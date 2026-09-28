import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { addWebFacts, webEndpointId, WEB_BASE_GUESS } from '../src/adapters/web_bridge.mjs';
import {
  buildEnvPack, buildToolOf, envByMode, hostnameOf, isLocalHost, splitAddress,
} from '../src/adapters/web/base_url.mjs';

// WHAT A BASE URL HOLDS IN EACH BUILD, and what that rests on (R2-B), driven by
// hand-written facts in the style of web_bridge.test.mjs. The worker half is
// web_base_url_facts.test.mjs.
//
// Three rules, one test group each:
//   the build tool   which .env files a value comes from, per mode, is the
//                    tool's documented rule (adapters/web/packs/build-env.json)
//   the host         an absolute address on this machine, whatever its port,
//                    is a backend's development server; one elsewhere, in every
//                    build, is a deployment nothing in the source ties here
//   the guess        a default literal, or a deployment host, grades every
//                    edge built on it HEURISTIC, through the constant, the URL
//                    and the edge

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROUTES = [['GET', '/api/things/list'], ['GET', '/plain/list']];

function graphWithRoutes() {
  const g = new Graph();
  for (const [httpMethod, path] of ROUTES) {
    const id = webEndpointId(httpMethod, path);
    g.addNode({ id, path, httpMethod, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

function file(name, ...records) {
  return [{ kind: 'file', file: name, line: 1, lang: 'js', recoveredErrors: 0 }, ...records.map((r) => ({ file: name, ...r }))];
}
const cfg = (f, rec) => ({ kind: 'config', file: f, line: 1, ...rec });
const env = (f, name, value, mode) => cfg(f, { what: 'env', name, value, mode });
const pkg = (...dependencies) => cfg('package.json', { what: 'package', dependencies });
const envRead = (root, name) => ({ kind: 'member', root, path: ['env', name] });
const literalUrl = (t) => ({ arg: { kind: 'string', value: t }, resolved: [{ template: t, dynamicParts: 0, via: 'literal' }] });

/** A client built with this base URL summary, and one call through it. */
function clientFacts(baseURL, url = '/things/list') {
  return [
    ...file('src/http.js',
      { kind: 'import', line: 1, source: 'axios', specifiers: [{ imported: 'default', local: 'axios' }], dynamic: false },
      {
        kind: 'binding', line: 2, name: 'client', exported: true,
        init: {
          shape: 'call', callee: { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
          binding: { kind: 'import', source: 'axios', imported: 'default' }, baseURL,
        },
      },
      { kind: 'export', line: 3, name: 'default', of: 'expression', local: 'client' }),
    ...file('src/api/x.js',
      { kind: 'import', line: 1, source: '../http', specifiers: [{ imported: 'default', local: 'client' }], dynamic: false },
      { kind: 'function', line: 2, name: 'go', endLine: 4, exported: 'named', async: false, params: 0, returns: null },
      {
        kind: 'call', line: 3, enclosing: 'go', callee: { shape: 'member', root: 'client', path: ['get'], name: 'get' },
        binding: { kind: 'import', source: '../http', imported: 'default' }, args: [], url: literalUrl(url),
        method: { value: 'GET', from: 'callee-name' }, platformSink: null,
      }),
  ];
}

const only = (g) => {
  const e = g.edges.filter((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.length, 1, `expected one CALLS_HTTP edge, got ${JSON.stringify(e, null, 1)}`);
  return e[0];
};

// ---------------------------------------------------------------------------
// The build tool and the host
// ---------------------------------------------------------------------------

test('the build tool is picked by the dependencies the package names, and one with none gets the shared default', () => {
  assert.equal(buildToolOf(['react', 'react-scripts']).name, 'create-react-app');
  assert.equal(buildToolOf(['vue', '@vue/cli-service']).name, 'vue-cli');
  assert.equal(buildToolOf(['vue', 'vite']).name, 'vite');
  assert.equal(buildToolOf(['next', 'vite']).name, 'next', 'the first row that matches wins');
  assert.equal(buildToolOf(null).name, buildEnvPack().default.name);
});

test('per mode, the LAST file in the tool\'s order that sets a name gives its value', () => {
  const pack = (deps, rows) => {
    const c = { env: new Map(), dependencies: deps };
    for (const r of rows) {
      if (!c.env.has(r.name)) c.env.set(r.name, []);
      c.env.get(r.name).push({ value: r.value, mode: r.mode ?? null, file: r.file });
    }
    return c;
  };
  const rows = [
    { name: 'X', value: 'base', file: 'f/.env' },
    { name: 'X', value: 'local', file: 'f/.env.local' },
    { name: 'X', value: 'dev', file: 'f/.env.development', mode: 'development' },
    { name: 'X', value: 'dev-local', file: 'f/.env.development.local', mode: 'development' },
    { name: 'X', value: 'staging', file: 'f/.env.staging', mode: 'staging' },
  ];
  const byMode = (deps) => Object.fromEntries(envByMode(pack(deps, rows), 'X').map((m) => [m.mode, m.value]));
  // Vite: .env < .env.local < .env.[mode] < .env.[mode].local, and --mode names any other.
  assert.deepEqual(byMode(['vite']), {
    development: 'dev-local', production: 'local', staging: 'staging',
  });
  // Create React App: the same four files, but no mode besides the two it builds.
  assert.deepEqual(byMode(['react-scripts']), { development: 'dev-local', production: 'local' });
  // The Angular CLI reads no .env file at all.
  assert.deepEqual(byMode(['@angular/cli']), { development: null, production: null });
});

test('this machine is this machine whatever port it names, and nothing else is', () => {
  assert.equal(hostnameOf('localhost:8080'), 'localhost');
  assert.equal(hostnameOf('[::1]:3000'), '[::1]');
  assert.equal(hostnameOf('user@127.0.0.1:80'), '127.0.0.1');
  for (const h of ['localhost', 'localhost:8080', '127.0.0.1:48080', '0.0.0.0:3000', '[::1]:5173', 'LOCALHOST']) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ['shop.example.com', 'localhost.example.com', 'api.example.org:8080']) assert.equal(isLocalHost(h), false, h);
  assert.deepEqual(splitAddress('http://localhost:8080/api/'), { path: '/api', host: 'localhost:8080', where: 'local' });
  assert.deepEqual(splitAddress('https://shop.example.com'), { path: '', host: 'shop.example.com', where: 'remote' });
  assert.deepEqual(splitAddress('/'), { path: '', host: null, where: 'relative' });
});

test('an absolute URL on this machine with a port is a call into the pack, one to another host is not', () => {
  for (const [url, target, grade] of [
    ['http://127.0.0.1:3000/plain/list', 'in-pack', 'SOUND_SET'],
    ['https://other.example.com/plain/list', 'outside-pack', 'UNRESOLVED'],
  ]) {
    const g = graphWithRoutes();
    addWebFacts(g, file('src/a.js',
      { kind: 'function', line: 1, name: 'go', endLine: 3, exported: 'named', async: false, params: 0, returns: null },
      {
        kind: 'call', line: 2, enclosing: 'go', callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
        binding: { kind: 'global', name: 'fetch' }, args: [],
        url: { ...literalUrl('/plain/list'), absolute: { host: new URL(url).host, path: '/plain/list' } },
        method: null, platformSink: 'fetch',
      }));
    const e = only(g);
    assert.equal(e.evidence.target, target, url);
    assert.equal(e.grade, grade, url);
  }
});

// ---------------------------------------------------------------------------
// A conditional base URL
// ---------------------------------------------------------------------------

test('a conditional base URL whose every branch and build gives one path gives that path, with the branches on the edge', () => {
  // `NODE_ENV === 'production' ? process.env.BASE : '/'`, with a development
  // server on this machine and a deployment elsewhere, both at the root.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    pkg('@vue/cli-service'),
    env('.env.development', 'BASE', 'http://localhost:8000', 'development'),
    env('.env.production', 'BASE', 'https://shop.example.com', 'production'),
    ...clientFacts({ kind: 'ternary', candidates: [envRead('process', 'BASE'), { kind: 'string', value: '/' }] }, '/plain/list'),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.prefix.from, 'derived');
  assert.equal(e.evidence.prefix.value, '');
  assert.equal(e.evidence.prefix.guess, undefined, 'the development build reaches this machine');
  assert.deepEqual(e.evidence.prefix.reads, [
    { branch: '0', from: 'env-file', raw: 'http://localhost:8000', env: 'BASE', file: '.env.development', modes: ['development'] },
    { branch: '0', from: 'env-file', raw: 'https://shop.example.com', env: 'BASE', file: '.env.production', modes: ['production'] },
    { branch: '1', from: 'source', raw: '/' },
  ]);
  assert.equal(stats.prefix[''].instances.find((i) => i.id === 'src/http.js#client').from, 'derived');
});

test('branches that disagree are not settled silently: the prefix is a counted guess', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    pkg('vite'),
    env('.env', 'BASE', '/api', null),
    ...clientFacts({ kind: 'ternary', candidates: [envRead('import.meta', 'BASE'), { kind: 'string', value: '/other' }] }),
  ]);
  const e = only(g);
  assert.equal(e.evidence.prefix.from, 'auto');
  assert.equal(e.grade, 'HEURISTIC');
  assert.deepEqual(e.evidence.prefix.candidates.map((c) => c.value).sort(), ['', '/api', '/other']);
});

// ---------------------------------------------------------------------------
// The guesses
// ---------------------------------------------------------------------------

test('a base URL every build puts on another host is read for its path, and graded as the guess it is', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    pkg('vite'),
    env('.env.production', 'BASE', 'https://shop.example.com/api', 'production'),
    env('.env.development', 'BASE', 'https://dev.example.com/api', 'development'),
    ...clientFacts(envRead('import.meta', 'BASE')),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'HEURISTIC');
  assert.deepEqual([e.evidence.prefix.value, e.evidence.prefix.from, e.evidence.prefix.guess], ['/api', 'derived', 'deployment-host']);
  const axes = declareAxes({ ddl: false, statements: false, code: true, web: stats });
  assert.equal(axes.web.status, 'degraded');
  assert.match(axes.web.reason, /name only hosts that are not this machine/);
  assert.ok(WEB_BASE_GUESS['deployment-host']);
});

test('a default no .env file sets grades the client\'s edges HEURISTIC; a .env file that sets it makes them SOUND_SET', () => {
  const summary = {
    kind: 'fallback', operator: '||', left: envRead('process', 'API'), right: { kind: 'string', value: 'http://localhost:8080/api' },
  };
  const unset = graphWithRoutes();
  const stats = addWebFacts(unset, [pkg('react-scripts'), ...clientFacts(summary)]);
  const e = only(unset);
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'HEURISTIC');
  assert.deepEqual([e.evidence.prefix.value, e.evidence.prefix.guess], ['/api', 'fallback']);
  assert.deepEqual(e.evidence.prefix.reads, [
    { from: 'fallback', raw: 'http://localhost:8080/api', env: 'API', modes: ['development', 'production'] },
  ]);
  const axes = declareAxes({ ddl: false, statements: false, code: true, web: stats });
  assert.equal(axes.web.status, 'degraded');
  assert.match(axes.web.reason, /the client base URL in \. rest on an environment value's default literal/);

  // Set to an address on this machine: a RELATIVE value with no dev-proxy rule
  // to explain it is a guess of its own (`auto`), and not this test's.
  const set = graphWithRoutes();
  addWebFacts(set, [pkg('react-scripts'), env('.env', 'API', 'http://localhost:9000/api', null), ...clientFacts(summary)]);
  const s = only(set);
  assert.equal(s.grade, 'SOUND_SET');
  assert.deepEqual([s.evidence.prefix.value, s.evidence.prefix.guess], ['/api', undefined]);
});

test('an environment read at the front of a call whose builds disagree stays a hole', () => {
  // `/dev-api` and `/prod-api`: putting one of them in would be a guess
  // nobody could see, so the call is counted as it always was.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    pkg('vite'),
    env('.env.development', 'BASE', '/dev-api', 'development'),
    env('.env.production', 'BASE', '/prod-api', 'production'),
    ...file('src/a.js',
      { kind: 'function', line: 1, name: 'go', endLine: 3, exported: 'named', async: false, params: 0, returns: null },
      {
        kind: 'call', line: 2, enclosing: 'go', callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
        binding: { kind: 'global', name: 'fetch' }, args: [],
        url: {
          arg: { kind: 'template', template: '{*}/plain/list', dynamicParts: 1 },
          holes: [{ kind: 'env', name: 'import.meta.env.BASE' }],
          resolved: [{ template: '{*}/plain/list', dynamicParts: 1, via: 'template' }],
        },
        method: null, platformSink: 'fetch',
      }),
  ]);
  assert.equal(stats.url.substituted['env-file'] ?? 0, 0);
  assert.equal(stats.url.holes.env, 1);
  for (const e of g.edges.filter((x) => x.type === 'CALLS_HTTP')) assert.notEqual(e.evidence.url.template, '/dev-api/plain/list');
});

test('a base URL read through an alias this engine assumed is only as good as that alias', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    pkg('vite'),
    cfg('package.json', { what: 'alias', from: '@', to: 'src', assumed: true }),
    env('.env', 'BASE', 'http://localhost:9000/api', null),
    ...file('src/settings.js',
      { kind: 'constant', line: 1, name: 'settings', exported: true, members: {}, omitted: 0, exprMembers: { base: envRead('import.meta', 'BASE') } },
      { kind: 'export', line: 1, name: 'settings', of: 'const', local: 'settings' }),
    ...clientFacts({ kind: 'member', root: 'settings', path: ['base'] }),
    ...file('src/http.js',
      { kind: 'import', line: 1, source: '@/settings', specifiers: [{ imported: 'settings', local: 'settings' }], dynamic: false }),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.deepEqual([e.evidence.prefix.value, e.evidence.prefix.guess], ['/api', 'assumed-alias']);
  assert.equal(e.grade, 'HEURISTIC');
});
