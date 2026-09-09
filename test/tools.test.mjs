import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import {
  column_impact, endpoint_impact, changed_impact, table_usage, search, neighborhood, ToolError,
} from '../src/mcp/tools.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixture — small inline catalog/lineage records (mirrors test/sql_bridge.test.mjs
// and test/pack.test.mjs): table pms_product with columns id/name/price;
//   - PmsProductMapper.updateByPrimaryKey: writes price, name; reads id
//   - PmsProductMapper.selectByPrimaryKey: reads id, name, price
//   - PmsProductMapper.deleteByPrimaryKey: touches the table (access 'delete'),
//     reads id, writes no columns
// The 'name' column carries a distinctive comment so search-by-comment can be
// pinned unambiguously.
// ---------------------------------------------------------------------------

const NAME_COMMENT = 'product display name — QUUXFOO marker';

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product catalog table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'name', type: 'VARCHAR(100)', comment: NAME_COMMENT },
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

function ctx(graph) {
  return { graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' } };
}

const UPDATE_ID = 'PmsProductMapper.updateByPrimaryKey';
const SELECT_ID = 'PmsProductMapper.selectByPrimaryKey';
const DELETE_ID = 'PmsProductMapper.deleteByPrimaryKey';

// ---------------------------------------------------------------------------
// column_impact
// ---------------------------------------------------------------------------

test('column_impact: mode both — assertContract passes and includes the writer and the reader', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'both' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const ids = resp.answer.statements.map((s) => s.id);
  assert.ok(ids.includes(UPDATE_ID));
  assert.ok(ids.includes(SELECT_ID));
  const update = resp.answer.statements.find((s) => s.id === UPDATE_ID);
  const select = resp.answer.statements.find((s) => s.id === SELECT_ID);
  assert.equal(update.access, 'write');
  assert.equal(select.access, 'read');
});

test('column_impact: writes are sorted before reads', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'both' }, ctx(g));
  const accesses = resp.answer.statements.map((s) => s.access);
  const firstReadIdx = accesses.indexOf('read');
  const lastWriteIdx = accesses.lastIndexOf('write');
  assert.ok(firstReadIdx === -1 || lastWriteIdx === -1 || lastWriteIdx < firstReadIdx, 'writes must precede reads');
});

test('column_impact: answer carries the column comment and type', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'both' }, ctx(g));
  assert.equal(resp.answer.comment, 'unit price');
  assert.equal(resp.answer.type, 'DECIMAL(10,2)');
});

test('column_impact: mode write returns only write entries', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'write' }, ctx(g));
  assert.ok(resp.answer.statements.length > 0);
  for (const s of resp.answer.statements) assert.equal(s.access, 'write');
  assert.ok(resp.answer.statements.some((s) => s.id === UPDATE_ID));
});

test('column_impact: mode read returns only read entries', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'read' }, ctx(g));
  assert.ok(resp.answer.statements.length > 0);
  for (const s of resp.answer.statements) assert.equal(s.access, 'read');
  assert.ok(resp.answer.statements.some((s) => s.id === SELECT_ID));
});

test('column_impact: an unknown column throws ToolError code unknown-column', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => column_impact(g, { column: 'pms_product.nope' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-column',
  );
});

test('column_impact: a missing column arg throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => column_impact(g, {}, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('column_impact: limit out of range throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => column_impact(g, { column: 'pms_product.price', limit: 0 }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
  assert.throws(
    () => column_impact(g, { column: 'pms_product.price', limit: 1000 }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('column_impact: offset out of range throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => column_impact(g, { column: 'pms_product.price', offset: -1 }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('column_impact: a small limit truncates and sets truncated.fields[0].nextOffset', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'both', limit: 1 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.statements.length, 1);
  assert.equal(resp.truncated.any, true);
  assert.equal(resp.truncated.fields[0].nextOffset, 1);
});

test('column_impact: paging to the end yields nextOffset null and assertContract still passes', () => {
  const g = buildFixtureGraph();
  const resp = column_impact(g, { column: 'pms_product.price', mode: 'both', limit: 1, offset: 1 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.truncated.fields[0].nextOffset, null);
  assert.equal(resp.truncated.any, false);
});

test('column_impact: a column nothing touches returns empty statements with answer.empty.statements "none"', () => {
  // Build a graph that has a column node no statement reads or writes.
  const g = buildFixtureGraph();
  g.addNode({ id: nodeId('column', 'pms_product.untouched'), kind: 'column' });
  const resp = column_impact(g, { column: 'pms_product.untouched' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.statements, []);
  assert.equal(resp.answer.empty.statements, 'none');
});

// ---------------------------------------------------------------------------
// table_usage
// ---------------------------------------------------------------------------

test('table_usage: assertContract passes and statements list the touching statements with an access string', () => {
  const g = buildFixtureGraph();
  const resp = table_usage(g, { table: 'pms_product' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const byId = Object.fromEntries(resp.answer.statements.map((s) => [s.id, s.access]));
  assert.equal(byId[UPDATE_ID], 'write');
  assert.equal(byId[SELECT_ID], 'read');
  assert.equal(byId[DELETE_ID], 'delete');
});

test('table_usage: a statement with both a read and a write access reports a combined "read+write" string', () => {
  // Add a second statement that both reads and writes pms_product so the
  // combined-access join is exercised directly.
  const g = buildFixtureGraph();
  const sid = nodeId('statement', 'PmsProductMapper.mixedAccess');
  g.addNode({ id: sid, statementType: 'update' });
  g.addEdge({ from: sid, to: nodeId('table', 'pms_product'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: sid, to: nodeId('table', 'pms_product'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } });
  const resp = table_usage(g, { table: 'pms_product' }, ctx(g));
  const mixed = resp.answer.statements.find((s) => s.id === 'PmsProductMapper.mixedAccess');
  assert.ok(mixed, 'expected the mixed-access statement in the result');
  assert.equal(mixed.access, 'read+write');
});

test('table_usage: answer.columns has per-column {column, reads, writes} counts', () => {
  const g = buildFixtureGraph();
  const resp = table_usage(g, { table: 'pms_product' }, ctx(g));
  const byCol = Object.fromEntries(resp.answer.columns.map((c) => [c.column, c]));
  assert.deepEqual(byCol['pms_product.price'], { column: 'pms_product.price', reads: 1, writes: 1 });
  assert.deepEqual(byCol['pms_product.name'], { column: 'pms_product.name', reads: 1, writes: 1 });
  assert.deepEqual(byCol['pms_product.id'], { column: 'pms_product.id', reads: 3, writes: 0 });
});

test('table_usage: an unknown table throws ToolError code unknown-table', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => table_usage(g, { table: 'nope' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-table',
  );
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search: assertContract passes and answer has tables/columns/statements arrays', () => {
  const g = buildFixtureGraph();
  const resp = search(g, { query: 'pms_product' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.ok(Array.isArray(resp.answer.tables));
  assert.ok(Array.isArray(resp.answer.columns));
  assert.ok(Array.isArray(resp.answer.statements));
});

test('search: matches by name substring (table name)', () => {
  const g = buildFixtureGraph();
  const resp = search(g, { query: 'pms_product' }, ctx(g));
  assert.ok(resp.answer.tables.some((t) => t.table === 'pms_product'));
  assert.ok(resp.answer.columns.some((c) => c.column === 'pms_product.price'));
});

test('search: matches on a column comment (distinctive marker)', () => {
  const g = buildFixtureGraph();
  const resp = search(g, { query: 'QUUXFOO' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.columns.length, 1);
  assert.equal(resp.answer.columns[0].column, 'pms_product.name');
  assert.equal(resp.answer.columns[0].comment, NAME_COMMENT);
});

test('search: a query shorter than 2 chars throws ToolError code bad-input', () => {
  const g = buildFixtureGraph();
  assert.throws(
    () => search(g, { query: 'a' }, ctx(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input',
  );
});

test('search: a query matching nothing returns all-empty lists with an answer.empty reason each, and is contract-valid', () => {
  const g = buildFixtureGraph();
  const resp = search(g, { query: 'zzz-nonexistent' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.tables, []);
  assert.deepEqual(resp.answer.columns, []);
  assert.deepEqual(resp.answer.statements, []);
  assert.equal(resp.answer.empty.tables, 'none');
  assert.equal(resp.answer.empty.columns, 'none');
  assert.equal(resp.answer.empty.statements, 'none');
});

// ---------------------------------------------------------------------------
// Every response passes assertContract (belt-and-braces sweep)
// ---------------------------------------------------------------------------

test('every tool response built here passes assertContract', () => {
  const g = buildFixtureGraph();
  const responses = [
    column_impact(g, { column: 'pms_product.price', mode: 'both' }, ctx(g)),
    column_impact(g, { column: 'pms_product.price', mode: 'write' }, ctx(g)),
    column_impact(g, { column: 'pms_product.price', mode: 'read' }, ctx(g)),
    table_usage(g, { table: 'pms_product' }, ctx(g)),
    search(g, { query: 'pms_product' }, ctx(g)),
    search(g, { query: 'zzz-nonexistent' }, ctx(g)),
  ];
  for (const resp of responses) assert.doesNotThrow(() => assertContract(resp));
});

// ---------------------------------------------------------------------------
// endpoint_impact — the code axis stitched onto the SQL fixture.
// Java facts: POST /product/update → PmsProductController#update, which calls
// productMapper.updateByPrimaryKey (a price WRITER in the SQL fixture). The
// mapper method fqn "PmsProductMapper#updateByPrimaryKey" binds to statement
// "PmsProductMapper.updateByPrimaryKey", so price reaches the endpoint.
// ---------------------------------------------------------------------------

function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.PmsProductController', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [], extends: null },
    { kind: 'type', fqn: 'PmsProductMapper', typeKind: 'interface', package: '', implements: [], extends: null },
    { kind: 'import', owner: 'com.x.PmsProductController', simple: 'PmsProductMapper', fqn: 'PmsProductMapper' },
    { kind: 'field', owner: 'com.x.PmsProductController', name: 'productMapper', typeSimple: 'PmsProductMapper' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/product/update', handler: 'com.x.PmsProductController#update', handlerType: 'com.x.PmsProductController' },
    { kind: 'call', from: 'com.x.PmsProductController#update', receiver: 'productMapper', method: 'updateByPrimaryKey', toTypeSimple: 'PmsProductMapper' },
    { kind: 'method', fqn: 'PmsProductMapper#updateByPrimaryKey', owner: 'PmsProductMapper', name: 'updateByPrimaryKey', paramCount: 1 },
  ];
}

function stitchedGraph() {
  const g = buildFixtureGraph();
  addJavaFacts(g, javaFacts());
  return g;
}

test('endpoint_impact: price reaches POST /product/update at SOUND_SET (weakest link), contract-valid', () => {
  const g = stitchedGraph();
  const resp = endpoint_impact(g, { column: 'pms_product.price' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const eps = resp.answer.endpoints;
  const hit = eps.find((e) => e.path === '/product/update' && e.httpMethod === 'POST');
  assert.ok(hit, 'POST /product/update should be reachable from pms_product.price');
  assert.equal(hit.grade, 'SOUND_SET'); // a MAY_CALL edge is on the path — never EXACT
  assert.equal(resp.trust.axes.includes('endpoint'), true);
});

test('endpoint_impact: empty reason "not-shipped" when the pack has no code axis', () => {
  const g = buildFixtureGraph(); // SQL only — no endpoint nodes
  const resp = endpoint_impact(g, { column: 'pms_product.price' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.endpoints.length, 0);
  assert.equal(resp.answer.empty.endpoints, 'not-shipped');
});

test('endpoint_impact: empty reason "none" when code axis exists but no endpoint reaches the column', () => {
  const g = stitchedGraph();
  // pms_product.id is only read by the mapper; the stitched endpoint writes via
  // updateByPrimaryKey which DOES read id too, so pick a column no statement of
  // the reachable path touches: add an isolated column with no statement edge.
  g.addNode({ id: nodeId('column', 'pms_product.orphan'), name: 'orphan' });
  const resp = endpoint_impact(g, { column: 'pms_product.orphan' }, ctx(g));
  assert.equal(resp.answer.endpoints.length, 0);
  assert.equal(resp.answer.empty.endpoints, 'none');
});

test('endpoint_impact: unknown column throws ToolError unknown-column', () => {
  const g = stitchedGraph();
  assert.throws(() => endpoint_impact(g, { column: 'pms_product.nope' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'unknown-column');
});

test('endpoint_impact: bad mode throws ToolError bad-input', () => {
  const g = stitchedGraph();
  assert.throws(() => endpoint_impact(g, { column: 'pms_product.price', mode: 'loose' }, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input');
});

// ---------------------------------------------------------------------------
// Schema relations are NOT flow — the walk must not climb DECLARES or JOINS.
//
//   endpoint POST /t/update --HANDLES--> com.x.TController#update
//     --MAY_CALL--> TMapper#upd --IMPLEMENTS_STMT--> statement TMapper.upd
//     --EXECUTES--> table t, --WRITES--> column t.a          (t.b: untouched)
//   table t --JOINS--> table u                    (no statement here runs u)
//
// Every one of these tests also proves the edge IS in the graph (an unfiltered
// backward walk still reaches the endpoint), so a green result means the filter
// did the work — not that the fixture forgot to connect something.
// ---------------------------------------------------------------------------

const T_ENDPOINT = nodeId('endpoint', 'POST /t/update');

function schemaEdgeGraph() {
  const g = buildGraphFromSql([
    { kind: 'table', schema: null, table: 't', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'a', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'b', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'u', comment: null },
    { kind: 'column', schema: null, table: 'u', column: 'k', type: 'INT', comment: null },
  ], [
    {
      kind: 'lineage', namespace: 'TMapper', id: 'upd', type: 'update',
      tables: [{ table: 't', access: 'write' }],
      columns: [{ table: 't', column: 'a', access: 'write' }],
      file: 'TMapper.xml', line: 1,
    },
  ]);
  addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.TController', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [], extends: null },
    { kind: 'type', fqn: 'TMapper', typeKind: 'interface', package: '', implements: [], extends: null },
    { kind: 'import', owner: 'com.x.TController', simple: 'TMapper', fqn: 'TMapper' },
    { kind: 'field', owner: 'com.x.TController', name: 'm', typeSimple: 'TMapper' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/t/update', handler: 'com.x.TController#update', handlerType: 'com.x.TController' },
    { kind: 'call', from: 'com.x.TController#update', receiver: 'm', method: 'upd', toTypeSimple: 'TMapper' },
    { kind: 'method', fqn: 'TMapper#upd', owner: 'TMapper', name: 'upd', paramCount: 1 },
  ]);
  // A schema relation, not an execution step: the two tables are joined
  // somewhere in the SQL, but no statement on this chain executes u.
  g.addEdge({ from: nodeId('table', 't'), to: nodeId('table', 'u'), type: 'JOINS', grade: 'EXACT', evidence: { columns: ['a=k'], count: 1 } });
  return g;
}

test('endpoint_impact: the endpoint is reported for the column the SQL writes, and NOT for a sibling column of the same table', () => {
  const g = schemaEdgeGraph();
  const hit = endpoint_impact(g, { column: 't.a' }, ctx(g));
  assert.doesNotThrow(() => assertContract(hit));
  assert.deepEqual(hit.answer.endpoints.map((e) => e.id), ['POST /t/update']);
  assert.equal(hit.answer.empty, undefined);

  const miss = endpoint_impact(g, { column: 't.b' }, ctx(g));
  assert.doesNotThrow(() => assertContract(miss));
  assert.deepEqual(miss.answer.endpoints, []);
  // the code axis IS in this pack — nothing reaches t.b, which is not the same
  // as "the Java lane was never run"
  assert.equal(miss.answer.empty.endpoints, 'none');

  assert.ok(g.impactOf(nodeId('column', 't.b'), { mode: 'conservative' }).has(T_ENDPOINT),
    'without the flow filter t.b climbs DECLARES to table t and inherits the endpoint');
});

test('endpoint_impact: a JOINS neighbour is schema too — a column of the joined table reports no endpoint', () => {
  const g = schemaEdgeGraph();
  const r = endpoint_impact(g, { column: 'u.k' }, ctx(g));
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.answer.endpoints, []);
  assert.equal(r.answer.empty.endpoints, 'none');
  assert.ok(g.impactOf(nodeId('column', 'u.k'), { mode: 'conservative' }).has(T_ENDPOINT),
    'without the filter u.k climbs DECLARES then JOINS and inherits an endpoint that never touches table u');
});

test('endpoint_impact / changed_impact: an Object.prototype key is a bad mode, not a mode', () => {
  const g = stitchedGraph();
  for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => endpoint_impact(g, { column: 'pms_product.price', mode: m }, ctx(g)),
      (e) => e instanceof ToolError && e.code === 'bad-input', `endpoint_impact accepted mode=${m}`);
    assert.throws(() => changed_impact(g, { files: ['x.java'], mode: m }, ctx(g)),
      (e) => e instanceof ToolError && e.code === 'bad-input', `changed_impact accepted mode=${m}`);
  }
});

// ---------------------------------------------------------------------------
// The web lane in the answers (RM28)
// ---------------------------------------------------------------------------

/**
 * The fixture graph with a frontend hanging off one endpoint, exactly as the
 * web bridge leaves it: a `lane:'web'` symbol, a graded CALLS_HTTP edge onto the
 * route, and one edge that stayed UNRESOLVED.
 */
function graphWithFrontend() {
  const g = buildFixtureGraph();
  g.addNode({
    id: 'endpoint:GET /product/list', path: '/product/list', httpMethod: 'GET', handler: 'com.demo.PC#list',
  });
  g.addNode({ id: 'symbol:com.demo.PC#list', symbol: 'com.demo.PC#list', owner: 'com.demo.PC' });
  g.addEdge({
    from: 'endpoint:GET /product/list', to: 'symbol:com.demo.PC#list', type: 'HANDLES', grade: 'EXACT',
  });
  g.addEdge({
    from: 'symbol:com.demo.PC#list', to: `statement:${SELECT_ID}`, type: 'IMPLEMENTS_STMT', grade: 'EXACT',
  });
  for (const [name, line] of [['listProducts', 4], ['reloadProducts', 9]]) {
    g.addNode({
      id: `symbol:web/src/api/product.js#${name}`,
      symbol: `web/src/api/product.js#${name}`,
      file: 'web/src/api/product.js',
      line,
      lane: 'web',
      exported: 'named',
    });
    g.addEdge({
      from: `symbol:web/src/api/product.js#${name}`,
      to: 'endpoint:GET /product/list',
      type: 'CALLS_HTTP',
      grade: 'SOUND_SET',
      evidence: { rule: 'web-http-call' },
    });
  }
  // A call this analysis could not attach: below every mode's floor, so it must
  // not be counted as a caller either.
  g.addNode({
    id: 'symbol:web/src/api/other.js#gone', symbol: 'web/src/api/other.js#gone', file: 'web/src/api/other.js', line: 2, lane: 'web',
  });
  g.addEdge({
    from: 'symbol:web/src/api/other.js#gone',
    to: 'endpoint:GET /product/list',
    type: 'CALLS_HTTP',
    grade: 'UNRESOLVED',
    evidence: { rule: 'web-http-call' },
  });
  return g;
}

test('endpoint_impact: an endpoint row says how many frontend functions call it, UNRESOLVED ones excluded', () => {
  const g = graphWithFrontend();
  const resp = endpoint_impact(g, { column: 'pms_product.price', mode: 'heuristic' }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const row = resp.answer.endpoints.find((e) => e.id === 'GET /product/list');
  assert.ok(row, JSON.stringify(resp.answer.endpoints));
  assert.equal(row.frontendCalls, 2, 'two resolved callers; the UNRESOLVED one is below every floor');
});

test('endpoint_impact: an endpoint no frontend calls carries no frontendCalls field at all', () => {
  const g = buildFixtureGraph();
  g.addNode({ id: 'endpoint:GET /plain', path: '/plain', httpMethod: 'GET', handler: 'com.demo.PC#plain' });
  g.addNode({ id: 'symbol:com.demo.PC#plain', symbol: 'com.demo.PC#plain', owner: 'com.demo.PC' });
  g.addEdge({ from: 'endpoint:GET /plain', to: 'symbol:com.demo.PC#plain', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:com.demo.PC#plain', to: `statement:${SELECT_ID}`, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  const resp = endpoint_impact(g, { column: 'pms_product.price', mode: 'heuristic' }, ctx(g));
  const row = resp.answer.endpoints.find((e) => e.id === 'GET /plain');
  assert.ok(row);
  assert.equal(Object.hasOwn(row, 'frontendCalls'), false,
    'a field on every row would read as "no screen calls this" on a pack with no frontend at all');
});

test('search: finds a frontend function by its name or by its file, and says where it lives', () => {
  const g = graphWithFrontend();
  const byName = search(g, { query: 'listProducts' }, ctx(g));
  assert.doesNotThrow(() => assertContract(byName));
  assert.deepEqual(byName.answer.webSymbols, [
    { symbol: 'web/src/api/product.js#listProducts', file: 'web/src/api/product.js', line: 4 },
  ]);
  const byFile = search(g, { query: 'api/product.js' }, ctx(g));
  assert.deepEqual(byFile.answer.webSymbols.map((s) => s.symbol).sort(), [
    'web/src/api/product.js#listProducts', 'web/src/api/product.js#reloadProducts',
  ]);
  // A pack with no frontend says `none` rather than leaving the field out.
  const plain = search(buildFixtureGraph(), { query: 'pms_product' }, ctx(g));
  assert.deepEqual(plain.answer.webSymbols, []);
  assert.equal(plain.answer.empty.webSymbols, 'none');
});

test('neighborhood: walking up from a route lists the frontend functions that call it', () => {
  const g = graphWithFrontend();
  const resp = neighborhood(g, { endpoint: 'GET /product/list', direction: 'up', hops: 1 }, ctx(g));
  assert.doesNotThrow(() => assertContract(resp));
  const web = resp.answer.nodes.filter((n) => n.lane === 'web');
  assert.deepEqual(web.map((n) => n.id).sort(), [
    'symbol:web/src/api/other.js#gone',
    'symbol:web/src/api/product.js#listProducts',
    'symbol:web/src/api/product.js#reloadProducts',
  ]);
  // The label is the file's own name plus the function, not the extension.
  assert.equal(web.find((n) => n.id.endsWith('#listProducts')).label, 'product.js#listProducts');
  // A backend symbol carries no `lane` at all, so the two cannot be confused.
  assert.equal(resp.answer.nodes.some((n) => n.id === 'symbol:com.demo.PC#list' && n.lane), false);
});

// ---------------------------------------------------------------------------
// THE SCREEN AXIS through the tools (RM30 §D)
// ---------------------------------------------------------------------------
//
// One hand-built pack that has both ends of the round trip on it, so the four
// tools that gained something this round can be asked the same question and
// have to give the same answer.

function screenPack() {
  const g = buildFixtureGraph();
  const SCREEN = nodeId('screen', '/products/edit');
  const VIEW = nodeId('symbol', 'src/screens/products/edit.vue#save');
  const API = nodeId('symbol', 'src/api/products.js#saveProduct');
  const EP = nodeId('endpoint', 'POST /products/save');
  const HANDLER = nodeId('symbol', 'com.x.ProductController#save');
  const MAPPER = nodeId('symbol', 'com.x.PmsProductMapper#updateByPrimaryKey');
  g.addNode({
    id: SCREEN, path: '/products/edit', label: 'edit', title: 'Edit a product', name: 'ProductEdit',
    group: 'products', component: 'src/screens/products/edit.vue', lane: 'web', source: 'router',
    file: 'src/router/index.js', line: 12,
  });
  g.addNode({ id: VIEW, file: 'src/screens/products/edit.vue', line: 20, lane: 'web', component: true });
  g.addNode({ id: API, file: 'src/api/products.js', line: 4, lane: 'web' });
  g.addNode({ id: EP, path: '/products/save', httpMethod: 'POST' });
  g.addNode({ id: HANDLER, owner: 'com.x.ProductController', file: 'C.java', line: 8 });
  g.addNode({ id: MAPPER, owner: 'com.x.PmsProductMapper', file: 'M.java', line: 3, mapperMethod: true });
  g.addEdge({ from: SCREEN, to: VIEW, type: 'RENDERS', grade: 'EXACT', evidence: { rule: 'route-component' } });
  g.addEdge({ from: VIEW, to: API, type: 'CALLS', grade: 'EXACT', evidence: { rule: 'esm-import' } });
  g.addEdge({ from: API, to: EP, type: 'CALLS_HTTP', grade: 'SOUND_SET', evidence: { rule: 'web-http-call' } });
  g.addEdge({ from: EP, to: HANDLER, type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: HANDLER, to: MAPPER, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: MAPPER, to: nodeId('statement', UPDATE_ID), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  return { g, SCREEN, VIEW, API, EP };
}

const shipped = (g) => ({ ...ctx(g), pack: { axes: { screen: { status: 'shipped', reason: null }, code: { status: 'shipped', reason: null } } } });

test('screen_impact: a column change names the screen, the routes it goes through and its grade', async () => {
  const { g } = screenPack();
  const { screen_impact } = await import('../src/mcp/tools.mjs');
  const r = screen_impact(g, { column: 'pms_product.price', mode: 'conservative' }, shipped(g));
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.answer.target, {
    kind: 'column', id: 'pms_product.price', short: 'pms_product.price', comment: 'unit price',
  });
  assert.deepEqual(r.answer.screens, [{
    screen: '/products/edit',
    label: 'edit',
    grade: 'SOUND_SET',
    endpoints: ['POST /products/save'],
    observed: false,
  }]);
  assert.deepEqual(r.truncated.fields[0], {
    field: 'screens', shown: 1, total: 1, order: 'grade desc, screen asc', nextOffset: null,
  });
  assert.ok(r.limits.some((l) => l.scope === 'screen'), 'the walk behind the answer is disclosed');
});

test('screen_impact: the same answer from a table, a statement and a method', async () => {
  const { g } = screenPack();
  const { screen_impact } = await import('../src/mcp/tools.mjs');
  for (const args of [
    { table: 'pms_product' },
    { statement: UPDATE_ID },
    { symbol: 'com.x.PmsProductMapper#updateByPrimaryKey' },
  ]) {
    const r = screen_impact(g, { ...args, mode: 'conservative' }, shipped(g));
    assert.deepEqual(r.answer.screens.map((s) => s.screen), ['/products/edit'], JSON.stringify(args));
  }
});

test('screen_impact: exactly one target, and a target this pack does not have is named', async () => {
  const { g } = screenPack();
  const { screen_impact } = await import('../src/mcp/tools.mjs');
  assert.throws(() => screen_impact(g, {}, shipped(g)), (e) => e instanceof ToolError && e.code === 'bad-input');
  assert.throws(() => screen_impact(g, { column: 'pms_product.price', table: 'pms_product' }, shipped(g)),
    (e) => e instanceof ToolError && e.code === 'bad-input');
  assert.throws(() => screen_impact(g, { statement: 'nope.nope' }, shipped(g)),
    (e) => e instanceof ToolError && e.code === 'unknown-statement');
});

test('screen_impact: empty is `not-shipped` with no screen axis, and `none` with one', async () => {
  const { screen_impact } = await import('../src/mcp/tools.mjs');
  // No screen node anywhere: the axis never ran.
  const bare = buildFixtureGraph();
  const r = screen_impact(bare, { column: 'pms_product.price' }, ctx(bare));
  assert.deepEqual(r.answer.screens, []);
  assert.equal(r.answer.empty.screens, 'not-shipped');

  // An axis that IS there, and a column no screen reaches.
  const { g } = screenPack();
  const other = screen_impact(g, { column: 'pms_product.id', mode: 'strict' }, shipped(g));
  assert.deepEqual(other.answer.screens, []);
  assert.equal(other.answer.empty.screens, 'none');
});

test('endpoint_impact: every row names the screens on the other side of the route', async () => {
  const { g } = screenPack();
  const r = endpoint_impact(g, { column: 'pms_product.price', mode: 'conservative' }, shipped(g));
  const row = r.answer.endpoints.find((e) => e.id === 'POST /products/save');
  assert.deepEqual(row.screens, { count: 1, sample: ['/products/edit'] });
  assert.equal(row.frontendCalls, 1);

  // ...and on a pack with NO screen axis the field is absent, because `{count:0}`
  // would read as "no screen calls this" where nothing was ever read.
  const bare = buildFixtureGraph();
  const none = endpoint_impact(bare, { column: 'pms_product.price', mode: 'conservative' }, ctx(bare));
  for (const e of none.answer.endpoints) assert.equal('screens' in e, false);
});

test('browse kind=screen: the rows carry the component and the census, and counts holds the total', async () => {
  const { g } = screenPack();
  const { browse } = await import('../src/mcp/tools.mjs');
  const r = browse(g, { kind: 'screen' }, shipped(g));
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.answer.items, [{
    screen: '/products/edit',
    path: '/products/edit',
    label: 'edit',
    title: 'Edit a product',
    group: 'products',
    component: 'src/screens/products/edit.vue',
    source: 'router',
    endpoints: 1,
    tables: 1,
    observed: false,
  }]);
  assert.equal(r.answer.counts.screen, 1);
  assert.equal(r.answer.sort, 'endpoints');
  assert.ok(r.limits.some((l) => l.scope === 'screen'));

  // A pack with no screen axis lists nothing, and says which kind of nothing.
  const bare = buildFixtureGraph();
  const empty = browse(bare, { kind: 'screen' }, ctx(bare));
  assert.deepEqual(empty.answer.items, []);
  assert.equal(empty.answer.empty.items, 'not-shipped');
});

test('flow: `screen=` walks down from the other end of the round trip', async () => {
  const { g } = screenPack();
  const { flow } = await import('../src/mcp/tools.mjs');
  const r = flow(g, { screen: '/products/edit', mode: 'conservative' }, shipped(g));
  assert.doesNotThrow(() => assertContract(r));
  assert.equal(r.answer.entry.kind, 'screen');
  assert.equal(r.answer.entry.component, 'src/screens/products/edit.vue');
  assert.equal(r.answer.walk.depth, 8, 'a screen entry defaults to the full depth');
  assert.deepEqual(r.truncated.fields.map((f) => f.field),
    ['webFunctions', 'endpoints', 'services', 'statements', 'tables']);
  assert.deepEqual(r.answer.webFunctions.map((x) => x.id),
    ['src/screens/products/edit.vue#save', 'src/api/products.js#saveProduct']);
  assert.deepEqual(r.answer.endpoints.map((x) => x.id), ['POST /products/save']);
  assert.deepEqual(r.answer.tables.map((x) => x.table), ['pms_product']);
  // A screen this pack does not have is named, not answered with nothing.
  assert.throws(() => flow(g, { screen: '/nope' }, shipped(g)), (e) => e.code === 'unknown-screen');
  // ...and a screen is a direction=down entry only.
  assert.throws(() => flow(g, { screen: '/products/edit', direction: 'up' }, shipped(g)),
    (e) => e.code === 'bad-input');
});

test('flow list kind=screen: the screens a chain can be walked from, busiest first', async () => {
  const { g, SCREEN } = screenPack();
  void SCREEN;
  g.addNode({
    id: nodeId('screen', '/products/list'), path: '/products/list', label: 'list',
    group: 'products', component: null, lane: 'web', source: 'router',
  });
  const { flow } = await import('../src/mcp/tools.mjs');
  const r = flow(g, { kind: 'screen' }, shipped(g));
  assert.equal(r.answer.kind, 'screen');
  assert.deepEqual(r.answer.entries.map((e) => [e.screen, e.endpoints]), [
    ['/products/edit', 1],
    ['/products/list', 0],
  ]);
  const filtered = flow(g, { kind: 'screen', query: 'list' }, shipped(g));
  assert.deepEqual(filtered.answer.entries.map((e) => e.screen), ['/products/list']);
  assert.throws(() => flow(g, { kind: 'nope' }, shipped(g)), (e) => e.code === 'bad-input');
});

test('search and neighborhood list screen nodes like any other kind', async () => {
  const { g, SCREEN } = screenPack();
  const found = search(g, { query: 'products/edit' }, shipped(g));
  assert.deepEqual(found.answer.screens, [{
    screen: '/products/edit', label: 'edit', title: 'Edit a product',
    component: 'src/screens/products/edit.vue', source: 'router',
  }]);
  const around = neighborhood(g, { screen: '/products/edit', direction: 'down', hops: 1 }, shipped(g));
  assert.equal(around.answer.focus, SCREEN);
  assert.deepEqual(around.answer.nodes.map((n) => n.id).sort(),
    [SCREEN, 'symbol:src/screens/products/edit.vue#save']);
  assert.equal(around.answer.nodes.find((n) => n.id === SCREEN).label, 'edit');
});

test('changed_impact: editing a component names the screens it is drawn on', async () => {
  const { g } = screenPack();
  const r = changed_impact(g, { files: ['src/api/products.js'], mode: 'conservative' }, shipped(g));
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.answer.touched.webSymbols, ['src/api/products.js#saveProduct']);
  assert.deepEqual(r.answer.touched.screens, ['/products/edit'],
    'an edited api function is felt on every screen whose component calls it');
  assert.deepEqual(r.answer.calledEndpoints.map((e) => e.id), ['POST /products/save']);
});
