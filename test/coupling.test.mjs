import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { nodeId, buildGraph } from '../src/core/graph.mjs';
import { buildCoupling, groupOfPath, CouplingError } from '../src/core/coupling.mjs';
import { coupling, ToolError } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';

// ---------------------------------------------------------------------------
// Fixture — three API groups over ONE database, plus a service all three reach.
//
//   GET /a/one → AController#one → AService#run  → M.writeX (writes t.x)
//                                                → M.delU   (DELETEs u)
//                                                → SharedService#run
//   GET /b/one → BController#one → BService#run  → M.readX  (reads t.x)
//                                                → M.readS  (reads t.s)
//                                                → M.readU  (reads u)
//                                                → SharedService#run
//   GET /c/one → CController#one → CService#run  → M.writeY (writes t.y)
//                                                → M.readY  (reads t.y)
//                                                → SharedService#run
//   GET /      → RootController#ping (no calls — the "(root)" group)
//   SharedService#run → M.shared (writes t.s) — reached by a, b AND c
//
// So: a writes t.x, b reads it (one coupling); c writes and reads t.y and
// nothing else touches it (self-only); t.s is written only through the shared
// statement (coupling that exists BECAUSE of fan-out); u is deleted by a and
// read by b (the table axis, where delete must count as a write).
// ---------------------------------------------------------------------------

function catalog() {
  return [
    { kind: 'table', schema: null, table: 't', comment: 'shared table' },
    { kind: 'column', schema: null, table: 't', column: 'x', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'y', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 's', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'u', comment: null },
    { kind: 'column', schema: null, table: 'u', column: 'k', type: 'INT', comment: null },
  ];
}
function lineage() {
  const st = (id, type, tables, columns) => ({ kind: 'lineage', namespace: 'M', id, type, tables, columns, file: 'M.xml', line: 1 });
  return [
    st('writeX', 'update', [{ table: 't', access: 'write' }], [{ table: 't', column: 'x', access: 'write' }]),
    st('readX', 'select', [{ table: 't', access: 'read' }], [{ table: 't', column: 'x', access: 'read' }]),
    st('writeY', 'update', [{ table: 't', access: 'write' }], [{ table: 't', column: 'y', access: 'write' }]),
    st('readY', 'select', [{ table: 't', access: 'read' }], [{ table: 't', column: 'y', access: 'read' }]),
    st('shared', 'update', [{ table: 't', access: 'write' }], [{ table: 't', column: 's', access: 'write' }]),
    st('readS', 'select', [{ table: 't', access: 'read' }], [{ table: 't', column: 's', access: 'read' }]),
    st('delU', 'delete', [{ table: 'u', access: 'delete' }], [{ table: 'u', column: 'k', access: 'read' }]),
    st('readU', 'select', [{ table: 'u', access: 'read' }], [{ table: 'u', column: 'k', access: 'read' }]),
  ];
}
function javaFacts() {
  const type = (fqn) => ({ kind: 'type', fqn, typeKind: 'class', package: 'com.x', file: `src/${fqn.slice(fqn.lastIndexOf('.') + 1)}.java`, implements: [] });
  const method = (fqn, line) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.lastIndexOf('#')), name: fqn.slice(fqn.lastIndexOf('#') + 1), paramCount: 1, line });
  const call = (from, toTypeSimple, m) => ({ kind: 'call', from, receiver: 'r', method: m, toTypeSimple });
  const mapper = (m) => method(`M#${m}`, 5);
  return [
    type('com.x.AController'), type('com.x.BController'), type('com.x.CController'), type('com.x.RootController'),
    type('com.x.AService'), type('com.x.BService'), type('com.x.CService'), type('com.x.SharedService'),
    { kind: 'type', fqn: 'M', typeKind: 'interface', package: '', implements: [] },
    method('com.x.AController#one', 10), method('com.x.BController#one', 11), method('com.x.CController#one', 12),
    method('com.x.RootController#ping', 13),
    method('com.x.AService#run', 20), method('com.x.BService#run', 21), method('com.x.CService#run', 22),
    method('com.x.SharedService#run', 23),
    mapper('writeX'), mapper('readX'), mapper('writeY'), mapper('readY'), mapper('shared'), mapper('readS'), mapper('delU'), mapper('readU'),
    call('com.x.AController#one', 'AService', 'run'),
    call('com.x.BController#one', 'BService', 'run'),
    call('com.x.CController#one', 'CService', 'run'),
    call('com.x.AService#run', 'M', 'writeX'), call('com.x.AService#run', 'M', 'delU'),
    call('com.x.AService#run', 'SharedService', 'run'),
    call('com.x.BService#run', 'M', 'readX'), call('com.x.BService#run', 'M', 'readS'),
    call('com.x.BService#run', 'M', 'readU'), call('com.x.BService#run', 'SharedService', 'run'),
    call('com.x.CService#run', 'M', 'writeY'), call('com.x.CService#run', 'M', 'readY'),
    call('com.x.CService#run', 'SharedService', 'run'),
    call('com.x.SharedService#run', 'M', 'shared'),
    { kind: 'endpoint', httpMethod: 'GET', path: '/a/one', handler: 'com.x.AController#one', line: 10 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/b/one', handler: 'com.x.BController#one', line: 11 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/c/one', handler: 'com.x.CController#one', line: 12 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/', handler: 'com.x.RootController#ping', line: 13 },
  ];
}
function couplingGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  return g;
}
const sqlOnly = () => buildGraphFromSql(catalog(), lineage());
const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ctx = (graph) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });
// every response in this file goes through the contract before it is inspected
const call = (graph, args) => { const r = coupling(graph, args, ctx(graph)); assertContract(r); return r; };
const pairKeys = (pairs) => pairs.map((p) => `${p.writer}→${p.reader}`);

// ---------------------------------------------------------------------------
// groups — the API path prefix
// ---------------------------------------------------------------------------

test('groupOfPath: the first path segment, "(root)" when there is none', () => {
  assert.equal(groupOfPath('/product/update/{id}'), 'product');
  assert.equal(groupOfPath('/product'), 'product');
  assert.equal(groupOfPath('productCategory/list'), 'productCategory'); // no leading slash
  assert.equal(groupOfPath('/'), '(root)');
  assert.equal(groupOfPath(''), '(root)');
  assert.equal(groupOfPath(null), '(root)');
});

test('buildCoupling: one group per endpoint prefix, with its endpoint count', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  assert.deepEqual(c.groups.map((g) => [g.group, g.endpoints]), [['(root)', 1], ['a', 1], ['b', 1], ['c', 1]]);
  assert.equal(c.summary.groups, 4);
  assert.equal(c.summary.endpoints, 4);
});

// ---------------------------------------------------------------------------
// column axis
// ---------------------------------------------------------------------------

test('coupling column axis: a writes t.x, b reads it → one pair a→b carrying that column', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  const ab = c.pairs.find((p) => p.writer === 'a' && p.reader === 'b');
  assert.ok(ab, 'a→b must be a pair');
  assert.deepEqual(ab.items, ['t.s', 't.x']); // t.s only through the shared statement (below)
  assert.equal(ab.count, 2);
  // b→a is NOT a pair: b writes nothing a reads.
  assert.equal(c.pairs.some((p) => p.writer === 'b' && p.reader === 'a'), false);
});

test('coupling column axis: a column written and read inside ONE group is selfOnly, not a pair', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  // t.y: c writes it, c reads it, nobody else touches it.
  assert.equal(c.pairs.some((p) => p.items.includes('t.y')), false);
  assert.equal(c.summary.selfOnlyItems, 1);
  assert.equal(c.summary.coupledItems, 2); // t.x and t.s
  assert.equal(c.summary.items, 4);        // t.x, t.y, t.s, u.k
});

test('coupling column axis: per-group write/read counts over the reached items', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  const by = Object.fromEntries(c.groups.map((g) => [g.group, [g.writes, g.reads]]));
  assert.deepEqual(by.a, [2, 1]); // writes t.x + t.s (via shared); reads u.k (the DELETE's WHERE)
  assert.deepEqual(by.b, [1, 3]); // writes t.s (via shared); reads t.x, t.s, u.k
  assert.deepEqual(by.c, [2, 1]); // writes t.y + t.s (via shared); reads t.y
  assert.deepEqual(by['(root)'], [0, 0]); // an endpoint that reaches no statement
});

test('coupling: a statement reached by 3+ groups is disclosed, and the pairs it alone carries say viaShared', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  assert.deepEqual(c.sharedStatements, [{ statement: 'M.shared', groups: 3 }]);
  assert.equal(c.summary.sharedStatements, 1);
  // a→b carries t.x (own statements) and t.s (only the shared one) → 1 of 2.
  const ab = c.pairs.find((p) => p.writer === 'a' && p.reader === 'b');
  assert.equal(ab.viaShared, 1);
  // c→b carries ONLY t.s, and c writes it only through the shared statement.
  const cb = c.pairs.find((p) => p.writer === 'c' && p.reader === 'b');
  assert.deepEqual(cb.items, ['t.s']);
  assert.equal(cb.viaShared, 1);
});

test('coupling: pairs are ordered count desc, writer asc, reader asc — and the order is stable', () => {
  const g = couplingGraph();
  const c = buildCoupling(g, { axis: 'column' });
  assert.deepEqual(pairKeys(c.pairs), ['a→b', 'c→b']); // 2 items, then 1
  assert.deepEqual(buildCoupling(g, { axis: 'column' }), buildCoupling(couplingGraph(), { axis: 'column' }));
});

// ---------------------------------------------------------------------------
// table axis
// ---------------------------------------------------------------------------

test('coupling table axis: EXECUTES access decides the side, and DELETE is a write', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'table' });
  const ab = c.pairs.find((p) => p.writer === 'a' && p.reader === 'b');
  // u is only ever DELETEd by a and SELECTed by b — it is a pair only if delete counts as a write.
  assert.deepEqual(ab.items, ['t', 'u']);
  assert.equal(ab.count, 2);
  assert.deepEqual(pairKeys(c.pairs), ['a→b', 'a→c', 'b→c', 'c→b']);
  assert.equal(c.summary.items, 2);        // t and u
  assert.equal(c.summary.coupledItems, 2);
  assert.equal(c.summary.selfOnlyItems, 0);
  assert.equal(c.summary.participatingGroups, 3); // (root) reaches nothing
});

test('coupling table axis: b writes t ONLY through the shared statement → that pair is viaShared', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'table' });
  const bc = c.pairs.find((p) => p.writer === 'b' && p.reader === 'c');
  assert.deepEqual(bc.items, ['t']);
  assert.equal(bc.viaShared, 1);
  // a writes t through its own statement too, so its pair is not fan-out-only.
  assert.equal(c.pairs.find((p) => p.writer === 'a' && p.reader === 'c').viaShared, 0);
});

// ---------------------------------------------------------------------------
// the walk knobs — this is the SAME walk the Flow tab draws
// ---------------------------------------------------------------------------

test('coupling: depth bounds the attribution — at depth 3 the shared statement is out of reach', () => {
  const g = couplingGraph();
  const deep = buildCoupling(g, { axis: 'column', depth: 8 });
  const shallow = buildCoupling(g, { axis: 'column', depth: 3 });
  // handler(0) → service(1) → SharedService#run(2) → M#shared(3) → statement(4)
  assert.equal(deep.summary.sharedStatements, 1);
  assert.equal(shallow.summary.sharedStatements, 0);
  assert.deepEqual(pairKeys(shallow.pairs), ['a→b']);
  assert.deepEqual(shallow.pairs[0].items, ['t.x']);
});

test('coupling: mode=strict walks no candidate call, so nothing is attributed at all', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column', mode: 'strict' });
  assert.equal(c.summary.statements, 0);
  assert.equal(c.pairs.length, 0);
  assert.equal(c.groups.length, 4); // the groups still exist — the WALK found nothing
});

test('buildCoupling: bad axis / mode / depth throw CouplingError', () => {
  const g = couplingGraph();
  assert.throws(() => buildCoupling(g, { axis: 'row' }), (e) => e instanceof CouplingError);
  assert.throws(() => buildCoupling(g, { mode: 'nope' }), (e) => e instanceof CouplingError);
  assert.throws(() => buildCoupling(g, { depth: 0 }), (e) => e instanceof CouplingError);
});

// ---------------------------------------------------------------------------
// the tool — contract, matrix, paging, honesty
// ---------------------------------------------------------------------------

test('coupling tool: default axis is column, and the answer carries the matrix cells without items', () => {
  const r = call(couplingGraph(), {});
  assert.equal(r.answer.axis, 'column');
  assert.equal(r.answer.mode, 'conservative');
  assert.equal(r.answer.depth, 8);
  assert.deepEqual(r.answer.cells, [
    { writer: 'a', reader: 'b', count: 2 },
    { writer: 'c', reader: 'b', count: 1 },
  ]);
  assert.equal(r.answer.cells.every((c) => c.items === undefined), true);
  assert.deepEqual(r.trust.axes, ['coupling']);
  assert.equal(r.truncated.any, false);
});

test('coupling tool: summary counts what the matrix cannot show', () => {
  const r = call(couplingGraph(), { axis: 'table' });
  assert.deepEqual(r.answer.summary, {
    items: 2, coupledItems: 2, selfOnlyItems: 0, writeOnlyItems: 0, readOnlyItems: 0, groups: 4,
    participatingGroups: 3, sharedStatements: 1, statements: 8, endpoints: 4,
  });
});

test('coupling tool: limits name the three things this view cannot prove', () => {
  const r = call(couplingGraph(), {});
  const reasons = r.limits.map((l) => l.reason).join(' | ');
  assert.equal(r.limits.every((l) => l.scope === 'coupling'), true);
  assert.match(reasons, /we attribute a statement to a group by following calls \(conservative, depth 8\)/);
  assert.match(reasons, /1 statement\(s\) are reached by 3 or more groups/);
  assert.match(reasons, /a group is the first segment of an API path/);
  assert.match(reasons, /sharing through the database only/);
});

test('coupling tool: an empty matrix the WALK produced says so, and names the wider mode', () => {
  const g = couplingGraph();
  const strict = call(g, { mode: 'strict' });
  assert.equal(strict.answer.pairs.length, 0);
  assert.equal(strict.answer.empty.pairs, 'none');
  assert.ok(strict.limits.some((l) => /the walk reached no statement at all \(mode=strict, depth 8\)/.test(l.reason)
    && /not because these groups share nothing; try mode=conservative/.test(l.reason)),
  'an empty answer under a narrow mode must not read as "nothing is shared"');
  // …and under heuristic there is no wider mode to suggest.
  const shallow = call(g, { mode: 'heuristic', depth: 1 });
  assert.ok(shallow.limits.some((l) => /mode=heuristic, depth 1/.test(l.reason) && !/try mode=/.test(l.reason)));
  // A walk that DID reach statements carries no such note.
  assert.equal(call(g, {}).limits.some((l) => /reached no statement/.test(l.reason)), false);
});

test('coupling tool: limit pages the pairs and says so; the matrix cells are never cut', () => {
  const g = couplingGraph();
  const page1 = call(g, { limit: 1 });
  assert.deepEqual(pairKeys(page1.answer.pairs), ['a→b']);
  assert.equal(page1.answer.cells.length, 2, 'the matrix still holds every cell');
  const t = page1.truncated.fields.find((f) => f.field === 'pairs');
  assert.equal(t.total, 2);
  assert.equal(t.nextOffset, 1);
  assert.equal(page1.truncated.any, true);
  const page2 = call(g, { limit: 1, offset: 1 });
  assert.deepEqual(pairKeys(page2.answer.pairs), ['c→b']);
  assert.equal(page2.truncated.fields.find((f) => f.field === 'pairs').nextOffset, null);
  // past the end: an empty page is "not in this axis", never an unexplained 0
  const past = call(g, { offset: 9 });
  assert.equal(past.answer.pairs.length, 0);
  assert.equal(past.answer.empty.pairs, 'not-in-this-axis');
});

test('coupling tool: a SQL-only pack has no groups at all — not-shipped, not "nothing shared"', () => {
  const r = call(sqlOnly(), {});
  assert.equal(r.answer.groups.length, 0);
  assert.equal(r.answer.empty.groups, 'not-shipped');
  assert.equal(r.answer.empty.pairs, 'not-shipped');
  assert.equal(r.answer.empty.cells, 'not-shipped');
  assert.equal(r.answer.empty.sharedStatements, 'not-shipped');
});

test('coupling tool: a code axis that shares nothing says "none", and the empty shared list too', () => {
  // Only the /a endpoint: one group can couple with nobody.
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts().filter((f) => f.kind !== 'endpoint' || f.path === '/a/one'));
  const r = call(g, {});
  assert.equal(r.answer.groups.length, 1);
  assert.equal(r.answer.pairs.length, 0);
  assert.equal(r.answer.empty.pairs, 'none');
  assert.equal(r.answer.empty.sharedStatements, 'none');
  assert.equal(r.answer.empty.groups, undefined);
});

test('coupling tool: bad arguments are rejected, not silently defaulted', () => {
  const g = couplingGraph();
  const bad = (args) => assert.throws(() => coupling(g, args, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input', JSON.stringify(args));
  bad({ axis: 'row' });
  bad({ mode: 'nope' });
  bad({ mode: 'constructor' }); // an inherited property is not a mode
  bad({ depth: 0 });
  bad({ depth: 9 });
  bad({ limit: 0 });
  bad({ limit: 501 });
  bad({ offset: -1 });
});

test('coupling tool: called with no arguments at all is the default view, not a crash', () => {
  const g = couplingGraph();
  const r = coupling(g, undefined, ctx(g));
  assertContract(r);
  assert.equal(r.answer.axis, 'column');
});

test('callTool: routes to coupling and returns a contract-valid response', () => {
  const g = couplingGraph();
  const r = callTool('coupling', { axis: 'table' }, { graph: g, basis: basis() });
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.trust.axes, ['coupling']);
  assert.equal(r.answer.pairs.length, 4);
});

// ---------------------------------------------------------------------------
// Synthetic graphs for the WALK knobs — spelled out edge by edge, because what
// is being tested is which edges the walk did and did not follow.
// ---------------------------------------------------------------------------

const symN = (k) => nodeId('symbol', k);
const stmtN = (k) => nodeId('statement', k);
const colN = (k) => nodeId('column', k);
const tblN = (k) => nodeId('table', k);
const epN = (k) => nodeId('endpoint', k);
const N = (id, extra = {}) => ({ fact: 'node', id, ...extra });
const E = (from, to, type, grade = 'EXACT', evidence = undefined) => ({ fact: 'edge', from, to, type, grade, evidence });
/** A route and its HANDLES edges, in the order given (the first is the default). */
const routeFacts = (key, handlers) => [
  N(epN(key), { httpMethod: key.split(' ')[0], path: key.split(' ')[1], handler: handlers[0] }),
  ...handlers.map((h) => E(epN(key), symN(h), 'HANDLES')),
];
/** mapper method → statement → one column, on the given access side. */
const stmtFacts = (mapper, stmt, column, side) => [
  N(symN(mapper), { owner: mapper.split('#')[0] }),
  N(stmtN(stmt), { statementType: side === 'WRITES' ? 'update' : 'select' }),
  N(colN(column)),
  E(symN(mapper), stmtN(stmt), 'IMPLEMENTS_STMT'),
  E(stmtN(stmt), colN(column), side),
];

// a's write sits 5 hops below its handler; b's read sits 2 below its own.
//   A#h → S1#run → S2#run → S3#run → M#w → statement M.w → t.c
function deepChainGraph() {
  return buildGraph([
    ...routeFacts('GET /a/one', ['A#h']),
    ...routeFacts('GET /b/one', ['B#h']),
    N(symN('A#h'), { owner: 'A' }), N(symN('B#h'), { owner: 'B' }),
    N(symN('S1#run')), N(symN('S2#run')), N(symN('S3#run')),
    E(symN('A#h'), symN('S1#run'), 'CALLS'), E(symN('S1#run'), symN('S2#run'), 'CALLS'),
    E(symN('S2#run'), symN('S3#run'), 'CALLS'), E(symN('S3#run'), symN('M#w'), 'CALLS'),
    ...stmtFacts('M#w', 'M.w', 't.c', 'WRITES'),
    E(symN('B#h'), symN('M#r'), 'CALLS'),
    ...stmtFacts('M#r', 'M.r', 't.c', 'READS'),
  ]);
}

test('buildCoupling: the depth cap is CARRIED, not discarded — the pair past it is unknown, not absent', () => {
  const g = deepChainGraph();
  const deep = buildCoupling(g, { axis: 'column', depth: 8 });
  assert.deepEqual(pairKeys(deep.pairs), ['a→b']);
  assert.deepEqual(deep.walk, { starts: 2, depthCut: 0, depthCutStarts: 0, nodeCapStarts: 0, byMode: 0, generated: 0, multiHandlerEndpoints: 0, outboundEndpoints: 0 });
  const shallow = buildCoupling(g, { axis: 'column', depth: 4 });
  assert.equal(shallow.pairs.length, 0, 'a\'s write is 5 hops down: at depth 4 it is not attributed');
  assert.equal(shallow.walk.depthCut, 1, 'and the mapper method still expanding at the cap is counted');
  assert.equal(shallow.walk.depthCutStarts, 1);
});

test('coupling tool: a depth cap that cut a walk is a limit, in the words `flow` uses', () => {
  const g = deepChainGraph();
  const r = call(g, { depth: 4 });
  assert.ok(r.limits.some((l) => /depth cap 4 reached at 1 call\(s\) across 1 endpoint chain\(s\)/.test(l.reason)
    && /deeper statements are not attributed to any group and pairs beyond are unknown, not absent/.test(l.reason)),
  'an empty cell past the cap must not read as "these groups share nothing"');
  // …and a walk that ran to its end claims no cut.
  assert.equal(call(g, { depth: 8 }).limits.some((l) => /depth cap/.test(l.reason)), false);
});

test('buildCoupling: the node cap is carried too — how many handlers hit it', () => {
  const c = buildCoupling(deepChainGraph(), { axis: 'column', maxNodes: 2 });
  assert.equal(c.walk.nodeCapStarts, 2, 'both walks ran out of budget');
  assert.equal(c.pairs.length, 0);
  // the same walk with room reaches the pair
  assert.equal(buildCoupling(deepChainGraph(), { axis: 'column', maxNodes: 4000 }).pairs.length, 1);
});

test('coupling tool: links below the grade floor are named, with the mode that would look wider', () => {
  // controller→service is a candidate call: strict walks neither chain.
  const g = deepChainGraph();
  const heur = call(g, { mode: 'heuristic' });
  assert.equal(heur.limits.some((l) => /below the grade floor/.test(l.reason)), false, 'nothing here is below the heuristic floor');
  const soft = buildGraph([
    ...routeFacts('GET /a/one', ['A#h']),
    ...routeFacts('GET /b/one', ['B#h']),
    N(symN('A#h')), N(symN('B#h')),
    E(symN('A#h'), symN('M#w'), 'MAY_CALL', 'SOUND_SET'),
    ...stmtFacts('M#w', 'M.w', 't.c', 'WRITES'),
    E(symN('B#h'), symN('M#r'), 'CALLS'),
    ...stmtFacts('M#r', 'M.r', 't.c', 'READS'),
  ]);
  const r = call(soft, { mode: 'strict' });
  // the walk reached SOMETHING (b's own chain), so this is the by-mode note, not
  // the "reached no statement at all" special case
  assert.equal(r.answer.walk.byMode, 1);
  assert.ok(r.limits.some((l) => /1 link\(s\) below the grade floor of mode=strict were not walked/.test(l.reason)
    && /Try mode=conservative/.test(l.reason)));
  assert.equal(r.limits.some((l) => /reached no statement at all/.test(l.reason)), false);
});

test('buildCoupling: a route with TWO handlers walks BOTH — the second one\'s writes still count', () => {
  // A1#h reaches nothing; A2#h is where the write is. Taking only the first
  // HANDLES edge would report "a and b share nothing".
  const g = buildGraph([
    ...routeFacts('GET /a/one', ['A1#h', 'A2#h']),
    ...routeFacts('GET /b/one', ['B#h']),
    N(symN('A1#h')), N(symN('A2#h')), N(symN('B#h')),
    E(symN('A2#h'), symN('M#w'), 'CALLS'),
    ...stmtFacts('M#w', 'M.w', 't.c', 'WRITES'),
    E(symN('B#h'), symN('M#r'), 'CALLS'),
    ...stmtFacts('M#r', 'M.r', 't.c', 'READS'),
  ]);
  const c = buildCoupling(g, { axis: 'column' });
  assert.deepEqual(pairKeys(c.pairs), ['a→b']);
  assert.deepEqual(c.pairs[0].items, ['t.c']);
  assert.equal(c.walk.starts, 3, 'three handler methods, three walks');
});

test('buildCoupling: two endpoints in one group are two WALKS — the cache is keyed by start, not by group', () => {
  const g = buildGraph([
    ...routeFacts('GET /a/one', ['A1#h']),
    ...routeFacts('GET /a/two', ['A2#h']),
    ...routeFacts('GET /b/one', ['B#h']),
    N(symN('A1#h')), N(symN('A2#h')), N(symN('B#h')),
    E(symN('A1#h'), symN('M#w1'), 'CALLS'), E(symN('A2#h'), symN('M#w2'), 'CALLS'),
    ...stmtFacts('M#w1', 'M.w1', 't.c1', 'WRITES'),
    ...stmtFacts('M#w2', 'M.w2', 't.c2', 'WRITES'),
    E(symN('B#h'), symN('M#r1'), 'CALLS'), E(symN('B#h'), symN('M#r2'), 'CALLS'),
    ...stmtFacts('M#r1', 'M.r1', 't.c1', 'READS'),
    ...stmtFacts('M#r2', 'M.r2', 't.c2', 'READS'),
  ]);
  const c = buildCoupling(g, { axis: 'column' });
  assert.equal(c.groups.find((x) => x.group === 'a').endpoints, 2);
  assert.deepEqual(pairKeys(c.pairs), ['a→b']);
  assert.deepEqual(c.pairs[0].items, ['t.c1', 't.c2'], 'both endpoints of the group are walked, not just the first');
  assert.equal(c.walk.starts, 3);
});

test('buildCoupling: SHARED_AT is the boundary — 2 groups reaching a statement is not fan-out, 3 is', () => {
  const facts = (groups) => [
    ...groups.flatMap((gname) => [
      ...routeFacts(`GET /${gname}/one`, [`${gname.toUpperCase()}#h`]),
      N(symN(`${gname.toUpperCase()}#h`)),
      E(symN(`${gname.toUpperCase()}#h`), symN('SS#run'), 'CALLS'),
    ]),
    N(symN('SS#run')),
    E(symN('SS#run'), symN('M#w'), 'CALLS'),
    ...stmtFacts('M#w', 'M.w', 't.c', 'WRITES'),
  ];
  const two = buildCoupling(buildGraph(facts(['a', 'b'])), { axis: 'column' });
  assert.equal(two.summary.sharedStatements, 0, 'exactly 2 groups is below SHARED_AT');
  const three = buildCoupling(buildGraph(facts(['a', 'b', 'c'])), { axis: 'column' });
  assert.deepEqual(three.sharedStatements, [{ statement: 'M.w', groups: 3 }]);
});

test('buildCoupling: viaShared counts the READER side too, and names THIS pair\'s statements', () => {
  // d writes t.c through its own statement; a, b and c all reach the SHARED
  // select that reads it — so a's reader evidence is fan-out only, and the
  // writer side is not. The clause under test is the reader one.
  const g = buildGraph([
    ...['a', 'b', 'c'].flatMap((gname) => [
      ...routeFacts(`GET /${gname}/one`, [`${gname.toUpperCase()}#h`]),
      N(symN(`${gname.toUpperCase()}#h`)),
      E(symN(`${gname.toUpperCase()}#h`), symN('SS#run'), 'CALLS'),
    ]),
    N(symN('SS#run')), E(symN('SS#run'), symN('M#rs'), 'CALLS'),
    ...stmtFacts('M#rs', 'M.rs', 't.c', 'READS'),
    ...routeFacts('GET /d/one', ['D#h']), N(symN('D#h')),
    E(symN('D#h'), symN('M#w'), 'CALLS'),
    ...stmtFacts('M#w', 'M.w', 't.c', 'WRITES'),
  ]);
  const c = buildCoupling(g, { axis: 'column' });
  assert.deepEqual(c.sharedStatements, [{ statement: 'M.rs', groups: 3 }]);
  assert.deepEqual(pairKeys(c.pairs), ['d→a', 'd→b', 'd→c']);
  const da = c.pairs.find((p) => p.reader === 'a');
  assert.equal(da.viaShared, 1, 'the READER side is fan-out only — the writer side is d\'s own statement');
  assert.deepEqual(da.sharedVia, ['M.rs'], 'this pair\'s own evidence, not the pack\'s top of the list');
  // and the tool passes it through
  const r = call(g, {});
  assert.deepEqual(r.answer.pairs[0].sharedVia, ['M.rs']);
});

test('buildCoupling: sharedVia lists at most 5 statements, sorted', () => {
  const shared = [];
  for (let i = 0; i < 7; i++) shared.push(...stmtFacts(`M#rs${i}`, `M.rs${i}`, `t.c${i}`, 'READS'));
  const g = buildGraph([
    ...['a', 'b', 'c'].flatMap((gname) => [
      ...routeFacts(`GET /${gname}/one`, [`${gname.toUpperCase()}#h`]),
      N(symN(`${gname.toUpperCase()}#h`)),
      E(symN(`${gname.toUpperCase()}#h`), symN('SS#run'), 'CALLS'),
    ]),
    N(symN('SS#run')),
    ...Array.from({ length: 7 }, (_, i) => E(symN('SS#run'), symN(`M#rs${i}`), 'CALLS')),
    ...shared,
    ...routeFacts('GET /d/one', ['D#h']), N(symN('D#h')),
    ...Array.from({ length: 7 }, (_, i) => E(symN('D#h'), symN(`M#w${i}`), 'CALLS')),
    ...Array.from({ length: 7 }, (_, i) => stmtFacts(`M#w${i}`, `M.w${i}`, `t.c${i}`, 'WRITES')).flat(),
  ]);
  const da = buildCoupling(g, { axis: 'column' }).pairs.find((p) => p.writer === 'd' && p.reader === 'a');
  assert.equal(da.viaShared, 7);
  assert.deepEqual(da.sharedVia, ['M.rs0', 'M.rs1', 'M.rs2', 'M.rs3', 'M.rs4']);
});

test('buildCoupling: every item is accounted for — coupled + selfOnly + writeOnly + readOnly === items', () => {
  const c = buildCoupling(couplingGraph(), { axis: 'column' });
  const s = c.summary;
  assert.equal(s.coupledItems + s.selfOnlyItems + s.writeOnlyItems + s.readOnlyItems, s.items);
  // u.k is read by a (the DELETE's WHERE) and by b, and written by nobody.
  assert.equal(s.readOnlyItems, 1);
  assert.equal(s.writeOnlyItems, 0);
});

test('coupling tool: an EXECUTES edge with no recorded access counts on BOTH sides, and says so', () => {
  const g = buildGraph([
    ...routeFacts('GET /a/one', ['A#h']), ...routeFacts('GET /b/one', ['B#h']),
    N(symN('A#h')), N(symN('B#h')),
    E(symN('A#h'), symN('M#u'), 'CALLS'), E(symN('B#h'), symN('M#r'), 'CALLS'),
    N(symN('M#u')), N(stmtN('M.u'), { statementType: 'update' }), N(tblN('t')),
    E(symN('M#u'), stmtN('M.u'), 'IMPLEMENTS_STMT'),
    E(stmtN('M.u'), tblN('t'), 'EXECUTES', 'EXACT', {}),                       // access never recorded
    N(symN('M#r')), N(stmtN('M.r'), { statementType: 'select' }),
    E(symN('M#r'), stmtN('M.r'), 'IMPLEMENTS_STMT'),
    E(stmtN('M.r'), tblN('t'), 'EXECUTES', 'EXACT', { access: 'read' }),
  ]);
  const c = buildCoupling(g, { axis: 'table' });
  assert.equal(c.unknownAccess, 1);
  assert.deepEqual(pairKeys(c.pairs), ['a→b'], 'unknown access makes a a writer as well as a reader');
  const r = call(g, { axis: 'table' });
  assert.ok(r.limits.some((l) => /1 EXECUTES edge\(s\) carry no read, write or delete access/.test(l.reason)
    && /count each on BOTH sides/.test(l.reason)));
  // the column axis never reads EXECUTES, so it declares no such edge
  assert.equal(buildCoupling(g, { axis: 'column' }).unknownAccess, 0);
});

test('coupling tool: a grouping that degenerates says so — one bucket, or a path variable', () => {
  const many = [];
  for (let i = 0; i < 9; i++) {
    many.push(...routeFacts(`GET /shop/x${i}`, [`H${i}#h`]), N(symN(`H${i}#h`)));
  }
  many.push(...routeFacts('GET /other/one', ['O#h']), N(symN('O#h')));
  const r = call(buildGraph(many), {});
  assert.ok(r.limits.some((l) => /grouping by first path segment breaks down on this pack: 9 of 10 endpoints fall in one group \(shop\)/.test(l.reason)));
  const varGraph = buildGraph([...routeFacts('GET /{id}/one', ['V#h']), N(symN('V#h'))]);
  assert.ok(call(varGraph, {}).limits.some((l) => /a path variable is the first segment \(\{id\}\)/.test(l.reason)));
  // the ordinary fixture claims neither
  assert.equal(call(couplingGraph(), {}).limits.some((l) => /breaks down on this pack/.test(l.reason)), false);
});

// A pack whose pairs and items both overflow the caps: 60 groups each writing
// one column that `z` reads, and `a` writing 25 columns of its own.
function wideGraph() {
  const facts = [...routeFacts('GET /z/read', ['Z#h']), N(symN('Z#h'))];
  const writers = [];
  for (let i = 0; i < 60; i++) writers.push(`g${String(i).padStart(2, '0')}`);
  for (const w of writers) {
    facts.push(...routeFacts(`GET /${w}/write`, [`${w.toUpperCase()}#h`]), N(symN(`${w.toUpperCase()}#h`)));
    const cols = w === 'g00' ? 25 : 1;
    for (let k = 0; k < cols; k++) {
      const col = `t.${w}_${k}`;
      facts.push(E(symN(`${w.toUpperCase()}#h`), symN(`M#w_${w}_${k}`), 'CALLS'));
      facts.push(...stmtFacts(`M#w_${w}_${k}`, `M.w_${w}_${k}`, col, 'WRITES'));
      facts.push(E(symN('Z#h'), symN(`M#r_${w}_${k}`), 'CALLS'));
      facts.push(...stmtFacts(`M#r_${w}_${k}`, `M.r_${w}_${k}`, col, 'READS'));
    }
  }
  return buildGraph(facts);
}

test('coupling tool: 60 pairs — the default limit is 50, the items cap is 20, and the tiebreak is writer asc', () => {
  const g = wideGraph();
  const c = buildCoupling(g, { axis: 'column' });
  assert.equal(c.pairs.length, 60);
  // count desc first (g00 shares 25 columns), then writer asc among the ties
  assert.deepEqual(pairKeys(c.pairs).slice(0, 4), ['g00→z', 'g01→z', 'g02→z', 'g03→z']);
  assert.equal(c.pairs[0].count, 25);
  assert.deepEqual(c.pairs.slice(1).map((p) => p.count), Array(59).fill(1));
  const r = call(g, {});
  assert.equal(r.answer.pairs.length, 50, 'the default page is 50 pairs');
  assert.equal(r.answer.cells.length, 60, 'the matrix is never cut');
  const tf = r.truncated.fields.find((f) => f.field === 'pairs');
  assert.deepEqual([tf.shown, tf.total, tf.nextOffset], [50, 60, 50]);
  assert.equal(r.answer.pairs[0].items.length, 20, 'a pair lists at most 20 items');
  assert.equal(r.answer.pairs[0].count, 25, '…and count stays the true number');
  assert.ok(r.limits.some((l) => /1 pair\(s\) list only the first 20 columns/.test(l.reason)));
});

test('coupling tool: sharedStatements is a capped disclosure, not a page — it never sets truncated.any', () => {
  // 25 statements, each reached by 3 groups: 20 are disclosed, and there is no
  // offset that fetches the other 5.
  const facts = [];
  for (const gname of ['a', 'b', 'c']) {
    facts.push(...routeFacts(`GET /${gname}/one`, [`${gname.toUpperCase()}#h`]), N(symN(`${gname.toUpperCase()}#h`)),
      E(symN(`${gname.toUpperCase()}#h`), symN('SS#run'), 'CALLS'));
  }
  facts.push(N(symN('SS#run')));
  for (let i = 0; i < 25; i++) {
    facts.push(E(symN('SS#run'), symN(`M#s${i}`), 'CALLS'));
    facts.push(...stmtFacts(`M#s${i}`, `M.s${String(i).padStart(2, '0')}`, `t.c${i}`, 'READS'));
  }
  const r = call(buildGraph(facts), {});
  const tf = r.truncated.fields.find((f) => f.field === 'sharedStatements');
  assert.deepEqual([tf.shown, tf.total, tf.nextOffset], [20, 25, null]);
  assert.equal(r.truncated.any, false, 'a disclosure that cannot be paged must not claim there is a next page');
});

// ---------------------------------------------------------------------------
// the real pack (skipped when it is not on this machine)
// ---------------------------------------------------------------------------

// The fixture guard lives in ONE place for every mall-pinned test
// (test/helpers/mall_fixture.mjs): absent -> skip; a different digest or
// commit -> skip naming both and the rebuild command; the pin -> run.

test('coupling on the mall pack, table axis: 32 groups, 61 pairs, product→cart over 4 tables', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), { axis: 'table' });
  assert.equal(r.answer.summary.groups, 32);
  assert.equal(r.answer.summary.endpoints, 239);
  assert.equal(r.answer.cells.length, 61);
  assert.equal(r.answer.pairs.length, 50); // 61 cells, cut to the default limit of 50
  const top = r.answer.pairs[0];
  assert.equal(top.writer, 'product');
  assert.equal(top.reader, 'cart');
  assert.deepEqual(top.items, ['pms_product', 'pms_product_full_reduction', 'pms_product_ladder', 'pms_sku_stock']);
  assert.equal(top.count, 4);
  // sparse by construction: 61 of 32×31 possible cells, and 22 groups in any of them
  assert.equal(r.answer.summary.participatingGroups, 22);
  assert.deepEqual(r.answer.summary, {
    items: 49, coupledItems: 29, selfOnlyItems: 11, writeOnlyItems: 4, readOnlyItems: 5, groups: 32,
    participatingGroups: 22, sharedStatements: 6, statements: 208, endpoints: 239,
  });
  assert.deepEqual(r.answer.sharedStatements, [
    { statement: 'com.macro.mall.mapper.OmsCartItemMapper.selectByExample', groups: 3 },
    { statement: 'com.macro.mall.mapper.PmsBrandMapper.selectByPrimaryKey', groups: 3 },
    { statement: 'com.macro.mall.mapper.PmsProductCategoryMapper.selectByExample', groups: 3 },
    { statement: 'com.macro.mall.mapper.PmsProductMapper.selectByExample', groups: 3 },
    { statement: 'com.macro.mall.mapper.PmsProductMapper.updateByExampleSelective', groups: 3 },
    { statement: 'com.macro.mall.mapper.SmsCouponHistoryMapper.selectByExample', groups: 3 },
  ]);
});

test('coupling on the mall pack, column axis: 61 pairs, and the top pair rests mostly on the shared statement', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), { axis: 'column' });
  assert.equal(r.answer.cells.length, 61);
  assert.deepEqual(r.answer.summary, {
    items: 461, coupledItems: 267, selfOnlyItems: 93, writeOnlyItems: 10, readOnlyItems: 91, groups: 32,
    participatingGroups: 22, sharedStatements: 6, statements: 208, endpoints: 239,
  });
  const top = r.answer.pairs[0];
  assert.equal(`${top.writer}→${top.reader}`, 'productCategory→product');
  assert.equal(top.count, 54);
  assert.equal(top.viaShared, 42); // 42 of the 54 columns are written only via PmsProductMapper.updateByExampleSelective
  assert.equal(top.items.length, 20, 'a pair lists at most 20 items; count stays the total');
  assert.ok(r.limits.some((l) => /list only the first 20 columns/.test(l.reason)));
  assert.deepEqual(r.answer.pairs.slice(0, 5).map((p) => [`${p.writer}→${p.reader}`, p.count]), [
    ['productCategory→product', 54], ['brand→home', 53], ['brand→member', 53], ['brand→product', 53], ['productCategory→home', 53],
  ]);
});

test('coupling on the mall pack: the four item classes add up to `items`', { skip: skipUnlessMall() }, () => {
  for (const axis of ['column', 'table']) {
    const s = call(mallGraph(), { axis }).answer.summary;
    assert.equal(s.coupledItems + s.selfOnlyItems + s.writeOnlyItems + s.readOnlyItems, s.items, axis);
  }
  const col = call(mallGraph(), { axis: 'column' }).answer.summary;
  assert.deepEqual([col.items, col.coupledItems, col.selfOnlyItems, col.writeOnlyItems, col.readOnlyItems],
    [461, 267, 93, 10, 91]);
});

test('coupling on the mall pack: depth 4 cuts the walk and loses pairs; depth 8 runs to the end', { skip: skipUnlessMall() }, () => {
  const shallow = call(mallGraph(), { axis: 'column', depth: 4 });
  assert.equal(shallow.answer.cells.length, 36);
  // RM35 moved this from 70: two more calls exist at depth 4 to cut, both of
  // them a `super.m()` into MyBatis Generator's DefaultCommentGenerator, which
  // the file imports by name and this lane does not parse.
  assert.equal(shallow.answer.walk.depthCut, 72);
  assert.equal(shallow.answer.walk.depthCutStarts, 30);
  assert.ok(shallow.limits.some((l) => /depth cap 4 reached at 72 call\(s\) across 30 endpoint chain\(s\)/.test(l.reason)));
  const deep = call(mallGraph(), { axis: 'column', depth: 8 });
  assert.equal(deep.answer.cells.length, 61, 'twenty-five pairs were past the cap, not absent');
  // Five chains are STILL open at depth 8 — the census says so instead of
  // implying the walk finished.
  assert.deepEqual(deep.answer.walk,
    { starts: 239, depthCut: 7, depthCutStarts: 5, nodeCapStarts: 0, byMode: 0, generated: 0, multiHandlerEndpoints: 7, outboundEndpoints: 0 });
  assert.ok(deep.limits.some((l) => /depth cap 8 reached at 7 call\(s\) across 5 endpoint chain\(s\)/.test(l.reason)));
  // nothing on this pack records an EXECUTES edge without an access
  assert.equal(deep.limits.some((l) => /EXECUTES edge\(s\) carry no read/.test(l.reason)), false);
});

// ---------------------------------------------------------------------------
// The walk refactor's guard rail. `buildCoupling` and `buildMap` share ONE
// per-endpoint walk (core/walks.mjs); this pins coupling's ENTIRE output — every
// axis, every mode, every depth, and the maxNodes path — to the bytes it
// produces over the pinned mall pack.
//
// Unlike every other number in this file, this hash is NOT independently
// derivable: it is a hash OF THE ENGINE'S OWN OUTPUT, and its only job is to
// notice a change. It is re-pinned whenever the mall pack is re-pinned (this
// value was measured on pack 8ac65658c1cc and is UNCHANGED on 9e1874dd5f6c,
// the pack `cascade analyze --root ../target-examples/mall` builds with no lane
// flags). If it changes while the
// pack does not, coupling's answer changed: that may be intended, but it must
// be a deliberate re-pin, never a side effect of touching the walk.
// ---------------------------------------------------------------------------

// RM13 (pack 8ac65658c1cc -> 9e1874dd5f6c): NOT re-pinned, because coupling's
// bytes did not move. The pack moved by seven endpoint NODES gaining honest
// handler/file/line attributes; every edge is byte-identical and coupling reads
// the HANDLES edges, so this hash holding across the re-pin is the evidence
// that no group, pair or cell changed.
//
// RM11 re-pin (pack 8ac65658c1cc was UNCHANGED then). The only difference from the
// previous value 41b87285fe78… is the two fields the walk census gained:
// `walk.multiHandlerEndpoints` and `walk.generated`. Re-derived by deleting
// exactly those two from every result before hashing, which reproduces
// 41b87285fe78… byte for byte — so no group, pair, cell or summary number moved
// when `overview` was put on this shared walk and the generated rule was added.
// previous value 1f26c49be9a6… is the ONE field the walk census gained in RM14:
// `walk.outboundEndpoints` — routes a @FeignClient method calls and this pack
// does not serve. Re-derived by deleting exactly that key from every result
// before hashing, which reproduces 1f26c49be9a6… byte for byte, so no group,
// pair, cell or summary number moved (mall declares no HTTP client, and the
// field is 0 on every one of the 27 runs above).
//
// RM35 re-pin (pack 99141d55e969 -> 9f01dfcbb8ed), from 189ab12ddbac…. The pack
// gained 85 EXTERNAL symbols and 319 MAY_CALL edges into them: a nested class
// now reads its file's imports, `java.lang` is implicit, Lombok's `log` is a
// field, and a `super.m()` into a base the imports name is an edge. An external
// symbol has no outgoing edge, so no walk gets past one and no column or table
// is reached that was not reached before — the ONE number that moved in all 27
// runs is `walk.depthCut` at depth 4, 70 -> 72, which counts calls the cap cut
// rather than anything the answer contains. Every group, pair, cell and summary
// figure this file pins is asserted separately above and none of them moved.
const COUPLING_BYTES_SHA256 = '33d0f543f28c12ebd9993c2fb1e6b1e24d62bd184f3b8cef3c574ff8268d278c';

test('buildCoupling on the mall pack is byte-identical to the pre-walk-refactor engine', { skip: skipUnlessMall() }, () => {
  const out = [];
  for (const axis of ['column', 'table']) {
    for (const mode of ['strict', 'conservative', 'heuristic']) {
      for (const depth of [1, 2, 3, 4, 5, 6, 7, 8]) {
        out.push({ axis, mode, depth, r: buildCoupling(mallGraph(), { axis, mode, depth }) });
      }
    }
  }
  for (const maxNodes of [5, 50, 4000]) {
    out.push({ axis: 'column', mode: 'conservative', depth: 8, maxNodes, r: buildCoupling(mallGraph(), { axis: 'column', mode: 'conservative', depth: 8, maxNodes }) });
  }
  const bytes = JSON.stringify(out, null, 1);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), COUPLING_BYTES_SHA256,
    'coupling\'s output changed — re-pin deliberately, or the shared walk broke it');
});
