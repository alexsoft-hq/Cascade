import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// The web lane defects the second independent review reproduced (RM67, review
// 2a items 1 to 6), each named by the test that fails before the fix. The
// fixtures are the reviewer's own, run through the worker that is spawned and
// then the bridge, so every step is the one `cascade analyze` takes.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function factsOf(dir) {
  return execFileSync(process.execPath, [WORKER, '--root', dir, path.join(dir, 'src')], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function graphWith(routes) {
  const g = new Graph();
  for (const [method, p] of routes) {
    const id = webEndpointId(method, p);
    g.addNode({ id, path: p, httpMethod: method, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

const everyVerb = (paths) => ['GET', 'POST', 'DELETE'].flatMap((m) => paths.map((p) => [m, p]));
const httpFrom = (g, file, fn) => g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from === `symbol:${file}#${fn}`);
const callsFrom = (g, file, fn) => g.edges.filter((e) => e.type === 'CALLS' && e.from === `symbol:${file}#${fn}`);

// ---------------------------------------------------------------------------
// Forward chains and the fetch wrapper (items 1 to 3)
// ---------------------------------------------------------------------------

const FORWARDS = path.join(FIXTURES, 'web-review-forwards');
const forwards = () => {
  const g = graphWith(everyVerb(['/items']));
  const stats = addWebFacts(g, factsOf(FORWARDS));
  return { g, stats };
};

test('forward_chain_uses_final_sink_method', () => {
  // get(opt) -> request({...opt, method: 'GET'}) -> axios({...option, method: 'DELETE'}):
  // the request that leaves is a DELETE, whatever the first hop wrote.
  const { g } = forwards();
  const e = httpFrom(g, 'src/api.ts', 'innerOverrides');
  assert.deepEqual(e.map((x) => x.to), [webEndpointId('DELETE', '/items')]);
  assert.equal(e[0].evidence.method.value, 'DELETE');
  assert.equal(e[0].grade, 'SOUND_SET');
});

test('forward_chain_rejects_url_in_discarded_parameter', () => {
  // get(opt) -> drop(opt, {}) -> axios({...options}): the URL is in `ignored`,
  // which the last hop never hands on. No edge may say it reaches /items.
  const { g, stats } = forwards();
  const e = httpFrom(g, 'src/api.ts', 'wrongArgument');
  assert.equal(e.some((x) => x.grade === 'SOUND_SET'), false, JSON.stringify(e));
  assert.ok(stats.calls.urlNotHandedOn >= 1);
});

test('fetch_wrapper_respects_method_after_spread', () => {
  // fetcher(u, o) -> fetch(u, {method: 'GET', ...o}) with o = {method: 'POST'}.
  const { g } = forwards();
  const e = httpFrom(g, 'src/api.ts', 'fetchOverrides');
  assert.deepEqual(e.map((x) => [x.to, x.evidence.method.value]), [[webEndpointId('POST', '/items'), 'POST']]);
});

test('a hop that hands the URL on through a member, a local or a rest still reaches the sink', () => {
  // The guards beside the reviewer's cases: what this lane reads (a member, a
  // spread) and what it cannot follow but must not call a discard (a local, a rest).
  const { g } = forwards();
  for (const fn of ['throughMember', 'throughLocal', 'throughRest']) {
    const e = httpFrom(g, 'src/callers.ts', fn);
    assert.ok(e.some((x) => x.to.endsWith(' /items') && x.grade === 'SOUND_SET'), `${fn}: ${JSON.stringify(e)}`);
  }
  // A default the first hop writes before the caller's options, and a later hop
  // that writes none: the caller's POST is what leaves.
  const post = httpFrom(g, 'src/callers.ts', 'callerMethod');
  assert.deepEqual(post.map((x) => [x.to, x.evidence.method.value]), [[webEndpointId('POST', '/items'), 'POST']]);
});

// ---------------------------------------------------------------------------
// Base URLs per build (items 4 and 5)
// ---------------------------------------------------------------------------

const ENV_ROUTES = [['GET', '/things'], ['GET', '/api/things'], ['GET', '/foo/things'], ['GET', '/api/foo/things']];
const envRun = (name) => {
  const g = graphWith(ENV_ROUTES);
  const stats = addWebFacts(g, factsOf(path.join(FIXTURES, 'web-review-env', name)));
  return { g, stats, edges: httpFrom(g, 'src/a.js', 'go') };
};

test('base_url_does_not_join_disjoint_build_modes', () => {
  // The base URL is set only for development, the front of the path only for
  // production: no build sends /api/foo/things, so no edge may say one does.
  const { edges, stats } = envRun('cross-modes');
  assert.equal(edges.some((e) => e.to === webEndpointId('GET', '/api/foo/things')), false, JSON.stringify(edges));
  assert.equal(edges.some((e) => e.grade === 'SOUND_SET'), false, JSON.stringify(edges));
  assert.equal(stats.unresolved.byReason.noBuild, 1);
});

test('empty_env_or_uses_fallback', () => {
  // `VITE_BASE=` is the empty string, which `||` treats as unset.
  const or = envRun('empty-or');
  assert.deepEqual(or.edges.map((e) => e.to), [webEndpointId('GET', '/api/things')]);
  assert.equal(or.edges[0].grade, 'HEURISTIC', 'the value is the default literal, which runs only where nothing sets it');
  // `??` keeps the empty string: no base URL at all.
  const nullish = envRun('empty-nullish');
  assert.deepEqual(nullish.edges.map((e) => [e.to, e.grade]), [[webEndpointId('GET', '/things'), 'SOUND_SET']]);
});

// ---------------------------------------------------------------------------
// Angular providers behind a typed injection (item 6)
// ---------------------------------------------------------------------------

test('typed_injection_includes_useClass_provider_target', () => {
  const g = graphWith(everyVerb(['/base', '/replacement']));
  addWebFacts(g, factsOf(path.join(FIXTURES, 'web-review-providers')));
  const byTarget = (file, fn) => Object.fromEntries(callsFrom(g, file, fn).map((e) => [e.to, e.grade]));
  // Component level: `providers: [{provide: Base, useClass: Replacement}]`.
  assert.deepEqual(byTarget('src/component.ts', 'Page.load'), {
    'symbol:src/service.ts#Base.list': 'SOUND_SET',
    'symbol:src/service.ts#Replacement.list': 'SOUND_SET',
  });
  // Module level, through `useExisting`.
  assert.deepEqual(byTarget('src/pages.ts', 'OtherPage.load'), {
    'symbol:src/service.ts#Other.list': 'SOUND_SET',
    'symbol:src/service.ts#Alias.list': 'SOUND_SET',
  });
  // Application level, through a factory this lane does not read: the set may
  // be short, so it is not SOUND_SET.
  const legacy = callsFrom(g, 'src/pages.ts', 'LegacyPage.load');
  assert.deepEqual(legacy.map((e) => [e.to, e.grade]), [['symbol:src/service.ts#Legacy.list', 'HEURISTIC']]);
  assert.equal(legacy[0].evidence.providers.unread[0].use, 'useFactory');
});
