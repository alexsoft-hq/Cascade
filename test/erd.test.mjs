import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { erd, ToolError } from '../src/mcp/tools.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// Catalog: three tables. a & b are joined by the mapper SQL; c stands alone.
function catalog() {
  return [
    { kind: 'table', schema: null, table: 'a', comment: 'table a' },
    { kind: 'column', schema: null, table: 'a', column: 'id', type: 'INT', comment: 'pk', pk: true },
    { kind: 'column', schema: null, table: 'a', column: 'name', type: 'VARCHAR', comment: null, pk: false },
    { kind: 'table', schema: null, table: 'b', comment: 'table b' },
    { kind: 'column', schema: null, table: 'b', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'b', column: 'a_id', type: 'INT', comment: 'fk-ish', pk: false },
    { kind: 'table', schema: null, table: 'c', comment: 'lonely table' },
    { kind: 'column', schema: null, table: 'c', column: 'id', type: 'INT', comment: null },
  ];
}
// Two statements join a↔b (so the relationship is witnessed twice).
function lineage() {
  const j = { left: { schema: null, table: 'a', column: 'id' }, right: { schema: null, table: 'b', column: 'a_id' }, kind: 'on' };
  return [
    { kind: 'lineage', namespace: 'M', id: 's1', type: 'select', tables: [{ table: 'a', access: 'read' }, { table: 'b', access: 'read' }], columns: [], joins: [j] },
    { kind: 'lineage', namespace: 'M', id: 's2', type: 'select', tables: [{ table: 'a', access: 'read' }, { table: 'b', access: 'read' }], columns: [], joins: [j] },
  ];
}
const g = () => buildGraphFromSql(catalog(), lineage());
const ctx = (graph) => ({ graph, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });

test('sql_bridge: joins on lineage records become one JOINS edge per table-pair (deduped, counted)', () => {
  const graph = g();
  const joins = graph.edges.filter((e) => e.type === 'JOINS');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].grade, 'EXACT');
  assert.equal(joins[0].evidence.count, 2); // two statements witness it
  assert.deepEqual(joins[0].evidence.columns, ['id=a_id']);
});

test('erd focus: returns the table + its join-neighborhood WITH columns and the relationship', () => {
  const resp = erd(g(), { table: 'a', hops: 1 }, ctx(g()));
  assert.doesNotThrow(() => assertContract(resp));
  const names = resp.answer.tables.map((t) => t.table).sort();
  assert.deepEqual(names, ['a', 'b']);
  const a = resp.answer.tables.find((t) => t.table === 'a');
  assert.equal(a.columns.length, 2); // id, name
  assert.equal(resp.answer.relationships.length, 1);
  assert.equal(resp.answer.relationships[0].statements, 2);
  assert.deepEqual(resp.answer.relationships[0].columns, ['id=a_id']);
  assert.equal(resp.answer.relationships[0].grade, 'EXACT');
  // a.id is a PK, b.a_id is not → a is the "1" side, b the "N" side.
  assert.equal(resp.answer.relationships[0].cardinality, '1:N');
  assert.equal(a.columns.find((c) => c.column === 'id').pk, true);
});

test('erd overview (no table): every table + every relationship, columns omitted', () => {
  const resp = erd(g(), {}, ctx(g()));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.focus, null);
  assert.equal(resp.answer.tables.length, 3); // a, b, c
  assert.equal(resp.answer.tables.every((t) => t.columns === undefined), true);
  assert.equal(resp.answer.tables.find((t) => t.table === 'a').columnCount, 2);
  assert.equal(resp.answer.relationships.length, 1);
});

test('erd focus on an unrelated table: no relationships, honest empty reason', () => {
  const resp = erd(g(), { table: 'c' }, ctx(g()));
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.tables.map((t) => t.table), ['c']);
  assert.equal(resp.answer.relationships.length, 0);
  assert.equal(resp.answer.empty.relationships, 'not-in-this-axis');
});

test('erd: unknown table throws ToolError unknown-table', () => {
  assert.throws(() => erd(g(), { table: 'nope' }, ctx(g())), (e) => e instanceof ToolError && e.code === 'unknown-table');
});

// ---------------------------------------------------------------------------
// The table cap (RM11, SPEC §13). Without one this answer is UNBOUNDED — every
// table in the schema, and in focus mode every COLUMN of every table within
// hops. Measured on a 400-table synthetic project: 86 KB whole-schema and
// 296 KB for a 4-hop neighbourhood; a 4 000-table schema would be megabytes
// with `truncated` still saying shown === total.
// ---------------------------------------------------------------------------

test('erd: the table cap keeps the most-joined tables and declares the true total', () => {
  const graph = g();
  const r = erd(graph, { limit: 2 }, ctx(graph));
  assertContract(r);
  // a and b are joined; c is joined by nothing, so c is the one that goes.
  assert.deepEqual(r.answer.tables.map((t) => t.table), ['a', 'b']);
  assert.equal(r.answer.limit, 2);
  const t = r.truncated.fields.find((f) => f.field === 'tables');
  assert.equal(t.shown, 2);
  assert.equal(t.total, 3, 'the true number of tables in scope, not the number drawn');
  assert.ok(r.limits.some((l) => /table cap 2 reached, so 1 of 3 table\(s\)/.test(l.reason)));
  // An ERD is a picture, not a page: no nextOffset, so `any` stays false and the
  // cut is read off shown vs total plus the limit.
  assert.equal(r.truncated.any, false);
  assert.equal(t.nextOffset, null);
});

test('erd: under the cap nothing is cut, and no cap limit is invented', () => {
  const graph = g();
  const r = erd(graph, {}, ctx(graph));
  assertContract(r);
  assert.equal(r.answer.tables.length, 3);
  assert.equal(r.truncated.fields.find((f) => f.field === 'tables').total, 3);
  assert.equal(r.limits.some((l) => /table cap/.test(l.reason)), false);
});

test('erd: a focused ERD never cuts its own focus table away', () => {
  const graph = g();
  // limit 1 with a focus that is NOT the best-connected table: the focus wins.
  const r = erd(graph, { table: 'b', hops: 1, limit: 1 }, ctx(graph));
  assertContract(r);
  assert.deepEqual(r.answer.tables.map((t) => t.table), ['b']);
  assert.ok(r.answer.tables[0].columns.length > 0, 'and it still carries its columns');
  assert.ok(r.limits.some((l) => /and the focus table always/.test(l.reason)));
});
