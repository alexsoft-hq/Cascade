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
  // The guards beside the reviewer's cases: a member, a spread copy held in a
  // local, and a rest that does not name `url`. Each is settled by the syntax.
  const { g } = forwards();
  for (const fn of ['throughMember', 'throughLocal', 'throughRest']) {
    const e = httpFrom(g, 'src/callers.ts', fn);
    assert.ok(e.some((x) => x.to.endsWith(' /items') && x.grade === 'SOUND_SET'), `${fn}: ${JSON.stringify(e)}`);
    assert.ok(e.every((x) => x.evidence.sink.unsettled === undefined), fn);
  }
  // A default the first hop writes before the caller's options, and a later hop
  // that writes none: the caller's POST is what leaves.
  const post = httpFrom(g, 'src/callers.ts', 'callerMethod');
  assert.deepEqual(post.map((x) => [x.to, x.evidence.method.value]), [[webEndpointId('POST', '/items'), 'POST']]);
});

// ---------------------------------------------------------------------------
// What a hop hands on, settled by the syntax or not (item 2, made precise)
// ---------------------------------------------------------------------------

const SETTLED = path.join(FIXTURES, 'web-review-settled');
const settled = () => {
  const g = graphWith(everyVerb(['/items', '/other']));
  const stats = addWebFacts(g, factsOf(SETTLED));
  return { g, stats, from: (fn) => httpFrom(g, 'src/callers.ts', fn) };
};
const ITEMS = webEndpointId('GET', '/items');

test('a_rest_or_copy_that_does_not_name_the_url_carries_it', () => {
  // `const { headersType, headers, ...otherOption } = option; axios({ ...otherOption })`:
  // the rest holds every key the pattern does not name, `url` among them. So
  // do a copy, an alias, a part put back under its key and `option.url` as a
  // key's value. Each is settled: SOUND_SET, and no hop left unsettled.
  const { from, stats } = settled();
  for (const fn of ['viaRest', 'viaKeep', 'viaSignatureKeep', 'viaAlias', 'viaCopy', 'viaKey']) {
    const e = from(fn);
    assert.deepEqual(e.map((x) => [x.to, x.grade]), [[ITEMS, 'SOUND_SET']], fn);
    assert.equal(e[0].evidence.sink.kind, 'wrapper', fn);
    assert.equal(e[0].evidence.sink.unsettled, undefined, fn);
  }
  // Only the six hops the syntax does not settle are counted.
  assert.equal(stats.calls.urlThroughUnreadHop, 6);
});

test('a_hop_that_names_the_url_and_does_not_hand_it_on_drops_it', () => {
  // `const { url, ...rest } = option; axios({ ...rest })`, the same in the
  // signature, a copy that writes its own `url` over the caller's, and one
  // that reads `headers`, another key it took out, which holds no URL.
  const { from, stats } = settled();
  for (const fn of ['viaDrop', 'viaSignatureDrop', 'viaOverwrite', 'viaDropWithHeaders']) {
    const e = from(fn);
    assert.equal(e.some((x) => x.to === ITEMS && x.grade === 'SOUND_SET'), false, `${fn}: ${JSON.stringify(e)}`);
    assert.ok(e.every((x) => x.evidence.sink.kind === 'untraced'), fn);
  }
  assert.ok(stats.calls.urlNotHandedOn >= 4, JSON.stringify(stats.calls));
});

test('a_hop_the_source_does_not_settle_is_heuristic_and_says_why', () => {
  // A variable assigned again, a parameter written over, `this`, a call on
  // the options, and the URL taken out and put back through a call on it: it
  // may reach the client, and nothing written says what it is when it does.
  const { from, stats } = settled();
  const cases = {
    viaReassigned: { hop: 'src/hops.ts#reassigned', why: 'reassigned', name: 'conf' },
    viaWrittenOver: { hop: 'src/hops.ts#writtenOver', why: 'reassigned', name: 'option' },
    viaThis: { hop: 'src/hops.ts#throughThis', why: 'this' },
    viaCall: { hop: 'src/hops.ts#throughCall', why: 'computed' },
    viaPrefix: { hop: 'src/hops.ts#prefixes', why: 'computed' },
  };
  for (const [fn, want] of Object.entries(cases)) {
    const e = from(fn);
    assert.deepEqual(e.map((x) => [x.to, x.grade]), [[ITEMS, 'HEURISTIC']], fn);
    const u = e[0].evidence.sink.unsettled;
    assert.ok(u, `${fn}: ${JSON.stringify(e[0].evidence.sink)}`);
    assert.deepEqual({ hop: u.hop, why: u.why, ...(u.name ? { name: u.name } : {}) }, want, fn);
    assert.equal(typeof u.reason, 'string', fn);
    assert.equal(Number.isInteger(u.line), true, fn);
  }
  // A step this lane reads only as the call it returns, whose arguments it did
  // not record: not settled either, and the step is named without a line.
  const back = from('viaReturn');
  assert.deepEqual(back.map((x) => [x.to, x.grade]), [[ITEMS, 'HEURISTIC']]);
  const { reason, ...rest } = back[0].evidence.sink.unsettled;
  assert.deepEqual(rest, { hop: 'src/hops.ts#throughReturn', why: 'unrecorded' });
  assert.equal(typeof reason, 'string');
  assert.deepEqual(stats.calls.unreadHopBy, {
    reassigned: 2, this: 1, computed: 2, unrecorded: 1,
  });
});

test('a hand says which keys a rest no longer carries and which key a part is', () => {
  const facts = factsOf(SETTLED);
  const callIn = (name) => facts.find((r) => r.kind === 'call' && r.file === 'src/hops.ts' && r.enclosing === name);
  assert.deepEqual(callIn('request').hands, [{ param: 0, arg: 0, as: 'spread', minus: ['headers', 'headersType'] }]);
  assert.deepEqual(callIn('keepsUrl').hands, [
    { param: 0, arg: 0, as: 'spread', minus: ['url'] },
    { param: 0, arg: 0, as: 'key', key: 'url', part: 'url' },
  ]);
  assert.deepEqual(callIn('byKey').hands, [{ param: 0, arg: 0, as: 'key', key: 'url', part: 'url' }]);
  // What a call reads apart from its hands: the parts inside `headers: {…}`,
  // which can only land under `headers`.
  assert.deepEqual(callIn('request').reads, {
    params: [], under: { headers: { params: [], partial: [{ param: 0, key: 'headers' }, { param: 0, key: 'headersType' }] } },
  });
  assert.deepEqual(callIn('reassigned').reads, { params: [], open: { why: 'reassigned', name: 'conf' } });
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
  // The production build sets no base URL at all, so it asks for /foo/things,
  // and that is the one request this call makes (review 3, R4).
  const { edges, stats } = envRun('cross-modes');
  assert.equal(edges.some((e) => e.to === webEndpointId('GET', '/api/foo/things')), false, JSON.stringify(edges));
  assert.deepEqual(edges.map((e) => [e.to, e.grade]), [[webEndpointId('GET', '/foo/things'), 'SOUND_SET']]);
  assert.equal(stats.unresolved.byReason.noBuild, 0);
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
