// sql_bridge.mjs — turn SQL-lane worker output into knowledge-graph facts.
//
// The Python SQL lane emits three JSONL streams (catalog / statements / lineage,
// SPEC §9.4-9.5, §12). This bridge maps the catalog + lineage records into the
// graph model (core/graph): table & column nodes (columns carry their business
// comment), DECLARES edges, and per-statement EXECUTES / READS / WRITES edges.
//
// These are direct SQL facts (a mapper statement literally names the table and
// the columns it touches), so their grade is EXACT — no candidate ambiguity at
// this layer. Deletes touch a table (EXECUTES, access=delete) but write no
// columns (the reference invariant is already enforced upstream in lineage.py;
// this bridge simply carries whatever column facts it is given).

import { Graph, nodeId } from '../core/graph.mjs';
import { foldIdentifier } from '../core/identifier_case.mjs';

/** Canonical key parts (schema optional; mall has null schema). */
export function tableKey(schema, table) {
  return schema ? `${schema}.${table}` : table;
}
export function columnKey(schema, table, column) {
  return schema ? `${schema}.${table}.${column}` : `${table}.${column}`;
}
/**
 * The key a statement is looked up by at run time.
 *
 * MyBatis always joins the namespace on. iBATIS with `useStatementNamespaces`
 * off does not, and the worker says so by leaving `namespace` empty (RM56) —
 * so an empty namespace is the bare id, not a key that starts with a dot.
 */
export function statementKey(namespace, id) {
  return namespace ? `${namespace}.${id}` : String(id);
}

/**
 * The MATCHING key of a table/column key under an identity rule — every part
 * folded, the separators kept. `foldedKey('PMS', 'Product', 'fold-lower')` is
 * `pms.product`; the DISPLAY key is untouched and stays what the node is named.
 *
 * This is the JavaScript half of the rule `adapters/sql/identifier_case.py`
 * states for the worker. The two are cross-checked in
 * `test/identifier_case.test.mjs`: a graph built here and a graph built from the
 * worker's own output must put the same table under the same id.
 *
 * @param {string} key  a `table` / `schema.table` / `table.column` key
 * @param {string} identifierCase
 * @returns {string}
 */
export function foldedKey(key, identifierCase) {
  return String(key).split('.').map((part) => foldIdentifier(part, identifierCase)).join('.');
}

/**
 * THE FOLD, FOR A BRIDGE THAT DERIVES NAMES INSTEAD OF READING THEM.
 *
 * The SQL bridge keys every table and column node by what the DDL wrote. The
 * mapping lanes (JPA, MyBatis-Plus) do not read a name, they DERIVE one from a
 * class or a property — `id` where an Oracle/HSQLDB/H2 DDL says `ID`. Matched by
 * string, the derived name makes a SECOND node for a column the catalog already
 * has and every answer about that column comes back missing half its
 * statements; matched through the SAME fold the SQL lane used, it lands on the
 * catalog's node. jeecg-boot's `sys_user_depart.id` / `.ID` is the case that
 * found this.
 *
 * ONE helper, used by both mapping bridges: a second copy is a second chance to
 * disagree with the worker, which is the defect this exists to prevent.
 *
 * `settle(id)` maps a derived `table:`/`column:` node id onto the spelling the
 * graph already carries. `register(id)` adds a node id the caller has just
 * created as a stub, so the next derived name that folds onto it finds it
 * instead of inventing a third node. Under `exact` both are the identity
 * function and nothing is indexed.
 *
 * @param {import('../core/graph.mjs').Graph} g  a graph whose table/column nodes are already in place
 * @param {string} [identifierCase='exact']
 * @returns {{settle:(id:string)=>string, register:(id:string)=>string, identifierCase:string}}
 */
export function graphSpellingIndex(g, identifierCase = 'exact') {
  const folds = identifierCase !== 'exact';
  const spelling = new Map(); // "kind:foldedKey" -> the node id already in the graph
  const matchKey = (id) => {
    const colon = id.indexOf(':');
    return `${id.slice(0, colon)}:${foldedKey(id.slice(colon + 1), identifierCase)}`;
  };
  if (folds) {
    for (const id of g.nodes.keys()) {
      const colon = id.indexOf(':');
      const kind = id.slice(0, colon);
      if (kind !== 'table' && kind !== 'column') continue;
      const folded = `${kind}:${foldedKey(id.slice(colon + 1), identifierCase)}`;
      if (!spelling.has(folded)) spelling.set(folded, id);
    }
  }
  const settle = (id) => (folds ? spelling.get(matchKey(id)) ?? id : id);
  const register = (id) => {
    if (folds) {
      const k = matchKey(id);
      if (!spelling.has(k)) spelling.set(k, id);
    }
    return id;
  };
  return { settle, register, identifierCase };
}

/**
 * The catalog's own spellings, indexed by matching key: `{tables, columns}`,
 * each a Map from folded key to the key the catalog declared. A lineage record
 * that names a table in another case then lands on the catalog's node instead of
 * inventing a second one — which is what `identifierCase` is for.
 *
 * Two catalog spellings that fold together are a COLLISION: the first
 * declaration keeps the key and the collision is returned so the caller can
 * report it (§3.3 — two declared tables are never merged in silence).
 *
 * @param {object[]} catalogRecords
 * @param {string} identifierCase
 * @returns {{tables:Map<string,string>, columns:Map<string,string>,
 *            collisions:{kind:string, key:string, kept:string, dropped:string}[]}}
 */
export function catalogIdentity(catalogRecords, identifierCase = 'exact') {
  const tables = new Map();
  const columns = new Map();
  const collisions = [];
  // A table is registered from its own record AND from each of its columns'
  // records; one collision is one FACT, not one per sighting.
  const reported = new Set();
  const put = (map, kind, folded, display) => {
    const kept = map.get(folded);
    if (kept === undefined) { map.set(folded, display); return; }
    if (kept === display) return;
    const seen = JSON.stringify([kind, folded, kept, display]);
    if (reported.has(seen)) return;
    reported.add(seen);
    collisions.push({ kind, key: folded, kept, dropped: display });
  };
  for (const r of catalogRecords ?? []) {
    if (r.kind === 'table') {
      const k = tableKey(r.schema, r.table);
      put(tables, 'table', foldedKey(k, identifierCase), k);
    } else if (r.kind === 'column') {
      const tk = tableKey(r.schema, r.table);
      put(tables, 'table', foldedKey(tk, identifierCase), tk);
      const ck = columnKey(r.schema, r.table, r.column);
      put(columns, 'column', foldedKey(ck, identifierCase), ck);
    }
  }
  return { tables, columns, collisions };
}

/**
 * Build a Graph from SQL-lane records.
 *
 * Node ids carry the CATALOG's spelling. A lineage record that names a table or
 * column in a different case — which the worker already resolves for the schemas
 * it can see — is matched through the folded key under `options.identifierCase`
 * and lands on that same node; a name the catalog does not have at all keeps its
 * own spelling and becomes a stub, exactly as before. The default `exact` folds
 * nothing, so a caller that says nothing gets the pre-RM12 behaviour.
 *
 * @param {object[]} catalogRecords  piece-1 output (header + table/column records)
 * @param {object[]} lineageRecords  piece-3 output (header + lineage records)
 * @param {{identifierCase?:string}} [options]
 * @returns {Graph}
 */
export function buildGraphFromSql(catalogRecords, lineageRecords, options = {}) {
  const g = new Graph();
  if (!Array.isArray(catalogRecords) || !Array.isArray(lineageRecords)) {
    throw new SqlBridgeError('catalogRecords and lineageRecords must be arrays');
  }
  const identifierCase = options.identifierCase ?? 'exact';
  const identity = catalogIdentity(catalogRecords, identifierCase);
  /** The catalog's spelling of a table key, or the key as written. */
  const tk = (schema, table) => {
    const k = tableKey(schema, table);
    return identity.tables.get(foldedKey(k, identifierCase)) ?? k;
  };
  /** The catalog's spelling of a column key, or the key as written. */
  const ck = (schema, table, column) => {
    const k = columnKey(schema, table, column);
    return identity.columns.get(foldedKey(k, identifierCase)) ?? k;
  };

  // Catalog → table/column nodes + DECLARES (table declares column).
  for (const r of catalogRecords) {
    if (r.kind === 'table') {
      g.addNode({ id: nodeId('table', tableKey(r.schema, r.table)), comment: r.comment ?? null });
    } else if (r.kind === 'column') {
      const tid = nodeId('table', tableKey(r.schema, r.table));
      const cid = nodeId('column', columnKey(r.schema, r.table, r.column));
      g.addNode({ id: cid, name: r.column, type: r.type ?? null, comment: r.comment ?? null, pk: r.pk === true });
      g.addEdge({ from: tid, to: cid, type: 'DECLARES', grade: 'EXACT' });
    }
    // header and any other kinds are ignored
  }

  // Lineage → statement nodes + EXECUTES / READS / WRITES.
  for (const r of lineageRecords) {
    if (r.kind !== 'lineage') continue;
    const sid = nodeId('statement', statementKey(r.namespace, r.id));
    // `hasStringSubst` / `schemaUnknown` are the mapper's own two honesty flags,
    // carried from piece 2 through piece 3 onto the node: a statement that
    // splices raw text (`${}`) can execute SQL this pack never saw, and one
    // whose schema qualifier was dropped names a table whose schema is UNKNOWN,
    // not the default one (I-4). `cascade estimate` measures both from here.
    g.addNode({
      id: sid, statementType: r.type, file: r.file ?? null, line: r.line ?? null,
      ...(r.hasStringSubst === true ? { hasStringSubst: true } : {}),
      ...(r.schemaUnknown === true ? { schemaUnknown: true } : {}),
    });
    for (const t of r.tables ?? []) {
      g.addEdge({
        from: sid,
        to: nodeId('table', tk(t.schema, t.table)),
        type: 'EXECUTES',
        grade: 'EXACT',
        evidence: { access: t.access },
      });
    }
    for (const c of r.columns ?? []) {
      if (c.access !== 'read' && c.access !== 'write') continue; // deletes carry no column write; guard anyway
      g.addEdge({
        from: sid,
        to: nodeId('column', ck(c.schema, c.table, c.column)),
        type: c.access === 'write' ? 'WRITES' : 'READS',
        grade: 'EXACT',
      });
    }
  }

  // JOINS: table↔table relationships recovered from the mapper SQL (this schema
  // has no FKs — relationships live only in how the queries join). Aggregated
  // across statements, deduped to one canonical edge per unordered table pair,
  // carrying the join columns and how many statements witness it. The join is
  // literal in the SQL, so grade EXACT.
  const joinAgg = new Map(); // "a|b" (a<b) -> {a,b,count,cols:Set}
  for (const r of lineageRecords) {
    if (r.kind !== 'lineage' || !Array.isArray(r.joins)) continue;
    for (const j of r.joins) {
      if (!j || !j.left || !j.right || !j.left.table || !j.right.table) continue;
      const aKey = tk(j.left.schema, j.left.table);
      const bKey = tk(j.right.schema, j.right.table);
      if (aKey === bKey) continue; // self-join: not an ERD relationship
      const swap = aKey > bKey;
      const [x, y] = swap ? [bKey, aKey] : [aKey, bKey];
      const rec = joinAgg.get(x + '|' + y) || { a: x, b: y, count: 0, cols: new Set() };
      rec.count += 1;
      if (j.left.column && j.right.column) {
        rec.cols.add(swap ? `${j.right.column}=${j.left.column}` : `${j.left.column}=${j.right.column}`);
      }
      joinAgg.set(x + '|' + y, rec);
    }
  }
  for (const rec of joinAgg.values()) {
    g.addEdge({
      from: nodeId('table', rec.a), to: nodeId('table', rec.b),
      type: 'JOINS', grade: 'EXACT',
      evidence: { count: rec.count, columns: [...rec.cols].sort() },
    });
  }
  return g;
}

/**
 * Convenience: the statements that touch a given column, split by read/write.
 * (Backward neighbours over READS/WRITES — "what breaks if I change this column".)
 * @param {Graph} g
 * @param {string} columnNodeId  e.g. nodeId('column','pms_product.price')
 * @returns {{writers:string[], readers:string[]}}
 */
export function statementsTouchingColumn(g, columnNodeId) {
  const writers = [];
  const readers = [];
  const reached = g.reach(columnNodeId, { direction: 'in', mode: 'strict', maxHops: 1, edgeTypes: ['READS', 'WRITES'] });
  // reach doesn't tell us which edge type; re-derive from adjacency for the split.
  for (const e of g.edges) {
    if (e.to === columnNodeId && (e.type === 'READS' || e.type === 'WRITES')) {
      (e.type === 'WRITES' ? writers : readers).push(e.from);
    }
  }
  void reached;
  return { writers: uniqSort(writers), readers: uniqSort(readers) };
}

function uniqSort(a) {
  return [...new Set(a)].sort();
}

export class SqlBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlBridgeError';
  }
}
