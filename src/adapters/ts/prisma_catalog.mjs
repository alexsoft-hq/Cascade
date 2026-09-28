// prisma_catalog.mjs — schema.prisma as a catalog: every model a table, every scalar field a column, every relation the join it is.
//
// A Prisma project with no DDL still declares its database: schema.prisma is
// what the client is generated from, and every name in it is the name Prisma
// sends. So each model is a table node and each scalar field a column node, in
// the shape the SQL lane gives a DDL's (src/adapters/sql_bridge.mjs: a table
// with its comment, a column with its name, type, comment and `pk`, a DECLARES
// edge between them), with `nullable` from `?`, the type as the schema writes
// it, and `declaredBy: "prisma"`. A relation is a JOINS edge between the two
// tables on the columns its `fields` and `references` name, graded EXACT since
// the schema states it, one edge per pair of tables as the SQL lane aggregates
// its joins; an implicit many-to-many is the table Prisma makes for it
// (src/adapters/ts/prisma_relations.mjs), joined to both.
//
// WITH A SQL CATALOG TOO (migrations named as the DDL, or a snapshot), a table
// that catalog declares is not declared twice: the SQL lane's nodes stay as it
// made them. The schema is read against them instead. What agrees marks the
// node it corroborates (`prismaModel`, `prismaField`); what does not is a
// disagreement, counted on the lane's stats and said: a table or column only
// one of them declares, a primary key or a nullability they state differently.
// Neither is known to be the newer (a migration may lag the schema, or the
// schema the database), so a column whose key or nullability they state
// differently carries both on its node, each under the source that stated it
// (`declarationsDiffer: {pk: {catalog, prisma}, nullable: {catalog, prisma}}`):
// the node's own `pk` is the SQL catalog's, as the node is, and it is not the
// only declaration there is.
// A column only the schema declares is added as the schema's, since the client
// sends it; one only the SQL catalog declares is only said, since no Prisma call
// can name it. Types are not compared: Prisma's `String` and the database's
// `TEXT` are two vocabularies, not a disagreement.

import { nodeId } from '../../core/graph.mjs';
import { tableKey, columnKey, graphSpellingIndex, foldedKey } from '../sql_bridge.mjs';
import { relationsOf, scalarOf } from './prisma_relations.mjs';

const SAMPLES = 20;
const keyOf = (id) => id.slice(id.indexOf(':') + 1);

/** The implicit many-to-many tables as models of their own: columns A and B, each typed like the id it points at, their key not known. */
function implicitModels(relations) {
  const out = new Map();
  const column = (name, m) => {
    const id = scalarOf(m, m.primaryKey[0]);
    return { name, type: id?.type ?? null, list: false, optional: false, relation: false, column: name, id: false, nativeType: id?.nativeType ?? null };
  };
  for (const r of relations.values()) {
    if (r.kind !== 'implicit' || out.has(r.table)) continue;
    // Whether (A, B) is a primary key or a unique index depends on the Prisma
    // version and the database, so neither column says it is in a key.
    out.set(r.table, { name: r.table, table: r.table, schema: r.a.schema, fields: [column('A', r.a), column('B', r.b)], compounds: {}, primaryKey: null, block: 'implicit' });
  }
  return out;
}

/** The tables, and the nullability of each column, of the SQL catalog this run read, keyed by their folded names. */
function sqlCatalogOf(records, identifierCase) {
  const tables = new Map();
  const nullable = new Map();
  for (const r of records) {
    if (r.kind === 'table') tables.set(foldedKey(tableKey(r.schema, r.table), identifierCase), nodeId('table', tableKey(r.schema, r.table)));
    if (r.kind === 'column' && typeof r.nullable === 'boolean') nullable.set(foldedKey(columnKey(r.schema, r.table, r.column), identifierCase), r.nullable);
  }
  return { present: tables.size > 0, tables, nullable, identifierCase };
}

/** A node the SQL catalog declared: in the graph, and neither a stub nor this catalog's own. */
const fromSql = (g, id) => {
  const n = g.nodes.get(id);
  return Boolean(n) && n.stub !== true && n.declaredBy !== 'prisma';
};

function disagree(st, d) {
  st.disagreements += 1;
  st.disagreementsByKind[d.what] = (st.disagreementsByKind[d.what] ?? 0) + 1;
  if (st.disagreementSamples.length < SAMPLES) st.disagreementSamples.push(d);
}

/** A declaration the two state differently: said on the stats, and kept on the column with both values, each under its source. */
function differs(node, ctx, what, prisma, catalog) {
  disagree(ctx.st, { what: `${what}-differs`, column: keyOf(node.id), prisma, catalog });
  node.declarationsDiffer = { ...(node.declarationsDiffer ?? {}), [what]: { catalog, prisma } };
}

/** A column the schema declares and the SQL catalog also does: the node is the catalog's, and the key and nullability are compared. */
function corroborateColumn(g, cid, f, pk, ctx) {
  const node = g.nodes.get(cid);
  node.prismaField = f.name;
  ctx.st.columnsCorroborated += 1;
  if (pk !== null && (node.pk === true) !== pk) differs(node, ctx, 'pk', pk, node.pk === true);
  const sqlNullable = ctx.sql.nullable.get(foldedKey(keyOf(cid), ctx.sql.identifierCase));
  const nullable = f.list ? null : f.optional;
  if (nullable !== null && sqlNullable !== undefined && sqlNullable !== nullable) differs(node, ctx, 'nullable', nullable, sqlNullable);
}

/**
 * One scalar field as a column: corroborating the SQL catalog's node when it
 * has one, else declared here. A list's nullability is left unsaid: Prisma
 * reads a missing list as empty, and whether the column itself allows NULL is
 * not in the schema.
 */
function placeColumn(g, m, f, tid, ctx) {
  const cid = ctx.names.column(tid, f.column);
  ctx.ids.columns.set(`${m.name}.${f.name}`, cid);
  const pk = m.primaryKey === null ? null : m.primaryKey.includes(f.name);
  if (fromSql(g, cid)) { corroborateColumn(g, cid, f, pk, ctx); return; }
  if (fromSql(g, tid)) disagree(ctx.st, { what: 'column-not-in-catalog', column: keyOf(cid) });
  const existed = g.nodes.has(cid);
  if (existed) delete g.nodes.get(cid).stub;
  g.addNode({
    id: cid, name: f.column, type: `${f.type}${f.list ? '[]' : ''}`, comment: null, pk, nullable: f.list ? null : f.optional,
    ...(f.nativeType ? { nativeType: f.nativeType } : {}), declaredBy: 'prisma', prismaField: f.name,
  });
  if (!existed) g.addEdge({ from: tid, to: cid, type: 'DECLARES', grade: 'EXACT' });
  ctx.names.register(cid);
  ctx.st.columns += 1;
}

/** One model (or implicit relation table) as a table, and each of its scalar fields as a column. */
function placeTable(g, m, ctx) {
  const tid = ctx.names.table(m);
  ctx.ids.tables.set(m.name, tid);
  if (fromSql(g, tid)) {
    g.nodes.get(tid).prismaModel = m.name;
    ctx.st.tablesCorroborated += 1;
  } else {
    if (ctx.sql.present) disagree(ctx.st, { what: 'table-not-in-catalog', table: keyOf(tid) });
    if (g.nodes.has(tid)) delete g.nodes.get(tid).stub;
    g.addNode({ id: tid, comment: null, declaredBy: 'prisma', prismaModel: m.name, ...(m.block === 'model' ? {} : { prismaBlock: m.block }) });
    ctx.names.register(tid);
    ctx.st.tables += 1;
  }
  for (const f of m.fields) if (!f.relation) placeColumn(g, m, f, tid, ctx);
}

/** What the SQL catalog declares and the schema does not: a table no model maps to, a column of a model's table no field maps to. */
function sqlOnly(g, ctx) {
  const tables = new Set(ctx.ids.tables.values());
  const columns = new Set(ctx.ids.columns.values());
  const declared = new Map();
  for (const e of g.edges) {
    if (e.type !== 'DECLARES') continue;
    if (!declared.has(e.from)) declared.set(e.from, []);
    declared.get(e.from).push(e.to);
  }
  for (const tid of [...ctx.sql.tables.values()].sort()) {
    if (!tables.has(tid)) { disagree(ctx.st, { what: 'table-not-in-schema', table: keyOf(tid) }); continue; }
    for (const cid of (declared.get(tid) ?? []).sort()) {
      if (!columns.has(cid) && fromSql(g, cid)) disagree(ctx.st, { what: 'column-not-in-schema', column: keyOf(cid) });
    }
  }
}

/**
 * The JOINS a relation is, one edge per pair of tables with every column pair
 * that joins them, written `a=b` in the order of the two table ids (the SQL
 * lane's shape). A relation of a model with itself is not an ERD relationship,
 * as the SQL lane counts it; a pair another lane already joined is left to it.
 */
function addJoins(g, relations, ids) {
  const agg = new Map();
  const colName = (cid) => g.nodes.get(cid)?.name ?? keyOf(cid).split('.').pop();
  const add = (ta, ca, tb, cb, rel) => {
    if (!ta || !tb || !ca || !cb || ta === tb) return;
    const swap = ta > tb;
    const k = swap ? `${tb}|${ta}` : `${ta}|${tb}`;
    const rec = agg.get(k) ?? { from: swap ? tb : ta, to: swap ? ta : tb, cols: new Set(), rels: new Set() };
    rec.cols.add(swap ? `${colName(cb)}=${colName(ca)}` : `${colName(ca)}=${colName(cb)}`);
    rec.rels.add(rel);
    agg.set(k, rec);
  };
  for (const [key, r] of relations) {
    const model = key.slice(0, key.indexOf('.'));
    if (r.kind === 'fk' && r.holder === 'self') {
      r.own.forEach((f, i) => add(ids.tables.get(model), ids.columns.get(`${model}.${f}`), ids.tables.get(r.target.name), ids.columns.get(`${r.target.name}.${r.other[i]}`), key));
    } else if (r.kind === 'implicit' && r.selfIsA) {
      for (const [side, m] of [['A', r.a], ['B', r.b]]) add(ids.tables.get(r.table), ids.columns.get(`${r.table}.${side}`), ids.tables.get(m.name), ids.columns.get(`${m.name}.${m.primaryKey[0]}`), key);
    }
  }
  const joined = new Set(g.edges.filter((e) => e.type === 'JOINS').map((e) => `${e.from}|${e.to}`));
  let added = 0;
  for (const rec of [...agg.values()].sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1))) {
    if (joined.has(`${rec.from}|${rec.to}`) || joined.has(`${rec.to}|${rec.from}`)) continue;
    g.addEdge({ from: rec.from, to: rec.to, type: 'JOINS', grade: 'EXACT', evidence: { via: 'prisma-relation', columns: [...rec.cols].sort(), relations: [...rec.rels].sort() } });
    added += 1;
  }
  return added;
}

/**
 * What a statement following one relation reaches: the target's table, the
 * columns the join reads on both sides (and the implicit table's A and B), and
 * the columns that hold the link, with the table they sit in, for a write that
 * sets or clears it; whether the link sits in this model's own table
 * (`inline`, as Prisma's engine calls a relation inlined on the model that
 * encloses it), and whether it is one-to-one.
 */
function relationEntry(key, r, ids) {
  if (r.kind === 'unresolved') return { ok: false, why: r.why };
  const model = key.slice(0, key.indexOf('.'));
  const targetTable = ids.tables.get(r.target.name);
  if (r.kind === 'implicit') {
    const [self, other] = r.selfIsA ? [r.a, r.b] : [r.b, r.a];
    const a = ids.columns.get(`${r.table}.A`);
    const b = ids.columns.get(`${r.table}.B`);
    const joinTable = ids.tables.get(r.table);
    const reads = [ids.columns.get(`${self.name}.${self.primaryKey[0]}`), ids.columns.get(`${other.name}.${other.primaryKey[0]}`), a, b];
    return { ok: true, target: r.target, targetTable, joinTable, joinReads: reads, link: { table: joinTable, columns: [a, b] }, inline: false, oneToOne: false };
  }
  const own = r.own.map((f) => ids.columns.get(`${model}.${f}`));
  const other = r.other.map((f) => ids.columns.get(`${r.target.name}.${f}`));
  if ([...own, ...other].some((x) => !x)) return { ok: false, why: 'its fields or references name a field that is not a column' };
  const link = r.holder === 'self' ? { table: ids.tables.get(model), columns: own } : { table: targetTable, columns: other };
  return { ok: true, target: r.target, targetTable, joinTable: null, joinReads: [...own, ...other], link, inline: r.holder === 'self', oneToOne: r.oneToOne === true };
}

function newStats(schema, sql) {
  const models = [...schema.models.values()];
  return {
    source: sql.present ? 'schema-and-sql-catalog' : 'schema', models: models.filter((m) => m.block === 'model').length, views: models.filter((m) => m.block === 'view').length,
    implicitTables: 0, tables: 0, columns: 0, tablesCorroborated: 0, columnsCorroborated: 0, joins: 0,
    relations: { resolved: 0, unresolved: 0, unresolvedSamples: [] }, disagreements: 0, disagreementsByKind: {}, disagreementSamples: [],
  };
}

/**
 * Put schema.prisma's catalog into the graph, and answer what a statement asks
 * of it: a model's table and columns, and what one relation joins.
 *
 * @param {import('../../core/graph.mjs').Graph} g  a graph the SQL lane already put its catalog in, if it read one
 * @param {{models:Map<string,object>}} schema  readPrismaSchema's answer
 * @param {{schemaName?:(string|null), identifierCase?:string, catalogRecords?:object[]}} [opts]
 */
export function addPrismaCatalog(g, schema, opts = {}) {
  const names = (() => {
    const { settle, register } = graphSpellingIndex(g, opts.identifierCase ?? 'exact');
    const schemaOf = (m) => m.schema ?? opts.schemaName ?? null;
    return {
      table: (m) => settle(nodeId('table', tableKey(schemaOf(m), m.table))),
      // A column is keyed under its table's own spelling: the SQL catalog's when it declared the table.
      column: (tid, column) => settle(nodeId('column', `${keyOf(tid)}.${column}`)),
      register,
    };
  })();
  const sql = sqlCatalogOf(opts.catalogRecords ?? [], opts.identifierCase ?? 'exact');
  const relations = relationsOf(schema.models);
  const implicit = implicitModels(relations);
  const ctx = { names, sql, ids: { tables: new Map(), columns: new Map() }, st: newStats(schema, sql) };
  for (const m of [...schema.models.values(), ...implicit.values()]) placeTable(g, m, ctx);
  if (sql.present) sqlOnly(g, ctx);
  ctx.st.implicitTables = implicit.size;
  ctx.st.joins = addJoins(g, relations, ctx.ids);
  const index = new Map([...relations].map(([key, r]) => [key, relationEntry(key, r, ctx.ids)]));
  for (const [key, e] of index) {
    ctx.st.relations[e.ok ? 'resolved' : 'unresolved'] += 1;
    if (!e.ok && ctx.st.relations.unresolvedSamples.length < 5) ctx.st.relations.unresolvedSamples.push(`${key}: ${e.why}`);
  }
  return {
    stats: ctx.st,
    tableId: (model) => ctx.ids.tables.get(model.name) ?? null,
    columnId: (model, field) => ctx.ids.columns.get(`${model.name}.${field}`) ?? null,
    scalarColumnIds: (model) => model.fields.filter((f) => !f.relation).map((f) => ctx.ids.columns.get(`${model.name}.${f.name}`)).filter(Boolean),
    relation: (model, field) => index.get(`${model.name}.${field}`) ?? null,
  };
}
