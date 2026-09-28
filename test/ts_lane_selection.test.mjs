import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectLanes } from '../src/core/lanes.mjs';
import { normalizeProfile, validateProfile, profileDiagnostics, ProfileError, digestedProfile } from '../src/core/profile.mjs';
import { sha256, canonicalJson } from '../src/core/canonical.mjs';
import { discover } from '../src/core/discover.mjs';
import { buildProfile, lanesOf } from '../src/core/init.mjs';
import { planIncremental } from '../src/core/invalidate.mjs';
import { emptyIndex } from '../src/core/facts_store.mjs';
import { CHANGESET_SCHEMA } from '../src/core/changeset.mjs';
import { isEngineSourcePath, pinOf, profileDigestOf } from '../src/core/calibration.mjs';

// Where the TypeScript backend lane is CHOSEN: the flag, the profile, what
// `cascade init` writes into the profile from what discovery finds, and the
// two places another lane must now step around it (the web worker's walk and
// the incremental plan).

const ROOT = path.resolve('/tmp/project');
const DOT = path.join(ROOT, '.cascade');
const WEB_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'web', 'webfacts.mjs');

const select = (flags, profile = {}) => {
  const diagnostics = [];
  const r = selectLanes({ flags, profile: normalizeProfile(profile), root: ROOT, cwd: ROOT, manifestDir: DOT, diagnostics });
  return { ...r, diagnostics: [...(r.diagnostics ?? []), ...diagnostics] };
};

// ---------------------------------------------------------------------------
// selectLanes
// ---------------------------------------------------------------------------

test('--ts-src names the application for one run, whatever the profile says', () => {
  const r = select({ tsSrc: ['api/src'] }, { frameworkPacks: ['nestjs'], tsBackend: { app: '../other' } });
  assert.deepEqual(r.tsSrc, [path.join(ROOT, 'api/src')]);
  assert.equal(r.sources.tsSrc, 'flag');
  assert.ok(r.lanes.includes('ts'));
});

test('with no flag, the nestjs pack lets the profile\'s tsBackend.app in, manifest-relative', () => {
  const r = select({}, { frameworkPacks: ['nestjs'], tsBackend: { app: '../apps/api/src' } });
  assert.deepEqual(r.tsSrc, [path.join(ROOT, 'apps/api/src')]);
  assert.equal(r.sources.tsSrc, 'profile');
});

test('tsBackend.app without the nestjs pack reads nothing, and the profile says so', () => {
  const r = select({}, { tsBackend: { app: '../apps/api/src' } });
  assert.deepEqual(r.tsSrc, []);
  assert.equal(r.lanes.includes('ts'), false);
  const said = profileDiagnostics(normalizeProfile({ tsBackend: { app: '../apps/api/src' } }));
  assert.ok(said.some((d) => d.kind === 'RECORDED_NOT_ACTED' && d.key === 'tsBackend.app'), JSON.stringify(said));
});

test('the nestjs pack with no application named is a MISSING_INPUT, not a silent skip', () => {
  const r = select({}, { frameworkPacks: ['nestjs'] });
  assert.deepEqual(r.tsSrc, []);
  assert.ok(r.diagnostics.some((d) => d.kind === 'MISSING_INPUT' && d.key === 'tsBackend'), JSON.stringify(r.diagnostics));
});

test('two roots named read the first alone, because one pack holds one application', () => {
  const r = select({ tsSrc: ['a/src', 'b/src'] });
  assert.deepEqual(r.tsSrc, [path.join(ROOT, 'a/src')]);
  const d = r.diagnostics.find((x) => x.kind === 'TS_ONE_APP');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.match(d.reason, /only .*a\/src is read/);
});

test('--no-ts switches the lane off even when the profile declares it', () => {
  const r = select({ noTs: true }, { frameworkPacks: ['nestjs'], tsBackend: { app: '../src' } });
  assert.deepEqual(r.tsSrc, []);
  assert.equal(r.sources.tsSrc, 'none');
});

// ---------------------------------------------------------------------------
// the profile
// ---------------------------------------------------------------------------

test('tsBackend defaults to nothing declared, and a wrong shape is refused with the key', () => {
  assert.deepEqual(normalizeProfile({}).tsBackend, { app: null, prismaSchema: null, globalPrefix: null, globalPrefixExclude: null, typeorm: { namingStrategy: null, entityPrefix: null, schema: null } });
  assert.throws(() => validateProfile({ tsBackend: { app: '' } }), (e) => e instanceof ProfileError && /tsBackend\.app/.test(e.message));
  assert.throws(() => validateProfile({ tsBackend: { prismaSchema: 3 } }), /tsBackend\.prismaSchema/);
  assert.throws(() => validateProfile({ tsBackend: { globalPrefix: false } }), /tsBackend\.globalPrefix/);
  // An empty prefix is a real answer: the application is served at the root.
  assert.doesNotThrow(() => validateProfile({ tsBackend: { app: '../src', globalPrefix: '' } }));
});

// ---------------------------------------------------------------------------
// discovery and init
// ---------------------------------------------------------------------------

function tree(t, files) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tsdisc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, 'utf8');
  }
  return root;
}

const realIo = {
  readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  gitHead: () => 'a'.repeat(40),
};

const NEST_PACKAGE = JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/common': '^10.0.0' } });
const BOOTSTRAP = "import { NestFactory } from '@nestjs/core';\nconst app = await NestFactory.create<Nest>(AppModule);\nawait app.listen(3000);\n";
const SCHEMA = 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id String @id\n}\n';

test('discovery finds a Nest application by the bootstrap the rule names, and the database its schema names', (t) => {
  const root = tree(t, {
    'package.json': NEST_PACKAGE,
    'src/main.ts': BOOTSTRAP,
    'src/app.module.ts': 'export class AppModule {}\n',
    // A test that boots the application is not the application.
    'test/app.e2e-spec.ts': BOOTSTRAP,
    'test/helpers/boot.ts': BOOTSTRAP,
    'prisma/schema.prisma': SCHEMA,
  });
  const d = discover(root, realIo);
  assert.deepEqual(d.nestApps, [{ root: 'src', bootstrap: 'src/main.ts', package: 'package.json', prismaSchema: null }]);
  assert.deepEqual(d.prismaSchemas, [{ path: 'prisma/schema.prisma', provider: 'postgresql' }]);
  assert.ok(lanesOf(d).includes('ts'));
});

test('a package that does not depend on @nestjs/core holds no Nest application, whatever its files call', (t) => {
  const root = tree(t, { 'package.json': JSON.stringify({ dependencies: { express: '4' } }), 'src/main.ts': BOOTSTRAP });
  assert.deepEqual(discover(root, realIo).nestApps, []);
});

test('the schema a package.json names under "prisma" travels with its application', (t) => {
  const root = tree(t, {
    'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '10' }, prisma: { schema: 'db/app.prisma' } }),
    'apps/api/src/main.ts': BOOTSTRAP,
  });
  assert.deepEqual(discover(root, realIo).nestApps.map((a) => [a.root, a.prismaSchema]), [['apps/api/src', 'db/app.prisma']]);
});

const initDiscovery = (over = {}) => ({
  root: '/p/app', repos: [{ path: '.', commit: 'a'.repeat(40), javaFiles: 0, frontendPackageJson: 0 }], counts: {},
  buildTool: null, packagePrefixes: [], ddlPaths: [], filesScanned: 3, capped: false, diagnostics: [], ...over,
});
const APP = { root: 'apps/api/src', bootstrap: 'apps/api/src/main.ts', package: 'package.json', prismaSchema: null };

test('init writes the one application it finds, the nestjs pack, and the dialect the Prisma schema names', () => {
  const { profile } = buildProfile(initDiscovery({ nestApps: [APP], prismaSchemas: [{ path: 'prisma/schema.prisma', provider: 'postgresql' }] }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.ok(profile.frameworkPacks.includes('nestjs'));
  assert.deepEqual(profile.tsBackend, { app: '../apps/api/src', prismaSchema: null, globalPrefix: null, globalPrefixExclude: null, typeorm: { namingStrategy: null, entityPrefix: null, schema: null } });
  assert.equal(profile.sqlDialects.main, 'postgresql');
});

test('init writes no application when it finds two, and says which it found', () => {
  const other = { ...APP, root: 'apps/admin/src', bootstrap: 'apps/admin/src/main.ts' };
  const { profile, diagnostics } = buildProfile(initDiscovery({ nestApps: [APP, other] }), { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.equal(profile.tsBackend.app, null);
  assert.ok(profile.frameworkPacks.includes('nestjs'), 'declared, so the analyze run asks which one');
  const said = diagnostics.find((d) => d.kind === 'TS_APPS_FOUND');
  assert.match(said.reason, /apps\/api\/src\/main\.ts, apps\/admin\/src\/main\.ts/);
});

test('an application the profile already names is kept whole, prefix and all', () => {
  const existing = { tsBackend: { app: '../server', prismaSchema: null, globalPrefix: 'api', globalPrefixExclude: ['health'] } };
  const { profile, diagnostics } = buildProfile(initDiscovery({ nestApps: [APP] }), { root: '/p/app', manifestDir: '/p/app/.cascade', existing });
  assert.deepEqual(profile.tsBackend, { ...existing.tsBackend, typeorm: { namingStrategy: null, entityPrefix: null, schema: null } }, 'kept, with a key it did not set at its default');
  assert.ok(diagnostics.some((d) => d.kind === 'TS_BACKEND_KEPT'));
});

test('a provider no profile dialect names (sqlite) is not written as one', () => {
  const { profile } = buildProfile(initDiscovery({ nestApps: [APP], prismaSchemas: [{ path: 'prisma/schema.prisma', provider: 'sqlite' }] }),
    { root: '/p/app', manifestDir: '/p/app/.cascade' });
  assert.equal(profile.sqlDialects.main, undefined);
});

// ---------------------------------------------------------------------------
// the other lanes step around it
// ---------------------------------------------------------------------------

test('the web worker leaves an --exclude-root out of its walk, and keeps the rest of the root', (t) => {
  const root = tree(t, {
    'package.json': JSON.stringify({ dependencies: { '@angular/core': '18' } }),
    'apps/web/src/api.ts': "export const f = () => fetch('/api/v1/users');\n",
    'apps/api/src/users.controller.ts': 'export class UsersController {}\n',
  });
  const out = execFileSync(process.execPath, [WEB_WORKER, '--root', root, '--exclude-root', path.join(root, 'apps/api/src'), root], { maxBuffer: 1 << 26 }).toString('utf8');
  const files = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'file').map((r) => r.file).sort();
  assert.deepEqual(files, ['apps/web/src/api.ts']);
});

test('the incremental plan does not hand the web lane a TypeScript backend file under its root', () => {
  const selection = { root: '/repo', javaRoots: [], mapperDirs: [], webRoots: ['.'], tsRoots: ['apps/api/src'], sqlArgs: [], packagePrefixes: [] };
  const workers = { java: 'javafacts/2' };
  const index = emptyIndex({ project: 'p', engineVersion: 'e/1', workers, root: '/repo', selection, base: { commit: 'base0', dirty: false, dirtyFiles: [] } });
  const changeset = {
    schema: CHANGESET_SCHEMA, repo: '/repo', status: 'OK', fromCommit: 'base0', toCommit: 'head1',
    files: [['M', 'apps/api/src/users.service.ts'], ['M', 'apps/web/src/api.ts']].map(([status, repoPath]) => ({ status, repoPath, srcPath: null })),
  };
  const p = planIncremental({ index, changeset, selection, workers, engineVersion: 'e/1' });
  assert.deepEqual(p.reparseWeb, ['apps/web/src/api.ts']);
});

test('the TypeScript worker is part of the engine print, so a change to it is an engine change', () => {
  assert.equal(isEngineSourcePath('adapters/ts/tsfacts.mjs'), true);
  assert.equal(isEngineSourcePath('adapters/ts/README.md'), false);
});

test('a project that never sets tsBackend keeps the profile digest it had before the block existed; setting it moves the digest', () => {
  const javaOnly = normalizeProfile({ frameworkPacks: ['spring-mvc'], sqlDialects: { main: 'mysql' } });
  const { tsBackend, ...withoutBlock } = javaOnly;
  assert.deepEqual(tsBackend, { app: null, prismaSchema: null, globalPrefix: null, globalPrefixExclude: null, typeorm: { namingStrategy: null, entityPrefix: null, schema: null } });
  assert.equal(profileDigestOf(javaOnly), profileDigestOf(withoutBlock), 'the block at its default is not part of the target');
  assert.notEqual(profileDigestOf(normalizeProfile({ tsBackend: { app: '../api' } })), profileDigestOf(normalizeProfile({})));
});

test('a project that set tsBackend before the typeorm block existed keeps its profile digest; declaring a part of it moves it', () => {
  const nest = normalizeProfile({ frameworkPacks: ['nestjs'], tsBackend: { app: 'src', globalPrefix: 'api' } });
  const { typeorm, ...before } = nest.tsBackend;
  assert.deepEqual(typeorm, { namingStrategy: null, entityPrefix: null, schema: null });
  assert.equal(profileDigestOf(nest), sha256(canonicalJson(digestedProfile({ ...nest, tsBackend: before }))), 'the digest the block had before the key');
  const declared = normalizeProfile({ frameworkPacks: ['nestjs'], tsBackend: { app: 'src', globalPrefix: 'api', typeorm: { entityPrefix: '' } } });
  assert.notEqual(profileDigestOf(declared), profileDigestOf(nest), 'a declared part is part of the target');
});

test('the TypeScript application read is part of the pinned target, and a run without one keeps the pin it had', () => {
  const base = { commit: 'a'.repeat(40), dirty: false, profileDigest: 'p', catalogDigest: null };
  const sel = { ddl: null, mapperDirs: [], javaRoots: ['src/main/java'] };
  assert.equal(pinOf({ ...base, selection: sel }).inputsDigest, pinOf({ ...base, selection: { ...sel, tsRoots: [] } }).inputsDigest);
  const a = pinOf({ ...base, selection: { ...sel, tsRoots: ['apps/a/src'] } });
  const b = pinOf({ ...base, selection: { ...sel, tsRoots: ['apps/b/src'] } });
  assert.notEqual(a.inputsDigest, b.inputsDigest, 'reading another application is another target (a REPIN), not nondeterminism');
  assert.notEqual(pinOf({ ...base, selection: sel, optOuts: ['--no-ts'] }).inputsDigest, pinOf({ ...base, selection: sel }).inputsDigest);
});
