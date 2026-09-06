import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nodeId } from '../src/core/graph.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import { walkScreens, screensAffectingColumn, screensAffecting, observedCall } from '../src/core/walks.mjs';

// The SCREEN AXIS through the chain walk (RM30 §C): down from a screen to a
// table, up from a column to a screen, and the one thing a recording must never
// do, which is be walked.
//
// One hand-built graph, the shape the bridges really produce:
//
//   screen:/rows --RENDERS--> rows.vue#getList --CALLS--> api.js#listRows
//     --CALLS_HTTP--> GET /rows --HANDLES--> C#list --MAY_CALL--> S#list
//     --MAY_CALL--> M#selectRows --IMPLEMENTS_STMT--> stmt --EXECUTES--> table
//     --READS--> column
//
// Every name in it is invented.

const SCREEN = nodeId('screen', '/rows');
const OTHER = nodeId('screen', '/quiet');
const VIEW = nodeId('symbol', 'src/screens/rows.vue#getList');
const API = nodeId('symbol', 'src/api/rows.js#listRows');
const EP = nodeId('endpoint', 'GET /rows');
const CTRL = nodeId('symbol', 'com.x.C#list');
const SVC = nodeId('symbol', 'com.x.S#list');
const MAPPER = nodeId('symbol', 'com.x.M#selectRows');
const STMT = nodeId('statement', 'com.x.M.selectRows');
const TABLE = nodeId('table', 'rows');
const COL = nodeId('column', 'rows.status');

function pack(opts = {}) {
  const facts = [
    { fact: 'node', id: SCREEN, path: '/rows', label: '/rows', title: 'Rows', group: 'rows', component: 'src/screens/rows.vue', lane: 'web', source: 'router' },
    { fact: 'node', id: OTHER, path: '/quiet', label: '/quiet', group: 'quiet', component: null, lane: 'web', source: 'router' },
    { fact: 'node', id: VIEW, file: 'src/screens/rows.vue', line: 10, lane: 'web', component: true },
    { fact: 'node', id: API, file: 'src/api/rows.js', line: 3, lane: 'web' },
    { fact: 'node', id: EP, path: '/rows', httpMethod: 'GET' },
    { fact: 'node', id: CTRL, owner: 'com.x.C', file: 'C.java', line: 4 },
    { fact: 'node', id: SVC, owner: 'com.x.S', file: 'S.java', line: 9 },
    { fact: 'node', id: MAPPER, owner: 'com.x.M', file: 'M.java', line: 3, mapperMethod: true },
    { fact: 'node', id: STMT, statementType: 'select', file: 'M.xml', line: 2 },
    { fact: 'node', id: TABLE },
    { fact: 'node', id: COL },
    { fact: 'edge', from: SCREEN, to: VIEW, type: 'RENDERS', grade: 'EXACT' },
    { fact: 'edge', from: VIEW, to: API, type: 'CALLS', grade: 'EXACT' },
    { fact: 'edge', from: API, to: EP, type: 'CALLS_HTTP', grade: 'SOUND_SET' },
    { fact: 'edge', from: EP, to: CTRL, type: 'HANDLES', grade: 'EXACT' },
    { fact: 'edge', from: CTRL, to: SVC, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: SVC, to: MAPPER, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: MAPPER, to: STMT, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: STMT, to: TABLE, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } },
    { fact: 'edge', from: STMT, to: COL, type: 'READS', grade: 'EXACT' },
    { fact: 'edge', from: TABLE, to: COL, type: 'DECLARES', grade: 'EXACT' },
  ];
  if (opts.har) {
    facts.push({
      fact: 'edge', from: SCREEN, to: EP, type: 'CALLS_HTTP', grade: 'RUNTIME_ONLY',
      evidence: { rule: 'har', file: 's.har', count: 3, firstSeen: 'a', lastSeen: 'b', methods: ['GET'] },
    });
    facts.push({ fact: 'node', id: SCREEN, observed: true });
  }
  return buildGraph(facts);
}

// ---------------------------------------------------------------------------
// Down, from a screen
// ---------------------------------------------------------------------------

test('down from a screen: the lanes run from its own functions to the table', () => {
  const g = pack();
  const w = chainWalk(g, { start: SCREEN, direction: 'down', mode: 'conservative', maxDepth: 8 });
  assert.deepEqual(w.laneNames, ['webFunctions', 'endpoints', 'services', 'statements', 'tables']);
  assert.deepEqual(w.webFunctions.map((r) => [r.id, r.hops, r.grade, r.component]), [
    ['src/screens/rows.vue#getList', 1, 'EXACT', true],
    ['src/api/rows.js#listRows', 2, 'EXACT', false],
  ]);
  assert.deepEqual(w.endpoints.map((r) => [r.id, r.hops, r.grade]), [['GET /rows', 3, 'SOUND_SET']]);
  assert.deepEqual(w.services.map((r) => r.id), ['com.x.C#list', 'com.x.S#list']);
  assert.deepEqual(w.statements.map((r) => r.id), ['com.x.M.selectRows']);
  assert.deepEqual(w.tables.map((r) => [r.table, r.grade]), [['rows', 'SOUND_SET']]);
  // The weakest link on the path is the CALLS_HTTP edge, so nothing past it is
  // EXACT however definitional its own last edge was.
  assert.equal(w.tables[0].grade, 'SOUND_SET');
  assert.equal(w.other, 0, 'every node the walk reached has a lane of its own');
});

test('down from a screen: the lanes are counted per hop, like every other walk', () => {
  const g = pack();
  const w = chainWalk(g, { start: SCREEN, direction: 'down', mode: 'conservative', maxDepth: 8 });
  assert.deepEqual(w.layers.map((l) => [l.hops, l.webFunctions, l.endpoints, l.services, l.statements, l.tables]), [
    [1, 1, 0, 0, 0, 0],
    [2, 1, 0, 0, 0, 0],
    [3, 0, 1, 0, 0, 0],
    [4, 0, 0, 1, 0, 0],
    [5, 0, 0, 1, 0, 0],
    [6, 0, 0, 0, 0, 0],
    [7, 0, 0, 0, 1, 0],
    [8, 0, 0, 0, 0, 1],
  ]);
});

test('down from a BACKEND entry, the frontend lanes are absent rather than empty', () => {
  const g = pack();
  const w = chainWalk(g, { start: CTRL, direction: 'down', mode: 'conservative' });
  assert.deepEqual(w.laneNames, ['services', 'statements', 'tables']);
  assert.deepEqual(w.webFunctions, []);
  assert.deepEqual(w.screens, []);
});

// ---------------------------------------------------------------------------
// Up, from a column
// ---------------------------------------------------------------------------

test('up from a column: the walk carries on past the route to the screen', () => {
  const g = pack();
  const w = chainWalk(g, { start: COL, direction: 'up', mode: 'conservative', maxDepth: 8 });
  assert.deepEqual(w.laneNames, ['statements', 'services', 'endpoints', 'webFunctions', 'screens']);
  assert.deepEqual(w.endpoints.map((r) => r.id), ['GET /rows']);
  assert.deepEqual(w.webFunctions.map((r) => [r.id, r.grade]), [
    ['src/api/rows.js#listRows', 'SOUND_SET'],
    ['src/screens/rows.vue#getList', 'SOUND_SET'],
  ]);
  assert.deepEqual(w.screens.map((r) => [r.id, r.short, r.title, r.group, r.grade]), [
    ['/rows', '/rows', 'Rows', 'rows', 'SOUND_SET'],
  ]);
  // A frontend function is NOT a service row: what is below it is a route.
  assert.equal(w.services.some((r) => r.id.includes('.vue')), false);
});

test('up from a column on a backend-only pack has no frontend lanes at all', () => {
  const g = buildGraph([
    { fact: 'node', id: CTRL, owner: 'com.x.C' },
    { fact: 'node', id: STMT },
    { fact: 'node', id: COL },
    { fact: 'edge', from: CTRL, to: STMT, type: 'MAY_CALL', grade: 'SOUND_SET' },
    { fact: 'edge', from: STMT, to: COL, type: 'READS', grade: 'EXACT' },
  ]);
  const w = chainWalk(g, { start: COL, direction: 'up', mode: 'conservative' });
  assert.deepEqual(w.laneNames, ['statements', 'services', 'endpoints']);
  assert.deepEqual(w.webFunctions, [], 'the array is still there, it is simply not a lane of this answer');
  assert.deepEqual(w.screens, []);
});

// ---------------------------------------------------------------------------
// A recording is shown, never walked
// ---------------------------------------------------------------------------

test('a HAR edge is never walked, in any mode, in either direction', () => {
  const g = pack({ har: true });
  for (const mode of ['strict', 'conservative', 'heuristic']) {
    const down = chainWalk(g, { start: SCREEN, direction: 'down', mode, maxDepth: 8 });
    // The route is reached through the CODE (RENDERS, CALLS, CALLS_HTTP) at hop
    // 3, never through the recording's own one-hop edge.
    const ep = down.endpoints.find((r) => r.id === 'GET /rows');
    if (mode === 'strict') {
      assert.equal(ep, undefined, 'strict refuses the SOUND_SET call, so the route is out of reach');
    } else {
      assert.equal(ep.hops, 3, `mode=${mode} took the recording as a shortcut`);
    }
    const up = chainWalk(g, { start: COL, direction: 'up', mode, maxDepth: 8 });
    for (const s of up.screens) assert.ok(s.hops >= 4, `mode=${mode} reached a screen in ${s.hops} hops`);
  }
});

test('the screen a recording confirms says `observed`, and the flag is not a grade', () => {
  const g = pack({ har: true });
  const w = chainWalk(g, { start: COL, direction: 'up', mode: 'conservative', maxDepth: 8 });
  const [s] = w.screens;
  assert.equal(s.observed, true);
  assert.equal(s.grade, 'SOUND_SET', 'the grade is still the weakest link on the WALKED path');
  assert.equal(observedCall(g, SCREEN, [EP]), true);
  assert.equal(observedCall(g, OTHER, [EP]), false);
});

// ---------------------------------------------------------------------------
// The censuses
// ---------------------------------------------------------------------------

test('walkScreens reports, per screen, the routes, statements and tables it reaches', () => {
  const g = pack();
  const { screens, walk } = walkScreens(g, { mode: 'conservative', depth: 8 });
  assert.deepEqual(screens.map((s) => [s.id, s.endpoints.length, s.statements.length, s.tables.length]), [
    [OTHER, 0, 0, 0],
    [SCREEN, 1, 1, 1],
  ]);
  const rows = screens.find((s) => s.id === SCREEN);
  assert.deepEqual(rows.endpoints, [{ id: EP, grade: 'SOUND_SET' }]);
  assert.deepEqual(rows.tables, [{ id: TABLE, grade: 'SOUND_SET' }]);
  assert.equal(rows.component, 'src/screens/rows.vue');
  assert.equal(walk.starts, 2);
  assert.equal(walk.depthCut, 0);
});

test('walkScreens at a shallow depth says how much it did not reach, rather than reaching less in silence', () => {
  const g = pack();
  const { screens } = walkScreens(g, { mode: 'conservative', depth: 2 });
  const s = screens.find((x) => x.id === SCREEN);
  assert.deepEqual(s.endpoints, []);
  assert.ok(s.depthCut > 0, 'the cut is disclosed per screen');
});

test('screensAffectingColumn names the screens a column change is felt on, at the weakest grade', () => {
  const g = pack();
  assert.deepEqual(screensAffectingColumn(g, COL, { mode: 'conservative' }), [
    { screen: SCREEN, path: '/rows', label: '/rows', pathGrade: 'SOUND_SET' },
  ]);
  // strict refuses the SOUND_SET hops, so nothing reaches — and that is the
  // MODE, not an absence.
  assert.deepEqual(screensAffectingColumn(g, COL, { mode: 'strict' }), []);
  // The same function answers for any target on the chain.
  assert.deepEqual(screensAffecting(g, TABLE, { mode: 'conservative' }).map((s) => s.screen), [SCREEN]);
  assert.deepEqual(screensAffecting(g, EP, { mode: 'conservative' }).map((s) => s.screen), [SCREEN]);
});

test('a recording alone never makes a screen affected: RUNTIME_ONLY is below every floor', () => {
  // The recording says `/quiet` called the route. The CODE says nothing of the
  // kind, so `/quiet` is not affected by a change to the column.
  const g = pack();
  g.addEdge({
    from: OTHER, to: EP, type: 'CALLS_HTTP', grade: 'RUNTIME_ONLY',
    evidence: { rule: 'har', file: 's.har', count: 1, firstSeen: null, lastSeen: null, methods: ['GET'] },
  });
  assert.deepEqual(screensAffectingColumn(g, COL, { mode: 'heuristic' }).map((s) => s.screen), [SCREEN]);
});
