import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { TOOLS, toolList, callTool, CATALOG_SCHEMA, DispatchError } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixture — small inline catalog/lineage records (same shape as
// test/sql_bridge.test.mjs, test/pack.test.mjs, test/tools.test.mjs).
// ---------------------------------------------------------------------------

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product catalog table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'name', type: 'VARCHAR(100)', comment: 'display name' },
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
      file: 'PmsProductMapper.xml', line: 10,
    },
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'pms_product', access: 'read' }],
      columns: [
        { table: 'pms_product', column: 'id', access: 'read' },
        { table: 'pms_product', column: 'name', access: 'read' },
        { table: 'pms_product', column: 'price', access: 'read' },
      ],
      file: 'PmsProductMapper.xml', line: 30,
    },
    {
      kind: 'lineage', namespace: 'PmsProductMapper', id: 'deleteByPrimaryKey', type: 'delete',
      tables: [{ table: 'pms_product', access: 'delete' }],
      columns: [{ table: 'pms_product', column: 'id', access: 'read' }],
      file: 'PmsProductMapper.xml', line: 50,
    },
  ];
}

function buildFixtureGraph() {
  return buildGraphFromSql(catalogRecords(), lineageRecords());
}

function basis() {
  return { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } };
}

function fullCtx(graph) {
  return { graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' } };
}

// ---------------------------------------------------------------------------
// TOOLS — catalog contents
// ---------------------------------------------------------------------------

test('TOOLS has exactly overview, search, browse, column_impact, endpoint_impact, screen_impact, transactions, flow, erd, coupling, map, neighborhood, changed_impact, table_usage, projects', () => {
  assert.deepEqual(new Set(Object.keys(TOOLS)), new Set(['overview', 'search', 'browse', 'column_impact', 'endpoint_impact', 'screen_impact', 'transactions', 'flow', 'erd', 'coupling', 'map', 'neighborhood', 'changed_impact', 'table_usage', 'projects']));
});

test('TOOLS: each entry has a non-empty description', () => {
  for (const [name, spec] of Object.entries(TOOLS)) {
    assert.equal(typeof spec.description, 'string', `${name} description should be a string`);
    assert.ok(spec.description.length > 0, `${name} description should be non-empty`);
  }
});

test('TOOLS: search requires query in its inputSchema', () => {
  assert.deepEqual(TOOLS.search.inputSchema.required, ['query']);
  assert.ok('query' in TOOLS.search.inputSchema.properties);
});

test('TOOLS: column_impact requires column in its inputSchema', () => {
  assert.deepEqual(TOOLS.column_impact.inputSchema.required, ['column']);
  assert.ok('column' in TOOLS.column_impact.inputSchema.properties);
});

test('TOOLS: browse requires kind in its inputSchema, and kind is a closed set', () => {
  assert.deepEqual(TOOLS.browse.inputSchema.required, ['kind']);
  assert.deepEqual(TOOLS.browse.inputSchema.properties.kind.enum,
    ['table', 'column', 'statement', 'endpoint', 'symbol', 'screen']);
});

test('TOOLS: table_usage requires table in its inputSchema', () => {
  assert.deepEqual(TOOLS.table_usage.inputSchema.required, ['table']);
  assert.ok('table' in TOOLS.table_usage.inputSchema.properties);
});

// ---------------------------------------------------------------------------
// toolList
// ---------------------------------------------------------------------------

test('toolList: returns {schema:CATALOG_SCHEMA, tools:[...]}', () => {
  const list = toolList();
  assert.equal(list.schema, CATALOG_SCHEMA);
  assert.ok(Array.isArray(list.tools));
  assert.equal(list.tools.length, 15);
});

test('toolList: each entry exposes ONLY name/description/inputSchema — no fn leaking', () => {
  const list = toolList();
  for (const entry of list.tools) {
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'inputSchema', 'name']);
    assert.equal('fn' in entry, false);
  }
});

test('toolList: entry names match TOOLS keys', () => {
  const list = toolList();
  assert.deepEqual(new Set(list.tools.map((t) => t.name)), new Set(Object.keys(TOOLS)));
});

// ---------------------------------------------------------------------------
// callTool — routing + contract validity
// ---------------------------------------------------------------------------

test('callTool: routes to table_usage and returns a contract-valid response', () => {
  const g = buildFixtureGraph();
  const resp = callTool('table_usage', { table: 'pms_product' }, fullCtx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.ok(resp.answer.statements.some((s) => s.id === 'PmsProductMapper.updateByPrimaryKey'));
});

test('callTool: routes to column_impact and returns a contract-valid response', () => {
  const g = buildFixtureGraph();
  const resp = callTool('column_impact', { column: 'pms_product.price' }, fullCtx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.column, 'pms_product.price');
});

test('callTool: routes to search and returns a contract-valid response', () => {
  const g = buildFixtureGraph();
  const resp = callTool('search', { query: 'pms_product' }, fullCtx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.ok(resp.answer.tables.some((t) => t.table === 'pms_product'));
});

// ---------------------------------------------------------------------------
// callTool — error handling
// ---------------------------------------------------------------------------

test('callTool: throws DispatchError code unknown-tool for an unknown name', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => callTool('nope', {}, fullCtx(g)),
    (e) => e instanceof DispatchError && e.code === 'unknown-tool',
  );
});

test('callTool: throws DispatchError code bad-input when ctx.graph is missing', () => {
  assert.throws(
    () => callTool('table_usage', { table: 'pms_product' }, { basis: basis() }),
    (e) => e instanceof DispatchError && e.code === 'bad-input',
  );
});

test('callTool: throws DispatchError code bad-input when ctx.basis is missing', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => callTool('table_usage', { table: 'pms_product' }, { graph: g }),
    (e) => e instanceof DispatchError && e.code === 'bad-input',
  );
});

test('callTool: propagates a ToolError unknown-column as a DispatchError with the same code', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => callTool('column_impact', { column: 'pms_product.nope' }, fullCtx(g)),
    (e) => e instanceof DispatchError && e.code === 'unknown-column',
  );
});

test('callTool: propagates a ToolError bad-input (missing required arg) as a DispatchError with the same code', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => callTool('column_impact', {}, fullCtx(g)),
    (e) => e instanceof DispatchError && e.code === 'bad-input',
  );
});

test('callTool: propagates a ToolError unknown-table as a DispatchError with the same code', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => callTool('table_usage', { table: 'nope' }, fullCtx(g)),
    (e) => e instanceof DispatchError && e.code === 'unknown-table',
  );
});

// ---------------------------------------------------------------------------
// callTool — trust axes / trustLevel default
// ---------------------------------------------------------------------------

test('callTool: column_impact sets trust.axes to ["column"]', () => {
  const g = buildFixtureGraph();
  const resp = callTool('column_impact', { column: 'pms_product.price' }, fullCtx(g));
  assert.deepEqual(resp.trust.axes, ['column']);
});

test('callTool: table_usage sets trust.axes to ["table"]', () => {
  const g = buildFixtureGraph();
  const resp = callTool('table_usage', { table: 'pms_product' }, fullCtx(g));
  assert.deepEqual(resp.trust.axes, ['table']);
});

test('callTool: trustLevel defaults to UNCERTIFIED when ctx.trust is omitted entirely', () => {
  const g = buildFixtureGraph();
  const resp = callTool('table_usage', { table: 'pms_product' }, { graph: g, basis: basis() });
  assert.equal(resp.trust.trustLevel, 'UNCERTIFIED');
});

test('callTool: the server\'s live git diff survives the hop — changed_impact with no files uses it', () => {
  const g = buildFixtureGraph();
  let called = 0;
  const ctx = { ...fullCtx(g), changedFiles: () => { called += 1; return ['PmsProductMapper.xml']; } };
  const r = callTool('changed_impact', {}, ctx);
  assert.doesNotThrow(() => assertContract(r));
  assert.equal(called, 1, 'the dispatcher must pass ctx.changedFiles to the tool');
  assert.equal(r.answer.changedFiles, 1);
  // …and without one, the tool says what is missing instead of answering blind
  assert.throws(() => callTool('changed_impact', {}, fullCtx(g)),
    (e) => e instanceof DispatchError && e.code === 'bad-input');
});
