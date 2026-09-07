import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { buildOverview, OverviewError } from '../src/core/overview.mjs';
import { overview, ToolError } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';

// ---------------------------------------------------------------------------
// Fixture — one small pack with ONE of everything the census counts, so each
// number below can be read straight off this picture:
//
//   GET /a/one  → AController#one → AService#run  → M.writeX  (writes t.x)
//                                  [@Transactional] → M.readX (reads  t.x)
//                                                  → Helper#help  (external:
//                                                    org.ext.Helper has no file)
//   GET /b/ping → BController#ping — calls nothing → reaches NO statement
//   M.orphan (reads u.k) has a mapper method but no endpoint calls it → the
//   statement, and table u with it, is not reached from the analysed endpoints.
//
// So: 2 endpoints (1 without a statement), 3 statements (2 reached), 2 tables
// (1 reached), 3 columns (1 reached), 7 symbols (1 external, 1 @Transactional,
// 3 mapper methods, 0 statements missing one).
// ---------------------------------------------------------------------------

function catalog() {
  return [
    { kind: 'table', schema: null, table: 't', comment: 'the reached table' },
    { kind: 'column', schema: null, table: 't', column: 'x', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'y', type: 'INT', comment: null },
    { kind: 'table', schema: null, table: 'u', comment: null },
    { kind: 'column', schema: null, table: 'u', column: 'k', type: 'INT', comment: null },
  ];
}
function lineage() {
  const st = (id, type, tables, columns) => ({ kind: 'lineage', namespace: 'com.demo.M', id, type, tables, columns, file: 'M.xml', line: 1 });
  return [
    st('writeX', 'update', [{ table: 't', access: 'write' }], [{ table: 't', column: 'x', access: 'write' }]),
    st('readX', 'select', [{ table: 't', access: 'read' }], [{ table: 't', column: 'x', access: 'read' }]),
    st('orphan', 'select', [{ table: 'u', access: 'read' }], [{ table: 'u', column: 'k', access: 'read' }]),
  ];
}
function javaFacts() {
  const type = (fqn, file) => ({ kind: 'type', fqn, typeKind: 'class', package: fqn.slice(0, fqn.lastIndexOf('.')), file, implements: [] });
  const method = (fqn, line) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.lastIndexOf('#')), name: fqn.slice(fqn.lastIndexOf('#') + 1), paramCount: 1, line });
  const call = (from, toTypeSimple, m) => ({ kind: 'call', from, receiver: 'r', method: m, toTypeSimple });
  return [
    type('com.demo.AController', 'src/AController.java'),
    type('com.demo.AService', 'src/AService.java'),
    type('com.demo.BController', 'src/BController.java'),
    { kind: 'type', fqn: 'com.demo.M', typeKind: 'interface', package: 'com.demo', file: 'src/M.java', implements: [] },
    // A type the lane only ever saw REFERENCED: no file → its method is external.
    { kind: 'type', fqn: 'org.ext.Helper', typeKind: 'class', package: 'org.ext', implements: [] },
    method('com.demo.AController#one', 10), method('com.demo.AService#run', 20), method('com.demo.BController#ping', 30),
    method('com.demo.M#writeX', 5), method('com.demo.M#readX', 6), method('com.demo.M#orphan', 7),
    method('org.ext.Helper#help', 1),
    call('com.demo.AController#one', 'AService', 'run'),
    call('com.demo.AService#run', 'M', 'writeX'),
    call('com.demo.AService#run', 'M', 'readX'),
    call('com.demo.AService#run', 'Helper', 'help'),
    { kind: 'endpoint', httpMethod: 'GET', path: '/a/one', handler: 'com.demo.AController#one', line: 10 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/b/ping', handler: 'com.demo.BController#ping', line: 30 },
    { kind: 'transactional', method: 'com.demo.AService#run', scope: 'REQUIRED', line: 20 },
  ];
}
function fixtureGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, javaFacts());
  return g;
}
const sqlOnly = () => buildGraphFromSql(catalog(), lineage());
const gapKinds = (o) => o.gaps.map((g) => g.kind);
const gapOf = (o, kind) => o.gaps.find((g) => g.kind === kind);

// ---------------------------------------------------------------------------
// the census — what is in this pack
// ---------------------------------------------------------------------------

test('buildOverview: nodes are counted per kind, biggest first', () => {
  const o = buildOverview(fixtureGraph());
  assert.deepEqual(o.nodes, [
    { kind: 'symbol', count: 7 },
    { kind: 'column', count: 3 },
    { kind: 'statement', count: 3 },
    { kind: 'endpoint', count: 2 },
    { kind: 'table', count: 2 },
  ]);
});

test('buildOverview: edges are counted per type AND grade — "4 calls" is not a fact without "every one a candidate"', () => {
  const o = buildOverview(fixtureGraph());
  assert.deepEqual(o.edges, [
    { type: 'MAY_CALL', grade: 'SOUND_SET', count: 4 },
    { type: 'DECLARES', grade: 'EXACT', count: 3 },
    { type: 'EXECUTES', grade: 'EXACT', count: 3 },
    { type: 'IMPLEMENTS_STMT', grade: 'EXACT', count: 3 },
    { type: 'HANDLES', grade: 'EXACT', count: 2 },
    { type: 'READS', grade: 'EXACT', count: 2 },
    { type: 'WRITES', grade: 'EXACT', count: 1 },
  ]);
  // the grade totals are the same edges, folded — they must add up to them
  assert.deepEqual(o.grades, [{ grade: 'EXACT', count: 14 }, { grade: 'SOUND_SET', count: 4 }]);
  assert.equal(o.grades.reduce((n, g) => n + g.count, 0), o.edges.reduce((n, e) => n + e.count, 0));
});

test('buildOverview: statement types are counted, and they sum to the statement node count', () => {
  const o = buildOverview(fixtureGraph());
  assert.deepEqual(o.statementTypes, [{ type: 'select', count: 2 }, { type: 'update', count: 1 }]);
  assert.equal(o.statementTypes.reduce((n, s) => n + s.count, 0), o.reach.statements);
});

// ---------------------------------------------------------------------------
// reach — the end-to-end story, walked
// ---------------------------------------------------------------------------

test('buildOverview: reach walks every handler forward and counts what is connected end to end', () => {
  const o = buildOverview(fixtureGraph());
  const { samples, ...counts } = o.reach;
  assert.deepEqual(counts, {
    endpoints: 2, outboundEndpoints: 0, endpointsWithoutStatement: 1, endpointsWithMultipleHandlers: 0,
    statements: 3, statementsReached: 2,
    tables: 2, tablesReached: 1,
    columns: 3, columnsReached: 1,
  });
  assert.deepEqual(samples.endpointsWithoutStatement, ['GET /b/ping']);
  assert.deepEqual(samples.unreachedStatements, ['com.demo.M.orphan']);
  assert.deepEqual(samples.unreachedTables, ['u']);
});

// ---------------------------------------------------------------------------
// The multi-handler defect (RM11). The SAME route string declared by TWO
// controllers is ONE endpoint node with two HANDLES edges. The census used to
// walk `outEdges(ep).find(HANDLES)` — the first edge — so everything the second
// controller reached was reported as unreached code. Here the second controller
// is the ONLY caller of M.orphan, which reads table u: walk one handler and the
// pack looks like it has an orphan statement and an unreached table; walk both
// and it has neither.
// ---------------------------------------------------------------------------

function twoHandlerGraph() {
  const g = buildGraphFromSql(catalog(), lineage());
  addJavaFacts(g, [
    ...javaFacts(),
    { kind: 'type', fqn: 'com.demo.ZController', typeKind: 'class', package: 'com.demo', file: 'src/ZController.java', implements: [] },
    { kind: 'method', fqn: 'com.demo.ZController#one', owner: 'com.demo.ZController', name: 'one', paramCount: 1, line: 40 },
    { kind: 'call', from: 'com.demo.ZController#one', receiver: 'r', method: 'orphan', toTypeSimple: 'M' },
    // the same route string, declared in a second module
    { kind: 'endpoint', httpMethod: 'GET', path: '/a/one', handler: 'com.demo.ZController#one', line: 40 },
  ]);
  return g;
}

test('buildOverview: a route declared TWICE is walked through BOTH handlers — the second module is not reported as unreached', () => {
  const g = twoHandlerGraph();
  // The pack really does hold two handler edges on one route node.
  assert.equal(g.outEdges('endpoint:GET /a/one').filter((e) => e.type === 'HANDLES').length, 2);
  const o = buildOverview(g);
  const { samples, ...counts } = o.reach;
  assert.deepEqual(counts, {
    endpoints: 2, outboundEndpoints: 0, endpointsWithoutStatement: 1, endpointsWithMultipleHandlers: 1,
    // 3 of 3 statements and both tables, because ZController#one's chain counts
    // too. Walking only the first handler gave 2 / 1 / 1 and called M.orphan an
    // orphan.
    statements: 3, statementsReached: 3,
    tables: 2, tablesReached: 2,
    columns: 3, columnsReached: 2,
  });
  assert.deepEqual(samples.unreachedStatements, [], 'nothing is unreached any more');
  assert.deepEqual(samples.unreachedTables, []);
  assert.deepEqual(samples.multiHandlerEndpoints, [{
    endpoint: 'GET /a/one',
    handlers: ['com.demo.AController#one', 'com.demo.ZController#one'],
  }]);
});

test('buildOverview: the duplicate route is DISCLOSED — a reader seeing one route mapped twice is told it is a fact', () => {
  const o = buildOverview(twoHandlerGraph());
  const g = gapOf(o, 'multi-handler-routes');
  assert.equal(g.count, 1);
  assert.match(g.note, /GET \/a\/one \(2\)/);
  assert.match(g.note, /follow every handler together/);
  // and it is told BEFORE the reach gaps it explains
  const kinds = gapKinds(o);
  assert.ok(kinds.indexOf('multi-handler-routes') < kinds.indexOf('mode-floor'));
  // a pack with no duplicate route says nothing at all — no padding zero
  assert.equal(gapOf(buildOverview(fixtureGraph()), 'multi-handler-routes'), undefined);
  assert.equal(buildOverview(fixtureGraph()).reach.samples.multiHandlerEndpoints.length, 0);
});

test('buildOverview: an unreached statement is "no analysed endpoint calls it", never "dead"', () => {
  const o = buildOverview(fixtureGraph());
  const g = gapOf(o, 'statements-not-reached');
  assert.equal(g.count, 1);
  assert.match(g.note, /not reached from the endpoints we analysed/);
  assert.match(g.note, /NOT a claim that they are dead/);
});

test('buildOverview: mode and depth are the walk, and a narrower one reaches less — not "nothing is connected"', () => {
  const strict = buildOverview(fixtureGraph(), { mode: 'strict' });
  // controller→service is MAY_CALL/SOUND_SET: strict cannot leave the handler.
  assert.equal(strict.reach.statementsReached, 0);
  assert.equal(strict.reach.endpointsWithoutStatement, 2);
  assert.equal(strict.reach.tablesReached, 0);
  assert.equal(gapOf(strict, 'mode-floor').count, 4, 'the 4 candidate calls sit below the strict floor');
  assert.match(gapOf(strict, 'mode-floor').note, /mode=strict/);
  // …and the shallow walk stops before the mapper method.
  const shallow = buildOverview(fixtureGraph(), { depth: 2 });
  assert.equal(shallow.reach.statementsReached, 0);
  assert.equal(gapOf(shallow, 'depth-cap').count, 1, 'the /a/one walk still had calls to make at the cap');
  assert.match(gapOf(shallow, 'depth-cap').note, /lower bound/);
});

test('buildOverview: at conservative the floor cuts nothing, and the note says what strict would cost', () => {
  const o = buildOverview(fixtureGraph());
  const g = gapOf(o, 'mode-floor');
  assert.equal(g.count, 0);
  assert.match(g.note, /mode=conservative, depth 8/);
  assert.match(g.note, /mode=strict would refuse 4 more/);
  assert.equal(gapKinds(o).includes('depth-cap'), false, 'nothing was cut by depth here');
});

// ---------------------------------------------------------------------------
// code axis + hubs
// ---------------------------------------------------------------------------

test('buildOverview: the code block counts the symbols, the ones with no source, and the boundaries', () => {
  const o = buildOverview(fixtureGraph());
  assert.deepEqual(o.code, { symbols: 7, external: 1, transactional: 1, mapperMethods: 3, statementsWithoutMapper: 0,
    // no MyBatis-Plus in this fixture: three zeros, which is "the lane found
    // none", not "the lane did not run" — `axes.mybatisPlus` says which
    mpEntities: 0, mpBuiltinStatements: 0, mpStatementsRuntimeOnlyColumns: 0,
    // this fixture's profile declares no generatedSources, so nothing is classified
    generated: 0, generatedInternalEdges: 0, generatedBoundaryEdges: 0 });
});

test('buildOverview: hubs rank the reached tables by how many endpoints arrive, and the endpoints by tables', () => {
  const o = buildOverview(fixtureGraph());
  assert.deepEqual(o.hubs.tables, [{ table: 't', endpoints: 1, statements: 2 }]);
  assert.deepEqual(o.hubs.endpoints, [{ endpoint: 'GET /a/one', httpMethod: 'GET', path: '/a/one', tables: 1, statements: 2 }]);
  // a table nothing reaches is not a hub — the ranked list is exactly tablesReached long
  assert.equal(o.hubs.tables.length, o.reach.tablesReached);
});

// ---------------------------------------------------------------------------
// a pack with no code axis
// ---------------------------------------------------------------------------

test('buildOverview: a SQL-only pack reports the code block as zeros and ONE not-shipped gap', () => {
  const o = buildOverview(sqlOnly());
  assert.deepEqual(o.code, { symbols: 0, external: 0, transactional: 0, mapperMethods: 0, statementsWithoutMapper: 0,
    mpEntities: 0, mpBuiltinStatements: 0, mpStatementsRuntimeOnlyColumns: 0,
    generated: 0, generatedInternalEdges: 0, generatedBoundaryEdges: 0 });
  assert.equal(o.reach.endpoints, 0);
  assert.equal(o.reach.statementsReached, 0);
  const g = gapOf(o, 'not-shipped');
  assert.equal(g.count, 3, 'all 3 statements have no known caller');
  assert.match(g.note, /without the Java lane/);
  assert.match(g.note, /absent, not empty/);
  // "how many calls were unresolved" is a Java-lane question — not asked of a pack that has no Java lane
  assert.equal(gapKinds(o).includes('unresolved-calls'), false);
  assert.equal(gapKinds(o).includes('endpoints-without-statement'), false);
});

test('buildOverview: the lane list only sharpens the not-shipped note; it never invents a count', () => {
  const withLanes = buildOverview(sqlOnly(), { lanes: ['sql'] });
  assert.match(gapOf(withLanes, 'not-shipped').note, /lanes: sql/);
  assert.equal(gapOf(withLanes, 'not-shipped').count, gapOf(buildOverview(sqlOnly()), 'not-shipped').count);
});

// ---------------------------------------------------------------------------
// unresolved calls — a number this pack does not carry is UNKNOWN, not zero
// ---------------------------------------------------------------------------

test('buildOverview: with no lane stats the unresolved-call count is null and says so', () => {
  const g = gapOf(buildOverview(fixtureGraph()), 'unresolved-calls');
  assert.equal(g.count, null);
  assert.match(g.note, /It is not zero/);
});

test('buildOverview: with lane stats the unresolved-call count is reported as a number', () => {
  const g = gapOf(buildOverview(fixtureGraph(), { laneStats: { unresolvedCalls: 12 } }), 'unresolved-calls');
  assert.equal(g.count, 12);
  assert.match(g.note, /^we couldn't tell what 12 method calls point to/);
  assert.equal(g.note.includes('Of those'), false, 'a pack that records no reason split says nothing about one');
});

// RM35: the count says how big the gap is; the split says what it is made of,
// and one of the four reasons is a thing a reader can fix.
test('buildOverview: the unresolved-call gap names WHY, when the pack records it', () => {
  const g = gapOf(buildOverview(fixtureGraph(), {
    laneStats: {
      unresolvedCalls: 12,
      unresolvedCallsByReason: {
        'project-type-outside-roots': 7, 'superclass-outside-roots': 1,
        'type-param-unbound': 0, unknown: 4,
      },
    },
  }), 'unresolved-calls');
  assert.match(g.note, /Of those, 7 name a type in a package of this project that no analyzed source root holds; 1 (?:are|is) `super/);
  assert.match(g.note, /4 we could not place at all/);
  assert.equal(g.note.includes('type parameter'), false, 'a reason with a zero count is left out, not padded in');
});

// ---------------------------------------------------------------------------
// determinism + argument validation
// ---------------------------------------------------------------------------

test('buildOverview: the same graph produces the identical answer, twice', () => {
  assert.deepEqual(buildOverview(fixtureGraph()), buildOverview(fixtureGraph()));
  const g = fixtureGraph();
  assert.deepEqual(buildOverview(g), buildOverview(g));
});

test('buildOverview: every list comes back sorted by its declared key', () => {
  const o = buildOverview(fixtureGraph());
  const desc = (arr, key) => arr.every((x, i) => i === 0 || arr[i - 1][key] >= x[key]);
  assert.ok(desc(o.nodes, 'count'));
  assert.ok(desc(o.edges, 'count'));
  assert.ok(desc(o.statementTypes, 'count'));
  assert.ok(desc(o.hubs.tables, 'endpoints'));
  assert.ok(desc(o.hubs.endpoints, 'tables'));
  for (const list of Object.values(o.reach.samples)) {
    assert.deepEqual(list, list.slice().sort(), 'samples are id-sorted');
  }
});

test('buildOverview: a bad mode or depth throws OverviewError instead of answering', () => {
  const g = fixtureGraph();
  assert.throws(() => buildOverview(g, { mode: 'nope' }), (e) => e instanceof OverviewError);
  assert.throws(() => buildOverview(g, { depth: 0 }), (e) => e instanceof OverviewError);
  assert.throws(() => buildOverview(g, { depth: 1.5 }), (e) => e instanceof OverviewError);
});

// ---------------------------------------------------------------------------
// the tool — contract, the pack block, the caps, and gaps read as limits
// ---------------------------------------------------------------------------

const basis = () => ({ project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const packMeta = () => ({
  project: 'demo', digest: 'abc123def456', builtAt: '2026-01-01T00:00:00.000Z',
  lanes: ['sql', 'java'], base: { repoPath: '/repo', commit: 'c0ffee' }, ddl: '/repo/schema.sql',
});
const ctx = (graph, pack = packMeta()) => ({ graph, basis: basis(), trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack });
// every response in this file goes through the contract before it is inspected
const call = (graph, args, pack) => { const r = overview(graph, args, ctx(graph, pack)); assertContract(r); return r; };
const overviewLimits = (r) => r.limits.filter((l) => l.scope === 'overview');

// A pack with more of everything than one screen holds: 12 tables, 12
// statements and no endpoint, so every sample list is longer than the cap.
function wideSqlOnly() {
  const cat = [];
  const lin = [];
  for (let i = 0; i < 12; i++) {
    const t = `t${String(i).padStart(2, '0')}`;
    cat.push({ kind: 'table', schema: null, table: t, comment: null });
    cat.push({ kind: 'column', schema: null, table: t, column: 'c', type: 'INT', comment: null });
    lin.push({ kind: 'lineage', namespace: 'W', id: `s${String(i).padStart(2, '0')}`, type: 'select', tables: [{ table: t, access: 'read' }], columns: [{ table: t, column: 'c', access: 'read' }], file: 'W.xml', line: 1 });
  }
  return buildGraphFromSql(cat, lin);
}

test('overview tool: one contract-valid answer on the overview axis, with the walk it used', () => {
  const r = call(fixtureGraph(), {});
  assert.equal(r.answer.mode, 'conservative');
  assert.equal(r.answer.depth, 8);
  assert.deepEqual(r.trust.axes, ['overview']);
  assert.equal(r.basis.freshness.verdict, 'unknown');
});

test('overview tool: the pack block is copied from the server, never re-derived', () => {
  const r = call(fixtureGraph(), {});
  assert.deepEqual(r.answer.pack, {
    project: 'demo', digest: 'abc123def456', builtAt: '2026-01-01T00:00:00.000Z',
    lanes: ['sql', 'java'], base: { commit: 'c0ffee', repoPath: '/repo' }, ddl: '/repo/schema.sql',
  });
});

test('overview tool: a server that supplied no pack metadata says unknown — it does not invent a name', () => {
  const r = call(fixtureGraph(), {}, null);
  assert.deepEqual(r.answer.pack, { project: null, digest: null, builtAt: null, lanes: null, base: null });
  assert.ok(r.limits.some((l) => /no pack metadata/.test(l.reason) && /unknown, not absent/.test(l.reason)));
});

test('overview tool: every gap is also a limit — the AI reading the contract sees the same honesty as the page', () => {
  const r = call(fixtureGraph(), {});
  const lim = overviewLimits(r);
  assert.equal(lim.length, r.answer.gaps.length);
  for (const g of r.answer.gaps) {
    assert.ok(lim.some((l) => l.reason.startsWith(`${g.kind} (`)), `${g.kind} must appear in limits`);
  }
  // a count nobody recorded is spelled out, never rendered as "0"
  assert.ok(lim.some((l) => l.reason.startsWith('unresolved-calls (unknown):')));
});

test('overview tool: the schema-bounded censuses are complete, never cut at 10', () => {
  // 12 statement types: bounded by the SQL dialect, not by the pack — cutting
  // this at 10 would hide two whole kinds of statement behind "showing 10 of 12".
  const cat = [{ kind: 'table', schema: null, table: 't', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'c', type: 'INT', comment: null }];
  const lin = [];
  for (let i = 0; i < 12; i++) {
    lin.push({ kind: 'lineage', namespace: 'W', id: `s${i}`, type: `type${String(i).padStart(2, '0')}`,
      tables: [{ table: 't', access: 'read' }], columns: [{ table: 't', column: 'c', access: 'read' }], file: 'W.xml', line: 1 });
  }
  const r = call(buildGraphFromSql(cat, lin), {});
  const f = (name) => r.truncated.fields.find((t) => t.field === name);
  assert.equal(r.answer.statementTypes.length, 12);
  assert.deepEqual(f('statementTypes'), { field: 'statementTypes', shown: 12, total: 12, order: 'count desc, type asc', nextOffset: null });
  for (const name of ['nodes', 'edges', 'grades']) {
    assert.equal(f(name).shown, f(name).total, `${name} is a census: shown must equal total`);
    assert.equal(f(name).nextOffset, null);
  }
});

test('overview tool: the OPEN-ENDED lists are cut at 10 and their true total declared — a headline, not a browser', () => {
  const r = call(wideSqlOnly(), {});
  const f = (name) => r.truncated.fields.find((t) => t.field === name);
  assert.equal(r.answer.reach.samples.unreachedTables.length, 10);
  assert.deepEqual(f('reach.samples.unreachedTables'), { field: 'reach.samples.unreachedTables', shown: 10, total: 12, order: 'id asc', nextOffset: 10 });
  assert.equal(f('reach.samples.unreachedStatements').total, 12);
  assert.equal(r.truncated.any, true);
  // and a list that fits is declared complete
  assert.equal(f('nodes').nextOffset, null);
  // every list in the answer carries an entry
  for (const name of ['nodes', 'edges', 'grades', 'statementTypes', 'gaps', 'hubs.tables', 'hubs.endpoints',
    'reach.samples.endpointsWithoutStatement', 'reach.samples.unreachedStatements', 'reach.samples.unreachedTables']) {
    assert.ok(f(name), `${name} must be declared in truncated.fields`);
  }
});

test('overview tool: a pack with no code axis reports it as not-shipped, not as an empty list', () => {
  const r = call(sqlOnly(), {});
  assert.equal(r.answer.hubs.tables.length, 0);
  assert.equal(r.answer.code.symbols, 0);
  assert.ok(r.answer.gaps.some((g) => g.kind === 'not-shipped'));
  // …and a pack with no SQL lane at all would say the same of its statements
  const empty = call(buildGraphFromSql([], []), {});
  assert.equal(empty.answer.empty.statementTypes, 'not-shipped');
  assert.equal(empty.answer.empty.nodes, 'none');
});

test('overview tool: mode and depth are accepted and echoed; bad ones are rejected, not defaulted', () => {
  const r = call(fixtureGraph(), { mode: 'strict', depth: 3 });
  assert.equal(r.answer.mode, 'strict');
  assert.equal(r.answer.depth, 3);
  assert.equal(r.answer.reach.statementsReached, 0);
  const g = fixtureGraph();
  const bad = (args) => assert.throws(() => overview(g, args, ctx(g)), (e) => e instanceof ToolError && e.code === 'bad-input', JSON.stringify(args));
  bad({ mode: 'nope' });
  bad({ mode: 'constructor' }); // an inherited property is not a mode
  bad({ depth: 0 });
  bad({ depth: 9 });
});

test('overview tool: called with no arguments at all is the default census, not a crash', () => {
  const g = fixtureGraph();
  const r = overview(g, undefined, ctx(g));
  assertContract(r);
  assert.equal(r.answer.mode, 'conservative');
});

test('callTool: routes to overview and returns a contract-valid response', () => {
  const g = fixtureGraph();
  const r = callTool('overview', {}, { graph: g, basis: basis(), pack: packMeta() });
  assert.doesNotThrow(() => assertContract(r));
  assert.deepEqual(r.trust.axes, ['overview']);
  assert.equal(r.answer.reach.endpoints, 2);
});

test('callTool: the pack metadata survives the dispatcher — both transports answer with the same pack', () => {
  const g = fixtureGraph();
  const r = callTool('overview', {}, { graph: g, basis: basis(), pack: packMeta() });
  assert.equal(r.answer.pack.project, 'demo', 'the dispatcher must forward ctx.pack, not rebuild ctx without it');
  assert.equal(r.answer.pack.digest, 'abc123def456');
  assert.deepEqual(r.answer.pack.lanes, ['sql', 'java']);
  assert.equal(r.limits.some((l) => /no pack metadata/.test(l.reason)), false);
});

// ---------------------------------------------------------------------------
// the real pack (skipped when it is not on this machine)
// ---------------------------------------------------------------------------

// The fixture guard lives in ONE place for every mall-pinned test
// (test/helpers/mall_fixture.mjs): absent -> skip; a different digest or
// commit -> skip naming both and the rebuild command; the pin -> run.

test('overview on the mall pack: the node and edge census', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), {});
  // RM35: symbol 10784 -> 10869. Seven are EXTERNAL members (java.util,
  // java.lang, org.slf4j, mybatis-generator) and 78 are project methods that
  // had no edge at all before, so no node either.
  assert.deepEqual(Object.fromEntries(r.answer.nodes.map((n) => [n.kind, n.count])), {
    column: 669, endpoint: 239, statement: 906, symbol: 10869, table: 76,
  });
  // MAY_CALL rose by ONE in RM14 (10126 -> 10127) and nothing else moved. The
  // reason is in mall's source, not in this engine's output: the tree holds a
  // single `this.<method>(...)` call — DynamicSecurityMetadataSource.java:44,
  // `this.loadDataSource()` — which the worker used to drop and now records.
  // (Its two `super.<method>(...)` calls, both in mall-mbg/CommentGenerator.java,
  // climb into MyBatis Generator's DefaultCommentGenerator, which is outside the
  // pack: counted UNRESOLVED, no edge.) See test/helpers/mall_fixture.mjs.
  // RM35: MAY_CALL 10127 -> 10446. The +319 all LEAVE the project: 304 to
  // java.util.List (the `criteria` field of the generated
  // `…Example.GeneratedCriteria` classes, whose own file imports it and which a
  // nested type could not see before), 7 to org.slf4j.Logger (Lombok's `log`),
  // 3 to an ElasticsearchTemplate reached through `java.util.*`, 3 to
  // java.lang.String and 2 to MyBatis Generator's DefaultCommentGenerator,
  // which CommentGenerator.java imports by name. Every other edge population is
  // byte-for-byte what it was.
  assert.deepEqual(r.answer.edges.map((e) => [`${e.type}/${e.grade}`, e.count]), [
    ['MAY_CALL/SOUND_SET', 10446], ['WRITES/EXACT', 3984], ['READS/EXACT', 2362], ['EXECUTES/EXACT', 950],
    ['IMPLEMENTS_STMT/EXACT', 904], ['DECLARES/EXACT', 669], ['HANDLES/EXACT', 246], ['JOINS/EXACT', 27],
  ]);
  // MAY_CALL is now the largest edge population: since javafacts/4 the lane also
  // resolves unqualified (`helper(x)`) call sites, and mall's 76 generated
  // `…Example.GeneratedCriteria` classes call `addCriterion` 8257 times between
  // them. Every one is a candidate call, so the SOUND_SET total overtakes EXACT.
  assert.deepEqual(r.answer.grades, [{ grade: 'EXACT', count: 9142 }, { grade: 'SOUND_SET', count: 10446 }]);
  assert.deepEqual(r.answer.statementTypes, [
    { type: 'update', count: 322 }, { type: 'select', count: 266 }, { type: 'insert', count: 167 }, { type: 'delete', count: 151 },
  ]);
});

test('overview on the mall pack: 208 of 906 statements and 49 of 76 tables are reached end to end', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), {});
  const { samples, ...counts } = r.answer.reach;
  assert.deepEqual(counts, {
    endpoints: 239, outboundEndpoints: 0, endpointsWithoutStatement: 34, endpointsWithMultipleHandlers: 7,
    statements: 906, statementsReached: 208,
    tables: 76, tablesReached: 49,
    columns: 669, columnsReached: 461,
  });
  // The 34 are the routes that touch no database THROUGH THIS PACK: token
  // refresh / file-upload (no DB at all), Elasticsearch and Alipay (a lane this
  // engine does not have), and the demo `template` controller.
  //
  // It was 37 before javafacts/4. The three that now reach their SQL are
  // `GET /cart/list/promotion`, `POST /admin/login` and `POST /sso/login`: each
  // handler delegates through a method of its OWN class — UmsAdminServiceImpl's
  // `login` calls `loadUserByUsername(username)` and `insertLoginLog(username)`
  // unqualified — and the old lane dropped that call site entirely, so a route
  // that plainly reads ums_admin looked as if it touched no database at all.
  assert.equal(samples.endpointsWithoutStatement.length, 10, 'a sample of the 34, not the list');
  assert.deepEqual(samples.endpointsWithoutStatement, [
    'GET /admin/refreshToken', 'GET /alipay/pay', 'GET /alipay/webPay', 'GET /aliyun/oss/policy',
    'GET /esProduct/delete/{id}', 'GET /esProduct/search', 'GET /esProduct/search/relate',
    'GET /esProduct/search/simple', 'GET /member/attention/detail', 'GET /member/attention/list',
  ]);
  assert.equal(r.truncated.fields.find((f) => f.field === 'reach.samples.endpointsWithoutStatement').total, 34);
  assert.equal(samples.unreachedStatements.length, 10, 'a sample of the 698, not the list');
  assert.equal(r.truncated.fields.find((f) => f.field === 'reach.samples.unreachedStatements').total, 698);
  assert.equal(r.truncated.fields.find((f) => f.field === 'reach.samples.unreachedTables').total, 27);
});

test('overview on the mall pack: the code axis, and the hubs the endpoints converge on', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), {});
  // RM35: symbols 10784 -> 10869, of which external 26 -> 33.
  // `transactional` and `mapperMethods` did not move, which is the check that
  // nothing already connected did.
  assert.deepEqual(r.answer.code, { symbols: 10869, external: 33, transactional: 35, mapperMethods: 904, statementsWithoutMapper: 2,
    // mall is MyBatis-generator, not MyBatis-Plus: `grep -rl "BaseMapper\|@TableName"`
    // over its sources finds nothing, so this lane adds nothing to it.
    mpEntities: 0, mpBuiltinStatements: 0, mpStatementsRuntimeOnlyColumns: 0,
    // mall's checked-in profile declares no generatedSources, so its 8 377
    // MyBatis-generator symbols are NOT classified here — see the RM11 report:
    // that generator leaves neither an annotation nor a banner, so only a
    // pathGlob the project declares can name them.
    generated: 0, generatedInternalEdges: 0, generatedBoundaryEdges: 0 });
  assert.equal(r.answer.hubs.tables.length, 10);
  assert.deepEqual(r.answer.hubs.tables[0], { table: 'pms_product', endpoints: 29, statements: 13 });
  assert.equal(r.truncated.fields.find((f) => f.field === 'hubs.tables').total, 49);
  assert.deepEqual(r.answer.hubs.endpoints[0], {
    endpoint: 'POST /order/generateOrder', httpMethod: 'POST', path: '/order/generateOrder', tables: 12, statements: 15,
  });
  assert.equal(r.truncated.fields.find((f) => f.field === 'hubs.endpoints').total, 204);
});

test('overview on the mall pack: the gaps are computed, and five chains are still open at depth 8', { skip: skipUnlessMall() }, () => {
  const r = call(mallGraph(), {});
  const by = Object.fromEntries(r.answer.gaps.map((g) => [g.kind, g.count]));
  assert.deepEqual(by, {
    'unresolved-calls': null, 'external-symbols': 33, 'multi-handler-routes': 7,
    'endpoints-without-statement': 34,
    'statements-not-reached': 698, 'tables-not-reached': 27, 'depth-cap': 5, 'mode-floor': 0,
  });
  // Five endpoints still had calls to walk at the cap, so every "reached"
  // count above is a LOWER bound and the census says so rather than implying
  // it walked everything. It was three before javafacts/4: resolving a
  // controller's own `helper(x)` calls makes some chains one hop longer.
  assert.match(r.answer.gaps.find((g) => g.kind === 'depth-cap').note, /5 endpoint\(s\) still had calls to walk when we stopped at depth 8/);
  assert.equal(overviewLimits(r).length, r.answer.gaps.length);
});

test('overview on the mall pack: the census is deterministic', { skip: skipUnlessMall() }, () => {
  assert.deepEqual(buildOverview(mallGraph()), buildOverview(mallGraph()));
});

// ---------------------------------------------------------------------------
// The web axis (RM28)
// ---------------------------------------------------------------------------

/** `laneStats.web` as the bridge writes it, with the numbers this block reads. */
const webLaneStats = (over = {}) => ({
  files: 90,
  calls: {
    withUrl: 40, traced: 30, platform: 2, untraced: 8, notUrlShaped: 3,
  },
  resolved: { SOUND_SET: 25, HEURISTIC: 5 },
  unresolved: {
    total: 10,
    byReason: {
      parameter: 2, expression: 1, importedConstant: 0, noMatch: 6, outsidePack: 1, allHoles: 0,
    },
  },
  outboundEndpoints: 7,
  prefix: { front: { instances: [{ id: 'front/src/http.js#client', value: '/api', from: 'derived', candidates: [] }] } },
  ...over,
});

test('overview: the web block reports what the frontend reached, and is ABSENT without a web lane', () => {
  const without = buildOverview(fixtureGraph(), { laneStats: { unresolvedCalls: 0 } });
  assert.equal(Object.hasOwn(without, 'web'), false,
    'a pack with no web lane must not carry a web block: "0 frontend calls" and "no frontend was read" are different answers');

  const o = buildOverview(fixtureGraph(), { laneStats: { unresolvedCalls: 0, web: webLaneStats() } });
  assert.deepEqual(o.web, {
    calls: 40,
    resolved: { SOUND_SET: 25, HEURISTIC: 5 },
    unresolved: 10,
    outbound: 7,
    prefix: [{
      package: 'front', instance: 'front/src/http.js#client', value: '/api', from: 'derived',
    }],
  });
});

test('overview: the http-calls-leaving-pack gap counts the frontend\'s misses apart from the backend\'s', () => {
  // The fixture graph has no outbound endpoint of its own, so one is added here
  // exactly as the web bridge adds it: a route the frontend names and nothing
  // in this pack serves.
  const g = fixtureGraph();
  g.addNode({
    id: 'endpoint:GET /gone/away', path: '/gone/away', httpMethod: 'GET', outbound: true, source: 'web',
  });
  g.addEdge({
    from: 'symbol:front/src/api/x.js#go',
    to: 'endpoint:GET /gone/away',
    type: 'CALLS_HTTP',
    grade: 'UNRESOLVED',
    evidence: { rule: 'web-http-call' },
  });
  const o = buildOverview(g, { laneStats: { unresolvedCalls: 0, web: webLaneStats() } });
  const gap = gapOf(o, 'http-calls-leaving-pack');
  assert.ok(gap, gapKinds(o).join(', '));
  assert.equal(gap.count, 1);
  assert.match(gap.note, /7 of those target\(s\) are named by the FRONTEND/);
  assert.match(gap.note, /6 matched no route here, 1 name another host/);
  assert.match(gap.note, /check the web axis reason before reading them as external/);
});
