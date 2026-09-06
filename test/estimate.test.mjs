import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { Graph } from '../src/core/graph.mjs';
import { ratio, estimateBefore, measurePack, buildEstimate, EstimateError } from '../src/core/estimate.mjs';
import { normalizeProfile } from '../src/core/profile.mjs';

// The coverage estimate (SPEC §10.4). Two halves, and the one rule that matters
// for both: a ratio with an empty denominator is `null`, never 0% — "there is
// nothing to measure" and "nothing measured well" are different answers, and an
// AI that reads the second where the first was true will act on a lie.

// --------------------------------------------------------------------------
// ratio
// --------------------------------------------------------------------------

test('ratio: one decimal, and null (never 0%) when there is nothing to divide', () => {
  assert.deepEqual(ratio(3, 4), { num: 3, den: 4, pct: 75 });
  assert.deepEqual(ratio(1, 3), { num: 1, den: 3, pct: 33.3 });
  assert.deepEqual(ratio(2, 3), { num: 2, den: 3, pct: 66.7 });
  assert.deepEqual(ratio(0, 0), { num: 0, den: 0, pct: null });
  assert.deepEqual(ratio(0, 5), { num: 0, den: 5, pct: 0 });
  assert.equal(ratio(0, 0, 'why').note, 'why');
});

// --------------------------------------------------------------------------
// The MEASURED half, on a graph with counts chosen by hand
// --------------------------------------------------------------------------

// 4 statements: three have column facts, one of those splices `${}` raw text.
//   selA  reads t.a           — column facts, no subst  -> EXACT-answerable
//   selB  reads t.b           — column facts, no subst  -> EXACT-answerable
//   selC  reads t.a, ${order} — column facts, SUBST     -> not EXACT-answerable
//   opaque no columns at all                            -> not EXACT-answerable
// So statementsWithColumnFacts 3/4 = 75.0 and exactAnswerable 2/4 = 50.0.
function sqlGraph() {
  const catalog = [
    { kind: 'table', schema: null, table: 't', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'a', type: 'INT', comment: null },
    { kind: 'column', schema: null, table: 't', column: 'b', type: 'INT', comment: null },
  ];
  const st = (id, columns, extra = {}) => ({
    kind: 'lineage', namespace: 'com.example.shop.mapper.M', id, type: 'select',
    tables: [{ table: 't', access: 'read' }], columns, file: 'M.xml', line: 1, ...extra,
  });
  const lineage = [
    st('selA', [{ table: 't', column: 'a', access: 'read' }]),
    st('selB', [{ table: 't', column: 'b', access: 'read' }]),
    st('selC', [{ table: 't', column: 'a', access: 'read' }], { hasStringSubst: true }),
    st('opaque', [], { schemaUnknown: true }),
  ];
  return buildGraphFromSql(catalog, lineage);
}

// Two endpoints, one of which reaches a statement; four mapper methods, three
// of which bind (the fourth names a statement this pack does not carry).
function javaFacts() {
  const M = 'com.example.shop.mapper.M';
  return [
    { kind: 'type', fqn: 'com.example.shop.web.C', typeKind: 'class', package: 'com.example.shop.web', file: 'C.java', implements: [], annotations: [] },
    { kind: 'type', fqn: M, typeKind: 'interface', package: 'com.example.shop.mapper', file: 'M.java', implements: [], annotations: ['Mapper'] },
    { kind: 'import', owner: 'com.example.shop.web.C', simple: 'M', fqn: M },
    { kind: 'method', fqn: 'com.example.shop.web.C#list', owner: 'com.example.shop.web.C', name: 'list', paramCount: 0, line: 3 },
    { kind: 'method', fqn: 'com.example.shop.web.C#ping', owner: 'com.example.shop.web.C', name: 'ping', paramCount: 0, line: 4 },
    { kind: 'method', fqn: `${M}#selA`, owner: M, name: 'selA', paramCount: 0, line: 5 },
    { kind: 'method', fqn: `${M}#selB`, owner: M, name: 'selB', paramCount: 0, line: 6 },
    { kind: 'method', fqn: `${M}#selC`, owner: M, name: 'selC', paramCount: 0, line: 7 },
    { kind: 'method', fqn: `${M}#notInThisPack`, owner: M, name: 'notInThisPack', paramCount: 0, line: 8 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/shop/list', handler: 'com.example.shop.web.C#list', line: 3 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/shop/ping', handler: 'com.example.shop.web.C#ping', line: 4 },
    { kind: 'call', from: 'com.example.shop.web.C#list', receiver: 'm', method: 'selA', toTypeSimple: 'M' },
    // A call to a type outside the declared prefixes: resolved, external, NOT unresolved.
    { kind: 'import', owner: 'com.example.shop.web.C', simple: 'Logger', fqn: 'org.other.Logger' },
    { kind: 'call', from: 'com.example.shop.web.C#ping', receiver: 'log', method: 'info', toTypeSimple: 'Logger' },
    // A call the lane cannot resolve at all.
    { kind: 'call', from: 'com.example.shop.web.C#ping', receiver: 'x', method: 'go', toTypeSimple: 'Nowhere' },
  ];
}

test('measurePack: the SQL ratios come out of the statement nodes (3 of 4 = 75.0)', () => {
  const r = measurePack(sqlGraph());
  assert.deepEqual(r.statementsWithColumnFacts, { num: 3, den: 4, pct: 75 });
  assert.deepEqual(r.statementsWithStringSubst, { num: 1, den: 4, pct: 25 });
  assert.deepEqual(r.statementsWithUnknownSchema, { num: 1, den: 4, pct: 25 });
  assert.deepEqual(r.exactAnswerable, { num: 2, den: 4, pct: 50 });
  // No code axis: nothing to measure, so null — not 0%.
  assert.deepEqual(r.endpointsReachingAStatement, { num: 0, den: 0, pct: null });
  assert.deepEqual(r.mapperMethodsBound, { num: 0, den: 0, pct: null });
  assert.equal(r.callsResolved.pct, null);
  assert.match(r.callsResolved.note, /UNKNOWN, not zero/);
});

test('measurePack: with the code axis, endpoints / mapper methods / calls are measured', () => {
  const g = sqlGraph();
  const stats = addJavaFacts(g, javaFacts(), { packagePrefixes: ['com.example'] });
  // 4 mapper methods, 3 bound (selA/selB/selC), 1 unbound (notInThisPack).
  assert.equal(stats.mapperMethods, 4);
  assert.equal(stats.mapperMethodsBound, 3);
  assert.equal(stats.unboundMapperMethods, 1);
  // The unbound one did NOT get a stub statement node.
  assert.equal(g.nodes.has('statement:com.example.shop.mapper.M.notInThisPack'), false);
  assert.equal(stats.externalCalls, 1);
  assert.equal(stats.unresolvedCalls, 1);

  const r = measurePack(g, { laneStats: stats });
  assert.deepEqual(r.endpointsReachingAStatement, { num: 1, den: 2, pct: 50 });
  assert.deepEqual(r.mapperMethodsBound, { num: 3, den: 4, pct: 75 });
  // calls = 2 (selA + the external Logger), external = 1, unresolved = 1
  // → project-internal resolved 1 of 3 call sites seen.
  assert.deepEqual(r.callsResolved, { num: 1, den: 3, pct: 33.3 });
});

test('measurePack: an empty graph reports nothing measurable rather than a row of zeros', () => {
  const r = measurePack(new Graph());
  for (const key of Object.keys(r)) assert.equal(r[key].pct, null, `${key} should be null on an empty pack`);
});

// --------------------------------------------------------------------------
// The BEFORE-ANALYSIS half, on a synthetic discovery
// --------------------------------------------------------------------------

const discovery = (counts, over = {}) => ({
  counts: {
    javaFiles: 0, javaTestFiles: 0, springHandlerFiles: 0, mybatisMapperXml: 0, ddlFiles: 0,
    jpaEntityFiles: 0, kotlinFiles: 0, frontendPackageJson: 0, webFiles: 0, vueFiles: 0, ...counts,
  },
  mapperDirs: [], javaSourceRoots: [], javaTestRoots: [], webSourceRoots: [], webPackages: [], ...over,
});
const axisOf = (r, name) => r.axes.find((a) => a.axis === name);

test('estimateBefore: a full Spring/MyBatis tree ships every axis this engine has', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 40, springHandlerFiles: 6, mybatisMapperXml: 12, ddlFiles: 1 },
      { mapperDirs: ['a/dao'], javaSourceRoots: ['a/src/main/java'] }),
    normalizeProfile({ frameworkPacks: ['spring-mvc', 'mybatis-xml'], catalog: { source: 'file', connectionFrom: '../s.sql' } }),
  );
  for (const a of ['catalog', 'statements', 'column', 'code', 'endpoints']) {
    assert.equal(axisOf(r, a).status, 'shipped', `${a} should ship`);
  }
  assert.equal(axisOf(r, 'web').status, 'not-shipped');
  assert.equal(axisOf(r, 'screen').status, 'not-shipped');
  assert.deepEqual(r.notCovered, []);
  // Every statement carries the count it rests on.
  assert.equal(axisOf(r, 'endpoints').counts.springHandlerFiles, 6);
  assert.equal(axisOf(r, 'statements').counts.mapperXmlFiles, 12);
});

test('estimateBefore: the code axis counts MAIN java files and names the test files it will skip', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 40, javaTestFiles: 9, springHandlerFiles: 6 },
      { javaSourceRoots: ['a/src/main/java'], javaTestRoots: ['a/src/test/java', 'b/src/test'] }),
    normalizeProfile({ frameworkPacks: ['spring-mvc'] }),
  );
  const code = axisOf(r, 'code');
  assert.equal(code.status, 'shipped');
  assert.match(code.reason, /31 main java file\(s\) across 1 source root\(s\); 9 more sit in 2 src\/test root\(s\)/);
  assert.deepEqual(code.counts, { javaFiles: 40, javaMainFiles: 31, javaTestFiles: 9, javaSourceRoots: 1, javaTestRoots: 2 });
});

test('estimateBefore: no DDL degrades the column axis and says why', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 10, springHandlerFiles: 2, mybatisMapperXml: 3, ddlFiles: 0 }, { mapperDirs: ['dao'] }),
    normalizeProfile({ frameworkPacks: ['spring-mvc', 'mybatis-xml'] }),
  );
  assert.equal(axisOf(r, 'catalog').status, 'not-shipped');
  assert.match(axisOf(r, 'catalog').reason, /no \.sql file in this tree contains CREATE TABLE/);
  assert.equal(axisOf(r, 'column').status, 'degraded');
  assert.match(axisOf(r, 'column').reason, /record it as unresolved rather than guess/);
});

test('estimateBefore: java without a single Spring handler does not ship the endpoint axis', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 20, springHandlerFiles: 0, mybatisMapperXml: 2, ddlFiles: 1 }),
    normalizeProfile({ frameworkPacks: ['spring-mvc', 'mybatis-xml'], catalog: { source: 'file', connectionFrom: 's.sql' } }),
  );
  assert.equal(axisOf(r, 'code').status, 'shipped');
  assert.equal(axisOf(r, 'endpoints').status, 'not-shipped');
  assert.match(axisOf(r, 'endpoints').reason, /no java file carries a Spring mapping annotation/);
});

test('estimateBefore: Kotlin and an UNREAD frontend are named as not covered; JPA is an AXIS now, not a gap', () => {
  const r = estimateBefore(
    discovery(
      { javaFiles: 30, jpaEntityFiles: 7, kotlinFiles: 4, frontendPackageJson: 2, webFiles: 90, vueFiles: 40 },
      { webSourceRoots: ['a/src', 'b/src'] },
    ),
    normalizeProfile({}),
  );
  assert.deepEqual(r.notCovered.map((n) => [n.technology, n.files]), [['Kotlin', 4], ['frontend', 2]]);
  // The profile declares no packs, so the web lane will NOT run and the reason
  // names the missing declaration rather than the missing lane.
  assert.equal(axisOf(r, 'web').status, 'not-shipped');
  assert.match(axisOf(r, 'web').reason, /frameworkPacks does not declare web/);
  // The profile above declares no packs, so neither lane runs and the entities
  // are found but NOT read — and the reason names the lane that is missing.
  assert.equal(axisOf(r, 'jpa').status, 'not-shipped');
  assert.match(axisOf(r, 'jpa').reason, /the Java lane will not run/);
});

test('estimateBefore: with the web pack declared the axis is DEGRADED before the run, and says why', () => {
  const d = discovery(
    { javaFiles: 0, frontendPackageJson: 1, webFiles: 120, vueFiles: 65 },
    { webSourceRoots: ['front/src'] },
  );
  const r = estimateBefore(d, normalizeProfile({ frameworkPacks: ['web'] }));
  const web = axisOf(r, 'web');
  assert.equal(web.status, 'degraded', 'what a run has to guess is not knowable before the run, so the estimate says degraded');
  assert.match(web.reason, /120 frontend source file\(s\) in 1 root\(s\)/);
  assert.match(web.reason, /attach it to the route this pack serves/);
  assert.match(web.reason, /graded HEURISTIC/);
  assert.deepEqual(web.counts, { frontendPackages: 1, webFiles: 120, vueFiles: 65, webSourceRoots: 1 });
  // A frontend the lane WILL read is no longer an uncovered technology.
  assert.deepEqual(r.notCovered, []);
  // Nothing here declares a router: not the profile's packs, and not the
  // package discovery found. So the third state resolves to off, and the reason
  // says which of the three rules decided it.
  assert.equal(axisOf(r, 'screen').status, 'not-shipped');
  assert.match(axisOf(r, 'screen').reason, /screenAxis\.enabled is undeclared/);
  assert.match(axisOf(r, 'screen').reason, /no frontend package this run reads depends on one/);
  assert.equal(axisOf(r, 'screen').counts.enabledFrom, 'nothing-read');
});

test('estimateBefore: with a router pack and the axis on, the screen axis is DEGRADED before the run', () => {
  const d = discovery(
    { javaFiles: 0, frontendPackageJson: 1, webFiles: 120, vueFiles: 65 },
    { webSourceRoots: ['front/src'] },
  );
  const r = estimateBefore(
    d,
    normalizeProfile({ frameworkPacks: ['web', 'vue-router'], screenAxis: { enabled: true } }),
    { routes: 57 },
  );
  const screen = axisOf(r, 'screen');
  assert.equal(screen.status, 'degraded');
  assert.match(screen.reason, /router pack\(s\): vue-router/);
  assert.match(screen.reason, /the last run recorded 57 route declaration\(s\)/);
  assert.match(screen.reason, /RENDERS edge/);
  assert.deepEqual(screen.counts.routerPacks, ['vue-router']);
  assert.equal(screen.counts.enabled, true);
  assert.equal(screen.counts.lastRunRoutes, 57);
});

test('estimateBefore: the axis on with NO router pack says which declaration is missing', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 0, frontendPackageJson: 1, webFiles: 12 }, { webSourceRoots: ['front/src'] }),
    normalizeProfile({ frameworkPacks: ['web'], screenAxis: { enabled: true } }),
  );
  assert.equal(axisOf(r, 'screen').status, 'not-shipped');
  assert.match(axisOf(r, 'screen').reason, /names no router pack/);
});

test('estimateBefore: the web pack declared with no frontend package says THAT, not "no frontend"', () => {
  const r = estimateBefore(
    discovery({ webFiles: 12 }, { webSourceRoots: [] }),
    normalizeProfile({ frameworkPacks: ['web'] }),
  );
  assert.equal(axisOf(r, 'web').status, 'not-shipped');
  assert.match(axisOf(r, 'web').reason, /no package\.json declaring a framework dependency/);
  assert.match(axisOf(r, 'web').reason, /--web-src/);
});

test('estimateBefore: with the jpa pack declared the axis ships DEGRADED until a naming strategy is', () => {
  const d = discovery({ javaFiles: 30, springHandlerFiles: 2, jpaEntityFiles: 7 });
  const undeclared = estimateBefore(d, normalizeProfile({ frameworkPacks: ['spring-mvc', 'jpa'] }));
  assert.equal(axisOf(undeclared, 'jpa').status, 'degraded');
  assert.match(axisOf(undeclared, 'jpa').reason, /graded HEURISTIC/);
  const declared = estimateBefore(d, normalizeProfile({ frameworkPacks: ['spring-mvc', 'jpa'], jpa: { namingStrategy: 'spring-snake-case' } }));
  assert.equal(axisOf(declared, 'jpa').status, 'shipped');
});

test('estimateBefore: files found but the pack not declared → the run would not read them', () => {
  const r = estimateBefore(
    discovery({ javaFiles: 10, springHandlerFiles: 3, mybatisMapperXml: 5, ddlFiles: 2 }),
    normalizeProfile({}),
  );
  assert.equal(axisOf(r, 'statements').status, 'not-shipped');
  assert.match(axisOf(r, 'statements').reason, /frameworkPacks does not declare mybatis-xml/);
  assert.match(axisOf(r, 'catalog').reason, /catalog\.source is "none"/);
  assert.match(axisOf(r, 'code').reason, /frameworkPacks does not declare spring-mvc/);
});

// --------------------------------------------------------------------------
// Both halves together
// --------------------------------------------------------------------------

test('buildEstimate: with no pack the measured half is null AND says so', () => {
  const e = buildEstimate({ discovery: discovery({ javaFiles: 1 }), profile: normalizeProfile({}), root: '/x' });
  assert.equal(e.schema, 'cascade:estimate:1');
  assert.equal(e.measured, null);
  assert.match(e.measuredNote, /no pack yet/);
  assert.ok(e.before.axes.length >= 6);
});

test('buildEstimate: with a pack both halves are present and the note goes away', () => {
  const g = sqlGraph();
  const stats = addJavaFacts(g, javaFacts(), { packagePrefixes: ['com.example'] });
  const e = buildEstimate({
    discovery: discovery({ javaFiles: 3, mybatisMapperXml: 1 }), profile: normalizeProfile({}),
    graph: g, pack: { digest: 'abc123', builtAt: '2020-01-01T00:00:00Z', lanes: ['sql', 'java'], laneStats: stats },
    root: '/x', project: 'shop',
  });
  assert.equal(e.measuredNote, null);
  assert.equal(e.project, 'shop');
  assert.equal(e.measured.pack.digest, 'abc123');
  assert.equal(e.measured.ratios.exactAnswerable.pct, 50);
  assert.throws(() => buildEstimate({}), EstimateError);
});

// --------------------------------------------------------------------------
// The web ratio (RM28)
// --------------------------------------------------------------------------

test('measurePack: webCallsResolved is null without a web lane, and measured with one', () => {
  const none = measurePack(sqlGraph());
  assert.equal(none.webCallsResolved.pct, null, 'no web lane is UNKNOWN, never a comforting 0%');
  assert.match(none.webCallsResolved.note, /UNKNOWN, not zero/);

  // The denominator is CALL SITES WITH A URL, not every call the lane saw: a
  // call whose URL is a parameter was never a candidate for an endpoint.
  const measured = measurePack(sqlGraph(), {
    laneStats: {
      web: {
        calls: { withUrl: 40, traced: 30, platform: 2, untraced: 8 },
        resolved: { SOUND_SET: 25, HEURISTIC: 5 },
      },
    },
  });
  assert.deepEqual(measured.webCallsResolved, { num: 30, den: 40, pct: 75 });
});
