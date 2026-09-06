import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts, symbolId, endpointId } from '../src/adapters/java_bridge.mjs';
import { nodesInFiles, changeImpact, OverlayError } from '../src/core/overlay.mjs';

// ---------------------------------------------------------------------------
// Fixture — the pms_product SQL fixture from test/tools.test.mjs (table with
// id/name/price, mapper PmsProductMapper.{update,select}ByPrimaryKey, lineage
// records carrying file: 'PmsProductMapper.xml'), stitched with a Java lane
// whose `type` records ADD a `file` (the overlay's whole read side is driven
// off that attribute) and a real Controller -> ServiceImpl -> Mapper call
// chain (not a direct Controller->Mapper call). That matters: editing the
// controller's OWN file also touches the endpoint node (its file is the
// handler's owning type's file, i.e. the controller's file too), so that edit
// alone can only ever prove the trivial self-EXACT case. Editing the
// intermediate ServiceImpl's file crosses a MAY_CALL edge to reach the
// endpoint, which is the case that actually exercises weakest-link grading.
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

const HANDLER_ID = symbolId('com.x.PmsProductController#update');
const SERVICE_SYMBOL_ID = symbolId('com.x.PmsProductServiceImpl#updateByPrimaryKey');
const ENDPOINT_NODE_ID = endpointId('POST', '/product/update');
const UPDATE_STMT_ID = nodeId('statement', 'PmsProductMapper.updateByPrimaryKey');
const SELECT_STMT_ID = nodeId('statement', 'PmsProductMapper.selectByPrimaryKey');
const PRICE_COL = nodeId('column', 'pms_product.price');
const NAME_COL = nodeId('column', 'pms_product.name');
const ID_COL = nodeId('column', 'pms_product.id');

// Before trusting overlay assertions against this fixture, confirm it actually
// stitches end to end (mirrors the endpoint_impact section of test/tools.test.mjs).
test('fixture sanity: the stitched graph connects pms_product.price to the endpoint at SOUND_SET (weakest link)', () => {
  const g = stitchedGraph();
  const reached = g.impactOf(PRICE_COL, { mode: 'conservative' });
  const info = reached.get(ENDPOINT_NODE_ID);
  assert.ok(info, 'expected the endpoint to be reachable backward from pms_product.price');
  assert.equal(info.pathGrade, 'SOUND_SET');
});

// ---------------------------------------------------------------------------
// nodesInFiles
// ---------------------------------------------------------------------------

test('nodesInFiles: a file that owns nodes returns their ids in matched and byId; a file with no node returns an empty match list', () => {
  const g = stitchedGraph();
  const { matched, byId } = nodesInFiles(g, [CONTROLLER_FILE, 'nope/nothing.js']);
  const owned = matched.get(CONTROLLER_FILE);
  assert.ok(owned.includes(HANDLER_ID), 'expected the handler symbol in the controller file match');
  assert.ok(owned.includes(ENDPOINT_NODE_ID), 'expected the endpoint (same owning file) in the controller file match');
  assert.equal(owned.length, 2);
  assert.ok(byId.has(HANDLER_ID));
  assert.ok(byId.has(ENDPOINT_NODE_ID));
  assert.deepEqual(matched.get('nope/nothing.js'), []);
});

test('nodesInFiles: path-suffix tolerance matches a longer node file to a shorter changed path, and a shorter node file to a longer changed path', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('symbol', 'com.x.Foo#bar'), file: 'mall-admin/src/main/java/com/x/Foo.java' });
  g.addNode({ id: nodeId('symbol', 'com.x.Bar#baz'), file: 'com/x/Bar.java' });
  const { matched } = nodesInFiles(g, ['com/x/Foo.java', 'mall-admin/src/main/java/com/x/Bar.java']);
  assert.deepEqual(matched.get('com/x/Foo.java'), [nodeId('symbol', 'com.x.Foo#bar')]);
  assert.deepEqual(matched.get('mall-admin/src/main/java/com/x/Bar.java'), [nodeId('symbol', 'com.x.Bar#baz')]);
});

// ---------------------------------------------------------------------------
// changeImpact
// ---------------------------------------------------------------------------

test('changeImpact: editing the ServiceImpl file touches its symbol, reaches the endpoint upstream at SOUND_SET (a MAY_CALL edge is on the path), and reaches the columns it writes/reads downstream', () => {
  const g = stitchedGraph();
  const r = changeImpact(g, [SERVICE_FILE]);
  assert.deepEqual(r.touched.symbols, [SERVICE_SYMBOL_ID]);

  const ep = r.upstreamEndpoints.find((e) => e.id === ENDPOINT_NODE_ID);
  assert.ok(ep, 'expected the endpoint reachable through the service symbol');
  assert.equal(ep.grade, 'SOUND_SET');

  const colIds = r.downstreamColumns.map((c) => c.id);
  assert.ok(colIds.includes(PRICE_COL));
  assert.ok(colIds.includes(NAME_COL));
  assert.ok(colIds.includes(ID_COL));
  for (const c of r.downstreamColumns) assert.equal(c.grade, 'SOUND_SET');
});

test('changeImpact: editing the mapper XML file touches the statement, reaches its columns downstream at EXACT (pure SQL edges), and the endpoint that reaches it upstream', () => {
  const g = stitchedGraph();
  const r = changeImpact(g, [MAPPER_XML_FILE]);
  assert.ok(r.touched.statements.includes(UPDATE_STMT_ID));
  assert.ok(r.touched.statements.includes(SELECT_STMT_ID));

  const priceEntry = r.downstreamColumns.find((c) => c.id === PRICE_COL);
  assert.ok(priceEntry, 'expected pms_product.price in downstreamColumns');
  assert.equal(priceEntry.grade, 'EXACT');

  const ep = r.upstreamEndpoints.find((e) => e.id === ENDPOINT_NODE_ID);
  assert.ok(ep, 'expected the endpoint that reaches the update statement');
});

test('changeImpact: the blast radius is the columns the reached SQL touches — a sibling column of the same table is NOT downstream', () => {
  const g = stitchedGraph();
  // pms_product declares a fourth column that no mapper in this fixture names.
  const STOCK_COL = nodeId('column', 'pms_product.stock');
  g.addNode({ id: STOCK_COL, name: 'stock' });
  g.addEdge({ from: nodeId('table', 'pms_product'), to: STOCK_COL, type: 'DECLARES', grade: 'EXACT' });

  const r = changeImpact(g, [SERVICE_FILE]);
  const colIds = r.downstreamColumns.map((c) => c.id);
  assert.ok(colIds.includes(PRICE_COL), 'the mapper this service calls does write price');
  assert.equal(colIds.includes(STOCK_COL), false, 'editing the service cannot touch a column no reached statement names');
  // The DECLARES edge is there: an unfiltered forward walk from the edited
  // symbol steps statement → table → EVERY column of that table.
  assert.ok(g.reach(SERVICE_SYMBOL_ID, { direction: 'out', mode: 'conservative' }).has(STOCK_COL));
});

test('changeImpact: matchedFiles vs unmatchedFiles splits a changeset by whether it owns a node', () => {
  const g = stitchedGraph();
  const r = changeImpact(g, [CONTROLLER_FILE, 'does/not/exist.js']);
  assert.deepEqual(r.matchedFiles, [CONTROLLER_FILE]);
  assert.deepEqual(r.unmatchedFiles, ['does/not/exist.js']);
});

test('changeImpact: a touched node that IS the endpoint (editing the controller file) is itself in upstreamEndpoints, self/EXACT', () => {
  const g = stitchedGraph();
  const r = changeImpact(g, [CONTROLLER_FILE]);
  assert.ok(r.touched.endpoints.includes(ENDPOINT_NODE_ID));
  const ep = r.upstreamEndpoints.find((e) => e.id === ENDPOINT_NODE_ID);
  assert.ok(ep, 'expected the endpoint itself in its own radius');
  assert.equal(ep.grade, 'EXACT');
});

test('changeImpact: a non-array changedFiles throws OverlayError', () => {
  const g = stitchedGraph();
  assert.throws(() => changeImpact(g, 'notarray'), (e) => e instanceof OverlayError);
});

test('changeImpact: an empty changeset returns all-empty lists without throwing', () => {
  const g = stitchedGraph();
  const r = changeImpact(g, []);
  assert.equal(r.changedFiles, 0);
  assert.deepEqual(r.matchedFiles, []);
  assert.deepEqual(r.unmatchedFiles, []);
  assert.deepEqual(r.touched, { symbols: [], webSymbols: [], screens: [], statements: [], endpoints: [], columns: [], other: [] });
  assert.deepEqual(r.upstreamEndpoints, []);
  assert.deepEqual(r.calledEndpoints, []);
  assert.deepEqual(r.downstreamColumns, []);
});
