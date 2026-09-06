import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import {
  walkEndpoints, groupOfEndpoint, groupOfPath, ROOT_GROUP, UNKNOWN_PACKAGE_GROUP, WalkError,
} from '../src/core/walks.mjs';
import { buildCoupling } from '../src/core/coupling.mjs';
import { buildMap } from '../src/core/map.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { normalizeProfile } from '../src/core/profile.mjs';

// moduleAttribution.packageDepth (SPEC §6.2): a project can DECLARE that its
// modules are packages, not URL prefixes. Two endpoints under the same package
// then belong together even when their paths do not — which is exactly the case
// the path rule gets wrong, and the reason the key exists.
//
// Fixture: two handlers in com.example.shop.product, one in com.example.shop.order.
//   GET  /product/list   → ProductController#list    → M.selP  (reads p.name)
//   POST /admin/product  → ProductAdminController#add → M.insP (writes p.name)
//   GET  /order/list     → OrderController#list      → M.selO  (reads o.id)
// Path rule → three groups (product, admin, order).
// Package rule at depth 4 → two (com.example.shop.product, com.example.shop.order).

function catalog() {
  return [
    { kind: 'table', schema: null, table: 'p', comment: null },
    { kind: 'column', schema: null, table: 'p', column: 'name', type: 'VARCHAR', comment: null },
    { kind: 'table', schema: null, table: 'o', comment: null },
    { kind: 'column', schema: null, table: 'o', column: 'id', type: 'INT', comment: null },
  ];
}
function lineage() {
  const st = (id, type, table, column, access) => ({
    kind: 'lineage', namespace: 'com.example.shop.mapper.M', id, type,
    tables: [{ table, access: access === 'write' ? 'write' : 'read' }],
    columns: [{ table, column, access }], file: 'M.xml', line: 1,
  });
  return [st('selP', 'select', 'p', 'name', 'read'), st('insP', 'insert', 'p', 'name', 'write'), st('selO', 'select', 'o', 'id', 'read')];
}
function javaFacts() {
  const type = (fqn, pkg) => ({ kind: 'type', fqn, typeKind: 'class', package: pkg, file: `src/${fqn}.java`, implements: [], annotations: [] });
  const method = (fqn, line) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.lastIndexOf('#')), name: fqn.slice(fqn.lastIndexOf('#') + 1), paramCount: 0, line });
  const ep = (httpMethod, p, handler) => ({ kind: 'endpoint', httpMethod, path: p, handler, line: 3 });
  const call = (from, toTypeSimple, m) => ({ kind: 'call', from, receiver: 'm', method: m, toTypeSimple });
  return [
    type('com.example.shop.product.ProductController', 'com.example.shop.product'),
    type('com.example.shop.product.ProductAdminController', 'com.example.shop.product'),
    type('com.example.shop.order.OrderController', 'com.example.shop.order'),
    { kind: 'type', fqn: 'com.example.shop.mapper.M', typeKind: 'interface', package: 'com.example.shop.mapper', implements: [], annotations: ['Mapper'], file: 'src/M.java' },
    { kind: 'import', owner: 'com.example.shop.product.ProductController', simple: 'M', fqn: 'com.example.shop.mapper.M' },
    { kind: 'import', owner: 'com.example.shop.product.ProductAdminController', simple: 'M', fqn: 'com.example.shop.mapper.M' },
    { kind: 'import', owner: 'com.example.shop.order.OrderController', simple: 'M', fqn: 'com.example.shop.mapper.M' },
    method('com.example.shop.product.ProductController#list', 10),
    method('com.example.shop.product.ProductAdminController#add', 11),
    method('com.example.shop.order.OrderController#list', 12),
    method('com.example.shop.mapper.M#selP', 5), method('com.example.shop.mapper.M#insP', 6), method('com.example.shop.mapper.M#selO', 7),
    ep('GET', '/product/list', 'com.example.shop.product.ProductController#list'),
    ep('POST', '/admin/product', 'com.example.shop.product.ProductAdminController#add'),
    ep('GET', '/order/list', 'com.example.shop.order.OrderController#list'),
    call('com.example.shop.product.ProductController#list', 'M', 'selP'),
    call('com.example.shop.product.ProductAdminController#add', 'M', 'insP'),
    call('com.example.shop.order.OrderController#list', 'M', 'selO'),
  ];
}
function graph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts(), { packagePrefixes: ['com.example'] });
  return g;
}

const ctx = (profile) => ({
  graph: graph(),
  basis: { project: 'p', buildDigest: 'd', freshness: { verdict: 'unknown' } },
  trust: { trustLevel: 'UNCERTIFIED' },
  limits: [],
  profile,
});

// --------------------------------------------------------------------------
// The rule itself
// --------------------------------------------------------------------------

test('groupOfEndpoint: packageDepth null keeps the path rule', () => {
  const n = { path: '/admin/product', handler: 'com.example.shop.product.ProductAdminController#add' };
  assert.equal(groupOfEndpoint(n), 'admin');
  assert.equal(groupOfEndpoint(n, { packageDepth: null }), 'admin');
  assert.equal(groupOfPath('/admin/product'), 'admin');
  assert.equal(groupOfEndpoint({ path: '/' }), ROOT_GROUP);
});

test('groupOfEndpoint: packageDepth truncates the HANDLER package, not the path', () => {
  const n = { path: '/admin/product', handler: 'com.example.shop.product.ProductAdminController#add' };
  assert.equal(groupOfEndpoint(n, { packageDepth: 4 }), 'com.example.shop.product');
  assert.equal(groupOfEndpoint(n, { packageDepth: 2 }), 'com.example');
  // A package shorter than the depth is kept whole, not padded.
  assert.equal(groupOfEndpoint({ path: '/x', handler: 'com.App#run' }, { packageDepth: 4 }), 'com');
});

test('groupOfEndpoint: an endpoint with no handler is (unknown package), never the path', () => {
  // Mixing the two rules in one matrix would make incomparable groups look like peers.
  assert.equal(groupOfEndpoint({ path: '/product/list' }, { packageDepth: 4 }), UNKNOWN_PACKAGE_GROUP);
  assert.equal(groupOfEndpoint({ path: '/x', handler: 'App#run' }, { packageDepth: 4 }), UNKNOWN_PACKAGE_GROUP);
});

test('groupOfEndpoint: a nonsense depth is an error, not a silent fallback', () => {
  assert.throws(() => groupOfEndpoint({ handler: 'a.B#c' }, { packageDepth: 0 }), WalkError);
  assert.throws(() => groupOfEndpoint({ handler: 'a.B#c' }, { packageDepth: 1.5 }), WalkError);
});

// --------------------------------------------------------------------------
// Both rules, end to end, through the views that share walks.mjs
// --------------------------------------------------------------------------

test('walkEndpoints: the two rules group the same three endpoints differently', () => {
  const g = graph();
  const byPath = walkEndpoints(g).endpoints.map((e) => e.group).sort();
  assert.deepEqual(byPath, ['admin', 'order', 'product']);
  const byPkg = walkEndpoints(g, { packageDepth: 4 }).endpoints.map((e) => e.group).sort();
  assert.deepEqual(byPkg, ['com.example.shop.order', 'com.example.shop.product', 'com.example.shop.product']);
  // The rule changes the GROUPING only — never what an endpoint reaches.
  const stmts = (r) => r.endpoints.map((e) => e.statements.map((s) => s.id).join('+')).sort();
  assert.deepEqual(stmts(walkEndpoints(g)), stmts(walkEndpoints(g, { packageDepth: 4 })));
});

test('coupling: under the package rule the two product endpoints stop coupling to each other', () => {
  const g = graph();
  // Path rule: `admin` writes p.name and `product` reads it — a cross-group coupling.
  const byPath = buildCoupling(g, {});
  assert.deepEqual(byPath.pairs.map((p) => `${p.writer}->${p.reader}`), ['admin->product']);
  // Package rule: both handlers are the same module, so that coupling is internal.
  const byPkg = buildCoupling(g, { packageDepth: 4 });
  assert.deepEqual(byPkg.pairs.map((p) => `${p.writer}->${p.reader}`), []);
  assert.deepEqual(byPkg.groups.map((x) => x.group).sort(), ['com.example.shop.order', 'com.example.shop.product']);
});

test('map: the group nodes follow the same declared rule', () => {
  const g = graph();
  const groups = (m) => m.nodes.filter((n) => n.kind === 'group').map((n) => n.id).sort();
  assert.deepEqual(groups(buildMap(g, {})), ['group:admin', 'group:order', 'group:product']);
  assert.deepEqual(groups(buildMap(g, { packageDepth: 4 })),
    ['group:com.example.shop.order', 'group:com.example.shop.product']);
});

test('the profile carries the rule into the tools, and the limits say WHICH rule was used', () => {
  const pathCtx = ctx(normalizeProfile({}));
  const pkgCtx = ctx(normalizeProfile({ moduleAttribution: { packageDepth: 4 } }));

  const a = callTool('coupling', {}, pathCtx);
  assert.deepEqual(a.answer.groups.map((g) => g.group).sort(), ['admin', 'order', 'product']);
  assert.ok(a.limits.some((l) => /a group is the first segment of an API path/.test(l.reason)));

  const b = callTool('coupling', {}, pkgCtx);
  assert.deepEqual(b.answer.groups.map((g) => g.group).sort(), ['com.example.shop.order', 'com.example.shop.product']);
  assert.ok(b.limits.some((l) => /the handler's package, cut to 4 segment\(s\)/.test(l.reason)));
  assert.equal(b.limits.some((l) => /a group is the first segment of an API path/.test(l.reason)), false);

  const m = callTool('map', {}, pkgCtx);
  assert.deepEqual(m.answer.nodes.filter((n) => n.kind === 'group').map((n) => n.id).sort(),
    ['group:com.example.shop.order', 'group:com.example.shop.product']);
  assert.ok(m.limits.some((l) => /the handler's package, cut to 4 segment\(s\)/.test(l.reason)));
});

test('a profile with no moduleAttribution behaves exactly as before it existed', () => {
  const withNone = callTool('coupling', {}, ctx(normalizeProfile({})));
  const withNoProfile = callTool('coupling', {}, { ...ctx(undefined) });
  assert.deepEqual(withNone.answer.cells, withNoProfile.answer.cells);
  assert.deepEqual(withNone.answer.groups, withNoProfile.answer.groups);
});
