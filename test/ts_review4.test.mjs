// ts_review4.test.mjs — review 4 of the TypeScript lane: every candidate set a call is given is closed, or it says what may be missing.
//
// A call through a type reaches a set of methods (src/adapters/ts/dispatch.mjs,
// nest_providers.mjs). The set is SOUND_SET only when nothing the engine could
// not read may add a member to it: a providers list it could not read, a class
// whose extends it cannot follow, a member written over a method, a module a
// dynamic module names. Anything else is HEURISTIC, and the edge says why. And
// a file the run does not read is said, never dropped: test support nobody
// imports, a link out of the root. The fixtures are small projects read by the
// real worker, so what is under test is the decision, not one repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (...l) => l.join('\n');
function bridge(files, opts = {}) {
  const g = new Graph();
  const stats = addTsFacts(g, files.flatMap(([n, s]) => factsOfFile(n, s)), opts);
  return { g, stats };
}
const callsFrom = (g, from) => g.edges.filter((e) => e.type === 'MAY_CALL' && e.from === from).sort((a, b) => (a.to < b.to ? -1 : 1));
const short = (e) => [e.grade, e.to.slice(e.to.indexOf('#') + 1)];
const MAIN = ['main.ts', src(
  "import { NestFactory } from '@nestjs/core';",
  "import { AppModule } from './app.module';",
  'async function bootstrap() { const app = await NestFactory.create(AppModule); await app.listen(3000); }',
  'bootstrap();',
)];

// ---------------------------------------------------------------------------
// a field whose type no class of the project changes, and the modules that fill it
// ---------------------------------------------------------------------------

const SVC = ['users.service.ts', src("import { Injectable } from '@nestjs/common';", '@Injectable()', 'export class UsersService { find() { return 1; } }')];
const FAKE = ['fake.service.ts', src("import { Injectable } from '@nestjs/common';", '@Injectable()', 'export class FakeUsersService { find() { return 2; } }')];
const CTRL = ['users.controller.ts', src("import { Controller, Get } from '@nestjs/common';", "import { UsersService } from './users.service';",
  "@Controller('users')", 'export class UsersController {', '  constructor(private readonly users: UsersService) {}', '  @Get() list() { return this.users.find(); }', '}')];
const LIST = 'symbol:users.controller.ts#UsersController.list';

test('plain_class_token_rebound_in_unread_provider_list_is_not_sound_set', () => {
  const provs = ['providers.ts', src("import { UsersService } from './users.service';", "import { FakeUsersService } from './fake.service';",
    'export const providers = [{ provide: UsersService, useClass: FakeUsersService }];')];
  const app = ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { UsersController } from './users.controller';", "import { providers } from './providers';",
    '@Module({ controllers: [UsersController], providers: [...providers] })', 'export class AppModule {}')];
  const edges = callsFrom(bridge([SVC, FAKE, CTRL, provs, app, MAIN]).g, LIST);
  // FakeUsersService.find runs; UsersService.find alone at SOUND_SET is a set without the truth.
  assert.ok(edges.length > 0 && edges.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(edges.map(short)));
  assert.match(edges[0].evidence.dispatch.incomplete, /providers are not a list this engine can read whole/);
});

test('a class listed alone stays its own set when every module the application loads is read, whatever an unloaded module does', () => {
  const app = ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { UsersController } from './users.controller';", "import { UsersService } from './users.service';",
    '@Module({ controllers: [UsersController], providers: [UsersService] })', 'export class AppModule {}')];
  const stray = ['stray.module.ts', src("import { Module } from '@nestjs/common';", "import { rest } from './rest';", '@Module({ imports: [...rest] })', 'export class StrayModule {}')];
  const edges = callsFrom(bridge([SVC, CTRL, app, stray, MAIN]).g, LIST);
  assert.deepEqual(edges.map(short), [['SOUND_SET', 'UsersService.find']]);
});

test('a list a module spreads that is written out, one branch or the other, is read, not a gap', () => {
  const app = ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { UsersController } from './users.controller';", "import { UsersService } from './users.service';",
    "import { BullBoardModule } from '@bull-board/nestjs';", 'declare const on: boolean;',
    '@Module({ controllers: [UsersController], providers: [UsersService], imports: [...(on ? [BullBoardModule.forFeature({ name: "q" })] : [])] })', 'export class AppModule {}')];
  const edges = callsFrom(bridge([SVC, CTRL, app, MAIN]).g, LIST);
  assert.deepEqual(edges.map(short), [['SOUND_SET', 'UsersService.find']]);
  // A spread of a list it holds only by name is still a gap.
  const named = ['app.module.ts', app[1].replace('[...(on ? [BullBoardModule.forFeature({ name: "q" })] : [])]', '[...(on ? MODS : [])]')];
  const open = callsFrom(bridge([SVC, CTRL, named, MAIN]).g, LIST);
  assert.ok(open.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(open.map(short)));
});

// ---------------------------------------------------------------------------
// the modules a dynamic module or a custom decorator brings
// ---------------------------------------------------------------------------

const REPO3 = ['repo.ts', src(
  'export abstract class Repo { abstract find(): number; }',
  'export class A extends Repo { find() { return 1; } }',
  'export class B extends Repo { find() { return 2; } }')];
const CTRL3 = ['c.controller.ts', src(
  "import { Controller, Get } from '@nestjs/common';", "import { Repo } from './repo';",
  "@Controller('c')", 'export class CController {', '  constructor(private readonly repo: Repo) {}', '  @Get() list() { return this.repo.find(); }', '}')];
const LIST3 = 'symbol:c.controller.ts#CController.list';

test('dynamic_module_naming_another_module_class_reads_that_class_bindings', () => {
  const persist = ['persist.ts', src("import { Module } from '@nestjs/common';", "import { Repo, A, B } from './repo';",
    '@Module({ providers: [{ provide: Repo, useClass: B }], exports: [Repo] }) export class Real {}',
    '@Module({}) export class Entry { static forRoot() { return { module: Real }; } }',
    '@Module({ providers: [{ provide: Repo, useClass: A }], exports: [Repo] }) export class Other {}')];
  const app = ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { CController } from './c.controller';", "import { Entry, Other } from './persist';",
    '@Module({ imports: [Entry.forRoot(), Other], controllers: [CController] })', 'export class AppModule {}')];
  const edges = callsFrom(bridge([REPO3, CTRL3, persist, app, MAIN]).g, LIST3);
  // Real is read as Nest reads it: both bindings are in the set, and it is settled.
  assert.deepEqual(edges.map(short), [['SOUND_SET', 'A.find'], ['SOUND_SET', 'B.find']]);
});

test('custom_decorated_module_with_a_static_method_imported_as_class_is_a_gap', () => {
  const wrapped = ['wrapped.module.ts', src("import { MyModule } from './my-module';", "import { Repo, B } from './repo';",
    '@MyModule({ providers: [{ provide: Repo, useClass: B }], exports: [Repo] })',
    'export class WrappedModule { static forRoot() { return { module: WrappedModule, global: true }; } }')];
  const app = ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { CController } from './c.controller';", "import { WrappedModule } from './wrapped.module';", "import { Repo, A } from './repo';",
    '@Module({ imports: [WrappedModule], controllers: [CController], providers: [{ provide: Repo, useClass: A }] })', 'export class AppModule {}')];
  const my = ['my-module.ts', "import { Module } from '@nestjs/common';\nexport const MyModule = (o: any) => Module(o);"];
  const edges = callsFrom(bridge([REPO3, CTRL3, wrapped, app, MAIN, my]).g, LIST3);
  assert.ok(edges.some((e) => e.to.endsWith('B.find')) || edges.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(edges.map(short)));
  assert.ok(edges.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(edges.map(short)));
});

// ---------------------------------------------------------------------------
// `this.m()`: what a subclass may run in its place
// ---------------------------------------------------------------------------

const RUN = 'symbol:base.ts#Base.run';
const BASE = 'export class Base { run() { return this.step(); } step() { return 1; } }';
for (const [name, lines] of [
  ['this_dispatch_property_holding_a_bound_method_overrides', [BASE, 'export class Sub extends Base { step = this.fast.bind(this); fast() { return 2; } }']],
  ['this_dispatch_property_set_in_constructor_overrides', [BASE, 'export class Sub extends Base { constructor() { super(); this.step = () => 2; } }']],
  ['this_dispatch_class_expression_subclass_is_in_the_set', [BASE, 'export const Sub = class extends Base { step() { return 2; } };']],
  ['this_dispatch_extends_unresolved_name_is_open', [BASE, 'declare const flag: boolean;', 'export class Other { step() { return 3; } }', 'export class X extends (flag ? Base : Other) { step() { return 2; } }']],
  ['this_dispatch_extends_a_value_the_file_makes_is_open', [BASE, 'declare function makeBase(): any;', 'const B2 = makeBase();', 'export class X extends B2 { step() { return 2; } }']],
  ['this_dispatch_member_assigned_on_the_prototype_is_open', [BASE, 'Base.prototype.step = function () { return 5; };']],
  ['this_dispatch_object_assign_on_this_is_open', [BASE, 'export class Sub extends Base { constructor(o: any) { super(); Object.assign(this, o); } }']],
]) {
  test(name, () => {
    const edges = callsFrom(bridge([['base.ts', src(...lines)]]).g, RUN);
    assert.ok(edges.length > 1 || edges.every((e) => e.grade === 'HEURISTIC'), JSON.stringify(edges.map(short)));
    // No edge at all is true to the source too: what runs is a value no symbol stands for, and the call is counted unresolved.
    assert.ok(edges.length === 0 || !edges.every((e) => e.grade === 'SOUND_SET' && e.to.endsWith('Base.step')), JSON.stringify(edges.map(short)));
  });
}

test('the class expression a const holds is a class of its own, and its override is in the set', () => {
  const edges = callsFrom(bridge([['base.ts', src(BASE, 'export const Sub = class extends Base { step() { return 2; } };')]]).g, RUN);
  assert.deepEqual(edges.map(short), [['SOUND_SET', 'Base.step'], ['SOUND_SET', 'Sub.step']]);
});

test('a class declared inside a function is a class too, named by its line, and its override is in the set', () => {
  const edges = callsFrom(bridge([['base.ts', src(BASE, 'export function make() { class Local extends Base { step() { return 9; } } return new Local(); }')]]).g, RUN);
  assert.deepEqual(edges.map(short), [['SOUND_SET', 'Base.step'], ['SOUND_SET', 'Local$2.step']]);
});

test('this_dispatch_extends_namespace_member_is_a_subclass', () => {
  const g = bridge([['base.ts', BASE], ['x.ts', "import * as b from './base';\nexport class X extends b.Base { step() { return 2; } }"]]).g;
  assert.deepEqual(callsFrom(g, RUN).map(short), [['SOUND_SET', 'Base.step'], ['SOUND_SET', 'X.step']]);
});

test('what does not change the method stays closed: a bind of itself, a global parent, an unrelated open class', () => {
  const same = callsFrom(bridge([['base.ts', src(BASE, 'export class Sub extends Base { constructor() { super(); this.step = this.step.bind(this); } }')]]).g, RUN);
  assert.deepEqual(same.map(short), [['SOUND_SET', 'Base.step']]);
  const global = callsFrom(bridge([['base.ts', src(BASE, 'export class Failure extends Error { step() { return 0; } }')]]).g, RUN);
  assert.deepEqual(global.map(short), [['SOUND_SET', 'Base.step']], 'a class extending a global is no subclass of a class of the project');
  const other = callsFrom(bridge([['base.ts', src(BASE, 'declare const B2: any;', 'export class X extends B2 { other() { return 2; } }')]]).g, RUN);
  assert.deepEqual(other.map(short), [['SOUND_SET', 'Base.step']], 'an open class that declares no step runs what its parent gives it');
});

const STORE_APP = (store) => [['store.ts', store],
  ['app.module.ts', src("import { Module } from '@nestjs/common';", "import { Store, Real } from './store';", "import { UserController } from './user.controller';",
    '@Module({ controllers: [UserController], providers: [{ provide: Store, useClass: Real }] })', 'export class AppModule {}')],
  ['user.controller.ts', src("import { Controller, Get } from '@nestjs/common';", "import { Store } from './store';",
    "@Controller('u')", 'export class UserController { constructor(private readonly store: Store) {} @Get() one() { return this.store.find(); } }')], MAIN];
const ONE = 'symbol:user.controller.ts#UserController.one';

test('a class of the set that inherits the method from a class this engine cannot follow makes the set short', () => {
  const g = bridge([['store.ts', src(
    'export abstract class Store { run() { return this.find(); } abstract find(): number; }',
    'declare function makeBase(): any;', 'const Made = makeBase();',
    'export class Kept extends Store { find() { return 1; } }',
    // Borrowed is a Store by its implements clause, and its find is whatever the class makeBase() returns has.
    'export class Borrowed extends Made implements Store {}')]]).g;
  const edges = callsFrom(g, 'symbol:store.ts#Store.run');
  assert.deepEqual(edges.map(short), [['HEURISTIC', 'Kept.find']]);
  assert.match(edges[0].evidence.dispatch.incomplete, /Borrowed may inherit find from Made, which this engine cannot take for a class/);
});

test('a set the modules settle stays SOUND_SET until one of its classes may run a member this engine does not link', () => {
  const settled = callsFrom(bridge(STORE_APP(src('export abstract class Store { abstract find(): number; }', 'export class Real extends Store { find() { return 1; } }'))).g, ONE);
  assert.deepEqual(settled.map(short), [['SOUND_SET', 'Real.find']]);
  const written = callsFrom(bridge(STORE_APP(src('export abstract class Store { abstract find(): number; }',
    'export class Real extends Store { constructor(o: any) { super(); Object.assign(this, o); } find() { return 1; } }'))).g, ONE);
  // Object.assign(this, o) may give the object a find of its own: nothing this engine links stands for it.
  assert.deepEqual(written, [], JSON.stringify(written.map(short)));
});

test('a this call in a package that may be published is open to its users, whose classes are not read', () => {
  const edges = callsFrom(bridge([['libs/shared/base.ts', BASE.replace('Base', 'Base')]], { publishedOf: (f) => (f.startsWith('libs/') ? 'the package of libs/shared may be published' : null) }).g, 'symbol:libs/shared/base.ts#Base.run');
  assert.deepEqual(edges.map(short), [['HEURISTIC', 'Base.step']]);
  assert.match(edges[0].evidence.dispatch.incomplete, /may be published/);
});

test('a module function whose name the file writes again is only a guess', () => {
  const g = bridge([['f.ts', src('let pick = () => 1;', 'pick = () => 2;', 'export function use() { return pick(); }')]]).g;
  const edges = callsFrom(g, 'symbol:f.ts#use');
  assert.deepEqual(edges.map(short), [['HEURISTIC', 'pick']]);
  assert.match(edges[0].evidence.incomplete, /writes pick again/);
});

// ---------------------------------------------------------------------------
// Prisma: an update whose data holds relation writes alone
// ---------------------------------------------------------------------------

test('prisma_nested_update_with_only_relation_data_writes_no_parent_row', async () => {
  const { readPrismaSchema } = await import('../src/adapters/ts/prisma_schema.mjs');
  // The schema .oss-work/rm67/review4-repro/r4-f1/prisma measured on Prisma 6.19 with SQLite.
  const schema = readPrismaSchema(src(
    'model User {', '  id Int @id', '  email String @unique', '  posts Post[]', '  tags Tag[]', '}',
    'model Post {', '  id Int @id', '  title String @default("")', '  authorEmail String?', '  author User? @relation(fields: [authorEmail], references: [email])', '}',
    'model Tag {', '  id Int @id', '  name String @unique', '  users User[]', '}'));
  const svc = ['svc.ts', src("import { PrismaClient } from '@prisma/client';", 'export class Svc {', '  constructor(private readonly prisma: PrismaClient) {}', '  async run(id, data) {',
    '    await this.prisma.user.update({ where: { id }, data: { posts: { connect: [{ id: 4 }] } }, select: { id: true } });',
    '    await this.prisma.post.update({ where: { id }, data: { author: { connect: { email: "b" } } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { tags: { connect: [{ name: "t8" }] } }, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data, select: { id: true } });',
    '    await this.prisma.user.update({ where: { id }, data: { email: "x", posts: { connect: [{ id: 4 }] } }, select: { id: true } });',
    '  }', '}')];
  const g = new Graph();
  addTsFacts(g, factsOfFile(...svc), { prisma: { schema } });
  const own = (n, table) => g.edges.filter((e) => e.from === `statement:prisma:svc.ts#Svc.run/${n}` && e.type === 'EXECUTES' && e.to === `table:${table}` && !e.evidence.relation).map((e) => `${e.grade} ${e.evidence.access}`).sort();
  // Measured: SELECT User ...; UPDATE Post SET authorEmail ...; SELECT User ... : no UPDATE of User.
  assert.deepEqual(own(0, 'User'), ['EXACT read']);
  // The link sits in Post: UPDATE Post SET authorEmail.
  assert.ok(g.edges.some((e) => e.from === 'statement:prisma:svc.ts#Svc.run/1' && e.to === 'table:Post' && e.evidence.access === 'write'));
  assert.deepEqual(own(2, 'User'), ['EXACT read'], 'a many-to-many connect inserts into the implicit table, not User');
  assert.deepEqual(own(3, 'User'), ['SOUND_SET write'], 'data not written out may set a field of User, or not');
  assert.deepEqual(own(4, 'User'), ['EXACT write']);
});

// ---------------------------------------------------------------------------
// files the run does not read
// ---------------------------------------------------------------------------

function tree(t, files, links = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-ts-r4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const [rel, to] of Object.entries(links)) fs.symlinkSync(to, path.join(dir, rel));
  return dir;
}

function analyze(root) {
  const env = { ...process.env, CASCADE_HOME: path.join(root, '.home'), XDG_CACHE_HOME: path.join(root, '.xdg') };
  execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'app') });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: path.join(root, 'app') });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: path.join(root, 'app') });
  execFileSync('node', [path.join(ENGINE, 'bin/cascade.mjs'), 'init', '--root', path.join(root, 'app'), '--project', 'r4'], { env, stdio: 'ignore' });
  execFileSync('node', [path.join(ENGINE, 'bin/cascade.mjs'), 'analyze', '--root', path.join(root, 'app'), '--project', 'r4'], { env, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(path.join(root, 'app/.cascade/pack/pack.json'), 'utf8'));
}

const NEST = { 'app/package.json': JSON.stringify({ name: 'p', dependencies: { '@nestjs/common': '10.0.0', '@nestjs/core': '10.0.0' } }), 'app/tsconfig.json': '{ "compilerOptions": { "baseUrl": "./" } }', 'app/src/main.ts': MAIN[1] };

test('ts_test_support_dir_holding_a_registered_controller_is_said_not_dropped', (t) => {
  const root = tree(t, {
    ...NEST,
    'app/src/app.module.ts': src("import { Module } from '@nestjs/common';", "import { UsersController } from './users/users.controller';", "import { TestController } from './testing/ab-testing.controller';",
      '@Module({ controllers: [UsersController, TestController] })', 'export class AppModule {}'),
    'app/src/testing/ab-testing.controller.ts': src("import { Controller, Get } from '@nestjs/common';", "@Controller('experiments')", "export class TestController { @Get('ping') ping() { return 'pong'; } }"),
    'app/src/users/users.controller.ts': src("import { Controller, Get } from '@nestjs/common';", "@Controller('users')", 'export class UsersController { @Get() list() { return []; } }'),
    'app/src/users/users.service.mock.ts': src('export class UsersServiceMock { list() { return []; } }'),
    'app/src/users/users.controller.spec.ts': src("import { UsersController } from './users.controller';", 'describe("x", () => {});'),
  });
  const p = analyze(root);
  // The application imports what it registers: the controller is served, whatever its directory is called.
  assert.ok(p.nodes.some((n) => n.id === 'endpoint:GET /experiments/ping'), 'the registered controller is served');
  const said = p.meta.diagnostics.find((d) => d.kind === 'TS_FILES_LEFT_OUT');
  assert.ok(said, 'the test support left out is said');
  assert.match(said.reason, /2 TypeScript file\(s\) found are not read: 2 test support/);
  assert.ok(!p.nodes.some((n) => String(n.id).includes('UsersServiceMock')), 'a mock nothing imports is still left out');
});

test('ts_reach_symlink_out_of_root_is_said', (t) => {
  const root = tree(t, {
    ...NEST,
    'app/src/app.module.ts': src("import { Module } from '@nestjs/common';", "import { OutsideController } from './linkdir/ctrl';", '@Module({ controllers: [OutsideController] })', 'export class AppModule {}'),
    'outside2/ctrl.ts': src("import { Controller, Get } from '@nestjs/common';", "@Controller('out')", 'export class OutsideController { @Get() get() { return 1; } }'),
  }, { 'app/src/linkdir': '../../outside2' });
  const p = analyze(root);
  const said = p.meta.diagnostics.find((d) => d.kind === 'TS_FILES_LEFT_OUT');
  assert.ok(said, 'a file behind a link out of the root is said');
  assert.match(said.reason, /1 whose bytes are outside the analyzed root/);
  assert.match(said.reason, /src\/app\.module\.ts -> src\/linkdir\/ctrl\.ts/);
  assert.ok(!p.nodes.some((n) => n.id === 'endpoint:GET /out'), 'its bytes are not read, so its route is not made');
  const unread = p.meta.diagnostics.find((d) => d.kind === 'TS_CONTROLLER_UNREAD');
  assert.match(unread?.reason ?? '', /AppModule: the controller OutsideController is not a class this engine reads/, 'and the module that registers it says its routes are not served');
});
