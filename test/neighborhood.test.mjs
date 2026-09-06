import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { neighborhood, ToolError } from '../src/mcp/tools.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixture — same shape as test/tools.test.mjs: table pms_product with columns
// id/name/price; PmsProductMapper.updateByPrimaryKey writes price+name, reads
// id; PmsProductMapper.selectByPrimaryKey reads id/name/price.
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
  ];
}

function buildFixtureGraph() {
  return buildGraphFromSql(catalogRecords(), lineageRecords());
}

function basis() {
  return { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } };
}

function ctx(graph) {
  return { graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' } };
}

const UPDATE_ID = 'statement:PmsProductMapper.updateByPrimaryKey';
const SELECT_ID = 'statement:PmsProductMapper.selectByPrimaryKey';

// ---------------------------------------------------------------------------
// direction: up — from a column, reach the statements that write/read it.
// ---------------------------------------------------------------------------

test('neighborhood: direction up from a column is contract-valid and includes the focus + its writer/reader statements', () => {
  const g = buildFixtureGraph();
  const resp = neighborhood(g, { column: 'pms_product.price', direction: 'up', hops: 2 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));

  const ids = resp.answer.nodes.map((n) => n.id);
  assert.ok(ids.includes(nodeId('column', 'pms_product.price')), 'focus node must be included');
  assert.ok(ids.includes(UPDATE_ID), 'the writer statement must be reached going up');
  assert.ok(ids.includes(SELECT_ID), 'the reader statement must be reached going up');

  assert.ok(resp.answer.edges.length > 0);
  for (const e of resp.answer.edges) assert.equal(e.grade, 'EXACT'); // SQL-lane edges are all EXACT
  const toFocus = resp.answer.edges.filter((e) => e.to === nodeId('column', 'pms_product.price'));
  assert.ok(toFocus.some((e) => e.from === UPDATE_ID && e.type === 'WRITES'));
  assert.ok(toFocus.some((e) => e.from === SELECT_ID && e.type === 'READS'));
});

// ---------------------------------------------------------------------------
// direction: down — from a statement, reach the columns it touches.
// ---------------------------------------------------------------------------

test('neighborhood: direction down from a statement reaches its columns', () => {
  const g = buildFixtureGraph();
  const resp = neighborhood(g, { statement: 'PmsProductMapper.updateByPrimaryKey', direction: 'down', hops: 1 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));

  const ids = resp.answer.nodes.map((n) => n.id);
  assert.ok(ids.includes(nodeId('column', 'pms_product.price')));
  assert.ok(ids.includes(nodeId('column', 'pms_product.name')));
  assert.ok(ids.includes(nodeId('column', 'pms_product.id')));
  assert.ok(ids.includes(nodeId('table', 'pms_product')));
});

// ---------------------------------------------------------------------------
// bad input
// ---------------------------------------------------------------------------

test('neighborhood: an unknown column focus throws ToolError code unknown-column', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => neighborhood(g, { column: 'no.such' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-column',
  );
});

test('neighborhood: a bad direction throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => neighborhood(g, { column: 'pms_product.price', direction: 'sideways' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('neighborhood: no focus arg at all throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => neighborhood(g, {}, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

// ---------------------------------------------------------------------------
// cap / truncation
// ---------------------------------------------------------------------------

test('neighborhood: a tiny limit trips the node cap — truncated.any is true and a limits entry is added', () => {
  const g = buildFixtureGraph();
  // pms_product.price has 2 inbound statement edges; a cap of 1 (just the
  // focus itself) is exceeded on the very first neighbor.
  const resp = neighborhood(g, { column: 'pms_product.price', direction: 'both', hops: 2, limit: 1 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.truncated.any, true);
  assert.ok(resp.limits.some((l) => l.scope === 'neighborhood'), 'expected a neighborhood-cap limits entry');
});
