// browse_modes.test.mjs — browse counts in the mode it is asked in (RM67-U2i).
//
// `browse` counted every row in one fixed mode, conservative. So a page that
// asked its other answers in heuristic put two walks' numbers side by side:
// Start's screens ranking could not follow the map's mode control, and Trace's
// list counted in conservative beside an answer walked in heuristic. It now
// takes `mode`, walks its census in that mode, keeps one census per mode, and
// says the mode on every answer. Asked with no mode it is the answer it was.
//
// THE FIXTURE, one link of each grade where it changes a count:
//   GET /a --HANDLES EXACT-->     A#a --CALLS EXACT-->         M#find  -> find  (reads t, t.c)
//   GET /b --HANDLES EXACT-->     B#b --MAY_CALL SOUND_SET-->  M#save  -> save  (writes t, t.c)
//                                 B#b --CALLS HEURISTIC-->     G#guess -> guess (reads u, u.x; a guessed table)
//   GET /h --HANDLES HEURISTIC--> H#h --CALLS EXACT-->         M#find
//   screen /s1 renders f1, which calls GET /b (SOUND_SET)
//   screen /s2 renders f2, which calls GET /a (HEURISTIC)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph, sqlEdgesOf } from '../src/core/graph.mjs';
import { walkEndpoints, walkScreens } from '../src/core/walks.mjs';
import { walkAgreement } from '../src/core/walk_agreement.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';
import { browseCensusDiff } from './helpers/browse_census.mjs';

const RECORDED = fileURLToPath(new URL('./fixtures/golden-browse/no-mode.json', import.meta.url));
const RECORD = process.env.CASCADE_RECORD_GOLDEN === '1';
const MODES = ['strict', 'conservative', 'heuristic'];
const KINDS = ['table', 'column', 'statement', 'endpoint', 'screen'];

function gradesGraph() {
  const g = new Graph();
  const sym = (id, extra = {}) => g.addNode({ id: `symbol:${id}`, file: `${id.split('#')[0]}.java`, line: 1, owner: id.split('#')[0], ...extra });
  const link = (from, to, type, grade, evidence = null) => g.addEdge({ from, to, type, grade, evidence });
  for (const s of ['p.A#a', 'p.B#b', 'p.H#h', 'p.M#find', 'p.M#save', 'p.G#guess']) sym(s);
  for (const [verb, p, handler, grade] of [['GET', '/a', 'p.A#a', 'EXACT'], ['GET', '/b', 'p.B#b', 'EXACT'], ['GET', '/h', 'p.H#h', 'HEURISTIC']]) {
    g.addNode({ id: `endpoint:${verb} ${p}`, path: p, httpMethod: verb, handler });
    link(`endpoint:${verb} ${p}`, `symbol:${handler}`, 'HANDLES', grade);
  }
  link('symbol:p.A#a', 'symbol:p.M#find', 'CALLS', 'EXACT');
  link('symbol:p.B#b', 'symbol:p.M#save', 'MAY_CALL', 'SOUND_SET');
  link('symbol:p.B#b', 'symbol:p.G#guess', 'CALLS', 'HEURISTIC');
  link('symbol:p.H#h', 'symbol:p.M#find', 'CALLS', 'EXACT');
  for (const tb of ['t', 'u']) g.addNode({ id: `table:${tb}` });
  for (const c of ['t.c', 'u.x']) {
    g.addNode({ id: `column:${c}` });
    link(`table:${c.split('.')[0]}`, `column:${c}`, 'DECLARES', 'EXACT');
  }
  for (const [name, method, tb, col, access, grade] of [
    ['find', 'p.M#find', 't', 't.c', 'read', 'EXACT'],
    ['save', 'p.M#save', 't', 't.c', 'write', 'EXACT'],
    ['guess', 'p.G#guess', 'u', 'u.x', 'read', 'HEURISTIC'],
  ]) {
    const st = `statement:p.M.${name}`;
    g.addNode({ id: st, statementType: access === 'read' ? 'select' : 'update', file: 'M.xml', line: 3 });
    link(`symbol:${method}`, st, 'IMPLEMENTS_STMT', 'EXACT', { line: 3 });
    link(st, `table:${tb}`, 'EXECUTES', grade, { access });
    link(st, `column:${col}`, access === 'read' ? 'READS' : 'WRITES', grade);
  }
  for (const [screen, fn, route, grade] of [['/s1', 'f1', 'GET /b', 'SOUND_SET'], ['/s2', 'f2', 'GET /a', 'HEURISTIC']]) {
    g.addNode({ id: `screen:${screen}`, path: screen, label: screen, group: 's', component: `web/${fn}.vue`, source: 'router', lane: 'web' });
    g.addNode({ id: `symbol:web/${fn}.vue#setup`, file: `web/${fn}.vue`, line: 1, lane: 'web' });
    link(`screen:${screen}`, `symbol:web/${fn}.vue#setup`, 'RENDERS', 'EXACT');
    link(`symbol:web/${fn}.vue#setup`, `endpoint:${route}`, 'CALLS_HTTP', grade);
  }
  return g;
}

const ctxOf = (g) => ({ graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack: { digest: 'd' } });
const ask = (g, args) => { const r = callTool('browse', args, ctxOf(g)); assertContract(r); return r; };
const row = (r, key) => r.answer.items.find((x) => x[r.answer.kind] === key);

// ---------------------------------------------------------------------------
// asked with no mode, the answer it always was
// ---------------------------------------------------------------------------

test('browse with no mode is the answer recorded before it took one, and the same as mode=conservative', () => {
  const now = Object.fromEntries(KINDS.map((kind) => [kind, ask(gradesGraph(), { kind })]));
  if (RECORD) {
    fs.mkdirSync(path.dirname(RECORDED), { recursive: true });
    fs.writeFileSync(RECORDED, `${JSON.stringify(now, null, 1)}\n`);
    return;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(now)), JSON.parse(fs.readFileSync(RECORDED, 'utf8')));
  for (const kind of KINDS) assert.deepEqual(ask(gradesGraph(), { kind, mode: 'conservative' }), now[kind], kind);
});

// ---------------------------------------------------------------------------
// each mode, its own census
// ---------------------------------------------------------------------------

test('browse counts every row in the mode it is asked in, where the grades make the counts differ', () => {
  const by = (mode, kind, key) => row(ask(gradesGraph(), { kind, mode }), key);
  const t = MODES.map((mode) => by(mode, 'table', 't'));
  assert.deepEqual(t.map((x) => [x.endpoints, x.screens]), [[1, 0], [2, 1], [3, 2]], 'GET /b over SOUND_SET, GET /h and /s2 over HEURISTIC');
  const u = MODES.map((mode) => by(mode, 'table', 'u'));
  assert.deepEqual(u.map((x) => [x.statementsRead, x.endpoints, x.screens]), [[0, 0, 0], [0, 0, 0], [1, 1, 1]], 'the guessed table is reached in heuristic only');
  assert.deepEqual(MODES.map((mode) => by(mode, 'column', 'u.x').reads), [0, 0, 1]);
  assert.deepEqual(MODES.map((mode) => by(mode, 'statement', 'p.M.guess')).map((x) => [x.tables, x.endpoints]), [[0, 0], [0, 0], [1, 1]]);
  assert.deepEqual(MODES.map((mode) => by(mode, 'endpoint', 'GET /b')).map((x) => [x.statements, x.tables]), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(MODES.map((mode) => by(mode, 'screen', '/s2')).map((x) => [x.endpoints, x.tables]), [[0, 0], [0, 0], [1, 1]]);
});

test('in each mode a row is the census walkEndpoints and walkScreens give in that mode', () => {
  for (const mode of MODES) {
    const g = gradesGraph();
    const want = { endpoints: new Map(), screens: new Map() };
    const reach = (into, rows) => {
      for (const r of rows) {
        for (const s of r.statements) {
          for (const e of sqlEdgesOf(g, s.id, mode)) { if (!into.has(e.to)) into.set(e.to, new Set()); into.get(e.to).add(r.id); }
        }
      }
    };
    reach(want.endpoints, walkEndpoints(g, { mode }).endpoints);
    reach(want.screens, walkScreens(g, { mode }).screens);
    const n = (m, id) => (m.get(id) ?? new Set()).size;
    for (const r of ask(g, { kind: 'table', mode }).answer.items) {
      assert.deepEqual([r.endpoints, r.screens], [n(want.endpoints, `table:${r.table}`), n(want.screens, `table:${r.table}`)], `${mode} ${r.table}`);
    }
    for (const r of ask(g, { kind: 'column', mode }).answer.items) {
      assert.deepEqual([r.endpoints, r.screens], [n(want.endpoints, `column:${r.column}`), n(want.screens, `column:${r.column}`)], `${mode} ${r.column}`);
    }
  }
});

test('in each mode browse counts the census walk_agreement holds the impact tools to, and the impact tools agree with it', () => {
  for (const mode of MODES) {
    const g = gradesGraph();
    const d = browseCensusDiff(g, mode);
    assert.equal(d.rows, 4, 'two tables and two columns');
    assert.deepEqual(d.differences, [], mode);
    assert.equal(walkAgreement(g, { mode }).disagreements, 0, mode);
  }
});

test('every answer says the mode its counts were walked in, as data and in its limits', () => {
  for (const mode of MODES) {
    const r = ask(gradesGraph(), { kind: 'table', mode });
    assert.deepEqual(r.answer.census, { mode, depth: null });
    assert.ok(r.limits.some((l) => l.scope === 'browse' && l.reason.includes(`(mode=${mode}, no depth cap)`)), `${mode}: ${JSON.stringify(r.limits)}`);
    assert.ok(r.limits.some((l) => l.scope === 'screen' && l.reason.includes(`a walk (mode=${mode}, no depth cap)`)), `${mode}: the screens beside it too`);
  }
  assert.throws(() => callTool('browse', { kind: 'table', mode: 'loose' }, ctxOf(gradesGraph())),
    (e) => e.code === 'bad-input' && /mode must be one of strict, conservative, heuristic/.test(e.message));
});

test('the census is kept per mode: one mode\'s census is never handed to another, in either order', () => {
  const fresh = Object.fromEntries(MODES.map((mode) => [mode, Object.fromEntries(KINDS.map((kind) => [kind, ask(gradesGraph(), { kind, mode })]))]));
  for (const [a, b] of [['strict', 'conservative'], ['conservative', 'heuristic']]) {
    assert.notDeepEqual(fresh[a].table.answer.items, fresh[b].table.answer.items, `${a} and ${b} count this graph differently`);
  }
  for (const order of [MODES, [...MODES].reverse(), ['conservative', 'heuristic', 'conservative', 'strict', 'heuristic']]) {
    const g = gradesGraph();
    for (const mode of order) {
      for (const kind of KINDS) assert.deepEqual(ask(g, { kind, mode }), fresh[mode][kind], `${order.join('>')}: ${mode} ${kind}`);
    }
  }
});

test('mall: a first browse in each mode answers inside 2 s, and every later one in any mode inside 50 ms', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const ms = (args) => { const t0 = process.hrtime.bigint(); ask(g, args); return Number(process.hrtime.bigint() - t0) / 1e6; };
  for (const mode of MODES) {
    const first = ms({ kind: 'table', mode });
    assert.ok(first < 2000, `the first ${mode} browse took ${first.toFixed(1)} ms`);
  }
  for (const mode of [...MODES, ...MODES]) {
    for (const kind of ['table', 'endpoint', 'column']) {
      const later = ms({ kind, mode });
      assert.ok(later < 50, `a later ${mode} ${kind} browse took ${later.toFixed(1)} ms`);
    }
  }
});
