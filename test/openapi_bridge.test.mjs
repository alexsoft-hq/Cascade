import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import {
  readYamlSubset, readOpenApiDocument, addOpenApiRoutes, serverBasePath, HTTP_VERBS,
} from '../src/adapters/openapi_bridge.mjs';

// The declaration layer (RM29). Two things are under test and they are not the
// same thing: whether the YAML subset reads what it claims to read AND refuses
// what it claims to refuse, and whether a document that has been read lands on
// the graph as corroboration rather than as a second opinion.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'openapi');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ---------------------------------------------------------------------------
// the YAML subset: what it reads
// ---------------------------------------------------------------------------

test('the YAML subset reads block mappings, sequences, scalars, comments and both flow forms', () => {
  const { value, unreadable } = readYamlSubset(`# a leading comment
name: plain
quoted: "a: colon inside"
single: 'it''s quoted'
number: 42
truthy: true
empty: null
url: http://localhost:8080/api   # a trailing comment
list:
  - one
  - two
flowSeq: [a, b, 'c, still one']
flowMap: { key: value, n: 3 }
nested:
  deeper:
    leaf: here
objects:
  - name: first
    value: 1
  - name: second
    value: 2
`);
  assert.deepEqual(unreadable, []);
  assert.equal(value.name, 'plain');
  assert.equal(value.quoted, 'a: colon inside');
  assert.equal(value.single, "it's quoted");
  assert.equal(value.number, 42);
  assert.equal(value.truthy, true);
  assert.equal(value.empty, null);
  assert.equal(value.url, 'http://localhost:8080/api', 'a colon inside a URL is not a key separator');
  assert.deepEqual(value.list, ['one', 'two']);
  assert.deepEqual(value.flowSeq, ['a', 'b', 'c, still one']);
  assert.deepEqual(value.flowMap, { key: 'value', n: 3 });
  assert.deepEqual(value.nested, { deeper: { leaf: 'here' } });
  assert.deepEqual(value.objects, [{ name: 'first', value: 1 }, { name: 'second', value: 2 }]);
});

test('a block scalar is kept as text, in both styles', () => {
  const { value, unreadable } = readYamlSubset(`literal: |
  first line
  second line
folded: >
  also two
  lines
after: back
`);
  assert.deepEqual(unreadable, []);
  assert.equal(value.literal, 'first line\nsecond line');
  assert.equal(value.folded, 'also two\nlines');
  assert.equal(value.after, 'back');
});

test('a key whose value is only a comment opens the block underneath it', () => {
  const { value } = readYamlSubset(`paths:   # every route
  /a:
    get:
      operationId: a
`);
  assert.deepEqual(Object.keys(value.paths), ['/a']);
});

// ---------------------------------------------------------------------------
// ...and what it refuses, BY NAME
// ---------------------------------------------------------------------------

const refused = (text) => readYamlSubset(text).unreadable;

test('an anchor, an alias, a tag, a tab and a second document are each refused by name', () => {
  const cases = [
    ['defaults: &common\n  a: 1\n', 'an anchor', 1],
    ['use: *common\n', 'an alias', 1],
    ['when: !!timestamp 2020-01-01\n', 'an explicit tag', 1],
    ['a: 1\n\tb: 2\n', 'a tab in the indentation', 2],
    ['a: 1\n---\nb: 2\n', 'a second YAML document', 2],
  ];
  for (const [text, construct, line] of cases) {
    const u = refused(text);
    assert.equal(u.length >= 1, true, `${construct} was not refused`);
    assert.equal(u[0].construct, construct);
    assert.equal(u[0].line, line, `${construct} was refused at the wrong line`);
    assert.match(u[0].reason, /outside the YAML subset/);
  }
});

test('an unterminated quote and an unterminated flow collection are refused, not half-read', () => {
  assert.equal(refused('a: "no end\n')[0].construct, 'an unterminated quoted scalar');
  assert.equal(refused('a: [1, 2\n')[0].construct, 'an unterminated flow sequence');
  assert.equal(refused('a: {k: v\n')[0].construct, 'an unterminated flow mapping');
});

test('the anchor fixture is refused with the line the anchor is on, and reads no route', () => {
  const doc = readOpenApiDocument(read('anchors.yaml'), { path: 'openapi/anchors.yaml' });
  assert.equal(doc.paths.length, 0, 'a document this reader refused must contribute no route at all');
  assert.equal(doc.unreadable.length >= 1, true);
  assert.equal(doc.unreadable[0].construct, 'an anchor');
  assert.equal(doc.unreadable[0].line, 5);
});

// ---------------------------------------------------------------------------
// reading a document
// ---------------------------------------------------------------------------

test('an OpenAPI 3 YAML: the base path comes from servers[0], every verb becomes a route', () => {
  const doc = readOpenApiDocument(read('shop.yaml'), { path: 'openapi/shop.yaml' });
  assert.deepEqual(doc.unreadable, []);
  assert.equal(doc.version, '3');
  assert.equal(doc.basePath, '/api', 'the path part of the FIRST server URL, and nothing from the second');
  assert.deepEqual(doc.paths.map((p) => `${p.method} ${p.path}`), [
    'ANY /api/health',
    'GET /api/item/get',
    'POST /api/item/price',
    'DELETE /api/report/daily',
    'GET /api/report/daily',
  ]);
  const get = doc.paths.find((p) => p.method === 'GET' && p.path === '/api/item/get');
  assert.equal(get.operationId, 'getItem');
  assert.equal(get.summary, 'Read one item');
  const report = doc.paths.find((p) => p.method === 'GET' && p.path === '/api/report/daily');
  assert.equal(report.summary, 'A report the code does not serve.\nTwo lines of it.',
    'a block-scalar summary survives as text');
  assert.equal(doc.paths.find((p) => p.path === '/api/health').method, 'ANY',
    'a path item with no verb still DECLARES the path');
});

test('a Swagger 2 JSON: basePath is the prefix, and the version is read from `swagger`', () => {
  const doc = readOpenApiDocument(read('legacy.json'), { path: 'openapi/legacy.json' });
  assert.deepEqual(doc.unreadable, []);
  assert.equal(doc.version, '2');
  assert.equal(doc.basePath, '/v1');
  assert.deepEqual(doc.paths.map((p) => `${p.method} ${p.path}`), ['GET /v1/item/get', 'GET /v1/legacy/ping']);
});

test('serverBasePath keeps a template as written and never invents a variable value', () => {
  assert.equal(serverBasePath('https://api.example.com/api/v2'), '/api/v2');
  assert.equal(serverBasePath('https://api.example.com'), '');
  assert.equal(serverBasePath('/api'), '/api');
  assert.equal(serverBasePath('https://{host}/v1'), '/v1');
  assert.equal(serverBasePath('{scheme}://api.example.com/v1'), '/v1',
    'the path is the path whatever the scheme variable turns out to be');
  assert.equal(serverBasePath('https://api.example.com/{stage}/v1'), '/{stage}/v1',
    'a variable IN THE PATH is left as written: substituting its default would invent a base path the document did not state');
  assert.equal(serverBasePath(''), '');
});

test('a document that does not parse, or has no paths, says so instead of contributing nothing quietly', () => {
  const bad = readOpenApiDocument('{ "openapi": "3.0.0", ', { path: 'a.json' });
  assert.equal(bad.paths.length, 0);
  assert.match(bad.unreadable[0].reason, /does not parse as JSON/);
  const noPaths = readOpenApiDocument('{ "openapi": "3.0.0" }', { path: 'b.json' });
  assert.match(noPaths.unreadable[0].reason, /no `paths` mapping/);
});

test('every HTTP verb a path item can carry is read', () => {
  const item = Object.fromEntries(HTTP_VERBS.map((v) => [v, { operationId: v }]));
  const doc = readOpenApiDocument(JSON.stringify({ openapi: '3.0.0', paths: { '/x': item } }), { path: 'v.json' });
  assert.deepEqual(doc.paths.map((p) => p.method).sort(), HTTP_VERBS.map((v) => v.toUpperCase()).sort());
});

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

const EP = (m, p) => nodeId('endpoint', `${m} ${p}`);

/** A graph with two SERVED routes and one the web lane invented as outbound. */
function servedGraph() {
  const g = new Graph();
  g.addNode({ id: EP('GET', '/api/item/get'), path: '/api/item/get', httpMethod: 'GET' });
  g.addNode({ id: EP('POST', '/api/item/price'), path: '/api/item/price', httpMethod: 'POST' });
  g.addNode({ id: nodeId('symbol', 'com.x.ItemController#get'), file: 'x/ItemController.java' });
  g.addEdge({ from: EP('GET', '/api/item/get'), to: nodeId('symbol', 'com.x.ItemController#get'), type: 'HANDLES', grade: 'EXACT' });
  // A route the FRONTEND names and nothing here serves: it is not corroboration.
  g.addNode({ id: EP('GET', '/api/gone'), path: '/api/gone', httpMethod: 'GET', outbound: true, source: 'web' });
  return g;
}

test('a route the code serves is CORROBORATED: no new node, no new edge, the document recorded on it', () => {
  const g = servedGraph();
  const before = g.edges.length;
  const doc = readOpenApiDocument(read('shop.yaml'), { path: 'openapi/shop.yaml' });
  const stats = addOpenApiRoutes(g, [doc]);

  const node = g.nodes.get(EP('GET', '/api/item/get'));
  assert.deepEqual(node.declaredBy, ['openapi/shop.yaml']);
  assert.equal(node.operationId, 'getItem');
  assert.equal(node.summary, 'Read one item');
  assert.equal(node.source, undefined, 'a node the code lane made keeps saying so');
  assert.equal(node.declared, undefined, 'only a route nothing serves is `declared`');
  assert.equal(g.edges.length, before, 'a declaration adds no edge to a route that already has a handler');
  assert.equal(stats.matchedServed, 2);
});

test('a route no code serves becomes a node with NO handler edge', () => {
  const g = servedGraph();
  const doc = readOpenApiDocument(read('shop.yaml'), { path: 'openapi/shop.yaml' });
  addOpenApiRoutes(g, [doc]);

  const id = EP('GET', '/api/report/daily');
  const node = g.nodes.get(id);
  assert.ok(node, 'the declared route is not in the graph');
  assert.equal(node.declared, true);
  assert.equal(node.source, 'openapi');
  assert.equal(node.operationId, 'dailyReport');
  assert.deepEqual(node.declaredBy, ['openapi/shop.yaml']);
  assert.equal(g.outEdges(id).length + g.inEdges(id).length, 0,
    'a declaration says a route exists and says nothing about what runs below it');
});

test('the drift census counts both directions, and only once a document was read', () => {
  const g = servedGraph();
  const doc = readOpenApiDocument(read('shop.yaml'), { path: 'openapi/shop.yaml' });
  const stats = addOpenApiRoutes(g, [doc]);
  assert.equal(stats.paths, 5);
  assert.equal(stats.matchedServed, 2, '/api/item/get and /api/item/price are served here');
  assert.deepEqual(stats.drift.onlyInDocument, [
    EP('ANY', '/api/health'), EP('DELETE', '/api/report/daily'), EP('GET', '/api/report/daily'),
  ]);
  assert.equal(stats.onlyInDocument, 3);
  assert.deepEqual(stats.drift.onlyInCode, [],
    'the two served routes are both declared, and the outbound one the web lane invented is not a served route');
  assert.deepEqual(stats.documents.map((d) => [d.path, d.paths, d.matchedServed, d.onlyInDocument]),
    [['openapi/shop.yaml', 5, 2, 3]]);
});

test('a served route no document declares is the other half of the census', () => {
  const g = servedGraph();
  g.addNode({ id: EP('GET', '/api/secret'), path: '/api/secret', httpMethod: 'GET' });
  const stats = addOpenApiRoutes(g, [readOpenApiDocument(read('shop.yaml'), { path: 'openapi/shop.yaml' })]);
  assert.deepEqual(stats.drift.onlyInCode, [EP('GET', '/api/secret')]);
  assert.equal(stats.onlyInCode, 1);
});

test('a document that could not be read declares nothing and claims no drift', () => {
  const g = servedGraph();
  const doc = readOpenApiDocument(read('anchors.yaml'), { path: 'openapi/anchors.yaml' });
  const stats = addOpenApiRoutes(g, [doc]);
  assert.equal(stats.paths, 0);
  assert.deepEqual(stats.drift.onlyInCode, [],
    'a document nobody could read must not make every served route look undocumented');
  assert.equal(stats.unreadable.length, 1);
  assert.equal(stats.unreadable[0].document, 'openapi/anchors.yaml');
});

test('two documents declaring the same route: declaredBy lists both, sorted, whatever order they arrive in', () => {
  const g = servedGraph();
  const a = readOpenApiDocument(read('shop.yaml'), { path: 'z-shop.yaml' });
  const b = readOpenApiDocument(JSON.stringify({
    openapi: '3.0.0', servers: [{ url: '/api' }],
    paths: { '/item/get': { get: { operationId: 'other', summary: 'another word for it' } } },
  }), { path: 'a-other.json' });

  const first = addOpenApiRoutes(g, [a, b]);
  assert.deepEqual(g.nodes.get(EP('GET', '/api/item/get')).declaredBy, ['a-other.json', 'z-shop.yaml']);
  assert.deepEqual(first.documents.map((d) => d.path), ['a-other.json', 'z-shop.yaml'],
    'the per-document rows are in path order, so the census does not depend on the argument order');

  const g2 = servedGraph();
  const second = addOpenApiRoutes(g2, [b, a]);
  assert.deepEqual(g2.nodes.get(EP('GET', '/api/item/get')).declaredBy, ['a-other.json', 'z-shop.yaml']);
  assert.deepEqual(second.documents, first.documents);
  assert.deepEqual(second.drift, first.drift);
});
