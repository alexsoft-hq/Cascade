import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '../src/core/graph.mjs';
import {
  buildGraphFromSql,
  statementsTouchingColumn,
  tableKey,
  columnKey,
  statementKey,
  SqlBridgeError,
} from '../src/adapters/sql_bridge.mjs';

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

test('tableKey: no schema returns just the table name', () => {
  assert.equal(tableKey(null, 't'), 't');
});

test('tableKey: schema present joins schema.table', () => {
  assert.equal(tableKey('s', 't'), 's.t');
});

test('columnKey: no schema returns table.column', () => {
  assert.equal(columnKey(null, 't', 'c'), 't.c');
});

test('columnKey: schema present joins schema.table.column', () => {
  assert.equal(columnKey('s', 't', 'c'), 's.t.c');
});

test('statementKey: joins namespace and id with a dot', () => {
  assert.equal(statementKey('ns', 'id'), 'ns.id');
});

// ---------------------------------------------------------------------------
// Fixtures — small inline synthetic catalog/lineage records mirroring the
// real SQL-lane worker output shapes (schema null, mall-style).
// ---------------------------------------------------------------------------

function catalogHeader() {
  return { kind: 'header', tool: 'sql-catalog', version: 1 };
}

function tableRecord() {
  return { kind: 'table', schema: null, table: 'pms_product', comment: '商品' };
}

function priceColumnRecord() {
  return { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10, 2)', comment: '价格' };
}

function idColumnRecord() {
  return { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: null };
}

function lineageHeader() {
  return { kind: 'header', tool: 'sql-lineage', version: 1 };
}

/** update statement: writes pms_product.price, reads pms_product.id */
function updateLineageRecord() {
  return {
    kind: 'lineage',
    namespace: 'com.x.PmsProductMapper',
    id: 'updateByPrimaryKey',
    type: 'update',
    tables: [{ table: 'pms_product', access: 'write' }],
    columns: [
      { table: 'pms_product', column: 'price', access: 'write' },
      { table: 'pms_product', column: 'id', access: 'read' },
    ],
    file: 'x.xml',
    line: 10,
  };
}

/** a second, distinct writer of pms_product.price (for statementsTouchingColumn) */
function secondUpdateLineageRecord() {
  return {
    kind: 'lineage',
    namespace: 'com.x.PmsProductMapper',
    id: 'updateSelective',
    type: 'update',
    tables: [{ table: 'pms_product', access: 'write' }],
    columns: [{ table: 'pms_product', column: 'price', access: 'write' }],
    file: 'x.xml',
    line: 20,
  };
}

/** a reader of pms_product.price */
function selectLineageRecord() {
  return {
    kind: 'lineage',
    namespace: 'com.x.PmsProductMapper',
    id: 'selectByPrimaryKey',
    type: 'select',
    tables: [{ table: 'pms_product', access: 'read' }],
    columns: [{ table: 'pms_product', column: 'price', access: 'read' }],
    file: 'x.xml',
    line: 30,
  };
}

/** delete statement: touches the table, reads a column, writes none */
function deleteLineageRecord() {
  return {
    kind: 'lineage',
    namespace: 'com.x.PmsProductMapper',
    id: 'deleteByPrimaryKey',
    type: 'delete',
    tables: [{ table: 'pms_product', access: 'delete' }],
    columns: [{ table: 'pms_product', column: 'id', access: 'read' }],
    file: 'x.xml',
    line: 40,
  };
}

// ---------------------------------------------------------------------------
// Catalog → nodes + DECLARES
// ---------------------------------------------------------------------------

test('buildGraphFromSql: a table record creates a table node carrying its comment', () => {
  const g = buildGraphFromSql([tableRecord()], []);
  const tid = nodeId('table', tableKey(null, 'pms_product'));
  const node = g.nodes.get(tid);
  assert.ok(node, 'expected table node to exist');
  assert.equal(node.comment, '商品');
});

test('buildGraphFromSql: a column record creates a column node carrying name/type/comment', () => {
  const g = buildGraphFromSql([tableRecord(), priceColumnRecord()], []);
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const node = g.nodes.get(cid);
  assert.ok(node, 'expected column node to exist');
  assert.equal(node.name, 'price');
  assert.equal(node.type, 'DECIMAL(10, 2)');
  assert.equal(node.comment, '价格');
});

test('buildGraphFromSql: a table+column pair creates a DECLARES edge graded EXACT', () => {
  const g = buildGraphFromSql([tableRecord(), priceColumnRecord()], []);
  const tid = nodeId('table', tableKey(null, 'pms_product'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const edge = g.edges.find((e) => e.type === 'DECLARES' && e.from === tid && e.to === cid);
  assert.ok(edge, 'expected DECLARES edge table -> column');
  assert.equal(edge.grade, 'EXACT');
});

test('buildGraphFromSql: a column with no comment carries comment null', () => {
  const g = buildGraphFromSql([tableRecord(), idColumnRecord()], []);
  const cid = nodeId('column', columnKey(null, 'pms_product', 'id'));
  assert.equal(g.nodes.get(cid).comment, null);
});

// ---------------------------------------------------------------------------
// Lineage → statement node + EXECUTES / WRITES / READS
// ---------------------------------------------------------------------------

test('buildGraphFromSql: a lineage record creates a statement node carrying statementType/file/line', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const node = g.nodes.get(sid);
  assert.ok(node, 'expected statement node to exist');
  assert.equal(node.statementType, 'update');
  assert.equal(node.file, 'x.xml');
  assert.equal(node.line, 10);
});

test('buildGraphFromSql: a table access produces an EXECUTES edge graded EXACT with evidence.access carried', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const tid = nodeId('table', tableKey(null, 'pms_product'));
  const edge = g.edges.find((e) => e.type === 'EXECUTES' && e.from === sid && e.to === tid);
  assert.ok(edge, 'expected EXECUTES edge statement -> table');
  assert.equal(edge.grade, 'EXACT');
  assert.equal(edge.evidence.access, 'write');
});

test('buildGraphFromSql: a write column access produces a WRITES edge statement -> column', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const edge = g.edges.find((e) => e.type === 'WRITES' && e.from === sid && e.to === cid);
  assert.ok(edge, 'expected WRITES edge statement -> column');
  assert.equal(edge.grade, 'EXACT');
  assert.equal(edge.from, sid);
  assert.equal(edge.to, cid);
});

test('buildGraphFromSql: a read column access produces a READS edge statement -> column', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'id'));
  const edge = g.edges.find((e) => e.type === 'READS' && e.from === sid && e.to === cid);
  assert.ok(edge, 'expected READS edge statement -> column');
  assert.equal(edge.grade, 'EXACT');
  assert.equal(edge.from, sid);
  assert.equal(edge.to, cid);
});

// ---------------------------------------------------------------------------
// All SQL-lane edges are EXACT
// ---------------------------------------------------------------------------

test('buildGraphFromSql: every edge produced (DECLARES/EXECUTES/WRITES/READS) is graded EXACT', () => {
  const g = buildGraphFromSql(
    [tableRecord(), priceColumnRecord(), idColumnRecord()],
    [updateLineageRecord(), selectLineageRecord(), deleteLineageRecord()],
  );
  assert.ok(g.edges.length > 0, 'expected at least one edge to check');
  for (const e of g.edges) assert.equal(e.grade, 'EXACT');
});

// ---------------------------------------------------------------------------
// Delete carries no column write
// ---------------------------------------------------------------------------

test('buildGraphFromSql: a delete record produces an EXECUTES edge with evidence.access "delete"', () => {
  const g = buildGraphFromSql([], [deleteLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'deleteByPrimaryKey'));
  const tid = nodeId('table', tableKey(null, 'pms_product'));
  const edge = g.edges.find((e) => e.type === 'EXECUTES' && e.from === sid && e.to === tid);
  assert.ok(edge, 'expected EXECUTES edge for the delete statement');
  assert.equal(edge.evidence.access, 'delete');
});

test('buildGraphFromSql: a delete record produces a READS edge for its read column', () => {
  const g = buildGraphFromSql([], [deleteLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'deleteByPrimaryKey'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'id'));
  const edge = g.edges.find((e) => e.type === 'READS' && e.from === sid && e.to === cid);
  assert.ok(edge, 'expected READS edge for the delete statement');
});

test('buildGraphFromSql: a delete record produces zero WRITES edges', () => {
  const g = buildGraphFromSql([], [deleteLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'deleteByPrimaryKey'));
  const writeEdges = g.edges.filter((e) => e.type === 'WRITES' && e.from === sid);
  assert.equal(writeEdges.length, 0);
});

test('buildGraphFromSql: a column access of "delete" (neither read nor write) is skipped — no edge created', () => {
  const malformed = {
    kind: 'lineage',
    namespace: 'com.x.PmsProductMapper',
    id: 'weirdDelete',
    type: 'delete',
    tables: [{ table: 'pms_product', access: 'delete' }],
    columns: [{ table: 'pms_product', column: 'price', access: 'delete' }],
    file: 'x.xml',
    line: 50,
  };
  const g = buildGraphFromSql([], [malformed]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'weirdDelete'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const edge = g.edges.find((e) => e.from === sid && e.to === cid);
  assert.equal(edge, undefined, 'no READS/WRITES edge should be created for access "delete"');
});

// ---------------------------------------------------------------------------
// Ingest order independence
// ---------------------------------------------------------------------------

test('buildGraphFromSql: lineage records ingested with no catalog still produce a stub column node', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  assert.ok(g.nodes.has(cid), 'expected column node to be auto-stubbed from lineage alone');
});

test('buildGraphFromSql: the auto-stubbed column node from lineage-only ingest still gets WRITES edge', () => {
  const g = buildGraphFromSql([], [updateLineageRecord()]);
  const sid = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const edge = g.edges.find((e) => e.type === 'WRITES' && e.from === sid && e.to === cid);
  assert.ok(edge, 'expected WRITES edge even without a catalog record for the column');
});

// ---------------------------------------------------------------------------
// statementsTouchingColumn
// ---------------------------------------------------------------------------

test('statementsTouchingColumn: returns writers and readers split, sorted, and de-duplicated', () => {
  const g = buildGraphFromSql(
    [tableRecord(), priceColumnRecord()],
    [updateLineageRecord(), secondUpdateLineageRecord(), selectLineageRecord(), updateLineageRecord()],
  );
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const { writers, readers } = statementsTouchingColumn(g, cid);

  const s1 = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  const s2 = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateSelective'));
  const s3 = nodeId('statement', statementKey('com.x.PmsProductMapper', 'selectByPrimaryKey'));

  assert.deepEqual(writers, [s1, s2].sort());
  assert.deepEqual(readers, [s3]);
});

test('statementsTouchingColumn: a duplicated write edge for the same statement is de-duplicated', () => {
  // updateLineageRecord() is fed twice above; confirm the duplicate write to
  // pms_product.price by the same statement id collapses to one entry.
  const g = buildGraphFromSql(
    [tableRecord(), priceColumnRecord()],
    [updateLineageRecord(), updateLineageRecord()],
  );
  const cid = nodeId('column', columnKey(null, 'pms_product', 'price'));
  const { writers } = statementsTouchingColumn(g, cid);
  const s1 = nodeId('statement', statementKey('com.x.PmsProductMapper', 'updateByPrimaryKey'));
  assert.deepEqual(writers, [s1]);
});

test('statementsTouchingColumn: a column with no readers/writers returns empty arrays', () => {
  const g = buildGraphFromSql([tableRecord(), idColumnRecord()], []);
  const cid = nodeId('column', columnKey(null, 'pms_product', 'id'));
  const { writers, readers } = statementsTouchingColumn(g, cid);
  assert.deepEqual(writers, []);
  assert.deepEqual(readers, []);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('buildGraphFromSql: throws SqlBridgeError when catalogRecords is not an array', () => {
  assert.throws(() => buildGraphFromSql(null, []), SqlBridgeError);
});

test('buildGraphFromSql: throws SqlBridgeError when lineageRecords is not an array', () => {
  assert.throws(() => buildGraphFromSql([], null), SqlBridgeError);
});

test('buildGraphFromSql: throws SqlBridgeError when both arguments are omitted', () => {
  assert.throws(() => buildGraphFromSql(), SqlBridgeError);
});

// ---------------------------------------------------------------------------
// header / unknown kinds ignored
// ---------------------------------------------------------------------------

test('buildGraphFromSql: header records and unknown kinds in catalog/lineage are ignored', () => {
  const g = buildGraphFromSql(
    [catalogHeader(), tableRecord(), priceColumnRecord(), { kind: 'mystery', schema: null, table: 'x' }],
    [lineageHeader(), updateLineageRecord(), { kind: 'mystery', id: 'nope' }],
  );
  // Exactly: table:pms_product, column:pms_product.price, column:pms_product.id
  // (stubbed from lineage READS), statement:updateByPrimaryKey.
  assert.equal(g.nodes.size, 4);
});
