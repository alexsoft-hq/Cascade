// name_resolve.test.mjs — a tool argument names the same thing the SQL does.
//
// RM12 made the PACK hold one node per table under the dialect's declared
// identity rule, and left the QUERY layer comparing arguments byte for byte:
// `table_usage ORDERS` was an `unknown-table` error for a table the pack holds,
// while `table_usage orders` answered. This file pins the fix — the resolver
// itself, and the four behaviours the tools owe a caller:
//
//   1. a folded hit ANSWERS, and says in `limits` what was typed and what it
//      resolved to (a match the user did not literally ask for is never silent)
//   2. a genuinely unknown name still fails, with "did you mean …"
//   3. an `exact`-rule pack folds NOTHING (a dialect whose rule we cannot cite)
//   4. a pack that declares no rule at all — one an older engine built —
//      behaves exactly as it did before: exact match, no fold
//
// The fixture graph mirrors test/tools.test.mjs (pms_product / id, name, price).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { resolveSchemaName, suggest, editDistance, MAX_SUGGESTIONS } from '../src/core/name_resolve.mjs';
import { column_impact, table_usage, erd, flow, neighborhood, ToolError } from '../src/mcp/tools.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { mallGraph, mallPack, skipUnlessMall } from './helpers/mall_fixture.mjs';

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'pms_product', comment: 'product catalog table' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'INT', comment: 'primary key' },
    { kind: 'column', schema: null, table: 'pms_product', column: 'name', type: 'VARCHAR(100)', comment: null },
    { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10,2)', comment: 'unit price' },
  ];
}
function lineageRecords() {
  return [{
    kind: 'lineage', namespace: 'PmsProductMapper', id: 'updateByPrimaryKey', type: 'update',
    tables: [{ table: 'pms_product', access: 'write' }],
    columns: [{ table: 'pms_product', column: 'price', access: 'write' }],
    file: 'PmsProductMapper.xml', line: 10,
  }];
}
const fixture = () => buildGraphFromSql(catalogRecords(), lineageRecords());

/** A ctx whose pack declares `rule` (pass null for a pack that declares none). */
function ctx(graph, rule) {
  return {
    graph,
    basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [],
    pack: { project: 't', digest: 'd', ...(rule ? { identifierCase: rule } : {}) },
  };
}
const foldLine = (resp) => resp.limits.find((l) => l.scope === 'identifier-case') ?? null;

/** The error a call threw (assert.throws does not hand it back). */
function caught(fn) {
  try { fn(); } catch (e) { return e; }
  throw new Error('expected a throw, got none');
}

// ---------------------------------------------------------------------------
// the resolver
// ---------------------------------------------------------------------------

test('resolveSchemaName: an exact spelling is an exact hit, and nothing is disclosed', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'table', 'pms_product', 'fold-lower');
  assert.equal(r.how, 'exact');
  assert.equal(r.id, nodeId('table', 'pms_product'));
  assert.equal(r.key, 'pms_product');
});

test('resolveSchemaName: fold-lower resolves the SQL spelling onto the catalog spelling', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'table', 'PMS_PRODUCT', 'fold-lower');
  assert.equal(r.how, 'folded');
  assert.equal(r.key, 'pms_product');
  assert.equal(r.typed, 'PMS_PRODUCT');
  assert.equal(r.identifierCase, 'fold-lower');
});

test('resolveSchemaName: a column key folds as a whole — table AND column part', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'column', 'PMS_Product.PRICE', 'fold-lower');
  assert.equal(r.how, 'folded');
  assert.equal(r.key, 'pms_product.price');
});

test('resolveSchemaName: fold-upper resolves the other way', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('table', 'ORDERS') });
  const r = resolveSchemaName(g, 'table', 'orders', 'fold-upper');
  assert.equal(r.how, 'folded');
  assert.equal(r.key, 'ORDERS');
});

test('resolveSchemaName: `exact` folds nothing — the rule we cannot cite never merges two names', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'table', 'PMS_PRODUCT', 'exact');
  assert.equal(r.how, 'none');
  assert.deepEqual(r.suggestions, ['pms_product']); // told it exists, never handed it
});

test('resolveSchemaName: a pack that declares NO rule behaves exactly as before (no fold)', () => {
  const g = fixture();
  for (const declared of [null, undefined]) {
    const r = resolveSchemaName(g, 'table', 'PMS_PRODUCT', declared);
    assert.equal(r.how, 'none', `declared=${String(declared)}`);
    assert.equal(r.identifierCase, null);
  }
});

test('resolveSchemaName: two pack names that fold together leave the argument AMBIGUOUS', () => {
  // The collision the lineage summary counts as `identifierCollisions`: the
  // bridge keeps both tables, so no fold can pick one of them for the caller.
  const g = new Graph();
  g.addNode({ id: nodeId('table', 'Orders') });
  g.addNode({ id: nodeId('table', 'ORDERS') });
  const r = resolveSchemaName(g, 'table', 'orders', 'fold-lower');
  assert.equal(r.how, 'ambiguous');
  assert.deepEqual(r.candidates, ['ORDERS', 'Orders']);
  assert.equal(r.id, null);
});

test('resolveSchemaName: an unknown name suggests the nearest by edit distance', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'column', 'pms_product.pricee', 'fold-lower');
  assert.equal(r.how, 'none');
  assert.deepEqual(r.suggestions, ['pms_product.price']);
});

test('resolveSchemaName: a name nothing is near suggests nothing at all', () => {
  const g = fixture();
  const r = resolveSchemaName(g, 'table', 'wholly_unrelated_thing', 'fold-lower');
  assert.equal(r.how, 'none');
  assert.deepEqual(r.suggestions, []);
});

test('suggest: case-insensitive equality comes first, then distance, and at most three', () => {
  const keys = ['ORDERS', 'orders_item', 'ordersx', 'order', 'orderss'];
  const out = suggest('Orders', keys);
  assert.equal(out[0], 'ORDERS');
  assert.ok(out.length <= MAX_SUGGESTIONS, out.join(','));
});

test('editDistance: abandons a comparison that is already too far, rather than measuring it', () => {
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.equal(editDistance('abc', 'abd'), 1);
  assert.equal(editDistance('price', 'pricee'), 1);
  assert.equal(editDistance('abc', 'abcdefghijk'), null);
  assert.equal(editDistance('kitten', 'sitting', 3), 3);
  assert.equal(editDistance('kitten', 'sitting', 2), null);
});

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

test('table_usage: an upper-case argument ANSWERS on a fold-lower pack, and discloses the fold', () => {
  const g = fixture();
  const resp = table_usage(g, { table: 'PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.statements.map((s) => s.id), ['PmsProductMapper.updateByPrimaryKey']);
  const line = foldLine(resp);
  assert.ok(line, JSON.stringify(resp.limits));
  assert.match(line.reason, /"PMS_PRODUCT"/);
  assert.match(line.reason, /"pms_product"/);
  assert.match(line.reason, /fold-lower/);
});

test('table_usage: the columns lane is the RESOLVED table\'s, not the typed spelling\'s', () => {
  const g = fixture();
  const resp = table_usage(g, { table: 'PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.deepEqual(resp.answer.columns.map((c) => c.column), ['pms_product.price']);
});

test('table_usage: an exact hit discloses NOTHING (the disclosure is only for a fold)', () => {
  const g = fixture();
  const resp = table_usage(g, { table: 'pms_product' }, ctx(g, 'fold-lower'));
  assert.equal(foldLine(resp), null);
});

test('column_impact: a folded column answers about the pack\'s spelling and says so', () => {
  const g = fixture();
  const resp = column_impact(g, { column: 'PMS_PRODUCT.PRICE' }, ctx(g, 'fold-lower'));
  assert.equal(resp.answer.column, 'pms_product.price');
  assert.equal(resp.answer.comment, 'unit price');
  assert.deepEqual(resp.answer.statements.map((s) => s.access), ['write']);
  assert.ok(foldLine(resp));
});

test('erd, flow(up) and neighborhood take the same folded name', () => {
  const g = fixture();
  const e = erd(g, { table: 'PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.equal(e.answer.focus, 'pms_product');
  assert.ok(foldLine(e));

  const f = flow(g, { direction: 'up', table: 'PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.equal(f.answer.entry.id, 'pms_product');
  assert.ok(foldLine(f));

  const n = neighborhood(g, { table: 'PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.equal(n.answer.focus, nodeId('table', 'pms_product'));
  assert.ok(foldLine(n));

  // …including the `node="<kind>:<key>"` spelling of the same focus.
  const n2 = neighborhood(g, { node: 'table:PMS_PRODUCT' }, ctx(g, 'fold-lower'));
  assert.equal(n2.answer.focus, nodeId('table', 'pms_product'));
  assert.ok(foldLine(n2));
});

test('the node="<kind>:<key>" form keeps its OWN error code, and only gains the suggestion', () => {
  const g = fixture();
  const e = caught(() => neighborhood(g, { node: 'table:pms_produkt' }, ctx(g, 'fold-lower')));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-node', 'a client pinned to unknown-node must still get it');
  assert.match(e.message, /node not in pack: table:pms_produkt\. Did you mean table:pms_product\?/);
  // A malformed or non-schema node id is unchanged in every respect.
  assert.equal(caught(() => neighborhood(g, { node: 'table:' }, ctx(g, 'fold-lower'))).code, 'unknown-node');
  assert.equal(caught(() => neighborhood(g, { node: 'nonsense' }, ctx(g, 'fold-lower'))).code, 'unknown-node');
  assert.equal(caught(() => neighborhood(g, { node: 'symbol:com.x.Y#z' }, ctx(g, 'fold-lower'))).code, 'unknown-node');
});

test('an unknown table keeps its code and gains a "did you mean"', () => {
  const g = fixture();
  const e = caught(() => table_usage(g, { table: 'pms_produkt' }, ctx(g, 'fold-lower')));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-table');
  assert.match(e.message, /table not found in pack: pms_produkt/);
  assert.match(e.message, /Did you mean pms_product\?/);
});

test('an `exact`-rule pack does not fold — the case-differing name is an error that names the other one', () => {
  const g = fixture();
  const e = caught(() => table_usage(g, { table: 'PMS_PRODUCT' }, ctx(g, 'exact')));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-table');
  assert.match(e.message, /Did you mean pms_product\?/);
});

test('a pack with no identifierCase in its meta answers exactly as it did before the fix', () => {
  const g = fixture();
  const e = caught(() => table_usage(g, { table: 'PMS_PRODUCT' }, ctx(g, null)));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-table');
  assert.doesNotThrow(() => assertContract(table_usage(g, { table: 'pms_product' }, ctx(g, null))));
});

test('an ambiguous argument stays unresolved and names both tables', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('table', 'Orders') });
  g.addNode({ id: nodeId('table', 'ORDERS') });
  const e = caught(() => table_usage(g, { table: 'orders' }, ctx(g, 'fold-lower')));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-table');
  assert.match(e.message, /ORDERS, Orders all fold onto it/);
});

// ---------------------------------------------------------------------------
// the same thing on a real pack (macrozheng/mall — fold-lower, 76 tables)
// ---------------------------------------------------------------------------

test('mall: table_usage PMS_PRODUCT answers the same as pms_product, and discloses the fold',
  { skip: skipUnlessMall() }, () => {
    const g = mallGraph();
    const pack = mallPack();
    // The rule is the PACK's, read back out of its own meta — not a constant
    // this test chose. (A pack built before RM13 carries none; regenerate it.)
    assert.equal(pack.meta.identifierCase, 'fold-lower', 'the mall pack must record the rule it was built under');
    const c = ctx(g, pack.meta.identifierCase);

    const folded = table_usage(g, { table: 'PMS_PRODUCT', limit: 100 }, c);
    const plain = table_usage(g, { table: 'pms_product', limit: 100 }, c);
    assert.ok(plain.answer.statements.length > 0);
    assert.deepEqual(folded.answer.statements, plain.answer.statements);
    assert.deepEqual(folded.answer.columns, plain.answer.columns);
    assert.ok(foldLine(folded), JSON.stringify(folded.limits));
    assert.equal(foldLine(plain), null);

    const ci = column_impact(g, { column: 'PMS_PRODUCT.Price', limit: 100 }, c);
    assert.equal(ci.answer.column, 'pms_product.price');
    assert.deepEqual(
      ci.answer.statements,
      column_impact(g, { column: 'pms_product.price', limit: 100 }, c).answer.statements,
    );
  });

test('mall: a misspelt table names the real one', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const e = caught(() => table_usage(g, { table: 'pms_produkt' }, ctx(g, 'fold-lower')));
  assert.ok(e instanceof ToolError);
  assert.equal(e.code, 'unknown-table');
  assert.match(e.message, /Did you mean pms_product\?/);
});
