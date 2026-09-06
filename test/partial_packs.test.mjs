import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { projectPack, loadPack } from '../src/core/pack.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// SPEC §10.4 MUST: the pack builder does not die() for a missing axis — it
// ships a PARTIAL pack that DECLARES the axis it could not fill. This file is
// the contract for that: for each lane combination, build the pack the way
// `cascade analyze` does, then ask through the real dispatcher and check that
//   - an axis tool answers `not-shipped` / `degraded` rather than a bare empty list,
//   - `trust.knownGaps` NAMES the axis, and
//   - the response still satisfies the honesty contract.

// --------------------------------------------------------------------------
// Lane outputs
// --------------------------------------------------------------------------

const catalog = () => [
  { kind: 'table', schema: null, table: 'shop_item', comment: 'items' },
  { kind: 'column', schema: null, table: 'shop_item', column: 'id', type: 'INT', comment: null, pk: true },
  { kind: 'column', schema: null, table: 'shop_item', column: 'price', type: 'INT', comment: 'price' },
];
const lineage = () => [{
  kind: 'lineage', namespace: 'com.example.shop.mapper.ItemMapper', id: 'updatePrice', type: 'update',
  tables: [{ table: 'shop_item', access: 'write' }],
  columns: [{ table: 'shop_item', column: 'price', access: 'write' }],
  joins: [], unresolved: [], hasStringSubst: false, schemaUnknown: false,
  file: 'ItemMapper.xml', line: 12,
}];
const javaFacts = () => {
  const M = 'com.example.shop.mapper.ItemMapper';
  const C = 'com.example.shop.web.ItemController';
  return [
    { kind: 'type', fqn: C, typeKind: 'class', package: 'com.example.shop.web', file: 'ItemController.java', implements: [], annotations: ['RestController'] },
    { kind: 'type', fqn: M, typeKind: 'interface', package: 'com.example.shop.mapper', file: 'ItemMapper.java', implements: [], annotations: ['Mapper'] },
    { kind: 'import', owner: C, simple: 'ItemMapper', fqn: M },
    { kind: 'method', fqn: `${C}#update`, owner: C, name: 'update', paramCount: 1, line: 20 },
    { kind: 'method', fqn: `${M}#updatePrice`, owner: M, name: 'updatePrice', paramCount: 1, line: 5 },
    { kind: 'endpoint', httpMethod: 'POST', path: '/item/price', handler: `${C}#update`, line: 20 },
    { kind: 'call', from: `${C}#update`, receiver: 'm', method: 'updatePrice', toTypeSimple: 'ItemMapper' },
  ];
};

/** A pack built exactly the way `cascade analyze` builds one, for a lane subset. */
function packFor({ ddl, statements, code }) {
  const g = buildGraphFromSql(ddl ? catalog() : [], statements ? lineage() : []);
  const laneStats = code ? addJavaFacts(g, javaFacts(), { packagePrefixes: ['com.example'] }) : null;
  const axes = declareAxes({ ddl, statements, code });
  return projectPack(g, { project: 'shop', builtAt: '2020-01-01T00:00:00Z', lanes: ['sql'], axes, laneStats });
}

function ctxFor(pack) {
  return {
    graph: loadPack(pack, { verifyDigest: true }),
    basis: { project: 'shop', buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [],
    pack: { project: 'shop', digest: pack.digest, builtAt: pack.meta.builtAt, lanes: pack.meta.lanes, axes: pack.meta.axes, laneStats: pack.meta.laneStats },
  };
}

const gapsOf = (resp) => resp.trust.knownGaps;
const reasons = (resp) => resp.limits.map((l) => l.reason).join(' | ');

// --------------------------------------------------------------------------
// DDL + mappers + java: the complete case, for contrast
// --------------------------------------------------------------------------

test('all three lanes: nothing is declared missing except the two axes this engine never ships', () => {
  const ctx = ctxFor(packFor({ ddl: true, statements: true, code: true }));
  assert.deepEqual(ctx.pack.axes.column, { status: 'shipped', reason: null });
  const r = callTool('column_impact', { column: 'shop_item.price' }, ctx);
  assertContract(r);
  assert.equal(r.answer.statements.length, 1);
  assert.deepEqual(gapsOf(r), ['jpa-axis-not-shipped', 'mybatisPlus-axis-not-shipped', 'web-axis-not-shipped', 'screen-axis-not-shipped']);
  const e = callTool('endpoint_impact', { column: 'shop_item.price' }, ctx);
  assert.deepEqual(e.answer.endpoints.map((x) => x.id), ['POST /item/price']);
});

// --------------------------------------------------------------------------
// mappers WITHOUT a DDL — the degraded column axis
// --------------------------------------------------------------------------

test('mappers without DDL: the column axis is DEGRADED, and the answer says so in limits', () => {
  const pack = packFor({ ddl: false, statements: true, code: false });
  assert.equal(pack.meta.axes.column.status, 'degraded');
  assert.equal(pack.meta.axes.catalog.status, 'not-shipped');
  const ctx = ctxFor(pack);

  const r = callTool('column_impact', { column: 'shop_item.price' }, ctx);
  assertContract(r);
  // The column still exists — a statement named it — but the answer carries the
  // degradation, so "1 statement" is not read as "the whole truth".
  assert.equal(r.answer.statements.length, 1);
  assert.match(reasons(r), /the column axis of this pack is degraded/);
  assert.ok(gapsOf(r).includes('column-axis-degraded'));
  assert.ok(gapsOf(r).includes('catalog-axis-not-shipped'));
});

test('mappers without DDL: the code axis is still named absent, not answered as empty', () => {
  const ctx = ctxFor(packFor({ ddl: false, statements: true, code: false }));
  const r = callTool('endpoint_impact', { column: 'shop_item.price' }, ctx);
  assertContract(r);
  assert.equal(r.answer.empty.endpoints, 'not-shipped');
  assert.ok(gapsOf(r).includes('code-axis-not-shipped'));
  assert.match(reasons(r), /the code axis of this pack is not-shipped: the Java lane did not run/);
});

// --------------------------------------------------------------------------
// DDL only — a catalog with nothing running against it
// --------------------------------------------------------------------------

test('DDL only: column_impact answers not-shipped (no statement axis), never a bare "none"', () => {
  const pack = packFor({ ddl: true, statements: false, code: false });
  assert.equal(pack.meta.axes.catalog.status, 'shipped');
  assert.equal(pack.meta.axes.statements.status, 'not-shipped');
  const ctx = ctxFor(pack);

  const r = callTool('column_impact', { column: 'shop_item.price' }, ctx);
  assertContract(r);
  assert.deepEqual(r.answer.statements, []);
  assert.equal(r.answer.empty.statements, 'not-shipped');
  assert.ok(gapsOf(r).includes('statements-axis-not-shipped'));
});

test('DDL only: the ERD and the map are empty WITH a reason, and the contract still holds', () => {
  const ctx = ctxFor(packFor({ ddl: true, statements: false, code: false }));
  const erd = callTool('erd', {}, ctx);
  assertContract(erd);
  assert.match(reasons(erd), /the statements axis of this pack is not-shipped/);
  const map = callTool('map', {}, ctx);
  assertContract(map);
  assert.equal(map.answer.empty.nodes, 'not-shipped');
  const ov = callTool('overview', {}, ctx);
  assertContract(ov);
  // `overview` lists the pack's declaration verbatim.
  assert.deepEqual(ov.answer.axes, ctx.pack.axes);
});

// --------------------------------------------------------------------------
// java only — no SQL at all under the code
// --------------------------------------------------------------------------

test('java only: a mapper method whose statement is absent gets NO stub node, and is counted', () => {
  const pack = packFor({ ddl: false, statements: false, code: true });
  assert.equal(pack.meta.axes.code.status, 'shipped');
  assert.equal(pack.meta.axes.statements.status, 'not-shipped');
  // The choice this engine made (documented in java_bridge.mjs): skip the edge,
  // count the method. A stub statement node would be a fact nobody observed.
  assert.equal(pack.nodes.some((n) => n.kind === 'statement'), false);
  assert.equal(pack.meta.laneStats.unboundMapperMethods, 1);
  assert.equal(pack.meta.laneStats.mapperMethodsBound, 0);
  assert.equal(pack.edges.some((e) => e.type === 'IMPLEMENTS_STMT'), false);
});

test('java only: the endpoint exists, and the column axis is declared absent', () => {
  const ctx = ctxFor(packFor({ ddl: false, statements: false, code: true }));
  const flow = callTool('flow', { endpoint: 'POST /item/price' }, ctx);
  assertContract(flow);
  assert.equal(flow.answer.empty.statements, 'none');
  assert.ok(gapsOf(flow).includes('column-axis-not-shipped'));
  assert.ok(gapsOf(flow).includes('statements-axis-not-shipped'));
  // A column nobody declared is still an honest "unknown-column" error, not an
  // empty answer that reads as "no impact".
  assert.throws(
    () => callTool('column_impact', { column: 'shop_item.price' }, ctx),
    (e) => e.code === 'unknown-column',
  );
});

// --------------------------------------------------------------------------
// The whole matrix
// --------------------------------------------------------------------------

test('every lane combination produces a contract-valid answer from every axis tool', () => {
  const combos = [
    { ddl: true, statements: true, code: true },
    { ddl: true, statements: true, code: false },
    { ddl: false, statements: true, code: true },
    { ddl: false, statements: true, code: false },
    { ddl: true, statements: false, code: false },
    { ddl: false, statements: false, code: true },
  ];
  for (const combo of combos) {
    const pack = packFor(combo);
    const ctx = ctxFor(pack);
    const label = JSON.stringify(combo);
    for (const [tool, args] of [
      ['overview', {}], ['erd', {}], ['map', {}], ['coupling', {}],
      ['transactions', {}], ['search', { query: 'item' }],
    ]) {
      const r = callTool(tool, args, ctx);
      assertContract(r);
      // Every axis the pack could not ship is NAMED, in every answer.
      for (const [axis, a] of Object.entries(pack.meta.axes)) {
        if (a.status === 'shipped') continue;
        assert.ok(r.trust.knownGaps.includes(`${axis}-axis-${a.status}`),
          `${tool} on ${label}: trust.knownGaps does not name ${axis} (${a.status})`);
      }
    }
  }
});

test('an older pack that declares NO axes still answers exactly as it used to', () => {
  const g = buildGraphFromSql(catalog(), lineage());
  const pack = projectPack(g, { project: 'shop', builtAt: '2020-01-01T00:00:00Z', lanes: ['sql'] });
  const ctx = {
    graph: loadPack(pack), basis: { project: 'shop', buildDigest: pack.digest, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' }, limits: [],
    pack: { project: 'shop', digest: pack.digest, lanes: ['sql'] },
  };
  const r = callTool('endpoint_impact', { column: 'shop_item.price' }, ctx);
  assertContract(r);
  // Inferred from the graph shape, as before axes existed: no endpoint node.
  assert.equal(r.answer.empty.endpoints, 'not-shipped');
  assert.deepEqual(r.trust.knownGaps, []);
  assert.deepEqual(r.limits, []);
});
