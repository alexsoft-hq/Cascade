// typeorm_catalog.mjs — the tables and columns TypeORM entities declare, as a catalog: every one of them a node, not only those a statement touches.
//
// The entity model (src/core/rules/kinds/typeorm_model.mjs) is written out as
// catalog records in the shape the SQL lane's catalog has (`{kind: 'table',
// schema, table}`, `{kind: 'column', schema, table, column, type, pk}`), each
// with the grade of its name and what declared it, and every record becomes a
// node. A column no statement reads is then a column that nothing here reads,
// not one the pack does not know: that is what makes the column axis true for
// an application whose schema is its entities.
//
// A table a DDL already declared is that node: matched through the run's
// identifier fold, as the JPA lane matches, and marked `typeormCatalogMatch`.
// A table only the entities declare is a stub with `declaredBy: 'typeorm'`,
// never presented as read from a schema. Each relation that owns its join
// column, and each join table, is a JOINS edge, graded by the names it joins.

import { nodeId } from '../../core/graph.mjs';
import { tableKey, columnKey, graphSpellingIndex, foldedKey } from '../sql_bridge.mjs';
import { weakest } from '../../core/rules/kinds/typeorm_mapping.mjs';

/** The model as catalog records: tables and columns, entities first, then join tables. */
export function catalogRecordsOf(model, schemaName) {
  const out = [];
  const schemaOf = (s) => s ?? schemaName ?? null;
  for (const e of model.entities.values()) {
    const schema = schemaOf(e.schema);
    out.push({ kind: 'table', schema, table: e.table, comment: null, grade: e.tableGrade, why: e.tableWhy, mappedFrom: `${e.file}#${e.name}` });
    for (const c of e.columns) out.push({ kind: 'column', schema, table: e.table, column: c.column, type: null, pk: c.pk, comment: null, grade: weakest(e.tableGrade, c.grade), why: whyIn(c, e.tableGrade, e.tableWhy), property: `${e.name}.${c.property}` });
  }
  for (const j of model.junctions) {
    const schema = schemaOf(j.schema);
    out.push({ kind: 'table', schema, table: j.table, comment: null, grade: j.grade, why: j.why, joinTableFor: `${j.owner.name}.${j.property}` });
    for (const c of [...j.ownerColumns, ...j.inverseColumns]) out.push({ kind: 'column', schema, table: j.table, column: c.column, type: null, pk: true, comment: null, grade: weakest(j.grade, c.grade), why: whyIn(c, j.grade, j.why) });
  }
  return out;
}

/** Why a column's name has the grade it has in its table: its own reason, or the table's when the table's name is the less sure. */
const whyIn = (c, tableGrade, tableWhy) => (weakest(tableGrade, c.grade) === c.grade ? c.why : `the table it is in is not settled: ${tableWhy}`);

/** The tables a DDL (or a snapshot) put in the graph before the entities are read, by their name without a schema, folded as the run folds. */
function ddlTablesByName(g, identifierCase) {
  const out = new Map();
  for (const n of g.nodes.values()) {
    if (n.kind !== 'table' || n.stub === true) continue;
    const key = n.id.slice('table:'.length);
    const bare = foldedKey(key.slice(key.lastIndexOf('.') + 1), identifierCase);
    out.set(bare, [...(out.get(bare) ?? []), key]);
  }
  return out;
}

/**
 * The schema a table is keyed under: its own, except that one in the schema
 * the profile declares as the default (`schema.default`) is the DDL's table
 * of that name written with no schema, when the DDL has one: the declaration
 * says an unqualified table is in that schema, so the two are one table.
 */
function defaultPlacer(g, identifierCase, defaultSchema) {
  if (!defaultSchema) return (schema) => schema;
  const unqualified = new Set([...g.nodes.values()].filter((n) => n.kind === 'table' && n.stub !== true && !n.id.slice('table:'.length).includes('.'))
    .map((n) => foldedKey(n.id.slice('table:'.length), identifierCase)));
  const same = (a) => foldedKey(a, identifierCase) === foldedKey(defaultSchema, identifierCase);
  return (schema, table) => (schema && same(schema) && unqualified.has(foldedKey(table, identifierCase)) ? null : schema);
}

/** A table only the entities declare: a stub, with the grade of its name and what maps it. */
function stubTable(g, id, r, stats) {
  g.addNode({ id, stub: true, declaredBy: 'typeorm', typeormNameGrade: r.grade, ...(r.mappedFrom ? { mappedFrom: r.mappedFrom } : { joinTableFor: r.joinTableFor }) });
  stats.tablesStubbed += 1;
}

/**
 * The table and column nodes of this run, found through the identifier fold:
 * `tableId(schema, table)`, `columnId(schema, table, column)`, and
 * `ensure(record)`, which makes the node a record declares when the graph has
 * none.
 */
export function catalogNodes(g, identifierCase, stats, defaultSchema = null) {
  const { settle, register } = graphSpellingIndex(g, identifierCase);
  const noteMiss = missNoter(g, identifierCase, stats);
  const place = defaultPlacer(g, identifierCase, defaultSchema);
  const tableId = (schema, table) => settle(nodeId('table', tableKey(place(schema, table), table)));
  const columnId = (schema, table, column) => settle(nodeId('column', columnKey(place(schema, table), table, column)));
  const ensureTable = (r) => {
    const id = tableId(r.schema, r.table);
    const node = g.nodes.get(id);
    if (!node) {
      stubTable(g, id, r, stats);
      register(id);
      noteMiss(r);
    } else if (node.stub !== true) node.typeormCatalogMatch = true;
    return id;
  };
  const ensureColumn = (r) => {
    const cid = columnId(r.schema, r.table, r.column);
    if (!g.nodes.has(cid)) register(stubColumn(g, cid, r, ensureTable({ ...r, kind: 'table' }), stats));
    return cid;
  };
  return { tableId, columnId, ensure: (r) => (r.kind === 'table' ? ensureTable(r) : ensureColumn(r)) };
}

/** A column only the entities declare: a stub, declared by its table at the grade of its name. */
function stubColumn(g, cid, r, tid, stats) {
  g.addNode({ id: cid, name: r.column, stub: true, declaredBy: 'typeorm', ...(r.pk ? { pk: true } : {}) });
  g.addEdge({ from: tid, to: cid, type: 'DECLARES', grade: r.grade, evidence: { via: 'typeorm', ...(r.property ? { property: r.property } : {}), ...(r.grade !== 'EXACT' ? { why: r.why } : {}) } });
  stats.columnsStubbed += 1;
  return cid;
}

/** How a table only the entities declare is noted when a DDL was read: with the DDL tables of the same name, keyed under another schema. */
function missNoter(g, identifierCase, stats) {
  const ddl = ddlTablesByName(g, identifierCase);
  stats.ddlTables = [...ddl.values()].reduce((n, ids) => n + ids.length, 0);
  return (r) => { if (ddl.size > 0) stats.ddlMisses.push({ table: tableKey(r.schema, r.table), ddl: ddl.get(foldedKey(r.table, identifierCase)) ?? [] }); };
}

function addJoin(g, seen, a, b, columns, grade) {
  if (a === b) return 0;
  const [from, to] = a < b ? [a, b] : [b, a];
  if (seen.has(`${from}|${to}`)) return 0;
  seen.add(`${from}|${to}`);
  g.addEdge({ from, to, type: 'JOINS', grade, evidence: { via: 'typeorm-relation', columns: [columns] } });
  return 1;
}

/** A JOINS edge for every relation that owns its join column, and two for every join table. */
export function addRelationJoins(g, model, nodes, schemaName) {
  const seen = new Set(g.edges.filter((e) => e.type === 'JOINS').map((e) => `${e.from}|${e.to}`));
  const sch = (s) => s ?? schemaName ?? null;
  const tid = (e) => nodes.tableId(sch(e.schema), e.table);
  let joins = 0;
  for (const e of model.entities.values()) {
    for (const r of e.relations) {
      if (!r.owner || !r.target) continue;
      if (r.junction) {
        const j = r.junction;
        const jt = nodes.tableId(sch(j.schema), j.table);
        joins += addJoin(g, seen, tid(e), jt, `${e.table}.${j.ownerColumns.map((c) => c.referenced).join(',')}=${j.table}.${j.ownerColumns.map((c) => c.column).join(',')}`, weakest(j.grade, ...j.ownerColumns.map((c) => c.grade)));
        joins += addJoin(g, seen, tid(r.target), jt, `${r.target.table}.${j.inverseColumns.map((c) => c.referenced).join(',')}=${j.table}.${j.inverseColumns.map((c) => c.column).join(',')}`, weakest(j.grade, ...j.inverseColumns.map((c) => c.grade)));
      } else if (r.joinColumns.length > 0) {
        const cols = `${e.table}.${r.joinColumns.map((c) => c.column).join(',')}=${r.target.table}.${r.joinColumns.map((c) => c.referenced).join(',')}`;
        joins += addJoin(g, seen, tid(e), tid(r.target), cols, weakest(e.tableGrade, r.target.tableGrade, ...r.joinColumns.map((c) => c.grade)));
      }
    }
  }
  return joins;
}
