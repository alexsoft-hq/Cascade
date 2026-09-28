// web_object_wrappers.test.mjs — an HTTP wrapper written as an OBJECT (RM67, R2-K).
//
// `export default { get: (option) => request({ method: 'GET', ...option }) }`
// and `request.get({ url: '/x', params })` in every api module is how a large
// Vue frontend sends everything. The lane did not follow a method of an object
// literal, and the method's body calls a helper the same file declares, which
// the worker did not record at all. So every call was `untraced` and HEURISTIC.
//
// The fixture under test/fixtures/web-object-wrappers is that shape, small:
// the default export, a named const written with method shorthand, a caller in
// the object's own file, a verb written after the caller's options, a caller
// that names its own method, one whose options carry a spread, and a method
// that hands on the wrong argument.
//
// The worker is SPAWNED and its records go to the bridge unchanged, so what is
// under test is the whole path from the source to the edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId, webSymbolId, WEB_CALL_BASIS } from '../src/adapters/web_bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-object-wrappers');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, path.join(FIXTURE, 'src')], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));

const fnRec = (file, name) => {
  const hit = RECORDS.filter((r) => r.kind === 'function' && r.file === file && r.name === name);
  assert.equal(hit.length, 1, `expected one function ${file}#${name}, got ${hit.length}`);
  return hit[0];
};
const callIn = (enclosing) => {
  const hit = RECORDS.filter((r) => r.kind === 'call' && r.enclosing === enclosing);
  assert.equal(hit.length, 1, `expected one call in ${enclosing}, got ${hit.length}`);
  return hit[0];
};

const ROUTES = [
  ['GET', '/things/list'],
  ['POST', '/things/save'],
  ['PUT', '/things/save'],
  ['GET', '/plain/list'],
  ['DELETE', '/plain/list'],
];

function run() {
  const g = new Graph();
  for (const [httpMethod, p] of ROUTES) {
    const id = webEndpointId(httpMethod, p);
    g.addNode({ id, path: p, httpMethod, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  const stats = addWebFacts(g, RECORDS);
  return { g, stats };
}

const edgesFrom = (g, file, fn) => g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from === webSymbolId(file, fn));
const onlyFrom = (g, file, fn) => {
  const e = edgesFrom(g, file, fn);
  assert.equal(e.length, 1, `expected one CALLS_HTTP edge from ${fn}, got ${e.length}: ${JSON.stringify(e, null, 1)}`);
  return e[0];
};

const API = 'src/api/things.ts';
const INDEX = 'src/http/index.ts';
const NAMED = 'src/http/named.ts';

// ---------------------------------------------------------------------------
// The worker: what a function hands on, and where a URL was read from
// ---------------------------------------------------------------------------

test('an object\'s method that hands its options to a helper the file declares says so on its record', () => {
  const get = fnRec(INDEX, 'get');
  assert.equal(get.member, 'default.get');
  assert.deepEqual(get.forwards, [{
    line: 15,
    callee: { shape: 'ident', root: 'request', path: [], name: 'request' },
    binding: { kind: 'local', name: 'request' },
    // Written BEFORE the caller's options, so the caller's own `method` wins.
    method: { value: 'GET', from: 'config', overridable: { key: 'method', by: [0] } },
    hands: [{ param: 0, arg: 0, as: 'spread' }],
    // Which of its parameters the call reads at all (review 2, item 2).
    reads: { params: [0] },
  }]);
  // Written AFTER them, so nothing the caller hands in replaces it.
  assert.deepEqual(fnRec(INDEX, 'put').forwards[0].method, { value: 'PUT', from: 'config' });
  // `query` spreads its SECOND parameter.
  assert.deepEqual(fnRec(INDEX, 'query').forwards[0].hands, [{ param: 1, arg: 0, as: 'spread' }]);
  // `ping` calls the helper with a local of its own: it hands on nothing it was given.
  assert.equal(fnRec(INDEX, 'ping').forwards, undefined);
  // A call on a name the file declares is still no call record.
  assert.equal(RECORDS.some((r) => r.kind === 'call' && r.file === INDEX && r.callee.root === 'request'), false);
});

test('a call record says which argument its URL came from, and an object with a spread says it has one', () => {
  assert.deepEqual(callIn('listThings').url.at, { arg: 0, key: 'url' });
  assert.equal(callIn('listThings').args[0].spread, undefined);
  assert.equal(callIn('listWithConfig').args[0].spread, true);
});

// ---------------------------------------------------------------------------
// The bridge: the call traced into the method, to the client
// ---------------------------------------------------------------------------

test('a call through an imported object\'s method is traced to the client and graded SOUND_SET, never EXACT', () => {
  const { g, stats } = run();
  const e = onlyFrom(g, API, 'listThings');
  assert.equal(e.to, webEndpointId('GET', '/things/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.wrapper);
  assert.deepEqual(e.evidence.sink, {
    kind: 'wrapper',
    module: 'axios',
    instance: 'src/http/service.ts#service',
    chain: [`${INDEX}#request`, `${INDEX}#get`],
    depth: 2,
  });
  // The wrapper's own default, because the caller's options name no method.
  assert.deepEqual(e.evidence.method, { value: 'GET', from: 'wrapper-default' });
  // get, post, put, query, fetch, remove, and `ping`, which RETURNS a call to
  // the helper and is a wrapper by the rule a return always followed.
  assert.equal(stats.wrappers.byKind.objectMethod, 7);
  assert.equal(stats.calls.urlNotHandedOn, 1);
  // A wrapper is plumbing: no node of its own.
  assert.equal(g.nodes.has(webSymbolId(INDEX, 'get')), false);
});

test('the method is the one the wrapper writes, unless the caller\'s options name their own', () => {
  const { g } = run();
  const post = onlyFrom(g, API, 'saveThing');
  assert.equal(post.to, webEndpointId('POST', '/things/save'));
  assert.deepEqual(post.evidence.method, { value: 'POST', from: 'wrapper-default' });
  // Written after the caller's options: the wrapper's verb, whatever the caller says.
  const put = onlyFrom(g, API, 'replaceThing');
  assert.equal(put.to, webEndpointId('PUT', '/things/save'));
  assert.deepEqual(put.evidence.method, { value: 'PUT', from: 'wrapper-verb' });
  // `request.get({ …, method: 'post' })`: the caller's key is spread in last.
  const own = onlyFrom(g, API, 'saveThingThroughGet');
  assert.equal(own.to, webEndpointId('POST', '/things/save'));
  assert.deepEqual(own.evidence.method, { value: 'POST', from: 'config' });
  assert.equal(own.grade, 'SOUND_SET');
});

test('options that could carry a method leave it unread, and the edge says a rule guessed', () => {
  const { g } = run();
  const e = onlyFrom(g, API, 'listWithConfig');
  assert.equal(e.evidence.sink.kind, 'wrapper');
  assert.deepEqual(e.evidence.method, { value: null, from: 'absent', wrapperDefault: 'GET' });
  assert.equal(e.grade, 'HEURISTIC');
});

test('a method that does not hand the URL\'s argument on does not trace it', () => {
  const { g } = run();
  const e = onlyFrom(g, API, 'listThroughQuery');
  assert.equal(e.evidence.sink.kind, 'untraced');
  assert.equal(e.grade, 'HEURISTIC');
});

test('an object held in a named const is the same, called from another file and from its own', () => {
  const { g } = run();
  const remove = onlyFrom(g, API, 'removePlain');
  assert.equal(remove.to, webEndpointId('DELETE', '/plain/list'));
  assert.equal(remove.grade, 'SOUND_SET');
  assert.deepEqual(remove.evidence.sink.chain, [`${NAMED}#send`, `${NAMED}#remove`]);
  assert.deepEqual(remove.evidence.method, { value: 'DELETE', from: 'wrapper-default' });
  // `export default http`: the default export is a name that holds the object.
  const held = onlyFrom(g, API, 'listHeld');
  assert.equal(held.to, webEndpointId('GET', '/plain/list'));
  assert.equal(held.grade, 'SOUND_SET');
  assert.deepEqual(held.evidence.sink.chain, [`${NAMED}#send`, `${NAMED}#fetch`]);
  const local = onlyFrom(g, NAMED, 'listPlain');
  assert.equal(local.to, webEndpointId('GET', '/plain/list'));
  assert.equal(local.grade, 'SOUND_SET');
  assert.deepEqual(local.evidence.sink.chain, [`${NAMED}#send`, `${NAMED}#fetch`]);
});
