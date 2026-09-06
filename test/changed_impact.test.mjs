import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts, endpointsAffectingColumn } from '../src/adapters/java_bridge.mjs';
import { changed_impact, ToolError } from '../src/mcp/tools.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixture — same shape as test/overlay.test.mjs: pms_product SQL fixture
// stitched with a Java lane whose `type` records carry `file`, and a real
// Controller -> ServiceImpl -> Mapper call chain. Editing SERVICE_FILE crosses
// a MAY_CALL edge to reach the endpoint, so it reliably grades SOUND_SET
// (unlike editing the controller's own file, whose endpoint node shares that
// same file and would self-match at EXACT) — see test/overlay.test.mjs for
// the full derivation.
// ---------------------------------------------------------------------------

const CONTROLLER_FILE = 'src/main/java/com/x/PmsProductController.java';
const SERVICE_FILE = 'src/main/java/com/x/PmsProductServiceImpl.java';
const MAPPER_JAVA_FILE = 'src/main/java/com/x/PmsProductMapper.java';
const MAPPER_XML_FILE = 'PmsProductMapper.xml';

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product catalog table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'name', type: 'VARCHAR(100)', comment: 'product display name' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10,2)', comment: 'unit price' },
  ];
}

function lineageRecords() {
  return [
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'updateByPrimaryKey', type: 'update',
      tables: [{ table: 'pms_product', access: 'write' }],
      columns: [
        { table: 'pms_product', column: 'price', access: 'write' },
        { table: 'pms_product', column: 'name', access: 'write' },
        { table: 'pms_product', column: 'id', access: 'read' },
      ],
      file: MAPPER_XML_FILE, line: 10,
    },
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'pms_product', access: 'read' }],
      columns: [
        { table: 'pms_product', column: 'id', access: 'read' },
        { table: 'pms_product', column: 'name', access: 'read' },
        { table: 'pms_product', column: 'price', access: 'read' },
      ],
      file: MAPPER_XML_FILE, line: 30,
    },
  ];
}

function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.PmsProductController', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [], extends: null, file: CONTROLLER_FILE },
    { kind: 'type', fqn: 'com.x.PmsProductServiceImpl', typeKind: 'class', package: 'com.x', implements: [], extends: null, file: SERVICE_FILE },
    { kind: 'type', fqn: 'PmsProductMapper', typeKind: 'interface', package: '', implements: [], extends: null, file: MAPPER_JAVA_FILE },
    { kind: 'import', owner: 'com.x.PmsProductController', simple: 'PmsProductServiceImpl', fqn: 'com.x.PmsProductServiceImpl' },
    { kind: 'import', owner: 'com.x.PmsProductServiceImpl', simple: 'PmsProductMapper', fqn: 'PmsProductMapper' },
    { kind: 'field', owner: 'com.x.PmsProductController', name: 'productService', typeSimple: 'PmsProductServiceImpl' },
    { kind: 'field', owner: 'com.x.PmsProductServiceImpl', name: 'productMapper', typeSimple: 'PmsProductMapper' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/product/update', handler: 'com.x.PmsProductController#update', handlerType: 'com.x.PmsProductController' },
    { kind: 'call', from: 'com.x.PmsProductController#update', receiver: 'productService', method: 'updateByPrimaryKey', toTypeSimple: 'PmsProductServiceImpl' },
    { kind: 'call', from: 'com.x.PmsProductServiceImpl#updateByPrimaryKey', receiver: 'productMapper', method: 'updateByPrimaryKey', toTypeSimple: 'PmsProductMapper' },
    { kind: 'method', fqn: 'PmsProductMapper#updateByPrimaryKey', owner: 'PmsProductMapper', name: 'updateByPrimaryKey', paramCount: 1 },
  ];
}

function stitchedGraph() {
  const g = buildGraphFromSql(catalogRecords(), lineageRecords());
  addJavaFacts(g, javaFacts());
  return g;
}

function basis() {
  return { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } };
}
function ctx(graph) {
  return { graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' } };
}

// ---------------------------------------------------------------------------

test('changed_impact: args.files with an owned file is contract-valid, stamped provisional-overlay, with SOUND_SET upstream endpoints', () => {
  const g = stitchedGraph();
  const resp = changed_impact(g, { files: [SERVICE_FILE] }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  assert.ok(resp.answer.upstreamEndpoints.length > 0, 'expected at least one upstream endpoint');
  for (const e of resp.answer.upstreamEndpoints) assert.equal(e.grade, 'SOUND_SET');
});

test('changed_impact: downstreamColumns lists only what the reached SQL names — not every column of a touched table', () => {
  const g = stitchedGraph();
  // pms_product declares a fourth column that no mapper in this fixture names.
  const stock = nodeId('column', 'pms_product.stock');
  g.addNode({ id: stock, name: 'stock' });
  g.addEdge({ from: nodeId('table', 'pms_product'), to: stock, type: 'DECLARES', grade: 'EXACT' });

  const resp = changed_impact(g, { files: [SERVICE_FILE] }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const cols = resp.answer.downstreamColumns.map((c) => c.id);
  assert.deepEqual(cols.sort(), ['pms_product.id', 'pms_product.name', 'pms_product.price']);
  assert.equal(cols.includes('pms_product.stock'), false, 'DECLARES is schema, not something this edit runs through');
  assert.ok(g.reach(nodeId('symbol', 'com.x.PmsProductServiceImpl#updateByPrimaryKey'), { direction: 'out', mode: 'conservative' }).has(stock),
    'the DECLARES edge is present — an unfiltered walk would have claimed stock too');
});

test('changed_impact: ctx.changedFiles as a function is used when args.files is absent', () => {
  const g = stitchedGraph();
  const c = ctx(g);
  c.changedFiles = () => [SERVICE_FILE];
  const resp = changed_impact(g, {}, c);
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.changedFiles, 1);
  assert.ok(resp.answer.files.matched.includes(SERVICE_FILE));
});

test('changed_impact: ctx.changedFiles as an array is used when args.files is absent', () => {
  const g = stitchedGraph();
  const c = ctx(g);
  c.changedFiles = [SERVICE_FILE];
  const resp = changed_impact(g, {}, c);
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.changedFiles, 1);
  assert.ok(resp.answer.files.matched.includes(SERVICE_FILE));
});

test('changed_impact: no files in args or ctx throws ToolError bad-input', () => {
  const g = stitchedGraph();
  assert.throws(
    () => changed_impact(g, {}, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('changed_impact: an unmatched changed file adds a "changed-files" limits entry, and answer.empty carries reasons when both result lists are empty', () => {
  const g = stitchedGraph();
  const resp = changed_impact(g, { files: ['does/not/exist.js'] }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.upstreamEndpoints, []);
  assert.deepEqual(resp.answer.downstreamColumns, []);
  assert.ok(resp.answer.empty && resp.answer.empty.upstreamEndpoints);
  assert.ok(resp.answer.empty && resp.answer.empty.downstreamColumns);
  assert.deepEqual(resp.answer.files.unmatched, ['does/not/exist.js']);

  const lim = resp.limits.find((l) => l.scope === 'changed-files');
  assert.ok(lim, 'expected a changed-files limit entry');
  assert.ok(lim.reason.includes('1 changed file'), `expected the count of unmatched files in the reason, got: ${lim.reason}`);
});

test('changed_impact: an invalid mode throws ToolError bad-input', () => {
  const g = stitchedGraph();
  assert.throws(
    () => changed_impact(g, { files: [SERVICE_FILE], mode: 'loose' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

// ---------------------------------------------------------------------------
// RM4 — the LIVE overlay on the context (SPEC §10.2, §10.3)
// ---------------------------------------------------------------------------
// The tool now answers over the graph the CLI/server built from the bytes on
// disk, when one is attached. These tests drive that with a hand-built overlay
// (the graph assembly itself is tested in test/overlay_graph.test.mjs) and
// check the three things a consumer reads: the verdict, the provisional marks,
// and the disclosure block.

/** The base graph plus one endpoint that exists ONLY in the overlay. */
function overlayGraphFixture() {
  const g = stitchedGraph();
  const epId = nodeId('endpoint', 'GET /product/preview');
  const symId = nodeId('symbol', 'com.x.PmsProductPreviewController#preview');
  g.addNode({ id: epId, path: '/product/preview', httpMethod: 'GET', handler: 'com.x.PmsProductPreviewController#preview', file: 'src/main/java/com/x/PmsProductPreviewController.java', provisional: true });
  g.addNode({ id: symId, symbol: 'com.x.PmsProductPreviewController#preview', owner: 'com.x.PmsProductPreviewController', file: 'src/main/java/com/x/PmsProductPreviewController.java', provisional: true });
  g.addEdge({ from: epId, to: symId, type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: symId, to: nodeId('symbol', 'com.x.PmsProductServiceImpl#updateByPrimaryKey'), type: 'MAY_CALL', grade: 'SOUND_SET' });
  return g;
}

function appliedOverlay(graph, over = {}) {
  return {
    applied: true, state: 'fresh', graph,
    session: { overlaySessionId: 'f'.repeat(64), baseCommit: 'c'.repeat(40), headCommit: 'c'.repeat(40), docVersions: { [SERVICE_FILE]: '1'.repeat(64) } },
    dirtyFiles: [SERVICE_FILE], parsedFiles: [SERVICE_FILE], droppedFiles: [], unmatched: [],
    provisional: { symbols: ['symbol:com.x.PmsProductPreviewController#preview'], endpoints: ['endpoint:GET /product/preview'], statements: [], edges: 2 },
    timingsMs: { loadBase: 3, java: 400, sql: 1, build: 20, total: 424 }, limits: [],
    ...over,
  };
}

test('overlay applied: the answer comes from the OVERLAY graph and stays provisional-overlay', () => {
  const base = stitchedGraph();
  const ov = overlayGraphFixture();
  const c = { ...ctx(base), overlay: () => appliedOverlay(ov) };
  const resp = changed_impact(base, {}, c);
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  assert.equal(resp.basis.freshness.overlaySessionId, 'f'.repeat(64));
  const ids = resp.answer.upstreamEndpoints.map((e) => e.id);
  assert.ok(ids.includes('GET /product/preview'), `the overlay-only endpoint is missing: ${ids.join(', ')}`);
  assert.ok(ids.includes('POST /product/update'), 'the base endpoint disappeared');
  // and the dirty files came from the overlay, not from args
  assert.deepEqual(resp.answer.files.matched, [SERVICE_FILE]);
});

test('overlay applied: a row that exists only in the overlay carries provisional:true beside its grade', () => {
  const base = stitchedGraph();
  const ov = overlayGraphFixture();
  const resp = changed_impact(base, {}, { ...ctx(base), overlay: () => appliedOverlay(ov) });
  const fresh = resp.answer.upstreamEndpoints.find((e) => e.id === 'GET /product/preview');
  const old = resp.answer.upstreamEndpoints.find((e) => e.id === 'POST /product/update');
  assert.equal(fresh.provisional, true);
  assert.equal(fresh.grade, 'SOUND_SET', 'PROVISIONAL is a marker, not a grade (I-1)');
  assert.equal(old.provisional, undefined, 'a row the base already had must not be marked provisional');
  for (const c of resp.answer.downstreamColumns) {
    assert.equal(c.provisional, undefined, 'columns come from the catalog, which the overlay never invents');
  }
});

test('overlay applied: answer.overlay discloses the session, the doc versions and the timings', () => {
  const base = stitchedGraph();
  const resp = changed_impact(base, {}, { ...ctx(base), overlay: () => appliedOverlay(overlayGraphFixture()) });
  const o = resp.answer.overlay;
  assert.equal(o.applied, true);
  assert.equal(o.state, 'fresh');
  assert.equal(o.overlaySessionId, 'f'.repeat(64));
  assert.deepEqual(o.docVersions, { [SERVICE_FILE]: '1'.repeat(64) });
  assert.deepEqual(o.parsedFiles, [SERVICE_FILE]);
  assert.deepEqual(o.droppedFiles, []);
  assert.equal(o.provisionalEdges, 2);
  assert.deepEqual(o.provisionalIds.endpoints, ['endpoint:GET /product/preview']);
  assert.equal(o.timingsMs.total, 424);
  assert.match(resp.answer.note, /RE-PARSED/);
});

test('a commit since the pack was built: verdict behind, overlay NOT applied, and the cure is named', () => {
  const base = stitchedGraph();
  const ov = {
    applied: false, state: 'stale-commit', graph: null,
    session: { overlaySessionId: 'e'.repeat(64), baseCommit: 'c'.repeat(40), headCommit: 'd'.repeat(40), docVersions: {} },
    dirtyFiles: [SERVICE_FILE], reason: 'HEAD moved past the pack',
    limits: [{ scope: 'overlay', reason: 'HEAD moved past the pack\'s base commit — run `cascade analyze`' }],
  };
  const resp = changed_impact(base, {}, { ...ctx(base), overlay: () => ov });
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.basis.freshness.verdict, 'behind');
  assert.equal(resp.answer.overlay.applied, false);
  assert.equal(resp.answer.overlay.state, 'stale-commit');
  const lim = resp.limits.find((l) => l.scope === 'overlay');
  assert.ok(lim && lim.reason.includes('cascade analyze'), 'the behind answer must name the cure');
  // No row may claim to be provisional when no overlay was applied.
  for (const e of resp.answer.upstreamEndpoints) assert.equal(e.provisional, undefined);
});

test('a dirty DDL: the overlay declines, the verdict is unknown, and the reason is carried', () => {
  const base = stitchedGraph();
  const ov = {
    applied: false, state: 'declined', graph: null,
    session: { overlaySessionId: 'a'.repeat(64), baseCommit: 'c'.repeat(40), headCommit: 'c'.repeat(40), docVersions: {} },
    dirtyFiles: ['schema.sql', SERVICE_FILE], reason: 'schema file changed — catalog changes need a certified re-analysis',
    limits: [{ scope: 'overlay', reason: 'the DDL is dirty — run `cascade analyze`' }],
  };
  const resp = changed_impact(base, {}, { ...ctx(base), overlay: () => ov });
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.basis.freshness.verdict, 'unknown');
  assert.match(resp.answer.overlay.reason, /certified re-analysis/);
  assert.match(resp.answer.note, /base pack/, 'a declined overlay must not describe itself as re-parsed');
});

test('no overlay wired: the old base-only answer, unchanged and still labelled', () => {
  const g = stitchedGraph();
  const resp = changed_impact(g, { files: [SERVICE_FILE] }, ctx(g));
  assert.equal(resp.basis.freshness.verdict, 'provisional-overlay');
  assert.equal(resp.answer.overlay, undefined);
  assert.match(resp.answer.note, /files as last analyzed/);
});

test('args.files still wins over the overlay diff, over the overlay graph', () => {
  const base = stitchedGraph();
  const ov = overlayGraphFixture();
  const resp = changed_impact(base, { files: ['src/main/java/com/x/PmsProductPreviewController.java'] }, { ...ctx(base), overlay: () => appliedOverlay(ov) });
  assert.deepEqual(resp.answer.files.matched, ['src/main/java/com/x/PmsProductPreviewController.java']);
  assert.ok(resp.answer.upstreamEndpoints.some((e) => e.id === 'GET /product/preview' && e.provisional === true));
});

// ---------------------------------------------------------------------------
// The internal HTTP hop reaches changed_impact and endpoint_impact too (RM14)
// ---------------------------------------------------------------------------

/** Module A calls module B's route; B's handler reads a column. */
function hopGraph() {
  const g = buildGraphFromSql(
    [
      { kind: 'table', schema: null, table: 'stock', comment: null },
      { kind: 'column', schema: null, table: 'stock', column: 'qty', type: 'INT', comment: null, pk: false },
    ],
    [{
      kind: 'lineage', namespace: 'b.StockMapper', id: 'selectById', type: 'select',
      tables: [{ table: 'stock', access: 'read' }],
      columns: [{ table: 'stock', column: 'qty', access: 'read' }],
      file: 'b/StockMapper.xml', line: 3,
    }],
  );
  addJavaFacts(g, [
    { kind: 'type', fqn: 'a.OrderController', typeKind: 'class', package: 'a', annotations: ['RestController'], implements: [], declaredMethods: ['detail/1'], file: 'a/OrderController.java' },
    { kind: 'type',
      fqn: 'a.StockClient',
      typeKind: 'interface',
      package: 'a',
      annotations: ['FeignClient'],
      implements: [],
      declaredMethods: ['byId/1'],
      client: { kind: 'FeignClient', service: 'stock-service', serviceLiteral: true, url: null, path: null },
      file: 'a/StockClient.java' },
    { kind: 'field', owner: 'a.OrderController', name: 'client', typeSimple: 'StockClient', file: 'a/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/{id}', handler: 'a.OrderController#detail', handlerType: 'a.OrderController', line: 11, file: 'a/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/stock/{id}', handler: 'a.StockClient#byId', handlerType: 'a.StockClient', line: 7, file: 'a/StockClient.java' },
    { kind: 'call', from: 'a.OrderController#detail', receiver: 'client', method: 'byId', toTypeSimple: 'StockClient', via: 'field', file: 'a/OrderController.java' },
    { kind: 'type', fqn: 'b.StockController', typeKind: 'class', package: 'b', annotations: ['RestController'], implements: [], declaredMethods: ['byId/1'], file: 'b/StockController.java' },
    { kind: 'type', fqn: 'b.StockMapper', typeKind: 'interface', package: 'b', annotations: ['Mapper'], implements: [], declaredMethods: ['selectById/1'], file: 'b/StockMapper.java' },
    { kind: 'field', owner: 'b.StockController', name: 'mapper', typeSimple: 'StockMapper', file: 'b/StockController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/stock/{id}', handler: 'b.StockController#byId', handlerType: 'b.StockController', line: 9, file: 'b/StockController.java' },
    { kind: 'method', fqn: 'b.StockMapper#selectById', owner: 'b.StockMapper', name: 'selectById', paramCount: 1, line: 4, file: 'b/StockMapper.java' },
    { kind: 'call', from: 'b.StockController#byId', receiver: 'mapper', method: 'selectById', toTypeSimple: 'StockMapper', via: 'field', file: 'b/StockController.java' },
  ]);
  return g;
}

test('endpoint_impact: a route affected only through another deployable says viaHttp', () => {
  const g = hopGraph();
  const rows = endpointsAffectingColumn(g, nodeId('column', 'stock.qty'));
  const by = Object.fromEntries(rows.map((r) => [r.endpoint, r]));
  assert.deepEqual(Object.keys(by).sort(), ['endpoint:GET /order/{id}', 'endpoint:GET /stock/{id}']);
  assert.equal(by['endpoint:GET /stock/{id}'].viaHttp, undefined, 'B serves it directly');
  assert.deepEqual(
    [by['endpoint:GET /order/{id}'].viaHttp, by['endpoint:GET /order/{id}'].httpHops], [true, 1],
    'A only reaches the column across the hop, and the row discloses it',
  );
});

test('changed_impact: editing B\'s mapper names A\'s route, marked as reached over HTTP', () => {
  const g = hopGraph();
  const r = changed_impact(g, { files: ['b/StockMapper.java'] }, ctx());
  assertContract(r);
  const by = Object.fromEntries(r.answer.upstreamEndpoints.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(by).sort(), ['GET /order/{id}', 'GET /stock/{id}']);
  assert.equal(by['GET /stock/{id}'].viaHttp, undefined);
  assert.deepEqual([by['GET /order/{id}'].viaHttp, by['GET /order/{id}'].httpHops], [true, 1]);
});
