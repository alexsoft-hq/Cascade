// trace_walks.test.mjs — the engine half of the Trace place (RM67-U2b).
//
// Trace asks one question of one target in either direction. Two things on the
// engine side make that honest, and this file holds both:
//   1. "Where is this API used?" is a real walk: up from a route, through the
//      frontend's calls to the screens that render them, with the same mode
//      floor, depth, weakest-link grading and cut counts as every other walk.
//      `neighborhood(up)` was not that walk (a depth cap of 5, no mode floor).
//   2. Which directions a target has is ONE table (FLOW_DIRECTIONS), and the
//      tool's refusals read it, so the page's direction switch can mirror it.
// Plus the masthead's api-group count, which every page load now has because
// the overview carries it (it used to wait for the map to be drawn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nodeId } from '../src/core/graph.mjs';
import { flow, overview, map, FLOW_DIRECTIONS, ToolError } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { snapshotQuery, SNAPSHOT_TABS } from '../src/viewer/snapshot.mjs';

// The screens test's pack, one route above a table, and a second screen that
// calls the same route through a HEURISTIC call:
//
//   screen:/rows --RENDERS--> rows.vue#getList --CALLS--> api.js#listRows --CALLS_HTTP(SOUND_SET)--> GET /rows
//   screen:/other --RENDERS--> other.vue#load --CALLS_HTTP(HEURISTIC)--> GET /rows
//   GET /rows --HANDLES--> C#list --MAY_CALL--> S#list --MAY_CALL--> M#selectRows --IMPLEMENTS_STMT--> stmt
const SCREEN = nodeId('screen', '/rows');
const OTHER = nodeId('screen', '/other');
const VIEW = nodeId('symbol', 'src/screens/rows.vue#getList');
const OVIEW = nodeId('symbol', 'src/screens/other.vue#load');
const API = nodeId('symbol', 'src/api/rows.js#listRows');
const EP = nodeId('endpoint', 'GET /rows');
const CTRL = nodeId('symbol', 'com.x.C#list');
const SVC = nodeId('symbol', 'com.x.S#list');
const MAPPER = nodeId('symbol', 'com.x.M#selectRows');
const STMT = nodeId('statement', 'com.x.M.selectRows');
const TABLE = nodeId('table', 'rows');
const COL = nodeId('column', 'rows.status');

function pack({ handles = 'EXACT', web = true, screens = true } = {}) {
  const facts = [
    { fact: 'node', id: EP, path: '/rows', httpMethod: 'GET', handler: 'com.x.C#list' },
    { fact: 'node', id: CTRL, owner: 'com.x.C', file: 'C.java', line: 4 },
    { fact: 'node', id: SVC, owner: 'com.x.S', file: 'S.java', line: 9 },
    { fact: 'node', id: MAPPER, owner: 'com.x.M', file: 'M.java', line: 3, mapperMethod: true },
    { fact: 'node', id: STMT, statementType: 'select', file: 'M.xml', line: 2 },
    { fact: 'node', id: TABLE },
    { fact: 'node', id: COL },
    { fact: 'edge', from: EP, to: CTRL, type: 'HANDLES', grade: handles, evidence: handles === 'EXACT' ? {} : { rule: 'nestjs.routes' } },
    { fact: 'edge', from: CTRL, to: SVC, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: SVC, to: MAPPER, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: MAPPER, to: STMT, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: STMT, to: TABLE, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } },
    { fact: 'edge', from: STMT, to: COL, type: 'READS', grade: 'EXACT' },
    { fact: 'edge', from: TABLE, to: COL, type: 'DECLARES', grade: 'EXACT' },
  ];
  if (web) {
    facts.push(
      { fact: 'node', id: VIEW, file: 'src/screens/rows.vue', line: 10, lane: 'web', component: true },
      { fact: 'node', id: OVIEW, file: 'src/screens/other.vue', line: 4, lane: 'web', component: true },
      { fact: 'node', id: API, file: 'src/api/rows.js', line: 3, lane: 'web' },
      { fact: 'edge', from: VIEW, to: API, type: 'CALLS', grade: 'EXACT' },
      { fact: 'edge', from: API, to: EP, type: 'CALLS_HTTP', grade: 'SOUND_SET' },
      { fact: 'edge', from: OVIEW, to: EP, type: 'CALLS_HTTP', grade: 'HEURISTIC' },
    );
    if (screens) {
      facts.push(
        { fact: 'node', id: SCREEN, path: '/rows', label: '/rows', title: 'Rows', group: 'rows', component: 'src/screens/rows.vue', lane: 'web', source: 'router' },
        { fact: 'node', id: OTHER, path: '/other', label: '/other', group: 'other', component: 'src/screens/other.vue', lane: 'web', source: 'router' },
        { fact: 'edge', from: SCREEN, to: VIEW, type: 'RENDERS', grade: 'EXACT' },
        { fact: 'edge', from: OTHER, to: OVIEW, type: 'RENDERS', grade: 'EXACT' },
      );
    }
  }
  return buildGraph(facts);
}

const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ctx = (graph, extra = {}) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [], ...extra });
const up = (graph, args, extra) => { const r = flow(graph, { direction: 'up', ...args }, ctx(graph, extra)); assertContract(r); return r.answer; };
const lanesOf = (a) => ['statements', 'services', 'endpoints', 'webFunctions', 'screens', 'tables'].filter((k) => Array.isArray(a[k]));

// ---------------------------------------------------------------------------
// 1. where is this API used
// ---------------------------------------------------------------------------

test('up from a route: the frontend functions that call it and the screens that render them, no statements lane', () => {
  const a = up(pack(), { endpoint: 'GET /rows' });
  assert.equal(a.entry.kind, 'endpoint');
  assert.equal(a.entry.start, EP, 'the walk starts AT the route, not at its handler');
  assert.deepEqual(lanesOf(a), ['services', 'endpoints', 'webFunctions', 'screens'],
    'what calls a route is code, never SQL, so there is no statements lane');
  assert.deepEqual(a.webFunctions.map((r) => [r.id, r.hops, r.grade, r.link.from]), [
    ['src/api/rows.js#listRows', 1, 'SOUND_SET', EP],
    ['src/screens/rows.vue#getList', 2, 'SOUND_SET', 'symbol:src/api/rows.js#listRows'],
  ]);
  assert.deepEqual(a.screens.map((r) => [r.id, r.hops, r.grade]), [['/rows', 3, 'SOUND_SET']],
    'the weakest link on the path is the CALLS_HTTP candidate set, so the screen is a candidate too');
  assert.deepEqual(a.empty, { services: 'none', endpoints: 'none' }, 'no code in this pack calls the route over HTTP');
});

test('up from a route: the mode floor is the same floor, counted by grade, with the wider mode named', () => {
  const a = up(pack(), { endpoint: 'GET /rows' });
  // /other reaches the route through a HEURISTIC call, which conservative does not walk.
  assert.equal(a.walk.cut.byMode, 1);
  assert.deepEqual(a.walk.cut.byModeGrades, { HEURISTIC: 1 });
  assert.match(a.walk.note, /try mode=heuristic/);
  const wide = up(pack(), { endpoint: 'GET /rows', mode: 'heuristic' });
  // /other is two links up (its component calls the route), /rows three.
  assert.deepEqual(wide.screens.map((r) => [r.id, r.hops, r.grade]), [['/other', 2, 'HEURISTIC'], ['/rows', 3, 'SOUND_SET']],
    'the wider mode walks the guessed call, and its screen is graded by it');
  assert.equal(wide.walk.cut.byMode, 0);
});

test('up from a route: the depth cap is the same cap, and what is past it is counted, not dropped', () => {
  const a = up(pack(), { endpoint: 'GET /rows', depth: 1 });
  assert.deepEqual(a.webFunctions.map((r) => r.id), ['src/api/rows.js#listRows']);
  assert.deepEqual(a.screens, []);
  assert.equal(a.walk.cut.depth, 1, 'the api function sat at the cap with a caller above it');
  assert.match(a.walk.note, /deeper CALLERS were not walked/);
});

test('up from a route whose own address is a guess: every caller is graded by it, and a mode that does not admit it walks none', () => {
  const guessed = up(pack({ handles: 'HEURISTIC' }), { endpoint: 'GET /rows', mode: 'heuristic' });
  assert.ok(guessed.webFunctions.length > 0);
  for (const r of [...guessed.webFunctions, ...guessed.screens]) assert.equal(r.grade, 'HEURISTIC', `${r.id} is matched through a guessed address`);
  assert.match(guessed.walk.note, /own address rests on a link graded HEURISTIC by nestjs\.routes/);
  const stopped = up(pack({ handles: 'HEURISTIC' }), { endpoint: 'GET /rows' });
  assert.deepEqual([stopped.webFunctions, stopped.screens], [[], []]);
  assert.equal(stopped.walk.cut.byMode, 1, 'the route\'s own link is what the floor kept out');
  assert.match(stopped.walk.note, /no caller of it is walked/);
  assert.match(stopped.walk.note, /try mode=heuristic/);
});

test('up from a route on a pack with no frontend: the frontend lanes say not-shipped, and a limit says why', () => {
  const a = up(pack({ web: false }), { endpoint: 'GET /rows' });
  assert.deepEqual(lanesOf(a), ['services', 'endpoints', 'webFunctions', 'screens']);
  assert.equal(a.empty.webFunctions, 'not-shipped');
  assert.equal(a.empty.screens, 'not-shipped');
  assert.match(a.walk.note, /no frontend.*unknown here, not none/);
});

test('a screens lane on a pack that read frontend code but no router is not-shipped, in every walk up', () => {
  const g = pack({ screens: false });
  const route = up(g, { endpoint: 'GET /rows' });
  assert.deepEqual(route.webFunctions.map((r) => r.id), ['src/api/rows.js#listRows', 'src/screens/rows.vue#getList']);
  assert.equal(route.empty.screens, 'not-shipped', '"none" would say no screen calls it, of a pack that never read a screen');
  const column = up(g, { column: 'rows.status' });
  assert.equal(column.empty.screens, 'not-shipped');
});

test('up from a route: a client in THIS pack that calls it over HTTP is a caller too, with its own route above it', () => {
  const g = pack({ web: false });
  const FEIGN = nodeId('symbol', 'com.y.RowsClient#list');
  const OUT = nodeId('symbol', 'com.y.OrderService#place');
  const OCTRL = nodeId('symbol', 'com.y.OrderController#post');
  const OEP = nodeId('endpoint', 'POST /orders');
  for (const f of [
    { fact: 'node', id: FEIGN, owner: 'com.y.RowsClient', file: 'RowsClient.java', line: 2 },
    { fact: 'node', id: OUT, owner: 'com.y.OrderService', file: 'OrderService.java', line: 7 },
    { fact: 'node', id: OCTRL, owner: 'com.y.OrderController', file: 'OrderController.java', line: 5 },
    { fact: 'node', id: OEP, path: '/orders', httpMethod: 'POST' },
  ]) g.addNode(Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'fact')));
  g.addEdge({ from: FEIGN, to: EP, type: 'CALLS_HTTP', grade: 'SOUND_SET' });
  g.addEdge({ from: OUT, to: FEIGN, type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: OCTRL, to: OUT, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: OEP, to: OCTRL, type: 'HANDLES', grade: 'EXACT' });
  const a = up(g, { endpoint: 'GET /rows' });
  assert.deepEqual(a.services.map((r) => r.id).sort(), ['com.y.OrderController#post', 'com.y.OrderService#place', 'com.y.RowsClient#list']);
  assert.deepEqual(a.endpoints.map((r) => [r.id, r.grade]), [['POST /orders', 'SOUND_SET']]);
});

test('up from a route is contract-valid through the catalog, and an unknown route is not-found', () => {
  const g = pack();
  const r = callTool('flow', { direction: 'up', endpoint: 'GET /rows' }, ctx(g));
  assertContract(r);
  assert.throws(() => flow(g, { direction: 'up', endpoint: 'GET /nope' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-endpoint');
});

// ---------------------------------------------------------------------------
// 2. which directions a target has: one table, and the tool reads it
// ---------------------------------------------------------------------------

test('every kind answers the directions FLOW_DIRECTIONS gives it and refuses the others, by name', () => {
  const g = pack();
  const target = { endpoint: 'GET /rows', screen: '/rows', symbol: 'com.x.S#list', statement: 'com.x.M.selectRows', table: 'rows', column: 'rows.status' };
  for (const [kind, value] of Object.entries(target)) {
    for (const dir of ['down', 'up']) {
      const args = { direction: dir, [kind]: value };
      if (FLOW_DIRECTIONS[dir].includes(kind)) {
        const r = flow(g, args, ctx(g));
        assert.equal(r.answer.walk.direction, dir, `${kind} ${dir} is answered`);
      } else {
        assert.throws(() => flow(g, args, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input'
          && (dir === 'up' ? /screen is the top of the chain/ : /direction=up target/).test(e.message), `${kind} ${dir} is refused with its reason`);
      }
    }
  }
  assert.deepEqual([...FLOW_DIRECTIONS.down].sort(), ['endpoint', 'screen', 'symbol']);
  assert.deepEqual([...FLOW_DIRECTIONS.up].sort(), ['column', 'endpoint', 'statement', 'symbol', 'table']);
});

test('a saved file can be of a route walked up, the question built the way the page asks it', () => {
  assert.ok(SNAPSHOT_TABS.impact.kinds.includes('endpoint'));
  const q = snapshotQuery('impact', { kind: 'endpoint', value: 'DELETE /api/v1/user' });
  assert.deepEqual(q.args, { direction: 'up', endpoint: 'DELETE /api/v1/user', mode: 'conservative', depth: 8, limit: 40 });
  assert.throws(() => snapshotQuery('impact', { kind: 'screen', value: '/x' }), /starts from/);
});

// ---------------------------------------------------------------------------
// 3. the api-group count every page load has
// ---------------------------------------------------------------------------

test('the overview counts the api groups the map draws, under either grouping rule', () => {
  const g = pack();
  // Two more routes: one in the `rows` group beside GET /rows, one in a group
  // of its own, so the groups are fewer than the routes.
  for (const [route, handler] of [['GET /rows/{id}', 'com.x.C#one'], ['GET /tags', 'com.y.T#list']]) {
    g.addNode({ id: nodeId('endpoint', route), path: route.slice(4), httpMethod: 'GET', handler });
    g.addNode({ id: nodeId('symbol', handler), owner: handler.split('#')[0], file: 'X.java', line: 1 });
    g.addEdge({ from: nodeId('endpoint', route), to: nodeId('symbol', handler), type: 'HANDLES', grade: 'EXACT' });
  }
  assert.equal(overview(g, {}, ctx(g)).answer.reach.groups, 2, 'rows and tags: two groups over three routes');
  for (const extra of [{}, { profile: { moduleAttribution: { packageDepth: 2 } } }]) {
    const o = overview(g, {}, ctx(g, extra)).answer;
    const m = map(g, {}, ctx(g, extra)).answer;
    assert.equal(typeof o.reach.groups, 'number');
    assert.equal(o.reach.groups, m.summary.groups, `the masthead and the map count the same groups (${JSON.stringify(extra)})`);
  }
});
