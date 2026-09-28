import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// The web lane defects the third independent review reproduced (RM67, review
// 3a, section B): fixes of round 2 that held only for round 2's exact inputs.
// The fixtures are the reviewer's own (test/fixtures/web-review3; `s` has one
// step more, a copy handed to another call), run through the worker that is
// spawned and then the bridge, as `cascade analyze` does.
// Each test names what the request sends AT RUN TIME, which is what an edge
// must not contradict.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function factsOf(dir) {
  return execFileSync(process.execPath, [WORKER, '--root', dir, path.join(dir, 'src')], { maxBuffer: 1 << 26 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const VERBS = ['GET', 'POST', 'DELETE', 'PUT'];
function run(name, paths, { dir = path.join(FIXTURES, 'web-review3', name), routes = null } = {}) {
  const g = new Graph();
  for (const [method, p] of routes ?? VERBS.flatMap((m) => paths.map((x) => [m, x]))) {
    const id = webEndpointId(method, p);
    g.addNode({ id, path: p, httpMethod: method, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  const stats = addWebFacts(g, factsOf(dir));
  return { g, stats };
}
const http = (g, fn) => g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.endsWith(`#${fn}`));
const said = (edges) => edges.map((e) => [e.to, e.grade]).sort();
const ITEMS = (m) => webEndpointId(m, '/items');

// ---------------------------------------------------------------------------
// R1: the method is followed hop by hop, the way the URL is
// ---------------------------------------------------------------------------

test('wrapper_method_from_caller_needs_the_hop_to_hand_it_on', () => {
  const { g } = run('m', ['/items']);
  // pick({url, method: 'DELETE'}) -> req1({url: o.url}) -> axios({method: 'GET', ...x}):
  // the hop hands on only the URL, so what leaves is the default, GET.
  assert.deepEqual(said(http(g, 't1')), [[ITEMS('GET'), 'SOUND_SET']]);
  // fetcher2('/items', {method: 'POST'}) -> fetch(u): the options go nowhere.
  assert.deepEqual(said(http(g, 't2')), [[ITEMS('GET'), 'SOUND_SET']]);
});

test('wrapper_hop_method_written_as_a_variable_is_not_the_library_default', () => {
  // api3.del -> req3('DELETE', o) -> axios({...o, method: verb}): a method is
  // written, and what it is the code does not say here.
  const { g } = run('m', ['/items']);
  const e = http(g, 't3');
  assert.ok(e.length > 0);
  assert.ok(e.every((x) => x.grade === 'HEURISTIC' && x.evidence.method.value === null), JSON.stringify(e.map((x) => x.evidence.method)));
});

test('wrapper_with_two_client_calls_keeps_both_methods', () => {
  // `if (o.upload) return axios({...o, method: 'POST'}); return axios({...o, method: 'GET'})`:
  // either branch may run, so both requests are candidates.
  const { g } = run('m', ['/items']);
  for (const fn of ['t4', 't4b']) {
    assert.deepEqual(said(http(g, fn)), [[ITEMS('GET'), 'SOUND_SET'], [ITEMS('POST'), 'SOUND_SET']], fn);
  }
});

test('wrapper_method_set_on_the_object_after_the_copy_is_read', () => {
  // `const cfg = {...o}; cfg.method = 'POST'` and `Object.assign(o, {method: 'DELETE'})`.
  const { g } = run('m', ['/items']);
  assert.deepEqual(said(http(g, 't8')), [[ITEMS('POST'), 'SOUND_SET']]);
  assert.deepEqual(said(http(g, 't9')), [[ITEMS('DELETE'), 'SOUND_SET']]);
  // `o.url = '/api' + o.url`: the URL itself is written over, which settles nothing.
  const t5 = http(g, 't5');
  assert.ok(t5.every((x) => x.grade !== 'SOUND_SET'), JSON.stringify(said(t5)));
});

// ---------------------------------------------------------------------------
// R2: settled means nothing writes the key; R3: a per-request base URL is read
// ---------------------------------------------------------------------------

test('settled_hop_member_write_is_not_settled', () => {
  // cfg.url = '/other' on a copy, option.url = '/other' on the parameter, delete cfg.url.
  const { g } = run('s', ['/items', '/v2/items', '/other']);
  for (const fn of ['a', 'b', 'c']) {
    const e = http(g, fn);
    assert.ok(!e.some((x) => x.grade === 'SOUND_SET' && x.to.endsWith(' /items')), `${fn}: ${JSON.stringify(said(e))}`);
    for (const x of e) {
      assert.equal(x.evidence.sink.unsettled?.why, 'written', `${fn}: ${JSON.stringify(x.evidence.sink)}`);
      assert.equal(x.evidence.sink.unsettled.key, 'url', fn);
    }
  }
  // A copy handed to another call before it is sent: that call may change it.
  const f = http(g, 'f');
  assert.ok(f.length > 0 && f.every((x) => x.grade === 'HEURISTIC' && x.evidence.sink.unsettled.why === 'handed'), JSON.stringify(said(f)));
});

test('hop_or_caller_baseURL_override_is_read', () => {
  // service({...option, baseURL: '/v2'}), and a caller that passes {url, baseURL: '/v2'}.
  const { g } = run('s', ['/items', '/v2/items', '/other']);
  for (const fn of ['d', 'e']) {
    const e = http(g, fn);
    assert.deepEqual(said(e), [[webEndpointId('GET', '/v2/items'), 'SOUND_SET']], fn);
    assert.deepEqual(e[0].evidence.prefix, { value: '/v2', from: 'request' }, fn);
  }
});

// ---------------------------------------------------------------------------
// R5, N1: Angular providers
// ---------------------------------------------------------------------------

test('typed_injection_reads_injectable_useClass', () => {
  // @Injectable({providedIn: 'root', useClass: Mock}) class Base: who injects Base gets a Mock.
  const { g } = run('ng', ['/base', '/mock', '/middle']);
  const e = g.edges.filter((x) => x.type === 'CALLS' && x.from.endsWith('APage.load'));
  assert.deepEqual(said(e), [['symbol:src/service.ts#Base.list', 'SOUND_SET'], ['symbol:src/service.ts#Mock.list', 'SOUND_SET']]);
});

test('provider_class_inheriting_the_method_keeps_the_inherited_target', () => {
  // {provide: Parent, useClass: Impl}, Impl extends Middle {}, list() on Middle.
  const { g } = run('ng', ['/base', '/mock', '/middle']);
  const e = g.edges.filter((x) => x.type === 'CALLS' && x.from.endsWith('BPage.load'));
  assert.deepEqual(said(e), [['symbol:src/service.ts#Middle.list', 'SOUND_SET'], ['symbol:src/service.ts#Parent.list', 'SOUND_SET']]);
});

// ---------------------------------------------------------------------------
// R4: a base URL only some builds set
// ---------------------------------------------------------------------------

test('base_url_set_in_one_build_is_not_sound_for_every_build', () => {
  // Only .env.development sets VITE_BASE: the development build asks /api/things,
  // a build with nothing set asks /things. Both are candidates, each for its build.
  const { g } = run('env1', null, { routes: [['GET', '/things'], ['GET', '/api/things']] });
  const e = http(g, 'go');
  assert.deepEqual(said(e), [[webEndpointId('GET', '/api/things'), 'SOUND_SET'], [webEndpointId('GET', '/things'), 'SOUND_SET']]);
});

// ---------------------------------------------------------------------------
// Item 2, what was left: a URL the chain drops draws no edge at all
// ---------------------------------------------------------------------------

test('url_not_handed_on_gets_no_guessed_edge', () => {
  const { g, stats } = run(null, ['/items'], { dir: path.join(FIXTURES, 'web-review-forwards') });
  assert.deepEqual(said(http(g, 'wrongArgument')), []);
  assert.equal(stats.calls.urlNotHandedOn, 1);
});
