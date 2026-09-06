import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph, GRADE_SETS } from '../src/core/graph.mjs';
import {
  readHar, addHarFacts, prefixRules, requestPathOf, pageRoutePathOf, isAssetPath, screenPathMatches,
} from '../src/adapters/har_bridge.mjs';
import { chainWalk } from '../src/core/chain.mjs';

// The HAR bridge (RM30 §E), driven by ONE recording fixture with everything in
// it that a real capture has: two pages, a bundle, a request nothing serves,
// and a dev-server prefix on every API call that the routes do not carry.
//
// The fixture invents its own origin and its own paths. What is under test is
// the DECISION each rule makes, not a count over somebody's project.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAR = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'har', 'session.har'), 'utf8');

const EP = 'endpoint:GET /orders/{id}';
const SCREEN = 'screen:/things/list';

/** A pack that serves one route and declares one screen, the way a real one does. */
function packGraph() {
  const g = new Graph();
  g.addNode({ id: EP, path: '/orders/{id}', httpMethod: 'GET' });
  g.addNode({ id: 'symbol:com.x.C#find', file: 'C.java', line: 1 });
  g.addEdge({ from: EP, to: 'symbol:com.x.C#find', type: 'HANDLES', grade: 'EXACT' });
  g.addNode({
    id: SCREEN, path: '/things/list', label: '/things/list', title: null, name: 'ThingList',
    group: 'things', component: 'src/views/things/list.vue', lane: 'web', source: 'router',
  });
  return g;
}

/** The prefix census the web bridge hands over: `/api` on the front, nothing on the back. */
const PREFIX = { '': { instances: [{ id: 'src/http.js#client', value: '', from: 'derived', front: '/api', candidates: [] }] } };

const harEdges = (g) => g.edges.filter((e) => e.grade === 'RUNTIME_ONLY');

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('a request URL is read down to its path, and a page URL down to its ROUTE', () => {
  assert.equal(requestPathOf('https://app.example.com/api/orders/1?withLines=true'), '/api/orders/1');
  assert.equal(requestPathOf('/api/orders/1#frag'), '/api/orders/1');
  // Hash routing: the fragment IS the screen path, and the path is `/`.
  assert.equal(pageRoutePathOf('https://app.example.com/#/things/list'), '/things/list');
  // History routing: the path is the screen path.
  assert.equal(pageRoutePathOf('https://app.example.com/things/list'), '/things/list');
});

test('the asset list is by extension, and it is the extension of the LAST segment', () => {
  for (const p of ['/a/app.4f21.js', '/a.css', '/x/y.png', '/f.woff2', '/b.js.map', '/favicon.ico', '/i.svg']) {
    assert.equal(isAssetPath(p), true, p);
  }
  assert.equal(isAssetPath('/api/orders/1'), false);
  // A directory that merely LOOKS like one is not an asset.
  assert.equal(isAssetPath('/css/list'), false);
});

test('a screen path template matches the page the browser was on', () => {
  assert.equal(screenPathMatches('/goods/edit/:id', '/goods/edit/42'), true);
  assert.equal(screenPathMatches('/goods/edit/:id', '/goods/edit'), false);
  assert.equal(screenPathMatches('/goods/edit/:id', '/goods/edit/42/more'), false);
  assert.equal(screenPathMatches('/redirect/*', '/redirect/a/b'), true);
  assert.equal(screenPathMatches('/things/list', '/things/list'), true);
  assert.equal(screenPathMatches('/things/list', '/things/detail'), false);
});

test('a file that is not a HAR is REFUSED by name, and contributes nothing', () => {
  const bad = readHar('{"nope": 1}', { file: 'x.har' });
  assert.match(bad.unreadable, /no log\.entries/);
  const notJson = readHar('<html>', { file: 'y.har' });
  assert.match(notJson.unreadable, /not JSON/);

  const g = packGraph();
  const stats = addHarFacts(g, [bad, notJson], { prefix: PREFIX });
  assert.deepEqual(harEdges(g), []);
  assert.deepEqual(stats.unreadable.map((u) => u.file), ['x.har', 'y.har']);
  assert.equal(stats.entries, 0);
});

test('the page URL is the first HTML response of that page, and its title rides along', () => {
  const rec = readHar(HAR, { file: 'session.har' });
  assert.equal(rec.unreadable, null);
  assert.deepEqual(rec.pages.map((p) => [p.id, p.title, p.path]), [
    ['page_1', 'Things', '/things/list'],
    ['page_2', 'Somewhere the router never declared', '/nowhere/at/all'],
  ]);
  assert.equal(rec.entries.length, 8);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('prefixRules puts declared first, then derived, then auto, longest front prefix first', () => {
  const rules = prefixRules({
    a: { instances: [{ id: 'a', value: '/back', from: 'auto', front: '/g' }] },
    b: { instances: [{ id: 'b', value: '', from: 'declared', front: '/api' }] },
    c: { instances: [{ id: 'c', value: '', from: 'derived', front: '/api/v2' }] },
  });
  assert.deepEqual(rules.map((r) => [r.from, r.front]), [
    ['declared', '/api'], ['derived', '/api/v2'], ['auto', '/g'], ['none', ''],
  ]);
});

test('a recorded call reaches the route this pack serves, once the FRONT prefix comes off', () => {
  const g = packGraph();
  const stats = addHarFacts(g, [readHar(HAR, { file: 'session.har' })], { prefix: PREFIX });

  // ONE edge per (screen, endpoint) pair, whatever the call count.
  const mine = harEdges(g).filter((e) => e.from === SCREEN);
  assert.equal(mine.length, 1);
  const [e] = mine;
  assert.equal(e.to, EP);
  assert.equal(e.type, 'CALLS_HTTP');
  assert.equal(e.grade, 'RUNTIME_ONLY');
  assert.deepEqual(e.evidence, {
    rule: 'har',
    file: 'session.har',
    count: 2,
    firstSeen: '2026-01-05T09:00:00.400Z',
    lastSeen: '2026-01-05T09:00:02.900Z',
    methods: ['GET'],
  });

  // The census, every number of it: nothing is dropped in silence.
  assert.deepEqual({
    files: stats.files, entries: stats.entries, matched: stats.matched,
    unmatched: stats.unmatched, assets: stats.assets, pagesWithoutScreen: stats.pagesWithoutScreen,
    pairs: stats.pairs,
  }, {
    files: 1, entries: 8, matched: 3, unmatched: 3, assets: 2, pagesWithoutScreen: 1, pairs: 2,
  });
  // ...and the requests that landed nowhere are listed, most common first.
  assert.deepEqual(stats.unmatchedPaths, [
    { method: 'GET', path: '/', count: 2 },
    { method: 'POST', path: '/api/nothing/here', count: 1 },
  ]);
});

test('`observed` lands on BOTH ends: the screen the browser was on and the route it asked for', () => {
  const g = packGraph();
  addHarFacts(g, [readHar(HAR, { file: 'session.har' })], { prefix: PREFIX });
  assert.equal(g.nodes.get(SCREEN).observed, true);
  assert.equal(g.nodes.get(EP).observed, true);
  // ...and the screen the ROUTER declared keeps everything else it had.
  assert.equal(g.nodes.get(SCREEN).source, 'router');
  assert.equal(g.nodes.get(SCREEN).component, 'src/views/things/list.vue');
});

test('a page the source never declared becomes a screen of its own, marked as coming from the recording', () => {
  const g = packGraph();
  addHarFacts(g, [readHar(HAR, { file: 'session.har' })], { prefix: PREFIX });
  const n = g.nodes.get('screen:/nowhere/at/all');
  assert.ok(n, `no screen for the undeclared page: ${[...g.nodes.keys()].filter((k) => k.startsWith('screen:')).join(', ')}`);
  assert.equal(n.source, 'har');
  assert.equal(n.observed, true);
  assert.equal(n.component, null);
  assert.equal(n.title, 'Somewhere the router never declared');
  assert.deepEqual(n.declaredAt, []);
  // It renders nothing: no source line says which component it mounts.
  assert.deepEqual(g.outEdges(n.id).filter((x) => x.type === 'RENDERS'), []);
});

test('a recording NEVER raises a grade: the static edge beside it is untouched', () => {
  const g = packGraph();
  const web = 'symbol:src/api/orders.js#getOrder';
  g.addNode({ id: web, file: 'src/api/orders.js', lane: 'web' });
  g.addEdge({ from: web, to: EP, type: 'CALLS_HTTP', grade: 'SOUND_SET', evidence: { rule: 'web-http-call' } });
  g.addEdge({ from: SCREEN, to: web, type: 'RENDERS', grade: 'EXACT' });
  addHarFacts(g, [readHar(HAR, { file: 'session.har' })], { prefix: PREFIX });
  const stat = g.edges.find((e) => e.from === web && e.to === EP);
  assert.equal(stat.grade, 'SOUND_SET', 'the static edge keeps its own grade');
  assert.equal(harEdges(g).some((e) => e.from === SCREEN && e.to === EP), true, 'and the recording says so beside it');
});

test('a RUNTIME_ONLY edge is below every mode\'s floor, so no walk in any mode follows one', () => {
  for (const mode of Object.keys(GRADE_SETS)) {
    assert.equal(GRADE_SETS[mode].has('RUNTIME_ONLY'), false, `mode=${mode} would walk a recording`);
  }
  const g = packGraph();
  addHarFacts(g, [readHar(HAR, { file: 'session.har' })], { prefix: PREFIX });
  for (const mode of ['strict', 'conservative', 'heuristic']) {
    const w = chainWalk(g, { start: SCREEN, direction: 'down', mode, maxDepth: 8 });
    assert.deepEqual(w.endpoints, [], `mode=${mode} walked a HAR edge onto a route`);
    assert.equal(w.walked, 0, `mode=${mode} walked something from a screen with only a recording on it`);
  }
});

test('with no prefix census at all, the path is matched as the browser sent it', () => {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /api/orders/{id}', path: '/api/orders/{id}', httpMethod: 'GET' });
  g.addNode({ id: SCREEN, path: '/things/list', label: '/things/list', lane: 'web', source: 'router' });
  const stats = addHarFacts(g, [readHar(HAR, { file: 'session.har' })], {});
  assert.equal(stats.matched, 3);
  assert.deepEqual(harEdges(g).map((e) => `${e.from} -> ${e.to}`).sort(), [
    'screen:/nowhere/at/all -> endpoint:GET /api/orders/{id}',
    'screen:/things/list -> endpoint:GET /api/orders/{id}',
  ]);
});

test('two recordings of the same pair are one edge, with the earliest and latest time on it', () => {
  const g = packGraph();
  const second = HAR.replace(/2026-01-05T09:00:00\.400Z/, '2026-01-04T08:00:00.000Z');
  const stats = addHarFacts(g, [
    readHar(HAR, { file: 'monday.har' }),
    readHar(second, { file: 'sunday.har' }),
  ], { prefix: PREFIX });
  assert.equal(stats.files, 2);
  const e = harEdges(g).find((x) => x.from === SCREEN);
  assert.equal(e.evidence.count, 4);
  assert.equal(e.evidence.firstSeen, '2026-01-04T08:00:00.000Z');
  assert.equal(e.evidence.lastSeen, '2026-01-05T09:00:02.900Z');
  assert.equal(e.evidence.file, 'monday.har', 'the recording the pair was first seen in');
});
