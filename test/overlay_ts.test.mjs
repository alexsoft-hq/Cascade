// overlay_ts.test.mjs — the working-tree overlay over a NestJS pack, with the tree edited.
//
// test/overlay_equivalence.test.mjs holds the overlay to the analyzed graph
// when nothing is edited. This holds it to the right graph when something is:
// each tree below is analyzed by the real CLI, edited without a commit, and
// overlaid by the provider `cascade impact` and the server lay every overlay
// with (makeOverlayProvider in src/cli/overlay_provider.mjs). Three things are
// asked of every edit:
//
//   - the overlay shows what the edit changed, and marks what no certified run
//     has seen as provisional: a statement, a table, a column, and every edge
//     that touches one;
//   - the base pack and the fact cache are as they were: an uncommitted edit
//     never becomes a cached fact;
//   - with the marks taken off, the overlay's graph is the one `cascade analyze`
//     builds from the edited tree, so it follows the imports, the bindings and
//     the tsconfig, schema.prisma and package.json files as they are now.
//
// And one thing it declines: a TypeScript shard that no longer applies to a file
// git calls unchanged (the worker changed, the shard is gone, or the file moved
// where git does not look) is a fact cache that no longer describes this pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '../src/core/canonical.mjs';
import { loadPack, projectPack } from '../src/core/pack.mjs';
import { changeImpact, classifyDirtyFiles, classifyTsDirtyFiles } from '../src/core/overlay.mjs';
import { assertOverlayable, OverlayStaleError } from '../src/core/overlay_lanes.mjs';
import { makeOverlayProvider, tsInputLimits } from '../src/cli/overlay_provider.mjs';
import { servedProfile } from '../src/cli/serve.mjs';
import { casDir } from '../src/core/paths.mjs';
import { ENGINE_ROOT, commit } from '../scripts/golden-trees.mjs';
import {
  PRISMA_SERVICE, SHARED_API, TYPEORM_ENTITY, dispatchTree, prismaTree, typeormTree, write,
} from './helpers/ts_trees.mjs';

const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

// ---------------------------------------------------------------------------
// a tree, analyzed, edited and overlaid
// ---------------------------------------------------------------------------

function tmpDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build, commit, `init` and `analyze` a tree with the real CLI, the pack where `cascade impact` finds it. */
function analyzedTree(t, name, build) {
  const base = tmpDir(t, `cascade-overlay-ts-${name}-`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  build(repo);
  commit(repo);
  const env = { ...process.env, CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, encoding: 'utf8' });
  try {
    cli(['init', '--root', repo, '--project', `ts-${name}`]);
    cli(['analyze', '--root', repo, '--project', `ts-${name}`]);
  } catch (e) {
    throw new Error(`the run over ${name} failed (${e.status}):\n${String(e.stderr ?? '')}`, { cause: e });
  }
  return { base, repo, packDir: path.join(repo, '.cascade', 'pack'), env, cli, name };
}

/** Run `fn` with the fact cache the tree's run wrote, as the CLI would find it. */
function withCache(tree, fn) {
  const was = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tree.env.XDG_CACHE_HOME;
  try { return fn(); } finally {
    if (was === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = was;
  }
}

/** The overlay over the working tree as git sees it now, laid by the provider every caller uses. */
function overlayNow(tree) {
  const pack = JSON.parse(fs.readFileSync(path.join(tree.packDir, 'pack.json'), 'utf8'));
  const baseGraph = loadPack(pack, { verifyDigest: true });
  return withCache(tree, () => {
    const provider = makeOverlayProvider({ packDir: tree.packDir, pack, baseGraph, profile: servedProfile(tree.packDir, pack) });
    return { pack, state: provider() };
  });
}

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

/** The base pack, its fact index and every file of the fact cache: what an overlay must leave as it found. */
function certifiedState(tree) {
  return {
    pack: sha(path.join(tree.packDir, 'pack.json')),
    index: sha(path.join(tree.packDir, 'facts-index.json')),
    cache: filesUnder(tree.env.XDG_CACHE_HOME),
  };
}

/**
 * What `cascade analyze` builds from the tree as it is now: a copy of it, with
 * its history and its profile, analyzed from nothing by another home and cache.
 */
function analyzedNow(t, tree) {
  const base = tmpDir(t, `cascade-overlay-ts-${tree.name}-now-`);
  const repo = path.join(base, 'repo');
  const own = path.join(tree.repo, '.cascade');
  fs.cpSync(tree.repo, repo, { recursive: true, filter: (src) => src !== own && !src.startsWith(own + path.sep) });
  const env = { ...process.env, CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  cli(['init', '--root', repo, '--project', `ts-${tree.name}-now`]);
  fs.copyFileSync(path.join(own, 'profile.json'), path.join(repo, '.cascade', 'profile.json'));
  cli(['analyze', '--root', repo, '--project', `ts-${tree.name}-now`]);
  return JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
}

/** A graph's nodes and edges as JSON, with the overlay's two markers taken off. */
function unmarked(graph) {
  const p = JSON.parse(JSON.stringify(projectPack(graph, {})));
  for (const n of p.nodes) delete n.provisional;
  for (const e of p.edges) {
    delete e.provisional;
    if (e.evidence) delete e.evidence.overlaySessionId;
  }
  return p;
}

/** Every node and edge on one side only, one line each: empty when the overlay is the analyzed graph. */
function differences(overlay, analyzed) {
  const lines = (p) => new Set([
    ...p.nodes.map((n) => `node ${canonicalJson(n)}`),
    ...p.edges.map((e) => `edge ${canonicalJson({ ...e, evidence: e.evidence && Object.keys(e.evidence).length > 0 ? e.evidence : null })}`),
  ]);
  const a = lines(overlay);
  const b = lines(analyzed);
  return [...[...a].filter((l) => !b.has(l)).map((l) => `only in the overlay: ${l}`), ...[...b].filter((l) => !a.has(l)).map((l) => `only in analyze: ${l}`)];
}

function assertAnalyzedGraph(t, tree, state) {
  const diffs = differences(unmarked(state.graph), analyzedNow(t, tree));
  assert.deepEqual(diffs.slice(0, 20), [], `the overlay differs from what analyze builds from the edited tree in ${diffs.length} place(s)`);
}

const edgesOf = (graph, type, from) => graph.edges.filter((e) => e.type === type && e.from === from);
const edit = (tree, rel, from, to) => {
  const file = path.join(tree.repo, rel);
  const before = fs.readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `${rel} holds ${from}`);
  fs.writeFileSync(file, before.replace(from, to));
};

// ---------------------------------------------------------------------------
// the edits
// ---------------------------------------------------------------------------

const LIST_ONE_CALL = `  public list() {
    return this.prisma.user.findMany({ select: { id: true, email: true } });
  }`;
const LIST_TWO_CALLS = `  public async list() {
    const users = await this.prisma.user.findMany({ select: { id: true, email: true } });
    const titles = await this.prisma.post.findMany({ select: { title: true } });
    return { users, titles };
  }`;

test('prisma: a service method that gains a Prisma call reaches a new statement, marked provisional, and the base pack and the cache stay as they were', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'prisma-call', prismaTree);
  const before = certifiedState(tree);
  edit(tree, PRISMA_SERVICE, LIST_ONE_CALL, LIST_TWO_CALLS);
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual([state.parsedTsFiles, state.droppedTsFiles, state.tsConfigFiles, state.unmatched], [[PRISMA_SERVICE], [], [], []],
    'the edited file alone was read again, and the lane claims it');

  const method = `symbol:${PRISMA_SERVICE}#UsersService.list`;
  const added = `statement:prisma:${PRISMA_SERVICE}#UsersService.list/1`;
  assert.deepEqual(state.provisional.statements, [added]);
  const link = edgesOf(state.graph, 'IMPLEMENTS_STMT', method).find((e) => e.to === added);
  assert.equal(link?.provisional, true, 'the edge onto a statement no run has seen is provisional too');
  assert.equal(link.evidence.overlaySessionId, state.session.overlaySessionId, 'and it came out of the re-read file');
  assert.deepEqual(edgesOf(state.graph, 'READS', added).map((e) => `${e.to} ${e.grade}`), ['column:posts.title EXACT']);
  assert.equal(state.graph.nodes.get(`statement:prisma:${PRISMA_SERVICE}#UsersService.list/0`).provisional, undefined, 'the statement the pack has is not provisional');

  // What an impact answer walks: the route above the edit, and the new column below it.
  const impact = changeImpact(state.graph, [PRISMA_SERVICE]);
  assert.ok(impact.upstreamEndpoints.some((e) => e.id === 'endpoint:GET /api/v1/users'));
  assert.ok(impact.downstreamColumns.some((c) => c.id === 'column:posts.title'));

  assert.deepEqual(certifiedState(tree), before, 'the pack, its index and the fact cache are untouched');
  assertAnalyzedGraph(t, tree, state);
});

test('typeorm: an entity column renamed moves every statement that names it onto the new column, marked provisional', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'typeorm-column', typeormTree);
  const before = certifiedState(tree);
  edit(tree, TYPEORM_ENTITY, '@Column() title: string;', "@Column({ name: 'headline' }) title: string;");
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.parsedTsFiles, [TYPEORM_ENTITY]);

  const stmt = (m) => `statement:typeorm:src/article/article.service.ts#ArticleService.${m}/0`;
  const cols = (type, m) => edgesOf(state.graph, type, stmt(m)).map((e) => e.to).sort();
  assert.deepEqual(cols('READS', 'list'), ['column:article.headline', 'column:article.id'], 'the select reads the renamed column');
  assert.deepEqual(cols('WRITES', 'create'), ['column:article.body', 'column:article.headline'], 'the insert writes it');
  assert.ok(cols('READS', 'byTitle').includes('column:article.headline'), 'and the builder\'s where reads it');
  assert.equal(state.graph.nodes.has('column:article.title'), false, 'the old name is no column any more');
  assert.deepEqual(state.provisional.columns, ['column:article.headline'], 'a column no certified run has seen is provisional');
  assert.equal(edgesOf(state.graph, 'READS', stmt('list')).find((e) => e.to === 'column:article.headline').provisional, true);

  assert.deepEqual(certifiedState(tree), before, 'the pack, its index and the fact cache are untouched');
  assertAnalyzedGraph(t, tree, state);
});

test('typeorm: DataSource options an edit changes are read again, and every table name moves with the prefix they now set', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'typeorm-options', typeormTree);
  edit(tree, 'src/app.module.ts', "TypeOrmModule.forRoot({ type: 'postgres' })", "TypeOrmModule.forRoot({ type: 'postgres', entityPrefix: 'shop_' })");
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.parsedTsFiles, ['src/app.module.ts'], 'the options are facts of the module file, and only it was read again');
  const executes = edgesOf(state.graph, 'EXECUTES', 'statement:typeorm:src/article/article.service.ts#ArticleService.list/0');
  assert.deepEqual(executes.map((e) => `${e.to} ${e.grade}`), ['table:shop_article EXACT'], 'the entities read in their own files take the prefix the options set');
  assert.deepEqual(state.provisional.tables, ['table:shop_article', 'table:shop_author']);
  assertAnalyzedGraph(t, tree, state);
});

test('a lib file both lanes read, edited, is read again by both, and its function stays one node that names both lanes', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'shared-lib', dispatchTree);
  edit(tree, SHARED_API, "fetch('/health')", "fetch('/api/v1/users')");
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual([state.parsedWebFiles, state.parsedTsFiles], [[SHARED_API], [SHARED_API]]);
  const fn = `symbol:${SHARED_API}#pingHealth`;
  assert.deepEqual(state.graph.nodes.get(fn).lanes, ['ts', 'web']);
  assert.deepEqual(edgesOf(state.graph, 'CALLS_HTTP', fn).map((e) => e.to), ['endpoint:GET /api/v1/users'], 'the request it sends now');
  assertAnalyzedGraph(t, tree, state);
});

test('a binding the module changes moves a call through the abstract class, though neither end of the call was edited', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'binding', dispatchTree);
  edit(tree, 'apps/api/src/users/users.module.ts', 'useClass: EmailNotifier', 'useClass: SmsNotifier');
  edit(tree, 'apps/api/src/users/users.module.ts', "import { EmailNotifier } from '../notify/email.notifier';", "import { SmsNotifier } from '../notify/sms.notifier';");
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.parsedTsFiles, ['apps/api/src/users/users.module.ts'], 'the service that makes the call was not read again');
  const sends = edgesOf(state.graph, 'MAY_CALL', `symbol:${PRISMA_SERVICE}#UsersService.create`).filter((e) => e.to.endsWith('.send'));
  // Cross-file work is the bridge's, over the whole stream: a cached shard of
  // users.service.ts holds the call, never which class answers it.
  assert.deepEqual(sends.map((e) => e.to), ['symbol:apps/api/src/notify/sms.notifier.ts#SmsNotifier.send']);
  assertAnalyzedGraph(t, tree, state);
});

test('an import an edit adds is followed to a file no run has read, and a lib no import reaches any more is dropped', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'imports', prismaTree);
  write(tree.repo, 'libs/common/src/slug.ts', 'export function slugOf(s: string) {\n  return s.trim().toLowerCase().replace(/ /g, \'-\');\n}\n');
  edit(tree, PRISMA_SERVICE, "import { normalizeEmail } from '@fixture/common/email';", "import { slugOf } from '@fixture/common/slug';");
  edit(tree, PRISMA_SERVICE, 'normalizeEmail(email)', 'slugOf(email)');
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.parsedTsFiles, [PRISMA_SERVICE, 'libs/common/src/slug.ts'].sort());
  assert.deepEqual(state.droppedTsFiles, ['libs/common/src/email.ts'], 'as the next analyze would not read it');
  const create = `symbol:${PRISMA_SERVICE}#UsersService.create`;
  assert.deepEqual(edgesOf(state.graph, 'MAY_CALL', create).map((e) => e.to), ['symbol:libs/common/src/slug.ts#slugOf']);
  assert.ok(state.provisional.symbols.includes('symbol:libs/common/src/slug.ts#slugOf'));
  assert.equal(state.graph.nodes.has('symbol:libs/common/src/email.ts#normalizeEmail'), false);
  assertAnalyzedGraph(t, tree, state);
});

test('an edited tsconfig is read again whole: the lib its new path names is reached, and the file is the lane\'s, not unmatched', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'tsconfig', prismaTree);
  write(tree.repo, 'libs/shared/src/email.ts', 'export function normalizeEmail(email: string) {\n  return email.toLowerCase();\n}\n');
  edit(tree, 'tsconfig.base.json', '"libs/common/src/*"', '"libs/shared/src/*"');
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.tsConfigFiles, ['tsconfig.base.json']);
  assert.equal(state.unmatched.includes('tsconfig.base.json'), false);
  assert.deepEqual(state.droppedTsFiles, ['libs/common/src/email.ts']);
  assert.deepEqual(edgesOf(state.graph, 'MAY_CALL', `symbol:${PRISMA_SERVICE}#UsersService.create`).map((e) => e.to), ['symbol:libs/shared/src/email.ts#normalizeEmail']);
  assertAnalyzedGraph(t, tree, state);
});

test('an edited schema.prisma is read again whole: a field it adds is a provisional column the edited service reads', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'schema', prismaTree);
  edit(tree, 'prisma/schema.prisma', '  createdAt DateTime @default(now())', '  createdAt DateTime @default(now())\n  bio       String?');
  edit(tree, PRISMA_SERVICE, 'select: { id: true, email: true }', 'select: { id: true, email: true, bio: true }');
  const { state } = overlayNow(tree);
  assert.equal(state.applied, true, state.reason);
  assert.deepEqual(state.tsConfigFiles, ['prisma/schema.prisma']);
  assert.deepEqual(state.provisional.columns, ['column:User.bio']);
  assert.ok(edgesOf(state.graph, 'READS', `statement:prisma:${PRISMA_SERVICE}#UsersService.list/0`).some((e) => e.to === 'column:User.bio'));
  assertAnalyzedGraph(t, tree, state);
});

test('a TypeScript shard that no longer applies to a file git calls unchanged declines the overlay, naming the cure', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'stale', prismaTree);
  const index = JSON.parse(fs.readFileSync(path.join(tree.packDir, 'facts-index.json'), 'utf8'));
  const entry = index.tsFiles['libs/common/src/email.ts'];
  fs.rmSync(casDir(index.project, 'tsfacts', entry.shardKey, { XDG_CACHE_HOME: tree.env.XDG_CACHE_HOME }), { recursive: true, force: true });
  edit(tree, PRISMA_SERVICE, LIST_ONE_CALL, LIST_TWO_CALLS);
  assert.throws(() => overlayNow(tree), (e) => e instanceof OverlayStaleError && e.code === 'overlay-stale'
    && /^the cached TypeScript facts of 1 file\(s\) the working tree did not change no longer apply \(libs\/common\/src\/email\.ts\): /.test(e.message)
    && /Run `cascade analyze`/.test(e.message));
});

test('cascade impact lays the overlay over a pack that reads TypeScript, and says what it read again', { timeout: 300000 }, (t) => {
  const tree = analyzedTree(t, 'cli', prismaTree);
  edit(tree, PRISMA_SERVICE, LIST_ONE_CALL, LIST_TWO_CALLS);
  const out = tree.cli(['impact', '--root', tree.repo, '--file', PRISMA_SERVICE]);
  assert.match(out, /^overlay [0-9a-f]+ \(fresh\): re-parsed 0 java \+ 0 frontend \+ 1 TypeScript file\(s\), dropped 0, provisional 1 node\(s\) \/ \d+ edge\(s\)$/m);
  assert.match(out, /^timings ms: load-base \d+ \+ java \d+ \+ web \d+ \+ sql \d+ \+ ts \d+ \+ graph \d+ = \d+$/m);
  // The column was there before; the statement that reaches it now is the new, provisional node.
  assert.match(out, /^ {2}posts\.title {2}\[EXACT\]$/m);
});

// ---------------------------------------------------------------------------
// which lane claims a changed file
// ---------------------------------------------------------------------------

test('a TypeScript file under a frontend root that holds the API is the TypeScript lane\'s, not a frontend file, as analyze plans it', () => {
  const selection = { webRoots: [''], tsRoots: ['apps/api/src'] };
  const dirty = classifyDirtyFiles([
    { path: PRISMA_SERVICE, status: 'M' }, { path: 'apps/web/src/app/users.api.ts', status: 'M' }, { path: 'libs/common/src/email.ts', status: 'M' },
  ], selection);
  assert.deepEqual(dirty.web, ['apps/web/src/app/users.api.ts', 'libs/common/src/email.ts'], 'a lib the frontend bundles is the web lane\'s too');
  assert.deepEqual(dirty.other, [PRISMA_SERVICE], 'the API file waits for the TypeScript lane to claim it');
});

test('the TypeScript lane claims the files it read now or the base read, and the tsconfig, schema and package.json files every file rests on', () => {
  const read = ['apps/api/src/main.ts', 'libs/common/src/email.ts'];
  const claims = classifyTsDirtyFiles([
    'apps/api/src/main.ts', 'libs/old/src/gone.ts', 'tsconfig.base.json', 'prisma/schema.prisma', 'package.json',
    'libs/common/package.json', 'tools/package.json', 'README.md',
  ], { read, baseRead: ['libs/old/src/gone.ts'], inputFiles: ['apps/api/tsconfig.app.json', 'tsconfig.base.json', 'prisma/schema.prisma'] });
  assert.deepEqual(claims.ts, ['apps/api/src/main.ts', 'libs/old/src/gone.ts']);
  assert.deepEqual(claims.tsConfig, ['libs/common/package.json', 'package.json', 'prisma/schema.prisma', 'tsconfig.base.json'],
    'a package.json above no file the lane read is not one it rests on');
});

test('a profile that names another TypeScript application than the one the pack read is said as a limit', () => {
  const idx = { root: '/r', selection: { tsRoots: ['apps/api/src'] } };
  const nest = (app) => ({ frameworkPacks: ['nestjs'], tsBackend: { app } });
  assert.deepEqual(tsInputLimits(idx, nest('../apps/api/src'), '/r/.cascade'), [], 'the application the pack read says nothing');
  const [limit] = tsInputLimits(idx, nest('../apps/admin/src'), '/r/.cascade');
  assert.equal(limit.scope, 'overlay');
  assert.match(limit.reason, /^the profile names the TypeScript application apps\/admin\/src, and this pack read apps\/api\/src\. The overlay reads apps\/api\/src, as the base pack did/);
  assert.doesNotMatch(limit.reason, /[—·]/);
  assert.deepEqual(tsInputLimits(idx, { frameworkPacks: [], tsBackend: { app: '../apps/admin/src' } }, '/r/.cascade'), [], 'a profile whose run reads no TypeScript names no application');
  assert.deepEqual(tsInputLimits({ root: '/r', selection: {} }, nest('../apps/admin/src'), '/r/.cascade'), [], 'a pack that read none has none to go stale');
});

test('only an index that keeps TypeScript shards among the other lanes\' declines: the overlay cannot tell there which files that lane read', () => {
  assert.doesNotThrow(() => assertOverlayable({ files: { 'a.ts': { lane: 'web' } }, tsFiles: { 'a.ts': { lane: 'ts' } } }));
  assert.throws(() => assertOverlayable({ files: { 'a.ts': { lane: 'ts' } } }), (e) => e instanceof OverlayStaleError && e.code === 'ts-not-overlaid'
    && /cannot tell which files the TypeScript lane read/.test(e.message) && !/[—·]/.test(e.message));
});
