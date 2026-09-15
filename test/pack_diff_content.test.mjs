// pack_diff_content.test.mjs — stable identities still carry meaningful changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { diffPacks } from '../src/core/pack_diff.mjs';

function pack(graph, digest) {
  return JSON.parse(JSON.stringify({ ...projectPack(graph, { project: 'content', base: { commit: digest.repeat(40) } }), digest }));
}

function addFlow(graph, edge, grade = 'EXACT', evidence = undefined) {
  graph.addEdge({ ...edge, grade, ...(evidence === undefined ? {} : { evidence }) });
}

function connected({ column = {}, symbol = {}, statement = {}, access = 'read', origin = undefined } = {}) {
  const graph = new Graph();
  graph.addNode({ id: nodeId('endpoint', 'GET /orders') });
  graph.addNode({ id: nodeId('screen', '/orders') });
  graph.addNode({ id: nodeId('symbol', 'Orders#list'), ...symbol });
  graph.addNode({ id: nodeId('statement', 'Orders.select'), ...statement });
  graph.addNode({ id: nodeId('column', 'orders.total'), ...column });
  addFlow(graph, { from: 'endpoint:GET /orders', to: 'symbol:Orders#list', type: 'HANDLES' });
  addFlow(graph, { from: 'screen:/orders', to: 'symbol:Orders#list', type: 'RENDERS' });
  addFlow(graph, { from: 'symbol:Orders#list', to: 'statement:Orders.select', type: 'MAY_CALL' });
  addFlow(graph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access, ...(origin === undefined ? {} : { origin }) });
  return graph;
}

test('stable column, transaction and SQL attributes are semantic changes with their endpoint and screen', () => {
  const base = pack(connected({ column: { type: 'INTEGER' }, symbol: { transactional: false }, statement: { statementType: 'select' } }), 'a');
  const head = pack(connected({ column: { type: 'NUMERIC(12,2)' }, symbol: { transactional: true }, statement: { statementType: 'update' } }), 'b');
  const diff = diffPacks(base, head);
  assert.equal(diff.comparisonVersion, 2);
  assert.deepEqual(diff.nodes.changedList.map((row) => [row.id, row.fields.map((field) => field.name)]), [
    ['column:orders.total', ['type']], ['statement:Orders.select', ['statementType']], ['symbol:Orders#list', ['transactional']],
  ]);
  assert.deepEqual(diff.endpointsTouched.ids, ['endpoint:GET /orders']);
  assert.deepEqual(diff.screensTouched.ids, ['screen:/orders']);
});

test('same-grade EXECUTES access evidence changes are visible without inventing a regrade', () => {
  const base = pack(connected({ access: 'read' }), 'a');
  const head = pack(connected({ access: 'write' }), 'b');
  const diff = diffPacks(base, head);
  assert.deepEqual([diff.edges.changed, diff.edges.moved, diff.edges.regraded], [1, 0, 0]);
  assert.deepEqual(diff.edges.changedList, [{
    from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES', rule: 'sql',
    base: [{ grade: 'EXACT', evidence: { access: 'read', rule: 'sql' } }],
    head: [{ grade: 'EXACT', evidence: { access: 'write', rule: 'sql' } }],
    fields: [{ name: 'evidence.access', base: 'read', head: 'write', basePresent: true, headPresent: true }],
  }]);
  assert.deepEqual(diff.endpointsTouched.ids, ['endpoint:GET /orders']);
  assert.deepEqual(diff.screensTouched.ids, ['screen:/orders']);
});

test('location-only moves do not seed impact, while combined moves and content changes are disjoint', () => {
  const base = pack(connected({ column: { type: 'INTEGER', file: 'src/a.sql', line: 4 } }), 'a');
  const moved = pack(connected({ column: { type: 'INTEGER', file: 'src/b.sql', line: 8 } }), 'b');
  const movedDiff = diffPacks(base, moved);
  assert.deepEqual([movedDiff.nodes.changed, movedDiff.nodes.moved, movedDiff.endpointsTouched.total, movedDiff.screensTouched.total], [0, 1, 0, 0]);
  assert.deepEqual(movedDiff.nodes.movedList[0], { id: 'column:orders.total', fields: [
    { name: 'file', base: 'src/a.sql', head: 'src/b.sql', basePresent: true, headPresent: true },
    { name: 'line', base: 4, head: 8, basePresent: true, headPresent: true },
  ] });
  const combined = pack(connected({ column: { type: 'TEXT', file: 'src/b.sql', line: 8 } }), 'c');
  const combinedDiff = diffPacks(base, combined);
  assert.deepEqual([combinedDiff.nodes.changed, combinedDiff.nodes.moved], [1, 0]);
  assert.deepEqual(combinedDiff.nodes.changedList[0].fields.map((field) => field.name), ['file', 'line', 'type']);
});

test('edge evidence preserves duplicate grade association without arbitrary pairing', () => {
  const graph = connected();
  const headGraph = connected();
  headGraph.edges = headGraph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(headGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write' });
  addFlow(headGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'SOUND_SET', { rule: 'sql', access: 'read' });
  graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(graph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read' });
  addFlow(graph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'SOUND_SET', { rule: 'sql', access: 'write' });
  const diff = diffPacks(pack(graph, 'a'), pack(headGraph, 'b'));
  assert.deepEqual([diff.edges.changed, diff.edges.regraded], [1, 0]);
  const field = diff.edges.changedList[0].fields[0];
  assert.equal(field.name, 'evidence.access');
  assert.deepEqual(field.base, [{ grade: 'EXACT', present: true, value: 'read' }, { grade: 'SOUND_SET', present: true, value: 'write' }]);
  assert.deepEqual(field.head, [{ grade: 'EXACT', present: true, value: 'write' }, { grade: 'SOUND_SET', present: true, value: 'read' }]);
});

test('full duplicate evidence correlation and uncertain origin structures stay semantic', () => {
  const baseGraph = connected();
  const headGraph = connected();
  for (const graph of [baseGraph, headGraph]) graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(baseGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', via: 'A' });
  addFlow(baseGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write', via: 'B' });
  addFlow(headGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', via: 'B' });
  addFlow(headGraph, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write', via: 'A' });
  const correlated = diffPacks(pack(baseGraph, 'a'), pack(headGraph, 'b'));
  assert.deepEqual(correlated.edges.changedList[0].fields.map((field) => field.name), ['evidence.records']);
  const uncertainBase = pack(connected({ origin: { file: 'a.sql', range: { line: 1 } } }), 'c');
  const uncertainHead = pack(connected({ origin: { file: 'b.sql', range: { line: 2 } } }), 'd');
  const uncertain = diffPacks(uncertainBase, uncertainHead);
  assert.deepEqual([uncertain.edges.changed, uncertain.edges.moved], [1, 0]);
});

test('duplicate evidence fields retain per-record absence without hiding the aggregate side', () => {
  const base = connected();
  const head = connected();
  for (const graph of [base, head]) graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', via: 'A' });
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', via: 'B' });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', via: 'A' });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write', via: 'B' });
  const field = diffPacks(pack(base, 'a'), pack(head, 'b')).edges.changedList[0].fields.find((row) => row.name === 'evidence.access');
  assert.deepEqual([field.basePresent, field.headPresent], [true, true]);
  assert.equal(field.base.some((entry) => entry.present === false), true);
});

test('duplicate content correlation remains changed when locations also move', () => {
  const base = connected();
  const head = connected();
  for (const graph of [base, head]) graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', via: 'A', file: 'old-a.sql' });
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write', via: 'B', file: 'old-b.sql' });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', via: 'B', file: 'new-a.sql' });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'write', via: 'A', file: 'new-b.sql' });
  const row = diffPacks(pack(base, 'a'), pack(head, 'b')).edges;
  assert.deepEqual([row.changed, row.moved], [1, 0]);
  assert.deepEqual(row.changedList[0].fields.map((field) => field.name), ['evidence.file', 'evidence.records']);
});

test('location-only duplicate correlation remains a move', () => {
  const base = connected();
  const head = connected();
  for (const graph of [base, head]) graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', file: 'a.sql', line: 1 });
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', file: 'b.sql', line: 2 });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', file: 'a.sql', line: 2 });
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', { rule: 'sql', access: 'read', file: 'b.sql', line: 1 });
  const row = diffPacks(pack(base, 'a'), pack(head, 'b')).edges;
  assert.deepEqual([row.changed, row.moved], [0, 1]);
  assert.deepEqual(row.movedList[0].fields.map((field) => field.name), ['evidence.locationRecords']);
  assert.deepEqual([row.movedList[0].fields[0].basePresent, row.movedList[0].fields[0].headPresent], [true, true]);
});

test('a non-object evidence shape is not silently treated as unchanged', () => {
  const base = connected();
  const head = connected();
  for (const graph of [base, head]) graph.edges = graph.edges.filter((edge) => edge.type !== 'EXECUTES');
  addFlow(base, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT', {});
  addFlow(head, { from: 'statement:Orders.select', to: 'column:orders.total', type: 'EXECUTES' }, 'EXACT');
  const diff = diffPacks(pack(base, 'a'), pack(head, 'b'));
  assert.deepEqual(diff.edges.changedList[0].fields.map((field) => field.name), ['evidence.records']);
  const missing = pack(head, 'c');
  const explicitNull = JSON.parse(JSON.stringify(missing));
  explicitNull.digest = 'd';
  explicitNull.edges.find((edge) => edge.type === 'EXECUTES').evidence = null;
  const nullDiff = diffPacks(missing, explicitNull);
  assert.equal(nullDiff.edges.changed, 1, 'an absent evidence value differs from an explicit null');
  assert.deepEqual(nullDiff.edges.changedList[0].fields[0].basePresent, false);
});

test('reordered records and object keys do not create changes, and the comparison does not mutate packs', () => {
  const base = pack(connected({ access: 'read' }), 'a');
  const head = JSON.parse(JSON.stringify(base));
  head.digest = 'b';
  head.nodes.reverse();
  head.edges.reverse();
  head.edges = head.edges.map((edge) => {
    const reordered = { grade: edge.grade, type: edge.type, to: edge.to, from: edge.from };
    if (Object.hasOwn(edge, 'evidence')) reordered.evidence = { access: edge.evidence.access, rule: edge.evidence.rule };
    return reordered;
  });
  const before = JSON.stringify({ base, head });
  const diff = diffPacks(base, head);
  assert.deepEqual([diff.nodes.changed, diff.nodes.moved, diff.edges.changed, diff.edges.moved, diff.edges.regraded], [0, 0, 0, 0, 0]);
  assert.equal(JSON.stringify({ base, head }), before);
});

test('edge list ordering uses rule as its final deterministic tie-break', () => {
  const base = connected();
  const head = connected();
  addFlow(head, { from: 'symbol:Orders#list', to: 'statement:Orders.select', type: 'CALLS' }, 'EXACT', { rule: 'z' });
  addFlow(head, { from: 'symbol:Orders#list', to: 'statement:Orders.select', type: 'CALLS' }, 'EXACT', { rule: 'a' });
  const added = diffPacks(pack(base, 'a'), pack(head, 'b')).edges.addedList.filter((edge) => edge.type === 'CALLS');
  assert.deepEqual(added.map((edge) => edge.rule), ['a', 'z']);
});

test('new capped lists retain complete totals and changed starts reach each side independently', () => {
  const base = pack(connected({ column: { type: 'INTEGER' }, access: 'read', origin: { file: 'a.sql', line: 1 } }), 'a');
  const head = pack(connected({ column: { type: 'TEXT' }, access: 'write', origin: { file: 'b.sql', line: 2 } }), 'b');
  const capped = diffPacks(base, head, { limit: 1 });
  for (const name of ['nodes.changed', 'nodes.moved', 'edges.changed', 'edges.moved']) {
    const entry = capped.truncated.fields.find((field) => field.field === name);
    assert.ok(entry, `${name} is an honest capped list`);
    assert.equal(entry.total >= entry.shown, true);
  }
  const baseGraph = connected({ column: { type: 'INTEGER' } });
  const headGraph = connected({ column: { type: 'TEXT' } });
  headGraph.edges = headGraph.edges.filter((edge) => edge.from !== 'endpoint:GET /orders');
  headGraph.addNode({ id: nodeId('endpoint', 'GET /head') });
  addFlow(headGraph, { from: 'endpoint:GET /head', to: 'symbol:Orders#list', type: 'HANDLES' });
  const rows = diffPacks(pack(baseGraph, 'c'), pack(headGraph, 'd')).endpointsTouched.rows;
  assert.deepEqual(rows, [
    { id: 'endpoint:GET /head', base: false, head: true },
    { id: 'endpoint:GET /orders', base: true, head: true },
  ]);
});
