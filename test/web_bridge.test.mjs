import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import {
  addWebFacts, webSymbolId, webEndpointId, routeMatches, httpClientPack, STRING_METHODS,
  WEB_CALL_BASIS,
} from '../src/adapters/web_bridge.mjs';

// The web bridge, driven by HAND-WRITTEN facts, in the style of
// java_bridge.test.mjs: the worker has its own spawned test (webfacts.test.mjs),
// so what is under test here is the DECISION each rule makes, stated one rule at
// a time, with the grade and the evidence asserted rather than a count.
//
// Every fixture invents its own names. The engine must not have been written
// against one project's spelling, and neither must its tests.

// ---------------------------------------------------------------------------
// A graph with routes on it, because the bridge attaches calls to routes the
// Java bridge already put there.
// ---------------------------------------------------------------------------

const ROUTES = [
  ['GET', '/api/things/list'],
  ['POST', '/api/things/save'],
  ['GET', '/api/things/{id}'],
  ['GET', '/api/files/{key:.+}'],
  ['GET', '/api/deep/**'],
  ['ANY', '/api/any/thing'],
  ['GET', '/plain/list'],
  ['POST', '/plain/list'],
];

function graphWithRoutes(routes = ROUTES) {
  const g = new Graph();
  for (const [httpMethod, path] of routes) {
    const id = webEndpointId(httpMethod, path);
    g.addNode({ id, path, httpMethod, handler: 'com.x.C#m' });
    g.addEdge({ from: id, to: 'symbol:com.x.C#m', type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

/** The records for one parsed file: a `file` record plus whatever is given. */
function file(name, ...records) {
  return [{ kind: 'file', file: name, line: 1, lang: name.endsWith('.ts') ? 'ts' : 'js', recoveredErrors: 0 },
    ...records.map((r) => ({ file: name, ...r }))];
}

const imp = (line, source, specifiers) => ({ kind: 'import', line, source, specifiers, dynamic: false });
const exp = (line, name, of, extra = {}) => ({ kind: 'export', line, name, of, ...extra });
const fn = (line, name, extra = {}) => ({
  kind: 'function', line, name, endLine: line + 2, exported: 'named', async: false, params: 1, returns: null, ...extra,
});
const binding = (line, name, init, exported = true) => ({ kind: 'binding', line, name, exported, init });
const axiosCreate = (baseURL) => ({
  shape: 'call',
  callee: { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
  binding: { kind: 'import', source: 'axios', imported: 'default' },
  ...(baseURL ? { baseURL } : {}),
});
const call = (line, enclosing, callee, bindingRec, url, method, extra = {}) => ({
  kind: 'call', line, enclosing, callee, binding: bindingRec, args: [], url, method, platformSink: null, ...extra,
});
const memberCallee = (root, name) => ({ shape: 'member', root, path: [name], name });
const literalUrl = (t) => ({ arg: { kind: 'string', value: t }, resolved: [{ template: t, dynamicParts: 0, via: 'literal' }] });
const cfg = (f, rec) => ({ kind: 'config', file: f, line: 1, ...rec });

/** The client every fixture below imports: `axios.create` in `src/http.js`. */
const clientFile = (baseURL) => file('src/http.js',
  imp(1, 'axios', [{ imported: 'default', local: 'axios' }]),
  binding(2, 'client', axiosCreate(baseURL)),
  exp(3, 'default', 'expression', { local: 'client' }));

const edgesOf = (g) => g.edges.filter((e) => e.type === 'CALLS_HTTP');
const only = (g) => {
  const e = edgesOf(g);
  assert.equal(e.length, 1, `expected exactly one CALLS_HTTP edge, got ${e.length}: ${JSON.stringify(e, null, 1)}`);
  return e[0];
};

// ---------------------------------------------------------------------------
// The declaration pack (B3)
// ---------------------------------------------------------------------------

test('the http-client pack is a DECLARATION: platform sinks and libraries, not rules', () => {
  const p = httpClientPack();
  assert.equal(p.pack, 'http-clients');
  assert.deepEqual(p.platform.map((x) => x.name).sort(), ['fetch', 'jquery', 'xhr']);
  // jQuery is a GLOBAL sink (RM48): the page loads it with a script tag, so the
  // pack names the identifiers it lands on rather than a module to import.
  const jq = p.platform.find((x) => x.name === 'jquery');
  assert.deepEqual(jq.globals, ['$', 'jQuery']);
  assert.deepEqual(jq.config.methods, ['ajax']);
  assert.equal(jq.verbs.getJSON, 'GET');
  assert.equal(jq.defaultMethod, 'GET');
  const modules = p.libraries.map((l) => l.module).sort();
  assert.deepEqual(modules, ['axios', 'ky', 'superagent']);
  const axios = p.libraries.find((l) => l.module === 'axios');
  assert.deepEqual(axios.instanceFactories, ['create']);
  assert.equal(axios.verbs.get, 'GET');
  assert.equal(axios.defaultMethod, 'GET');
});

// ---------------------------------------------------------------------------
// B6: route matching, as a function
// ---------------------------------------------------------------------------

test('routeMatches: a route hole takes one segment, `**` takes the rest', () => {
  assert.equal(routeMatches('/a/{id}/b', '/a/7/b'), true);
  assert.equal(routeMatches('/a/{id}/b', '/a/7/8/b'), false);
  assert.equal(routeMatches('/a/{key:.+}', '/a/x.png'), true);
  assert.equal(routeMatches('/a/*', '/a/x'), true);
  assert.equal(routeMatches('/a/**', '/a/b/c/d'), true);
  assert.equal(routeMatches('/a/b', '/a/b/c'), false);
});

test('routeMatches: a CALL hole takes one whole segment, or the rest of its own', () => {
  assert.equal(routeMatches('/a/list', '/a/{*}'), true);
  assert.equal(routeMatches('/a/list', '/a/li{*}'), true);
  assert.equal(routeMatches('/a/list', '/a/x{*}'), false);
  assert.equal(routeMatches('/a/{id}', '/a/{*}'), true);
  assert.equal(routeMatches('/a/b/c', '/a/{*}'), false);
});

// ---------------------------------------------------------------------------
// B4/B7: a library call is SOUND_SET, and the edge says what it rested on
// ---------------------------------------------------------------------------

test('a call through an axios instance reaches the route, SOUND_SET, with the sink named', () => {
  const g = graphWithRoutes();
  const facts = [
    // A relative base URL is only DERIVED when a dev-proxy rule explains it;
    // with nothing to explain it the prefix is a guess (see the auto test).
    cfg('vue.config.js', { what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null }),
    ...clientFile({ kind: 'string', value: '/api' }),
    ...file('src/api/things.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      exp(2, 'listThings', 'function', { local: 'listThings' }),
      fn(2, 'listThings'),
      call(3, 'listThings', memberCallee('client', 'get'),
        { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' })),
  ];
  const stats = addWebFacts(g, facts);
  const e = only(g);
  assert.equal(e.from, webSymbolId('src/api/things.js', 'listThings'));
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.rule, 'web-http-call');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.library);
  assert.deepEqual(e.evidence.sink, {
    kind: 'library', module: 'axios', instance: 'src/http.js#client', chain: [], depth: 0,
  });
  assert.deepEqual(e.evidence.url, { written: '/things/list', template: '/api/things/list', via: 'literal' });
  assert.deepEqual(e.evidence.method, { value: 'GET', from: 'callee-name' });
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'derived' });
  assert.equal(e.evidence.match, 'exact');
  assert.equal(e.evidence.target, 'in-pack');

  // The caller is a node with its file, its line and the lane it came from.
  const n = g.nodes.get(e.from);
  assert.deepEqual(
    { symbol: n.symbol, file: n.file, line: n.line, lane: n.lane, exported: n.exported },
    { symbol: 'src/api/things.js#listThings', file: 'src/api/things.js', line: 2, lane: 'web', exported: 'named' },
  );
  assert.equal(stats.instances, 1);
  assert.deepEqual(stats.resolved, { SOUND_SET: 1, HEURISTIC: 0 });
  assert.deepEqual(stats.matches, { exact: 1, template: 0, multi: 0 });
});

test('the method decides which route answers: the same path with two verbs is two routes', () => {
  const mk = (method) => {
    const g = graphWithRoutes();
    addWebFacts(g, [
      ...clientFile(null),
      ...file('src/api/x.js',
        imp(1, '../http', [{ imported: 'default', local: 'client' }]),
        fn(2, 'go'),
        call(3, 'go', memberCallee('client', method.toLowerCase()),
          { kind: 'import', source: '../http', imported: 'default' },
          literalUrl('/plain/list'), { value: method, from: 'callee-name' })),
    ]);
    return only(g).to;
  };
  assert.equal(mk('GET'), webEndpointId('GET', '/plain/list'));
  assert.equal(mk('POST'), webEndpointId('POST', '/plain/list'));
});

test('an ANY route answers whatever method the call sends', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('client', 'put'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/api/any/thing'), { value: 'PUT', from: 'callee-name' })),
  ]);
  assert.equal(only(g).to, webEndpointId('ANY', '/api/any/thing'));
});

test('a template URL matches a route template, and the match says `template`', () => {
  // Only the `{id}` route here: `/api/things/{*}` would otherwise ALSO match
  // `/api/things/list`, which is a real ambiguity and has its own test below.
  const g = graphWithRoutes([['GET', '/api/things/{id}']]);
  addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'detail'),
      call(3, 'detail', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        { arg: { kind: 'template', template: '/api/things/{*}', dynamicParts: 1 }, resolved: [{ template: '/api/things/{*}', dynamicParts: 1, via: 'template' }] },
        { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/api/things/{id}'));
  assert.equal(e.evidence.match, 'template');
  assert.equal(e.grade, 'SOUND_SET');
});

test('a `{key:.+}` route and a `**` route are both reachable', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'a'), fn(5, 'b'),
      call(3, 'a', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/api/files/pic.png'), { value: 'GET', from: 'callee-name' }),
      call(6, 'b', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/api/deep/one/two/three'), { value: 'GET', from: 'callee-name' })),
  ]);
  const to = edgesOf(g).map((e) => e.to).sort();
  assert.deepEqual(to, [webEndpointId('GET', '/api/deep/**'), webEndpointId('GET', '/api/files/{key:.+}')].sort());
});

// ---------------------------------------------------------------------------
// B4: the platform sinks
// ---------------------------------------------------------------------------

test('fetch and XMLHttpRequest are sinks by contract, and the basis says so', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('src/plain.js',
      fn(1, 'ping'),
      call(2, 'ping', { shape: 'ident', root: 'fetch', path: [], name: 'fetch' }, { kind: 'global', name: 'fetch' },
        literalUrl('/plain/list'), { value: 'POST', from: 'positional' }, { platformSink: 'fetch' })),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('POST', '/plain/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.platform);
  assert.deepEqual(e.evidence.sink, { kind: 'platform', module: 'fetch', instance: null, chain: [], depth: 0 });
  // No client, no base URL, and that is not a guess: what the browser sends is
  // the path as written.
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'derived' });
});

// ---------------------------------------------------------------------------
// B4: wrappers, including the class chain
// ---------------------------------------------------------------------------

/**
 * The shape jeecg-style frontends are written in, with invented names: a class
 * whose constructor puts `axios.create(...)` on a field, verb methods that
 * forward to one generic method, a factory that hands out an instance of the
 * class, and a module-level constant holding what the factory returned.
 */
function classClientFacts() {
  return [
    // The dev proxy that explains the class's base URL, so the prefix is READ
    // rather than guessed and the grade below is about the chain, not the prefix.
    cfg('vue.config.js', { what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null }),
    ...file('src/utils/client.ts',
      imp(1, 'axios', [{ imported: 'default', local: 'axios' }]),
      { kind: 'class', line: 3, name: 'Wrapped', exported: 'named', methods: ['constructor', 'get', 'request'], fields: ['inner'] },
      exp(3, 'Wrapped', 'class', { local: 'Wrapped' }),
      fn(4, 'Wrapped.constructor'),
      { kind: 'assign', line: 5, class: 'Wrapped', field: 'inner', init: axiosCreate({ kind: 'string', value: '/api' }) },
      call(5, 'Wrapped.constructor', { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
        { kind: 'import', source: 'axios', imported: 'default' }, null, null),
      fn(7, 'Wrapped.get', {
        returns: {
          shape: 'call',
          callee: { shape: 'member', root: 'this', path: ['request'], name: 'request' },
          binding: { kind: 'this', class: 'Wrapped' },
        },
      }),
      call(8, 'Wrapped.get', { shape: 'member', root: 'this', path: ['request'], name: 'request' },
        { kind: 'this', class: 'Wrapped' }, null, { value: 'GET', from: 'config' }),
      fn(10, 'Wrapped.request'),
      call(11, 'Wrapped.request', { shape: 'member', root: 'this', path: ['inner', 'request'], name: 'request' },
        { kind: 'this', class: 'Wrapped' }, null, null)),
    ...file('src/utils/factory.ts',
      imp(1, './client', [{ imported: 'Wrapped', local: 'Wrapped' }]),
      exp(3, 'make', 'function', { local: 'make' }),
      fn(3, 'make', {
        returns: {
          shape: 'new',
          callee: { shape: 'ident', root: 'Wrapped', path: [], name: 'Wrapped' },
          binding: { kind: 'import', source: './client', imported: 'Wrapped' },
        },
      }),
      binding(6, 'api', { shape: 'call', callee: { shape: 'ident', root: 'make', path: [], name: 'make' }, binding: { kind: 'local', name: 'make' } }),
      exp(6, 'api', 'const', { local: 'api' })),
  ];
}

test('a class wrapper chain resolves to axios.create, and the chain and depth are on the edge', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...classClientFacts(),
    ...file('src/api/things.ts',
      imp(1, './../utils/factory', [{ imported: 'api', local: 'api' }]),
      exp(2, 'listThings', 'function', { local: 'listThings' }),
      fn(2, 'listThings'),
      call(3, 'listThings', memberCallee('api', 'get'), { kind: 'import', source: './../utils/factory', imported: 'api' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.wrapper);
  assert.deepEqual(e.evidence.sink, {
    kind: 'wrapper',
    module: 'axios',
    instance: 'src/utils/client.ts#Wrapped.inner',
    // Deepest first: the generic method that touches the library, then the verb
    // method the caller actually named.
    chain: ['src/utils/client.ts#Wrapped.request', 'src/utils/client.ts#Wrapped.get'],
    depth: 2,
  });
  // The verb came from the wrapper, not from the call: `Wrapped.get` is what
  // sets `method: 'GET'` on the config it forwards.
  assert.deepEqual(e.evidence.method, { value: 'GET', from: 'wrapper-verb' });
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'derived' });
  assert.equal(stats.wrappers.count, 2);
  assert.equal(stats.wrappers.maxDepth, 2);
  assert.deepEqual(stats.wrappers.byKind, { function: 0, classMethod: 2 });
  // A wrapper is plumbing: it gets no node of its own and no edge.
  assert.equal(g.nodes.has(webSymbolId('src/utils/client.ts', 'Wrapped.get')), false);
});

test('a call through an `export *` barrel resolves, and so does the client behind it', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...classClientFacts(),
    ...file('src/utils/all.ts', exp(1, '*', 'reexport', { source: './factory' })),
    ...file('src/api/things.ts',
      imp(1, './../utils/all', [{ imported: 'api', local: 'api' }]),
      fn(2, 'listThings'),
      call(3, 'listThings', memberCallee('api', 'get'), { kind: 'import', source: './../utils/all', imported: 'api' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.sink.kind, 'wrapper');
});

test('a FUNCTION wrapper that forwards what it was given is a wrapper; one that spells the URL out is not', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...clientFile(null),
    ...file('src/utils/send.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      exp(2, 'send', 'function', { local: 'send' }),
      fn(2, 'send'),
      // Forwards what it was given, so it is a WRAPPER. The worker records no
      // url on it at all: `request` is not a verb, and an identifier argument
      // is not shown to be a URL by anything in this file.
      call(3, 'send', memberCallee('client', 'request'), { kind: 'import', source: '../http', imported: 'default' },
        null, null)),
    ...file('src/api/x.js',
      imp(1, './../utils/send', [{ imported: 'send', local: 'send' }]),
      fn(2, 'listThings'),
      call(3, 'listThings', { shape: 'ident', root: 'send', path: [], name: 'send' },
        { kind: 'import', source: './../utils/send', imported: 'send' },
        literalUrl('/plain/list'), null)),
  ]);
  const e = only(g);
  assert.equal(e.from, webSymbolId('src/api/x.js', 'listThings'));
  assert.equal(e.evidence.sink.kind, 'wrapper');
  assert.deepEqual(e.evidence.sink.chain, ['src/utils/send.js#send']);
  assert.equal(e.evidence.sink.depth, 1);
  // No verb anywhere, so the LIBRARY's own default is what this sends, said as such.
  assert.deepEqual(e.evidence.method, { value: 'GET', from: 'library-default' });
  assert.equal(e.grade, 'SOUND_SET');
  assert.deepEqual(stats.wrappers.byKind, { function: 1, classMethod: 0 });
  // The wrapper's own call carried no URL of its own, so it is not counted as a
  // call site with a URL and produced no edge.
  assert.equal(stats.calls.withUrl, 1);
});

test('an untraced call is HEURISTIC, and the basis says a rule guessed', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...file('src/api/x.js',
      imp(1, 'some-other-lib', [{ imported: 'helper', local: 'helper' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('helper', 'post'), { kind: 'import', source: 'some-other-lib', imported: 'helper' },
        literalUrl('/plain/list'), { value: 'POST', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.untraced);
  assert.deepEqual(e.evidence.sink, { kind: 'untraced', module: 'some-other-lib', instance: null, chain: [], depth: 0 });
  assert.equal(stats.calls.untraced, 1);
});

test('a verb-named call on something that is not a client, with an argument that is not a path, is not a call at all', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...file('src/store.js',
      imp(1, 'some-cookie-lib', [{ imported: 'Jar', local: 'Jar' }]),
      fn(2, 'readSize'),
      call(3, 'readSize', memberCallee('Jar', 'get'), { kind: 'import', source: 'some-cookie-lib', imported: 'Jar' },
        { arg: { kind: 'string', value: 'size' }, resolved: [{ template: 'size', dynamicParts: 0, via: 'literal' }] },
        { value: 'GET', from: 'callee-name' })),
  ]);
  assert.deepEqual(edgesOf(g), []);
  assert.equal(stats.calls.notUrlShaped, 1);
  assert.equal(stats.calls.withUrl, 0);
});

// ---------------------------------------------------------------------------
// B5: the prefix
// ---------------------------------------------------------------------------

/** One call of one instance, so a prefix rule can be read off the edge. */
function withPrefixFacts(baseURL, configs, url = '/things/list') {
  return [
    ...configs,
    ...clientFile(baseURL),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl(url), { value: 'GET', from: 'callee-name' })),
  ];
}

test('prefix DERIVED: a dev-proxy rule with a rewrite strips the base URL', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'process', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/dev-api', mode: 'development' }),
      cfg('vite.config.ts', { what: 'proxy', context: '/dev-api', target: 'http://localhost:8080', rewrite: [{ from: '^/dev-api', to: '' }] })],
    '/plain/list',
  ));
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'derived' });
  assert.equal(e.grade, 'SOUND_SET');
  assert.deepEqual(stats.prefix[''].instances.find((i) => i.id === 'src/http.js#client'),
    { id: 'src/http.js#client', value: '', from: 'derived', front: '/dev-api', candidates: [] });
});

test('prefix DERIVED: a proxy rule with NO rewrite keeps the base URL', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'process', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/api', mode: 'development' }),
      cfg('vue.config.js', { what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null })],
  ));
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'derived' });
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
});

test('prefix DERIVED: an absolute base URL contributes only its path', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts({ kind: 'string', value: 'http://localhost:8080' }, [], '/plain/list'));
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'derived' });
  assert.equal(e.grade, 'SOUND_SET');
});

test('prefix DERIVED: modes that spell the same path differently still agree', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'process', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/api', mode: 'development' }),
      cfg('.env.production', { what: 'env', name: 'BASE', value: 'https://www.example.com/api', mode: 'production' }),
      cfg('vue.config.js', { what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null })],
  ));
  assert.deepEqual(only(g).evidence.prefix, { value: '/api', from: 'derived' });
});

test('prefix DERIVED: modes that really disagree are settled by the one a proxy rule explains', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'import.meta', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/dev-api', mode: 'development' }),
      cfg('.env.production', { what: 'env', name: 'BASE', value: '/prod-api', mode: 'production' }),
      cfg('.env.staging', { what: 'env', name: 'BASE', value: '/stage-api', mode: 'staging' }),
      cfg('vite.config.ts', { what: 'proxy', context: '/dev-api', target: 'http://localhost:8080', rewrite: [{ from: '^/dev-api', to: '' }] })],
    '/plain/list',
  ));
  assert.deepEqual(only(g).evidence.prefix, { value: '', from: 'derived' });
});

test('prefix AUTO: modes that disagree with nothing to settle them are chosen by match count, and the counts are recorded', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    cfg('.env.development', { what: 'env', name: 'BASE', value: '/api', mode: 'development' }),
    cfg('.env.production', { what: 'env', name: 'BASE', value: '/other', mode: 'production' }),
    ...clientFile({ kind: 'member', root: 'process', path: ['env', 'BASE'] }),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'a'), fn(5, 'b'),
      call(3, 'a', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' }),
      call(6, 'b', memberCallee('client', 'post'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/things/save'), { value: 'POST', from: 'callee-name' })),
  ]);
  const e = edgesOf(g);
  assert.equal(e.length, 2);
  for (const one2 of e) {
    assert.equal(one2.evidence.prefix.from, 'auto');
    assert.equal(one2.evidence.prefix.value, '/api');
    // Every candidate that was tried, with how many routes it hit: the reader
    // sees WHY this one won rather than being asked to trust it.
    // Most exact hits first; a tie goes to the LONGER prefix, then to the name,
    // so two runs over the same pack list them in the same order.
    assert.deepEqual(one2.evidence.prefix.candidates, [
      { value: '/api', exact: 2, template: 0 },
      { value: '/other', exact: 0, template: 0 },
      { value: '', exact: 0, template: 0 },
    ]);
    // A prefix nobody stated is a guess, so the edge is HEURISTIC however good
    // the match was.
    assert.equal(one2.grade, 'HEURISTIC');
  }
  assert.deepEqual(stats.resolved, { SOUND_SET: 0, HEURISTIC: 2 });
});

test('prefix NONE: when no candidate matches anything, the URL is used as written', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    cfg('.env.development', { what: 'env', name: 'BASE', value: '/api', mode: 'development' }),
    cfg('.env.production', { what: 'env', name: 'BASE', value: '/other', mode: 'production' }),
    ...clientFile({ kind: 'member', root: 'process', path: ['env', 'BASE'] }),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'a'),
      call(3, 'a', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        literalUrl('/nothing/here'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.evidence.prefix.from, 'none');
  assert.equal(e.evidence.prefix.value, '');
});

test('prefix DECLARED beats derived, and the profile is the only place it is read', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'process', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/admin', mode: 'development' }),
      cfg('vue.config.js', { what: 'proxy', context: '/admin', target: 'http://localhost:8080', rewrite: null })],
  ), { gatewayRoutes: { '/admin': '/api' } });
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'declared' });
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'SOUND_SET');
});

test('a declared `*` applies to every call, whatever the client says', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(null, []), { gatewayRoutes: { '*': '/api' } });
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'declared' });
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
});

test('a declared key rewrites the CALL when the prefix is already on the URL', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(null, [], '/dev-api/plain/list'), { gatewayRoutes: { '/dev-api': '' } });
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'declared' });
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
});

test('a discovered route rewrites a call that carries the prefix itself, and names the service (RM46)', () => {
  // The shape a gateway's own frontend has: no base URL anywhere, the gateway
  // prefix written into every call, and a route table that says which service
  // answers it. This is `cascade init`'s object value, read by both bridges.
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(null, [], '/api/thing/plain/list'), {
    gatewayRoutes: {
      '/api/thing': { to: '', service: 'thing-service', from: 'src/main/resources/application.yml' },
    },
  });
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'declared' });
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.evidence.service, 'thing-service');
  assert.equal(e.evidence.serviceLiteral, true);
});

test('the longest declared key wins, and a route with no service names none', () => {
  const g = graphWithRoutes();
  addWebFacts(g, withPrefixFacts(null, [], '/api/thing/plain/list'), {
    gatewayRoutes: {
      '/api': { to: '/wrong', service: 'other-service', from: 'a.yml' },
      '/api/thing': { to: '', service: 'thing-service', from: 'a.yml' },
    },
  });
  assert.equal(only(g).evidence.service, 'thing-service');

  const plain = graphWithRoutes();
  addWebFacts(plain, withPrefixFacts(null, [], '/dev-api/plain/list'), { gatewayRoutes: { '/dev-api': '' } });
  const e = only(plain);
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.evidence.service, undefined, 'a string value names no service, and an absent field is not a null one');
});

test('a route on the client BASE URL carries its service too, and the census records it', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, withPrefixFacts(
    { kind: 'member', root: 'process', path: ['env', 'BASE'] },
    [cfg('.env.development', { what: 'env', name: 'BASE', value: '/api/thing', mode: 'development' })],
  ), {
    gatewayRoutes: { '/api/thing': { to: '', service: 'thing-service', from: 'a.yml' } },
  });
  const e = only(g);
  assert.deepEqual(e.evidence.prefix, { value: '', from: 'declared' });
  assert.equal(e.to, webEndpointId('GET', '/things/list'));
  assert.equal(e.evidence.service, 'thing-service');
  const instance = stats.prefix[''].instances.find((i) => i.id === 'src/http.js#client');
  assert.equal(instance.service, 'thing-service');
});

// ---------------------------------------------------------------------------
// B2: module resolution and the assumed alias
// ---------------------------------------------------------------------------

test('an alias resolves the client, and an ASSUMED alias lowers every edge through it to HEURISTIC', () => {
  const make = (assumed) => {
    const g = graphWithRoutes();
    const stats = addWebFacts(g, [
      cfg('package.json', { what: 'alias', from: '@', to: 'src', ...(assumed ? { assumed: true } : {}) }),
      ...clientFile(null),
      ...file('src/api/x.js',
        imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
        fn(2, 'go'),
        call(3, 'go', memberCallee('client', 'get'), { kind: 'import', source: '@/http', imported: 'default' },
          literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' })),
    ]);
    return { e: only(g), stats };
  };
  const declared = make(false);
  assert.equal(declared.e.grade, 'SOUND_SET');
  assert.equal(declared.e.evidence.sink.kind, 'library');
  assert.equal(declared.e.evidence.alias, undefined);
  assert.equal(declared.stats.assumedAliases, 0);

  const assumed = make(true);
  assert.equal(assumed.e.grade, 'HEURISTIC', 'an alias this engine assumed is a guess on the path to the client');
  assert.equal(assumed.e.evidence.alias, 'assumed');
  assert.equal(assumed.e.evidence.sink.kind, 'library');
  assert.equal(assumed.stats.assumedAliases, 1);
});

test('a specifier resolving to a file the lane never parsed leaves the call untraced', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('src/api/x.js',
      imp(1, './nowhere', [{ imported: 'default', local: 'client' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('client', 'get'), { kind: 'import', source: './nowhere', imported: 'default' },
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(e.evidence.sink.kind, 'untraced');
});

test('`export { x as y }` is followed to what x really is', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('src/http.js',
      imp(1, 'axios', [{ imported: 'default', local: 'axios' }]),
      binding(2, 'inner', axiosCreate(null), false),
      exp(3, 'sender', 'const', { local: 'inner' })),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'sender', local: 'sender' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('sender', 'get'), { kind: 'import', source: '../http', imported: 'sender' },
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.sink.instance, 'src/http.js#inner');
});

test('the library module used directly (`axios.get`) is a sink too', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('src/api/x.js',
      imp(1, 'axios', [{ imported: 'default', local: 'axios' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('axios', 'get'), { kind: 'import', source: 'axios', imported: 'default' },
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.sink.kind, 'library');
  assert.equal(e.evidence.sink.module, 'axios');
});

// ---------------------------------------------------------------------------
// B6: what does not match
// ---------------------------------------------------------------------------

test('a URL nothing here serves becomes an outbound endpoint node and an UNRESOLVED edge', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, withPrefixFacts(null, [], '/somewhere/else'));
  const e = only(g);
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.to, webEndpointId('GET', '/somewhere/else'));
  const n = g.nodes.get(e.to);
  assert.deepEqual(
    { path: n.path, httpMethod: n.httpMethod, outbound: n.outbound, source: n.source },
    { path: '/somewhere/else', httpMethod: 'GET', outbound: true, source: 'web' },
  );
  assert.equal(e.evidence.target, 'outside-pack');
  assert.equal(e.evidence.match, null);
  assert.equal(stats.outboundEndpoints, 1);
  assert.equal(stats.unresolved.total, 1);
  assert.equal(stats.unresolved.byReason.noMatch, 1);
  assert.deepEqual(stats.unmatchedUrls, [{ url: 'GET /somewhere/else', count: 1 }]);
});

test('an absolute URL to another host is outside-pack, and the host rides on the evidence', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        {
          arg: { kind: 'string', value: 'https://elsewhere.example.com/plain/list' },
          resolved: [{ template: '/plain/list', dynamicParts: 0, via: 'literal' }],
          absolute: { host: 'elsewhere.example.com', path: '/plain/list' },
        },
        { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.evidence.url.host, 'elsewhere.example.com');
  assert.equal(stats.unresolved.byReason.outsidePack, 1);
  assert.equal(stats.unresolved.byReason.noMatch, 0);
});

test('a URL that never resolved gets NO edge, and is counted by the reason the worker gave', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'a'), fn(5, 'b'), fn(8, 'c'),
      call(3, 'a', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        { arg: { kind: 'ident', name: 'url' }, resolved: null, unresolved: 'parameter' }, null),
      call(6, 'b', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        { arg: { kind: 'other' }, resolved: null, unresolved: 'expression' }, null),
      call(9, 'c', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        { arg: { kind: 'member', root: 'Urls', path: ['x'] }, resolved: null, unresolved: 'imported-constant' }, null)),
  ]);
  assert.deepEqual(edgesOf(g), []);
  assert.equal(stats.unresolved.total, 3);
  assert.deepEqual(stats.unresolved.byReason,
    { parameter: 1, expression: 1, importedConstant: 1, noMatch: 0, outsidePack: 0, allHoles: 0 });
});

test('a URL that is nothing but interpolation names no route, and is counted as such', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'a'),
      call(3, 'a', memberCallee('client', 'get'), { kind: 'import', source: '../http', imported: 'default' },
        { arg: { kind: 'template', template: '/{*}/{*}', dynamicParts: 2 }, resolved: [{ template: '/{*}/{*}', dynamicParts: 2, via: 'template' }] },
        { value: 'GET', from: 'callee-name' })),
  ]);
  assert.deepEqual(edgesOf(g), [], 'a template with no literal segment matches every route of that length');
  assert.equal(stats.unresolved.byReason.allHoles, 1);
});

test('a URL matching several routes gets an edge each, and every one says how many', () => {
  const g = graphWithRoutes([['GET', '/api/a/{id}'], ['GET', '/api/{kind}/7'], ['GET', '/api/a/7']]);
  const stats = addWebFacts(g, withPrefixFacts(null, [], '/api/{*}/7'));
  const e = edgesOf(g).sort((a, b) => (a.to < b.to ? -1 : 1));
  assert.equal(e.length, 3, JSON.stringify(e.map((x) => x.to)));
  assert.deepEqual(e.map((x) => x.to), [
    webEndpointId('GET', '/api/a/7'), webEndpointId('GET', '/api/a/{id}'), webEndpointId('GET', '/api/{kind}/7'),
  ]);
  for (const one2 of e) {
    assert.equal(one2.evidence.candidates, 3);
    assert.equal(one2.grade, 'SOUND_SET', 'several candidates is at most SOUND_SET, never lower for being several');
  }
  // The CALL is counted once, at the grade it reached. Counting the edges would
  // make "calls resolved" bigger than "calls".
  assert.deepEqual(stats.resolved, { SOUND_SET: 1, HEURISTIC: 0 });
  assert.equal(stats.matches.multi, 1);
});

test('a ternary URL is two possible requests from one call site, so it makes two edges', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...clientFile(null),
    ...file('src/api/x.js',
      imp(1, '../http', [{ imported: 'default', local: 'client' }]),
      fn(2, 'save'),
      call(3, 'save', memberCallee('client', 'post'), { kind: 'import', source: '../http', imported: 'default' },
        {
          arg: { kind: 'ident', name: 'url' },
          resolved: [
            { template: '/plain/list', dynamicParts: 0, via: 'ternary' },
            { template: '/somewhere/else', dynamicParts: 0, via: 'ternary' },
          ],
        },
        { value: 'POST', from: 'callee-name' })),
  ]);
  const e = edgesOf(g).sort((a, b) => (a.to < b.to ? -1 : 1));
  assert.equal(e.length, 2);
  assert.equal(e[0].to, webEndpointId('POST', '/plain/list'));
  assert.equal(e[0].grade, 'SOUND_SET');
  assert.equal(e[1].to, webEndpointId('POST', '/somewhere/else'));
  assert.equal(e[1].grade, 'UNRESOLVED');
  // One call site, counted once, at the grade the candidates that matched reached.
  assert.equal(stats.calls.withUrl, 1);
  assert.deepEqual(stats.resolved, { SOUND_SET: 1, HEURISTIC: 0 });
});

test('a call with no method at all matches by path, and is HEURISTIC for it', () => {
  const g = graphWithRoutes([['POST', '/plain/list']]);
  const facts = [
    ...file('src/api/x.js',
      imp(1, 'some-other-lib', [{ imported: 'send', local: 'send' }]),
      fn(2, 'go'),
      call(3, 'go', memberCallee('send', 'to'), { kind: 'import', source: 'some-other-lib', imported: 'send' },
        literalUrl('/plain/list'), null)),
  ];
  const g2 = graphWithRoutes([['POST', '/plain/list']]);
  addWebFacts(g2, facts);
  const e = only(g2);
  assert.equal(e.to, webEndpointId('POST', '/plain/list'));
  assert.equal(e.grade, 'HEURISTIC');
  assert.deepEqual(e.evidence.method, { value: null, from: 'absent' });
  void g;
});

// ---------------------------------------------------------------------------
// Determinism (SPEC §2.1)
// ---------------------------------------------------------------------------

test('the same facts in reverse order build the same edges, with the same evidence', () => {
  const facts = [
    cfg('.env.development', { what: 'env', name: 'BASE', value: '/api', mode: 'development' }),
    cfg('vue.config.js', { what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null }),
    ...classClientFacts(),
    ...file('src/utils/all.ts', exp(1, '*', 'reexport', { source: './factory' })),
    ...file('src/api/things.ts',
      imp(1, './../utils/all', [{ imported: 'api', local: 'api' }]),
      fn(2, 'listThings'), fn(5, 'saveThing'), fn(8, 'detail'),
      call(3, 'listThings', memberCallee('api', 'get'), { kind: 'import', source: './../utils/all', imported: 'api' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' }),
      call(6, 'saveThing', memberCallee('api', 'post'), { kind: 'import', source: './../utils/all', imported: 'api' },
        literalUrl('/things/save'), { value: 'POST', from: 'callee-name' }),
      call(9, 'detail', memberCallee('api', 'get'), { kind: 'import', source: './../utils/all', imported: 'api' },
        literalUrl('/nowhere/at/all'), { value: 'GET', from: 'callee-name' })),
  ];
  const forward = graphWithRoutes();
  const statsA = addWebFacts(forward, facts);
  const backward = graphWithRoutes();
  const statsB = addWebFacts(backward, facts.slice().reverse());

  const shape = (g) => edgesOf(g).map((e) => ({
    from: e.from, to: e.to, grade: e.grade, evidence: e.evidence,
  }));
  assert.deepEqual(shape(backward), shape(forward));
  assert.deepEqual(statsB, statsA);
  assert.ok(shape(forward).length >= 3, JSON.stringify(shape(forward)));
});

test('the bridge is additive: it never touches the routes it was handed', () => {
  const before = graphWithRoutes();
  const after = graphWithRoutes();
  addWebFacts(after, withPrefixFacts(null, [], '/plain/list'));
  for (const [id, n] of before.nodes) {
    assert.deepEqual(after.nodes.get(id), n, `${id} was changed by the web bridge`);
  }
  assert.equal(after.edges.filter((e) => e.type === 'HANDLES').length, before.edges.filter((e) => e.type === 'HANDLES').length);
});

test('an empty fact stream is a legal run that says nothing happened', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, []);
  assert.deepEqual(edgesOf(g), []);
  assert.deepEqual(stats.calls, {
    withUrl: 0, traced: 0, platform: 0, injected: 0, untraced: 0, notUrlShaped: 0,
    stringMethod: 0, template: 0,
    nexacro: 0, nexacroUnreadable: 0, notAFunction: 0, passedAsValue: 0,
  });
  assert.deepEqual(stats.resolved, { SOUND_SET: 0, HEURISTIC: 0 });
  assert.equal(stats.instances, 0);
  assert.deepEqual(stats.prefix, {});
  assert.deepEqual(stats.functions, { withHttp: 0, reachingHttp: 0, created: 0 });
  assert.deepEqual(stats.callsEdges, { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 });
  assert.deepEqual(stats.callsByRule, { 'same-file': 0, 'esm-import': 0, 'passed-as-value': 0 });
  assert.equal(stats.screens.declared, 0);
  assert.equal(stats.screens.screens, 0);
});

// ---------------------------------------------------------------------------
// A frontend that lives BESIDE the backend
// ---------------------------------------------------------------------------
//
// Two repositories, not one: the analyzed root is the backend, so every path in
// the fact stream starts with `../`. Nothing about the rules changes, and this
// test is here because everything about them COULD have: an alias target is
// joined onto the package directory, and a `..` that a path normalizer swallowed
// would send every import to a file that is not there.

test('facts stamped ../ resolve an alias and a base URL exactly like in-root ones', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    cfg('../front/vite.config.ts', { what: 'alias', from: '@', to: './src' }),
    cfg('../front/.env.development', {
      what: 'env', name: 'BASE', value: '/api', mode: 'development',
    }),
    cfg('../front/vite.config.ts', {
      what: 'proxy', context: '/api', target: 'http://localhost:8080', rewrite: null,
    }),
    ...file('../front/src/utils/http.ts',
      imp(1, 'axios', [{ imported: 'default', local: 'axios' }]),
      binding(2, 'client', axiosCreate({ kind: 'member', root: 'import.meta', path: ['env', 'BASE'] })),
      exp(3, 'default', 'expression', { local: 'client' })),
    ...file('../front/src/api/things.ts',
      imp(1, '@/utils/http', [{ imported: 'default', local: 'client' }]),
      exp(2, 'listThings', 'function', { local: 'listThings' }),
      fn(2, 'listThings'),
      call(3, 'listThings', memberCallee('client', 'get'),
        { kind: 'import', source: '@/utils/http', imported: 'default' },
        literalUrl('/things/list'), { value: 'GET', from: 'callee-name' })),
  ]);
  const e = only(g);
  assert.equal(e.from, webSymbolId('../front/src/api/things.ts', 'listThings'));
  assert.equal(e.to, webEndpointId('GET', '/api/things/list'));
  assert.equal(e.grade, 'SOUND_SET', 'a package outside the analyzed root is still a package');
  assert.equal(e.evidence.sink.instance, '../front/src/utils/http.ts#client');
  assert.deepEqual(e.evidence.prefix, { value: '/api', from: 'derived' });
  assert.equal(e.evidence.alias, undefined, 'the alias was declared, so nothing rested on an assumption');
  // The package the census groups by is the directory above the root, named as
  // it is stamped.
  assert.deepEqual(Object.keys(stats.prefix), ['../front']);
  assert.equal(stats.assumedAliases, 0);
});

// ---------------------------------------------------------------------------
// THE SCREEN AXIS (RM30 §A, §B)
// ---------------------------------------------------------------------------
//
// Everything above is about ONE call reaching ONE route. These are about the
// two hops on either side of it: the calls BETWEEN frontend functions, and the
// screen the router mounts the component on. Same discipline, same invented
// names: what is asserted is the decision each rule makes, with its grade and
// its evidence, one rule at a time.

const identCallee = (name) => ({ shape: 'ident', root: name, path: [], name });
const importBinding = (source, imported) => ({ kind: 'import', source, imported });
const route = (line, rec) => ({ kind: 'route', line, pack: 'test-router', parent: null, children: 0, ...rec });
const ALIAS = cfg('jsconfig.json', { what: 'alias', from: '@', to: 'src' });
const ASSUMED_ALIAS = cfg('jsconfig.json', { what: 'alias', from: '@', to: 'src', assumed: true });

/** The api module: one exported function whose call really does send a request. */
const apiFile = (name = 'src/api/rows.js', fnName = 'listRows') => file(name,
  imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
  fn(3, fnName),
  exp(3, fnName, 'function', { local: fnName }),
  call(4, fnName, memberCallee('client', 'get'), importBinding('@/http', 'default'),
    literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }));

/** A screen component: one method that calls the api function above. */
const viewFile = (opts = {}) => file(opts.file ?? 'src/screens/panel/rows.vue',
  imp(1, opts.source ?? '@/api/rows', [{ imported: opts.local ?? 'listRows', local: opts.local ?? 'listRows' }]),
  ...(opts.extraImports ?? []),
  fn(10, 'getList', { exported: 'default-member' }),
  call(11, 'getList', identCallee(opts.local ?? 'listRows'),
    importBinding(opts.source ?? '@/api/rows', opts.local ?? 'listRows'), null, null),
  ...(opts.extra ?? []));

const SCREEN_ON = { screenAxis: { enabled: true } };
const screensOf = (g) => [...g.nodes.values()].filter((n) => n.kind === 'screen').sort((a, b) => (a.id < b.id ? -1 : 1));
const rendersOf = (g) => g.edges.filter((e) => e.type === 'RENDERS');
const callsOf = (g) => g.edges.filter((e) => e.type === 'CALLS');

// ---- B: the missing hop ---------------------------------------------------

test('a component function calling an api function is a CALLS edge, EXACT through a declared alias', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null), ...apiFile(), ...viewFile()], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['symbol:src/screens/panel/rows.vue#getList', 'symbol:src/api/rows.js#listRows', 'EXACT'],
  ]);
  assert.deepEqual(callsOf(g)[0].evidence, {
    rule: 'esm-import', specifier: '@/api/rows', origin: 'src/api/rows.js#listRows',
  });
  assert.deepEqual(stats.callsEdges, { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 });
  // The api function SENDS a request; the component function only leads to one.
  assert.deepEqual(stats.functions, { withHttp: 1, reachingHttp: 1, created: 2 });
});

test('a name that arrived through an `export *` barrel is SOUND_SET, and the edge says so', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    ...file('src/api/all.js', exp(1, '*', 'reexport', { source: './rows' })),
    ...viewFile({ source: '@/api/all' }),
  ], SCREEN_ON);
  const [e] = callsOf(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.viaStar, true);
  assert.equal(e.evidence.origin, 'src/api/rows.js#listRows');
  assert.equal(e.evidence.specifier, '@/api/all');
});

test('an ASSUMED alias on the path lowers the CALLS edge to HEURISTIC and says which', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [ASSUMED_ALIAS, ...clientFile(null), ...apiFile(), ...viewFile()], SCREEN_ON);
  const [e] = callsOf(g);
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(e.evidence.assumedAlias, true);
});

test('a call by name INSIDE one file resolves to the declaration beside it, EXACT', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null),
    ...file('src/api/rows.js',
      imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
      fn(3, 'send'),
      call(4, 'send', memberCallee('client', 'get'), importBinding('@/http', 'default'),
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }),
      fn(8, 'listRows'),
      exp(8, 'listRows', 'function', { local: 'listRows' }),
      call(9, 'listRows', identCallee('send'), { kind: 'local', name: 'send' }, null, null)),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade, e.evidence.rule]), [
    ['symbol:src/api/rows.js#listRows', 'symbol:src/api/rows.js#send', 'EXACT', 'same-file'],
  ]);
});

test('`this.method()` inside a class resolves to that class\'s own function record', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null),
    ...file('src/api/rows.js',
      imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
      { kind: 'class', line: 2, name: 'Rows', exported: 'named' },
      fn(3, 'Rows.send'),
      call(4, 'Rows.send', memberCallee('client', 'get'), importBinding('@/http', 'default'),
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }),
      fn(8, 'Rows.list'),
      call(9, 'Rows.list', memberCallee('this', 'send'), { kind: 'this', class: 'Rows' }, null, null)),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['symbol:src/api/rows.js#Rows.list', 'symbol:src/api/rows.js#Rows.send', 'EXACT'],
  ]);
});

test('a member call on a NAMESPACE import resolves the member to the exported function', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    ...file('src/screens/panel/rows.vue',
      imp(1, '@/api/rows', [{ imported: '*', local: 'api' }]),
      fn(10, 'getList', { exported: 'default-member' }),
      call(11, 'getList', memberCallee('api', 'listRows'), importBinding('@/api/rows', '*'), null, null)),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['symbol:src/screens/panel/rows.vue#getList', 'symbol:src/api/rows.js#listRows', 'EXACT'],
  ]);
});

// ---- B: a URL built on a constant ANOTHER MODULE exports (RM58) -----------
//
// The worker fills in a constant the same file declares, because that is all
// one file can state. `import { ROWS_URL } from '@/api/urls'` is the same shape
// written across two files, and following it needs the specifier rules and the
// export chain, which live in the bridge.

/** A template URL with its remaining holes on it, the way the worker records one. */
const templateUrl = (template, holes) => ({
  arg: { kind: 'template', template, dynamicParts: holes.length, holes },
  holes,
  resolved: [{ template, dynamicParts: holes.length, via: 'template' }],
});

/** The module the paths are declared in, and the api file that imports one. */
const urlsFile = (value) => file('src/api/urls.js',
  { kind: 'constant', line: 1, name: 'ROWS_URL', exported: true, value },
  exp(1, 'ROWS_URL', 'const', { local: 'ROWS_URL' }));

const importedConstantApi = (source = '@/api/urls') => file('src/api/rows.js',
  imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
  imp(2, source, [{ imported: 'ROWS_URL', local: 'ROWS_URL' }]),
  fn(3, 'listRows'),
  exp(3, 'listRows', 'function', { local: 'listRows' }),
  call(4, 'listRows', memberCallee('client', 'get'), importBinding('@/http', 'default'),
    templateUrl('{*}/list', [{ kind: 'import', name: 'ROWS_URL', source, imported: 'ROWS_URL' }]),
    { value: 'GET', from: 'callee-name' }));

test('a hole another module\'s constant explains is filled in, and the edge says what went in', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...urlsFile('/plain'), ...importedConstantApi(),
  ], SCREEN_ON);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.evidence.url.written, '/plain/list');
  assert.deepEqual(e.evidence.url.substituted, [
    { name: 'ROWS_URL', value: '/plain', from: 'import' },
  ]);
  // The literal is in the source, so the route match is graded as any other.
  assert.equal(e.grade, 'SOUND_SET');
  assert.deepEqual(stats.url.substituted, { 'same-file': 0, import: 1 });
  assert.deepEqual(stats.url.holes, {
    parameter: 0, env: 0, call: 0, import: 0, unknown: 0,
  });
});

test('a hole whose module this lane never read stays a hole, and nothing is invented', () => {
  // The specifier leads out of the project, so nothing here knows what the name
  // holds. The template keeps its hole and the call is matched on what is left
  // of it, exactly as it was before this rule existed.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...importedConstantApi('some-package/urls'),
  ], SCREEN_ON);
  const e = only(g);
  assert.equal(e.evidence.url.written, '{*}/list');
  assert.equal(e.evidence.url.substituted, undefined);
  assert.deepEqual(stats.url.substituted, { 'same-file': 0, import: 0 });
  assert.deepEqual(stats.url.holes, {
    parameter: 0, env: 0, call: 0, import: 1, unknown: 0,
  });
});

test('a constant reached through an ASSUMED alias grades the call down', () => {
  // The value is a literal somebody wrote; WHICH file it was read from rests on
  // a guessed alias, and everything that rests on that guess grades down.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ASSUMED_ALIAS, ...clientFile(null), ...urlsFile('/plain'), ...importedConstantApi(),
  ], SCREEN_ON);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(stats.assumedAliases, 1);
});

// ---- B: a member of an imported OBJECT (RM57) -----------------------------
//
// `export const rowService = { listRows: … }` in one file and
// `rowService.listRows()` in another is how most TypeScript frontends keep
// their API calls. The worker says whose each function is, so the member is
// resolved by name rather than by looking for any function spelled `listRows`
// in that file.

/** The same api module, written as a named object of functions. */
const serviceFile = (name = 'src/api/rows.js') => file(name,
  imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
  exp(2, 'rowService', 'const', { local: 'rowService' }),
  fn(3, 'listRows', { exported: null, member: 'rowService.listRows' }),
  call(4, 'listRows', memberCallee('client', 'get'), importBinding('@/http', 'default'),
    literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }));

/** A view that calls one member of it, and whatever else the test adds. */
const serviceViewFile = (...extra) => file('src/screens/panel/rows.vue',
  imp(1, '@/api/rows', [{ imported: 'rowService', local: 'rowService' }]),
  fn(10, 'getList', { exported: 'default-member' }),
  call(11, 'getList', memberCallee('rowService', 'listRows'),
    importBinding('@/api/rows', 'rowService'), null, null),
  ...extra);

test('a member of an imported object of functions is a CALLS edge, and the evidence names it', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null), ...serviceFile(), ...serviceViewFile()], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['symbol:src/screens/panel/rows.vue#getList', 'symbol:src/api/rows.js#listRows', 'EXACT'],
  ]);
  assert.deepEqual(callsOf(g)[0].evidence, {
    rule: 'esm-import',
    specifier: '@/api/rows',
    member: 'rowService.listRows',
    origin: 'src/api/rows.js#listRows',
  });
  assert.deepEqual(stats.callsEdges, { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 });
  assert.equal(stats.callsByRule['esm-import'], 1);
});

test('a member this lane never read is no edge and no miss: the HTTP pass already explained it', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...serviceFile(),
    ...serviceViewFile(
      // A member nobody declared, and a path one level deeper than a member.
      call(12, 'getList', memberCallee('rowService', 'missing'),
        importBinding('@/api/rows', 'rowService'), null, null),
      call(13, 'getList',
        { shape: 'member', root: 'rowService', path: ['inner', 'listRows'], name: 'listRows' },
        importBinding('@/api/rows', 'rowService'), null, null),
    ),
  ], SCREEN_ON);
  assert.equal(callsOf(g).length, 1, 'only the member the worker recorded is an edge');
  assert.equal(stats.calls.notAFunction, 0);
});

test('the object an import names is followed through a barrel, and the member with it', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...serviceFile(),
    ...file('src/api/all.js', exp(1, '*', 'reexport', { source: './rows' })),
    ...file('src/screens/panel/rows.vue',
      imp(1, '@/api/all', [{ imported: 'rowService', local: 'rowService' }]),
      fn(10, 'getList', { exported: 'default-member' }),
      call(11, 'getList', memberCallee('rowService', 'listRows'),
        importBinding('@/api/all', 'rowService'), null, null)),
  ], SCREEN_ON);
  const [e] = callsOf(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.viaStar, true);
  assert.equal(e.evidence.member, 'rowService.listRows');
  assert.equal(e.evidence.origin, 'src/api/rows.js#listRows');
});

test('a call onto an imported name that is not a function makes no edge, and is counted', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    ...file('src/labels.js', { kind: 'constant', line: 1, name: 'LABEL', exported: true, value: 'rows' },
      exp(1, 'LABEL', 'const', { local: 'LABEL' })),
    ...viewFile({
      extra: [call(12, 'getList', identCallee('LABEL'), importBinding('@/labels', 'LABEL'), null, null)],
      extraImports: [imp(2, '@/labels', [{ imported: 'LABEL', local: 'LABEL' }])],
    }),
  ], SCREEN_ON);
  assert.equal(stats.calls.notAFunction, 1);
  assert.equal(callsOf(g).length, 1, 'only the real function call is an edge');
});

// ---- B: a function handed over as a VALUE (RM32) --------------------------
//
// A view that writes `usePage({ api: listRows }, saveRows)` never CALLS either
// function, so every rule above sees nothing and the screen ends at the view.
// The worker records what was passed; these say what the bridge does with it.

/** Two api functions, each of which really does send a request. */
const apiPair = file('src/api/rows.js',
  imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
  fn(3, 'listRows'),
  exp(3, 'listRows', 'function', { local: 'listRows' }),
  call(4, 'listRows', memberCallee('client', 'get'), importBinding('@/http', 'default'),
    literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }),
  fn(8, 'saveRows'),
  exp(8, 'saveRows', 'function', { local: 'saveRows' }),
  call(9, 'saveRows', memberCallee('client', 'post'), importBinding('@/http', 'default'),
    literalUrl('/plain/list'), { value: 'POST', from: 'callee-name' }));

/** A view whose only mention of its api functions is handing them to a hook. */
const handoverFile = (refs, opts = {}) => file('src/screens/panel/rows.vue',
  imp(1, opts.source ?? '@/api/rows', [
    { imported: 'listRows', local: 'listRows' }, { imported: 'saveRows', local: 'saveRows' },
  ]),
  ...(opts.extraImports ?? []),
  imp(2, '@/hooks/page', [{ imported: 'usePage', local: 'usePage' }]),
  fn(10, 'setup', { exported: 'default-member' }),
  call(11, 'setup', identCallee('usePage'), importBinding('@/hooks/page', 'usePage'), null, null, { fnRefs: refs }));

const byProperty = (local, source, imported, key) => ({
  name: local, binding: { kind: 'import', source, imported }, via: 'property', key,
});
const byArgument = (local, source, imported, extra = {}) => ({
  name: local, binding: { kind: 'import', source, imported }, via: 'argument', ...extra,
});

test('a function handed to a hook as a value is a CALLS edge, SOUND_SET, by property and by argument', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null), ...apiPair, ...handoverFile([
    byProperty('listRows', '@/api/rows', 'listRows', 'api'),
    byArgument('saveRows', '@/api/rows', 'saveRows'),
  ])], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['symbol:src/screens/panel/rows.vue#setup', 'symbol:src/api/rows.js#listRows', 'SOUND_SET'],
    ['symbol:src/screens/panel/rows.vue#setup', 'symbol:src/api/rows.js#saveRows', 'SOUND_SET'],
  ]);
  assert.deepEqual(callsOf(g)[0].evidence, {
    rule: 'passed-as-value', via: 'property', key: 'api',
    specifier: '@/api/rows', origin: 'src/api/rows.js#listRows',
  });
  assert.deepEqual(callsOf(g)[1].evidence, {
    rule: 'passed-as-value', via: 'argument',
    specifier: '@/api/rows', origin: 'src/api/rows.js#saveRows',
  });
  // SOUND_SET and never EXACT: nothing here looked at whether the hook calls
  // what it was given, and the grade is the honest name for that.
  assert.deepEqual(stats.callsEdges, { EXACT: 0, SOUND_SET: 2, HEURISTIC: 0 });
  assert.deepEqual(stats.callsByRule, { 'same-file': 0, 'esm-import': 0, 'passed-as-value': 2 });
  assert.equal(stats.calls.passedAsValue, 2);
  // Both api functions send a request; the view only leads to one, and it is a
  // node BECAUSE of these edges.
  assert.deepEqual(stats.functions, { withHttp: 2, reachingHttp: 1, created: 3 });
});

test('the screen reaches the api function it only handed over, through the same fixpoint', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiPair,
    ...handoverFile([byProperty('listRows', '@/api/rows', 'listRows', 'api')]),
    ...file('src/router/routes.js', route(5, { path: '/panel/rows', componentSource: '@/screens/panel/rows.vue' })),
  ], SCREEN_ON);
  assert.deepEqual(rendersOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['screen:/panel/rows', 'symbol:src/screens/panel/rows.vue#setup', 'EXACT'],
  ]);
  // ...and one hop on, the function that really sends the request.
  assert.deepEqual(callsOf(g).map((e) => e.to), ['symbol:src/api/rows.js#listRows']);
  assert.equal(g.nodes.has('symbol:src/api/rows.js#listRows'), true);
});

test('a member of a NAMESPACE import handed over resolves to the exported function', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiPair,
    ...file('src/screens/panel/rows.vue',
      imp(1, '@/api/rows', [{ imported: '*', local: 'api' }]),
      imp(2, '@/hooks/page', [{ imported: 'usePage', local: 'usePage' }]),
      fn(10, 'setup', { exported: 'default-member' }),
      call(11, 'setup', identCallee('usePage'), importBinding('@/hooks/page', 'usePage'), null, null, {
        fnRefs: [byArgument('api', '@/api/rows', '*', { path: ['listRows'] })],
      })),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.to, e.grade]), [
    ['symbol:src/api/rows.js#listRows', 'SOUND_SET'],
  ]);
  assert.equal(callsOf(g)[0].evidence.origin, 'src/api/rows.js#listRows');
});

test('a member of an imported OBJECT handed over as a value resolves the same way a call does', () => {
  // `usePage({ api: rowService.listRows })`. Handing a member over is the same
  // hop as calling it, so it goes through the same index (RM58) rather than
  // being refused for having a dot in it.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...serviceFile(),
    ...file('src/screens/panel/rows.vue',
      imp(1, '@/api/rows', [{ imported: 'rowService', local: 'rowService' }]),
      imp(2, '@/hooks/page', [{ imported: 'usePage', local: 'usePage' }]),
      fn(10, 'setup', { exported: 'default-member' }),
      call(11, 'setup', identCallee('usePage'), importBinding('@/hooks/page', 'usePage'), null, null, {
        fnRefs: [byProperty('rowService', '@/api/rows', 'rowService', 'api')].map(
          (r) => ({ ...r, path: ['listRows'] }),
        ),
      })),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.to, e.grade]), [
    ['symbol:src/api/rows.js#listRows', 'SOUND_SET'],
  ]);
  assert.deepEqual(callsOf(g)[0].evidence, {
    rule: 'passed-as-value', via: 'property', key: 'api',
    specifier: '@/api/rows', origin: 'src/api/rows.js#listRows',
    member: 'rowService.listRows',
  });
  assert.equal(stats.callsByRule['passed-as-value'], 1);
});

test('an ASSUMED alias on the path lowers a handed-over function to HEURISTIC', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [ASSUMED_ALIAS, ...clientFile(null), ...apiPair, ...handoverFile([
    byProperty('listRows', '@/api/rows', 'listRows', 'api'),
  ])], SCREEN_ON);
  const [e] = callsOf(g);
  assert.equal(e.grade, 'HEURISTIC');
  assert.equal(e.evidence.assumedAlias, true);
});

test('a value that is NOT a function this lane read makes no edge and is not counted as a miss', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiPair,
    ...file('src/labels.js', { kind: 'constant', line: 1, name: 'LABEL', exported: true, value: 'rows' },
      exp(1, 'LABEL', 'const', { local: 'LABEL' })),
    ...handoverFile([byProperty('LABEL', '@/labels', 'LABEL', 'title')], {
      extraImports: [imp(3, '@/labels', [{ imported: 'LABEL', local: 'LABEL' }])],
    }),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g), []);
  assert.equal(stats.calls.passedAsValue, 0);
  // Handing a label to a hook is ordinary, not a hop this lane lost.
  assert.equal(stats.calls.notAFunction, 0);
});

test('a function BOTH called and handed over keeps the call\'s EXACT answer, once', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiPair,
    ...file('src/screens/panel/rows.vue',
      imp(1, '@/api/rows', [{ imported: 'listRows', local: 'listRows' }]),
      imp(2, '@/hooks/page', [{ imported: 'usePage', local: 'usePage' }]),
      fn(10, 'setup', { exported: 'default-member' }),
      call(11, 'setup', identCallee('usePage'), importBinding('@/hooks/page', 'usePage'), null, null, {
        fnRefs: [byProperty('listRows', '@/api/rows', 'listRows', 'api')],
      }),
      call(12, 'setup', identCallee('listRows'), importBinding('@/api/rows', 'listRows'), null, null)),
  ], SCREEN_ON);
  assert.deepEqual(callsOf(g).map((e) => [e.to, e.grade, e.evidence.rule]), [
    ['symbol:src/api/rows.js#listRows', 'EXACT', 'esm-import'],
  ]);
  assert.equal(stats.calls.passedAsValue, 1, 'the reference is still counted: it is there in the source');
});

test('THE FUNCTION-CREATION RULE: a utility with no path to HTTP gets no node and no edge', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    ...file('src/utils/fmt.js', fn(1, 'formatRow'), exp(1, 'formatRow', 'function', { local: 'formatRow' })),
    ...viewFile({
      extraImports: [imp(2, '@/utils/fmt', [{ imported: 'formatRow', local: 'formatRow' }])],
      extra: [call(12, 'getList', identCallee('formatRow'), importBinding('@/utils/fmt', 'formatRow'), null, null)],
    }),
  ], SCREEN_ON);
  assert.equal(g.nodes.has('symbol:src/utils/fmt.js#formatRow'), false,
    'a formatter no request ever passes through is counted, not created');
  assert.equal(callsOf(g).some((e) => e.to.includes('fmt.js')), false);
  assert.deepEqual(stats.functions, { withHttp: 1, reachingHttp: 1, created: 2 });
});

test('a function in a COMPONENT file says so, and one in an api module does not', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [ALIAS, ...clientFile(null), ...apiFile(), ...viewFile()], SCREEN_ON);
  assert.equal(g.nodes.get('symbol:src/screens/panel/rows.vue#getList').component, true);
  assert.equal(g.nodes.get('symbol:src/api/rows.js#listRows').component, undefined);
});

// ---- A: composition -------------------------------------------------------

const composeFacts = (...routes) => [
  ALIAS, ...clientFile(null), ...apiFile(), ...viewFile(),
  ...file('src/router/routes.js', ...routes),
];

test('a child path composes onto its parent, and an ABSOLUTE child replaces it', () => {
  const g = graphWithRoutes();
  addWebFacts(g, composeFacts(
    route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue', children: 2 }),
    route(8, { path: 'rows', componentSource: '@/screens/panel/rows.vue', parent: 5 }),
    route(12, { path: '/elsewhere', componentSource: '@/screens/panel/rows.vue', parent: 5 }),
  ), SCREEN_ON);
  assert.deepEqual(screensOf(g).map((n) => n.path), ['/elsewhere', '/panel', '/panel/rows']);
});

test('a parent whose path is empty contributes nothing, and the root path is `/`', () => {
  const g = graphWithRoutes();
  addWebFacts(g, composeFacts(
    route(5, { path: '', componentSource: '@/screens/panel/index.vue', children: 1 }),
    route(8, { path: 'rows', componentSource: '@/screens/panel/rows.vue', parent: 5 }),
    route(20, { path: '/', componentSource: '@/screens/panel/index.vue' }),
  ), SCREEN_ON);
  assert.deepEqual(screensOf(g).map((n) => n.path), ['/', '/rows']);
});

test('a REDIRECT with no component and no children is not a screen', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, composeFacts(
    route(5, { path: '/go', redirect: '/panel/rows' }),
    route(9, { path: '/panel', componentSource: '@/screens/panel/rows.vue', redirect: '/panel/rows', children: 0 }),
  ), SCREEN_ON);
  assert.deepEqual(screensOf(g).map((n) => n.path), ['/panel'], 'a redirect that also mounts a component IS a screen');
  assert.equal(stats.screens.declared, 2, 'both declarations are counted, and one of them is not a screen');
  assert.equal(stats.screens.screens, 1);
});

test('two declarations that compose to the SAME path are one node, and both are listed', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, composeFacts(
    route(5, { path: '/panel', componentSource: '@/screens/panel/rows.vue' }),
    route(30, { path: '/panel', componentSource: '@/screens/panel/index.vue' }),
  ), SCREEN_ON);
  const [n] = screensOf(g);
  assert.equal(screensOf(g).length, 1);
  assert.equal(n.line, 5, 'the FIRST in (file, line) order is the node');
  assert.equal(n.component, 'src/screens/panel/rows.vue');
  assert.deepEqual(n.declaredAt, [
    { file: 'src/router/routes.js', line: 5 },
    { file: 'src/router/routes.js', line: 30 },
  ]);
  assert.equal(stats.screens.duplicatePaths, 1);
});

// ---- A: attributes and the profile keys -----------------------------------

const attrFacts = (rec) => composeFacts(route(8, {
  path: 'rows', name: 'PanelRows', componentSource: '@/screens/panel/rows.vue',
  metaTitle: 'Panel rows', parent: 5, ...rec,
}), route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue', children: 1 }));

test('every attribute of a screen comes off the declaration, and nothing is invented', () => {
  const g = graphWithRoutes();
  addWebFacts(g, attrFacts({}), { screenAxis: { enabled: true, nameSource: 'route-meta' } });
  const n = g.nodes.get('screen:/panel/rows');
  assert.deepEqual({
    path: n.path, name: n.name, title: n.title, label: n.label, code: n.code, group: n.group,
    component: n.component, file: n.file, line: n.line, pack: n.pack, params: n.params,
    lane: n.lane, source: n.source, hidden: n.hidden,
  }, {
    path: '/panel/rows', name: 'PanelRows', title: 'Panel rows', label: '/panel/rows', code: null,
    group: 'panel', component: 'src/screens/panel/rows.vue', file: 'src/router/routes.js', line: 8,
    pack: 'test-router', params: false, lane: 'web', source: 'router', hidden: undefined,
  });
});

test('nameSource: route-meta reads the title, none leaves it null, jsdoc-comment is REFUSED by name', () => {
  const meta = new Graph();
  const withMeta = graphWithRoutes();
  addWebFacts(withMeta, attrFacts({}), { screenAxis: { enabled: true, nameSource: 'route-meta' } });
  assert.equal(withMeta.nodes.get('screen:/panel/rows').title, 'Panel rows');
  void meta;

  const none = graphWithRoutes();
  const noneStats = addWebFacts(none, attrFacts({}), { screenAxis: { enabled: true, nameSource: 'none' } });
  assert.equal(none.nodes.get('screen:/panel/rows').title, null);
  assert.equal(noneStats.screens.nameSource.refused, null);

  const jsdoc = graphWithRoutes();
  const stats = addWebFacts(jsdoc, attrFacts({}), { screenAxis: { enabled: true, nameSource: 'jsdoc-comment' } });
  assert.equal(jsdoc.nodes.get('screen:/panel/rows').title, null);
  assert.deepEqual(stats.screens.nameSource, {
    asked: 'jsdoc-comment', used: 'none', refused: stats.screens.nameSource.refused,
  });
  assert.match(stats.screens.nameSource.refused, /jsdoc-comment/);
});

test('pathRule last-segment shortens the LABEL and never the path', () => {
  const g = graphWithRoutes();
  addWebFacts(g, attrFacts({}), { screenAxis: { enabled: true, pathRule: 'last-segment' } });
  const n = g.nodes.get('screen:/panel/rows');
  assert.equal(n.label, 'rows');
  assert.equal(n.path, '/panel/rows');
});

test('codeRegex reads a screen CODE, and codeLength cuts it down to the group', () => {
  const g = graphWithRoutes();
  addWebFacts(g, attrFacts({ name: 'AB1234-rows' }), {
    screenAxis: { enabled: true, codeRegex: '([A-Z]{2}\\d{4})' },
    codeLength: 2,
  });
  const n = g.nodes.get('screen:/panel/rows');
  assert.equal(n.code, 'AB1234');
  assert.equal(n.group, 'AB');

  // With a code and NO length, the group falls back to the first path segment.
  const noLen = graphWithRoutes();
  addWebFacts(noLen, attrFacts({ name: 'AB1234-rows' }), {
    screenAxis: { enabled: true, codeRegex: '([A-Z]{2}\\d{4})' },
  });
  assert.equal(noLen.nodes.get('screen:/panel/rows').group, 'panel');
});

test('a path with a parameter says so, and a hidden declaration carries it', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, composeFacts(
    route(5, { path: '/panel/:id', componentSource: '@/screens/panel/rows.vue', hidden: true }),
  ), SCREEN_ON);
  const n = g.nodes.get('screen:/panel/:id');
  assert.equal(n.params, true);
  assert.equal(n.hidden, true);
  assert.equal(stats.screens.withParams, 1);
  assert.equal(stats.screens.hidden, 1);
});

test('screenAxis.enabled is the GATE: with it off no route becomes a screen', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, attrFacts({}), { screenAxis: { enabled: false } });
  assert.deepEqual(screensOf(g), []);
  assert.equal(stats.screens.declared, 2, 'the declarations are still counted');
  assert.equal(stats.screens.screens, 0);
  assert.equal(stats.screens.enabled, false);
  // ...and the CALLS edges are unaffected: they are not the screen axis.
  assert.equal(callsOf(g).length, 1);
});

// ---- A: RENDERS -----------------------------------------------------------

test('RENDERS is EXACT onto the functions of the file the route names', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, composeFacts(
    route(5, { path: '/panel/rows', componentSource: '@/screens/panel/rows.vue' }),
  ), SCREEN_ON);
  assert.deepEqual(rendersOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['screen:/panel/rows', 'symbol:src/screens/panel/rows.vue#getList', 'EXACT'],
  ]);
  assert.equal(rendersOf(g)[0].evidence.rule, 'route-component');
  assert.equal(rendersOf(g)[0].evidence.component, 'src/screens/panel/rows.vue');
  assert.deepEqual(stats.screens.renders, { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 });
});

test('a component that IMPORTS another component renders it as a candidate, with the chain', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    // The route's component imports a child, which imports a grandchild; only
    // the grandchild makes a call.
    ...file('src/screens/panel/index.vue', imp(1, './child.vue', [{ imported: 'default', local: 'Child' }])),
    ...file('src/screens/panel/child.vue', imp(1, './rows.vue', [{ imported: 'default', local: 'Rows' }])),
    ...viewFile(),
    ...file('src/router/routes.js', route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue' })),
  ], SCREEN_ON);
  const e = rendersOf(g).find((x) => x.to === 'symbol:src/screens/panel/rows.vue#getList');
  assert.ok(e, `no RENDERS onto the grandchild: ${JSON.stringify(rendersOf(g))}`);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.rule, 'component-import');
  assert.deepEqual(e.evidence.via, [
    'src/screens/panel/index.vue', 'src/screens/panel/child.vue', 'src/screens/panel/rows.vue',
  ]);
  assert.deepEqual(stats.screens.renders, { EXACT: 0, SOUND_SET: 1, HEURISTIC: 0 });
});

test('an import CYCLE between two components is cut, and neither is rendered twice', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ALIAS, ...clientFile(null), ...apiFile(),
    ...file('src/screens/panel/index.vue',
      imp(1, './rows.vue', [{ imported: 'default', local: 'Rows' }])),
    ...viewFile({ extraImports: [imp(2, './index.vue', [{ imported: 'default', local: 'Panel' }])] }),
    ...file('src/router/routes.js', route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue' })),
  ], SCREEN_ON);
  assert.equal(rendersOf(g).length, 1, JSON.stringify(rendersOf(g)));
});

test('a component the lane never read gets NO renders edge, and the specifier that failed is named', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, composeFacts(
    route(5, { path: '/gone', componentSource: '@/screens/nowhere/index.vue' }),
    route(9, { path: '/local', componentLocal: 'Layout' }),
  ), SCREEN_ON);
  assert.deepEqual(rendersOf(g), []);
  assert.equal(stats.screens.componentUnresolved, 2);
  assert.deepEqual(stats.screens.unresolvedSpecifiers.map((u) => u.specifier).sort(), [
    '(declared in src/router/routes.js as Layout)', '@/screens/nowhere/index.vue',
  ]);
  // ...and the screens are still there, with no component and nothing under them.
  assert.deepEqual(screensOf(g).map((n) => [n.path, n.component]), [['/gone', null], ['/local', null]]);
});

test('the whole round trip, in one graph: screen to component to api function to route', () => {
  const g = graphWithRoutes();
  addWebFacts(g, composeFacts(
    route(5, { path: '/panel/rows', componentSource: '@/screens/panel/rows.vue' }),
  ), SCREEN_ON);
  const hops = [];
  let cur = 'screen:/panel/rows';
  for (let i = 0; i < 3; i += 1) {
    const [next] = g.outEdges(cur);
    if (!next) break;
    hops.push(`${next.type}/${next.grade}`);
    cur = next.to;
  }
  assert.deepEqual(hops, ['RENDERS/EXACT', 'CALLS/EXACT', 'CALLS_HTTP/SOUND_SET']);
  assert.equal(cur, webEndpointId('GET', '/plain/list'));
});

test('the same facts in reverse order build the same screens and the same edges', () => {
  const facts = composeFacts(
    route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue', children: 1 }),
    route(8, { path: 'rows', componentSource: '@/screens/panel/rows.vue', parent: 5 }),
  );
  const a = graphWithRoutes();
  addWebFacts(a, facts, SCREEN_ON);
  const b = graphWithRoutes();
  addWebFacts(b, facts.slice().reverse(), SCREEN_ON);
  const shape = (g) => JSON.stringify({
    screens: screensOf(g).map((n) => [n.path, n.component, n.line]),
    edges: g.edges.filter((e) => e.type !== 'HANDLES').map((e) => [e.from, e.to, e.type, e.grade]).sort(),
  });
  assert.equal(shape(a), shape(b));
});

test('the server-driven rule is the MENU CALL: it fires with one route declared and with many', () => {
  const menuRoute = ['GET', '/system/menus'];
  const withMenu = () => {
    const g = graphWithRoutes([...ROUTES, menuRoute]);
    return g;
  };
  // A call that reaches the menu route, and only a handful of routes declared.
  const menuCall = file('src/api/menu.js',
    imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
    fn(3, 'getMenus'),
    exp(3, 'getMenus', 'function', { local: 'getMenus' }),
    call(4, 'getMenus', memberCallee('client', 'get'), importBinding('@/http', 'default'),
      literalUrl('/system/menus'), { value: 'GET', from: 'callee-name' }));

  const g1 = withMenu();
  const fired = addWebFacts(g1, [
    ALIAS, ...clientFile(null), ...apiFile(), ...viewFile(), ...menuCall,
    ...file('src/router/routes.js', route(5, { path: '/panel', componentSource: '@/screens/panel/rows.vue' })),
  ], SCREEN_ON);
  assert.equal(fired.screens.serverDriven.detected, true);
  assert.equal(fired.screens.serverDriven.detectedBy, 'menu-call');
  assert.deepEqual(fired.screens.serverDriven.menuEndpoints, ['/system/menus']);
  assert.equal(fired.screens.serverDriven.routes, 1);

  // The same frontend WITHOUT the menu call: not server driven.
  const g2 = withMenu();
  const quiet = addWebFacts(g2, [
    ALIAS, ...clientFile(null), ...apiFile(), ...viewFile(),
    ...file('src/router/routes.js', route(5, { path: '/panel', componentSource: '@/screens/panel/rows.vue' })),
  ], SCREEN_ON);
  assert.equal(quiet.screens.serverDriven.detected, false);
  assert.equal(quiet.screens.serverDriven.detectedBy, null);
  assert.deepEqual(quiet.screens.serverDriven.menuEndpoints, []);

  // MANY ROUTES AND A MENU CALL is server driven too (RM32). It used to need
  // fewer than 30 declared routes, and the biggest frontend measured declares
  // 173 while fetching every business screen from the database: the rule stayed
  // silent and "19 of 166 screens reach a table" read as a shortfall.
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push(route(5 + i, { path: `/p${i}`, componentSource: '@/screens/panel/rows.vue' }));
  }
  const g3 = withMenu();
  const big = addWebFacts(g3, [
    ALIAS, ...clientFile(null), ...apiFile(), ...viewFile(), ...menuCall,
    ...file('src/router/routes.js', ...many),
  ], SCREEN_ON);
  assert.equal(big.screens.serverDriven.routes, 40);
  assert.equal(big.screens.serverDriven.detected, true, 'the menu call alone decides');
  assert.equal(big.screens.serverDriven.detectedBy, 'menu-call');
  assert.equal(big.screens.serverDriven.ceiling, 30, 'the ceiling survives as the wording switch');
});

// ---------------------------------------------------------------------------
// B7b/B7c: a screen that attaches by the FRAMEWORK'S OWN NAME REGISTRY (RM47)
//
// A frontend written before modules imports nothing. `<owner-list>` in a state's
// template is a string the framework matches against a registry it keeps, and
// that registry is what these edges are built on: the tag, the component
// registered under that name, and the controller that component names.
// ---------------------------------------------------------------------------

const ngRoute = (line, rec) => ({
  kind: 'route', line, pack: 'angular-router', via: 'chain', receiver: '$stateProvider',
  parent: null, children: 0, ...rec,
});
const ngReg = (line, what, name, extra = {}) => ({
  kind: 'registration', line, framework: 'angular', what, name, ...extra,
});
const ngCall = (line, url, method = 'GET') => ({
  kind: 'call', line, enclosing: '(module)',
  callee: { shape: 'member', root: '$http', path: [method.toLowerCase()], name: method.toLowerCase() },
  binding: null, args: [], url: literalUrl(url), method: { value: method, from: 'callee-name' },
  platformSink: null, injected: { client: '$http', framework: 'angularjs' },
});

/** The petclinic shape, renamed: a state, a component, a controller that calls. */
const ngApp = ({ tag = 'thing-list', component = 'thingList', controller = 'ThingListCtrl' } = {}) => [
  ...file('static/scripts/app.js',
    ngRoute(4, { name: 'shell', path: '', abstract: true, componentTag: 'ui-view' }),
    ngRoute(9, { name: 'things', path: '/plain/list', parentName: 'shell', componentTag: tag })),
  ...file('static/scripts/thing/thing.component.js',
    ngReg(3, 'component', component, { controller })),
  ...file('static/scripts/thing/thing.controller.js',
    ngReg(3, 'controller', controller),
    ngCall(5, '/plain/list')),
];

test('a screen resolves its component by NAME, and the chain of names is on the edge', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, ngApp(), SCREEN_ON);
  assert.deepEqual(screensOf(g).map((s) => s.path), ['/plain/list'],
    'the abstract state composes the path and is not a screen of its own');
  assert.deepEqual(rendersOf(g).map((e) => [e.from, e.to, e.grade]), [
    ['screen:/plain/list', 'symbol:static/scripts/thing/thing.controller.js#(module)', 'EXACT'],
  ]);
  const [e] = rendersOf(g);
  assert.equal(e.evidence.rule, 'angular-controller');
  assert.deepEqual(e.evidence.names, ['thing-list', 'thingList', 'ThingListCtrl']);
  assert.equal(e.evidence.component, 'static/scripts/thing/thing.controller.js');
  assert.match(e.evidence.basis, /resolves that name through its own registry/);
  assert.deepEqual(stats.screens.renders, { EXACT: 1, SOUND_SET: 0, HEURISTIC: 0 });
  assert.equal(stats.screens.withComponent, 1);
  assert.deepEqual(stats.screens.unresolvedNames, []);
});

test('the $http call behind that screen is a client, and the screen reaches the route', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, ngApp(), SCREEN_ON);
  const e = only(g);
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.equal(e.evidence.sink.kind, 'injected');
  assert.equal(e.evidence.sink.module, '$http');
  assert.equal(e.evidence.basis, WEB_CALL_BASIS.injected);
  assert.equal(stats.calls.injected, 1);
  assert.equal(stats.calls.untraced, 0, 'an injected client is traced, not guessed at');
});

test('a name registered TWICE renders both, HEURISTIC, because load order decides', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...ngApp(),
    // A second module registers the same component name against another controller.
    ...file('static/scripts/other/other.component.js', ngReg(3, 'component', 'thingList', { controller: 'OtherCtrl' })),
    ...file('static/scripts/other/other.controller.js', ngReg(3, 'controller', 'OtherCtrl'), ngCall(5, '/plain/list')),
  ], SCREEN_ON);
  assert.deepEqual(rendersOf(g).map((e) => [e.to, e.grade]).sort(), [
    ['symbol:static/scripts/other/other.controller.js#(module)', 'HEURISTIC'],
    ['symbol:static/scripts/thing/thing.controller.js#(module)', 'HEURISTIC'],
  ]);
  assert.match(rendersOf(g)[0].evidence.basis, /registered more than once/);
  assert.deepEqual(stats.screens.renders, { EXACT: 0, SOUND_SET: 0, HEURISTIC: 2 });
});

test('a tag nothing registers gets NO edge, and the name is reported rather than dropped', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...file('static/scripts/app.js',
      ngRoute(4, { name: 'ghost', path: '/plain/list', componentTag: 'never-registered' })),
  ], SCREEN_ON);
  assert.deepEqual(screensOf(g).map((s) => s.path), ['/plain/list']);
  assert.deepEqual(rendersOf(g), []);
  assert.equal(stats.screens.componentUnresolved, 1);
  assert.deepEqual(stats.screens.unresolvedNames, [{ name: 'component neverRegistered', count: 1 }],
    'the REGISTRY name the tag resolves to is what missed, and that is the name to look for');
});

test('a template mounts a component inside a component, and the walk follows it', () => {
  const g = graphWithRoutes();
  // The same app, with thing.component.js's template naming <thing-badge>:
  // another component, with a controller of its own.
  const withTemplate = ngApp().filter((r) => r.file !== 'static/scripts/thing/thing.component.js');
  const stats = addWebFacts(g, [
    ...withTemplate,
    ...file('static/scripts/thing/thing.component.js',
      ngReg(3, 'component', 'thingList', {
        controller: 'ThingListCtrl',
        templateFile: 'static/scripts/thing/thing.template.html',
        templateTags: ['thing-badge'],
      })),
    ...file('static/scripts/badge/badge.js',
      ngReg(3, 'component', 'thingBadge', { controller: 'BadgeCtrl' }),
      ngReg(7, 'controller', 'BadgeCtrl'),
      ngCall(9, '/api/things/list')),
  ], SCREEN_ON);
  const badge = rendersOf(g).find((e) => e.to.includes('badge/badge.js'));
  assert.ok(badge, `expected an edge onto the badge file, got ${JSON.stringify(rendersOf(g).map((e) => e.to))}`);
  assert.equal(badge.grade, 'EXACT');
  assert.equal(badge.evidence.rule, 'angular-controller');
  assert.deepEqual(badge.evidence.names, [
    'thing-list', 'thingList', 'static/scripts/thing/thing.template.html', 'thing-badge', 'thingBadge', 'BadgeCtrl',
  ], 'the whole chain, template included, is what the edge rests on');
  // Three edges: the screen's own controller, and the badge file twice, once as
  // the component the template names and once as the controller that component
  // names. Both registrations sit in that one file.
  assert.deepEqual(rendersOf(g).map((e) => [e.to, e.evidence.rule]).sort(), [
    ['symbol:static/scripts/badge/badge.js#(module)', 'angular-controller'],
    ['symbol:static/scripts/badge/badge.js#(module)', 'angular-template-tag'],
    ['symbol:static/scripts/thing/thing.controller.js#(module)', 'angular-controller'],
  ]);
  assert.equal(stats.screens.renders.EXACT, 3);
});

test('a state with an abstract parent composes its path across FILES', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('static/scripts/app.js', ngRoute(4, { name: 'app', path: '/plain', abstract: true, componentTag: 'ui-view' })),
    // Another file entirely names `app` as its parent — the worker resolves
    // nothing across files, so the bridge is what puts the two together.
    ...file('static/scripts/list/list.js', ngRoute(6, { name: 'rows', path: 'list', parentName: 'app', componentTag: 'row-list' })),
    ...file('static/scripts/list/list.component.js', ngReg(3, 'component', 'rowList', { controller: 'RowCtrl' })),
    ...file('static/scripts/list/list.controller.js', ngReg(3, 'controller', 'RowCtrl'), ngCall(5, '/plain/list')),
  ], SCREEN_ON);
  assert.deepEqual(screensOf(g).map((s) => s.path), ['/plain/list']);
});

test('a DIRECTIVE with a controller is a mount point when no component holds the name', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('static/scripts/app.js', ngRoute(4, { name: 'boxes', path: '/plain/list', componentTag: 'widget-box' })),
    ...file('static/scripts/widget/widget.js',
      ngReg(3, 'directive', 'widgetBox', { controller: 'WidgetCtrl' }),
      ngReg(9, 'controller', 'WidgetCtrl'),
      ngCall(11, '/plain/list')),
  ], SCREEN_ON);
  assert.deepEqual(rendersOf(g).map((e) => [e.to, e.grade, e.evidence.rule]), [
    ['symbol:static/scripts/widget/widget.js#(module)', 'EXACT', 'angular-component'],
    ['symbol:static/scripts/widget/widget.js#(module)', 'EXACT', 'angular-controller'],
  ]);
});

test('a $routeProvider route names its controller directly, with no component in between', () => {
  const g = graphWithRoutes();
  addWebFacts(g, [
    ...file('static/scripts/legacy.js', {
      kind: 'route', line: 4, pack: 'angular-router', via: 'chain', receiver: '$routeProvider',
      path: '/plain/list', controllerName: 'LegacyCtrl', parent: null, children: 0,
    }),
    ...file('static/scripts/legacy.controller.js', ngReg(3, 'controller', 'LegacyCtrl'), ngCall(5, '/plain/list')),
  ], SCREEN_ON);
  assert.deepEqual(rendersOf(g).map((e) => [e.from, e.to, e.evidence.rule]), [
    ['screen:/plain/list', 'symbol:static/scripts/legacy.controller.js#(module)', 'angular-controller'],
  ]);
});

// ---- B: where a screen LEADS, with no request in it (RM59) ----------------
//
// A router call changes which screen the browser shows and sends nothing, so
// the bridge places no edge for one. What it answers is the question a single
// file cannot: is the path this navigation names a screen this project
// declares? The answer is recorded on the screen the navigation is written in.

const navigation = (line, rec) => ({
  kind: 'navigation', line, framework: 'test-router', rule: 'router-navigation',
  sink: 'router.push', enclosing: 'openRows', ...rec,
});
const navigateTo = (t) => ({ arg: { kind: 'string', value: t }, resolved: [{ template: t, dynamicParts: 0, via: 'literal' }] });

/** Two screens, and a navigation written in the component of the first. */
const navigationFacts = (...extra) => [
  ALIAS, ...clientFile(null), ...apiFile(),
  ...viewFile({ extra }),
  ...file('src/screens/panel/index.vue', fn(4, 'shell', { exported: 'default-member' })),
  ...file('src/router/routes.js',
    route(5, { path: '/panel', componentSource: '@/screens/panel/index.vue' }),
    route(9, { path: '/panel/rows/:rowId', componentSource: '@/screens/panel/rows.vue' })),
];

test('a navigation whose path names a screen is recorded on the screen it is written in', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, navigationFacts(navigation(20, { to: navigateTo('/panel') })), SCREEN_ON);
  assert.deepEqual(g.nodes.get('screen:/panel/rows/:rowId').navigatesTo, [{
    to: 'screen:/panel',
    path: '/panel',
    match: 'exact',
    rule: 'router-navigation',
    framework: 'test-router',
    sink: 'router.push',
    file: 'src/screens/panel/rows.vue',
    line: 20,
  }]);
  // The screen it leads TO says nothing: a navigation is one-way and the
  // record sits where the code is written.
  assert.equal(g.nodes.get('screen:/panel').navigatesTo, undefined);
  assert.equal(stats.navigation.navigations, 1);
  assert.equal(stats.navigation.navigationsToScreen, 1);
  assert.equal(stats.navigation.navigationsUnmatched, 0);
  assert.equal(stats.navigation.screensWithNavigation, 1);
  assert.deepEqual(stats.navigation.byFramework, { 'test-router': 1 });
});

test('a navigation places no edge of any kind, and is in none of the call numbers', () => {
  const g = graphWithRoutes();
  const before = addWebFacts(graphWithRoutes(), navigationFacts(), SCREEN_ON);
  const stats = addWebFacts(g, navigationFacts(navigation(20, { to: navigateTo('/panel') })), SCREEN_ON);
  assert.equal(stats.calls.withUrl, before.calls.withUrl);
  assert.equal(stats.unresolved.total, before.unresolved.total);
  assert.equal(stats.outboundEndpoints, before.outboundEndpoints);
  assert.deepEqual(g.edges.filter((e) => e.to === 'screen:/panel'), []);
});

test('a navigation into a screen with a parameter matches it the way a call matches a route', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, navigationFacts(navigation(20, { to: navigateTo('/panel/rows/{*}') })), SCREEN_ON);
  const entry = g.nodes.get('screen:/panel/rows/:rowId').navigatesTo[0];
  assert.equal(entry.to, 'screen:/panel/rows/:rowId');
  assert.equal(entry.match, 'template');
  assert.equal(stats.navigation.navigationsToScreen, 1);
});

test('a navigation to a path no screen declares is counted and listed, and nothing is invented', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, navigationFacts(navigation(20, { to: navigateTo('/somewhere/else') })), SCREEN_ON);
  assert.equal(g.nodes.get('screen:/panel/rows/:rowId').navigatesTo, undefined);
  assert.equal(stats.navigation.navigationsToScreen, 0);
  assert.equal(stats.navigation.navigationsUnmatched, 1);
  assert.deepEqual(stats.navigation.unmatchedPaths, [{ path: '/somewhere/else', count: 1 }]);
});

test('a navigation whose target this lane could not read is counted and nothing else', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, navigationFacts(navigation(20, {
    to: { arg: { kind: 'ident', name: 'href' }, resolved: null, unresolved: 'parameter' },
  })), SCREEN_ON);
  assert.equal(stats.navigation.navigations, 1);
  assert.equal(stats.navigation.navigationsUnmatched, 1);
  assert.deepEqual(stats.navigation.unmatchedPaths, []);
});

test('a navigation written in a file no screen mounts is counted and recorded nowhere', () => {
  // A shared component belongs to no one screen. Saying it belongs to every
  // screen that mounts it would be a guess, so the count is the whole answer.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [
    ...navigationFacts(),
    ...file('src/components/crumbs.vue', navigation(6, { to: navigateTo('/panel') })),
  ], SCREEN_ON);
  assert.equal(stats.navigation.navigations, 1);
  assert.equal(stats.navigation.navigationsToScreen, 1);
  assert.equal(stats.navigation.screensWithNavigation, 0);
});

// ---- B: a URL that IS an imported constant (RM59) -------------------------
//
// RM58 filled the HOLES a template was left with. A URL argument that is the
// imported name itself resolved to nothing, and the value settles it in both
// directions: a path resolves the call, and anything else was never a call.

const wholeConstantApi = (value) => [
  ...file('src/api/urls.js',
    { kind: 'constant', line: 1, name: 'ROWS_URL', exported: true, value },
    exp(1, 'ROWS_URL', 'const', { local: 'ROWS_URL' })),
  ...file('src/api/rows.js',
    imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
    imp(2, '@/api/urls', [{ imported: 'ROWS_URL', local: 'ROWS_URL' }]),
    fn(3, 'listRows'),
    exp(3, 'listRows', 'function', { local: 'listRows' }),
    call(4, 'listRows', memberCallee('client', 'get'), importBinding('@/http', 'default'), {
      arg: { kind: 'ident', name: 'ROWS_URL' },
      resolved: null,
      unresolved: 'imported-constant',
      binding: { kind: 'import', source: '@/api/urls', imported: 'ROWS_URL' },
    }, { value: 'GET', from: 'callee-name' })),
];

test('a URL that is nothing but an imported constant is read, and the call resolves', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null), ...wholeConstantApi('/plain/list')], SCREEN_ON);
  const e = only(g);
  assert.equal(e.to, webEndpointId('GET', '/plain/list'));
  assert.deepEqual(e.evidence.url.substituted, [{ name: 'ROWS_URL', value: '/plain/list', from: 'import' }]);
  assert.equal(stats.unresolved.byReason.importedConstant, 0);
  assert.equal(stats.calls.withUrl, 1);
});

test('a constant that holds something other than a path says this was never a call', () => {
  // `store.get(ACCESS_TOKEN)` is a browser-storage read that the verb-name
  // convention reads as a URL argument, and the callee reaches no client this
  // lane knows. The VALUE is what settles it.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null),
    ...file('src/api/urls.js',
      { kind: 'constant', line: 1, name: 'TOKEN_KEY', exported: true, value: 'Access-Token' },
      exp(1, 'TOKEN_KEY', 'const', { local: 'TOKEN_KEY' })),
    ...file('src/api/session.js',
      imp(1, 'some-storage', [{ imported: 'default', local: 'store' }]),
      imp(2, '@/api/urls', [{ imported: 'TOKEN_KEY', local: 'TOKEN_KEY' }]),
      fn(3, 'currentToken'),
      call(4, 'currentToken', memberCallee('store', 'get'), importBinding('some-storage', 'default'), {
        arg: { kind: 'ident', name: 'TOKEN_KEY' },
        resolved: null,
        unresolved: 'imported-constant',
        binding: { kind: 'import', source: '@/api/urls', imported: 'TOKEN_KEY' },
      }, { value: 'GET', from: 'callee-name' }))], SCREEN_ON);
  assert.deepEqual(edgesOf(g), []);
  assert.equal(stats.calls.withUrl, 0);
  assert.equal(stats.calls.notUrlShaped, 1);
  assert.equal(stats.unresolved.total, 0);
});

test('a constant this lane never read stays unresolved, counted by its own reason', () => {
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null),
    ...file('src/api/rows.js',
      imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
      imp(2, 'some-package/urls', [{ imported: 'ROWS_URL', local: 'ROWS_URL' }]),
      fn(3, 'listRows'),
      call(4, 'listRows', memberCallee('client', 'get'), importBinding('@/http', 'default'), {
        arg: { kind: 'ident', name: 'ROWS_URL' },
        resolved: null,
        unresolved: 'imported-constant',
        binding: { kind: 'import', source: 'some-package/urls', imported: 'ROWS_URL' },
      }, { value: 'GET', from: 'callee-name' }))], SCREEN_ON);
  assert.deepEqual(edgesOf(g), []);
  assert.equal(stats.unresolved.byReason.importedConstant, 1);
});

// ---- B: a string method is never a sink (RM59) ----------------------------
//
// `pathname.startsWith('/auth/login/naver')` asks where the browser already is.
// The argument is path-shaped by construction and the callee reaches no client,
// which is exactly the shape of an untraced call, so it came out as a request to
// a route nothing serves.

const stringMethodFacts = (method) => [
  ALIAS, ...clientFile(null),
  ...file('src/api/rows.js',
    imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
    fn(3, 'onRoute'),
    call(4, 'onRoute', memberCallee('pathname', method), null,
      literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' })),
];

test('a call on a string method reaches no route, and is counted as itself', () => {
  for (const method of ['startsWith', 'endsWith', 'includes', 'indexOf', 'split', 'replace', 'test', 'match']) {
    const g = graphWithRoutes();
    const stats = addWebFacts(g, stringMethodFacts(method), SCREEN_ON);
    assert.deepEqual(edgesOf(g), [], `${method} placed an edge`);
    assert.equal(stats.calls.stringMethod, 1, `${method} was not counted`);
    assert.equal(stats.calls.withUrl, 0, `${method} was counted as a call`);
    assert.equal(stats.calls.notUrlShaped, 0, `${method} was counted under the wrong reason`);
  }
});

test('no method a declaration pack calls a VERB is on the list, so no real client can be silenced', () => {
  // The rule is what keeps `pathname.startsWith('/x')` out of the graph, and the
  // one way it could do harm is by naming a method some library really sends
  // with. Held mechanically against every pack the lane reads rather than by
  // reading the two lists side by side.
  const pack = httpClientPack();
  const verbs = new Set();
  const take = (o) => {
    for (const v of Object.keys(o.verbs ?? {})) verbs.add(v);
    for (const v of o.generic ?? []) verbs.add(v);
    for (const v of o.config?.methods ?? []) verbs.add(v);
    for (const v of o.instanceFactories ?? []) verbs.add(v);
  };
  for (const l of pack.libraries ?? []) take(l);
  for (const p of pack.platform ?? []) take(p);
  for (const i of pack.injected ?? []) take(i);
  assert.ok(verbs.size > 10, `expected the pack's verbs, found ${verbs.size}`);
  const clash = [...verbs].filter((v) => STRING_METHODS.has(v)).sort();
  assert.deepEqual(clash, [], `these are both a client verb and a string method: ${clash.join(', ')}`);
});

test('a project function named `split` that is CALLED by name is untouched', () => {
  // The rule needs a member call (`x.split(…)`). A bare call to something this
  // project declares is its own function, and silencing it would be a name rule.
  const g = graphWithRoutes();
  const stats = addWebFacts(g, [ALIAS, ...clientFile(null),
    ...file('src/api/rows.js',
      imp(1, '@/http', [{ imported: 'default', local: 'client' }]),
      fn(3, 'split'),
      exp(3, 'split', 'function', { local: 'split' }),
      call(4, 'split', memberCallee('client', 'get'), importBinding('@/http', 'default'),
        literalUrl('/plain/list'), { value: 'GET', from: 'callee-name' }))], SCREEN_ON);
  assert.equal(stats.calls.stringMethod, 0);
  assert.equal(only(g).to, webEndpointId('GET', '/plain/list'));
});
