// assemble.test.mjs — the one core-owned "facts → Graph" seam (SPEC §4, I-3).
//
// `src/core/overlay.mjs` used to import the SQL and Java bridges directly, so
// the CORE depended on the ADAPTERS — the opposite of the direction the spec
// states. The assembly now lives here and takes the bridges as functions; the
// CLI wires the real ones. What these tests pin is that the seam really is
// injected (it cannot reach a lane on its own), that a lane runs only when its
// options are given, and that going through it produces exactly the graph the
// two bridges produce when called by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleGraph, AssembleError } from '../src/core/assemble.mjs';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { projectPack } from '../src/core/pack.mjs';

const CATALOG = [
  { kind: 'table', schema: null, table: 'shop_item', comment: 'items' },
  { kind: 'column', schema: null, table: 'shop_item', column: 'id', type: 'INT', comment: null, pk: true },
  { kind: 'column', schema: null, table: 'shop_item', column: 'name', type: 'VARCHAR(64)', comment: null },
];
const LINEAGE = [{
  kind: 'lineage', namespace: 'com.example.mapper.ItemMapper', id: 'selectById', type: 'select',
  tables: [{ table: 'shop_item', access: 'read' }],
  columns: [{ table: 'shop_item', column: 'name', access: 'read' }],
  joins: [], unresolved: [], file: 'src/main/resources/mapper/ItemMapper.xml', line: 8,
}];
const JAVA_FACTS = [
  { kind: 'type', fqn: 'com.example.web.ItemController', pkg: 'com.example.web', name: 'ItemController', file: 'src/main/java/com/example/web/ItemController.java', implementsSimple: [] },
  { kind: 'method', fqn: 'com.example.web.ItemController#get', owner: 'com.example.web.ItemController', line: 12 },
  { kind: 'endpoint', httpMethod: 'GET', path: '/item/get', handler: 'com.example.web.ItemController#get', line: 11, file: 'src/main/java/com/example/web/ItemController.java' },
];
const BRIDGES = { buildGraphFromSql, addJavaFacts };
const JAVA_OPTS = { packagePrefixes: ['com.example'] };

test('assembleGraph: with the real bridges it is byte-identical to calling them by hand', () => {
  const byHand = buildGraphFromSql(CATALOG, LINEAGE, { identifierCase: 'fold-lower' });
  addJavaFacts(byHand, JAVA_FACTS, JAVA_OPTS);

  const { graph, javaStats, jpaStats } = assembleGraph({
    bridges: BRIDGES, catalogRecords: CATALOG, lineageRecords: LINEAGE, javaFacts: JAVA_FACTS,
    identifierCase: 'fold-lower', java: JAVA_OPTS,
  });
  assert.equal(jpaStats, null);
  assert.equal(javaStats.endpoints, 1);
  assert.equal(projectPack(graph).digest, projectPack(byHand).digest);
});

test('assembleGraph: no java options — the code lane does not run at all', () => {
  const { graph, javaStats } = assembleGraph({
    bridges: BRIDGES, catalogRecords: CATALOG, lineageRecords: LINEAGE, javaFacts: JAVA_FACTS,
    identifierCase: 'fold-lower',
  });
  assert.equal(javaStats, null);
  assert.equal(graph.nodes.has(nodeId('endpoint', 'GET /item/get')), false);
  assert.equal(graph.nodes.has(nodeId('table', 'shop_item')), true);
});

test('assembleGraph: the identity rule is passed straight through to the SQL bridge', () => {
  const seen = [];
  const bridges = {
    buildGraphFromSql: (c, l, opts) => { seen.push(opts.identifierCase); return new Graph(); },
  };
  assembleGraph({ bridges, identifierCase: 'fold-upper' });
  assembleGraph({ bridges });
  assert.deepEqual(seen, ['fold-upper', 'exact']); // the default folds nothing
});

test('assembleGraph: the JPA bridge runs only when its options are given, over the SAME facts', () => {
  const calls = [];
  const bridges = {
    buildGraphFromSql: () => new Graph(),
    addJavaFacts: (g, facts, o) => { calls.push(['java', facts, o]); return { endpoints: 0 }; },
    addJpaFacts: (g, facts, o) => { calls.push(['jpa', facts, o]); return { entities: 2 }; },
  };
  const none = assembleGraph({ bridges, javaFacts: JAVA_FACTS, java: JAVA_OPTS });
  assert.equal(none.jpaStats, null);
  assert.deepEqual(calls.map((c) => c[0]), ['java']);

  const both = assembleGraph({ bridges, javaFacts: JAVA_FACTS, java: JAVA_OPTS, jpa: { schema: null } });
  assert.deepEqual(both.jpaStats, { entities: 2 });
  assert.deepEqual(calls.map((c) => c[0]), ['java', 'java', 'jpa']);
  // Both bridges see the one assembled fact stream, not two.
  assert.equal(calls[1][1], calls[2][1]);
});

test('assembleGraph: core cannot reach a lane on its own — a missing bridge is a loud error', () => {
  assert.throws(() => assembleGraph({}), AssembleError);
  assert.throws(() => assembleGraph({ bridges: {} }), AssembleError);
  assert.throws(
    () => assembleGraph({ bridges: { buildGraphFromSql: () => new Graph() }, java: JAVA_OPTS }),
    AssembleError,
  );
  assert.throws(
    () => assembleGraph({ bridges: { buildGraphFromSql: () => new Graph(), addJavaFacts: () => ({}) }, java: JAVA_OPTS, jpa: {} }),
    AssembleError,
  );
});

test('assembleGraph: a bridge that does not return a Graph is refused, not carried on with', () => {
  assert.throws(() => assembleGraph({ bridges: { buildGraphFromSql: () => ({ nodes: new Map() }) } }), AssembleError);
});

// ---------------------------------------------------------------------------
// The web lane (RM28)
// ---------------------------------------------------------------------------
//
// The web bridge is injected like the other three, and it runs LAST: it turns a
// frontend call into an edge onto an endpoint, and the endpoints are what the
// Java bridge put in the graph. An assembly that ran it first would find no
// route to attach anything to, which is a defect nothing else would catch.

const WEB_FACTS = [
  { kind: 'file', file: 'front/src/http.js', line: 1, lang: 'js', recoveredErrors: 0 },
  {
    kind: 'import', file: 'front/src/http.js', line: 1, source: 'axios', dynamic: false,
    specifiers: [{ imported: 'default', local: 'axios' }],
  },
  {
    kind: 'binding',
    file: 'front/src/http.js',
    line: 2,
    name: 'client',
    exported: true,
    init: {
      shape: 'call',
      callee: { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
      binding: { kind: 'import', source: 'axios', imported: 'default' },
    },
  },
  {
    kind: 'export', file: 'front/src/http.js', line: 3, name: 'default', of: 'expression', local: 'client',
  },
  { kind: 'file', file: 'front/src/api/item.js', line: 1, lang: 'js', recoveredErrors: 0 },
  {
    kind: 'import', file: 'front/src/api/item.js', line: 1, source: '../http', dynamic: false,
    specifiers: [{ imported: 'default', local: 'client' }],
  },
  {
    kind: 'function', file: 'front/src/api/item.js', line: 2, name: 'getItem', endLine: 4, exported: 'named', async: false, params: 0, returns: null,
  },
  {
    kind: 'call',
    file: 'front/src/api/item.js',
    line: 3,
    enclosing: 'getItem',
    callee: { shape: 'member', root: 'client', path: ['get'], name: 'get' },
    binding: { kind: 'import', source: '../http', imported: 'default' },
    args: [],
    url: { arg: { kind: 'string', value: '/item/get' }, resolved: [{ template: '/item/get', dynamicParts: 0, via: 'literal' }] },
    method: { value: 'GET', from: 'callee-name' },
    platformSink: null,
  },
];

test('assembleGraph: the web bridge is injected too, and runs after the routes exist', async () => {
  const { addWebFacts } = await import('../src/adapters/web_bridge.mjs');
  const { graph, webStats } = assembleGraph({
    bridges: { ...BRIDGES, addWebFacts },
    catalogRecords: CATALOG,
    lineageRecords: LINEAGE,
    javaFacts: JAVA_FACTS,
    webFacts: WEB_FACTS,
    identifierCase: 'fold-lower',
    java: JAVA_OPTS,
    web: { gatewayRoutes: {}, packages: [] },
  });
  const edge = graph.edges.find((e) => e.type === 'CALLS_HTTP');
  assert.ok(edge, 'the frontend call must have reached the route the Java lane declared');
  assert.equal(edge.from, nodeId('symbol', 'front/src/api/item.js#getItem'));
  assert.equal(edge.to, nodeId('endpoint', 'GET /item/get'));
  assert.equal(edge.grade, 'SOUND_SET');
  assert.equal(webStats.resolved.SOUND_SET, 1);
});

test('assembleGraph: no web options — the web lane does not run at all', async () => {
  const { addWebFacts } = await import('../src/adapters/web_bridge.mjs');
  const { graph, webStats } = assembleGraph({
    bridges: { ...BRIDGES, addWebFacts },
    catalogRecords: CATALOG,
    lineageRecords: LINEAGE,
    javaFacts: JAVA_FACTS,
    webFacts: WEB_FACTS,
    identifierCase: 'fold-lower',
    java: JAVA_OPTS,
  });
  assert.equal(webStats, null);
  assert.equal(graph.edges.some((e) => e.type === 'CALLS_HTTP'), false);
});

test('assembleGraph: web options with no bridge is an error, not a silent skip', () => {
  assert.throws(() => assembleGraph({
    bridges: BRIDGES, catalogRecords: CATALOG, lineageRecords: LINEAGE, javaFacts: JAVA_FACTS,
    webFacts: WEB_FACTS, identifierCase: 'fold-lower', java: JAVA_OPTS, web: { gatewayRoutes: {} },
  }), AssembleError);
});
