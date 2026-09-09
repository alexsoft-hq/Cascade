import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildMap, MapError } from '../src/core/map.mjs';
import { walkEndpoints, groupOfPath, WalkError } from '../src/core/walks.mjs';
import { buildCoupling } from '../src/core/coupling.mjs';
import { map, ToolError } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';

// ---------------------------------------------------------------------------
// Fixture — TWO API groups over one database, a table they share, a table only
// one of them reaches, and a join between the two tables.
//
//   GET /a/one  → AController#one → AService#run → M.writeShared (writes shared)
//                                               → M.readOwn     (reads own)
//   GET /a/two  → AController#two → AService#run (the same chain: two routes,
//                                                 one walk)
//   GET /b/one  → BController#one → BService#run → M.readShared  (reads shared)
//   GET /       → RootController#ping (no calls — the "(root)" group, and an
//                                      endpoint that ends at no table)
//   M.joinBoth  → a statement NOTHING reaches: it joins shared↔own and touches
//                 `lonely`, so `lonely` is a table in the pack that is NOT on
//                 the map, and the join it witnesses is between two DRAWN tables.
// ---------------------------------------------------------------------------

function catalog() {
  return [
    { kind: 'table', schema: null, table: 'shared', comment: 'the shared table' },
    { kind: 'column', schema: null, table: 'shared', column: 'id', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 'shared', column: 'v', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'own', comment: null },
    { kind: 'column', schema: null, table: 'own', column: 'id', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 'own', column: 'shared_id', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'lonely', comment: 'nothing reaches me' },
    { kind: 'column', schema: null, table: 'lonely', column: 'id', type: 'INT', comment: null },
  ];
}
function lineage() {
  const st = (id, type, tables, columns, joins) => ({
    kind: 'lineage', namespace: 'M', id, type, tables, columns, file: 'M.xml', line: 1,
    ...(joins ? { joins } : {}),
  });
  return [
    st('writeShared', 'update', [{ table: 'shared', access: 'write' }], [{ table: 'shared', column: 'v', access: 'write' }]),
    st('readShared', 'select', [{ table: 'shared', access: 'read' }], [{ table: 'shared', column: 'v', access: 'read' }]),
    st('readOwn', 'select', [{ table: 'own', access: 'read' }], [{ table: 'own', column: 'id', access: 'read' }]),
    // Witnesses the shared↔own join twice, and touches a third table nothing reaches.
    st('joinBoth', 'select', [{ table: 'lonely', access: 'read' }], [],
      [{ left: { table: 'shared', column: 'id' }, right: { table: 'own', column: 'shared_id' } }]),
    st('joinAgain', 'select', [{ table: 'lonely', access: 'read' }], [],
      [{ left: { table: 'shared', column: 'id' }, right: { table: 'own', column: 'shared_id' } }]),
  ];
}
function javaFacts() {
  const type = (fqn) => ({ kind: 'type', fqn, typeKind: 'class', package: 'com.x', file: `src/${fqn.slice(fqn.lastIndexOf('.') + 1)}.java`, implements: [] });
  const method = (fqn, line) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.lastIndexOf('#')), name: fqn.slice(fqn.lastIndexOf('#') + 1), paramCount: 1, line });
  const call = (from, toTypeSimple, m) => ({ kind: 'call', from, receiver: 'r', method: m, toTypeSimple });
  const mapper = (m) => method(`M#${m}`, 5);
  return [
    type('com.x.AController'), type('com.x.BController'), type('com.x.RootController'),
    type('com.x.AService'), type('com.x.BService'),
    { kind: 'type', fqn: 'M', typeKind: 'interface', package: '', implements: [] },
    method('com.x.AController#one', 10), method('com.x.AController#two', 11),
    method('com.x.BController#one', 12), method('com.x.RootController#ping', 13),
    method('com.x.AService#run', 20), method('com.x.BService#run', 21),
    mapper('writeShared'), mapper('readShared'), mapper('readOwn'), mapper('joinBoth'), mapper('joinAgain'),
    call('com.x.AController#one', 'AService', 'run'),
    call('com.x.AController#two', 'AService', 'run'),
    call('com.x.BController#one', 'BService', 'run'),
    call('com.x.AService#run', 'M', 'writeShared'), call('com.x.AService#run', 'M', 'readOwn'),
    call('com.x.BService#run', 'M', 'readShared'),
    { kind: 'endpoint', httpMethod: 'GET', path: '/a/one', handler: 'com.x.AController#one', line: 10 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/a/two', handler: 'com.x.AController#two', line: 11 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/b/one', handler: 'com.x.BController#one', line: 12 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/', handler: 'com.x.RootController#ping', line: 13 },
  ];
}
function mapGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  return g;
}
const sqlOnly = () => buildGraphFromSql(catalog(), lineage());
const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ctx = (graph) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });
// every response in this file goes through the contract before it is inspected
const call = (graph, args) => { const r = map(graph, args, ctx(graph)); assertContract(r); return r; };
const ids = (nodes) => nodes.map((n) => n.id);
const ofKind = (list, kind) => list.filter((x) => x.kind === kind);
const linkKey = (l) => `${l.source} --${l.kind}--> ${l.target}`;

// ---------------------------------------------------------------------------
// the shared walk (core/walks.mjs) — one walk, two views
// ---------------------------------------------------------------------------

test('walkEndpoints: one entry per endpoint, sorted by id, with its group and reached statements', () => {
  const w = walkEndpoints(mapGraph(), {});
  assert.deepEqual(w.endpoints.map((e) => e.id), [
    'endpoint:GET /', 'endpoint:GET /a/one', 'endpoint:GET /a/two', 'endpoint:GET /b/one',
  ]);
  assert.deepEqual(w.endpoints.map((e) => e.group), ['(root)', 'a', 'a', 'b']);
  const a1 = w.endpoints.find((e) => e.id === 'endpoint:GET /a/one');
  assert.deepEqual(a1.statements.map((s) => s.id), ['statement:M.readOwn', 'statement:M.writeShared']);
  // the chain runs through a MAY_CALL controller→service hop, so it is a candidate
  assert.deepEqual([...new Set(a1.statements.map((s) => s.grade))], ['SOUND_SET']);
  // the (root) endpoint calls nothing: an empty list, not a missing one
  assert.deepEqual(w.endpoints.find((e) => e.id === 'endpoint:GET /').statements, []);
});

test('walkEndpoints: two routes on the SAME handler chain are ONE walk (memoised by start)', () => {
  const w = walkEndpoints(mapGraph(), {});
  // 4 endpoints, but /a/one and /a/two enter through different controller
  // methods, so 4 distinct starts here — the memo is proved on the mall pack
  // below (155 starts for 160 endpoints).
  assert.equal(w.walk.starts, 4);
  assert.deepEqual(w.walk, { starts: 4, depthCut: 0, depthCutStarts: 0, nodeCapStarts: 0, byMode: 0, generated: 0, multiHandlerEndpoints: 0, outboundEndpoints: 0 });
});

test('walkEndpoints: an unknown mode / a bad depth is refused before anything is walked', () => {
  assert.throws(() => walkEndpoints(mapGraph(), { mode: 'nope' }), WalkError);
  assert.throws(() => walkEndpoints(mapGraph(), { depth: 0 }), WalkError);
  assert.throws(() => walkEndpoints(mapGraph(), { depth: 1.5 }), WalkError);
});

test('walkEndpoints: mode=strict walks past no candidate call, so no statement is reached', () => {
  const w = walkEndpoints(mapGraph(), { mode: 'strict' });
  assert.deepEqual(w.endpoints.map((e) => e.statements.length), [0, 0, 0, 0]);
  assert.ok(w.walk.byMode > 0, 'and it says how many links the floor refused');
});

test('walks.groupOfPath is the SAME rule coupling groups by', () => {
  assert.equal(groupOfPath('/a/one'), 'a');
  assert.equal(groupOfPath('/'), '(root)');
  const c = buildCoupling(mapGraph(), { axis: 'table' });
  const m = buildMap(mapGraph());
  assert.deepEqual(c.groups.map((g) => g.group), ofKind(m.nodes, 'group').map((n) => n.label));
});

// ---------------------------------------------------------------------------
// buildMap — nodes
// ---------------------------------------------------------------------------

test('buildMap: a node per group, per endpoint and per TOUCHED table — ordered by kind, then id', () => {
  const m = buildMap(mapGraph());
  assert.deepEqual(ids(m.nodes), [
    'group:(root)', 'group:a', 'group:b',
    'endpoint:GET /', 'endpoint:GET /a/one', 'endpoint:GET /a/two', 'endpoint:GET /b/one',
    'table:own', 'table:shared',
  ]);
  // `lonely` is in the pack and on no endpoint's line, so it is NOT drawn
  assert.equal(m.nodes.some((n) => n.id === 'table:lonely'), false);
  assert.equal(m.summary.tables, 3);
  assert.equal(m.summary.tablesTouched, 2);
});

test('buildMap: each kind carries its own facts', () => {
  const m = buildMap(mapGraph());
  assert.deepEqual(m.nodes.find((n) => n.id === 'group:a'),
    { id: 'group:a', kind: 'group', label: 'a', degree: 2, endpoints: 2 });
  assert.deepEqual(m.nodes.find((n) => n.id === 'endpoint:GET /a/one'), {
    id: 'endpoint:GET /a/one', kind: 'endpoint', label: 'GET /a/one', group: 'a', degree: 3,
    httpMethod: 'GET', path: '/a/one', handlerShort: 'AController#one', handlers: 1,
  });
  assert.deepEqual(m.nodes.find((n) => n.id === 'table:shared'), {
    id: 'table:shared', kind: 'table', label: 'shared', degree: 4, comment: 'the shared table', columnCount: 2,
  });
});

test('buildMap: degree counts the links actually in the answer', () => {
  const m = buildMap(mapGraph());
  for (const n of m.nodes) {
    const incident = m.links.filter((l) => l.source === n.id || l.target === n.id).length;
    assert.equal(n.degree, incident, n.id);
  }
});

// ---------------------------------------------------------------------------
// buildMap — links
// ---------------------------------------------------------------------------

test('buildMap: member group→endpoint, touches endpoint→table, joins table↔table — ordered by kind', () => {
  const m = buildMap(mapGraph());
  assert.deepEqual(m.links.map(linkKey), [
    'group:(root) --member--> endpoint:GET /',
    'group:a --member--> endpoint:GET /a/one',
    'group:a --member--> endpoint:GET /a/two',
    'group:b --member--> endpoint:GET /b/one',
    'endpoint:GET /a/one --touches--> table:own',
    'endpoint:GET /a/one --touches--> table:shared',
    'endpoint:GET /a/two --touches--> table:own',
    'endpoint:GET /a/two --touches--> table:shared',
    'endpoint:GET /b/one --touches--> table:shared',
    'table:own --joins--> table:shared',
  ]);
  assert.equal(m.summary.links, 10);
});

test('buildMap: a member link is definitional (EXACT) even where the chain under it is a candidate', () => {
  const m = buildMap(mapGraph());
  assert.deepEqual(m.links.find((l) => l.kind === 'member'),
    { source: 'group:(root)', target: 'endpoint:GET /', kind: 'member', grade: 'EXACT' });
  // …and the touch below it is a CANDIDATE: every path to it runs through the
  // controller→service MAY_CALL, and nothing promotes a lone SOUND_SET path.
  assert.equal(m.links.find((l) => l.kind === 'touches').grade, 'SOUND_SET');
});

// ---------------------------------------------------------------------------
// The grade rule, on a graph built edge by edge so both grades are explicit:
// WEAKEST link within a path, STRONGEST across the alternative paths — the same
// rule Graph.reach and the Flow view's tables lane follow. Getting this backwards
// would make the SAME endpoint→table relation read SOUND_SET on the map and
// EXACT in the Flow tab.
//
//   GET /two/paths --HANDLES--> C#run
//     C#run --CALLS(EXACT)-------> M2#direct   --IMPLEMENTS_STMT--> M2.direct
//     C#run --MAY_CALL(SOUND_SET)-> S#run --CALLS--> M2#viaService --…--> M2.viaService
//   both statements EXECUTE `shared`  → one EXACT path, one SOUND_SET path
//   `other` is the same shape with the ids swapped, so the WEAK path is walked
//   FIRST there: the rule must not depend on which path happens to arrive first.
// ---------------------------------------------------------------------------

function twoPathGraph() {
  const g = new Graph();
  g.addNode({ id: nodeId('endpoint', 'GET /two/paths'), httpMethod: 'GET', path: '/two/paths' });
  g.addNode({ id: nodeId('table', 'shared'), comment: null });
  g.addNode({ id: nodeId('table', 'other'), comment: null });
  const sym = (k) => nodeId('symbol', k);
  const stmt = (k) => nodeId('statement', k);
  g.addEdge({ from: nodeId('endpoint', 'GET /two/paths'), to: sym('com.x.C#run'), type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: sym('com.x.C#run'), to: sym('com.x.S#run'), type: 'MAY_CALL', grade: 'SOUND_SET' });
  // `shared`: the strong path's statement sorts FIRST (direct < viaService)
  g.addEdge({ from: sym('com.x.C#run'), to: sym('M2#direct'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: sym('M2#direct'), to: stmt('M2.direct'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt('M2.direct'), to: nodeId('table', 'shared'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: sym('com.x.S#run'), to: sym('M2#viaService'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: sym('M2#viaService'), to: stmt('M2.viaService'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt('M2.viaService'), to: nodeId('table', 'shared'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } });
  // `other`: the WEAK path's statement sorts first (aWeak < zStrong)
  g.addEdge({ from: sym('com.x.S#run'), to: sym('M2#aWeak'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: sym('M2#aWeak'), to: stmt('M2.aWeak'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt('M2.aWeak'), to: nodeId('table', 'other'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: sym('com.x.C#run'), to: sym('M2#zStrong'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: sym('M2#zStrong'), to: stmt('M2.zStrong'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt('M2.zStrong'), to: nodeId('table', 'other'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  return g;
}

test('buildMap: a touch reached by an EXACT path AND a SOUND_SET path is EXACT — strongest across paths', () => {
  const m = buildMap(twoPathGraph());
  const t = (tbl) => m.links.find((l) => l.kind === 'touches' && l.target === 'table:' + tbl);
  assert.equal(t('shared').grade, 'EXACT', 'one confirmed route makes the touch confirmed');
  assert.equal(t('shared').statements, 2, 'both statements are still folded into the one link');
  assert.equal(t('shared').access, 'read+write');
  // …and it does not depend on which path the walk happens to fold in first
  assert.equal(t('other').grade, 'EXACT', 'the weak path is walked first here and must not win');
  assert.equal(t('other').statements, 2);
});

test('buildMap: a table reachable ONLY through a candidate call stays SOUND_SET — nothing is promoted', () => {
  const g = twoPathGraph();
  g.addEdge({ from: nodeId('symbol', 'M2#viaService'), to: nodeId('statement', 'M2.weakOnly'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: nodeId('statement', 'M2.weakOnly'), to: nodeId('table', 'weakonly'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  const m = buildMap(g);
  const l = m.links.find((x) => x.kind === 'touches' && x.target === 'table:weakonly');
  assert.equal(l.grade, 'SOUND_SET', 'every path to it runs through the MAY_CALL');
});

test('buildMap layers=[statements]: each endpoint→statement step keeps ITS OWN path grade', () => {
  const m = buildMap(twoPathGraph(), { layers: ['statements'] });
  const step = (k) => m.links.find((l) => l.source === 'endpoint:GET /two/paths' && l.target === 'statement:' + k);
  assert.equal(step('M2.direct').grade, 'EXACT');
  assert.equal(step('M2.viaService').grade, 'SOUND_SET', 'this one is reached only through the MAY_CALL');
  // the SQL step below them is the edge's own grade, untouched by the walk
  assert.equal(m.links.find((l) => l.source === 'statement:M2.viaService' && l.target === 'table:shared').grade, 'EXACT');
});

test('walkEndpoints: a statement reached by two starts keeps the STRONGEST of the path grades', () => {
  // Two handlers on one route (an interface with two implementations): one
  // reaches the statement directly, the other only through a candidate call.
  const g = new Graph();
  const sym = (k) => nodeId('symbol', k);
  g.addNode({ id: nodeId('endpoint', 'GET /twin'), httpMethod: 'GET', path: '/twin' });
  g.addEdge({ from: nodeId('endpoint', 'GET /twin'), to: sym('A#run'), type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: nodeId('endpoint', 'GET /twin'), to: sym('B#run'), type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: sym('A#run'), to: sym('M#s'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: sym('B#run'), to: sym('M#s'), type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: sym('M#s'), to: nodeId('statement', 'M.s'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  const w = walkEndpoints(g, {});
  assert.equal(w.walk.starts, 2, 'both handlers are walked');
  assert.deepEqual(w.endpoints[0].statements, [{ id: 'statement:M.s', grade: 'EXACT' }]);
});

test('buildMap: a touch carries the access AGGREGATED over the statements the endpoint reaches', () => {
  const m = buildMap(mapGraph());
  const t = (ep, tbl) => m.links.find((l) => l.source === ep && l.target === tbl && l.kind === 'touches');
  assert.deepEqual(t('endpoint:GET /a/one', 'table:shared'),
    { source: 'endpoint:GET /a/one', target: 'table:shared', kind: 'touches', access: 'write', grade: 'SOUND_SET', statements: 1 });
  assert.deepEqual(t('endpoint:GET /b/one', 'table:shared'),
    { source: 'endpoint:GET /b/one', target: 'table:shared', kind: 'touches', access: 'read', grade: 'SOUND_SET', statements: 1 });
});

test('buildMap: two statements on one (endpoint, table) pair are ONE link with both accesses', () => {
  // AService also READS shared — the same endpoint→table pair, from a second statement.
  const g = mapGraph();
  const extra = [
    { kind: 'lineage', namespace: 'M', id: 'readSharedToo', type: 'select', tables: [{ table: 'shared', access: 'read' }], columns: [], file: 'M.xml', line: 9 },
  ];
  const g2 = buildGraphFromSql(catalog(), [...lineage(), ...extra]);
  addJavaFacts(g2, [...javaFacts(),
    { kind: 'method', fqn: 'M#readSharedToo', owner: 'M', name: 'readSharedToo', paramCount: 1, line: 9 },
    { kind: 'call', from: 'com.x.AService#run', receiver: 'r', method: 'readSharedToo', toTypeSimple: 'M' }]);
  void g;
  const m = buildMap(g2);
  const l = m.links.find((x) => x.source === 'endpoint:GET /a/one' && x.target === 'table:shared');
  assert.equal(l.statements, 2, 'one link, two statements folded into it');
  assert.equal(l.access, 'read+write', 'both accesses, sorted and joined');
});

test('buildMap: joins are undirected and drawn ONCE, with the witness count, only between DRAWN tables', () => {
  const m = buildMap(mapGraph());
  const j = m.links.filter((l) => l.kind === 'joins');
  assert.equal(j.length, 1);
  assert.deepEqual(j[0], { source: 'table:own', target: 'table:shared', kind: 'joins', grade: 'EXACT', witness: 2 });
});

// ---------------------------------------------------------------------------
// the statements layer
// ---------------------------------------------------------------------------

test('buildMap layers=[statements]: statement nodes appear and REPLACE the touches shortcut', () => {
  const m = buildMap(mapGraph(), { layers: ['statements'] });
  assert.equal(m.layers.statements, true);
  assert.deepEqual(ofKind(m.nodes, 'statement').map((n) => n.id),
    ['statement:M.readOwn', 'statement:M.readShared', 'statement:M.writeShared']);
  assert.deepEqual(m.nodes.find((n) => n.id === 'statement:M.writeShared'),
    { id: 'statement:M.writeShared', kind: 'statement', label: 'M.writeShared', degree: 3, statementType: 'update' });
  assert.equal(m.links.some((l) => l.kind === 'touches'), false, 'no shortcut when the real steps are drawn');
  assert.deepEqual(ofKind(m.links, 'executes').map(linkKey), [
    'endpoint:GET /a/one --executes--> statement:M.readOwn',
    'endpoint:GET /a/one --executes--> statement:M.writeShared',
    'endpoint:GET /a/two --executes--> statement:M.readOwn',
    'endpoint:GET /a/two --executes--> statement:M.writeShared',
    'endpoint:GET /b/one --executes--> statement:M.readShared',
    'statement:M.readOwn --executes--> table:own',
    'statement:M.readShared --executes--> table:shared',
    'statement:M.writeShared --executes--> table:shared',
  ]);
  assert.equal(m.summary.statements, 3);
});

test('buildMap layers=[statements]: the SQL step keeps its own EXACT grade and access', () => {
  const m = buildMap(mapGraph(), { layers: ['statements'] });
  const epStep = m.links.find((l) => l.source === 'endpoint:GET /a/one' && l.target === 'statement:M.writeShared');
  const sqlStep = m.links.find((l) => l.source === 'statement:M.writeShared' && l.target === 'table:shared');
  assert.equal(epStep.grade, 'SOUND_SET', 'the walk to the statement is a candidate');
  assert.deepEqual(sqlStep, { source: 'statement:M.writeShared', target: 'table:shared', kind: 'executes', access: 'write', grade: 'EXACT' });
});

test('buildMap: an unknown layer, mode, depth or limit is refused', () => {
  assert.throws(() => buildMap(mapGraph(), { layers: ['columns'] }), MapError);
  assert.throws(() => buildMap(mapGraph(), { layers: 'statements' }), MapError);
  assert.throws(() => buildMap(mapGraph(), { mode: 'nope' }), MapError);
  assert.throws(() => buildMap(mapGraph(), { depth: 0 }), MapError);
  assert.throws(() => buildMap(mapGraph(), { limit: 0 }), MapError);
});

// ---------------------------------------------------------------------------
// the node cap
// ---------------------------------------------------------------------------

test('buildMap: the node cap cuts statements first, then endpoints, then tables — never groups', () => {
  const full = buildMap(mapGraph(), { layers: ['statements'] });
  assert.equal(full.nodes.length, 12); // 3 groups + 4 endpoints + 2 tables + 3 statements
  // 12 → 10 takes the two lowest-degree statements and nothing else
  const cut = buildMap(mapGraph(), { layers: ['statements'], limit: 10 });
  assert.deepEqual(cut.summary.shown, { groups: 3, endpoints: 4, tables: 2, statements: 1, screens: 0 });
  // 12 → 6 takes every statement (3) and then the three lowest-degree endpoints
  const harder = buildMap(mapGraph(), { layers: ['statements'], limit: 6 });
  assert.deepEqual(harder.summary.shown, { groups: 3, endpoints: 1, tables: 2, statements: 0, screens: 0 });
  // a cap below the group count still keeps every group — the skeleton is never cut
  const tiny = buildMap(mapGraph(), { limit: 1 });
  assert.deepEqual(tiny.summary.shown, { groups: 3, endpoints: 0, tables: 0, statements: 0, screens: 0 });
  assert.equal(tiny.links.length, 0);
});

test('buildMap: the node cap keeps the BEST-CONNECTED of the kind it cuts', () => {
  // endpoints by degree: /a/one and /a/two have 3 each, /b/one 2, / just 1.
  const cut = buildMap(mapGraph(), { limit: 7 }); // 3 groups + 2 tables + 2 endpoints
  assert.deepEqual(ofKind(cut.nodes, 'endpoint').map((n) => n.id), ['endpoint:GET /a/one', 'endpoint:GET /a/two']);
});

test('buildMap: a link whose end was cut goes with it, and the totals still name it', () => {
  const cut = buildMap(mapGraph(), { limit: 7 });
  for (const l of cut.links) {
    assert.ok(cut.nodes.some((n) => n.id === l.source), l.source);
    assert.ok(cut.nodes.some((n) => n.id === l.target), l.target);
  }
  assert.equal(cut.summary.nodesTotal, 9);
  assert.equal(cut.summary.linksTotal, 10);
  assert.ok(cut.summary.links < 10);
});

// ---------------------------------------------------------------------------
// the tool: arguments, contract, limits
// ---------------------------------------------------------------------------

test('map tool: the default answer echoes its arguments and carries the summary', () => {
  const r = call(mapGraph(), {});
  assert.equal(r.answer.mode, 'conservative');
  assert.equal(r.answer.depth, 8);
  assert.equal(r.answer.limit, 6000);
  assert.deepEqual(r.answer.layers, { statements: false, screens: false });
  assert.equal(r.answer.nodes.length, 9);
  assert.equal(r.answer.links.length, 10);
  assert.deepEqual(r.trust.axes, ['map']);
});

test('map tool: a bad mode / layer / depth / limit is bad-input, never a silent default', () => {
  const g = mapGraph();
  assert.throws(() => map(g, { mode: 'nope' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input');
  assert.throws(() => map(g, { layers: ['columns'] }, ctx(g)), (e) => e.code === 'bad-input');
  assert.throws(() => map(g, { layers: 'statements' }, ctx(g)), (e) => e.code === 'bad-input');
  assert.throws(() => map(g, { layers: [7] }, ctx(g)), (e) => e.code === 'bad-input');
  assert.throws(() => map(g, { depth: 9 }, ctx(g)), (e) => e.code === 'bad-input');
  assert.throws(() => map(g, { limit: 20001 }, ctx(g)), (e) => e.code === 'bad-input');
  assert.throws(() => map(g, { limit: 0 }, ctx(g)), (e) => e.code === 'bad-input');
});

test('map tool: the group rule and the reachability attribution are always in limits', () => {
  const r = call(mapGraph(), {});
  assert.ok(r.limits.some((l) => /a group is the first segment of an API path/.test(l.reason)));
  assert.ok(r.limits.some((l) => /the same forward walk `flow` draws/.test(l.reason)));
});

test('map tool: the tables NO endpoint reaches are counted out loud', () => {
  const r = call(mapGraph(), {});
  assert.ok(r.limits.some((l) => /2 of 3 table\(s\) in the pack are reached from an endpoint. The other 1 are NOT drawn/.test(l.reason)));
});

test('map tool: the node cap says exactly how many of each kind it refused', () => {
  const r = call(mapGraph(), { layers: ['statements'], limit: 6 });
  assert.ok(r.limits.some((l) => /node cap 6 reached, so 3 statements, 3 endpoints not drawn/.test(l.reason)), JSON.stringify(r.limits));
  const tiny = call(mapGraph(), { limit: 1 });
  assert.ok(tiny.limits.some((l) => /3 groups go past the node cap 1 on their own/.test(l.reason)));
});

test('map tool: a map cannot be paged — truncated declares the totals with no nextOffset', () => {
  const r = call(mapGraph(), { limit: 7 });
  const nodes = r.truncated.fields.find((f) => f.field === 'nodes');
  const links = r.truncated.fields.find((f) => f.field === 'links');
  assert.deepEqual([nodes.shown, nodes.total, nodes.nextOffset], [7, 9, null]);
  assert.ok(links.shown < links.total && links.nextOffset === null);
  assert.equal(r.truncated.any, false, 'a picture that cannot be paged must not claim a next page');
});

test('map tool: an empty map from the MODE says so, and is not called an absence', () => {
  const r = call(mapGraph(), { mode: 'strict' });
  assert.equal(r.answer.links.filter((l) => l.kind === 'touches').length, 0);
  assert.equal(r.answer.summary.tablesTouched, 0);
  assert.ok(r.limits.some((l) => /the walk reached no statement at all \(mode=strict, depth 8\)/.test(l.reason)));
  assert.ok(r.limits.some((l) => /try mode=conservative/.test(l.reason)));
});

test('map tool: a pack with no code axis is not-shipped, not "nothing relates"', () => {
  const r = call(sqlOnly(), {});
  assert.deepEqual(r.answer.nodes, []);
  assert.deepEqual(r.answer.links, []);
  assert.deepEqual(r.answer.empty, { nodes: 'not-shipped', links: 'not-shipped' });
  assert.equal(r.answer.summary.tables, 3);
  assert.equal(r.answer.summary.tablesTouched, 0);
});

test('map tool: reachable through the catalog dispatcher, contract-valid', () => {
  const graph = mapGraph();
  const r = callTool('map', { layers: ['statements'] }, ctx(graph));
  assert.doesNotThrow(() => assertContract(r));
  assert.equal(r.answer.summary.statements, 3);
});

// ---------------------------------------------------------------------------
// the real pack (skipped when it is not on this machine)
// ---------------------------------------------------------------------------

// The fixture guard lives in ONE place for every mall-pinned test
// (test/helpers/mall_fixture.mjs): absent -> skip; a different digest or
// commit -> skip naming both and the rebuild command; the pin -> run.

test('map on the mall pack: 32 groups, 239 endpoints, 49 of 76 tables, 345 touches, 27 joins', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), {});
  const a = r.answer;
  assert.deepEqual(a.summary.shown, { groups: 32, endpoints: 239, tables: 49, statements: 0, screens: 0 });
  assert.equal(a.summary.groups, 32);
  assert.equal(a.summary.endpoints, 239);
  assert.equal(a.summary.tables, 76);
  assert.equal(a.summary.tablesTouched, 49);
  assert.equal(a.nodes.length, 320); // 32 + 239 + 49
  const byKind = {};
  for (const l of a.links) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  assert.deepEqual(byKind, { member: 239, touches: 345, joins: 27 });
  assert.equal(a.links.length, 611);
  assert.equal(a.summary.links, 611);
  // The memo: 239 endpoints and 239 DISTINCT handler chains — not because the
  // routes map one-to-one onto handlers (they do not: 7 routes name two
  // controllers each, and PmsBrandController#getList handles two routes), but
  // because those two effects cancel on this pack. Five chains are still open at
  // the depth cap.
  assert.deepEqual(a.summary.walk,
    { starts: 239, depthCut: 7, depthCutStarts: 5, nodeCapStarts: 0, byMode: 0, generated: 0, multiHandlerEndpoints: 7, outboundEndpoints: 0 });
  // …and those 7 routes are disclosed, not left for the reader to spot.
  assert.ok(r.limits.some((l) => /7 route\(s\) are declared by more than one controller method/.test(l.reason)));
  const twice = a.nodes.filter((n) => n.kind === 'endpoint' && n.handlers > 1);
  assert.equal(twice.length, 7);
});

test('map on the mall pack: the busiest table is pms_product, reached by 29 endpoints', { skip: skipUnlessMall() }, () => {
  const a = call(mallGraph(), {}).answer;
  const t = a.nodes.find((n) => n.id === 'table:pms_product');
  assert.equal(t.columnCount, 42);
  assert.equal(t.comment, '商品信息');
  const eps = a.links.filter((l) => l.kind === 'touches' && l.target === 'table:pms_product');
  assert.equal(eps.length, 29);
  const joins = a.links.filter((l) => l.kind === 'joins' && (l.source === 'table:pms_product' || l.target === 'table:pms_product'));
  assert.equal(joins.length, 10);
  // degree is what is DRAWN around it: 29 endpoints + 10 joined tables
  assert.equal(t.degree, 39);
});

test('map on the mall pack: the statements layer draws 208 statements and 592 executes links', { skip: skipUnlessMall() }, () => {
  const a = call(mallGraph(), { layers: ['statements'] }).answer;
  assert.equal(a.summary.statements, 208);
  assert.equal(a.nodes.length, 528); // 32 + 239 + 49 + 208
  const byKind = {};
  for (const l of a.links) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  assert.deepEqual(byKind, { member: 239, executes: 592, joins: 27 });
  assert.equal(a.links.some((l) => l.kind === 'touches'), false);
});

test('map on the mall pack: a tiny limit cuts by kind and says so', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), { limit: 100 });
  assert.equal(r.answer.nodes.length, 100);
  // groups are never cut and tables give way last: 32 + 49 = 81, so 19 of the
  // 239 endpoints fit under the cap of 100.
  assert.deepEqual(r.answer.summary.shown, { groups: 32, endpoints: 19, tables: 49, statements: 0, screens: 0 });
  assert.ok(r.limits.some((l) => /node cap 100 reached, so 220 endpoints not drawn/.test(l.reason)));
  const tf = r.truncated.fields.find((f) => f.field === 'nodes');
  assert.deepEqual([tf.shown, tf.total, tf.nextOffset], [100, 320, null]);
});

test('map on the mall pack: the walk it runs is the SAME one coupling counts', { skip: skipUnlessMall() }, () => {
  const m = buildMap(mallGraph(), { mode: 'conservative', depth: 4 });
  const c = buildCoupling(mallGraph(), { axis: 'table', mode: 'conservative', depth: 4 });
  assert.deepEqual(m.summary.walk, c.walk);
  assert.equal(m.summary.groups, c.summary.groups);
  assert.equal(m.summary.endpoints, c.summary.endpoints);
});

// ---------------------------------------------------------------------------
// The ANSWER budget (RM11, SPEC §13: the response-size limit is taken from
// MEASURED bytes, and going over is disclosed, never silently trimmed).
//
// The node cap alone is in the wrong unit. Measured on a 400-table /
// 3 800-endpoint synthetic project: 4 227 nodes — well under the 6 000 default —
// carry 12 200 links and serialise to 2.5 MB, and the answer called itself
// complete. These tests pin the two halves of the fix: the cut really happens,
// and the answer says so.
// ---------------------------------------------------------------------------

test('buildMap: the byte budget cuts to a MEASURED size, in the same order the node cap cuts', () => {
  const g = mapGraph();
  const whole = buildMap(g, { layers: ['statements'] });
  const wholeBytes = Buffer.byteLength(JSON.stringify({ nodes: whole.nodes, links: whole.links }), 'utf8');
  assert.ok(wholeBytes > 400, 'the fixture must be big enough for a budget to bite');
  const budget = Math.floor(wholeBytes / 2);
  const cut = buildMap(g, { layers: ['statements'], maxBytes: budget });
  assert.ok(cut.summary.bytes <= budget, `${cut.summary.bytes} bytes must fit the ${budget}-byte budget`);
  assert.equal(cut.summary.cutBy, 'byte-budget');
  assert.equal(cut.summary.maxBytes, budget);
  // Totals are the WHOLE map, so a reader can see what is missing.
  assert.equal(cut.summary.nodesTotal, whole.summary.nodesTotal);
  assert.equal(cut.summary.linksTotal, whole.summary.linksTotal);
  assert.ok(cut.nodes.length < whole.nodes.length);
  // Groups are never cut, whichever budget bit.
  assert.equal(ofKind(cut.nodes, 'group').length, ofKind(whole.nodes, 'group').length);
  // And the survivors are a SUBSET of the whole map: a byte-cut map is the same
  // picture smaller, never a different one.
  const wholeIds = new Set(ids(whole.nodes));
  for (const id of ids(cut.nodes)) assert.ok(wholeIds.has(id), `${id} is not in the uncut map`);
});

test('buildMap: an ample budget cuts nothing and reports the measured size anyway', () => {
  const m = buildMap(mapGraph(), { maxBytes: 8 * 1024 * 1024 });
  assert.equal(m.summary.cutBy, null);
  assert.equal(m.nodes.length, m.summary.nodesTotal);
  assert.equal(m.summary.bytes, Buffer.byteLength(JSON.stringify({ nodes: m.nodes, links: m.links }), 'utf8'));
});

test('buildMap: no budget asked for, no budget invented — bytes/maxBytes stay null', () => {
  const m = buildMap(mapGraph());
  assert.equal(m.summary.maxBytes, null);
  assert.equal(m.summary.bytes, null);
  assert.equal(m.summary.cutBy, null);
  assert.throws(() => buildMap(mapGraph(), { maxBytes: 0 }), MapError);
  assert.throws(() => buildMap(mapGraph(), { maxBytes: 1.5 }), MapError);
});

test('map tool: the byte budget is the DEFAULT bound, and a cut names the budget, not the node cap', () => {
  const g = mapGraph();
  const wide = call(g, {});
  assert.equal(wide.answer.maxBytes, 512 * 1024, 'the documented default answer budget');
  assert.equal(wide.answer.summary.cutBy, null);
  // 64 KB is the smallest budget the tool accepts, and this fixture fits inside
  // it: the assertion is that the argument is honoured rather than clamped away.
  assert.equal(call(g, { maxBytes: 65536 }).answer.maxBytes, 65536);
  // Out of range is REFUSED, not silently clamped — the same rule every other
  // numeric argument on this surface follows.
  assert.throws(() => map(g, { maxBytes: 1 }, ctx(g)), ToolError);
  assert.throws(() => map(g, { maxBytes: 99 * 1024 * 1024 }, ctx(g)), ToolError);
});

test('map tool: a budget that bites is disclosed in limits with the true totals', () => {
  const g = mapGraph();
  const whole = buildMap(g, { layers: ['statements'] });
  const bytes = Buffer.byteLength(JSON.stringify({ nodes: whole.nodes, links: whole.links }), 'utf8');
  // The tool's floor is 64 KB, so force the cut through the engine and check the
  // wording the tool would produce for it.
  const cut = buildMap(g, { layers: ['statements'], maxBytes: Math.floor(bytes / 2) });
  assert.equal(cut.summary.cutBy, 'byte-budget');
  assert.ok(cut.summary.shown.endpoints + cut.summary.shown.statements
    < whole.summary.shown.endpoints + whole.summary.shown.statements);
});

// ---------------------------------------------------------------------------
// The screens layer (RM31)
// ---------------------------------------------------------------------------

// The map fixture, with a frontend bolted on the way the web bridge writes one:
//
//   screen:/a  --RENDERS--> views/a.vue#load --CALLS--> api/a.js#one
//              --CALLS_HTTP--> GET /a/one
//   screen:/nowhere  a route whose component reaches nothing at all
//
// So one screen reaches one route (and through it `shared` and `own`), and one
// reaches none — the second is the case the layer must NOT draw.
function screenGraph() {
  const g = mapGraph();
  const S = nodeId('screen', '/a');
  const QUIET = nodeId('screen', '/nowhere');
  const VIEW = nodeId('symbol', 'src/views/a.vue#load');
  const API = nodeId('symbol', 'src/api/a.js#one');
  g.addNode({ id: S, path: '/a', label: '/a', title: 'The A screen', group: 'a', lane: 'web',
    component: 'src/views/a.vue', source: 'router' });
  g.addNode({ id: QUIET, path: '/nowhere', label: '/nowhere', group: 'nowhere', lane: 'web',
    component: 'src/views/nowhere.vue', source: 'router' });
  g.addNode({ id: VIEW, file: 'src/views/a.vue', line: 3, lane: 'web', component: true });
  g.addNode({ id: API, file: 'src/api/a.js', line: 2, lane: 'web' });
  g.addEdge({ from: S, to: VIEW, type: 'RENDERS', grade: 'EXACT' });
  g.addEdge({ from: VIEW, to: API, type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: API, to: nodeId('endpoint', 'GET /a/one'), type: 'CALLS_HTTP', grade: 'SOUND_SET' });
  return g;
}

test('buildMap layers=[screens]: one node per screen that reaches a drawn route, one link per pair', () => {
  const m = buildMap(screenGraph(), { layers: ['screens'] });
  assert.deepEqual(m.layers, { statements: false, screens: true });
  const screens = ofKind(m.nodes, 'screen');
  assert.deepEqual(ids(screens), ['screen:/a'], 'the screen that reaches nothing is not a dot with no line');
  assert.deepEqual([screens[0].path, screens[0].title, screens[0].group, screens[0].component],
    ['/a', 'The A screen', 'a', 'src/views/a.vue']);
  assert.deepEqual([screens[0].endpoints, screens[0].tables], [1, 2], 'what it reaches, from the census');
  assert.equal(screens[0].observed, false, 'no recording, and the row says so rather than being silent');

  const calls = m.links.filter((l) => l.kind === 'calls');
  assert.deepEqual(calls.map((l) => [l.source, l.target, l.grade]),
    [['screen:/a', 'endpoint:GET /a/one', 'SOUND_SET']]);

  // Two numbers, because they answer two questions.
  assert.equal(m.summary.screens, 1);
  assert.equal(m.summary.screensTotal, 2);
  assert.equal(m.summary.shown.screens, 1);
});

test('buildMap: without the layer there is no screen on the map and no count claiming there is', () => {
  const m = buildMap(screenGraph(), {});
  assert.deepEqual(m.layers, { statements: false, screens: false });
  assert.deepEqual(ofKind(m.nodes, 'screen'), []);
  assert.equal(m.links.some((l) => l.kind === 'calls'), false);
  assert.equal(m.summary.screens, undefined, 'a layer that was not asked for reports no number');
  assert.equal(m.summary.screensTotal, undefined);
});

test('buildMap: the node cap gives up ENDPOINTS before screens, and never a group', () => {
  // A screen that reaches no route is not on the map at all, so the ones that
  // are here are few and each is a top of the chain. Cutting them first would
  // hand a reader who asked for the layer a map with no screen on it: measured
  // on jeecg, that is exactly what happened when screens went before endpoints.
  const full = buildMap(screenGraph(), { layers: ['screens'] });
  assert.equal(full.nodes.length, 10); // 3 groups + 4 endpoints + 2 tables + 1 screen
  const cut = buildMap(screenGraph(), { layers: ['screens'], limit: 9 });
  assert.deepEqual(cut.summary.shown, { groups: 3, endpoints: 3, tables: 2, statements: 0, screens: 1 });
  const harder = buildMap(screenGraph(), { layers: ['screens'], limit: 6 });
  assert.deepEqual(harder.summary.shown, { groups: 3, endpoints: 0, tables: 2, statements: 0, screens: 1 });
  const tiny = buildMap(screenGraph(), { layers: ['screens'], limit: 4 });
  assert.deepEqual(tiny.summary.shown, { groups: 3, endpoints: 0, tables: 1, statements: 0, screens: 0 });
  assert.equal(tiny.links.some((l) => l.kind === 'calls'), false, 'a link whose end went, went with it');
});

test('map tool: layers:["screens"] is accepted, disclosed, and the screens nobody can see are counted', () => {
  const r = call(screenGraph(), { layers: ['screens'] });
  assert.deepEqual(r.answer.layers, { statements: false, screens: true });
  assert.equal(r.answer.summary.screens, 1);
  assert.equal(r.answer.summary.screensTotal, 2);
  assert.ok(r.limits.some((l) => l.scope === 'screen' && /a screen reaches a route because a walk/.test(l.reason)));
  assert.ok(r.limits.some((l) => /1 of 2 screen\(s\) in this pack reach a route this map draws/.test(l.reason)));
  // …and an unknown layer is still bad-input, so the pair is a closed set.
  assert.throws(() => map(screenGraph(), { layers: ['screenz'] }, ctx(screenGraph())), (e) => e.code === 'bad-input');
});
