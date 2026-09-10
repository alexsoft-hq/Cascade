import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, buildProfile, lanesOf, slugify, writeInitFiles, InitError } from '../src/core/init.mjs';
import { validateManifest, MANIFEST_SCHEMA, REPO_KINDS } from '../src/core/manifest.mjs';
import { validateProfile } from '../src/core/profile.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const SHA = (c) => c.repeat(40).slice(0, 40);

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

const discovery = (over = {}) => ({
  root: '/p/app',
  repos: [{ path: '.', commit: SHA('a'), javaFiles: 3, frontendPackageJson: 0 }],
  counts: { javaFiles: 3, springHandlerFiles: 1, mybatisMapperXml: 2, ddlFiles: 1, jpaEntityFiles: 0, kotlinFiles: 0, frontendPackageJson: 0 },
  buildTool: 'maven',
  packagePrefixes: ['com.example.app'],
  ddlPaths: ['db/schema.sql'],
  ddlDialectHint: 'mysql',
  filesScanned: 9,
  capped: false,
  diagnostics: [],
  ...over,
});

test('slugify makes a filesystem-safe id, or null when nothing usable is left', () => {
  assert.equal(slugify('My App'), 'my-app');
  assert.equal(slugify('mall'), 'mall');
  assert.equal(slugify('app_v2.1'), 'app_v2.1');
  assert.equal(slugify('---'), null);
  assert.equal(slugify(''), null);
  assert.equal(slugify(42), null);
});

test('lanesOf reports only the lanes the tree can feed', () => {
  assert.deepEqual(lanesOf(discovery()), ['sql', 'java']);
  assert.deepEqual(lanesOf(discovery({ counts: { javaFiles: 0, ddlFiles: 1, mybatisMapperXml: 0 } })), ['sql']);
  assert.deepEqual(lanesOf(discovery({ counts: { javaFiles: 2, ddlFiles: 0, mybatisMapperXml: 0 } })), ['java']);
  assert.deepEqual(lanesOf(discovery({ counts: {} })), []);
});

test('buildManifest points the root repo at ".." — relative to the manifest FILE, not the root', () => {
  const m = buildManifest(discovery(), { projectId: 'app', root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.equal(m.project, 'app');
  assert.equal(m.profile, './profile.json');
  assert.deepEqual(m.repositories, [{ key: 'app', path: '..', commit: SHA('a'), kind: 'backend-java' }]);
  assert.doesNotThrow(() => validateManifest(m, '/p/app/.cascade/manifest.json'));
  // …and it resolves back to the repo it came from.
  const norm = validateManifest(m, '/p/app/.cascade/manifest.json');
  assert.equal(norm.repositories[0].absPath, '/p/app');
});

test('buildManifest gives a nested repo a path relative to the manifest dir and its own key', () => {
  const d = discovery({
    repos: [
      { path: '.', commit: SHA('a'), javaFiles: 0, frontendPackageJson: 0 },
      { path: 'services/api', commit: SHA('b'), javaFiles: 5, frontendPackageJson: 0 },
      { path: 'web', commit: SHA('c'), javaFiles: 0, frontendPackageJson: 1 },
    ],
  });
  const m = buildManifest(d, { projectId: 'app', root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(m.repositories.map((r) => [r.key, r.path, r.kind]), [
    ['app', '..', 'unknown'],
    ['services-api', '../services/api', 'backend-java'],
    ['web', '../web', 'frontend-web'],
  ]);
  assert.doesNotThrow(() => validateManifest(m, '/p/app/.cascade/manifest.json'));
});

test('"unknown" is an accepted repo kind (a repo whose stack was not identified is listed, not dropped)', () => {
  assert.ok(REPO_KINDS.includes('unknown'));
  const m = {
    schema: MANIFEST_SCHEMA, project: 'app', profile: './profile.json',
    repositories: [{ key: 'app', path: '..', commit: SHA('a'), kind: 'unknown' }],
  };
  assert.doesNotThrow(() => validateManifest(m, '/p/app/.cascade/manifest.json'));
});

test('buildManifest refuses a tree with no committed repository, and says why', () => {
  assert.throws(() => buildManifest(discovery({ repos: [] }), { projectId: 'app', root: '/p/app', manifestDir: '/p/app/.cascade' }), (e) => {
    assert.ok(e instanceof InitError);
    assert.match(e.message, /no git repository with a HEAD commit/);
    return true;
  });
});

test('buildManifest refuses an unusable project id', () => {
  assert.throws(() => buildManifest(discovery(), { projectId: 'Bad Id', root: '/p/app', manifestDir: '/p/app/.cascade' }), InitError);
});

test('buildProfile carries the discovered hints and passes validateProfile', () => {
  const { profile, diagnostics } = buildProfile(discovery(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.equal(profile.build.tool, 'maven');
  assert.deepEqual(profile.packagePrefixes, ['com.example.app']);
  assert.deepEqual(profile.frameworkPacks, ['spring-mvc', 'mybatis-xml']);
  // A backend with no frontend package IN THIS TREE leaves the switch at its
  // third state, not at false: discovery walked this root, and a frontend
  // checked out beside it is not something this walk could have seen. Saying
  // `false` here would put a word in the user's mouth that the run would obey.
  assert.equal(profile.screenAxis.enabled, null);
  assert.deepEqual(profile.runtimeEvidence, { har: [], otel: [] });
  assert.deepEqual(profile.catalog, { source: 'file', connectionFrom: '../db/schema.sql', ddl: [], ddlAlternatives: {} });
  assert.deepEqual(profile.sqlDialects, { main: 'mysql' });
  assert.equal(profile.schema.default, null, 'invariant I-4: no invented schema name');
  assert.deepEqual(diagnostics, []);
  assert.doesNotThrow(() => validateProfile(profile));
});

test('buildProfile writes the service name and the gateway routes discovery read (RM46)', () => {
  const { profile, diagnostics } = buildProfile(discovery({
    serviceNames: [{ name: 'edge-service', file: 'src/main/resources/application.yml' }],
    gatewayRoutes: [
      { front: '/api/order', to: '', service: 'orders-service', file: 'src/main/resources/application.yml', id: 'orders' },
      { front: '/api/bill', to: '/bill', service: 'billing-service', file: 'src/main/resources/application.yml', id: 'billing' },
    ],
  }), { root: '/p/app', manifestDir: '/p/app/.cascade' });

  assert.deepEqual(profile.serviceNames, ['edge-service']);
  assert.deepEqual(profile.gatewayRoutes, {
    '/api/order': { to: '', service: 'orders-service', from: 'src/main/resources/application.yml' },
    '/api/bill': { to: '/bill', service: 'billing-service', from: 'src/main/resources/application.yml' },
  });
  assert.deepEqual(diagnostics, []);
  assert.doesNotThrow(() => validateProfile(profile));
});

test('a profile that already declares them keeps its own, and the run says what it did not apply', () => {
  const d = discovery({
    serviceNames: [{ name: 'edge-service', file: 'src/main/resources/application.yml' }],
    gatewayRoutes: [{ front: '/api/order', to: '', service: 'orders-service', file: 'src/main/resources/application.yml', id: 'orders' }],
  });
  const { profile, diagnostics } = buildProfile(d, {
    root: '/p/app',
    manifestDir: '/p/app/.cascade',
    existing: { serviceNames: ['my-own-name'], gatewayRoutes: { '/dev-api': '' } },
  });
  assert.deepEqual(profile.serviceNames, ['my-own-name']);
  assert.deepEqual(profile.gatewayRoutes, { '/dev-api': '' });
  assert.deepEqual(diagnostics.map((x) => x.kind).sort(), ['GATEWAY_ROUTES_KEPT', 'SERVICE_NAME_KEPT']);
  assert.match(diagnostics.find((x) => x.kind === 'GATEWAY_ROUTES_KEPT').reason, /were not applied: \/api\/order/);
  assert.match(diagnostics.find((x) => x.kind === 'SERVICE_NAME_KEPT').reason, /already names this project my-own-name/);
});

test('two routes claiming one prefix: the first is kept and the disagreement is reported', () => {
  const { profile, diagnostics } = buildProfile(discovery({
    gatewayRoutes: [
      { front: '/api/order', to: '', service: 'orders-service', file: 'a/application.yml', id: 'orders' },
      { front: '/api/order', to: '/inner', service: 'other-service', file: 'b/application.yml', id: 'other' },
    ],
  }), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.gatewayRoutes, {
    '/api/order': { to: '', service: 'orders-service', from: 'a/application.yml' },
  });
  const hit = diagnostics.find((x) => x.kind === 'AMBIGUOUS_GATEWAY_ROUTE');
  assert.ok(hit, JSON.stringify(diagnostics));
  assert.match(hit.reason, /the first one is kept/);
});

test('buildProfile leaves the catalog at "none" and reports the candidates when several DDL files exist', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({ ddlPaths: ['db/a.sql', 'db/b.sql'], counts: { ...discovery().counts, ddlFiles: 2 } }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.catalog, { source: 'none', connectionFrom: null, ddl: [], ddlAlternatives: {} });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, 'AMBIGUOUS_CATALOG_SOURCE');
  assert.match(diagnostics[0].reason, /db\/a\.sql, db\/b\.sql/);
});

// One schema shipped once per database vendor (RM55): the eGovFrame layout.
const vendorDdl = (vendor, name) => ({
  path: `DATABASE/${vendor}/${name}`, dialect: vendor, dialectFrom: 'path', role: 'schema',
  createTables: 30, alters: 0, dml: 0, byPath: false, testPath: false,
});

const SEVEN_VENDORS = {
  ddlPaths: ['DATABASE/mysql/all_ddl_mysql.sql', 'DATABASE/oracle/all_ddl_oracle.sql', 'DATABASE/tibero/all_ddl_tibero.sql'],
  ddlCandidates: [
    vendorDdl('mysql', 'all_ddl_mysql.sql'),
    vendorDdl('oracle', 'all_ddl_oracle.sql'),
    vendorDdl('tibero', 'all_ddl_tibero.sql'),
  ],
  ddlDialectHint: null,
  counts: { javaFiles: 3, springHandlerFiles: 1, mybatisMapperXml: 2, ddlFiles: 3, jpaEntityFiles: 0, kotlinFiles: 0, frontendPackageJson: 0 },
};

test('buildProfile picks the vendor the configuration NAMES, and records the rest as alternatives (RM55)', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      ...SEVEN_VENDORS,
      dbTypeDeclarations: [{ vendor: 'tibero', key: 'Globals.DbType', file: 'src/main/resources/globals.properties', line: 23 }],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.equal(profile.catalog.source, 'file');
  assert.deepEqual(profile.catalog.ddl, ['../DATABASE/tibero/all_ddl_tibero.sql']);
  assert.deepEqual(Object.keys(profile.catalog.ddlAlternatives).sort(), ['mysql', 'oracle']);
  // …and the lineage dialect follows the same choice.
  assert.deepEqual(profile.sqlDialects, { main: 'tibero' });
  const hit = diagnostics.find((d) => d.kind === 'CATALOG_VENDOR_CHOSEN');
  assert.ok(hit, JSON.stringify(diagnostics));
  assert.match(hit.reason, /ships its schema for 3 databases \(mysql, oracle, tibero\)/);
  assert.match(hit.reason, /Globals\.DbType in src\/main\/resources\/globals\.properties names it/);
  validateProfile(profile);
});

test('buildProfile with nothing naming the vendor keeps today\'s behaviour, and lists what it found (RM55)', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({ ...SEVEN_VENDORS }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.catalog, { source: 'none', connectionFrom: null, ddl: [], ddlAlternatives: {} });
  const hit = diagnostics.find((d) => d.kind === 'AMBIGUOUS_CATALOG_SOURCE');
  assert.ok(hit, JSON.stringify(diagnostics));
  assert.match(hit.reason, /one schema written for 3 databases \(mysql, oracle, tibero\)/);
  assert.match(hit.reason, /nothing in this tree says which database it runs on/);
});

test('buildProfile records the OpenAPI documents discovery found, manifest-relative and sorted', () => {
  const { profile } = buildProfile(
    discovery({ openapiDocuments: [{ path: 'api/openapi.yaml', version: '3' }, { path: 'api/legacy.json', version: '2' }] }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.openapi.documents, ['../api/legacy.json', '../api/openapi.yaml']);
  validateProfile(profile);
});

test('buildProfile leaves openapi.documents empty when the tree ships no document', () => {
  const { profile } = buildProfile(discovery(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.openapi.documents, []);
});

test('buildProfile omits framework packs and dialects it did not see', () => {
  const { profile } = buildProfile(
    discovery({ counts: { javaFiles: 1, springHandlerFiles: 0, mybatisMapperXml: 0, ddlFiles: 0 }, ddlPaths: [], ddlDialectHint: null, buildTool: null, packagePrefixes: [] }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.frameworkPacks, []);
  assert.deepEqual(profile.sqlDialects, {});
  assert.equal(profile.build.tool, null);
  assert.deepEqual(profile.catalog, { source: 'none', connectionFrom: null, ddl: [], ddlAlternatives: {} });
});

// --- the connection-info half of the catalog decision (SPEC §12.1, §12.3) ---

const candidate = (over = {}) => ({
  path: 'src/main/resources/application.yml', kind: 'spring-yml',
  url: 'jdbc:mysql://db.example.com:3306/shop', host: 'db.example.com', port: 3306,
  database: 'shop', dialect: 'mysql', usernameRef: 'shop_app',
  passwordPresent: true, passwordRef: '<literal in file>', ...over,
});

test('buildProfile RECORDS a single connection candidate but never turns the source on', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      ddlPaths: [], counts: { ...discovery().counts, ddlFiles: 0 },
      connectionCandidates: [candidate()],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  // The path is recorded; the SOURCE stays "none". Switching it on would mean
  // the tool decided by itself to connect to a host named by the analyzed
  // repository — which is untrusted input (SPEC §12.3, §17.5).
  assert.deepEqual(profile.catalog, {
    source: 'none', connectionFrom: '../src/main/resources/application.yml', ddl: [], ddlAlternatives: {},
  });
  validateProfile(profile);
  const hit = diagnostics.find((d) => d.kind === 'CATALOG_CONNECTION_FOUND');
  assert.ok(hit, 'the find must be reported');
  assert.match(hit.reason, /mysql at db\.example\.com:3306\/shop/);
  assert.match(hit.reason, /cascade catalog fetch --candidate 1/);
  assert.match(hit.reason, /Nothing connects until you do/);
  assert.equal(JSON.stringify(diagnostics).includes('<literal in file>'), false,
    'the diagnostic states THAT a password is there, not where its text sits');
});

test('buildProfile prefers a DDL file over a connection candidate', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({ connectionCandidates: [candidate()] }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.catalog, { source: 'file', connectionFrom: '../db/schema.sql', ddl: [], ddlAlternatives: {} });
  assert.equal(diagnostics.find((d) => d.kind === 'CATALOG_CONNECTION_FOUND'), undefined);
});

test('buildProfile records NOTHING when several files carry connection info', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      ddlPaths: [], counts: { ...discovery().counts, ddlFiles: 0 },
      connectionCandidates: [candidate(), candidate({ path: 'b/application-prod.yml' })],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.catalog, { source: 'none', connectionFrom: null, ddl: [], ddlAlternatives: {} });
  const hit = diagnostics.find((d) => d.kind === 'AMBIGUOUS_CATALOG_SOURCE');
  assert.ok(hit);
  assert.match(hit.reason, /2 files carry datasource connection info/);
  assert.match(hit.reason, /cascade catalog discover/);
});

test('writeInitFiles keeps existing files unless forced', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'manifest.json');
  const profilePath = path.join(dir, 'profile.json');

  const first = writeInitFiles({ manifestPath, profilePath, manifest: { a: 1 }, profile: { b: 1 } });
  assert.deepEqual(first, { written: [manifestPath, profilePath], kept: [] });

  const second = writeInitFiles({ manifestPath, profilePath, manifest: { a: 2 }, profile: { b: 2 } });
  assert.deepEqual(second, { written: [], kept: [manifestPath, profilePath] });
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).a, 1, 'the existing file must not be overwritten');

  const forced = writeInitFiles({ manifestPath, profilePath, manifest: { a: 3 }, profile: { b: 3 }, force: true });
  assert.deepEqual(forced, { written: [manifestPath, profilePath], kept: [] });
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).a, 3);
});

// ---------------------------------------------------------------------------
// Integration: the real CLI over two independent projects
// ---------------------------------------------------------------------------

// A tmp dir under its REAL path: on macOS os.tmpdir() is a symlink (/var ->
// /private/var), and the registry stores the resolved directory.
function tmpDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  return git('rev-parse', 'HEAD').toString('utf8').trim();
}

const JAVA_CONTROLLER = `package com.example.web;
@RestController
public class UserController { @GetMapping("/u") public String u() { return "u"; } }
`;
const MAPPER_XML = '<mapper namespace="com.example.web.UserMapper"><select id="u">select 1</select></mapper>\n';
const DDL = 'CREATE TABLE `users` (`id` bigint NOT NULL) ENGINE=InnoDB;\n';

function runInit(args, env) {
  return execFileSync(process.execPath, [CLI, 'init', ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString('utf8');
}

test('cascade init: two projects, two .cascade dirs, one registry with both — and the pack is gitignored', (t) => {
  const base = tmpDir(t, 'cascade-init-cli-');
  const home = path.join(base, 'home');

  const zuluDir = path.join(base, 'zulu');
  const alphaDir = path.join(base, 'alpha');
  const zuluHead = gitRepo(zuluDir, {
    'pom.xml': '<project/>',
    'src/main/java/com/example/web/UserController.java': JAVA_CONTROLLER,
    'src/main/resources/mapper/UserMapper.xml': MAPPER_XML,
    'db/schema.sql': DDL,
  });
  const alphaHead = gitRepo(alphaDir, {
    'build.gradle': 'plugins {}',
    'src/main/java/com/example/svc/Svc.java': 'package com.example.svc;\npublic class Svc {}\n',
  });

  const out = runInit(['--root', zuluDir, '--json'], { CASCADE_HOME: home });
  const report = JSON.parse(out);
  assert.equal(report.schema, 'cascade:init-report:1');
  assert.equal(report.project, 'zulu');
  assert.deepEqual(report.lanes, ['sql', 'java']);
  assert.equal(report.discovery.repos[0].commit, zuluHead);
  assert.equal(report.discovery.counts.springHandlerFiles, 1);
  assert.equal(report.discovery.counts.mybatisMapperXml, 1);
  assert.equal(report.written.length, 2);
  assert.deepEqual(report.kept, []);
  assert.equal(report.registry, path.join(home, 'registry.json'));

  runInit(['--root', alphaDir], { CASCADE_HOME: home });

  // Two separate durable tiers, no cross-talk.
  for (const [dir, head, tool] of [[zuluDir, zuluHead, 'maven'], [alphaDir, alphaHead, 'gradle']]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'manifest.json'), 'utf8'));
    assert.equal(manifest.repositories.length, 1);
    assert.equal(manifest.repositories[0].commit, head);
    assert.equal(manifest.repositories[0].path, '..');
    const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
    assert.equal(profile.build.tool, tool);
    assert.doesNotThrow(() => validateProfile(profile));
    // The pack carries the user's SQL: it MUST be ignored by git (SPEC §5.1/§17.1).
    const code = execFileSync('git', ['-C', dir, 'check-ignore', '.cascade/pack/pack.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(code.toString('utf8'), /\.cascade\/pack\/pack\.json/);
  }

  // One registry, both projects, sorted by id.
  const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(reg.schema, 'cascade:registry:1');
  assert.deepEqual(reg.projects.map((p) => p.id), ['alpha', 'zulu']);
  assert.deepEqual(reg.projects.map((p) => p.dotCascadePath), [path.join(alphaDir, '.cascade'), path.join(zuluDir, '.cascade')]);
  assert.deepEqual(reg.projects.map((p) => p.source), ['init', 'init']);
  assert.deepEqual(reg.projects.find((p) => p.id === 'zulu').stack, ['sql', 'java']);
  assert.deepEqual(reg.projects.find((p) => p.id === 'alpha').stack, ['java']);
  assert.equal(reg.projects[0].lastCertifiedAt, null);
});

test('cascade init: a second run keeps hand-edited files unless --force', (t) => {
  const base = tmpDir(t, 'cascade-init-keep-');
  const home = path.join(base, 'home');
  const dir = path.join(base, 'app');
  gitRepo(dir, { 'src/A.java': 'package com.example.a;\npublic class A {}\n' });

  runInit(['--root', dir], { CASCADE_HOME: home });
  const profilePath = path.join(dir, '.cascade', 'profile.json');
  const edited = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  edited.packagePrefixes = ['com.example.handwritten'];
  fs.writeFileSync(profilePath, JSON.stringify(edited, null, 2));

  const second = JSON.parse(runInit(['--root', dir, '--json'], { CASCADE_HOME: home }));
  assert.deepEqual(second.written, []);
  assert.equal(second.kept.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, 'utf8')).packagePrefixes, ['com.example.handwritten']);

  const third = JSON.parse(runInit(['--root', dir, '--json', '--force'], { CASCADE_HOME: home }));
  assert.equal(third.written.length, 2);
  assert.deepEqual(third.kept, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(profilePath, 'utf8')).packagePrefixes, ['com.example.a']);
});

test('cascade init: --project sets the id, and a second directory claiming it is refused without --force', (t) => {
  const base = tmpDir(t, 'cascade-init-clash-');
  const home = path.join(base, 'home');
  const one = path.join(base, 'one');
  const two = path.join(base, 'two');
  gitRepo(one, { 'a.txt': 'a' });
  gitRepo(two, { 'b.txt': 'b' });

  runInit(['--root', one, '--project', 'shared'], { CASCADE_HOME: home });
  assert.throws(
    () => runInit(['--root', two, '--project', 'shared'], { CASCADE_HOME: home }),
    (e) => {
      assert.match(e.stderr.toString('utf8'), /ambiguous project id "shared"/);
      return true;
    },
  );
  let reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(reg.projects[0].dotCascadePath, path.join(one, '.cascade'));

  runInit(['--root', two, '--project', 'shared', '--force'], { CASCADE_HOME: home });
  reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.length, 1);
  assert.equal(reg.projects[0].dotCascadePath, path.join(two, '.cascade'));
});

test('cascade init: the same directory reached through a symlink is the SAME project, not a clash', (t) => {
  const base = tmpDir(t, 'cascade-init-link-');
  const home = path.join(base, 'home');
  const real = path.join(base, 'app');
  const link = path.join(base, 'link-to-app');
  gitRepo(real, { 'src/A.java': 'package com.example.a;\npublic class A {}\n' });
  fs.symlinkSync(real, link, 'dir');

  runInit(['--root', real, '--project', 'app'], { CASCADE_HOME: home });
  // Same directory, different spelling: this must UPDATE the entry. Comparing
  // the two spellings textually would report a false "ambiguous project id".
  runInit(['--root', link, '--project', 'app'], { CASCADE_HOME: home });

  const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.length, 1, JSON.stringify(reg.projects, null, 2));
  assert.equal(reg.projects[0].dotCascadePath, fs.realpathSync(path.join(real, '.cascade')));
});

test('cascade init: a tree with no git repository fails with an explanation and writes nothing', (t) => {
  const base = tmpDir(t, 'cascade-init-nogit-');
  const dir = path.join(base, 'plain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');

  assert.throws(
    () => runInit(['--root', dir], { CASCADE_HOME: path.join(base, 'home') }),
    (e) => {
      assert.match(e.stderr.toString('utf8'), /no git repository with a HEAD commit/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(dir, '.cascade')), false, 'nothing is written when identity cannot be established');
});

test('cascade init: unsupported technologies reach the report as diagnostics', (t) => {
  const base = tmpDir(t, 'cascade-init-diag-');
  const dir = path.join(base, 'poly');
  gitRepo(dir, {
    'src/Main.kt': 'package com.example\nfun main() {}\n',
    'web/package.json': JSON.stringify({ dependencies: { react: '18.0.0' } }),
    'db/a.sql': DDL,
    'db/b.sql': DDL,
  });
  const report = JSON.parse(runInit(['--root', dir, '--json'], { CASCADE_HOME: path.join(base, 'home') }));
  const kinds = report.discovery.diagnostics.map((d) => d.kind).sort();
  // Kotlin is still uncovered. The React package is NOT: RM26 ships the lane
  // that reads it, and what the lane does not do is stated on the `web` axis.
  assert.deepEqual(kinds, ['AMBIGUOUS_CATALOG_SOURCE', 'UNSUPPORTED_TECHNOLOGY']);
  const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(profile.catalog, { source: 'none', connectionFrom: null, ddl: [], ddlAlternatives: {} });
});

test('cascade init: a frontend package declares the web pack, plus the router pack its deps name', (t) => {
  const base = tmpDir(t, 'cascade-init-web-');
  const dir = path.join(base, 'shop');
  gitRepo(dir, {
    'src/main/java/com/example/A.java': 'package com.example;\n@RestController\npublic class A {}\n',
    'front/package.json': JSON.stringify({ dependencies: { vue: '3.0.0', 'vue-router': '4.0.0', axios: '1.0.0' } }),
    'front/src/api/thing.js': "import client from '@/utils/http'\nexport function listThings() { return client({ url: '/things' }) }\n",
    'admin/package.json': JSON.stringify({ dependencies: { react: '18.0.0', 'react-router-dom': '6.0.0' } }),
    'admin/src/App.jsx': 'export default function App() { return null }\n',
  });
  const report = JSON.parse(runInit(['--root', dir, '--json'], { CASCADE_HOME: path.join(base, 'home') }));
  const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(profile.frameworkPacks, ['spring-mvc', 'web', 'vue-router', 'react-router']);
  // A ROUTER PACK IS THE SCREEN AXIS SWITCH: the packs are what let the worker
  // recognize a route object at all, so a project that uses one has screens to
  // build and `init` writes the gate on rather than leaving it to be found.
  // This is the one case where `init` states a value at all.
  assert.equal(profile.screenAxis.enabled, true);
  assert.ok(report.lanes.includes('web'), JSON.stringify(report.lanes));
  // The manifest still calls the repo backend-java: it holds java sources, and
  // the `kind` rule is unchanged by the web lane.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'manifest.json'), 'utf8'));
  assert.equal(manifest.repositories[0].kind, 'backend-java');
});

test('cascade init: a frontend with no router dependency declares web and no router pack', (t) => {
  const base = tmpDir(t, 'cascade-init-web-norouter-');
  const dir = path.join(base, 'plainfront');
  gitRepo(dir, {
    'package.json': JSON.stringify({ dependencies: { svelte: '4.0.0' } }),
    'src/main.js': "fetch('/health')\n",
  });
  const profileText = (() => {
    runInit(['--root', dir], { CASCADE_HOME: path.join(base, 'home') });
    return fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8');
  })();
  assert.deepEqual(JSON.parse(profileText).frameworkPacks, ['web']);
  // No router pack in this tree, so `init` writes no word either way and leaves
  // the third state: a run over this tree alone finds no router and builds no
  // screen, and a run that is later pointed at a frontend that does have one
  // builds them without anybody editing the profile.
  assert.equal(JSON.parse(profileText).screenAxis.enabled, null);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'manifest.json'), 'utf8'));
  assert.equal(manifest.repositories[0].kind, 'frontend-web');
});

test('cascade init: the profile gets the service name and the gateway table, and says both out loud', (t) => {
  const base = tmpDir(t, 'cascade-init-gateway-');
  const dir = path.join(base, 'edge');
  gitRepo(dir, {
    'pom.xml': '<project/>',
    'src/main/java/com/example/web/A.java': 'package com.example.web;\n@RestController\npublic class A {}\n',
    'src/main/resources/application.yml': [
      'spring:',
      '  application:',
      '    name: edge-service',
      '  cloud:',
      '    gateway:',
      '      routes:',
      '        - id: orders',
      '          uri: lb://orders-service',
      '          predicates:',
      '            - Path=/api/order/**',
      '          filters:',
      '            - StripPrefix=2',
      '',
    ].join('\n'),
  });
  const run = spawnSync(process.execPath, [CLI, 'init', '--root', dir], {
    env: { ...process.env, CASCADE_HOME: path.join(base, 'home') },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /service name: edge-service \(from src\/main\/resources\/application\.yml\)/);
  assert.match(run.stderr, /gateway routes: 1 read from src\/main\/resources\/application\.yml/);
  assert.match(run.stderr, /\/api\/order -> \/ at orders-service/);

  const profile = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(profile.serviceNames, ['edge-service']);
  assert.deepEqual(profile.gatewayRoutes, {
    '/api/order': { to: '', service: 'orders-service', from: 'src/main/resources/application.yml' },
  });

  // A SECOND RUN with --force does not overwrite a map the user has since
  // edited: the profile on disk is read first, and a non-empty one is theirs.
  const edited = { ...profile, gatewayRoutes: { '/api/order': '/mine' }, serviceNames: ['my-own-name'] };
  fs.writeFileSync(path.join(dir, '.cascade', 'profile.json'), JSON.stringify(edited, null, 2) + '\n');
  const again = spawnSync(process.execPath, [CLI, 'init', '--root', dir, '--force'], {
    env: { ...process.env, CASCADE_HOME: path.join(base, 'home') },
    encoding: 'utf8',
  });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /the profile already declares its own, so these were not applied/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, '.cascade', 'profile.json'), 'utf8'));
  assert.deepEqual(after.gatewayRoutes, { '/api/order': '/mine' });
  assert.deepEqual(after.serviceNames, ['my-own-name']);
});

// ---------------------------------------------------------------------------
// A frontend with no package manifest (RM47)
// ---------------------------------------------------------------------------

const vendored = (over = {}) => discovery({
  webVendoredRoots: [{ root: 'src/main/resources/static/scripts', files: 22, routerPacks: ['angular-router'] }],
  ...over,
});

test('lanesOf counts a frontend with no package as a web lane', () => {
  assert.ok(lanesOf(vendored()).includes('web'));
});

test('buildProfile writes the vendored root, the web pack and the router the SOURCE names', () => {
  const { profile, diagnostics } = buildProfile(vendored(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.webRoots, [{
    root: '../src/main/resources/static/scripts', kind: 'vendored', from: 'discovery',
  }], 'manifest-relative, like every other path in this file');
  assert.ok(profile.frameworkPacks.includes('web'));
  assert.ok(profile.frameworkPacks.includes('angular-router'),
    'no dependency list names the framework, so the registrar the source writes is what does');
  assert.equal(profile.screenAxis.enabled, true, 'a router pack IS the screen axis switch');
  assert.deepEqual(diagnostics.filter((d) => d.kind === 'WEB_ROOTS_KEPT'), []);
});

test('a webRoots list already in the profile is the user\'s, including an empty one', () => {
  const kept = buildProfile(vendored(), {
    root: '/p/app', manifestDir: '/p/app/.cascade', existing: { webRoots: [] },
  });
  assert.deepEqual(kept.profile.webRoots, [], 'an empty list is how a project says "read none of them"');
  const d = kept.diagnostics.find((x) => x.kind === 'WEB_ROOTS_KEPT');
  assert.ok(d, JSON.stringify(kept.diagnostics));
  assert.match(d.reason, /src\/main\/resources\/static\/scripts/);

  const mine = buildProfile(vendored(), {
    root: '/p/app', manifestDir: '/p/app/.cascade', existing: { webRoots: [{ root: '../legacy/js', kind: 'declared' }] },
  });
  assert.deepEqual(mine.profile.webRoots, [{ root: '../legacy/js', kind: 'declared' }]);
});

// ---------------------------------------------------------------------------
// A server-rendered application: where a view name becomes a page (RM48)
// ---------------------------------------------------------------------------

const withTemplates = (over = {}) => discovery({
  templateRoots: [
    { root: 'src/main/resources/templates', engine: 'thymeleaf', suffix: '.html', from: 'default', files: 12 },
  ],
  ...over,
});

test('buildProfile writes the template roots, manifest-relative, with the engine and the suffix', () => {
  const { profile, diagnostics } = buildProfile(withTemplates(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.templateRoots, [{
    root: '../src/main/resources/templates', engine: 'thymeleaf', suffix: '.html', from: 'default',
  }]);
  assert.deepEqual(diagnostics.filter((d) => d.kind === 'TEMPLATE_ROOTS_KEPT'), []);
});

test('a templateRoots list already in the profile is the user\'s, including an empty one', () => {
  const kept = buildProfile(withTemplates(), {
    root: '/p/app', manifestDir: '/p/app/.cascade', existing: { templateRoots: [] },
  });
  // ...and a list the user typed is kept as typed.
  const mine = buildProfile(withTemplates(), {
    root: '/p/app', manifestDir: '/p/app/.cascade',
    existing: { templateRoots: [{ root: '../views', engine: 'jsp', suffix: '.jsp' }] },
  });
  assert.deepEqual(mine.profile.templateRoots, [{ root: '../views', engine: 'jsp', suffix: '.jsp' }]);
  assert.deepEqual(kept.profile.templateRoots, [],
    'an empty list is how a project says "read no templates"');
  const d = kept.diagnostics.find((x) => x.kind === 'TEMPLATE_ROOTS_KEPT');
  assert.ok(d, JSON.stringify(kept.diagnostics));
  assert.match(d.reason, /src\/main\/resources\/templates \(thymeleaf\)/);
});

test('a tree with no template at all writes no templateRoots', () => {
  const { profile } = buildProfile(discovery(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.templateRoots, []);
});

test('a tree with neither a frontend package nor a vendored root declares no web pack', () => {
  const { profile } = buildProfile(discovery(), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.deepEqual(profile.webRoots, []);
  assert.equal(profile.frameworkPacks.includes('web'), false);
});

// --------------------------------------------------------------------------
// one mapper, shipped once per vendor (RM56)
// --------------------------------------------------------------------------

const vendorMappers = (base, namespace, vendors) => vendors.map((v) => ({
  path: `src/main/resources/mapper/${base}_SQL_${v}.xml`, kind: 'mapper', namespace,
}));

test('buildProfile leaves the other vendors\' mapper copies out, by name and by vendor (RM56)', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      ...SEVEN_VENDORS,
      dbTypeDeclarations: [{ vendor: 'tibero', key: 'Globals.DbType', file: 'src/main/resources/globals.properties', line: 23 }],
      mapperFiles: [
        ...vendorMappers('EgovProgrmManage', 'progrmManageDAO', ['mysql', 'oracle', 'tibero']),
        // A mapper this tree ships once needs no choosing.
        { path: 'src/main/resources/mapper/EgovCmmn.xml', kind: 'mapper', namespace: 'cmmnDAO' },
      ],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.mappers.alternatives, {
    mysql: ['../src/main/resources/mapper/EgovProgrmManage_SQL_mysql.xml'],
    oracle: ['../src/main/resources/mapper/EgovProgrmManage_SQL_oracle.xml'],
  }, 'the tibero copy is the one this project runs, so it is not on this list');
  const hit = diagnostics.find((d) => d.kind === 'MAPPER_VENDOR_CHOSEN');
  assert.ok(hit, JSON.stringify(diagnostics));
  assert.match(hit.reason, /1 mapper\(s\) here are shipped once per database vendor/);
  assert.match(hit.reason, /1 copy\(ies\) are read and 2 are recorded as mappers\.alternatives/);
  validateProfile(profile);
});

test('buildProfile says so when no copy is for the vendor this project runs (RM56)', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      ...SEVEN_VENDORS,
      dbTypeDeclarations: [{ vendor: 'tibero', key: 'Globals.DbType', file: 'globals.properties', line: 1 }],
      mapperFiles: vendorMappers('EgovProgrmManage', 'progrmManageDAO', ['mysql', 'oracle']),
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  // The statements are still read, from the first copy by path.
  assert.deepEqual(profile.mappers.alternatives, {
    oracle: ['../src/main/resources/mapper/EgovProgrmManage_SQL_oracle.xml'],
  });
  const hit = diagnostics.find((d) => d.kind === 'MAPPER_VENDOR_UNMATCHED');
  assert.ok(hit, JSON.stringify(diagnostics));
  assert.equal(hit.severity, 'warn');
  assert.match(hit.reason, /shipped for mysql, oracle and none of those is tibero/);
  assert.match(hit.reason, /namespace progrmManageDAO/);
});

test('buildProfile: a tree that ships one copy of each mapper writes nothing down (RM56)', () => {
  const { profile, diagnostics } = buildProfile(
    discovery({
      mapperFiles: [{ path: 'src/main/resources/mapper/EgovCmmn.xml', kind: 'mapper', namespace: 'cmmnDAO' }],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.mappers, { alternatives: {} });
  assert.equal(diagnostics.find((d) => String(d.kind).startsWith('MAPPER_VENDOR')), undefined);
});

test('buildProfile: a profile that already answers for mappers.alternatives is left alone (RM56)', () => {
  const existing = { mappers: { alternatives: { oracle: ['../keep/me.xml'] } } };
  const { profile, diagnostics } = buildProfile(
    discovery({
      ...SEVEN_VENDORS,
      dbTypeDeclarations: [{ vendor: 'tibero', key: 'Globals.DbType', file: 'globals.properties', line: 1 }],
      mapperFiles: vendorMappers('EgovProgrmManage', 'progrmManageDAO', ['mysql', 'oracle', 'tibero']),
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade', existing },
  );
  assert.deepEqual(profile.mappers.alternatives, { oracle: ['../keep/me.xml'] });
  assert.ok(diagnostics.find((d) => d.kind === 'MAPPER_ALTERNATIVES_KEPT'), JSON.stringify(diagnostics));
});

test('buildProfile: an iBATIS sqlMap tree declares the statement lane like a MyBatis one (RM56)', () => {
  const { profile } = buildProfile(
    discovery({
      counts: {
        javaFiles: 3, springHandlerFiles: 1, mybatisMapperXml: 0, ibatisSqlMapXml: 4,
        ddlFiles: 0, jpaEntityFiles: 0, kotlinFiles: 0, frontendPackageJson: 0,
      },
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.ok(profile.frameworkPacks.includes('mybatis-xml'),
    'one lane reads both elements, so one pack declares it');
});

test('buildProfile: a directory of Nexacro forms is a web root of its own kind (RM56)', () => {
  const { profile } = buildProfile(
    discovery({
      counts: { javaFiles: 3, springHandlerFiles: 1, mybatisMapperXml: 0, ddlFiles: 0, jpaEntityFiles: 0, kotlinFiles: 0, frontendPackageJson: 0 },
      webVendoredRoots: [{ root: 'src/main/nxui', files: 30, forms: 30, routerPacks: ['nexacro'], kind: 'nexacro' }],
    }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' },
  );
  assert.deepEqual(profile.webRoots, [{ root: '../src/main/nxui', kind: 'nexacro', from: 'discovery' }]);
  assert.ok(profile.frameworkPacks.includes('nexacro'));
  assert.equal(profile.screenAxis.enabled, true, 'a client made of screens turns the screen axis on');
  validateProfile(profile);
});
