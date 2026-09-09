import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  selectLanes, sqlLaneArgs, declareAxes, axisLimits, axisKnownGaps, AXES, chooseDdlFiles,
  screenAxisOf, serviceNamesOf,
} from '../src/core/lanes.mjs';
import { normalizeProfile } from '../src/core/profile.mjs';

const ROOT = path.resolve('/tmp/project');
const DOT = path.join(ROOT, '.cascade');

const discovery = (over = {}) => ({
  mapperDirs: ['app/src/main/resources/dao'],
  javaSourceRoots: ['app/src/main/java'],
  counts: {},
  ...over,
});

// --------------------------------------------------------------------------
// sqlLaneArgs — the ONE place the SQL-lane worker flags are built (I-5)
// --------------------------------------------------------------------------

test('sqlLaneArgs: defaults route mysql and NOTHING else — no invented schema (I-4)', () => {
  const a = sqlLaneArgs(normalizeProfile({}));
  assert.equal(a.dialect, 'mysql');
  assert.equal(a.defaultSchema, null);
  // The identity rule is ALWAYS spelled out to the worker, never left to its
  // own default: the worker sees a sqlglot dialect, the rule belongs to the
  // database the profile named, and those two are not the same name.
  assert.equal(a.identifierCase, 'fold-lower');
  assert.deepEqual(a.lineageArgs, ['--dialect', 'mysql', '--identifier-case', 'fold-lower']);
  assert.deepEqual(a.mybatisArgs, []);
});

test('sqlLaneArgs: the identity rule follows the dialect, and a declaration overrides it', () => {
  // Every row of the declared table, through the profile that names it.
  const caseOf = (main) => sqlLaneArgs(normalizeProfile({ sqlDialects: { main } })).identifierCase;
  assert.equal(caseOf('mysql'), 'fold-lower');
  assert.equal(caseOf('mariadb'), 'fold-lower');
  assert.equal(caseOf('postgres'), 'fold-lower');
  assert.equal(caseOf('oracle'), 'fold-upper');
  assert.equal(caseOf('oracle-19c'), 'fold-upper');
  assert.equal(caseOf('hsqldb'), 'fold-upper');
  assert.equal(caseOf('h2'), 'fold-upper');
  // hsqldb has no sqlglot parser of its own: it routes to sqlglot's default
  // (ANSI) one, and the case rule still comes from HSQLDB, not from that parser.
  assert.equal(sqlLaneArgs(normalizeProfile({ sqlDialects: { main: 'hsqldb' } })).dialect, '');
  // An explicit declaration wins over the dialect's rule, in both directions.
  const forced = sqlLaneArgs(normalizeProfile({ sqlDialects: { main: 'oracle' }, sqlIdentifierCase: 'exact' }));
  assert.equal(forced.identifierCase, 'exact');
  assert.deepEqual(forced.lineageArgs, ['--dialect', 'oracle', '--identifier-case', 'exact']);
});

test('sqlLaneArgs: schema.default + propertyNames reach both workers, dialect is mapped', () => {
  const a = sqlLaneArgs(normalizeProfile({
    sqlDialects: { main: 'oracle-19c' },
    schema: { default: 'shopdb', propertyNames: ['dbMain', 'dbLog'] },
  }));
  assert.equal(a.dialect, 'oracle');
  assert.deepEqual(a.lineageArgs, ['--dialect', 'oracle', '--identifier-case', 'fold-upper', '--default-schema', 'shopdb']);
  assert.deepEqual(a.mybatisArgs, [
    '--default-schema', 'shopdb',
    '--schema-property', 'dbMain',
    '--schema-property', 'dbLog',
  ]);
});

test('sqlLaneArgs: propertyNames without a default schema still declares the properties', () => {
  const a = sqlLaneArgs(normalizeProfile({ schema: { propertyNames: ['dbMain'] } }));
  // No --default-schema: the qualifier is dropped and the statement flagged, not renamed.
  assert.deepEqual(a.mybatisArgs, ['--schema-property', 'dbMain']);
});

// --------------------------------------------------------------------------
// selectLanes
// --------------------------------------------------------------------------

test('selectLanes: explicit flags win over the profile and discovery', () => {
  const r = selectLanes({
    flags: { ddl: 'db/schema.sql', mappers: ['m2', 'm1'], javaSrc: ['j'] },
    profile: normalizeProfile({ frameworkPacks: ['mybatis-xml', 'spring-mvc'], catalog: { source: 'file', connectionFrom: '../other.sql' } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.equal(r.ddl, path.join(ROOT, 'db/schema.sql'));
  assert.deepEqual(r.sources, { ddl: 'flag', mappers: 'flag', javaSrc: 'flag', webSrc: 'none', openapi: 'none', har: 'none', otel: 'none' });
  // Sorted: the pack digest must not depend on the order the flags were typed.
  assert.deepEqual(r.mappers, [path.join(ROOT, 'm1'), path.join(ROOT, 'm2')]);
  assert.deepEqual(r.lanes, ['sql', 'java']);
});

test('selectLanes: with no flags the inputs come from the profile + discovery', () => {
  const r = selectLanes({
    flags: {},
    profile: normalizeProfile({
      frameworkPacks: ['mybatis-xml', 'spring-mvc'],
      catalog: { source: 'file', connectionFrom: '../document/sql/schema.sql' },
    }),
    discovery: discovery(), root: ROOT, manifestDir: DOT,
  });
  // catalog.connectionFrom is relative to the MANIFEST directory (SPEC §5).
  assert.equal(r.ddl, path.join(ROOT, 'document/sql/schema.sql'));
  assert.deepEqual(r.mappers, [path.join(ROOT, 'app/src/main/resources/dao')]);
  assert.deepEqual(r.javaSrc, [path.join(ROOT, 'app/src/main/java')]);
  assert.deepEqual(r.sources, { ddl: 'profile', mappers: 'discovery', javaSrc: 'discovery', webSrc: 'none', openapi: 'none', har: 'none', otel: 'none' });
  assert.deepEqual(r.diagnostics, []);
});

// --------------------------------------------------------------------------
// OpenAPI documents: flag > profile > discovery (RM29)
// --------------------------------------------------------------------------

const withDocs = (extra = {}) => ({ ...discovery(), openapiDocuments: [{ path: 'api/found.yaml', version: '3' }], ...extra });

test('selectLanes: --openapi wins over the profile and over discovery', () => {
  const r = selectLanes({
    flags: { openapi: ['contracts/typed.yaml'] },
    profile: normalizeProfile({ openapi: { documents: ['declared.yaml'] } }),
    discovery: withDocs(), root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.deepEqual(r.openapi, [path.join(ROOT, 'contracts/typed.yaml')]);
  assert.equal(r.sources.openapi, 'flag');
  assert.ok(r.lanes.includes('openapi'));
});

test('selectLanes: with no flag the profile is next, and its paths are MANIFEST-relative', () => {
  const r = selectLanes({
    flags: {},
    profile: normalizeProfile({ openapi: { documents: ['../api/declared.yaml'] } }),
    discovery: withDocs(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.openapi, [path.join(ROOT, 'api/declared.yaml')]);
  assert.equal(r.sources.openapi, 'profile');
});

test('selectLanes: with neither, discovery supplies the documents, ROOT-relative', () => {
  const r = selectLanes({
    flags: {}, profile: normalizeProfile({}), discovery: withDocs(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.openapi, [path.join(ROOT, 'api/found.yaml')]);
  assert.equal(r.sources.openapi, 'discovery');
  assert.ok(r.lanes.includes('openapi'), 'a document is a lane, with no framework pack to declare');
});

test('selectLanes: --no-openapi reads nothing, whatever the profile and discovery say', () => {
  const r = selectLanes({
    flags: { noOpenapi: true },
    profile: normalizeProfile({ openapi: { documents: ['declared.yaml'] } }),
    discovery: withDocs(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.openapi, []);
  assert.equal(r.sources.openapi, 'none');
  assert.equal(r.lanes.includes('openapi'), false);
});

test('declareAxes: routes from a document and no java lane make the CODE axis degraded, with the reason', () => {
  const axes = declareAxes({ ddl: false, statements: false, code: false, openapi: { paths: 12 } });
  assert.equal(axes.code.status, 'degraded');
  assert.match(axes.code.reason, /endpoints come from an OpenAPI document, not from source/);
  assert.match(axes.code.reason, /a frontend call reaches an endpoint and stops there/);
  // With a java lane the document changes nothing about this axis.
  assert.equal(declareAxes({ ddl: false, statements: false, code: true, openapi: { paths: 12 } }).code.status, 'shipped');
  // ...and a document that declared nothing is not a code axis either.
  assert.equal(declareAxes({ ddl: false, statements: false, code: false, openapi: { paths: 0 } }).code.status, 'not-shipped');
});

test('selectLanes: a framework pack the profile does not declare is not run unflagged', () => {
  const r = selectLanes({
    flags: {}, profile: normalizeProfile({ frameworkPacks: ['mybatis-xml'] }),
    discovery: discovery(), root: ROOT, manifestDir: DOT,
  });
  assert.equal(r.javaSrc.length, 0, 'spring-mvc is not declared, so the Java lane is not selected');
  assert.deepEqual(r.lanes, ['sql']);
});

test('selectLanes: catalog.source=jdbc reads the pinned snapshot, not a DDL and not a database', () => {
  const snap = path.join(DOT, 'catalog', 'columns.jsonl');
  const r = selectLanes({
    cwd: ROOT, flags: { mappers: ['m'] },
    profile: normalizeProfile({ catalog: { source: 'jdbc', connectionFrom: 'app.yml' } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT, catalogSnapshot: snap,
  });
  assert.equal(r.ddl, null, 'a snapshot is not a DDL file — catalog_ddl.py must not be pointed at it');
  assert.equal(r.snapshot, snap);
  assert.deepEqual(r.catalog, { kind: 'snapshot', path: snap, paths: [snap], source: 'profile' });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.lanes, ['sql']);
});

test('selectLanes: catalog.source=jdbc with nowhere to keep a snapshot says so instead of guessing', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { mappers: ['m'] },
    profile: normalizeProfile({ catalog: { source: 'jdbc', connectionFrom: 'app.yml' } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT, catalogSnapshot: null,
  });
  assert.equal(r.snapshot, null);
  assert.equal(r.catalog.kind, null);
  assert.equal(r.diagnostics[0].kind, 'MISSING_INPUT');
  assert.match(r.diagnostics[0].reason, /cascade catalog fetch/);
});

test('selectLanes: --ddl still wins over a jdbc snapshot', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { ddl: 'schema.sql', mappers: ['m'] },
    profile: normalizeProfile({ catalog: { source: 'jdbc', connectionFrom: 'app.yml' } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT,
    catalogSnapshot: path.join(DOT, 'catalog', 'columns.jsonl'),
  });
  assert.equal(r.snapshot, null);
  assert.equal(r.catalog.kind, 'ddl');
  assert.equal(r.sources.ddl, 'flag');
});

test('selectLanes: a declared pack whose files discovery never found is reported, not assumed', () => {
  const r = selectLanes({
    flags: {}, profile: normalizeProfile({ frameworkPacks: ['mybatis-xml', 'spring-mvc'] }),
    discovery: discovery({ mapperDirs: [], javaSourceRoots: [] }), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.lanes, []);
  assert.equal(r.diagnostics.length, 2);
  assert.equal(r.diagnostics.every((d) => d.kind === 'MISSING_INPUT'), true);
});

test('selectLanes: DDL alone is a runnable lane (a catalog-only pack)', () => {
  const r = selectLanes({
    flags: { ddl: 'schema.sql' }, profile: normalizeProfile({}),
    discovery: discovery({ mapperDirs: [], javaSourceRoots: [] }), root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.deepEqual(r.lanes, ['sql']);
  assert.deepEqual(r.mappers, []);
});

test('selectLanes: a flag path is relative to the SHELL, a profile path to the manifest', () => {
  const r = selectLanes({
    flags: { ddl: 'db/schema.sql' }, profile: normalizeProfile({}),
    discovery: null, root: ROOT, manifestDir: DOT, cwd: '/elsewhere',
  });
  assert.equal(r.ddl, path.resolve('/elsewhere/db/schema.sql'),
    'a --ddl the user typed must not be silently re-rooted at --root');
  const fromProfile = selectLanes({
    flags: {}, profile: normalizeProfile({ catalog: { source: 'file', connectionFrom: '../db/schema.sql' } }),
    discovery: null, root: ROOT, manifestDir: DOT, cwd: '/elsewhere',
  });
  assert.equal(fromProfile.ddl, path.join(ROOT, 'db/schema.sql'));
});

test('selectLanes: duplicate mapper directories collapse (a file is never analyzed twice)', () => {
  const r = selectLanes({
    flags: { mappers: ['m', 'm', './m'] }, profile: normalizeProfile({}),
    discovery: null, root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.deepEqual(r.mappers, [path.join(ROOT, 'm')]);
});

// --------------------------------------------------------------------------
// declareAxes + the two projections the tool layer reads
// --------------------------------------------------------------------------

test('declareAxes: every axis is present, with a reason whenever it is not shipped', () => {
  const axes = declareAxes({ ddl: true, statements: true, code: true });
  assert.deepEqual(Object.keys(axes).sort(), [...AXES].sort());
  for (const a of ['catalog', 'statements', 'column', 'code']) {
    assert.equal(axes[a].status, 'shipped');
    assert.equal(axes[a].reason, null);
  }
  for (const a of ['web', 'screen']) {
    assert.equal(axes[a].status, 'not-shipped');
    assert.ok(axes[a].reason.length > 10);
  }
});

test('declareAxes: mappers WITHOUT a catalog degrade the column axis, they do not delete it', () => {
  const axes = declareAxes({ ddl: false, statements: true, code: false });
  assert.equal(axes.catalog.status, 'not-shipped');
  assert.equal(axes.statements.status, 'shipped');
  assert.equal(axes.column.status, 'degraded');
  assert.match(axes.column.reason, /unresolved rather than dropped/);
  assert.equal(axes.code.status, 'not-shipped');
});

test('declareAxes: DDL alone ships the catalog and nothing that needs a statement', () => {
  const axes = declareAxes({ ddl: true, statements: false, code: false });
  assert.equal(axes.catalog.status, 'shipped');
  assert.equal(axes.statements.status, 'not-shipped');
  assert.equal(axes.column.status, 'not-shipped');
  assert.match(axes.column.reason, /no statement was analyzed/);
});

test('declareAxes: java alone ships only the code axis', () => {
  const axes = declareAxes({ ddl: false, statements: false, code: true });
  assert.equal(axes.code.status, 'shipped');
  assert.equal(axes.statements.status, 'not-shipped');
  assert.equal(axes.column.status, 'not-shipped');
});

// RM35: a SHIPPED code axis can still carry a note. "the code axis is shipped"
// and "and here is the one thing in it we could not see" are both true, and
// calling the whole axis degraded would be a bigger claim than the evidence.
test('declareAxes: a shipped code axis NAMES the packages no source root holds, and what to pass', () => {
  const axes = declareAxes({
    ddl: true,
    statements: true,
    code: true,
    java: {
      typesOutsideRoots: [
        { package: 'org.acme.common.util', simple: 'RedisUtil', calls: 74 },
        { package: 'org.acme.common.api', simple: 'Sender', calls: 9 },
      ],
    },
  });
  assert.equal(axes.code.status, 'shipped');
  assert.equal(axes.code.notes.length, 1);
  assert.match(axes.code.notes[0], /83 call\(s\)/);
  assert.match(axes.code.notes[0], /org\.acme\.common\.api, org\.acme\.common\.util/);
  assert.match(axes.code.notes[0], /--java-src/);
  // A note is a limit even on a shipped axis, so the tool layer reports it.
  const limits = axisLimits(axes).filter((l) => l.scope === 'axis:code');
  assert.equal(limits.length, 1);
  assert.equal(limits[0].reason, axes.code.notes[0]);
  // …and the axis is still SHIPPED, so `axisKnownGaps` says nothing about it.
  assert.equal(axisKnownGaps(axes).some((g) => g.startsWith('code-')), false);
});

test('declareAxes: one package outside the roots is under the threshold, so no note', () => {
  const axes = declareAxes({
    ddl: true, statements: true, code: true,
    java: { typesOutsideRoots: [{ package: 'org.acme.util', simple: 'RedisUtil', calls: 3 }] },
  });
  assert.equal(axes.code.notes, undefined);
  assert.deepEqual(axisLimits(axes).filter((l) => l.scope === 'axis:code'), []);
  // A pack from an engine that recorded none (an older one) is not a claim that
  // there are none: it is silence, and silence adds no sentence.
  assert.equal(declareAxes({ ddl: true, statements: true, code: true }).code.notes, undefined);
});

test('declareAxes: a profile that ASKED for the screen axis gets a reason that says why not', () => {
  const on = declareAxes({ ddl: true, statements: true, code: true }, { screenAxisRequested: true });
  assert.match(on.screen.reason, /the profile enables the screen axis/);
  const off = declareAxes({ ddl: true, statements: true, code: true });
  assert.match(off.screen.reason, /the web lane did not run/);
});

// --------------------------------------------------------------------------
// screenAxisOf — the screen axis switch, in three states
// --------------------------------------------------------------------------

const withRouter = [{ path: '/x/front/package.json', router: 'vue-router' }];
const noRouter = [{ path: '/x/front/package.json', router: null }];

test('screenAxisOf: true and false are the USER\'S WORD, whatever the run reads', () => {
  const on = screenAxisOf(normalizeProfile({ screenAxis: { enabled: true } }), { webPackages: noRouter });
  assert.equal(on.enabled, true);
  assert.equal(on.from, 'profile');
  // Off even though the frontend this run reads does declare a router: the user
  // said no, and an engine that argues with that is an engine nobody can steer.
  const off = screenAxisOf(
    normalizeProfile({ frameworkPacks: ['web', 'vue-router'], screenAxis: { enabled: false } }),
    { webPackages: withRouter },
  );
  assert.equal(off.enabled, false);
  assert.equal(off.from, 'profile');
});

test('screenAxisOf: the THIRD state is decided by what the run reads, not by what init saw', () => {
  // A router pack the profile declares is the first rule: `cascade init` wrote
  // it because it found one in the tree.
  const declared = screenAxisOf(normalizeProfile({ frameworkPacks: ['web', 'react-router'] }), {});
  assert.equal(declared.enabled, true);
  assert.equal(declared.from, 'declared-router');
  assert.match(declared.reason, /react-router/);

  // THE CASE THIS STATE EXISTS FOR: a backend whose profile names no router
  // pack, because discovery walked the backend and the frontend is checked out
  // beside it. The run reads that frontend's package, and it depends on a
  // router, so the screens are built.
  const read = screenAxisOf(normalizeProfile({ frameworkPacks: ['spring-mvc'] }), { webPackages: withRouter });
  assert.equal(read.enabled, true);
  assert.equal(read.from, 'read-router');
  assert.match(read.reason, /a frontend package this run reads depends on vue-router/);

  // Nothing anywhere declares a router: off, and the reason names all three
  // rules that were tried rather than saying "disabled".
  const nothing = screenAxisOf(normalizeProfile({ frameworkPacks: ['spring-mvc'] }), { webPackages: noRouter });
  assert.equal(nothing.enabled, false);
  assert.equal(nothing.from, 'nothing-read');
  assert.match(nothing.reason, /undeclared/);
  assert.match(nothing.reason, /no frontend package this run reads depends on one/);

  // The key ABSENT is the same state as null, and no evidence at all is off.
  assert.equal(screenAxisOf({ frameworkPacks: [] }, {}).enabled, false);
  assert.equal(screenAxisOf(null, {}).enabled, false);
  assert.equal(screenAxisOf(normalizeProfile({}), {}).from, 'nothing-read');
});

// --------------------------------------------------------------------------
// The web lane (RM26)
// --------------------------------------------------------------------------

const webDiscovery = (over = {}) => discovery({
  webSourceRoots: ['web/src'],
  webPackages: [{ path: 'web/package.json', root: 'web/src', framework: 'vue', router: 'vue-router', http: ['axios'] }],
  ...over,
});

test('selectLanes: --web-src names the frontend root, and it is resolved against the CWD', () => {
  const r = selectLanes({
    flags: { webSrc: ['front/src'] },
    profile: normalizeProfile({}),
    root: ROOT, cwd: '/tmp/elsewhere', manifestDir: DOT,
  });
  assert.deepEqual(r.webSrc, ['/tmp/elsewhere/front/src']);
  assert.equal(r.sources.webSrc, 'flag');
  assert.ok(r.lanes.includes('web'));
});

test('selectLanes: with no flag, the web pack lets discovery\'s frontend roots in', () => {
  const r = selectLanes({
    flags: {},
    profile: normalizeProfile({ frameworkPacks: ['web'] }),
    discovery: webDiscovery(),
    root: ROOT, cwd: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.webSrc, [path.join(ROOT, 'web/src')]);
  assert.equal(r.sources.webSrc, 'discovery');
  assert.ok(r.lanes.includes('web'));
});

test('selectLanes: without the web pack, a frontend discovery finds is NOT read', () => {
  const r = selectLanes({
    flags: {},
    profile: normalizeProfile({}),
    discovery: webDiscovery(),
    root: ROOT, cwd: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.webSrc, []);
  assert.equal(r.lanes.includes('web'), false);
});

test('selectLanes: --no-web switches the lane off even when the profile declares it', () => {
  const r = selectLanes({
    flags: { noWeb: true },
    profile: normalizeProfile({ frameworkPacks: ['web'] }),
    discovery: webDiscovery(),
    root: ROOT, cwd: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.webSrc, []);
  assert.equal(r.sources.webSrc, 'none');
  assert.equal(r.lanes.includes('web'), false);
});

test('selectLanes: the web pack declared with nothing found is a MISSING_INPUT, not a silent skip', () => {
  const r = selectLanes({
    flags: {},
    profile: normalizeProfile({ frameworkPacks: ['web'] }),
    discovery: discovery({ webSourceRoots: [], webPackages: [] }),
    root: ROOT, cwd: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.webSrc, []);
  const d = r.diagnostics.find((x) => x.kind === 'MISSING_INPUT' && /declares web/.test(x.reason));
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.match(d.reason, /--web-src/);
});

// The web axis, from what the bridge actually did (RM28). `laneStats.web` is the
// worker's counts merged with the bridge's, so these fixtures are that shape.
const webStats = (over = {}) => ({
  files: 120, parseErrors: 0, calls: { withUrl: 168, traced: 160, platform: 4, untraced: 4 },
  routes: 57,
  resolved: { SOUND_SET: 140, HEURISTIC: 0 },
  unresolved: { total: 28, byReason: { parameter: 6, expression: 0, importedConstant: 0, noMatch: 20, outsidePack: 2 } },
  prefix: { front: { instances: [{ id: 'front/src/u.js#c', value: '/admin', from: 'derived', candidates: [] }] } },
  assumedAliases: 0,
  ...over,
});

test('declareAxes: a web lane that guessed NOTHING is shipped', () => {
  const axes = declareAxes({
    ddl: false, statements: false, code: false, web: webStats({ calls: { withUrl: 168, traced: 168, platform: 0, untraced: 0 } }),
  });
  assert.equal(axes.web.status, 'shipped');
  assert.equal(axes.web.reason, null);
  // ...and the screen axis still says the routes were RECORDED, which is a
  // different sentence from "there is no web lane".
  assert.equal(axes.screen.status, 'not-shipped');
  assert.match(axes.screen.reason, /recorded 57 route declaration\(s\)/);
});

// The screen axis, from what the bridge actually built. `laneStats.web.screens`
// is that block, so these fixtures are its shape.
const screenStats = (over = {}) => ({
  enabled: true,
  declared: 57,
  screens: 57,
  withComponent: 57,
  componentUnresolved: 0,
  renders: { EXACT: 100, SOUND_SET: 20 },
  nameSource: { asked: 'none', used: 'none', refused: null },
  serverDriven: { detected: false, detectedBy: null, routes: 57, ceiling: 30, menuEndpoints: [] },
  ...over,
});

test('declareAxes: a MENU CALL makes the screen axis degraded whatever the route count is', () => {
  // A big frontend that ALSO fetches its menu: 173 routes declared in the source
  // and a call that resolved to the menu route. Before RM32 the rule needed
  // fewer than 30 declared routes as well, so a shape like this read `shipped`
  // and every screen number looked like the whole product.
  const big = declareAxes({
    ddl: false,
    web: webStats({
      routes: 173,
      screens: screenStats({
        declared: 173,
        screens: 166,
        serverDriven: { detected: true, detectedBy: 'menu-call', routes: 173, ceiling: 30, menuEndpoints: ['/sys/getRouters'] },
      }),
    }),
  });
  assert.equal(big.screen.status, 'degraded');
  assert.match(big.screen.reason, /the app also fetches its menu from the server at run time/);
  assert.match(big.screen.reason, /a call to \/sys\/getRouters was found/);
  assert.match(big.screen.reason, /173 screen\(s\) are declared in the source and the ones the server adds are not here/);
  // Over the ceiling: the WORDING changes, the verdict does not.
  assert.match(big.screen.reason, /screens beyond the 173 declared arrive when the app runs/);

  // Under the ceiling, the same rule with the other sentence.
  const small = declareAxes({
    ddl: false,
    web: webStats({
      routes: 21,
      screens: screenStats({
        declared: 21,
        screens: 21,
        serverDriven: { detected: true, detectedBy: 'menu-call', routes: 21, ceiling: 30, menuEndpoints: ['/getRouters'] },
      }),
    }),
  });
  assert.equal(small.screen.status, 'degraded');
  assert.match(small.screen.reason, /most screens arrive when the app runs/);

  // And the shape that is NOT server driven: 57 routes, no menu call anywhere.
  // Nothing was guessed, so the axis is shipped and says nothing.
  const quiet = declareAxes({ ddl: false, web: webStats({ screens: screenStats() }) });
  assert.equal(quiet.screen.status, 'shipped');
  assert.equal(quiet.screen.reason, null);
});

test('declareAxes: a guessed prefix or an assumed alias degrades the web axis by name, and an untraced call rides along', () => {
  const auto = declareAxes({
    ddl: false,
    web: webStats({ prefix: { front: { instances: [{ id: 'front/src/u.js#c', value: '', from: 'auto', candidates: [] }] } } }),
  });
  assert.equal(auto.web.status, 'degraded');
  assert.match(auto.web.reason, /prefix chosen by match count for front/);
  assert.match(auto.web.reason, /declare gatewayRoutes/);

  const alias = declareAxes({ ddl: false, web: webStats({ assumedAliases: 12 }) });
  assert.equal(alias.web.status, 'degraded');
  assert.match(alias.web.reason, /alias @ assumed as src, on 12 call\(s\)/);

  // An untraced call does NOT demote the axis on its own: it is an edge, graded
  // HEURISTIC, that says so about itself. It is named as context once something
  // else has already made the axis degraded.
  assert.match(alias.web.reason, /4 call\(s\) untraced/);
  assert.match(alias.web.reason, /140 frontend call\(s\) reached a route this pack serves/);
  const onlyUntraced = declareAxes({ ddl: false, web: webStats() });
  assert.equal(onlyUntraced.web.status, 'shipped');
});

test('declareAxes: a web lane that resolved NOTHING says how many calls it read and the top reason', () => {
  const axes = declareAxes({
    ddl: false,
    web: webStats({ resolved: { SOUND_SET: 0, HEURISTIC: 0 } }),
  });
  assert.equal(axes.web.status, 'degraded');
  assert.match(axes.web.reason, /168 HTTP call site\(s\) and not one of them reached a route this pack serves/);
  assert.match(axes.web.reason, /most often because noMatch \(20 call\(s\)\)/);
  assert.match(axes.web.reason, /declare it as gatewayRoutes/);
});

test('declareAxes: a pack from an engine whose web lane only RECORDED facts still reads honestly', () => {
  // No `resolved` block at all: an older pack, and the axis must not claim the
  // lane resolved zero calls when it never tried.
  const axes = declareAxes({
    ddl: false, web: { files: 120, parseErrors: 0, calls: 360, callsWithUrl: 168, routes: 57 },
  });
  assert.equal(axes.web.status, 'degraded');
  assert.match(axes.web.reason, /parsed 120 file\(s\)/);
  assert.match(axes.web.reason, /168 HTTP call site\(s\)/);
  assert.match(axes.web.reason, /without attaching any of them to an endpoint/);
});

test('declareAxes: no web lane says WHY there is none, and names the flag', () => {
  const axes = declareAxes({ ddl: true, statements: true, code: true });
  assert.equal(axes.web.status, 'not-shipped');
  assert.match(axes.web.reason, /--web-src/);
  assert.match(axes.web.reason, /--no-web/);
});

test('axisLimits / axisKnownGaps: only non-shipped axes, in a fixed order', () => {
  const axes = declareAxes({ ddl: false, statements: true, code: false });
  assert.deepEqual(axisKnownGaps(axes), [
    'catalog-axis-not-shipped', 'column-axis-degraded', 'jpa-axis-not-shipped',
    'mybatisPlus-axis-not-shipped',
    'code-axis-not-shipped', 'web-axis-not-shipped', 'screen-axis-not-shipped',
  ]);
  const limits = axisLimits(axes);
  assert.equal(limits.length, 7);
  assert.equal(limits[0].scope, 'axis:catalog');
  assert.match(limits[1].reason, /the column axis of this pack is degraded/);
  // A pack that declares nothing yields nothing — the tools then infer as before.
  assert.deepEqual(axisLimits(null), []);
  assert.deepEqual(axisKnownGaps(null), []);
  assert.deepEqual(axisKnownGaps(declareAxes({
    ddl: true, statements: true, code: true,
    jpa: { entities: 2, repositories: 1, namingStrategyDeclared: true },
    mybatisPlus: { entities: 3, statements: 9, namingStrategyDeclared: true },
  })).filter((g) => !g.startsWith('web') && !g.startsWith('screen')), []);

  // The MyBatis-Plus axis is DEGRADED, not shipped, while the naming strategy is
  // assumed: every name the mapping did not spell out was derived by a rule the
  // project never declared, and the answer must say so.
  const mpAssumed = declareAxes({
    ddl: true, statements: true, code: true,
    mybatisPlus: { entities: 64, statements: 542, namingStrategyDeclared: false },
  });
  assert.equal(mpAssumed.mybatisPlus.status, 'degraded');
  assert.match(mpAssumed.mybatisPlus.reason, /camelCase to under_score/);
  assert.ok(axisKnownGaps(mpAssumed).includes('mybatisPlus-axis-degraded'));
});

test('selectLanes: --no-ddl overrides a profile that declares a catalog (a deliberate partial pack)', () => {
  const r = selectLanes({
    flags: { noDdl: true, mappers: ['dao'] },
    profile: normalizeProfile({ frameworkPacks: ['mybatis-xml'], catalog: { source: 'file', connectionFrom: '../s.sql' } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.equal(r.ddl, null);
  assert.equal(r.sources.ddl, 'none');
  assert.deepEqual(r.diagnostics, [], 'an explicit --no-ddl is a choice, not a defect to warn about');
  assert.equal(declareAxes({ ddl: !!r.ddl, statements: r.mappers.length > 0, code: false }).column.status, 'degraded');
});

// --------------------------------------------------------------------------
// Test sources: excluded from an UNFLAGGED run, never hidden (round RM2b)
// --------------------------------------------------------------------------

const withTests = (over = {}) => discovery({
  javaSourceRoots: ['app/src/main/java'],
  javaTestRoots: ['app/src/test/java', 'other/src/test'],
  ...over,
});

test('selectLanes: an unflagged run reads main sources and REPORTS the test roots it left out', () => {
  const r = selectLanes({
    flags: {}, profile: normalizeProfile({ frameworkPacks: ['spring-mvc'] }),
    discovery: withTests(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.javaSrc, [path.join(ROOT, 'app/src/main/java')]);
  assert.deepEqual(r.excludedTestRoots, ['app/src/test/java', 'other/src/test']);
});

test('selectLanes: --java-src naming a test root is honoured, and excludes nothing', () => {
  const r = selectLanes({
    flags: { javaSrc: ['app/src/test/java'] }, profile: normalizeProfile({ frameworkPacks: ['spring-mvc'] }),
    discovery: withTests(), root: ROOT, manifestDir: DOT, cwd: ROOT,
  });
  assert.deepEqual(r.javaSrc, [path.join(ROOT, 'app/src/test/java')]);
  assert.deepEqual(r.excludedTestRoots, [], 'the user named it, so nothing was left out on their behalf');
  assert.deepEqual(r.lanes, ['java']);
});

test('selectLanes: a project that is ONLY test roots says so rather than reporting no java at all', () => {
  const r = selectLanes({
    flags: {}, profile: normalizeProfile({ frameworkPacks: ['spring-mvc'] }),
    discovery: withTests({ javaSourceRoots: [] }), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.javaSrc, []);
  assert.match(r.diagnostics[0].reason, /every Java source root discovery found is a test root.*Pass --java-src/);
});

test('selectLanes: --no-mappers and --no-java switch a lane off that the project would supply', () => {
  const profile = normalizeProfile({
    frameworkPacks: ['mybatis-xml', 'spring-mvc'],
    catalog: { source: 'file', connectionFrom: '../s.sql' },
  });
  const all = selectLanes({ flags: {}, profile, discovery: withTests(), root: ROOT, manifestDir: DOT });
  assert.deepEqual(all.lanes, ['sql', 'java']);
  assert.ok(all.ddl && all.mappers.length > 0 && all.javaSrc.length > 0);

  const noMappers = selectLanes({ flags: { noMappers: true }, profile, discovery: withTests(), root: ROOT, manifestDir: DOT });
  assert.deepEqual(noMappers.mappers, []);
  assert.equal(noMappers.sources.mappers, 'none');
  assert.ok(noMappers.ddl, 'the catalog lane is untouched');
  assert.equal(declareAxes({ ddl: true, statements: false, code: true }).statements.status, 'not-shipped');

  const noJava = selectLanes({ flags: { noJava: true }, profile, discovery: withTests(), root: ROOT, manifestDir: DOT });
  assert.deepEqual(noJava.javaSrc, []);
  assert.deepEqual(noJava.excludedTestRoots, [], 'nothing was excluded on the user\'s behalf — the whole lane is off');
  assert.deepEqual(noJava.lanes, ['sql']);

  const nothing = selectLanes({
    flags: { noDdl: true, noMappers: true, noJava: true }, profile, discovery: withTests(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(nothing.lanes, [], 'all three off leaves nothing runnable — the CLI then fails with what discovery found');
});

// ---------------------------------------------------------------------------
// A CATALOG FROM SEVERAL DDL FILES (RM20 §3)
//
// One `--ddl` is the exception, not the rule: a schema is commonly split one
// file per service, one file per dialect, or a base plus a migration sequence.
// ---------------------------------------------------------------------------

const ddlCandidate = (over) => ({
  path: 'x.sql', dialect: 'mysql', role: 'schema',
  createTables: 5, alters: 0, dml: 0, byPath: false, testPath: false, ...over,
});

test('selectLanes: --ddl is a LIST, resolved in the order it was given', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { ddl: ['db/a.sql', 'db/b.sql'], noMappers: true, noJava: true },
    profile: normalizeProfile({}), discovery: discovery(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls, [path.join(ROOT, 'db/a.sql'), path.join(ROOT, 'db/b.sql')]);
  assert.equal(r.ddl, r.ddls[0], '`ddl` stays the first, for every caller that only wanted one');
  assert.deepEqual(r.catalog, { kind: 'ddl', path: r.ddls[0], paths: r.ddls, source: 'flag' });
  assert.deepEqual(r.lanes, ['sql']);
});

test('selectLanes: a single --ddl string still works, and is a set of one', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { ddl: 'db/a.sql', noMappers: true, noJava: true },
    profile: normalizeProfile({}), discovery: discovery(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls, [path.join(ROOT, 'db/a.sql')]);
  assert.equal(r.sources.ddl, 'flag');
});

test('selectLanes: catalog.connectionFrom takes an ARRAY, in the order written', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { noMappers: true, noJava: true },
    profile: normalizeProfile({ catalog: { source: 'file', connectionFrom: ['../svc-a/schema.sql', '../svc-b/schema.sql'] } }),
    discovery: discovery(), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls, [path.resolve(ROOT, 'svc-a/schema.sql'), path.resolve(ROOT, 'svc-b/schema.sql')]);
  assert.equal(r.sources.ddl, 'profile');
  assert.equal(r.ddlChoice, null, 'the project said it — there is nothing to explain');
});

test('selectLanes: with nothing declared, discovery picks every SCHEMA file of the dialect, in path order', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { noMappers: true, noJava: true },
    profile: normalizeProfile({ sqlDialects: { main: 'mysql' } }),
    discovery: discovery({
      ddlCandidates: [
        ddlCandidate({ path: 'a/db/mysql/schema.sql' }),
        ddlCandidate({ path: 'b/db/mysql/schema.sql' }),
        ddlCandidate({ path: 'sql/dolphin_postgresql.sql', dialect: 'postgres' }),
        ddlCandidate({ path: 'sql/upgrade/2.0.sql', role: 'migration', createTables: 0, alters: 9, byPath: true }),
      ],
    }),
    root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls, [path.join(ROOT, 'a/db/mysql/schema.sql'), path.join(ROOT, 'b/db/mysql/schema.sql')]);
  assert.equal(r.sources.ddl, 'discovery');
  assert.equal(r.ddlChoice.dialect, 'mysql');
  assert.equal(r.ddlChoice.dialectFrom, 'profile');
  assert.equal(r.ddlChoice.migrations, 1);
  assert.deepEqual(r.ddlChoice.skipped.map((s) => s.path),
    ['sql/dolphin_postgresql.sql', 'sql/upgrade/2.0.sql']);
  for (const s of r.ddlChoice.skipped) assert.ok(s.reason.length > 20, s.reason);
});

test('selectLanes: an explicit --ddl overrides the classification entirely — a migration CAN be applied', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { ddl: ['sql/schema.sql', 'sql/upgrade/2.0.sql'], noMappers: true, noJava: true },
    profile: normalizeProfile({}),
    discovery: discovery({ ddlCandidates: [ddlCandidate({ path: 'sql/schema.sql' })] }),
    root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls.map((p) => path.relative(ROOT, p)), ['sql/schema.sql', 'sql/upgrade/2.0.sql']);
  assert.equal(r.ddlChoice, null);
});

test('selectLanes: --no-ddl still wins over everything, including the classification', () => {
  const r = selectLanes({
    cwd: ROOT, flags: { noDdl: true, noMappers: true, javaSrc: ['src'] },
    profile: normalizeProfile({ catalog: { source: 'file', connectionFrom: ['a.sql'] } }),
    discovery: discovery({ ddlCandidates: [ddlCandidate({})] }), root: ROOT, manifestDir: DOT,
  });
  assert.deepEqual(r.ddls, []);
  assert.equal(r.ddl, null);
});

test('chooseDdlFiles: with no declared dialect, the one most schema files use wins', () => {
  const c = chooseDdlFiles([
    ddlCandidate({ path: 'a.sql', dialect: 'postgres' }),
    ddlCandidate({ path: 'b.sql', dialect: 'postgres' }),
    ddlCandidate({ path: 'c.sql', dialect: 'mysql' }),
  ], normalizeProfile({ sqlDialects: {} }));
  // normalizeProfile leaves sqlDialects empty here, so the files decide.
  assert.equal(c.dialectFrom, 'files');
  assert.equal(c.dialect, 'postgres');
  assert.deepEqual(c.chosen.map((x) => x.path), ['a.sql', 'b.sql']);
  assert.deepEqual(c.skipped.map((x) => x.path), ['c.sql']);
});

test('chooseDdlFiles: a file whose dialect nothing reveals is PORTABLE and is kept', () => {
  const c = chooseDdlFiles([
    ddlCandidate({ path: 'a.sql', dialect: 'mysql' }),
    ddlCandidate({ path: 'b.sql', dialect: null }),
  ], normalizeProfile({ sqlDialects: { main: 'mysql' } }));
  assert.deepEqual(c.chosen.map((x) => x.path), ['a.sql', 'b.sql']);
});

test('chooseDdlFiles: a schema file under src/test is a fixture, and is left out with that reason', () => {
  const c = chooseDdlFiles([
    ddlCandidate({ path: 'src/main/resources/db/schema.sql' }),
    ddlCandidate({ path: 'tools/src/test/resources/3.0.0_schema/full.sql', testPath: true }),
  ], normalizeProfile({ sqlDialects: { main: 'mysql' } }));
  assert.deepEqual(c.chosen.map((x) => x.path), ['src/main/resources/db/schema.sql']);
  assert.equal(c.testFiles, 1);
  assert.match(c.skipped[0].reason, /src\/test\/. source root/);
});

test('chooseDdlFiles: nothing to choose from yields nothing, and says no dialect — never a guess', () => {
  const c = chooseDdlFiles([], normalizeProfile({ sqlDialects: {} }));
  assert.deepEqual(c.chosen, []);
  assert.equal(c.dialect, null);
  assert.equal(c.dialectFrom, 'none');
});

// --------------------------------------------------------------------------
// serviceNamesOf — who this run says it is (RM46)
// --------------------------------------------------------------------------

test('serviceNamesOf: the profile wins, and discovery is not consulted at all', () => {
  const r = serviceNamesOf(
    normalizeProfile({ serviceNames: ['orders-service'] }),
    { serviceNames: [{ name: 'read-from-the-tree', file: 'src/main/resources/application.yml' }] },
  );
  assert.deepEqual(r, { names: ['orders-service'], from: 'profile', files: [] });
});

test('serviceNamesOf: an empty profile takes THIS RUN\'s discovery, and says where from', () => {
  const r = serviceNamesOf(normalizeProfile({}), {
    serviceNames: [
      { name: 'orders-service', file: 'b/src/main/resources/application.yml' },
      { name: 'billing-service', file: 'a/src/main/resources/application.yml' },
      { name: 'orders-service', file: 'b/src/main/resources/application-docker.yml' },
    ],
  });
  assert.deepEqual(r.names, ['billing-service', 'orders-service'], 'unique and sorted, so two runs write one sidecar');
  assert.equal(r.from, 'discovery');
  assert.deepEqual(r.files, [
    'a/src/main/resources/application.yml',
    'b/src/main/resources/application-docker.yml',
    'b/src/main/resources/application.yml',
  ]);
});

test('serviceNamesOf: no profile key and no discovery is `none`, not a guess', () => {
  assert.deepEqual(serviceNamesOf(normalizeProfile({}), null), { names: [], from: 'none', files: [] });
  assert.deepEqual(serviceNamesOf(normalizeProfile({}), { serviceNames: [] }), { names: [], from: 'none', files: [] });
  // A run that gave every lane a flag reads no tree at all, and that is not a
  // reason to invent a name.
  assert.deepEqual(serviceNamesOf(null, null), { names: [], from: 'none', files: [] });
});
