import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId, buildGraph, FLOW_EDGE_TYPES } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { flow, endpoint_impact, ToolError } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';

// ---------------------------------------------------------------------------
// Fixture — the same chain as test/chain.test.mjs (endpoint → controller →
// service iface → impl → mapper → statement → table), plus two more endpoints
// so list mode has something to sort, filter and page:
//   GET  /p/{id}      → com.x.PController#get     (the full chain)
//   POST /p/create    → com.x.PController#create  (a handler that calls nothing)
//   GET  /admin/ping  → com.x.AdminController#ping
// ---------------------------------------------------------------------------

function catalog() {
  return [
    { kind: 'table', schema: null, table: 'p', comment: 'product' },
    { kind: 'column', schema: null, table: 'p', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'p', column: 'name', type: 'VARCHAR', comment: null },
    { kind: 'column', schema: null, table: 'p', column: 'price', type: 'DECIMAL', comment: null },
    { kind: 'table', schema: null, table: 'q', comment: null },
    { kind: 'column', schema: null, table: 'q', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'q', column: 'p_id', type: 'INT', comment: null },
  ];
}
function lineage() {
  return [
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'p', access: 'read' }],
      columns: [{ table: 'p', column: 'id', access: 'read' }, { table: 'p', column: 'name', access: 'read' }],
      file: 'PMapper.xml', line: 10,
    },
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'updateByPrimaryKey', type: 'update',
      tables: [{ table: 'p', access: 'write' }, { table: 'q', access: 'write' }],
      columns: [
        { table: 'p', column: 'name', access: 'write' },
        { table: 'p', column: 'price', access: 'write' },
        { table: 'q', column: 'p_id', access: 'write' },
      ],
      file: 'PMapper.xml', line: 30,
    },
  ];
}
function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.PController', typeKind: 'class', package: 'com.x', file: 'src/PController.java', implements: [] },
    { kind: 'type', fqn: 'com.x.AdminController', typeKind: 'class', package: 'com.x', file: 'src/AdminController.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PService', typeKind: 'interface', package: 'com.x', file: 'src/PService.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PServiceImpl', typeKind: 'class', package: 'com.x', file: 'src/PServiceImpl.java', implements: ['PService'] },
    { kind: 'type', fqn: 'com.x.PMapper', typeKind: 'interface', package: 'com.x', file: 'src/PMapper.java', implements: [] },
    { kind: 'type', fqn: 'com.ext.Ext', typeKind: 'class', package: 'com.ext', implements: [] }, // no file → external
    { kind: 'import', owner: 'com.x.PController', simple: 'Ext', fqn: 'com.ext.Ext' },
    { kind: 'method', fqn: 'com.x.PController#get', owner: 'com.x.PController', paramCount: 1, line: 30 },
    { kind: 'method', fqn: 'com.x.PController#create', owner: 'com.x.PController', paramCount: 1, line: 44 },
    { kind: 'method', fqn: 'com.x.AdminController#ping', owner: 'com.x.AdminController', paramCount: 0, line: 9 },
    { kind: 'method', fqn: 'com.x.PServiceImpl#load', owner: 'com.x.PServiceImpl', paramCount: 1, line: 20 },
    { kind: 'method', fqn: 'com.x.PMapper#selectByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 7 },
    { kind: 'method', fqn: 'com.x.PMapper#updateByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 12 },
    { kind: 'call', from: 'com.x.PController#get', receiver: 's', method: 'load', toTypeSimple: 'PService' },
    { kind: 'call', from: 'com.x.PController#get', receiver: 'e', method: 'send', toTypeSimple: 'Ext' },
    { kind: 'call', from: 'com.x.PServiceImpl#load', receiver: 'm', method: 'selectByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'call', from: 'com.x.PServiceImpl#load', receiver: 'm', method: 'updateByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/p/{id}', handler: 'com.x.PController#get', line: 30 },
    { kind: 'endpoint', httpMethod: 'POST', path: '/p/create', handler: 'com.x.PController#create', line: 44 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/admin/ping', handler: 'com.x.AdminController#ping', line: 9 },
    { kind: 'transactional', method: 'com.x.PServiceImpl#load', scope: 'method', line: 20 },
  ];
}
function flowGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  return g;
}
const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ctx = (graph) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });
// every response in this file goes through the contract before it is inspected
const call = (graph, args) => { const r = flow(graph, args, ctx(graph)); assertContract(r); return r; };

// ---------------------------------------------------------------------------
// list mode — the entry picker
// ---------------------------------------------------------------------------

test('flow list: every endpoint, sorted path asc then httpMethod asc, with its handler', () => {
  const g = flowGraph();
  const r = call(g, {});
  assert.deepEqual(r.answer.entries.map((e) => e.id), ['GET /admin/ping', 'POST /p/create', 'GET /p/{id}']);
  const first = r.answer.entries[0];
  assert.equal(first.httpMethod, 'GET');
  assert.equal(first.path, '/admin/ping');
  assert.equal(first.handler, 'com.x.AdminController#ping');
  assert.equal(first.handlerShort, 'AdminController#ping');
  assert.equal(first.file, 'src/AdminController.java');
  assert.equal(first.line, 9);
  assert.equal(r.truncated.any, false);
  assert.deepEqual(r.trust.axes, ['flow']);
});

test('flow list: query is a case-insensitive substring over "METHOD path handler"', () => {
  const g = flowGraph();
  assert.deepEqual(call(g, { query: 'ADMIN' }).answer.entries.map((e) => e.id), ['GET /admin/ping']);
  assert.equal(call(g, { query: 'controller' }).answer.entries.length, 3); // matches via the handler
  assert.deepEqual(call(g, { query: 'post' }).answer.entries.map((e) => e.id), ['POST /p/create']);
  const none = call(g, { query: 'zzz' });
  assert.equal(none.answer.entries.length, 0);
  assert.equal(none.answer.empty.entries, 'none');
});

test('flow list: paging — limit cuts, nextOffset points at the rest, last page has none', () => {
  const g = flowGraph();
  const page1 = call(g, { limit: 2 });
  assert.equal(page1.answer.entries.length, 2);
  assert.equal(page1.truncated.any, true);
  assert.deepEqual(page1.truncated.fields[0], { field: 'entries', shown: 2, total: 3, order: 'path asc, httpMethod asc', nextOffset: 2 });
  const page2 = call(g, { limit: 2, offset: 2 });
  assert.deepEqual(page2.answer.entries.map((e) => e.id), ['GET /p/{id}']);
  assert.equal(page2.truncated.any, false);
  assert.equal(page2.truncated.fields[0].nextOffset, null);
});

test('flow list: a SQL-only pack has no code axis — empty reason not-shipped, not "none"', () => {
  const g = buildGraphFromSql(catalog(), lineage());
  const r = call(g, {});
  assert.equal(r.answer.entries.length, 0);
  assert.equal(r.answer.empty.entries, 'not-shipped');
});

// ---------------------------------------------------------------------------
// chain mode
// ---------------------------------------------------------------------------

test('flow chain from an endpoint: entry starts at the handler, four lanes come back', () => {
  const g = flowGraph();
  const r = call(g, { endpoint: 'GET /p/{id}' });
  const a = r.answer;
  assert.equal(a.entry.kind, 'endpoint');
  assert.equal(a.entry.id, 'GET /p/{id}');
  assert.equal(a.entry.handlerShort, 'PController#get');
  assert.equal(a.entry.start, nodeId('symbol', 'com.x.PController#get')); // the walk begins at the code
  assert.equal(a.walk.mode, 'conservative');
  assert.equal(a.walk.depth, 6);
  assert.equal(a.walk.walked, 13);
  assert.deepEqual(a.services.map((s) => s.short), ['Ext#send', 'PService#load', 'PServiceImpl#load']);
  assert.deepEqual(a.statements.map((s) => s.short), ['PMapper.selectByPrimaryKey', 'PMapper.updateByPrimaryKey']);
  assert.deepEqual(a.tables.map((t) => t.table), ['p', 'q']);
  // the first service row links back to the entry row the page drew
  assert.equal(a.services[0].link.from, a.entry.start);
  assert.equal(a.tables[0].via, 'com.x.PMapper.selectByPrimaryKey');
  assert.equal(a.statements[0].grade, 'SOUND_SET'); // weakest link, not the EXACT last edge
  // the statement hangs off the SERVICE that called its mapper (the mapper row
  // is folded into the statement), so the drawing has no missing middle
  assert.equal(a.statements[0].link.from, nodeId('symbol', 'com.x.PServiceImpl#load'));
  assert.equal(a.statements[0].symbol, 'com.x.PMapper#selectByPrimaryKey');
  assert.ok(a.services.some((sv) => 'symbol:' + sv.id === a.statements[0].link.from), 'the statement parent is a rendered service row');
  assert.equal(a.empty, undefined);
  assert.deepEqual(r.trust.axes, ['flow']);
  assert.deepEqual(r.truncated.fields.map((f) => f.field), ['services', 'statements', 'tables']);
  assert.equal(r.truncated.fields[0].order, 'hops asc, grade desc, id asc');
  assert.equal(r.truncated.fields[2].order, 'hops asc, grade desc, table asc');
});

test('flow chain from a symbol: hop 0 is that method; a lane with nothing in it says "none"', () => {
  const g = flowGraph();
  const r = call(g, { symbol: 'com.x.PServiceImpl#load' });
  const a = r.answer;
  assert.equal(a.entry.kind, 'symbol');
  assert.equal(a.entry.short, 'PServiceImpl#load');
  assert.equal(a.entry.transactional, true);
  assert.equal(a.entry.start, nodeId('symbol', 'com.x.PServiceImpl#load'));
  assert.equal(a.services.length, 0);          // only mapper methods below it
  assert.equal(a.empty.services, 'none');
  assert.deepEqual(a.statements.map((s) => s.hops), [2, 2]);
  // Still candidates: the first hop OUT of this start is the impl→mapper
  // MAY_CALL, so the weakest link on every row below it is SOUND_SET.
  assert.deepEqual(a.tables.map((t) => [t.table, t.hops, t.grade]), [['p', 3, 'SOUND_SET'], ['q', 3, 'SOUND_SET']]);
  assert.deepEqual(a.statements.map((s) => s.grade), ['SOUND_SET', 'SOUND_SET']);
});

test('flow chain: an endpoint whose handler calls nothing — every lane empty, no cut claimed', () => {
  const g = flowGraph();
  const r = call(g, { endpoint: 'POST /p/create' });
  assert.equal(r.answer.walk.walked, 0);
  assert.deepEqual(r.answer.layers, []); // nothing was walked, so there is no hop to fold
  assert.deepEqual(r.answer.empty, { services: 'none', statements: 'none', tables: 'none', layers: 'none' });
  assert.deepEqual(r.answer.walk.cut, { depth: 0, nodeCap: false, byMode: 0, generated: 0 });
  assert.deepEqual(r.answer.walk.beyond, { tables: 0 });
  assert.equal(r.answer.walk.note, null);
  assert.equal(r.limits.length, 0);
});

test('flow chain: mode=strict returns nothing and says the MODE did it (limits + walk.note)', () => {
  const g = flowGraph();
  const r = call(g, { endpoint: 'GET /p/{id}', mode: 'strict' });
  assert.equal(r.answer.services.length, 0);
  assert.equal(r.answer.statements.length, 0);
  assert.equal(r.answer.tables.length, 0);
  assert.equal(r.answer.walk.cut.byMode, 2);
  const entry = r.limits.find((l) => l.scope === 'flow' && /grade floor of mode=strict/.test(l.reason));
  assert.ok(entry, 'expected a limits entry naming the mode');
  assert.ok(r.answer.walk.note.includes(entry.reason), 'walk.note must repeat what limits says');
});

test('flow chain: depth 3 stops above the statements and says they are unknown, not absent', () => {
  const g = flowGraph();
  const r = call(g, { endpoint: 'GET /p/{id}', depth: 3 });
  assert.equal(r.answer.walk.depth, 3);
  assert.equal(r.answer.statements.length, 0);
  assert.equal(r.answer.empty.statements, 'none');
  assert.equal(r.answer.tables.length, 0);
  assert.equal(r.answer.walk.cut.depth, 2); // both mapper methods are calls we did not follow
  const entry = r.limits.find((l) => l.scope === 'flow' && /depth cap 3 reached at 2 call\(s\)/.test(l.reason));
  assert.ok(entry, 'expected a depth-cut limits entry');
  assert.ok(/unknown, not absent/.test(entry.reason));
});

test('flow chain: limit=1 keeps the FIRST row of each lane in the declared order, and declares the rest via nextOffset', () => {
  const g = flowGraph();
  const full = call(g, { endpoint: 'GET /p/{id}' });
  const r = call(g, { endpoint: 'GET /p/{id}', limit: 1 });
  assert.equal(r.answer.services.length, 1);
  assert.equal(r.answer.statements.length, 1);
  assert.equal(r.answer.tables.length, 1);
  // A PREFIX of the ordered list, not "some row": which row survives is the
  // whole point of publishing an order (hops asc, grade desc, id asc).
  assert.deepEqual(r.answer.services.map((s) => s.id), ['com.ext.Ext#send']);
  assert.deepEqual(r.answer.statements.map((s) => s.id), ['com.x.PMapper.selectByPrimaryKey']);
  assert.deepEqual(r.answer.tables.map((t) => t.table), ['p']);
  for (const lane of ['services', 'statements', 'tables']) {
    assert.deepEqual(r.answer[lane], full.answer[lane].slice(0, 1), lane + ' must be the first row of the full list');
  }
  assert.equal(r.truncated.any, true);
  const svc = r.truncated.fields.find((f) => f.field === 'services');
  assert.deepEqual(svc, { field: 'services', shown: 1, total: 3, order: 'hops asc, grade desc, id asc', nextOffset: 1 });
});

test('flow list: paging past the end is "not-in-this-axis", not "none" — there ARE endpoints, you just walked off the list', () => {
  const g = flowGraph();
  const r = call(g, { offset: 99 });
  assert.deepEqual(r.answer.entries, []);
  assert.equal(r.answer.empty.entries, 'not-in-this-axis');
  assert.equal(r.truncated.fields[0].total, 3);
  assert.equal(r.truncated.fields[0].nextOffset, null);
});

test('flow chain: the node cap says the chain is bigger than one picture (and is not a depth or mode note)', () => {
  // 5000 methods called straight from one handler: past the 4000-node cap.
  const facts = [
    { kind: 'type', fqn: 'com.x.Wide', typeKind: 'class', package: 'com.x', file: 'src/Wide.java', implements: [] },
    { kind: 'method', fqn: 'com.x.Wide#run', owner: 'com.x.Wide', paramCount: 0, line: 1 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/wide', handler: 'com.x.Wide#run', line: 1 },
  ];
  for (let i = 0; i < 5000; i++) {
    facts.push({ kind: 'type', fqn: `com.x.T${i}`, typeKind: 'class', package: 'com.x', file: `src/T${i}.java`, implements: [] });
    facts.push({ kind: 'method', fqn: `com.x.T${i}#m`, owner: `com.x.T${i}`, paramCount: 0, line: 1 });
    facts.push({ kind: 'call', from: 'com.x.Wide#run', method: 'm', toTypeSimple: `T${i}` });
  }
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, facts);
  const r = call(g, { endpoint: 'GET /wide', limit: 5 });
  assert.equal(r.answer.walk.cut.nodeCap, true);
  assert.equal(r.answer.walk.walked, 4000);
  const note = r.limits.find((l) => l.scope === 'flow' && /node cap reached/.test(l.reason));
  assert.ok(note, 'expected a node-cap limits entry');
  assert.ok(/bigger than one picture/.test(note.reason));
  assert.ok(r.answer.walk.note.includes(note.reason), 'walk.note must repeat what limits says');
  assert.equal(r.limits.some((l) => /depth cap/.test(l.reason)), false, 'a node cap is not a depth cap');
});

test('flow chain: layers fold the same walk per hop, and limit does not cut them', () => {
  const g = flowGraph();
  const full = call(g, { endpoint: 'GET /p/{id}' });
  assert.deepEqual(full.answer.layers.map((l) => [l.hops, l.nodes, l.services, l.statements, l.tables]), [
    [1, 2, 2, 0, 0], [2, 1, 1, 0, 0], [3, 2, 0, 0, 0], [4, 2, 0, 2, 0], [5, 2, 0, 0, 2],
  ]);
  for (const g2 of ['EXACT', 'SOUND_SET', 'HEURISTIC']) {
    assert.equal(full.answer.layers.reduce((n, l) => n + l.byLinkGrade[g2], 0), full.answer.walk.byLinkGrade[g2]);
  }
  assert.deepEqual(full.answer.walk.beyond, { tables: 0 });
  // A census is not a list: the lanes are cut to one row each, the layers are not.
  const cut = call(g, { endpoint: 'GET /p/{id}', limit: 1 });
  assert.equal(cut.answer.services.length, 1);
  assert.deepEqual(cut.answer.layers, full.answer.layers);
  // …and it carries no truncated entry, because nothing about it was cut
  assert.equal(cut.truncated.fields.some((f) => f.field === 'layers'), false);
});

test('flow chain: routed through callTool the response is contract-valid', () => {
  const g = flowGraph();
  const r = callTool('flow', { endpoint: 'GET /p/{id}' }, { graph: g, basis: basis() });
  assertContract(r);
  assert.equal(r.answer.entry.id, 'GET /p/{id}');
  assert.equal(r.trust.trustLevel, 'UNCERTIFIED');
});

// ---------------------------------------------------------------------------
// bad input
// ---------------------------------------------------------------------------

test('flow: endpoint AND symbol together is bad-input', () => {
  const g = flowGraph();
  assert.throws(() => flow(g, { endpoint: 'GET /p/{id}', symbol: 'com.x.PServiceImpl#load' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input');
});

test('flow: an unknown endpoint / symbol throws unknown-endpoint / unknown-symbol', () => {
  const g = flowGraph();
  assert.throws(() => flow(g, { endpoint: 'GET /nope' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'unknown-endpoint');
  assert.throws(() => flow(g, { symbol: 'com.x.Nope#nope' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'unknown-symbol');
});

test('flow: depth outside 1..8, a bad mode, an over-limit and offset in chain mode are all bad-input', () => {
  const g = flowGraph();
  const bad = (args) => assert.throws(() => flow(g, args, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input');
  bad({ endpoint: 'GET /p/{id}', depth: 9 });
  bad({ endpoint: 'GET /p/{id}', depth: 0 });
  bad({ endpoint: 'GET /p/{id}', limit: 201 });
  bad({ endpoint: 'GET /p/{id}', mode: 'lax' });
  bad({ endpoint: 'GET /p/{id}', offset: 1 }); // a walk is one picture — raise limit instead
  bad({ limit: 501 });                        // list mode caps at 500
  // An Object.prototype key is a BAD MODE, not a mode: reading the mode table
  // as a plain object would hand 'constructor' to the engine as a 500.
  for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    bad({ endpoint: 'GET /p/{id}', mode: m });
  }
});

test('flow: called with no arguments at all is list mode, not a crash', () => {
  const g = flowGraph();
  const r = flow(g, undefined, ctx(g));
  assertContract(r);
  assert.equal(r.answer.entries.length, 3);
});

// ---------------------------------------------------------------------------
// the real pack (skipped when it is not on this machine)
// ---------------------------------------------------------------------------

// The fixture guard lives in ONE place for every mall-pinned test
// (test/helpers/mall_fixture.mjs): absent -> skip; a different digest or
// commit -> skip naming both and the rebuild command; the pin -> run.

test('flow on the mall pack: GET /product/updateInfo/{id} walks 94 nodes, statements at hop 4, tables at hop 5', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { endpoint: 'GET /product/updateInfo/{id}', depth: 6, mode: 'conservative' });
  assert.equal(r.answer.walk.walked, 94);
  assert.equal(r.answer.walk.cut.depth, 0); // nothing beyond hop 6 that this call runs through
  assert.equal(Math.min(...r.answer.statements.map((s) => s.hops)), 4); // handler→iface→impl→mapper→statement
  assert.equal(Math.min(...r.answer.tables.map((t) => t.hops)), 5);
  assert.equal(r.answer.services.length, 2);
  assert.equal(r.answer.statements.length, 1);
  assert.equal(r.answer.tables.length, 7);
  assert.equal(r.answer.statements[0].grade, 'SOUND_SET'); // reached through candidate calls
  assert.equal(r.limits.length, 0, 'no depth note when the walk really did finish');

  const strict = call(g, { endpoint: 'GET /admin/info', mode: 'strict' });
  assert.equal(strict.answer.services.length, 0);
  assert.ok(strict.limits.some((l) => l.scope === 'flow' && l.reason.includes('mode=strict')),
    'strict on a real handler must explain itself with the mode');
});

test('flow on the mall pack: the depth note counts unfollowed CALLS, and more depth really does reveal more', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  // A walk that really did finish must NOT warn: the boundary here is a
  // statement, whose tables are listed from its own edges.
  const done = call(g, { endpoint: 'GET /product/updateInfo/{id}', depth: 6 });
  assert.equal(done.answer.walk.cut.depth, 0);
  assert.equal(done.limits.filter((l) => /depth cap/.test(l.reason)).length, 0, 'no warning about nothing');

  // `POST /order/generateConfirmOrder` is the other case: since javafacts/4 the
  // lane follows OmsPortalOrderServiceImpl's own `calcCartAmount(...)`-style
  // calls, so its chain is genuinely longer than the cap at EVERY depth below.
  // The note is the count of CALLS not followed, and it shrinks as depth grows.
  const at5 = call(g, { endpoint: 'POST /order/generateConfirmOrder', depth: 5 });
  assert.equal(at5.answer.walk.cut.depth, 4);
  assert.ok(at5.limits.some((l) => l.scope === 'flow' && /depth cap 5 reached at 4 call\(s\)/.test(l.reason)));
  assert.equal(at5.answer.statements.length, 1);

  const at6 = call(g, { endpoint: 'POST /order/generateConfirmOrder', depth: 6 });
  assert.equal(at6.answer.walk.cut.depth, 2);
  assert.equal(at6.answer.statements.length, 3);
  assert.equal(at6.answer.tables.length, 6);
  assert.equal(Math.max(...at6.answer.tables.map((t) => t.hops)), 7); // deeper than the cap, and known

  const at8 = call(g, { endpoint: 'POST /order/generateConfirmOrder', depth: 8 });
  assert.equal(at8.answer.walk.cut.depth, 1);
  assert.equal(at8.answer.statements.length, 4);
  assert.equal(at8.answer.tables.length, 7);
  // Monotone: a deeper walk never LOSES a table a shallower one found.
  for (const t of at6.answer.tables) {
    assert.ok(at8.answer.tables.some((x) => x.table === t.table), `${t.table} vanished at depth 8`);
  }
  assert.ok(at5.answer.statements.length < at6.answer.statements.length
    && at6.answer.statements.length < at8.answer.statements.length, 'a cut chain really does show fewer statements');
});

test('flow on the mall pack: layers fold POST /product/update/{id} into 5 hops, and a table past the cap is `beyond`', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { endpoint: 'POST /product/update/{id}', depth: 6 });
  assert.deepEqual(r.answer.layers.map((l) => [l.hops, l.nodes, l.services, l.statements, l.tables]), [
    [1, 1, 1, 0, 0], [2, 1, 1, 0, 0], [3, 9, 2, 0, 0], [4, 11, 1, 7, 0], [5, 10, 0, 3, 7], [6, 1, 0, 0, 1],
  ]);
  // Since javafacts/4 hops 3-5 also hold PmsProductServiceImpl's OWN methods
  // (`handleSkuStockCode`, `relateAndInsertList`, `handleUpdateSkuStockList`),
  // which is why three more statements and one more table appear a hop later.
  assert.equal(r.answer.services.length, 5);
  assert.equal(r.answer.statements.length, 10);
  assert.equal(r.answer.tables.length, 8);
  assert.equal(r.answer.layers.reduce((n, l) => n + l.nodes, 0), 33);
  for (const grade of ['EXACT', 'SOUND_SET', 'HEURISTIC']) {
    assert.equal(r.answer.layers.reduce((n, l) => n + l.byLinkGrade[grade], 0), r.answer.walk.byLinkGrade[grade]);
  }
  assert.deepEqual(r.answer.walk.beyond, { tables: 0 });

  // …and the endpoint whose tables sit one hop past the cap: 3 table rows, of
  // which the 2 the walk never stepped onto are counted apart from the layers.
  const res = call(g, { endpoint: 'POST /resource/update/{id}', depth: 6 });
  assert.deepEqual(res.answer.layers.map((l) => l.hops), [1, 2, 3, 4, 5, 6]);
  assert.equal(res.answer.tables.length, 3);
  assert.equal(res.answer.layers.reduce((n, l) => n + l.tables, 0), 1);
  assert.deepEqual(res.answer.walk.beyond, { tables: 2 });
});

test('flow on the mall pack: a table\'s `via` follows the rule, not the order the walk met its statements', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { endpoint: 'GET /flash/list' });
  const t = r.answer.tables.find((x) => x.table === 'sms_flash_promotion');
  assert.equal(t.statements, 2);
  // Both statements sit at hop 4 with the same grade, so the tie falls to the
  // id — and the BFS reached selectByPrimaryKey FIRST, so "whichever came
  // first" would have named the other one.
  const touching = r.answer.statements.filter((s) => (s.tables || []).some((x) => x.table === 'sms_flash_promotion'));
  assert.deepEqual(touching.map((s) => [s.hops, s.grade]), [[4, 'SOUND_SET'], [4, 'SOUND_SET']]);
  assert.equal(t.via, 'com.macro.mall.mapper.SmsFlashPromotionMapper.selectByExample');
  const met = [...g.reach(r.answer.entry.start, { mode: 'conservative', maxHops: 6, edgeTypes: FLOW_EDGE_TYPES }).keys()]
    .filter((k) => k.startsWith('statement:com.macro.mall.mapper.SmsFlashPromotionMapper'));
  assert.equal(met[0], 'statement:com.macro.mall.mapper.SmsFlashPromotionMapper.selectByPrimaryKey', 'sanity: the other one really is met first');
});

// ---------------------------------------------------------------------------
// direction=up — the mirror: "if I change THIS, which endpoints are affected?"
// ---------------------------------------------------------------------------

test('flow up from a column: target → statements → services → endpoints, no tables lane', () => {
  const g = flowGraph();
  const r = call(g, { column: 'p.name', direction: 'up' });
  const a = r.answer;
  assert.equal(a.entry.kind, 'column');
  assert.equal(a.entry.id, 'p.name');
  assert.equal(a.entry.short, 'p.name');
  assert.equal(a.entry.start, nodeId('column', 'p.name'));
  assert.equal(a.walk.direction, 'up');
  assert.equal(a.walk.depth, 8, 'the reverse walk defaults to the full 8 hops');
  assert.equal(a.tables, undefined, 'walking up, the target IS the table side');
  assert.deepEqual(a.statements.map((s) => [s.id, s.hops]), [
    ['com.x.PMapper.selectByPrimaryKey', 1], ['com.x.PMapper.updateByPrimaryKey', 1],
  ]);
  // hop-1 rows hang off the target itself — the only row above them on screen
  for (const s of a.statements) assert.equal(s.link.from, a.entry.start);
  const impl = a.services.find((s) => s.id === 'com.x.PServiceImpl#load');
  assert.equal(impl.hops, 3);
  assert.equal(impl.link.from, nodeId('statement', 'com.x.PMapper.selectByPrimaryKey'), 'the mapper is folded; the service links to the statement');
  const handler = a.services.find((s) => s.id === 'com.x.PController#get');
  assert.equal(handler.handler, true);
  assert.deepEqual(a.endpoints.map((e) => [e.id, e.hops, e.grade, e.handlerShort]), [
    ['GET /p/{id}', 6, 'SOUND_SET', 'PController#get'],
  ]);
  assert.equal(a.endpoints[0].hops, handler.hops + 1);
  assert.equal(a.empty, undefined);
  assert.deepEqual(r.truncated.fields.map((f) => f.field), ['statements', 'services', 'endpoints']);
  assert.equal(r.truncated.fields[2].order, 'hops asc, grade desc, id asc');
  assert.deepEqual(r.trust.axes, ['flow']);
  assert.equal(r.limits.length, 0);
});

test('flow up from a table / statement / symbol: the same chain, entered further along', () => {
  const g = flowGraph();
  const tbl = call(g, { table: 'q', direction: 'up' });
  assert.equal(tbl.answer.entry.kind, 'table');
  assert.deepEqual(tbl.answer.statements.map((s) => s.id), ['com.x.PMapper.updateByPrimaryKey']);
  assert.deepEqual(tbl.answer.endpoints.map((e) => e.id), ['GET /p/{id}']);

  const st = call(g, { statement: 'com.x.PMapper.selectByPrimaryKey', direction: 'up' });
  assert.equal(st.answer.entry.kind, 'statement');
  assert.equal(st.answer.entry.statementType, 'select');
  // a statement read as the TARGET is described like one read as a row: its tables
  assert.deepEqual(st.answer.entry.tables, [{ table: 'p', access: 'read' }]);
  const upd = call(g, { statement: 'com.x.PMapper.updateByPrimaryKey', direction: 'up' });
  assert.deepEqual(upd.answer.entry.tables, [{ table: 'p', access: 'write' }, { table: 'q', access: 'write' }]);
  assert.equal(call(g, { column: 'p.name', direction: 'up' }).answer.entry.tables, undefined, 'only a statement target has them');
  assert.deepEqual(st.answer.statements, []);
  // nothing upstream of a statement IS a statement: the axis, not an absence
  assert.equal(st.answer.empty.statements, 'not-in-this-axis');
  assert.deepEqual(st.answer.services.map((s) => [s.id, s.hops]), [
    ['com.x.PServiceImpl#load', 2], ['com.x.PService#load', 3], ['com.x.PController#get', 4],
  ]);
  assert.deepEqual(st.answer.endpoints.map((e) => [e.id, e.hops]), [['GET /p/{id}', 5]]);

  const sym = call(g, { symbol: 'com.x.PServiceImpl#load', direction: 'up' });
  assert.equal(sym.answer.entry.kind, 'symbol');
  assert.equal(sym.answer.entry.transactional, true);
  assert.equal(sym.answer.empty.statements, 'not-in-this-axis');
  assert.deepEqual(sym.answer.services.map((s) => s.id), ['com.x.PService#load', 'com.x.PController#get']);
  assert.deepEqual(sym.answer.endpoints.map((e) => [e.id, e.hops]), [['GET /p/{id}', 3]]);
});

test('flow up: a column nothing calls into — statements yes, endpoints "none", and the mode is not blamed', () => {
  const g = flowGraph();
  // q.id is declared but touched by no statement at all
  const r = call(g, { column: 'q.id', direction: 'up' });
  assert.deepEqual(r.answer.statements, []);
  assert.deepEqual(r.answer.endpoints, []);
  assert.equal(r.answer.empty.statements, 'none', 'a COLUMN target does have a statements axis — there is simply nothing on it');
  assert.equal(r.answer.empty.endpoints, 'none');
  assert.equal(r.answer.walk.cut.byMode, 0);
  assert.equal(r.answer.walk.note, null);
  assert.equal(r.limits.length, 0);
});

test('flow up: mode=strict keeps the EXACT SQL edges and says the MODE dropped the calls above them', () => {
  const g = flowGraph();
  const r = call(g, { column: 'p.name', direction: 'up', mode: 'strict' });
  assert.equal(r.answer.statements.length, 2, 'READS/WRITES and IMPLEMENTS_STMT are EXACT');
  assert.deepEqual(r.answer.services, []);
  assert.deepEqual(r.answer.endpoints, []);
  assert.ok(r.answer.walk.cut.byMode > 0);
  const entry = r.limits.find((l) => l.scope === 'flow' && /grade floor of mode=strict/.test(l.reason));
  assert.ok(entry, 'expected a limits entry naming the mode');
  assert.ok(r.answer.walk.note.includes(entry.reason));
});

test('flow up: a statement at the cap is a CUT — an empty endpoints lane there is the depth, and it says so', () => {
  const g = flowGraph();
  const r = call(g, { column: 'p.name', direction: 'up', depth: 1 });
  assert.equal(r.answer.statements.length, 2, 'the SQL side is complete at hop 1');
  assert.deepEqual(r.answer.endpoints, []);
  assert.equal(r.answer.empty.endpoints, 'none');
  assert.ok(r.answer.walk.cut.depth > 0, 'each statement hides its mapper and the callers above it');
  assert.equal(r.answer.walk.cut.depth, 2);
  const entry = r.limits.find((l) => l.scope === 'flow' && /depth cap 1 reached at 2 caller\(s\)/.test(l.reason));
  assert.ok(entry, 'an endpoints lane emptied by the DEPTH must say so, not read as an absence');
  assert.ok(/deeper CALLERS were not walked and endpoints beyond are unknown, not absent/.test(entry.reason));
  assert.ok(r.answer.walk.note.includes(entry.reason), 'walk.note must repeat what limits says');
  // the same boundary walking DOWN still claims nothing (its tables are derived)
  const down = call(g, { endpoint: 'GET /p/{id}', depth: 4 });
  assert.equal(down.answer.walk.cut.depth, 0);
  assert.equal(down.limits.filter((l) => /depth cap/.test(l.reason)).length, 0);
});

test('flow up: the depth note talks about CALLERS, and what is past the cap is unknown, not absent', () => {
  const g = flowGraph();
  const r = call(g, { column: 'p.name', direction: 'up', depth: 3 });
  assert.equal(r.answer.walk.cut.depth, 1);
  assert.deepEqual(r.answer.endpoints, []);
  const entry = r.limits.find((l) => l.scope === 'flow' && /depth cap 3 reached at 1 caller\(s\)/.test(l.reason));
  assert.ok(entry, 'expected a depth-cut limits entry');
  assert.ok(/deeper CALLERS were not walked and endpoints beyond are unknown, not absent/.test(entry.reason));
  // at depth 5 the handler IS the boundary: its route is derived, so nothing is
  // claimed cut — and the route one hop past the cap is counted apart
  const at5 = call(g, { column: 'p.name', direction: 'up', depth: 5 });
  assert.equal(at5.answer.walk.cut.depth, 0);
  assert.deepEqual(at5.answer.walk.beyond, { endpoints: 1 });
  assert.equal(at5.limits.filter((l) => /depth cap/.test(l.reason)).length, 0);
});

test('flow up: limit cuts each lane to a PREFIX of its declared order and declares the rest', () => {
  const g = flowGraph();
  const full = call(g, { column: 'p.name', direction: 'up' });
  const r = call(g, { column: 'p.name', direction: 'up', limit: 1 });
  for (const lane of ['statements', 'services', 'endpoints']) {
    assert.deepEqual(r.answer[lane], full.answer[lane].slice(0, 1), lane + ' must be the first row of the full list');
  }
  assert.equal(r.truncated.any, true);
  assert.deepEqual(r.truncated.fields.find((f) => f.field === 'services'),
    { field: 'services', shown: 1, total: 3, order: 'hops asc, grade desc, id asc', nextOffset: 1 });
  // the layers census is never cut by limit
  assert.deepEqual(r.answer.layers, full.answer.layers);
});

test('flow up: layers fold the reverse walk per hop; the derived route sits in its hop with no node of its own', () => {
  const g = flowGraph();
  const r = call(g, { column: 'p.name', direction: 'up' });
  assert.deepEqual(r.answer.layers.map((l) => [l.hops, l.nodes, l.statements, l.services, l.endpoints]), [
    [1, 2, 2, 0, 0], [2, 2, 0, 0, 0], [3, 1, 0, 1, 0], [4, 1, 0, 1, 0], [5, 1, 0, 1, 0], [6, 0, 0, 0, 1],
  ]);
  for (const grade of ['EXACT', 'SOUND_SET', 'HEURISTIC']) {
    assert.equal(r.answer.layers.reduce((n, l) => n + l.byLinkGrade[grade], 0), r.answer.walk.byLinkGrade[grade]);
  }
  assert.equal(r.answer.walk.endLane, 'endpoints');
});

test('flow up: routed through callTool the response is contract-valid', () => {
  const g = flowGraph();
  const r = callTool('flow', { column: 'p.name', direction: 'up' }, { graph: g, basis: basis() });
  assertContract(r);
  assert.equal(r.answer.entry.id, 'p.name');
  assert.equal(r.answer.walk.direction, 'up');
});

test('flow: the direction and the entry must agree — every bad combination is bad-input', () => {
  const g = flowGraph();
  const bad = (args, re) => assert.throws(() => flow(g, args, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input' && (!re || re.test(e.message)));
  bad({ direction: 'sideways', column: 'p.name' }, /direction must be down \| up/);
  bad({ direction: 'up', endpoint: 'GET /p/{id}' }, /an endpoint has nothing upstream/);
  bad({ direction: 'up' }, /needs a target/);            // no list mode upstream
  bad({ direction: 'up', column: 'p.name', table: 'p' }, /exactly one/);
  bad({ direction: 'up', symbol: 'com.x.PServiceImpl#load', statement: 'com.x.PMapper.selectByPrimaryKey' }, /exactly one/);
  bad({ column: 'p.name' }, /direction=up target/);      // a column is not a downstream entry
  bad({ table: 'p' }, /direction=up target/);
  bad({ statement: 'com.x.PMapper.selectByPrimaryKey' }, /direction=up target/);
  bad({ direction: 'up', column: 'p.name', offset: 1 }); // a walk is one picture
  bad({ direction: 'up', column: 'p.name', depth: 9 });
  bad({ direction: 'up', column: 'p.name', mode: 'lax' });
  // an unknown target is not-found, not bad-input
  assert.throws(() => flow(g, { direction: 'up', column: 'p.nope' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-column');
  assert.throws(() => flow(g, { direction: 'up', table: 'nope' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-table');
  assert.throws(() => flow(g, { direction: 'up', statement: 'no.such' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-statement');
});

test('flow up on a SQL-only pack: the code lanes are NOT SHIPPED, not empty — and the answer says so', () => {
  // The Java lane never ran, so there is no code above the statements. "none"
  // would read as "no endpoint reaches this column"; the honest word is the one
  // endpoint_impact / transactions / flow-list already use.
  const g = buildGraphFromSql(catalog(), lineage());
  const r = call(g, { column: 'p.name', direction: 'up' });
  assert.equal(r.answer.statements.length, 2, 'the SQL axis is there');
  assert.deepEqual(r.answer.services, []);
  assert.deepEqual(r.answer.endpoints, []);
  assert.equal(r.answer.empty.services, 'not-shipped');
  assert.equal(r.answer.empty.endpoints, 'not-shipped');
  assert.equal(r.answer.empty.statements, undefined, 'the lane that IS shipped carries no reason');
  const note = r.limits.find((l) => l.scope === 'flow' && /no code axis, because the Java lane did not run/.test(l.reason));
  assert.ok(note, 'expected a limits entry naming the missing lane');
  assert.ok(r.answer.walk.note.includes(note.reason), 'and the same sentence in walk.note');
  // a target with nothing on the SQL axis either still separates the two cases
  const empty = call(g, { column: 'q.id', direction: 'up' });
  assert.equal(empty.answer.empty.statements, 'none', 'this lane is shipped and really is empty');
  assert.equal(empty.answer.empty.endpoints, 'not-shipped');
  // …and with a code axis present, the same lanes go back to "none"
  const withCode = call(flowGraph(), { column: 'q.id', direction: 'up' });
  assert.equal(withCode.answer.empty.endpoints, 'none');
  assert.equal(withCode.limits.some((l) => /no code axis/.test(l.reason)), false);
});

test('flow up: a TABLE no statement executes — the statements lane is shipped and empty, so "none"', () => {
  const g = flowGraph();
  // z is only JOINed to p; no statement executes it
  g.addNode({ id: nodeId('table', 'z'), comment: 'joined only' });
  g.addEdge({ from: nodeId('table', 'p'), to: nodeId('table', 'z'), type: 'JOINS', grade: 'EXACT', evidence: { columns: ['id=k'], count: 1 } });
  const r = call(g, { table: 'z', direction: 'up' });
  assert.equal(r.answer.entry.kind, 'table');
  assert.equal(r.answer.entry.comment, 'joined only', 'the entry carries the table comment');
  assert.equal(r.answer.entry.short, 'z');
  assert.deepEqual(r.answer.statements, []);
  assert.equal(r.answer.empty.statements, 'none', 'a table target DOES have a statements axis');
  assert.equal(r.answer.empty.endpoints, 'none');
  assert.equal(r.answer.walk.cut.byMode, 0);
  // the entry names the thing you are changing: its comment (from the catalog)
  // and its short form, whichever kind it is
  assert.equal(call(g, { table: 'p', direction: 'up' }).answer.entry.comment, 'product');
  const col = call(g, { column: 'p.id', direction: 'up' });
  assert.equal(col.answer.entry.short, 'p.id');
  assert.equal(col.answer.entry.comment, null, 'no comment in the catalog is null, never a made-up one');
});

test('flow up: the default limit is 40 per lane, and a cut lane is a PREFIX of the full order', () => {
  // No mall target has more than 36 services upstream, so the default cut is
  // proven on a graph built to exceed it: 45 services calling the same mapper.
  const g = flowGraph();
  for (let i = 0; i < 45; i++) {
    const owner = `com.x.S${String(i).padStart(2, '0')}`;
    const id = nodeId('symbol', `${owner}#run`);
    g.addNode({ id, owner, file: `src/${owner}.java`, line: 10 + i });
    g.addEdge({ from: id, to: nodeId('symbol', 'com.x.PMapper#selectByPrimaryKey'), type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { basis: 'parse-tree receiver→field→type', receiver: 'm' } });
  }
  const capped = call(g, { column: 'p.name', direction: 'up' });                 // no limit given
  const full = call(g, { column: 'p.name', direction: 'up', limit: 200 });
  assert.ok(full.answer.services.length > 40, 'the fixture really does exceed one page');
  assert.equal(capped.answer.services.length, 40, 'the up default limit is 40');
  const t = capped.truncated.fields.find((f) => f.field === 'services');
  assert.deepEqual([t.shown, t.total, t.nextOffset], [40, full.answer.services.length, 40]);
  assert.equal(capped.truncated.any, true);
  assert.deepEqual(capped.answer.services, full.answer.services.slice(0, 40), 'a cut lane is a PREFIX of the declared order');
  assert.equal(capped.answer.empty, undefined, 'a cut lane is not an empty one');
});

test('flow up on the mall pack: the endpoints lane matches an independently sorted copy', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const rank = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };
  for (const args of [{ column: 'pms_product.price' }, { table: 'ums_admin' }, { column: 'ums_menu.title' }]) {
    const eps = call(g, { ...args, direction: 'up', depth: 8, limit: 200 }).answer.endpoints;
    const sorted = [...eps].sort((a, b) => (a.hops - b.hops) || (rank[b.grade] - rank[a.grade]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(eps, sorted, JSON.stringify(args));
    assert.ok(eps.length > 1, 'a one-row lane would prove nothing');
  }
});

test('flow: direction=down is the default and is untouched by all of this', () => {
  const g = flowGraph();
  const explicit = call(g, { endpoint: 'GET /p/{id}', direction: 'down' });
  const implicit = call(g, { endpoint: 'GET /p/{id}' });
  assert.deepEqual(explicit.answer, implicit.answer);
  assert.equal(implicit.answer.walk.direction, 'down');
  assert.equal(implicit.answer.walk.depth, 6);
  assert.deepEqual(implicit.answer.tables.map((t) => t.table), ['p', 'q']);
  assert.equal(implicit.answer.endpoints, undefined);
});

// ---------------------------------------------------------------------------
// the real pack, walking up
// ---------------------------------------------------------------------------

test('flow up on the mall pack: pms_product.price reaches 27 endpoints at hop 6, nothing cut', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { column: 'pms_product.price', direction: 'up', depth: 8, limit: 200 });
  assert.equal(r.answer.walk.walked, 115);
  assert.deepEqual(r.answer.walk.cut, { depth: 0, nodeCap: false, byMode: 0, generated: 0 });
  assert.equal(r.answer.statements.length, 18);
  assert.equal(r.answer.services.length, 79);
  assert.equal(r.answer.endpoints.length, 27);
  assert.equal(Math.min(...r.answer.statements.map((s) => s.hops)), 1);
  assert.equal(Math.min(...r.answer.endpoints.map((e) => e.hops)), 6);
  assert.equal(r.answer.endpoints.every((e) => e.grade === 'SOUND_SET'), true, 'reached through candidate calls');
  assert.equal(r.limits.length, 0);
  // the same 27 as the table above it
  // The TABLE is reached by two more routes than the COLUMN: `pms_product` as a
  // whole is touched by statements that never name `price`.
  const t = call(g, { table: 'pms_product', direction: 'up', depth: 8, limit: 200 });
  assert.equal(t.answer.endpoints.length, 29);
  // …and at depth 1 the walk stops on the statements, which DO hide their
  // callers: 0 endpoints there is the cap talking, and the answer says so.
  const at1 = call(g, { column: 'pms_product.price', direction: 'up', depth: 1, limit: 200 });
  assert.equal(at1.answer.statements.length, 18);
  assert.deepEqual(at1.answer.endpoints, []);
  assert.equal(at1.answer.walk.cut.depth, 18);
  assert.ok(at1.limits.some((l) => l.scope === 'flow' && /depth cap 1 reached at 18 caller\(s\)/.test(l.reason)));
  assert.equal(r.answer.walk.cut.depth, 0, 'at depth 8 nothing is cut');
});

test('flow up on the mall pack: a column no endpoint reaches says "none", and does not blame the mode', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { column: 'cms_prefrence_area.pic', direction: 'up', depth: 8, limit: 200 });
  assert.equal(r.answer.statements.length, 8, 'the SQL axis is there…');
  assert.deepEqual(r.answer.endpoints, [], '…and no code above it');
  assert.equal(r.answer.empty.endpoints, 'none');
  assert.equal(r.answer.walk.cut.byMode, 0);
  assert.equal(r.answer.walk.note, null);
  assert.equal(r.limits.some((l) => /mode=/.test(l.reason)), false, 'nothing was withheld by the mode');
});

test('flow up on the mall pack: EVERY column agrees with endpoint_impact — the two tools walk the same edges', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const c = ctx(g);
  const columns = [...g.nodes.values()].filter((n) => n.kind === 'column').map((n) => n.id.slice('column:'.length));
  assert.ok(columns.length > 600, `expected the mall catalog, got ${columns.length} columns`);
  let compared = 0, withEndpoints = 0, exact = 0, cutShort = 0;
  const mismatches = [];
  for (const column of columns) {
    const up = flow(g, { column, direction: 'up', depth: 8, limit: 200 }, c);
    assertContract(up);
    // the cross-check is only meaningful if nothing was cut away
    assert.equal(up.truncated.fields.find((f) => f.field === 'endpoints').nextOffset, null, `${column}: endpoints lane was truncated`);
    const fromFlow = new Set(up.answer.endpoints.map((e) => e.id));

    const fromImpact = new Set();
    for (let offset = 0; ;) {
      const r = endpoint_impact(g, { column, limit: 100, offset }, c);
      for (const e of r.answer.endpoints) fromImpact.add(e.id);
      const f = r.truncated.fields.find((x) => x.field === 'endpoints');
      if (f && f.nextOffset != null) offset = f.nextOffset; else break;
    }
    compared += 1;
    if (fromFlow.size) withEndpoints += 1;
    const onlyFlow = [...fromFlow].filter((x) => !fromImpact.has(x));
    const onlyImpact = [...fromImpact].filter((x) => !fromFlow.has(x));
    // THE INVARIANT, in two halves.
    //
    // (1) flow never INVENTS: an endpoint flow reports must be one impact
    //     reports, always, whatever the depth. This is the half that would
    //     mean the two tools walk different edges.
    assert.deepEqual(onlyFlow, [], `${column}: flow reported an endpoint endpoint_impact does not have`);
    // (2) flow may report FEWER, and only because of its depth cap: `flow` walks
    //     at most `depth` hops while `endpoint_impact` is unbounded. Since
    //     javafacts/4 some chains run deeper than 8 hops (a service calling its
    //     own helpers adds hops), so this is now a real case — and it must be
    //     accounted for by the walk's OWN cut counter, not waved away.
    if (onlyImpact.length) {
      assert.ok(up.answer.walk.cut.depth > 0,
        `${column}: endpoint_impact found ${onlyImpact.length} endpoint(s) flow missed, but flow says nothing was cut`);
      cutShort += 1;
    } else if (up.answer.walk.cut.depth === 0) {
      exact += 1;
    }
    if (onlyImpact.length) mismatches.push({ column, cut: up.answer.walk.cut.depth, onlyImpact: onlyImpact.length });
  }
  // Measured on this pack: 20 of 669 columns sit behind a chain longer than the
  // depth-8 cap; the other 649 agree exactly.
  assert.equal(mismatches.length, 20, JSON.stringify(mismatches.slice(0, 3)));
  assert.equal(mismatches.every((m) => m.cut > 0), true, 'every shortfall is the depth cap, and the answer says so');
  assert.equal(cutShort, 20);
  assert.ok(exact > 600, `only ${exact} columns agreed with nothing cut`);
  assert.equal(compared, columns.length);
  assert.equal(withEndpoints, 461, 'measured: 461 of the 669 columns reach at least one endpoint');
});

test('flow chain: a route with TWO handlers follows the PRIMARY one, names the others, and does not depend on ingest order', () => {
  // One picture can follow one method — two controllers declaring the same route
  // string are two DEPLOYABLES, and drawing both as one chain would claim a
  // request runs through both. Which one it follows is a property of the GRAPH
  // (the lowest handler id), NOT of the endpoint node's own `handler` attribute:
  // a node merged from two controllers carries whichever was ingested LAST, so a
  // picture that trusted it changed with the parse order and disagreed with the
  // label `map` puts on the same route.
  const facts = (handlerAttr, order) => [
    { fact: 'node', id: nodeId('endpoint', 'GET /a'), httpMethod: 'GET', path: '/a', handler: handlerAttr },
    { fact: 'node', id: nodeId('symbol', 'A#run'), owner: 'A' },
    { fact: 'node', id: nodeId('symbol', 'B#run'), owner: 'B' },
    ...order.map((h) => ({ fact: 'edge', from: nodeId('endpoint', 'GET /a'), to: nodeId('symbol', h), type: 'HANDLES', grade: 'EXACT' })),
  ];
  const ctx = () => ({ graph: null, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });
  const run = (handlerAttr, order) => {
    const g = buildGraph(facts(handlerAttr, order));
    const r = flow(g, { endpoint: 'GET /a' }, ctx());
    assertContract(r);
    return r;
  };
  const r = run('B#run', ['A#run', 'B#run']);
  assert.equal(r.answer.entry.start, nodeId('symbol', 'A#run'), 'the primary handler is the lowest id, not the one the node names');
  assert.equal(r.answer.entry.handler, 'A#run', 'and the card names the method the walk actually started at');
  assert.equal(r.answer.entry.handlerShort, 'A#run');
  assert.equal(r.answer.entry.handlers, 2, 'the card says there are two');
  assert.ok(r.limits.some((l) => /this route is declared by 2 controller methods/.test(l.reason) && /follows A#run/.test(l.reason) && /symbol=B#run/.test(l.reason)),
    'and the picture names the query that draws the other one');
  assert.match(r.answer.walk.note, /declared by 2 controller methods/);
  // Ingest order and the lossy `handler` attribute change NOTHING.
  for (const [attr, order] of [['A#run', ['A#run', 'B#run']], ['B#run', ['B#run', 'A#run']], ['A#run', ['B#run', 'A#run']]]) {
    const other = run(attr, order);
    assert.equal(other.answer.entry.start, nodeId('symbol', 'A#run'), `handler=${attr} order=${order.join(',')}`);
    assert.equal(other.answer.entry.handler, 'A#run');
  }
});

test('flow list mode: the picker names the handler the picture will walk from, and finds a route by EITHER handler', () => {
  const g = buildGraph([
    { fact: 'node', id: nodeId('endpoint', 'GET /a'), httpMethod: 'GET', path: '/a', handler: 'B#run' },
    { fact: 'node', id: nodeId('symbol', 'A#run'), owner: 'A' },
    { fact: 'node', id: nodeId('symbol', 'B#run'), owner: 'B' },
    { fact: 'edge', from: nodeId('endpoint', 'GET /a'), to: nodeId('symbol', 'A#run'), type: 'HANDLES', grade: 'EXACT' },
    { fact: 'edge', from: nodeId('endpoint', 'GET /a'), to: nodeId('symbol', 'B#run'), type: 'HANDLES', grade: 'EXACT' },
  ]);
  const ctx = { graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] };
  const list = flow(g, {}, ctx);
  assertContract(list);
  assert.deepEqual(list.answer.entries.map((e) => [e.id, e.handler, e.handlers]), [['GET /a', 'A#run', 2]],
    'the picker and the picture name the same method');
  // Searching for the SECOND controller still finds the route it declares.
  assert.equal(flow(g, { query: 'B#run' }, ctx).answer.entries.length, 1);
});
