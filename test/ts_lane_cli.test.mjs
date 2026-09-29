import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The TypeScript backend lane through the REAL CLI: `cascade init` finds the
// NestJS application, `cascade analyze` reads it beside the frontend, and the
// fact cache reuses what did not change.
//
// The fixture (test/fixtures/ts-nest) is a workspace shaped like ghostfolio:
// one package.json at the top declaring both Angular and NestJS, the API under
// apps/api/src, a frontend under apps/web, a shared lib reached through a
// tsconfig path, and prisma/schema.prisma at the top. What it pins down:
//
// - a controller no module registers serves nothing;
// - a route excluded from the global prefix, and a method that is version
//   neutral, are served where Nest serves them;
// - two Prisma calls in one method are two statements, and neither reads the
//   other's columns;
// - the web lane reads the frontend and NOT the API, although both sit under
//   the package's root;
// - the shared lib the API imports through a tsconfig path is read by the
//   TypeScript lane too, and each lane keeps its own shard of it.

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'ts-nest');
const SERVICE = 'apps/api/src/users/users.service.ts';

function tmpDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo holding a copy of the fixture, so a run has a commit to pin, and a home of its own. */
function workspace(t) {
  const base = tmpDir(t, 'cascade-tslane-');
  const dir = path.join(base, 'ws');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'init');
  const env = { CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  return { base, dir, env };
}

/** Run the CLI, capturing stderr even on success (execFileSync only returns it on a throw). */
function cli(args, { base, env }) {
  const log = path.join(base, `stderr-${args[0]}-${Date.now()}.txt`);
  const fd = fs.openSync(log, 'w');
  let code = 0;
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, cwd: base, stdio: ['ignore', 'pipe', fd], maxBuffer: 1 << 28, encoding: 'utf8',
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
  } finally {
    fs.closeSync(fd);
  }
  return { code, stdout, stderr: fs.readFileSync(log, 'utf8') };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lineOf = (stderr, re) => stderr.split('\n').find((l) => re.test(l)) ?? '';

function initAndAnalyze(t) {
  const ws = workspace(t);
  const init = cli(['init', '--root', ws.dir, '--project', 'tsfix'], ws);
  assert.equal(init.code, 0, init.stderr);
  const run = cli(['analyze', '--root', ws.dir, '--project', 'tsfix'], ws);
  assert.equal(run.code, 0, run.stderr);
  const pack = readJson(path.join(ws.dir, '.cascade', 'pack', 'pack.json'));
  return { ws, init, run, pack };
}

test('init finds the NestJS application and the database its schema.prisma names, and writes them into the profile', (t) => {
  const { ws, init } = initAndAnalyze(t);
  assert.match(init.stderr, /lanes \[web,ts\]/);
  const profile = readJson(path.join(ws.dir, '.cascade', 'profile.json'));
  assert.deepEqual(profile.frameworkPacks, ['web', 'nestjs']);
  assert.deepEqual(profile.tsBackend, { app: '../apps/api/src', prismaSchema: null, globalPrefix: null, globalPrefixExclude: null, typeorm: { namingStrategy: null, entityPrefix: null, schema: null, type: null } });
  assert.equal(profile.sqlDialects.main, 'postgresql', 'the datasource provider, which every migration of this project is written in');
});

test('an unflagged analyze serves the routes the registered controllers declare, where Nest serves them', (t) => {
  const { run, pack } = initAndAnalyze(t);
  assert.match(run.stderr, /^lanes \[ts,web\]: .*web \. \(discovery\); ts apps\/api\/src \(profile\)/m);
  const lane = lineOf(run.stderr, /^TypeScript lane: \d+ file/);
  assert.match(lane, /^TypeScript lane: 9 file\(s\) \(1 outside the application, reached through its imports\), 4 route\(s\) from 2 registered controller\(s\) \(1 not registered by any module\), /);
  assert.match(lane, / 4 call\(s\) linked \(1 into files outside the application\), /);
  assert.match(lane, /; Prisma: 4 statement\(s\) from 4 client call\(s\)$/);

  const endpoints = pack.nodes.filter((n) => n.id.startsWith('endpoint:')).map((n) => n.id).sort();
  assert.deepEqual(endpoints, [
    'endpoint:GET /api/v1/users',
    'endpoint:GET /api/v1/users/{id}',
    // excluded from the global prefix, and version neutral: neither segment
    'endpoint:GET /health',
    'endpoint:POST /api/v1/users',
  ]);
  const handles = pack.edges.find((e) => e.type === 'HANDLES' && e.from === 'endpoint:GET /api/v1/users');
  assert.equal(handles.to, 'symbol:apps/api/src/users/users.controller.ts#UsersController.list');
  assert.equal(handles.grade, 'EXACT');
  assert.equal(handles.evidence.rule, 'nestjs.routes');
  const ts = pack.meta.laneStats.ts;
  assert.equal(ts.app, 'apps/api/src');
  assert.equal(ts.tsconfig, 'apps/api/tsconfig.app.json');
  assert.equal(ts.prismaSchema.path, 'prisma/schema.prisma');
  assert.equal(ts.prismaSchema.provider, 'postgresql');
  assert.match(ts.prismaSchema.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(ts.unregisteredControllers, ['apps/api/src/orphan/orphan.controller.ts#OrphanController']);
  assert.deepEqual(ts.reached, ['libs/common/src/email.ts'], 'the file the API imports through @fixture/common, and no other file outside it');
});

test('with no DDL, schema.prisma is the catalog: the axes say so, the pack names the schema as its source, and a relation is a join', (t) => {
  const { run, pack } = initAndAnalyze(t);
  assert.match(run.stderr, /^TypeScript lane: schema\.prisma: 2 table\(s\) and 7 column\(s\) as the catalog, 1 join\(s\) from its relations; /m);
  assert.equal(pack.meta.axes.catalog.status, 'shipped');
  assert.equal(pack.meta.axes.column.status, 'shipped');
  assert.equal(pack.meta.catalog.source, 'prisma');
  assert.equal(pack.meta.catalog.path, 'prisma/schema.prisma');
  assert.equal(pack.meta.catalog.sha256, pack.meta.laneStats.ts.prismaSchema.sha256);
  const joins = pack.edges.filter((e) => e.type === 'JOINS');
  assert.deepEqual(joins.map((e) => [e.from, e.to, e.evidence.columns]), [['table:User', 'table:posts', ['id=authorId']]]);
  assert.equal(pack.nodes.find((n) => n.id === 'column:User.display_name').nullable, true, 'name String? @map("display_name")');
});

test('two Prisma calls in one method are two statements, and neither reads the columns of the other', (t) => {
  const { pack } = initAndAnalyze(t);
  const touched = (sid, type) => pack.edges.filter((e) => e.from === sid && e.type === type).map((e) => e.to).sort();
  const user = `statement:prisma:${SERVICE}#UsersService.one/0`;
  const posts = `statement:prisma:${SERVICE}#UsersService.one/1`;
  // `name` is @map("display_name"): the column is what the database holds.
  assert.deepEqual(touched(user, 'READS'), ['column:User.display_name', 'column:User.id']);
  assert.deepEqual(touched(posts, 'READS'), ['column:posts.authorId', 'column:posts.title']);
  assert.deepEqual(touched(user, 'EXECUTES'), ['table:User']);
  assert.deepEqual(touched(posts, 'EXECUTES'), ['table:posts'], 'the table is the model\'s @@map');
  const create = `statement:prisma:${SERVICE}#UsersService.create/0`;
  assert.deepEqual(touched(create, 'WRITES'), ['column:User.display_name', 'column:User.email']);
  const implemented = pack.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.to === user);
  assert.equal(implemented.from, `symbol:${SERVICE}#UsersService.one`);
  assert.equal(implemented.evidence.rule, 'prisma.client', 'PrismaService extends PrismaClient, which the rule names');
});

test('the web lane reads the frontend beside the API and not the API, and its calls reach the handlers', (t) => {
  const { run, pack } = initAndAnalyze(t);
  assert.match(lineOf(run.stderr, /^Web lane: \d+ file/), /^Web lane: 2 file\(s\) \(0 \.vue, 2 \.ts\/\.tsx, 0 \.js\/\.jsx\)/, 'the frontend and the shared lib, and no file of apps/api/src');
  const calls = pack.edges.filter((e) => e.type === 'CALLS_HTTP').map((e) => `${e.from} -> ${e.to}`).sort();
  assert.deepEqual(calls, [
    'symbol:apps/web/src/app/users.api.ts#createUser -> endpoint:POST /api/v1/users',
    'symbol:apps/web/src/app/users.api.ts#fetchUsers -> endpoint:GET /api/v1/users',
  ]);
  const mayCall = pack.edges.filter((e) => e.type === 'MAY_CALL').map((e) => `${e.from.split('#')[1]} -> ${e.to.split('#')[1]}`).sort();
  assert.deepEqual(mayCall, [
    'UsersController.create -> UsersService.create',
    'UsersController.list -> UsersService.list',
    'UsersController.one -> UsersService.one',
    // into the shared lib, which a name imported through a tsconfig path used to count as a package
    'UsersService.create -> normalizeEmail',
  ]);
  const shared = pack.nodes.find((n) => n.id === 'symbol:libs/common/src/email.ts#normalizeEmail');
  assert.equal(shared.lane, 'ts', 'the web lane makes no node of a function that sends no request, so this one is the TypeScript lane\'s alone');
  assert.equal(shared.lanes, undefined);
});

test('a second run reuses every TypeScript shard, and an edited TypeScript file is the only one read again', (t) => {
  const { ws, pack } = initAndAnalyze(t);
  const again = cli(['analyze', '--root', ws.dir, '--project', 'tsfix'], ws);
  assert.equal(again.code, 0, again.stderr);
  // The shared lib is read by both lanes, and each reuses its own shard of it.
  assert.match(again.stderr, /^incremental: .*reparsed 0 web file\(s\) \(2 reused, 0 dropped\), reparsed 0 TypeScript file\(s\) \(9 reused, 1 reached outside the application\)/m);
  assert.equal(readJson(path.join(ws.dir, '.cascade', 'pack', 'pack.json')).digest, pack.digest);

  fs.appendFileSync(path.join(ws.dir, SERVICE), '\n// a comment changes no fact\n');
  const edited = cli(['analyze', '--root', ws.dir, '--project', 'tsfix'], ws);
  assert.equal(edited.code, 0, edited.stderr);
  // The file sits under the web root too; the web lane must not take it for a frontend file.
  assert.match(edited.stderr, /^incremental: .*reparsed 0 web file\(s\) \(2 reused, 0 dropped\), reparsed 1 TypeScript file\(s\) \(8 reused, 1 reached outside the application\)/m);
  assert.equal(readJson(path.join(ws.dir, '.cascade', 'pack', 'pack.json')).digest, pack.digest);
  const index = readJson(path.join(ws.dir, '.cascade', 'pack', 'facts-index.json'));
  assert.equal(index.tsFiles[SERVICE].lane, 'ts');
  assert.equal(index.files[SERVICE], undefined, 'the API is no file of the web lane');
  // One file, two lanes: the web lane's shard in `files`, the TypeScript lane's in `tsFiles`.
  assert.equal(index.files['libs/common/src/email.ts'].lane, 'web');
  assert.equal(index.tsFiles['libs/common/src/email.ts'].lane, 'ts');
  assert.notEqual(index.files['libs/common/src/email.ts'].shardKey, index.tsFiles['libs/common/src/email.ts'].shardKey);
});

test('an edit to the shared lib alone is read again by both lanes, and an import it adds is followed', (t) => {
  const { ws } = initAndAnalyze(t);
  const lib = path.join(ws.dir, 'libs', 'common', 'src');
  fs.writeFileSync(path.join(lib, 'trim.ts'), 'export function trimAll(s: string) {\n  return s.trim();\n}\n');
  fs.writeFileSync(path.join(lib, 'email.ts'), "import { trimAll } from './trim';\nexport function normalizeEmail(email: string) {\n  return trimAll(email).toLowerCase();\n}\n");
  const run = cli(['analyze', '--root', ws.dir, '--project', 'tsfix'], ws);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /^incremental: .*reparsed 2 TypeScript file\(s\) \(8 reused, 2 reached outside the application\)/m);
  const pack = readJson(path.join(ws.dir, '.cascade', 'pack', 'pack.json'));
  const mayCall = pack.edges.filter((e) => e.type === 'MAY_CALL' && e.from.includes('libs/')).map((e) => `${e.from} -> ${e.to}`);
  assert.deepEqual(mayCall, ['symbol:libs/common/src/email.ts#normalizeEmail -> symbol:libs/common/src/trim.ts#trimAll']);
  assert.deepEqual(pack.meta.laneStats.ts.reached, ['libs/common/src/email.ts', 'libs/common/src/trim.ts']);
});

test('a shared lib the TypeScript lane read, edited, makes the pack the working tree\'s even with no web lane to read it', (t) => {
  const ws = workspace(t);
  assert.equal(cli(['init', '--root', ws.dir, '--project', 'tsfix'], ws).code, 0);
  fs.appendFileSync(path.join(ws.dir, 'libs', 'common', 'src', 'email.ts'), '\n// edited, not committed\n');
  const run = cli(['analyze', '--root', ws.dir, '--project', 'tsfix', '--no-web'], ws);
  assert.equal(run.code, 0, run.stderr);
  const pack = readJson(path.join(ws.dir, '.cascade', 'pack', 'pack.json'));
  assert.deepEqual(pack.meta.lanes, ['ts']);
  assert.equal(pack.meta.base.dirty, true, 'the lane read a file outside its root that differs from HEAD');
  assert.deepEqual(pack.meta.base.dirtyFiles, ['libs/common/src/email.ts']);
});

test('the working-tree overlay re-reads the edited TypeScript file of a pack that reads the lane, and base-only still answers', (t) => {
  const { ws } = initAndAnalyze(t);
  fs.appendFileSync(path.join(ws.dir, SERVICE), '\n// dirty\n');
  const overlaid = cli(['impact', '--root', ws.dir, '--file', SERVICE], ws);
  assert.equal(overlaid.code, 0, overlaid.stderr);
  assert.match(overlaid.stdout, /^overlay [0-9a-f]+ \(fresh\): re-parsed 0 java \+ 0 frontend \+ 1 TypeScript file\(s\), dropped 0, provisional 0 node\(s\) \/ 0 edge\(s\)$/m,
    'a comment adds no fact, so nothing is provisional');
  assert.match(overlaid.stdout, /^ {2}GET \/api\/v1\/users {2}\[SOUND_SET\]$/m, 'and the routes above the file are the answer');
  const baseOnly = cli(['impact', '--root', ws.dir, '--file', SERVICE, '--mode', 'base-only'], ws);
  assert.equal(baseOnly.code, 0, baseOnly.stderr);
  assert.match(baseOnly.stdout, /mode base-only/);
});
