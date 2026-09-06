import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';
import { assembleJavaFacts, assembleWebFacts } from '../src/core/facts_store.mjs';
import { overlayGraph, classifyDirtyFiles, changeImpact, OverlayError } from '../src/core/overlay.mjs';
import { frontendCallsOf } from '../src/core/walks.mjs';

// The lane bridges, INJECTED — `src/core/` imports nothing from `src/adapters/`
// (SPEC §4, I-3; the gate is in test/gates.test.mjs). bin/cascade.mjs wires the
// same pair for `analyze` and for the live overlay.
const BRIDGES = { buildGraphFromSql, addJavaFacts, addWebFacts };

// The overlay COMPUTES (SPEC §10.2): the dirty files are re-parsed and a new
// graph is assembled from the cached shards of everything else. These tests
// drive that with synthetic facts — no JDK, no Python, no filesystem — so what
// is under test is the splice, the provisional marking and the promise that the
// base is left untouched.
//
// The fixture is one real chain:
//   GET /item/get -> ItemController#get -> ItemService#find -> (dispatch)
//   ItemServiceImpl#find -> ItemMapper#selectById -> statement -> shop_item.name
// and a SECOND mapper method the base never calls (updateStock -> shop_stock.qty),
// so "a service edit reaches a new table" can be expressed as one added call.

const CONTROLLER = 'src/main/java/com/example/web/ItemController.java';
const SERVICE = 'src/main/java/com/example/service/ItemService.java';
const IMPL = 'src/main/java/com/example/service/impl/ItemServiceImpl.java';
const MAPPER = 'src/main/java/com/example/mapper/ItemMapper.java';
const NEW_CONTROLLER = 'src/main/java/com/example/web/ExtraController.java';
const MAPPER_XML = 'src/main/resources/mapper/ItemMapper.xml';

const CATALOG = [
  { kind: 'table', schema: null, table: 'shop_item', comment: 'items' },
  { kind: 'column', schema: null, table: 'shop_item', column: 'id', type: 'INT', comment: null, pk: true },
  { kind: 'column', schema: null, table: 'shop_item', column: 'name', type: 'VARCHAR(64)', comment: 'item name' },
  { kind: 'table', schema: null, table: 'shop_stock', comment: 'stock' },
  { kind: 'column', schema: null, table: 'shop_stock', column: 'qty', type: 'INT', comment: 'quantity' },
];

const LINEAGE = [
  {
    kind: 'lineage', namespace: 'com.example.mapper.ItemMapper', id: 'selectById', type: 'select',
    tables: [{ table: 'shop_item', access: 'read' }],
    columns: [{ table: 'shop_item', column: 'id', access: 'read' }, { table: 'shop_item', column: 'name', access: 'read' }],
    joins: [], unresolved: [], file: MAPPER_XML, line: 4,
  },
  {
    kind: 'lineage', namespace: 'com.example.mapper.ItemMapper', id: 'updateStock', type: 'update',
    tables: [{ table: 'shop_stock', access: 'write' }],
    columns: [{ table: 'shop_stock', column: 'qty', access: 'write' }],
    joins: [], unresolved: [], file: MAPPER_XML, line: 9,
  },
];

const type = (fqn, file, extra = {}) => ({
  kind: 'type', fqn, typeKind: 'class', package: fqn.slice(0, fqn.lastIndexOf('.')),
  annotations: [], implements: [], extends: null, file, ...extra,
});
const method = (fqn, file, line) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.indexOf('#')), name: fqn.slice(fqn.indexOf('#') + 1), paramCount: 1, line, file });
const call = (from, toTypeSimple, m, file) => ({ kind: 'call', from, method: m, toTypeSimple, file });
const imp = (owner, simple, fqn, file) => ({ kind: 'import', owner, simple, fqn, file });

/** The base tree's per-file shards, exactly as the CAS holds them. */
function baseShardMap() {
  return new Map([
    [CONTROLLER, [
      type('com.example.web.ItemController', CONTROLLER, { annotations: ['RestController'] }),
      imp('com.example.web.ItemController', 'ItemService', 'com.example.service.ItemService', CONTROLLER),
      method('com.example.web.ItemController#get', CONTROLLER, 12),
      { kind: 'endpoint', httpMethod: 'GET', path: '/item/get', handler: 'com.example.web.ItemController#get', line: 12, file: CONTROLLER },
      call('com.example.web.ItemController#get', 'ItemService', 'find', CONTROLLER),
    ]],
    [SERVICE, [
      type('com.example.service.ItemService', SERVICE, { typeKind: 'interface' }),
      method('com.example.service.ItemService#find', SERVICE, 5),
    ]],
    [IMPL, [
      type('com.example.service.impl.ItemServiceImpl', IMPL, { implements: ['ItemService'] }),
      imp('com.example.service.impl.ItemServiceImpl', 'ItemService', 'com.example.service.ItemService', IMPL),
      imp('com.example.service.impl.ItemServiceImpl', 'ItemMapper', 'com.example.mapper.ItemMapper', IMPL),
      method('com.example.service.impl.ItemServiceImpl#find', IMPL, 9),
      call('com.example.service.impl.ItemServiceImpl#find', 'ItemMapper', 'selectById', IMPL),
    ]],
    [MAPPER, [
      type('com.example.mapper.ItemMapper', MAPPER, { typeKind: 'interface', annotations: ['Mapper'] }),
      method('com.example.mapper.ItemMapper#selectById', MAPPER, 4),
      method('com.example.mapper.ItemMapper#updateStock', MAPPER, 6),
    ]],
  ]);
}

const PREFIXES = ['com.example'];

// ---- the frontend, in the shapes adapters/web/webfacts.mjs really emits -----
const WEB_API = 'front/src/api/items.js';
const WEB_VIEW = 'front/src/views/Items.vue';
const WEB_NEW = 'front/src/api/stock.js';
const WEB_ROOTS = ['front/src'];
const WEB_CONFIG = [
  { kind: 'config', file: 'front/.env.development', line: 1, what: 'env', name: 'VUE_APP_BASE', value: '', mode: 'development' },
];

const webCall = (file, enclosing, url, line) => ({
  kind: 'call', file, line, enclosing,
  callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
  binding: { kind: 'global', name: 'fetch' },
  args: [{ kind: 'string', value: url }, { kind: 'object', keys: { method: { kind: 'string', value: 'GET' } } }],
  url: { arg: { kind: 'string', value: url }, resolved: [{ template: url, dynamicParts: 0, via: 'literal' }] },
  method: { value: 'GET', from: 'positional' },
  platformSink: 'fetch',
});
const webFn = (file, name, line) => ({
  kind: 'function', file, line, name, endLine: line + 2, exported: 'named', async: false, params: 1, returns: null,
});

function webShardMap() {
  return new Map([
    [WEB_API, [
      { kind: 'file', file: WEB_API, line: 1, lang: 'js', recoveredErrors: 0 },
      webFn(WEB_API, 'getItem', 1),
      webCall(WEB_API, 'getItem', '/item/get', 2),
    ]],
    [WEB_VIEW, [
      { kind: 'file', file: WEB_VIEW, line: 1, lang: 'vue', recoveredErrors: 0, blocks: [{ lang: 'js', setup: false, line: 5 }] },
    ]],
  ]);
}

function buildBaseGraph(shards, webShards = webShardMap()) {
  const g = buildGraphFromSql(CATALOG, LINEAGE);
  addJavaFacts(g, assembleJavaFacts(shards), { packagePrefixes: PREFIXES });
  addWebFacts(g, assembleWebFacts(webShards, WEB_CONFIG), { gatewayRoutes: {}, packages: [] });
  return g;
}

const SESSION = 'a'.repeat(64);
const snapshot = (shards) => JSON.stringify([...shards.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** Everything the overlay needs except the edit itself. */
function overlayOver({
  dirtyFacts = new Map(), dropFiles = [], dirtyFiles = [],
  webDirtyFacts = new Map(), webDropFiles = [], webConfigRecords = WEB_CONFIG,
}) {
  const baseShards = baseShardMap();
  const webBaseShards = webShardMap();
  const baseGraph = buildBaseGraph(baseShardMap());
  const before = snapshot(baseShards) + snapshot(webBaseShards);
  const r = overlayGraph({
    bridges: BRIDGES,
    baseShards, dirtyFacts, dropFiles, catalogRecords: CATALOG, lineageRecords: LINEAGE,
    webBaseShards, webDirtyFacts, webDropFiles, webConfigRecords,
    web: { gatewayRoutes: {}, packages: [] },
    baseGraph, overlaySessionId: SESSION, dirtyFiles, packagePrefixes: PREFIXES,
  });
  return { ...r, baseGraph, baseShards, webBaseShards, before, after: snapshot(baseShards) + snapshot(webBaseShards) };
}

const columnsFrom = (graph, file) => changeImpact(graph, [file]).downstreamColumns.map((c) => c.id);
const endpointsFrom = (graph, file) => changeImpact(graph, [file]).upstreamEndpoints.map((e) => e.id);

// ---------------------------------------------------------------------------

test('the base chain is what the fixture claims (nothing below means anything otherwise)', () => {
  const g = buildBaseGraph(baseShardMap());
  assert.ok(g.nodes.has('endpoint:GET /item/get'));
  assert.ok(g.nodes.has('column:shop_stock.qty'));
  assert.deepEqual(columnsFrom(g, IMPL), ['column:shop_item.id', 'column:shop_item.name'],
    'the base service reaches only what selectById reads');
});

test('(a) a service edit that calls a NEW mapper method makes the endpoint reach a new table', () => {
  // The edit: ItemServiceImpl#find now also calls ItemMapper.updateStock.
  const edited = baseShardMap().get(IMPL).concat([call('com.example.service.impl.ItemServiceImpl#find', 'ItemMapper', 'updateStock', IMPL)]);
  const { graph } = overlayOver({ dirtyFacts: new Map([[IMPL, edited]]), dirtyFiles: [IMPL] });

  const cols = columnsFrom(graph, IMPL);
  assert.ok(cols.includes('column:shop_stock.qty'), `the new table is not reached: ${cols.join(', ')}`);
  // and the endpoint above it now reaches that column too
  const reached = graph.reach('endpoint:GET /item/get', { direction: 'out', mode: 'conservative' });
  assert.ok(reached.has('column:shop_stock.qty'), 'the endpoint does not reach the new column through the edited service');
  // The base is untouched: the same query on the base graph still says no.
  assert.equal(columnsFrom(buildBaseGraph(baseShardMap()), IMPL).includes('column:shop_stock.qty'), false);
});

test('(a2) an edge out of an edited file carries the overlaySessionId as provenance', () => {
  const edited = baseShardMap().get(IMPL).concat([call('com.example.service.impl.ItemServiceImpl#find', 'ItemMapper', 'updateStock', IMPL)]);
  const { graph, taggedEdges } = overlayOver({ dirtyFacts: new Map([[IMPL, edited]]), dirtyFiles: [IMPL] });
  const e = graph.edges.find((x) => x.from === 'symbol:com.example.service.impl.ItemServiceImpl#find' && x.to === 'symbol:com.example.mapper.ItemMapper#updateStock');
  assert.ok(e, 'the new call edge is missing');
  assert.equal(e.evidence.overlaySessionId, SESSION);
  assert.ok(taggedEdges >= 1);
  // An edge with no dirty file on either end is NOT tagged: the marker means
  // "this came out of the overlay", so it may not be sprayed over the base.
  const untouched = graph.edges.find((x) => x.from === 'statement:com.example.mapper.ItemMapper.selectById' && x.type === 'READS');
  assert.equal(untouched.evidence?.overlaySessionId, undefined);
});

test('(b) a brand-new controller file is PROVISIONAL — node and edge, never a grade', () => {
  const facts = [
    type('com.example.web.ExtraController', NEW_CONTROLLER, { annotations: ['RestController'] }),
    imp('com.example.web.ExtraController', 'ItemService', 'com.example.service.ItemService', NEW_CONTROLLER),
    method('com.example.web.ExtraController#get', NEW_CONTROLLER, 10),
    { kind: 'endpoint', httpMethod: 'GET', path: '/extra/get', handler: 'com.example.web.ExtraController#get', line: 10, file: NEW_CONTROLLER },
    call('com.example.web.ExtraController#get', 'ItemService', 'find', NEW_CONTROLLER),
  ];
  const { graph, provisional } = overlayOver({ dirtyFacts: new Map([[NEW_CONTROLLER, facts]]), dirtyFiles: [NEW_CONTROLLER] });

  const ep = graph.nodes.get('endpoint:GET /extra/get');
  assert.ok(ep, 'the new endpoint is not in the overlay graph');
  assert.equal(ep.provisional, true);
  assert.equal(graph.nodes.get('symbol:com.example.web.ExtraController#get').provisional, true);
  assert.ok(provisional.endpoints.includes('endpoint:GET /extra/get'));
  assert.ok(provisional.symbols.includes('symbol:com.example.web.ExtraController#get'));
  const handles = graph.edges.find((e) => e.from === 'endpoint:GET /extra/get' && e.type === 'HANDLES');
  assert.equal(handles.provisional, true);
  assert.equal(handles.grade, 'EXACT', 'PROVISIONAL is a MARKER — the grade lattice is untouched (I-1)');
  assert.ok(provisional.edges >= 2);

  // A node the base already had is NOT provisional, even when the new file points at it.
  assert.equal(graph.nodes.get('symbol:com.example.service.ItemService#find').provisional, undefined);
  // and the new endpoint really reaches the base column through the existing chain
  assert.ok(endpointsFrom(graph, NEW_CONTROLLER).includes('endpoint:GET /extra/get'));
});

test('(c) deleting a file removes its symbols and its handler from the overlay', () => {
  const { graph } = overlayOver({ dropFiles: [CONTROLLER], dirtyFiles: [CONTROLLER] });
  assert.equal(graph.nodes.has('symbol:com.example.web.ItemController#get'), false);
  // The ROUTE survives, because the frontend still calls it: what is left is an
  // endpoint with no handler, which is what deleting the controller really did.
  assert.equal(graph.edges.some((e) => e.to === 'endpoint:GET /item/get' && e.type === 'HANDLES'), false);
  assert.equal(graph.nodes.get('endpoint:GET /item/get').outbound, true);
  // What the deleted file called is still there — only its own facts left.
  assert.ok(graph.nodes.has('symbol:com.example.service.ItemService#find'));
  assert.ok(graph.nodes.has('column:shop_item.name'));
});

test('(d) the base shards and the base graph are byte-identical after an overlay', () => {
  const edited = baseShardMap().get(IMPL).concat([call('com.example.service.impl.ItemServiceImpl#find', 'ItemMapper', 'updateStock', IMPL)]);
  const r = overlayOver({ dirtyFacts: new Map([[IMPL, edited]]), dropFiles: [], dirtyFiles: [IMPL] });
  assert.equal(r.after, r.before, 'the overlay mutated the cached base shards');
  // and the base GRAPH carries no overlay marks
  for (const n of r.baseGraph.nodes.values()) assert.equal(n.provisional, undefined);
  for (const e of r.baseGraph.edges) assert.equal(e.evidence?.overlaySessionId, undefined);
  assert.equal(r.baseGraph.nodes.has('column:shop_stock.qty'), true);
  assert.equal(columnsFrom(r.baseGraph, IMPL).includes('column:shop_stock.qty'), false,
    'the base graph learned the edit — the overlay is not isolated');
});

test('a statement the base never had is provisional too (a new mapper statement)', () => {
  const baseShards = baseShardMap();
  const lineage = LINEAGE.concat([{
    kind: 'lineage', namespace: 'com.example.mapper.ItemMapper', id: 'deleteById', type: 'delete',
    tables: [{ table: 'shop_item', access: 'delete' }], columns: [], joins: [], unresolved: [], file: MAPPER_XML, line: 20,
  }]);
  const { graph, provisional } = (() => {
    const r = overlayGraph({
      bridges: BRIDGES,
      baseShards, dirtyFacts: new Map(), dropFiles: [], catalogRecords: CATALOG, lineageRecords: lineage,
      baseGraph: buildBaseGraph(baseShardMap()), overlaySessionId: SESSION, dirtyFiles: [MAPPER_XML], packagePrefixes: PREFIXES,
    });
    return r;
  })();
  assert.equal(graph.nodes.get('statement:com.example.mapper.ItemMapper.deleteById').provisional, true);
  assert.deepEqual(provisional.statements, ['statement:com.example.mapper.ItemMapper.deleteById']);
});

test('overlayGraph refuses to run without a base graph or a session id', () => {
  const args = { bridges: BRIDGES, baseShards: baseShardMap(), catalogRecords: CATALOG, lineageRecords: LINEAGE, baseGraph: buildBaseGraph(baseShardMap()), overlaySessionId: SESSION };
  assert.throws(() => overlayGraph({ ...args, baseGraph: null }), OverlayError);
  assert.throws(() => overlayGraph({ ...args, overlaySessionId: '' }), OverlayError);
  assert.throws(() => overlayGraph({ ...args, baseShards: {} }), OverlayError);
});

// ---------------------------------------------------------------------------
// the frontend in the overlay (RM29)
// ---------------------------------------------------------------------------

test('(e) an edited .vue that now calls a route is PROVISIONAL, and the route it calls is the answer', () => {
  const edited = webShardMap().get(WEB_VIEW).concat([
    webFn(WEB_VIEW, 'load', 8),
    webCall(WEB_VIEW, 'load', '/item/get', 9),
  ]);
  const { graph, provisional, webStats } = overlayOver({
    webDirtyFacts: new Map([[WEB_VIEW, edited]]), dirtyFiles: [WEB_VIEW],
  });

  const sym = 'symbol:front/src/views/Items.vue#load';
  assert.equal(graph.nodes.get(sym).provisional, true, 'the base graph never saw this function');
  assert.ok(provisional.symbols.includes(sym));
  const edge = graph.edges.find((e) => e.from === sym && e.type === 'CALLS_HTTP');
  assert.ok(edge, 'the frontend call did not become an edge');
  assert.equal(edge.to, 'endpoint:GET /item/get');
  assert.equal(edge.provisional, true);
  assert.equal(edge.grade, 'SOUND_SET', 'PROVISIONAL is a MARKER, not a grade (I-1)');
  assert.equal(edge.evidence.overlaySessionId, SESSION, 'an edge out of a re-read file carries its provenance');
  assert.ok(webStats && webStats.calls.withUrl >= 2, JSON.stringify(webStats));

  // The answer a reader asks for: the routes this edit calls, and the columns
  // those routes reach.
  const r = changeImpact(graph, [WEB_VIEW]);
  assert.deepEqual(r.touched.webSymbols, [sym]);
  assert.deepEqual(r.touched.symbols, [], 'a frontend function is not a java symbol');
  assert.deepEqual(r.calledEndpoints.map((e) => e.id), ['endpoint:GET /item/get']);
  assert.deepEqual(r.downstreamColumns.map((c) => c.id), ['column:shop_item.id', 'column:shop_item.name']);
  assert.deepEqual(r.upstreamEndpoints, [], 'nothing in this graph calls a screen');
});

test('(f) a deleted frontend file takes its calls with it, and the base is untouched', () => {
  const { graph, baseGraph, before, after } = overlayOver({ webDropFiles: [WEB_API], dirtyFiles: [WEB_API] });
  assert.equal(graph.nodes.has('symbol:front/src/api/items.js#getItem'), false);
  assert.equal(graph.edges.some((e) => e.type === 'CALLS_HTTP'), false);
  assert.equal(baseGraph.nodes.has('symbol:front/src/api/items.js#getItem'), true, 'the base learned the deletion');
  assert.equal(after, before, 'the overlay mutated the cached shards');
});

test('(g) an edited controller says how many frontend functions call the route it serves', () => {
  const { graph } = overlayOver({
    dirtyFacts: new Map([[CONTROLLER, baseShardMap().get(CONTROLLER)]]), dirtyFiles: [CONTROLLER],
  });
  const r = changeImpact(graph, [CONTROLLER]);
  assert.ok(r.upstreamEndpoints.some((e) => e.id === 'endpoint:GET /item/get'));
  assert.equal(frontendCallsOf(graph, 'endpoint:GET /item/get'), 1,
    'one frontend function calls this route, and the row is what says so');
});

test('(h) the package configuration is read fresh: a new base URL moves the edge, with no shard touched', () => {
  // The same frontend, the same shards; only the package's declared base URL
  // moved. Nothing cached could have told us that.
  const moved = overlayOver({
    dirtyFiles: ['front/.env.development'],
    webConfigRecords: [
      { kind: 'config', file: 'front/.env.development', line: 1, what: 'env', name: 'VUE_APP_BASE', value: '/gw', mode: 'development' },
      { kind: 'config', file: 'front/vue.config.js', line: 3, what: 'proxy', context: '/gw', target: 'http://localhost:8080', rewrite: null },
    ],
  });
  const edge = moved.graph.edges.find((e) => e.type === 'CALLS_HTTP');
  assert.ok(edge, 'the call is still an edge');
  assert.equal(edge.to, 'endpoint:GET /item/get',
    'the proxy rule explains the new base, so the call still lands on the route it always did');
  assert.equal(moved.after, moved.before, 'a config re-read must not touch a shard');
});

// ---------------------------------------------------------------------------
// classifyDirtyFiles — which lane claims a dirty path
// ---------------------------------------------------------------------------

const SELECTION = { javaRoots: ['src/main/java'], mapperDirs: ['src/main/resources/mapper'], webRoots: WEB_ROOTS, ddl: 'schema.sql' };

test('classifyDirtyFiles routes each path to the lane that can consume it', () => {
  const c = classifyDirtyFiles([
    { status: 'M', path: IMPL },
    { status: 'A', path: NEW_CONTROLLER },
    { status: 'D', path: CONTROLLER },
    { status: 'M', path: MAPPER_XML },
    { status: 'M', path: 'schema.sql' },
    { status: 'M', path: 'src/main/resources/application.properties' },
    { status: 'M', path: 'web/src/App.vue' },
    { status: 'M', path: 'src/test/java/com/example/ItemTest.java' },
    { status: 'M', path: WEB_VIEW },
    { status: 'A', path: WEB_NEW },
    { status: 'D', path: WEB_API },
    { status: 'M', path: 'front/.env.development' },
    { status: 'M', path: 'front/src/types/thing.d.ts' },
  ], SELECTION);
  assert.deepEqual(c.java, [NEW_CONTROLLER, IMPL].sort());
  assert.deepEqual(c.javaDeleted, [CONTROLLER]);
  assert.deepEqual(c.xml, [MAPPER_XML]);
  assert.deepEqual(c.ddl, ['schema.sql']);
  assert.deepEqual(c.web, [WEB_NEW, WEB_VIEW].sort());
  assert.deepEqual(c.webDeleted, [WEB_API]);
  assert.deepEqual(c.webConfig, ['front/.env.development']);
  assert.deepEqual(c.other, [
    'front/src/types/thing.d.ts',
    'src/main/resources/application.properties',
    'src/test/java/com/example/ItemTest.java',
    'web/src/App.vue',
  ], 'a path no lane claims is REPORTED, not dropped — a .vue outside every web root and a type declaration included');
});

test('classifyDirtyFiles: a frontend path both deleted and present is present', () => {
  const c = classifyDirtyFiles([{ status: 'D', path: WEB_API }, { status: 'A', path: WEB_API }], SELECTION);
  assert.deepEqual(c.web, [WEB_API]);
  assert.deepEqual(c.webDeleted, []);
});

test('classifyDirtyFiles: with no web root, a frontend file and its config are unclaimed', () => {
  const c = classifyDirtyFiles(
    [{ status: 'M', path: WEB_VIEW }, { status: 'M', path: 'front/.env.development' }],
    { javaRoots: ['src/main/java'], mapperDirs: [], ddl: null },
  );
  assert.deepEqual(c.web, []);
  assert.deepEqual(c.webConfig, []);
  assert.deepEqual(c.other, ['front/.env.development', WEB_VIEW].sort());
});

test('classifyDirtyFiles: a path both deleted and present is present (a rename onto it)', () => {
  const c = classifyDirtyFiles([{ status: 'D', path: IMPL }, { status: 'A', path: IMPL }], SELECTION);
  assert.deepEqual(c.java, [IMPL]);
  assert.deepEqual(c.javaDeleted, []);
});

test('classifyDirtyFiles rejects a file with no path rather than silently skipping it', () => {
  assert.throws(() => classifyDirtyFiles([{ status: 'M' }], SELECTION), OverlayError);
  assert.throws(() => classifyDirtyFiles('nope', SELECTION), OverlayError);
});
