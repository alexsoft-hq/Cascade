import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { endpointsAffectingColumn } from '../src/adapters/java_bridge.mjs';
import { walkEndpoints } from '../src/core/walks.mjs';
import { browse, ToolError } from '../src/mcp/tools.mjs';
import { callTool, TOOLS } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph, mallPack } from './helpers/mall_fixture.mjs';

// `browse` (RM27) — the lists the viewer's rail opens on, and the tool an AI
// calls when it does not have a name yet.
//
// THE FIXTURE, in one picture:
//
//   GET  /p/{id}    -> PController#get    -> PService.load   -> PMapper.selectByPrimaryKey
//   GET  /p/search  -> PController#search -> PService.search -> PMapper.findByName
//   POST /p/save    -> PController#save   -> PService.save   -> PMapper.updateByPrimaryKey
//   POST /p/create  -> PController#create -> (calls nothing)
//   POST /billing/charge  a route this pack CALLS over HTTP and does not serve
//
// so `p.name` is read by TWO statements and reached by TWO endpoints, `p` has a
// comment and `q` has none, one endpoint reaches no statement at all, and the
// outbound route is neither listed nor counted.

function catalog() {
  return [
    { kind: 'table', schema: null, table: 'p', comment: 'the product table' },
    { kind: 'column', schema: null, table: 'p', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'p', column: 'name', type: 'VARCHAR', comment: 'display name' },
    { kind: 'column', schema: null, table: 'p', column: 'price', type: 'DECIMAL', comment: null },
    { kind: 'table', schema: null, table: 'q', comment: null },
    { kind: 'column', schema: null, table: 'q', column: 'id', type: 'INT', comment: null, pk: true },
    { kind: 'column', schema: null, table: 'q', column: 'p_id', type: 'INT', comment: null },
  ];
}
function lineage() {
  return [
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'selectByPrimaryKey', type: 'select',
      tables: [{ table: 'p', access: 'read' }],
      columns: [
        { table: 'p', column: 'id', access: 'read' },
        { table: 'p', column: 'name', access: 'read' },
        { table: 'p', column: 'price', access: 'read' },
      ],
      file: 'PMapper.xml', line: 10,
    },
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'findByName', type: 'select',
      tables: [{ table: 'p', access: 'read' }],
      columns: [{ table: 'p', column: 'name', access: 'read' }],
      file: 'PMapper.xml', line: 20,
      hasStringSubst: true,
    },
    {
      kind: 'lineage', namespace: 'com.x.PMapper', id: 'updateByPrimaryKey', type: 'update',
      tables: [{ table: 'p', access: 'write' }, { table: 'q', access: 'write' }],
      columns: [
        { table: 'p', column: 'price', access: 'write' },
        { table: 'q', column: 'p_id', access: 'write' },
      ],
      file: 'PMapper.xml', line: 30,
    },
  ];
}
function javaFacts() {
  return [
    { kind: 'type', fqn: 'com.x.PController', typeKind: 'class', package: 'com.x', file: 'src/PController.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PService', typeKind: 'interface', package: 'com.x', file: 'src/PService.java', implements: [] },
    { kind: 'type', fqn: 'com.x.PServiceImpl', typeKind: 'class', package: 'com.x', file: 'src/PServiceImpl.java', implements: ['PService'] },
    { kind: 'type', fqn: 'com.x.PMapper', typeKind: 'interface', package: 'com.x', file: 'src/PMapper.java', implements: [] },
    { kind: 'type', fqn: 'com.ext.Ext', typeKind: 'class', package: 'com.ext', implements: [] }, // no file: external
    { kind: 'import', owner: 'com.x.PController', simple: 'Ext', fqn: 'com.ext.Ext' },
    { kind: 'method', fqn: 'com.x.PController#get', owner: 'com.x.PController', paramCount: 1, line: 30 },
    { kind: 'method', fqn: 'com.x.PController#search', owner: 'com.x.PController', paramCount: 1, line: 38 },
    { kind: 'method', fqn: 'com.x.PController#save', owner: 'com.x.PController', paramCount: 1, line: 46 },
    { kind: 'method', fqn: 'com.x.PController#create', owner: 'com.x.PController', paramCount: 1, line: 54 },
    { kind: 'method', fqn: 'com.x.PServiceImpl#load', owner: 'com.x.PServiceImpl', paramCount: 1, line: 20 },
    { kind: 'method', fqn: 'com.x.PServiceImpl#search', owner: 'com.x.PServiceImpl', paramCount: 1, line: 28 },
    { kind: 'method', fqn: 'com.x.PServiceImpl#save', owner: 'com.x.PServiceImpl', paramCount: 1, line: 36 },
    { kind: 'method', fqn: 'com.x.PMapper#selectByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 7 },
    { kind: 'method', fqn: 'com.x.PMapper#findByName', owner: 'com.x.PMapper', paramCount: 1, line: 9 },
    { kind: 'method', fqn: 'com.x.PMapper#updateByPrimaryKey', owner: 'com.x.PMapper', paramCount: 1, line: 12 },
    { kind: 'call', from: 'com.x.PController#get', receiver: 's', method: 'load', toTypeSimple: 'PService' },
    { kind: 'call', from: 'com.x.PController#get', receiver: 'e', method: 'send', toTypeSimple: 'Ext' },
    { kind: 'call', from: 'com.x.PController#search', receiver: 's', method: 'search', toTypeSimple: 'PService' },
    { kind: 'call', from: 'com.x.PController#save', receiver: 's', method: 'save', toTypeSimple: 'PService' },
    { kind: 'call', from: 'com.x.PServiceImpl#load', receiver: 'm', method: 'selectByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'call', from: 'com.x.PServiceImpl#search', receiver: 'm', method: 'findByName', toTypeSimple: 'PMapper' },
    { kind: 'call', from: 'com.x.PServiceImpl#save', receiver: 'm', method: 'updateByPrimaryKey', toTypeSimple: 'PMapper' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/p/{id}', handler: 'com.x.PController#get', line: 30 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/p/search', handler: 'com.x.PController#search', line: 38 },
    { kind: 'endpoint', httpMethod: 'POST', path: '/p/save', handler: 'com.x.PController#save', line: 46 },
    { kind: 'endpoint', httpMethod: 'POST', path: '/p/create', handler: 'com.x.PController#create', line: 54 },
    { kind: 'transactional', method: 'com.x.PServiceImpl#save', scope: 'method', line: 36 },
  ];
}
/** A route this pack CALLS over HTTP and does not serve (a @FeignClient target). */
function outboundFacts() {
  return [
    { kind: 'type',
      fqn: 'com.x.BillingClient',
      typeKind: 'interface',
      package: 'com.x',
      annotations: ['FeignClient'],
      implements: [],
      declaredMethods: ['charge/1'],
      client: { kind: 'FeignClient', service: 'BILLING', serviceLiteral: false, url: null, path: '/billing' },
      file: 'src/BillingClient.java' },
    { kind: 'endpoint', httpMethod: 'POST', path: '/billing/charge', handler: 'com.x.BillingClient#charge', handlerType: 'com.x.BillingClient', line: 5, file: 'src/BillingClient.java' },
  ];
}

function fixture() {
  const g = buildGraphFromSql(catalog(), lineage());
  // The prefix is what makes `com.ext` EXTERNAL: a type is a library class
  // because it sits outside the packages the profile declares, never because
  // the lane happened not to see its file.
  addJavaFacts(g, [...javaFacts(), ...outboundFacts()], { packagePrefixes: ['com.x'] });
  return g;
}
const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ctx = (graph) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });
/** Every response in this file goes through the contract before it is read. */
const call = (graph, args) => { const r = browse(graph, args, ctx(graph)); assertContract(r); return r; };
const ids = (r, field) => r.answer.items.map((x) => x[field]);
const rowOf = (r, field, key) => r.answer.items.find((x) => x[field] === key);

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

test('kind=table: every row carries what the rail shows, and a table with no comment says null', () => {
  const r = call(fixture(), { kind: 'table' });
  assert.equal(r.answer.kind, 'table');
  assert.equal(r.answer.sort, 'statements', 'the default sort is the busiest-first one');
  assert.deepEqual(ids(r, 'table'), ['p', 'q'], '3 statements touch p, 1 touches q');
  assert.deepEqual(rowOf(r, 'table', 'p'), {
    table: 'p', comment: 'the product table', columns: 3,
    statementsRead: 2, statementsWrite: 1, endpoints: 3, groups: 1,
  });
  assert.deepEqual(rowOf(r, 'table', 'q'), {
    table: 'q', comment: null, columns: 2,
    statementsRead: 0, statementsWrite: 1, endpoints: 1, groups: 1,
  });
  assert.equal(r.answer.total, 2);
});

test('kind=table: a DELETE counts as a write, because it changes the rows', () => {
  const g = buildGraphFromSql(
    [{ kind: 'table', schema: null, table: 'p', comment: null }],
    [{ kind: 'lineage', namespace: 'M', id: 'wipe', type: 'delete', tables: [{ table: 'p', access: 'delete' }], columns: [], file: 'M.xml', line: 1 }],
  );
  const row = rowOf(call(g, { kind: 'table' }), 'table', 'p');
  assert.equal(row.statementsWrite, 1);
  assert.equal(row.statementsRead, 0);
});

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

test('kind=column: a column read by TWO statements is reached by the TWO endpoints above them', () => {
  const r = call(fixture(), { kind: 'column' });
  assert.deepEqual(rowOf(r, 'column', 'p.name'), {
    column: 'p.name', table: 'p', type: 'VARCHAR', pk: false, comment: 'display name',
    reads: 2, writes: 0, endpoints: 2,
  });
  assert.deepEqual(rowOf(r, 'column', 'p.id'), {
    column: 'p.id', table: 'p', type: 'INT', pk: true, comment: null,
    reads: 1, writes: 0, endpoints: 1,
  });
  // Read by the select AND written by the update, so two endpoints reach it by
  // two different routes.
  const price = rowOf(r, 'column', 'p.price');
  assert.deepEqual([price.reads, price.writes, price.endpoints], [1, 1, 2]);
  assert.equal(r.answer.total, 5);
  assert.equal(r.answer.sort, 'writes');
});

test('kind=column with table=: just that table\'s columns, and the identity rule resolves the name', () => {
  const g = fixture();
  const r = call(g, { kind: 'column', table: 'p', sort: 'name' });
  assert.deepEqual(ids(r, 'column'), ['p.id', 'p.name', 'p.price']);
  assert.equal(r.answer.total, 3);
  // An unknown table is the schema layer's own error, not an empty list.
  assert.throws(() => call(g, { kind: 'column', table: 'nope' }), (e) => e instanceof ToolError && e.code === 'unknown-table');
  // ...and `table=` means nothing for the other kinds rather than being ignored.
  assert.throws(() => call(g, { kind: 'table', table: 'p' }), (e) => e instanceof ToolError && e.code === 'bad-input');
});

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------

test('kind=statement: its type, how many tables it touches, its own honesty flags and where it lives', () => {
  const r = call(fixture(), { kind: 'statement', sort: 'name' });
  assert.deepEqual(ids(r, 'statement'), [
    'com.x.PMapper.findByName', 'com.x.PMapper.selectByPrimaryKey', 'com.x.PMapper.updateByPrimaryKey',
  ]);
  assert.deepEqual(rowOf(r, 'statement', 'com.x.PMapper.updateByPrimaryKey'), {
    statement: 'com.x.PMapper.updateByPrimaryKey', type: 'update', tables: 2,
    hasUnresolved: false, hasStringSubst: false, file: 'PMapper.xml', line: 30, endpoints: 1,
  });
  // The `${}` flag is the SQL lane's own, carried from the mapper onto the node.
  assert.equal(rowOf(r, 'statement', 'com.x.PMapper.findByName').hasStringSubst, true);
  assert.equal(rowOf(r, 'statement', 'com.x.PMapper.findByName').endpoints, 1);
});

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

test('kind=endpoint: an endpoint that reaches no statement is LISTED with zeroes, and an OUTBOUND route is not listed at all', () => {
  const r = call(fixture(), { kind: 'endpoint', sort: 'path' });
  assert.deepEqual(ids(r, 'endpoint'),
    ['POST /p/create', 'POST /p/save', 'GET /p/search', 'GET /p/{id}'],
    'sorted by path, and the outbound /billing/charge is absent');
  assert.deepEqual(rowOf(r, 'endpoint', 'POST /p/create'), {
    endpoint: 'POST /p/create', httpMethod: 'POST', path: '/p/create', group: 'p',
    handlerShort: 'PController#create', handlers: 1, statements: 0, tables: 0,
  });
  assert.deepEqual(rowOf(r, 'endpoint', 'POST /p/save'), {
    endpoint: 'POST /p/save', httpMethod: 'POST', path: '/p/save', group: 'p',
    handlerShort: 'PController#save', handlers: 1, statements: 1, tables: 2,
  });
  assert.equal(r.answer.total, 4);
});

// ---------------------------------------------------------------------------
// symbols — the one kind that demands a query
// ---------------------------------------------------------------------------

test('kind=symbol without a query is bad-input: a pack carries tens of thousands of methods', () => {
  const g = fixture();
  for (const args of [{ kind: 'symbol' }, { kind: 'symbol', query: '' }, { kind: 'symbol', query: 'a' }]) {
    assert.throws(() => call(g, args), (e) => e instanceof ToolError && e.code === 'bad-input',
      `${JSON.stringify(args)} should be refused`);
  }
});

test('kind=symbol with a query: the method, its owner, its short name, and what it IS', () => {
  const r = call(fixture(), { kind: 'symbol', query: 'PServiceImpl' });
  assert.deepEqual(ids(r, 'symbol'), [
    'com.x.PServiceImpl#load', 'com.x.PServiceImpl#save', 'com.x.PServiceImpl#search',
  ]);
  assert.deepEqual(rowOf(r, 'symbol', 'com.x.PServiceImpl#save'), {
    symbol: 'com.x.PServiceImpl#save', owner: 'com.x.PServiceImpl', short: 'PServiceImpl#save',
    file: 'src/PServiceImpl.java', line: 36, transactional: true, mapperMethod: false, external: false,
  });
  const mapper = rowOf(call(fixture(), { kind: 'symbol', query: 'PMapper#find' }), 'symbol', 'com.x.PMapper#findByName');
  assert.equal(mapper.mapperMethod, true, 'a mapper method IS a statement');
  const ext = rowOf(call(fixture(), { kind: 'symbol', query: 'com.ext' }), 'symbol', 'com.ext.Ext#send');
  assert.equal(ext.external, true, 'a type with no source here is external');
});

// ---------------------------------------------------------------------------
// query / sort / limit / offset / counts
// ---------------------------------------------------------------------------

test('query is a case-insensitive substring over the id AND the row\'s own second line', () => {
  const g = fixture();
  assert.deepEqual(ids(call(g, { kind: 'table', query: 'PRODUCT' }), 'table'), ['p'], 'matched on the comment');
  assert.deepEqual(ids(call(g, { kind: 'column', query: 'display' }), 'column'), ['p.name'], 'matched on the comment');
  assert.deepEqual(ids(call(g, { kind: 'statement', query: 'pmapper.xml' }), 'statement').length, 3, 'matched on the file');
  assert.deepEqual(ids(call(g, { kind: 'endpoint', query: 'search' }), 'endpoint'), ['GET /p/search']);
  assert.deepEqual(ids(call(g, { kind: 'endpoint', query: 'pcontroller#save' }), 'endpoint'), ['POST /p/save'],
    'matched on the handler');
  // A query that matches nothing is `none`, the same word `search` and the
  // `flow` picker use for it; `not-in-this-axis` is reserved for a page that
  // starts past the end of a list that DOES have rows (see the paging test).
  const none = call(g, { kind: 'table', query: 'zzz' });
  assert.deepEqual(none.answer.items, []);
  assert.equal(none.answer.empty.items, 'none');
  assert.equal(none.answer.total, 0);
});

test('sort names a field of the row, and an unknown one is refused rather than ignored', () => {
  const g = fixture();
  assert.deepEqual(ids(call(g, { kind: 'table', sort: 'name' }), 'table'), ['p', 'q']);
  assert.deepEqual(ids(call(g, { kind: 'table', sort: 'endpoints' }), 'table'), ['p', 'q']);
  assert.deepEqual(ids(call(g, { kind: 'column', sort: 'reads' }), 'column')[0], 'p.name', '2 reads is the most');
  assert.deepEqual(ids(call(g, { kind: 'endpoint', sort: 'tables' }), 'endpoint')[0], 'POST /p/save', '2 tables is the most');
  assert.equal(call(g, { kind: 'table' }).truncated.fields[0].order, 'statements desc, table asc');
  assert.equal(call(g, { kind: 'table', sort: 'name' }).truncated.fields[0].order, 'table asc');
  assert.equal(call(g, { kind: 'endpoint', sort: 'path' }).truncated.fields[0].order, 'path asc, httpMethod asc');
  assert.throws(() => call(g, { kind: 'table', sort: 'reads' }), (e) => e instanceof ToolError && e.code === 'bad-input',
    'reads is a COLUMN field; a table has none');
  assert.throws(() => call(g, { kind: 'nope' }), (e) => e instanceof ToolError && e.code === 'bad-input');
});

test('limit and offset page the list, and `truncated` says where the rest starts', () => {
  const g = fixture();
  const page1 = call(g, { kind: 'column', sort: 'name', limit: 2 });
  assert.deepEqual(ids(page1, 'column'), ['p.id', 'p.name']);
  assert.equal(page1.answer.total, 5);
  assert.equal(page1.truncated.any, true);
  assert.deepEqual(page1.truncated.fields[0], { field: 'items', shown: 2, total: 5, order: 'column asc', nextOffset: 2 });
  const page2 = call(g, { kind: 'column', sort: 'name', limit: 2, offset: 2 });
  assert.deepEqual(ids(page2, 'column'), ['p.price', 'q.id']);
  const last = call(g, { kind: 'column', sort: 'name', limit: 2, offset: 4 });
  assert.deepEqual(ids(last, 'column'), ['q.p_id']);
  assert.equal(last.truncated.any, false, 'the last page has nothing after it');
  // Past the end is "not in this axis", never a silent empty answer.
  const past = call(g, { kind: 'column', limit: 2, offset: 99 });
  assert.equal(past.answer.empty.items, 'not-in-this-axis');
  assert.throws(() => call(g, { kind: 'table', limit: 501 }), (e) => e instanceof ToolError && e.code === 'bad-input');
});

test('counts: the pack total for EVERY kind rides on every answer, whatever kind was asked for', () => {
  const g = fixture();
  const want = { table: 2, column: 5, statement: 3, endpoint: 4, symbol: 15, screen: 0 };
  for (const kind of ['table', 'column', 'statement', 'endpoint']) {
    assert.deepEqual(call(g, { kind }).answer.counts, want, `counts on kind=${kind}`);
  }
  assert.deepEqual(call(g, { kind: 'symbol', query: 'com.x' }).answer.counts, want);
  // 4, not 5: the outbound route is counted by nobody as one of this pack's endpoints.
  let endpointNodes = 0;
  for (const n of g.nodes.values()) if (n.kind === 'endpoint') endpointNodes += 1;
  assert.equal(endpointNodes, 5, 'the graph really does hold the outbound route as a node');
});

// ---------------------------------------------------------------------------
// the empty states — a lane that never ran is not an empty lane
// ---------------------------------------------------------------------------

test('a pack with no code axis says not-shipped for endpoints and methods, and still lists its tables', () => {
  const g = buildGraphFromSql(catalog(), lineage());   // SQL only: no Java lane
  const eps = call(g, { kind: 'endpoint' });
  assert.deepEqual(eps.answer.items, []);
  assert.equal(eps.answer.empty.items, 'not-shipped');
  const syms = call(g, { kind: 'symbol', query: 'com' });
  assert.equal(syms.answer.empty.items, 'not-shipped');
  // The tables are still there, and their `endpoints` is honestly 0.
  const tables = call(g, { kind: 'table' });
  assert.deepEqual(ids(tables, 'table'), ['p', 'q']);
  assert.equal(rowOf(tables, 'table', 'p').endpoints, 0);
  assert.equal(tables.answer.counts.endpoint, 0);
});

test('a pack with no catalog still lists the tables its statements named', () => {
  const g = buildGraphFromSql([], lineage());
  assert.deepEqual(ids(call(g, { kind: 'table' }), 'table'), ['p', 'q']);
  assert.equal(rowOf(call(g, { kind: 'table' }), 'table', 'p').comment, null);
  // ...and their columns, which no DECLARES edge points at.
  assert.deepEqual(ids(call(g, { kind: 'column', table: 'p', sort: 'name' }), 'column'),
    ['p.id', 'p.name', 'p.price']);
});

test('an empty graph answers `none`, not an unexplained empty list', () => {
  const g = new Graph();
  for (const kind of ['table', 'column', 'statement']) {
    const r = call(g, { kind });
    assert.deepEqual(r.answer.items, []);
    assert.ok(['none', 'not-shipped'].includes(r.answer.empty.items), `${kind}: ${r.answer.empty.items}`);
  }
});

// ---------------------------------------------------------------------------
// the census, and its memo
// ---------------------------------------------------------------------------

test('the walk behind `endpoints` is disclosed in `limits`, with its mode and its depth', () => {
  const r = call(fixture(), { kind: 'table' });
  const scopes = r.limits.map((l) => l.scope);
  assert.ok(scopes.includes('browse'), 'the answer says what `endpoints` counts');
  const walk = r.limits.find((l) => l.scope === 'browse' && /mode=conservative/.test(l.reason));
  assert.ok(walk, `no walk disclosure in: ${JSON.stringify(scopes)}`);
  assert.match(walk.reason, /depth 8/);
  assert.match(walk.reason, /unknown, not absent/);
  // A row that names an API GROUP has to say what a group IS.
  assert.ok(r.limits.some((l) => /first segment of an API path|moduleAttribution/.test(l.reason)));
});

test('the census is computed ONCE per graph: a graph changed after the first call keeps the first answer', () => {
  // The memo is a WeakMap on the graph object, so the only way to SEE it from
  // outside is to change the graph and watch the second answer not notice. A
  // pack's graph is built once and never mutated, which is what makes that safe;
  // this test is the proof the walk is not being re-run per request.
  const g = fixture();
  assert.equal(call(g, { kind: 'endpoint' }).answer.total, 4);
  addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.ZController', typeKind: 'class', package: 'com.x', file: 'src/ZController.java', implements: [] },
    { kind: 'method', fqn: 'com.x.ZController#ping', owner: 'com.x.ZController', paramCount: 0, line: 3 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/z/ping', handler: 'com.x.ZController#ping', line: 3 },
  ]);
  assert.equal(call(g, { kind: 'endpoint' }).answer.total, 4,
    'the second call did NOT walk again, so it did not see the new route');
  // A graph built fresh does see it, which is what a reloaded pack is.
  const fresh = fixture();
  addJavaFacts(fresh, [
    { kind: 'type', fqn: 'com.x.ZController', typeKind: 'class', package: 'com.x', file: 'src/ZController.java', implements: [] },
    { kind: 'method', fqn: 'com.x.ZController#ping', owner: 'com.x.ZController', paramCount: 0, line: 3 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/z/ping', handler: 'com.x.ZController#ping', line: 3 },
  ]);
  assert.equal(call(fresh, { kind: 'endpoint' }).answer.total, 5);
});

// ---------------------------------------------------------------------------
// the catalogue and the contract
// ---------------------------------------------------------------------------

test('the catalogue lists browse, requires `kind`, and its answer goes through the dispatcher intact', () => {
  assert.ok(TOOLS.browse, 'the catalogue has no browse');
  assert.deepEqual(TOOLS.browse.inputSchema.required, ['kind']);
  assert.deepEqual(TOOLS.browse.inputSchema.properties.kind.enum,
    ['table', 'column', 'statement', 'endpoint', 'symbol', 'screen']);
  // callTool asserts the contract itself and turns a ToolError into a
  // DispatchError with the same code.
  const g = fixture();
  const r = callTool('browse', { kind: 'table' }, ctx(g));
  assert.equal(r.answer.kind, 'table');
  assert.deepEqual(r.trust.axes, ['browse']);
  assert.equal(r.basis.buildDigest, 'd');
  assert.throws(() => callTool('browse', {}, ctx(g)), (e) => e.code === 'bad-input');
});

// ---------------------------------------------------------------------------
// mall — the pinned numbers, and the timing the rail depends on
// ---------------------------------------------------------------------------

test('mall: the kind census is the pack\'s own node counts', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { kind: 'table' });
  // RM35: 10784 -> 10869. Seven of the 85 are EXTERNAL members mall's code calls
  // and this lane never parses; the other 78 are project methods whose ONLY call
  // used to be unresolved, so they had no edge and no node (see
  // test/helpers/mall_fixture.mjs). Nothing vanished.
  assert.deepEqual(r.answer.counts, { table: 76, column: 669, statement: 906, endpoint: 239, symbol: 10869, screen: 0 });
  assert.equal(r.answer.total, 76);
  assert.equal(mallPack().digest.length > 0, true);
});

test('mall: the busiest table, and its `endpoints` re-derived from the other direction', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const top = call(g, { kind: 'table' }).answer.items[0];
  assert.equal(top.table, 'pms_product');
  assert.deepEqual(
    { statementsRead: top.statementsRead, statementsWrite: top.statementsWrite, columns: top.columns, endpoints: top.endpoints, groups: top.groups },
    { statementsRead: 12, statementsWrite: 10, columns: 42, endpoints: 29, groups: 8 },
  );

  // THE INDEPENDENT RE-DERIVATION, walked the other way: the union, over every
  // column of that table, of the endpoints an UPWARD impact walk reaches
  // (adapters/java_bridge.endpointsAffectingColumn). It is 31, not 29, and the
  // difference is exactly the DEPTH CAP: `browse` walks forward at depth 8 (the
  // whole-pack default every other census uses), while the upward walk is
  // unbounded. So the tool's set must be a SUBSET, and the same forward walk at
  // depth 10 must agree with the upward one exactly.
  const union = new Set();
  for (const n of g.nodes.values()) {
    if (n.kind !== 'column' || !n.id.startsWith('column:pms_product.')) continue;
    for (const e of endpointsAffectingColumn(g, n.id, { mode: 'conservative' })) union.add(e.endpoint);
  }
  assert.equal(union.size, 31);
  const forward = (depth) => {
    const seen = new Set();
    for (const ep of walkEndpoints(g, { mode: 'conservative', depth }).endpoints) {
      for (const s of ep.statements) {
        for (const e of g.outEdges(s.id)) if (e.type === 'EXECUTES' && e.to === 'table:pms_product') seen.add(ep.id);
      }
    }
    return seen;
  };
  const at8 = forward(8);
  assert.equal(at8.size, top.endpoints, 'the row IS the depth-8 forward walk');
  for (const id of at8) assert.ok(union.has(id), `${id} is in the forward walk but not the upward one`);
  assert.deepEqual([...forward(10)].sort(), [...union].sort(),
    'two more endpoints reach pms_product at 9 or 10 hops, and the depth cap is the only difference');
});

test('mall: the first browse answers well inside 2 s and every later one inside 50 ms', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const ms = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const first = ms(() => call(g, { kind: 'table' }));
  const second = ms(() => call(g, { kind: 'table' }));
  const other = ms(() => call(g, { kind: 'endpoint' }));
  assert.ok(first < 2000, `the first browse took ${first.toFixed(1)} ms`);
  assert.ok(second < 50, `the second browse took ${second.toFixed(1)} ms`);
  assert.ok(other < 50, `browse on another kind took ${other.toFixed(1)} ms`);
});

test('mall: the busiest endpoint, and a route two controllers declare', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const r = call(g, { kind: 'endpoint' });
  assert.equal(r.answer.total, 239);
  const top = r.answer.items[0];
  assert.equal(top.endpoint, 'POST /order/generateOrder');
  assert.equal(top.group, 'order');
  assert.equal(top.handlers, 1);
  assert.equal(top.tables, 12);
  // mall declares `GET /order/list` in two controllers; the row says so, and
  // `handlerShort` names the one the shared primary rule picks.
  const two = rowOf(call(g, { kind: 'endpoint', query: 'GET /order/list' }), 'endpoint', 'GET /order/list');
  assert.equal(two.handlers, 2);
  assert.equal(two.handlerShort, 'OmsOrderController#list');
});

// ---------------------------------------------------------------------------
// The screen count on a table and a column row (RM31)
// ---------------------------------------------------------------------------

// The fixture above has no frontend. This adds one to it: a screen that renders
// a component function, which calls an api function, which calls GET /p/{id} —
// the shape the web bridge really produces. So `p` and `p.name` are reached by
// ONE screen through that route, `q` by none, and every other row is unchanged.
function withScreen() {
  const g = fixture();
  const add = (id, extra) => g.addNode({ id, ...extra });
  add(nodeId('screen', '/products'), { path: '/products', label: '/products', group: 'products',
    component: 'src/views/products.vue', lane: 'web', source: 'router' });
  add(nodeId('symbol', 'src/views/products.vue#load'), { file: 'src/views/products.vue', line: 4, lane: 'web', component: true });
  add(nodeId('symbol', 'src/api/products.js#getOne'), { file: 'src/api/products.js', line: 2, lane: 'web' });
  g.addEdge({ from: nodeId('screen', '/products'), to: nodeId('symbol', 'src/views/products.vue#load'), type: 'RENDERS', grade: 'EXACT' });
  g.addEdge({ from: nodeId('symbol', 'src/views/products.vue#load'), to: nodeId('symbol', 'src/api/products.js#getOne'), type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: nodeId('symbol', 'src/api/products.js#getOne'), to: nodeId('endpoint', 'GET /p/{id}'), type: 'CALLS_HTTP', grade: 'SOUND_SET' });
  return g;
}

test('browse: a table and a column row carry `screens`, from the same walk `kind=screen` lists', () => {
  const g = withScreen();
  const tables = call(g, { kind: 'table' });
  assert.equal(rowOf(tables, 'table', 'p').screens, 1);
  assert.equal(rowOf(tables, 'table', 'q').screens, 0, 'nothing the screen reaches touches q');

  const cols = call(g, { kind: 'column' });
  // `selectByPrimaryKey` reads id, name and price, and the screen reaches it.
  assert.equal(rowOf(cols, 'column', 'p.name').screens, 1);
  assert.equal(rowOf(cols, 'column', 'q.p_id').screens, 0);

  // The same number the screen list itself carries: one screen, reaching one
  // route and one table.
  const screens = call(g, { kind: 'screen' });
  assert.deepEqual(screens.answer.items.map((x) => [x.screen, x.endpoints, x.tables]), [['/products', 1, 1]]);

  // …and the sentence that says how that number was arrived at travels with it.
  assert.ok(tables.limits.some((l) => l.scope === 'screen' && /a screen reaches a route because a walk/.test(l.reason)));
  assert.ok(cols.limits.some((l) => l.scope === 'screen'));
});

test('browse: on a pack with NO frontend the field is ABSENT, never 0', () => {
  // `screens: 0` on a backend-only pack would read as "no screen touches this
  // table", when the truth is that no frontend was ever analyzed.
  const r = call(fixture(), { kind: 'table' });
  for (const row of r.answer.items) assert.equal(Object.hasOwn(row, 'screens'), false);
  const cols = call(fixture(), { kind: 'column' });
  for (const row of cols.answer.items) assert.equal(Object.hasOwn(row, 'screens'), false);
  assert.equal(r.limits.some((l) => l.scope === 'screen'), false, 'and nothing is claimed about a walk that never ran');
});
