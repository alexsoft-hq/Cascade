import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// A BASE URL THE BUILD DECIDES (R2-B), read by the worker that is spawned and
// then by the bridge, end to end.
//
// The worker cannot say what `process.env.X` holds: that is in the package's
// `.env` files, which are other files. So the rule under test on this side is
// that the expression is KEPT, whole and unread, wherever a base URL can be
// written: a constant, a member of an object constant, a hole in a URL, and a
// name the top of a module destructured. The bridge half is the second part.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-base-url');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, path.join(FIXTURE, 'src')], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));

const constantNamed = (name) => RECORDS.find((r) => r.kind === 'constant' && r.name === name);
const callIn = (enclosing) => {
  const hits = RECORDS.filter((r) => r.kind === 'call' && r.enclosing === enclosing);
  assert.equal(hits.length, 1, `expected one call in ${enclosing}, got ${hits.length}`);
  return hits[0];
};
const envRead = (root, name) => ({ kind: 'member', root, path: ['env', name] });

test('a constant with a default keeps both halves, and no text', () => {
  const c = constantNamed('SERVER_URL');
  assert.deepEqual(c.expr, {
    kind: 'fallback', operator: '||',
    left: envRead('process', 'SHOP_SERVER_URL'), right: { kind: 'string', value: 'http://localhost:8080/api' },
  });
  assert.equal(c.value, undefined, 'which half runs is a build fact, so the constant states no text');
});

test('an object member made of two environment reads is kept beside the string members', () => {
  const c = constantNamed('settings');
  assert.deepEqual(c.members, { timeout: 'long' });
  assert.equal(c.exprMembers.baseUrl.kind, 'template');
  assert.equal(c.exprMembers.baseUrl.template, '{*}{*}');
  assert.deepEqual(c.exprMembers.baseUrl.holes, [
    { kind: 'name', name: 'import.meta.env.VITE_ORIGIN' }, { kind: 'name', name: 'import.meta.env.VITE_API_PATH' },
  ]);
});

test('a condition over an environment read is kept with every branch, and a bare read stays a binding', () => {
  assert.deepEqual(constantNamed('PICKED').expr, {
    kind: 'ternary', candidates: [envRead('import.meta', 'VITE_ORIGIN'), { kind: 'string', value: '/' }],
  });
  assert.equal(constantNamed('PLAIN'), undefined);
  const plain = RECORDS.find((r) => r.kind === 'binding' && r.name === 'PLAIN');
  assert.deepEqual(plain.init.callee.path, ['env', 'VITE_PLAIN']);
});

test('a base URL written as a destructured name says which member of which object it is', () => {
  const client = RECORDS.find((r) => r.kind === 'binding' && r.name === 'client');
  assert.deepEqual(client.init.baseURL, { kind: 'member', root: 'settings', path: ['baseUrl'] });
});

test('a destructured name in a URL is that member, and a hole cut off with the query is not left behind', () => {
  // `baseUrl + '/auth/renew?token=' + token`: the path has ONE hole, and it is
  // `settings.baseUrl`, not `settings` (the whole object the declaration names).
  const url = callIn('renewToken').url;
  assert.deepEqual(url.resolved.map((r) => r.template), ['{*}/auth/renew']);
  assert.deepEqual(url.holes, [{ kind: 'import', name: 'settings.baseUrl', source: './settings', imported: 'settings' }]);
  assert.equal(url.query, 'token={*}');
});

test('a default written inside a URL is an env hole carrying the expression', () => {
  const url = callIn('inlineDefault').url;
  assert.deepEqual(url.holes[0], {
    kind: 'env', name: 'process.env.SHOP_SERVER_URL',
    expr: { kind: 'fallback', operator: '||', left: envRead('process', 'SHOP_SERVER_URL'), right: { kind: 'string', value: '/api' } },
  });
  assert.deepEqual(url.holes[1], { kind: 'parameter', name: 'id' });
});

test('a default handed to a verb is still not a URL argument', () => {
  // `cache.get(name || 'fallback-key')` read as `other` before the summaries
  // learned to say what a default is, and must read the same after.
  assert.equal(RECORDS.some((r) => r.kind === 'call' && r.enclosing === 'readCache'), false);
});

test('the package says what it builds with, as a package-level config record', () => {
  const pkg = RECORDS.filter((r) => r.kind === 'config' && r.what === 'package');
  assert.deepEqual(pkg, [{ kind: 'config', file: 'package.json', line: 1, what: 'package', dependencies: ['axios', 'vite'] }]);
});

// ---------------------------------------------------------------------------
// The bridge over the same records
// ---------------------------------------------------------------------------

function graphWith(routes) {
  const g = new Graph();
  for (const [httpMethod, p] of routes) {
    const id = webEndpointId(httpMethod, p);
    g.addNode({ id, path: p, httpMethod, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

const ROUTES = [['POST', '/api/auth/renew'], ['GET', '/api/orders'], ['GET', '/api/orders/{id}']];
const edgeFrom = (g, fn) => g.edges.find((e) => e.type === 'CALLS_HTTP' && e.from.endsWith(`#${fn}`));

test('end to end: two env reads joined per build reach the route, and the build that reaches this machine keeps it SOUND_SET', () => {
  const g = graphWith(ROUTES);
  const stats = addWebFacts(g, RECORDS);
  const e = edgeFrom(g, 'renewToken');
  assert.equal(e.to, webEndpointId('POST', '/api/auth/renew'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.url.template, '/api/auth/renew');
  const [sub] = e.evidence.url.substituted;
  assert.equal(sub.name, 'settings.baseUrl');
  assert.equal(sub.value, 'http://localhost:9090/api', 'the build on this machine is the one shown');
  assert.equal(sub.from, 'env-file');
  assert.equal(sub.env, 'VITE_ORIGIN + VITE_API_PATH');
  assert.deepEqual(sub.reads.map((r) => [r.raw, r.modes]), [
    ['http://localhost:9090/api', ['development']], ['https://shop.example.com/api', ['production']],
  ]);
  assert.equal(e.evidence.url.guess, undefined);
  // The client's own base URL is the same value, read through the import.
  const client = stats.prefix[''].instances.find((i) => i.id === 'src/client.js#client');
  assert.deepEqual([client.value, client.from, client.guess], ['/api', 'derived', undefined]);
});

test('end to end: a default no .env file sets is used, and every edge built on it is HEURISTIC', () => {
  const g = graphWith(ROUTES);
  const stats = addWebFacts(g, RECORDS);
  const e = edgeFrom(g, 'listOrders');
  assert.equal(e.to, webEndpointId('GET', '/api/orders'));
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(e.evidence.url.guess, 'fallback');
  // localhost WITH A PORT is this machine: the call stays in the pack.
  assert.equal(e.evidence.url.host, 'localhost:8080');
  assert.equal(e.evidence.target, 'in-pack');
  assert.equal(stats.url.guessed.fallback, 2, 'listOrders and inlineDefault both rest on the default');
  const inline = edgeFrom(g, 'inlineDefault');
  assert.equal(inline.to, webEndpointId('GET', '/api/orders/{id}'));
  assert.equal(inline.grade, 'HEURISTIC');
});
