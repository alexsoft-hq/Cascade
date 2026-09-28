import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { addWebFacts, webEndpointId } from '../src/adapters/web_bridge.mjs';

// Three follow-ups to the build-decided base URLs (R2-B), each a decision this
// file pins with hand-written facts:
//   the port     this machine is this machine, but its PORT says which service
//                answers: one no application of this pack listens on leaves the
//                call outbound, with both ports said
//   the wrapper  a function that hands its request to the GLOBAL fetch is a
//                wrapper, though `fetch` binds nothing a callee could resolve to
//   the axis     untraced calls are a note on the web axis, and as many
//                untraced as traced degrade it, with the rule in the reason

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
const fn = (line, name, extra = {}) => ({
  kind: 'function', line, name, endLine: line + 2, exported: 'named', async: false, params: 0, returns: null, ...extra,
});
const cfg = (f, rec) => ({ kind: 'config', file: f, line: 1, ...rec });
const env = (f, name, value, mode) => cfg(f, { what: 'env', name, value, mode });
const pkg = (...dependencies) => cfg('package.json', { what: 'package', dependencies });
const envRead = (root, name) => ({ kind: 'member', root, path: ['env', name] });
const literalUrl = (t) => ({ arg: { kind: 'string', value: t }, resolved: [{ template: t, dynamicParts: 0, via: 'literal' }] });
const fetchCallee = { callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' }, binding: { kind: 'global', name: 'fetch' } };
const edgesOf = (g) => g.edges.filter((e) => e.type === 'CALLS_HTTP');
const only = (g) => {
  const e = edgesOf(g);
  assert.equal(e.length, 1, `expected one CALLS_HTTP edge, got ${JSON.stringify(e, null, 1)}`);
  return e[0];
};

/** An axios client built with this base URL, and one call through it. */
function clientFacts(baseURL) {
  return [
    ...file('src/http.js',
      { kind: 'import', line: 1, source: 'axios', specifiers: [{ imported: 'default', local: 'axios' }], dynamic: false },
      {
        kind: 'binding', line: 2, name: 'client', exported: true,
        init: {
          shape: 'call', callee: { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
          binding: { kind: 'import', source: 'axios', imported: 'default' }, ...(baseURL ? { baseURL } : {}),
        },
      },
      { kind: 'export', line: 3, name: 'default', of: 'expression', local: 'client' }),
    ...file('src/api/x.js',
      { kind: 'import', line: 1, source: '../http', specifiers: [{ imported: 'default', local: 'client' }], dynamic: false },
      fn(2, 'go'),
      {
        kind: 'call', line: 3, enclosing: 'go', callee: { shape: 'member', root: 'client', path: ['get'], name: 'get' },
        binding: { kind: 'import', source: '../http', imported: 'default' }, args: [], url: literalUrl('/things/list'),
        method: { value: 'GET', from: 'callee-name' }, platformSink: null,
      }),
  ];
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** The ports a pack listens on, as src/core/server_ports.mjs hands them over. */
const PORTS_8081 = { known: true, ports: [8081], files: ['svc/src/main/resources/application.yml'], why: null };

/** One `fetch` of an absolute address. */
function fetchFacts(address) {
  const u = new URL(address);
  return file('src/a.js', fn(1, 'go'), {
    kind: 'call', line: 2, enclosing: 'go', ...fetchCallee, args: [],
    url: { ...literalUrl(u.pathname), absolute: { host: u.host, path: u.pathname } },
    method: null, platformSink: 'fetch',
  });
}

test('a call to this machine on a port this pack does not listen on is another service\'s: outbound, with both ports', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, fetchFacts('http://localhost:8082/visits/list'), { serverPorts: PORTS_8081 });
  const e = only(g);
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.evidence.target, 'outside-pack');
  assert.equal(g.nodes.get(e.to).outbound, true, 'a route this pack does not serve becomes an outbound node, for federation to cross');
  assert.deepEqual([e.evidence.away.called, e.evidence.away.served], [8082, [8081]]);
  assert.match(e.evidence.away.reason,
    /localhost:8082 is this machine on port 8082, and this pack listens on 8081 \(server\.port in svc\/src\/main\/resources\/application\.yml\)/);
  assert.equal(stats.ports.otherPortCalls, 1);
  assert.equal(stats.unresolved.byReason.outsidePack, 1);
  // A path this pack ALSO serves is still not reached: the port says the
  // request goes to the other service, so the edge is below every floor.
  const same = graphWithRoutes();
  addWebFacts(same, fetchFacts('http://localhost:8082/plain/list'), { serverPorts: PORTS_8081 });
  assert.deepEqual([only(same).grade, only(same).evidence.target], ['UNRESOLVED', 'outside-pack']);
});

test('the same port, ports nobody could read, or no port written leave a call on this machine where it was', () => {
  for (const [address, serverPorts] of [
    ['http://localhost:8081/plain/list', PORTS_8081],
    ['http://127.0.0.1:8081/plain/list', PORTS_8081],
    ['http://localhost:8082/plain/list', { known: false, ports: [], files: [], why: 'x takes the configuration from outside this tree' }],
    ['http://localhost:8082/plain/list', undefined],
    ['http://localhost/plain/list', PORTS_8081],
  ]) {
    const g = graphWithRoutes();
    addWebFacts(g, fetchFacts(address), serverPorts ? { serverPorts } : {});
    const e = only(g);
    assert.equal(e.to, webEndpointId('GET', '/plain/list'), `${address} ${JSON.stringify(serverPorts)}`);
    assert.equal(e.evidence.away, undefined);
  }
});

test('a client whose every build goes to this machine on another port sends every call to that other service', () => {
  const run = (devBase) => {
    const g = graphWithRoutes();
    addWebFacts(g, [
      pkg('vite'),
      env('.env.development', 'BASE', devBase, 'development'),
      env('.env.production', 'BASE', 'https://shop.example.com/api', 'production'),
      ...clientFacts(envRead('import.meta', 'BASE')),
    ], { serverPorts: PORTS_8081 });
    return { g, e: only(g) };
  };
  const away = run('http://localhost:8082/api');
  assert.equal(away.e.grade, 'UNRESOLVED');
  assert.equal(away.e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(away.e.evidence.target, 'outside-pack');
  assert.equal(away.e.evidence.away.called, 8082);
  assert.equal(away.e.evidence.prefix.guess, undefined, 'another service is not a guess about this one');
  // The development build on this pack's own port keeps the client here.
  const here = run('http://localhost:8081/api');
  assert.equal(here.e.grade, 'SOUND_SET');
  assert.equal(here.e.evidence.away, undefined);
});

test('a base URL an environment read puts at the front of a call is placed by its port too', () => {
  const summary = {
    kind: 'fallback', operator: '||', left: envRead('process', 'API'), right: { kind: 'string', value: 'http://localhost:8082/api' },
  };
  const g = graphWithRoutes();
  addWebFacts(g, [
    pkg('react-scripts'),
    ...file('src/settings.js',
      { kind: 'constant', line: 1, name: 'API', exported: true, expr: summary },
      { kind: 'export', line: 1, name: 'API', of: 'const', local: 'API' }),
    ...file('src/a.js',
      { kind: 'import', line: 1, source: './settings', specifiers: [{ imported: 'API', local: 'API' }], dynamic: false },
      fn(2, 'go'),
      {
        kind: 'call', line: 3, enclosing: 'go', ...fetchCallee, args: [],
        url: {
          arg: { kind: 'template', template: '{*}/things/list', dynamicParts: 1 },
          holes: [{ kind: 'import', name: 'API', source: './settings', imported: 'API' }],
          resolved: [{ template: '{*}/things/list', dynamicParts: 1, via: 'template' }],
        },
        method: null, platformSink: 'fetch',
      }),
  ], { serverPorts: PORTS_8081 });
  const e = only(g);
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.evidence.target, 'outside-pack');
  assert.equal(e.evidence.away.called, 8082);
});

// ---------------------------------------------------------------------------
// The global fetch wrapper
// ---------------------------------------------------------------------------

test('a function that hands its request to the GLOBAL fetch is a wrapper, and a call through it is traced', () => {
  // `const request = (options) => fetch(options.url, options)` and
  // `request({ url: '/plain/list', method: 'GET' })`: the global `fetch` binds
  // nothing, so its callee resolves to nothing, and that must not hide the sink.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, file('src/api.js',
    fn(1, 'request', { exported: null, params: 1 }),
    {
      kind: 'call', line: 2, enclosing: 'request', ...fetchCallee, args: [],
      url: { arg: { kind: 'member', root: 'options', path: ['url'] }, resolved: null, unresolved: 'parameter' },
      method: null, platformSink: 'fetch',
    },
    fn(5, 'listThings'),
    {
      kind: 'call', line: 6, enclosing: 'listThings', callee: { shape: 'ident', root: 'request', path: [], name: 'request' },
      binding: { kind: 'local', name: 'request' }, args: [],
      url: literalUrl('/plain/list'), method: { value: 'GET', from: 'config' }, platformSink: null,
    }));
  assert.equal(stats.wrappers.count, 1);
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP' && x.from.endsWith('#listThings'));
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.deepEqual([e.evidence.sink.kind, e.evidence.sink.module, e.evidence.sink.chain], ['wrapper', 'fetch', ['src/api.js#request']]);
  assert.equal(stats.calls.untraced, 0);
});

// ---------------------------------------------------------------------------
// The web axis and the calls it could not trace
// ---------------------------------------------------------------------------

/** One traced call per name in `traced`, one untraced call per name in `lost`. */
function mixedFacts(traced, lost) {
  const recs = [...clientFacts(null)].filter((r) => r.file === 'src/http.js');
  traced.forEach((name, i) => recs.push(...file(`src/api/${name}.js`,
    { kind: 'import', line: 1, source: '../http', specifiers: [{ imported: 'default', local: 'client' }], dynamic: false },
    fn(2, name),
    {
      kind: 'call', line: 3, enclosing: name, callee: { shape: 'member', root: 'client', path: ['get'], name: 'get' },
      binding: { kind: 'import', source: '../http', imported: 'default' }, args: [],
      url: literalUrl(i % 2 === 0 ? '/plain/list' : '/api/things/list'), method: { value: 'GET', from: 'callee-name' }, platformSink: null,
    })));
  lost.forEach((name) => recs.push(...file(`src/lost/${name}.js`, fn(1, name), {
    kind: 'call', line: 2, enclosing: name, callee: { shape: 'member', root: 'api', path: ['get'], name: 'get' },
    binding: null, args: [], url: literalUrl('/plain/list'), method: { value: 'GET', from: 'callee-name' }, platformSink: null,
  })));
  return recs;
}

const axesOf = (stats) => declareAxes({ ddl: false, statements: false, code: true, web: stats }).web;

test('a few untraced calls are a note that rides on the web axis, and the axis stays shipped', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, mixedFacts(['a', 'b'], ['c']));
  assert.deepEqual([stats.calls.withUrl, stats.calls.untraced], [3, 1]);
  assert.deepEqual(stats.untraced.byReason, { unbound: 1 });
  assert.deepEqual(stats.untraced.callees, [{ reason: 'unbound', callee: 'api.get', count: 1 }]);
  const web = axesOf(stats);
  assert.equal(web.status, 'shipped');
  assert.deepEqual(web.notes, [
    '1 of 3 frontend call site(s) were traced to no client, so each of their edges is HEURISTIC at best; '
      + 'most often because the function called is bound to nothing this lane follows (an object of functions, a parameter, a global) (1 call(s), e.g. api.get)',
  ]);
});

test('as many untraced calls as traced ones degrade the web axis, and the reason states the rule', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, mixedFacts(['a'], ['b']));
  const web = axesOf(stats);
  assert.equal(web.status, 'degraded');
  assert.match(web.reason, /1 of 2 call site\(s\) were traced to no client, at least as many as were traced, and the axis is degraded whenever untraced calls are at least as many as traced ones/);
  assert.equal(web.notes.length, 1);
  // Every call traced: no note at all.
  const clean = graphWithRoutes();
  const cleanWeb = axesOf(addWebFacts(clean, mixedFacts(['a', 'b'], [])));
  assert.equal(cleanWeb.status, 'shipped');
  assert.equal(cleanWeb.notes, undefined);
});
