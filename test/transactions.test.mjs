import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { transactions, ToolError } from '../src/mcp/tools.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// SQL: statement M.upd writes t.name (and reads t.id).
function catalog() {
  return [
    { kind: 'table', schema: null, table: 't', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'id', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'name', type: 'VARCHAR', comment: null },
  ];
}
function lineage() {
  return [{ kind: 'lineage', namespace: 'M', id: 'upd', type: 'update', tables: [{ table: 't', access: 'write' }], columns: [{ table: 't', column: 'name', access: 'write' }, { table: 't', column: 'id', access: 'read' }] }];
}
// Java: com.x.S#doIt is @Transactional, calls mapper M.upd (M#upd → statement M.upd).
function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.S', typeKind: 'class', package: 'com.x', annotations: ['Service'], implements: [] },
    { kind: 'type', fqn: 'M', typeKind: 'interface', package: '', implements: [] },
    { kind: 'import', owner: 'com.x.S', simple: 'M', fqn: 'M' },
    { kind: 'field', owner: 'com.x.S', name: 'm', typeSimple: 'M' },
    { kind: 'call', from: 'com.x.S#doIt', receiver: 'm', method: 'upd', toTypeSimple: 'M' },
    { kind: 'method', fqn: 'M#upd', owner: 'M', name: 'upd', paramCount: 1, line: 5 },
    { kind: 'transactional', method: 'com.x.S#doIt', scope: 'method', line: 12 },
  ];
}
function txGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  return g;
}
const ctx = (g) => ({ graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });

test('addJavaFacts: a transactional fact marks its symbol node', () => {
  const g = txGraph();
  const n = g.nodes.get(nodeId('symbol', 'com.x.S#doIt'));
  assert.equal(n.transactional, true);
  assert.equal(n.txScope, 'method');
  assert.equal(n.line, 12);
});

test('transactions list: the boundary with its write/read footprint counts', () => {
  const resp = transactions(txGraph(), {}, ctx(txGraph()));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.transactions.length, 1);
  const t = resp.answer.transactions[0];
  assert.equal(t.method, 'com.x.S#doIt');
  assert.equal(t.writeCount, 1); // t.name
  assert.equal(t.tableCount, 1);
  assert.equal(t.statementCount, 1);
  assert.equal(t.writes, undefined); // list mode: counts only
});

test('transactions detail (method=): full write/read column lists + tables', () => {
  const resp = transactions(txGraph(), { method: 'com.x.S#doIt' }, ctx(txGraph()));
  assert.doesNotThrow(() => assertContract(resp));
  const t = resp.answer.transactions[0];
  assert.deepEqual(t.writes, ['t.name']);
  assert.deepEqual(t.reads, ['t.id']);
  assert.deepEqual(t.tables, ['t']);
});

test('transactions: a non-transactional method throws bad-input', () => {
  const g = txGraph();
  assert.throws(() => transactions(g, { method: 'M#upd' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input');
});

test('transactions: an unknown method throws unknown-symbol', () => {
  const g = txGraph();
  assert.throws(() => transactions(g, { method: 'com.x.S#nope' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'unknown-symbol');
});

test('transactions: SQL-only graph (no code axis) → empty reason not-shipped', () => {
  const g = buildGraphFromSql(catalog(), lineage());
  const resp = transactions(g, {}, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.transactions.length, 0);
  assert.equal(resp.answer.empty.transactions, 'not-shipped');
});
