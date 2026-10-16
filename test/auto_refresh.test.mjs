import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAutoRefresh, sourceFingerprint, sourceContentFingerprint, refreshArgv, runRefresh, rootLaneSources } from '../src/cli/auto_refresh.mjs';
import { handleRpc } from '../src/mcp/stdio.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { readTsconfigPaths, tsSupplementaryFiles, tsCandidateFiles } from '../src/cli/ts_inputs.mjs';
import { jpaNamingConfigured } from '../src/cli/commands/analyze/inputs.mjs';
import { findJdk } from '../src/cli/env.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packDir = path.join(root, '.cascade', 'pack'); fs.mkdirSync(packDir, { recursive: true });
  const entry = { id: 'sample', packDir, dotCascadePath: path.dirname(packDir) };
  const pack = { digest: 'first', meta: { builtAt: 'one', base: { repoPath: root }, analysis: { invocation: { noJava: true, noMappers: true, noDdl: true }, selection: {} } } };
  const write = () => fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(pack)); write();
  return { root, entry, pack, write };
}

function commitFixture(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
}

test('ignored Spring configuration beside an internal Java root changes the analyzer input and triggers refresh', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src/main/java'), { recursive: true });
  fs.mkdirSync(path.join(f.root, 'src/main/resources'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'src/main/java/A.java'), 'class A {}');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\nsrc/main/resources/application.properties\n');
  commitFixture(f.root);
  const config = path.join(f.root, 'src/main/resources/application.properties');
  const writeConfig = (name) => fs.writeFileSync(config, `spring.jpa.hibernate.naming.physical-strategy=org.hibernate.boot.model.naming.${name}\n`);
  writeConfig('PhysicalNamingStrategyStandardImpl');
  f.pack.meta.analysis = { invocation: { javaSrc: ['src/main/java'] }, selection: { javaRoots: ['src/main/java'] } }; f.write();
  let runs = 0;
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, validStructure: () => true, run: async () => { runs++; f.pack.meta.builtAt = String(runs); f.write(); } }); t.after(c.close);
  await c.ensureFresh(); const before = sourceFingerprint(f.entry, f.pack);
  const readBefore = jpaNamingConfigured([path.join(f.root, 'src/main/java')], f.root);
  writeConfig('CamelCaseToUnderscoresNamingStrategy');
  assert.notDeepEqual(jpaNamingConfigured([path.join(f.root, 'src/main/java')], f.root), readBefore);
  assert.notEqual(sourceFingerprint(f.entry, f.pack), before); await c.ensureFresh(); assert.equal(runs, 2);
  f.pack.meta.analysis.invocation.noJava = true;
  const disabled = sourceFingerprint(f.entry, f.pack); writeConfig('PhysicalNamingStrategyStandardImpl');
  assert.equal(sourceFingerprint(f.entry, f.pack), disabled);
});

test('ignored TS config extends chain and Prisma schema above the app are inventoried by analyzer helpers', async (t) => {
  const f = fixture(t);
  for (const dir of ['api/src', 'config', 'prisma']) fs.mkdirSync(path.join(f.root, dir), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'api/src/a.ts'), 'export class A {}');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\ntsconfig.json\nconfig/\nprisma/\napi/prisma/\n');
  commitFixture(f.root);
  fs.writeFileSync(path.join(f.root, 'tsconfig.json'), '{"extends":"./config/base"}');
  const base = path.join(f.root, 'config/base.json');
  const writeBase = (target) => fs.writeFileSync(base, JSON.stringify({ compilerOptions: { paths: { '@lib/*': [target] } } }));
  writeBase('lib-a/*');
  const schema = path.join(f.root, 'prisma/schema.prisma'); fs.writeFileSync(schema, 'model Item { id Int @id }');
  const app = path.join(f.root, 'api/src');
  assert.ok(tsSupplementaryFiles(f.root, app).includes(base)); assert.ok(tsSupplementaryFiles(f.root, app).includes(schema));
  f.pack.meta.analysis = { invocation: { tsSrc: ['api/src'] }, selection: { tsRoots: ['api/src'] } }; f.write();
  let runs = 0;
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, validStructure: () => true, run: async () => { runs++; f.pack.meta.builtAt = String(runs); f.write(); } }); t.after(c.close);
  await c.ensureFresh(); const before = sourceFingerprint(f.entry, f.pack), readBefore = readTsconfigPaths(f.root, app);
  writeBase('lib-b/*');
  assert.notDeepEqual(readTsconfigPaths(f.root, app), readBefore);
  assert.notEqual(sourceFingerprint(f.entry, f.pack), before); await c.ensureFresh(); assert.equal(runs, 2);
  const schemaBefore = sourceFingerprint(f.entry, f.pack); fs.appendFileSync(schema, '\nmodel Other { id Int @id }');
  assert.notEqual(sourceFingerprint(f.entry, f.pack), schemaBefore); await c.ensureFresh(); assert.equal(runs, 3);
  f.pack.meta.laneStats = { ts: { prismaSchema: { path: 'prisma/schema.prisma' } } };
  const nearerBefore = sourceFingerprint(f.entry, f.pack);
  fs.mkdirSync(path.join(f.root, 'api/prisma'));
  const nearer = path.join(f.root, 'api/prisma/schema.prisma'); fs.writeFileSync(nearer, 'model Nearer { id Int @id }');
  assert.ok(tsSupplementaryFiles(f.root, app, schema).includes(nearer));
  assert.notEqual(sourceFingerprint(f.entry, f.pack), nearerBefore);
  f.write(); await c.ensureFresh(); assert.equal(runs, 4);
  f.pack.meta.analysis.invocation.noTs = true;
  const disabled = sourceFingerprint(f.entry, f.pack); writeBase('lib-c/*');
  assert.equal(sourceFingerprint(f.entry, f.pack), disabled);
});

test('real TS analysis refreshes a Git-ignored imported file outside the selected app root', async (t) => {
  const f = fixture(t), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-closure-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  for (const dir of ['api/src', 'lib']) fs.mkdirSync(path.join(f.root, dir), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\nlib/\n');
  fs.writeFileSync(path.join(f.root, 'api/src/a.ts'), "import { Shared } from '../../lib/shared'; export class A extends Shared {}");
  fs.writeFileSync(path.join(f.root, 'api/src/stable.ts'), 'export class Stable { a() {} b() {} c() {} d() {} e() {} f() {} g() {} h() {} }');
  const shared = path.join(f.root, 'lib/shared.ts'); fs.writeFileSync(shared, 'export class Shared { before() {} }');
  commitFixture(f.root);
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  execFileSync(process.execPath, [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--ts-src', path.join(f.root, 'api/src'), '--no-java', '--no-web', '--no-ddl', '--no-mappers', '--no-openapi'], { cwd: f.root, env, stdio: 'pipe' });
  const read = () => JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json'), 'utf8'));
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run: (entry, pack, options) => runRefresh(entry, pack, { ...options, env }) }); t.after(c.close);
  await c.ensureFresh(); const before = sourceFingerprint(f.entry, read());
  fs.writeFileSync(shared, 'export class Shared { after() {} }');
  assert.notEqual(sourceFingerprint(f.entry, read()), before); await c.ensureFresh();
  const structure = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'structure.json'), 'utf8'));
  assert.ok(structure.declarations.some((d) => d.file === 'lib/shared.ts' && d.name === 'after'));
  assert.equal(c.status('sample').verdict, 'current');
  fs.unlinkSync(shared); await c.ensureFresh();
  const missing = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'structure.json'), 'utf8'));
  assert.ok(!missing.files.some((file) => file.path === 'lib/shared.ts'));
  const missingFingerprint = sourceFingerprint(f.entry, read());
  fs.writeFileSync(shared, 'export class Shared { newlyAppeared() {} }');
  assert.notEqual(sourceFingerprint(f.entry, read()), missingFingerprint);
  await c.ensureFresh();
  const appeared = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'structure.json'), 'utf8'));
  assert.ok(appeared.declarations.some((d) => d.file === 'lib/shared.ts' && d.name === 'newlyAppeared'));
  assert.equal(c.status('sample').verdict, 'current');
});

test('TS candidate inventory follows resolver selection, excluding packages and outside symlinks', (t) => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const dir of ['lib', 'node_modules/pkg', 'dist']) fs.mkdirSync(path.join(f.root, dir), { recursive: true });
  for (const file of ['lib/a.ts', 'node_modules/pkg/a.ts', 'dist/a.ts', 'lib/types.d.ts']) fs.writeFileSync(path.join(f.root, file), 'export class A {}');
  fs.writeFileSync(path.join(outside, 'outside.ts'), 'export class Outside {}');
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(f.root, 'outside'));
    fs.symlinkSync(f.root, path.join(f.root, 'lib/loop'));
  }
  assert.deepEqual(tsCandidateFiles(f.root), [path.join(f.root, 'lib/a.ts')]);
});

test('ignored Java edit and newly added source use cold refresh; tracked Java retains incremental refresh', async (t) => {
  if (!findJdk()) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md; CI runs this on JDK 21'); return; }
  const f = fixture(t), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-java-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\nsrc/ignored/\n');
  const tracked = path.join(f.root, 'src/Tracked.java'); fs.writeFileSync(tracked, 'class Tracked { void initial() {} }');
  const hidden = path.join(f.root, 'src/Hidden.java'); fs.writeFileSync(hidden, 'class Hidden { void original() {} }');
  fs.mkdirSync(path.join(f.root, 'src/ignored'));
  const ignored = path.join(f.root, 'src/ignored/Ignored.java'); fs.writeFileSync(ignored, 'class Ignored { void before() {} }');
  commitFixture(f.root);
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  execFileSync(process.execPath, [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--java-src', path.join(f.root, 'src'), '--no-ts', '--no-web', '--no-ddl', '--no-mappers', '--no-openapi'], { cwd: f.root, env, stdio: 'pipe' });
  const read = () => JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json'), 'utf8'));
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run: (entry, pack, options) => runRefresh(entry, pack, { ...options, env }) }); t.after(c.close);
  await c.ensureFresh();
  fs.writeFileSync(tracked, 'class Tracked { void changed() {} }');
  assert.ok(refreshArgv(f.entry, read()).includes('--incremental')); await c.ensureFresh();
  execFileSync('git', ['-C', f.root, 'update-index', '--assume-unchanged', 'src/Hidden.java']);
  fs.writeFileSync(hidden, 'class Hidden { void concealed() {} }');
  assert.ok(refreshArgv(f.entry, read()).includes('--cold')); await c.ensureFresh();
  fs.writeFileSync(ignored, 'class Ignored { void after() {} }');
  assert.ok(refreshArgv(f.entry, read()).includes('--cold')); await c.ensureFresh();
  fs.writeFileSync(path.join(f.root, 'src/ignored/Added.java'), 'class Added { void added() {} }');
  assert.ok(refreshArgv(f.entry, read()).includes('--cold')); await c.ensureFresh();
  const structure = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'structure.json'), 'utf8'));
  assert.ok(structure.declarations.some((d) => d.name === 'after'));
  assert.ok(structure.declarations.some((d) => d.name === 'added'));
  assert.ok(structure.declarations.some((d) => d.name === 'changed'));
  assert.ok(structure.declarations.some((d) => d.name === 'concealed'));
  assert.ok(structure.files.every((file) => file.sha256));
  assert.equal(c.status('sample').verdict, 'current');
});

test('coalesces requests, rebuilds edits during a run, and reuses a pack-bound receipt after restart', async (t) => {
  const f = fixture(t); let digest = 'one', runs = 0;
  const cfg = { entries: [f.entry], intervalMs: 0, validStructure: () => true, fingerprint: () => digest, run: async () => {
    runs++; await new Promise((r) => setImmediate(r));
    if (runs === 1) digest = 'two';
    f.pack.meta.builtAt = String(runs); f.write();
  } };
  const c = createAutoRefresh(cfg); t.after(c.close);
  await Promise.all([c.ensureFresh(), c.ensureFresh()]);
  assert.equal(runs, 2); assert.equal(c.status('sample').verdict, 'current');
  await c.ensureFresh(); assert.equal(runs, 2);
  const restarted = createAutoRefresh(cfg); t.after(restarted.close);
  await restarted.ensureFresh(); assert.equal(runs, 2);
  f.pack.meta.builtAt = 'external build'; f.write();
  await restarted.ensureFresh(); assert.equal(runs, 3);
});

test('failed build remains behind, identical failure does not hot loop, changed inputs retry', async (t) => {
  const f = fixture(t); let runs = 0, digest = 'one';
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, validStructure: () => true, fingerprint: () => digest, run: async () => { runs++; throw new Error('gate rejected'); } }); t.after(c.close);
  await assert.rejects(c.ensureFresh(), /gate rejected/); await assert.rejects(c.ensureFresh(), /gate rejected/);
  assert.equal(runs, 1); assert.equal(c.status('sample').verdict, 'behind');
  digest = 'two'; await assert.rejects(c.ensureFresh()); assert.equal(runs, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json'))).digest, 'first');
});

test('disabled and detached source packs stay unknown without invoking analysis', async (t) => {
  const f = fixture(t); const run = () => { throw new Error('must not run'); };
  const disabled = createAutoRefresh({ entries: [f.entry], enabled: false, run }); t.after(disabled.close);
  await disabled.ensureFresh(); assert.equal(disabled.status('sample').verdict, 'unknown');
  f.pack.meta.base.repoPath = path.join(f.root, 'missing'); f.write();
  const detached = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run }); t.after(detached.close);
  await detached.ensureFresh(); assert.match(detached.status('sample').reason, /snapshot/);
});

test('fingerprints saved content, untracked files and HEAD; ignores generated pack state', (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'one'); git('add', 'a.txt'); git('commit', '-m', 'first');
  const first = sourceFingerprint(f.entry, f.pack);
  fs.writeFileSync(path.join(f.root, 'a.txt'), 'two'); const second = sourceFingerprint(f.entry, f.pack); assert.notEqual(first, second);
  fs.writeFileSync(path.join(f.entry.packDir, 'structure.json'), '{}'); assert.equal(second, sourceFingerprint(f.entry, f.pack));
  fs.writeFileSync(path.join(f.root, 'new.txt'), 'new'); assert.notEqual(second, sourceFingerprint(f.entry, f.pack));
  const beforeRename = sourceFingerprint(f.entry, f.pack);
  fs.renameSync(path.join(f.root, 'new.txt'), path.join(f.root, 'renamed.txt')); assert.notEqual(beforeRename, sourceFingerprint(f.entry, f.pack));
  const beforeDelete = sourceFingerprint(f.entry, f.pack); fs.unlinkSync(path.join(f.root, 'renamed.txt')); assert.notEqual(beforeDelete, sourceFingerprint(f.entry, f.pack));
  fs.writeFileSync(path.join(f.root, '.gitignore'), 'dist/\n'); fs.mkdirSync(path.join(f.root, 'dist'));
  const beforeOutput = sourceFingerprint(f.entry, f.pack); fs.writeFileSync(path.join(f.root, 'dist', 'generated.js'), 'output'); assert.equal(beforeOutput, sourceFingerprint(f.entry, f.pack));
  const beforeCommit = sourceFingerprint(f.entry, f.pack); git('add', '.'); git('commit', '-m', 'next'); assert.notEqual(beforeCommit, sourceFingerprint(f.entry, f.pack));
});

test('recorded lane opt-outs and custom profile are replayed without accepting a baseline', (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'custom.json'), '{}');
  f.pack.meta.analysis.invocation = { webSrc: ['front'], noJava: true, profile: 'custom.json' };
  const args = refreshArgv(f.entry, f.pack);
  assert.ok(args.includes('--no-java')); assert.ok(args.includes(path.join(f.root, 'front'))); assert.ok(args.includes(path.join(f.root, 'custom.json')));
  assert.ok(!args.includes('--accept-baseline'));
});

test('RPC and HTTP await async tools and preserve error contracts', async () => {
  const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview' } };
  const deps = { callTool: async () => ({ answer: 'fresh' }) };
  assert.match((await handleRpc(req, deps)).result.content[0].text, /fresh/);
  assert.deepEqual((await handleApi('POST', '/api/call', { name: 'overview' }, deps)).json, { answer: 'fresh' });
  const fail = { callTool: async () => { throw Object.assign(new Error('stale'), { code: 'refresh-failed' }); } };
  assert.equal((await handleRpc(req, fail)).result.isError, true);
  assert.equal((await handleApi('POST', '/api/call', { name: 'overview' }, fail)).status, 503);
});


test('real incremental analysis refreshes a saved source edit and reuses the result on restart', async (t) => {
  const f = fixture(t);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-cache-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\n');
  const api = path.join(f.root, 'api.json');
  const document = (route) => JSON.stringify({ openapi: '3.0.0', info: { title: 'test', version: '1' }, paths: { [route]: { get: { responses: { 200: { description: 'ok' } } } } } });
  fs.writeFileSync(api, document('/before')); git('add', '.'); git('commit', '-m', 'initial');
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  execFileSync(process.execPath, [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--no-java', '--no-web', '--no-mappers', '--no-ddl', '--no-ts', '--openapi', api], { env, stdio: 'pipe', timeout: 30000 });
  let runs = 0;
  const cfg = { entries: [f.entry], intervalMs: 0, run: async (entry, pack, options) => { runs++; await runRefresh(entry, pack, { ...options, env }); } };
  const coordinator = createAutoRefresh(cfg); t.after(coordinator.close);
  await coordinator.ensureFresh();
  const before = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json'))).digest;
  fs.writeFileSync(api, document('/after'));
  await coordinator.ensureFresh();
  const after = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json'))).digest;
  assert.notEqual(before, after); assert.equal(coordinator.status('sample').verdict, 'current');
  const savedRuns = runs;
  const restarted = createAutoRefresh(cfg); t.after(restarted.close);
  await restarted.ensureFresh(); assert.equal(runs, savedRuns);
});


test('close cancels pending work and never writes a successful receipt', async (t) => {
  const f = fixture(t);
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, fingerprint: () => 'x', run: async (_entry, _pack, { signal }) => {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  const pending = c.ensureFresh(); c.close();
  await assert.rejects(pending, /cancelled/);
  assert.equal(fs.existsSync(path.join(f.entry.packDir, 'refresh-state.json')), false);
});

test('async HTTP freshness barrier precedes direct metadata access', async () => {
  const order = [];
  const result = await handleApi('GET', '/api/meta', null, {
    ensureFresh: async () => { await new Promise((r) => setImmediate(r)); order.push('fresh'); },
    meta: () => { order.push('meta'); return { graph: 'new' }; },
  });
  assert.deepEqual(order, ['fresh', 'meta']); assert.equal(result.json.graph, 'new');
});

test('ignored package env and ignored source at a selected repository root invalidate freshness', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\n.env\nignored.js\ndist/\n');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"name":"test","devDependencies":{"vite":"*"}}');
  fs.writeFileSync(path.join(f.root, '.env'), 'VITE_API_URL=/api');
  fs.writeFileSync(path.join(f.root, 'src', 'app.js'), "fetch(import.meta.env.VITE_API_URL + '/before');");
  git('add', '.'); git('commit', '-m', 'initial');
  f.pack.meta.analysis.invocation.webSrc = ['src']; f.pack.meta.analysis.selection.webRoots = ['src']; f.write();
  let runs = 0;
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, validStructure: () => true, run: async () => { runs++; f.pack.meta.builtAt = String(runs); f.write(); } }); t.after(c.close);
  await c.ensureFresh(); const first = sourceFingerprint(f.entry, f.pack);
  fs.writeFileSync(path.join(f.root, '.env'), 'VITE_API_URL=/changed');
  assert.notEqual(first, sourceFingerprint(f.entry, f.pack)); await c.ensureFresh(); assert.equal(runs, 2);
  f.pack.meta.analysis.invocation.webSrc = ['.']; f.pack.meta.analysis.selection.webRoots = ['.']; f.write();
  fs.writeFileSync(path.join(f.root, 'ignored.js'), 'export function before() {}'); await c.ensureFresh(); const rootDigest = sourceFingerprint(f.entry, f.pack);
  fs.writeFileSync(path.join(f.root, 'ignored.js'), 'export function after() {}');
  assert.notEqual(rootDigest, sourceFingerprint(f.entry, f.pack)); await c.ensureFresh(); assert.equal(runs, 4);
  fs.mkdirSync(path.join(f.root, 'dist')); const preOutput = sourceFingerprint(f.entry, f.pack);
  fs.writeFileSync(path.join(f.root, 'dist', 'junk.js'), 'generated'); assert.equal(preOutput, sourceFingerprint(f.entry, f.pack));
});

test('stdio disconnect cancels an in-flight refresh before draining its response', async (t) => {
  const { PassThrough } = await import('node:stream');
  const { serve } = await import('../src/mcp/stdio.mjs');
  const f = fixture(t); let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, fingerprint: () => 'x', run: async (_entry, _pack, { signal }) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('disconnected')), { once: true }));
  } }); t.after(c.close);
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const pending = serve({ input, output, deps: { callTool: () => c.ensureFresh(), onDisconnect: c.close } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview' } }) + '\n');
  await ready; input.destroy(); await pending;
  assert.match(text, /disconnected/); assert.equal(c.status('sample').verdict, 'behind');
});

test('stdio EOF drains asynchronous answers before closing the refresh coordinator', async () => {
  const { PassThrough } = await import('node:stream');
  const { serve } = await import('../src/mcp/stdio.mjs');
  const input = new PassThrough(), output = new PassThrough(); let text = '', closed = false, release;
  const ready = new Promise((resolve) => { release = resolve; });
  output.on('data', (chunk) => { text += chunk; });
  const serving = serve({ input, output, deps: {
    callTool: async () => { await ready; assert.equal(closed, false); return { answer: 'ready' }; },
    onDisconnect: () => { closed = true; },
  } });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'overview' } }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false); release(); await serving;
  assert.equal(JSON.parse(JSON.parse(text).result.content[0].text).answer, 'ready');
  assert.equal(closed, true);
});

test('local queries refresh only their project while federation can refresh siblings', async () => {
  const { refreshProjectIds } = await import('../src/cli/serve.mjs');
  const host = { ids: () => ['healthy', 'broken'], resolveProjectArg: (args) => ({ projectId: args.project }) };
  assert.deepEqual(refreshProjectIds(host, 'code_search', { project: 'healthy' }), ['healthy']);
  assert.deepEqual(refreshProjectIds(host, 'flow', { project: 'healthy' }), ['healthy', 'broken']);
  assert.deepEqual(refreshProjectIds(host, 'flow', { project: 'healthy', federate: false }), ['healthy']);
  assert.deepEqual(refreshProjectIds(host, 'index_status', { project: 'broken' }), []);
});

test('background refresh continues to another project after a failed project', async (t) => {
  const a = fixture(t), b = fixture(t); b.entry.id = 'healthy';
  let healthy;
  const done = new Promise((resolve) => { healthy = resolve; });
  const c = createAutoRefresh({ entries: [a.entry, b.entry], intervalMs: 5, fingerprint: () => 'x', validStructure: () => true,
    run: async (entry) => { if (entry.id === 'sample') throw new Error('broken'); healthy(); } }); t.after(c.close);
  await Promise.race([done, new Promise((_r, reject) => setTimeout(() => reject(new Error('healthy project starved')), 500))]);
});

test('real web analysis refreshes ignored env and ignored sources selected by dot root', async (t) => {
  const f = fixture(t);
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-web-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\n.env\nignored.js\n');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"name":"test","devDependencies":{"vite":"*"}}');
  fs.writeFileSync(path.join(f.root, '.env'), 'VITE_API_URL=/before');
  fs.writeFileSync(path.join(f.root, 'ignored.js'), "export function load() { return fetch(import.meta.env.VITE_API_URL + '/items'); }");
  git('add', '.'); git('commit', '-m', 'initial');
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  execFileSync(process.execPath, [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--no-java', '--no-mappers', '--no-ddl', '--no-ts', '--no-openapi', '--web-src', f.root], { env, stdio: 'pipe', timeout: 30000 });
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run: (entry, pack, options) => runRefresh(entry, pack, { ...options, env }) }); t.after(c.close);
  await c.ensureFresh();
  const readPack = () => JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json')));
  const before = readPack().digest;
  fs.writeFileSync(path.join(f.root, '.env'), 'VITE_API_URL=/after'); await c.ensureFresh();
  assert.notEqual(before, readPack().digest, 'env changes update actual graph facts');
  const previousStructure = readPack().meta.structure.digest;
  fs.writeFileSync(path.join(f.root, 'ignored.js'), "export function renamed() { return fetch(import.meta.env.VITE_API_URL + '/items'); }"); await c.ensureFresh();
  assert.notEqual(previousStructure, readPack().meta.structure.digest); assert.equal(c.status('sample').verdict, 'current');
});


test('root TS and Java inventories include ignored public and target sources independently of web exclusions', async (t) => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', f.root, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\npublic/\ntarget/\n.hidden/\n');
  for (const dir of ['public', 'target', '.hidden']) fs.mkdirSync(path.join(f.root, dir));
  const tsFile = path.join(f.root, 'public', 'a.ts'), javaFile = path.join(f.root, 'target', 'A.java'), hiddenJava = path.join(f.root, '.hidden', 'B.java');
  fs.writeFileSync(tsFile, 'export class A {}'); fs.writeFileSync(javaFile, 'class A {}'); fs.writeFileSync(hiddenJava, 'class B {}');
  git('add', '.gitignore'); git('commit', '-m', 'initial');
  const analysis = { invocation: { tsSrc: ['.'], javaSrc: ['.'] }, selection: { tsRoots: ['.'], javaRoots: ['.'] } };
  f.pack.meta.analysis = analysis; f.write();
  const { sourceFiles } = await import('../adapters/ts/tsfacts.mjs');
  assert.ok(sourceFiles([f.root]).includes(tsFile), 'the actual TS worker reads public/a.ts');
  const inventory = rootLaneSources(f.root, analysis);
  assert.ok(inventory.includes(tsFile)); assert.ok(inventory.includes(javaFile)); assert.ok(inventory.includes(hiddenJava));
  let runs = 0;
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, validStructure: () => true, run: async () => { runs++; f.pack.meta.builtAt = String(runs); f.write(); } }); t.after(c.close);
  await c.ensureFresh();
  for (const file of [tsFile, javaFile, hiddenJava]) {
    const before = sourceFingerprint(f.entry, f.pack); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/class ([AB])/, 'class Changed$1'));
    assert.notEqual(before, sourceFingerprint(f.entry, f.pack)); await c.ensureFresh();
  }
  assert.equal(runs, 4); assert.equal(c.status('sample').verdict, 'current');
});


test('background checks default to 30 seconds while every request verifies content immediately', async (t) => {
  const f = fixture(t), scheduled = [], cleared = [];
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared.push(timer); });
  let reads = 0, runs = 0, digest = 'saved-one';
  const options = { entries: [f.entry], fingerprint: () => { reads++; return digest; }, validStructure: () => true, run: async () => { runs++; } };
  const c = createAutoRefresh(options); t.after(c.close);
  assert.equal(scheduled[0].delay, 30000); assert.equal(reads, 0);
  await c.ensureFresh(); assert.equal(runs, 1);
  const afterFirst = reads; await c.ensureFresh(); assert.equal(reads, afterFirst + 1);
  digest = 'saved-two'; await c.ensureFresh(); assert.equal(runs, 2);
  const beforePoll = reads; scheduled[0].callback(); await c.ensureFresh(); assert.equal(reads, beforePoll + 1);
  c.close(); assert.ok(cleared.includes(scheduled[0]));
  const afterClose = reads; scheduled[0].callback(); assert.equal(reads, afterClose);
  const custom = createAutoRefresh({ ...options, intervalMs: 125 }); custom.close(); assert.equal(scheduled[1].delay, 125);
  const disabled = createAutoRefresh({ ...options, intervalMs: 0 }); disabled.close(); assert.equal(scheduled.length, 2);
});


test('served MCP and viewer use the 30-second default; one-shot code and no-watch do not poll', async (t) => {
  const { servedHost } = await import('../src/cli/serve.mjs');
  const f = fixture(t), scheduled = [], cleared = [];
  t.mock.method(globalThis, 'setInterval', (_callback, delay) => {
    const timer = { delay, unref() {} }; scheduled.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared.push(timer); });
  const args = { opt: (key, fallback) => key === 'pack' ? f.entry.packDir : fallback, optAll: () => [], flag: () => false, die: (message) => { throw new Error(message); } };
  for (const command of ['mcp', 'view']) {
    const host = servedHost(args, command); assert.equal(scheduled.at(-1).delay, 30000);
    host.close(); assert.ok(cleared.includes(scheduled.at(-1)));
  }
  servedHost(args, 'code').close();
  servedHost({ ...args, flag: (key) => key === 'no-watch' }, 'view').close();
  assert.equal(scheduled.length, 2);
});


test('one fingerprint hashes overlapping Git, selected roots and external aliases once, then rereads saved bytes next time', async (t) => {
  const f = fixture(t), external = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src'));
  const source = path.join(f.root, 'src/a.js'); fs.writeFileSync(source, 'export const value = 1;');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"name":"hash-scan"}');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/'); commitFixture(f.root);
  let alias;
  try { alias = path.join(external.root, 'alias.js'); fs.symlinkSync(source, alias, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; alias = null; }
  f.pack.meta.analysis = { invocation: { webSrc: ['src', 'src', ...(alias ? [external.root] : [])] }, selection: { webRoots: ['src'] } };
  sourceFingerprint(f.entry, f.pack); // engine identity initialization is outside this scan assertion
  const originalOpen = fs.openSync; let sourceReads = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (path.resolve(String(file)) === fs.realpathSync(source)) sourceReads++;
    return originalOpen(file, ...args);
  });
  const first = sourceFingerprint(f.entry, f.pack); assert.equal(sourceReads, 1);
  fs.writeFileSync(source, 'export const value = 2;');
  const second = sourceFingerprint(f.entry, f.pack); assert.equal(sourceReads, 2); assert.notEqual(second, first);
});

test('optional shared content hasher preserves existing directory, external config and failure digests', async (t) => {
  const { contentDigestOf, externalSourcesOf, createFileHashCache } = await import('../src/cli/external_sources.mjs');
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, 'src/a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(f.root, 'package.json'), '{"name":"digest-parity"}');
  fs.writeFileSync(path.join(f.root, '.env'), 'BASE_URL=/api');
  const args = { webSrc: [path.join(f.root, 'src')] }, cached = createFileHashCache();
  assert.equal(contentDigestOf(f.root, cached), contentDigestOf(f.root));
  assert.deepEqual(externalSourcesOf(args, {}, cached), externalSourcesOf(args));
  assert.equal(contentDigestOf(path.join(f.root, 'gone'), cached), 'missing');
  assert.equal(contentDigestOf(f.root, () => { throw new Error('read failed'); }), 'unreadable');
});

test('calibration source identity includes ignored/external content but excludes engine, parser output and own state', (t) => {
  const f = fixture(t), outside = fixture(t);
  fs.mkdirSync(path.join(f.root, 'api')); fs.mkdirSync(path.join(f.root, 'ignored'));
  fs.writeFileSync(path.join(f.root, 'api/a.ts'), 'export class A {}');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\nignored/'); commitFixture(f.root);
  const hidden = path.join(f.root, 'ignored/shared.ts'), external = path.join(outside.root, 'external.ts');
  fs.writeFileSync(hidden, 'export class Shared {}'); fs.writeFileSync(external, 'export class External {}');
  f.pack.meta.analysis = { invocation: { tsSrc: ['api', outside.root], noJava: true, noWeb: true }, selection: { tsRoots: ['api', outside.root] } };
  const digest = () => sourceContentFingerprint(f.entry, f.pack);
  const first = digest();
  f.pack.meta.analysis.enginePrint = 'different'; f.pack.meta.analysis.workers = { ts: 'different' };
  f.pack.meta.structure = { digest: 'different', inputDigest: 'different' };
  f.pack.meta.laneStats = { ts: { prismaSchema: { path: 'parser-output' } } };
  fs.writeFileSync(path.join(f.entry.packDir, 'facts-index.json'), '{"files":{"arbitrary":"parser-output"}}');
  fs.mkdirSync(path.join(f.entry.dotCascadePath, 'calibration')); fs.writeFileSync(path.join(f.entry.dotCascadePath, 'calibration/baseline.json'), '{}');
  fs.mkdirSync(`${f.entry.packDir}-rejected`); fs.writeFileSync(path.join(`${f.entry.packDir}-rejected`, 'pack.json'), '{}');
  assert.equal(digest(), first);
  fs.writeFileSync(hidden, 'export class Changed {}'); assert.notEqual(digest(), first);
  const edited = digest(); fs.unlinkSync(hidden); assert.notEqual(digest(), edited);
  const deleted = digest(); fs.writeFileSync(hidden, 'export class Added {}'); assert.notEqual(digest(), deleted);
  const added = digest(); fs.writeFileSync(external, 'export class ExternalChanged {}'); assert.notEqual(digest(), added);
  const schema = path.join(outside.root, 'custom.prisma');
  f.pack.meta.analysis.declaredInputs = [schema];
  const missing = digest(); fs.writeFileSync(schema, 'model Item { id Int @id }'); assert.notEqual(digest(), missing);
});

test('a real large source deletion still fails the repin gate and preserves the last good pack', async (t) => {
  const f = fixture(t), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-large-drop-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/\nsrc/ignored.ts\n');
  fs.writeFileSync(path.join(f.root, 'src/main.ts'), 'export class Main {}');
  const hidden = path.join(f.root, 'src/ignored.ts'); fs.writeFileSync(hidden, 'export class Hidden { a() {} b() {} c() {} d() {} }');
  commitFixture(f.root);
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  execFileSync(process.execPath, [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--ts-src', path.join(f.root, 'src'), '--no-java', '--no-web', '--no-ddl', '--no-mappers', '--no-openapi'], { cwd: f.root, env, stdio: 'pipe' });
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run: (entry, pack, options) => runRefresh(entry, pack, { ...options, env }) }); t.after(c.close);
  await c.ensureFresh();
  const packBefore = fs.readFileSync(path.join(f.entry.packDir, 'pack.json'));
  const receiptBefore = fs.readFileSync(path.join(f.entry.packDir, 'refresh-state.json'));
  fs.unlinkSync(hidden);
  await assert.rejects(c.ensureFresh(), /REPIN -> RED/);
  assert.equal(c.status('sample').verdict, 'behind');
  assert.deepEqual(fs.readFileSync(path.join(f.entry.packDir, 'pack.json')), packBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.entry.packDir, 'refresh-state.json')), receiptBefore);
});

test('a saved edit after real worker extraction cannot poison the pack or baseline, and a stable refresh recovers', async (t) => {
  const f = fixture(t), cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-refresh-race-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const env = { ...process.env, CASCADE_HOME: cache };
  fs.mkdirSync(path.join(f.root, 'src')); fs.writeFileSync(path.join(f.root, '.gitignore'), '.cascade/');
  const source = path.join(f.root, 'src/main.ts');
  fs.writeFileSync(source, 'export class Main { a() {} b() {} c() {} d() {} }'); commitFixture(f.root);
  const { CLI_PATH } = await import('../src/cli/env.mjs');
  const args = [CLI_PATH, 'analyze', '--root', f.root, '--out', f.entry.packDir, '--ts-src', path.join(f.root, 'src'), '--no-java', '--no-web', '--no-ddl', '--no-mappers', '--no-openapi'];
  execFileSync(process.execPath, args, { cwd: f.root, env, stdio: 'pipe' });
  const baselineFile = path.join(f.entry.dotCascadePath, 'calibration/baseline.json');
  const packBefore = fs.readFileSync(path.join(f.entry.packDir, 'pack.json')), baselineBefore = fs.readFileSync(baselineFile);
  const preload = path.join(cache, 'race.cjs');
  fs.writeFileSync(preload, `const cp = require('node:child_process'), fs = require('node:fs');
const original = cp.execFileSync;
cp.execFileSync = function(command, args, options) {
  const result = original.call(this, command, args, options);
  if (args?.some(a => String(a).endsWith('tsfacts.mjs')) && !args.includes('--list')) {
    fs.writeFileSync(process.env.CASCADE_RACE_SOURCE, 'export class Main { a() {} b() {} c() {} d() {} added() {} }');
  }
  return result;
};
require('node:module').syncBuiltinESMExports();`);
  fs.writeFileSync(source, 'export class Main { a() {} b() {} c() {} d() {} changed() {} }');
  assert.throws(() => execFileSync(process.execPath, ['--require', preload, ...args], {
    cwd: f.root, env: { ...env, CASCADE_RACE_SOURCE: source }, stdio: 'pipe',
  }), /SOURCE_INPUTS_CHANGED/);
  assert.deepEqual(fs.readFileSync(path.join(f.entry.packDir, 'pack.json')), packBefore);
  assert.deepEqual(fs.readFileSync(baselineFile), baselineBefore);
  const c = createAutoRefresh({ entries: [f.entry], intervalMs: 0, run: (entry, pack, options) => runRefresh(entry, pack, { ...options, env }) }); t.after(c.close);
  await c.ensureFresh(); assert.equal(c.status('sample').verdict, 'current');
  const pack = JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'pack.json')));
  assert.equal(pack.meta.calibration.mode, 'REPIN');
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.entry.packDir, 'structure.json'))).declarations.some((d) => d.name === 'added'));
});
