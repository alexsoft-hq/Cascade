// ts_bridge.test.mjs — addTsFacts: symbols, routes, calls and Prisma statements, from hand-written tsfacts records.
//
// In the style of test/rules.test.mjs and test/web_bridge.test.mjs: every
// fixture is a small TypeScript project written out here, not a real
// repository, so what is under test is the DECISION the bridge makes over a
// project's records, not one project's spelling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { readPrismaSchema } from '../src/adapters/ts/prisma_schema.mjs';
import { tableKey, columnKey } from '../src/adapters/sql_bridge.mjs';

/** Every file's tsfacts records, concatenated: the bridge reads a whole project at once. */
function recordsOf(files) {
  return files.flatMap(([name, source]) => factsOfFile(name, source));
}

function bridge(files, opts = {}, g = new Graph()) {
  const stats = addTsFacts(g, recordsOf(files), opts);
  return { g, stats };
}

const mayCallEdges = (g) => g.edges.filter((e) => e.type === 'MAY_CALL');
const byRule = (edges, rule) => edges.find((e) => e.evidence.rule === rule);

// ---------------------------------------------------------------------------
// symbols and the routed endpoint
// ---------------------------------------------------------------------------

test('a method and a module function each get their own symbol node', () => {
  const svc = ['svc.ts', [
    'export class UsersService {',
    '  list() {}',
    '}',
    'export function helper() {}',
  ].join('\n')];
  const { g, stats } = bridge([svc]);
  assert.ok(g.nodes.has('symbol:svc.ts#UsersService.list'));
  assert.ok(g.nodes.has('symbol:svc.ts#helper'));
  assert.equal(stats.symbols, 2);
});

/** A minimal served NestJS application with one controller, so route tests need not repeat the bootstrap. */
function nestApp(controllerFileBase, controllerClass, controllerBody) {
  const main = ['main.ts', [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    '  await app.listen(3000);',
    '}',
    'bootstrap();',
  ].join('\n')];
  const appModule = ['app.module.ts', [
    "import { Module } from '@nestjs/common';",
    `import { ${controllerClass} } from './${controllerFileBase}';`,
    `@Module({ controllers: [${controllerClass}] })`,
    'export class AppModule {}',
  ].join('\n')];
  const controller = [`${controllerFileBase}.ts`, controllerBody];
  return [main, appModule, controller];
}

test('an endpoint node gets a HANDLES EXACT edge to its handler symbol, carrying the rule as evidence', () => {
  const files = nestApp('users.controller', 'UsersController', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('users')",
    'export class UsersController {',
    '  @Get() list() {}',
    '}',
  ].join('\n'));
  const { g } = bridge(files);
  const epId = 'endpoint:GET /users';
  const node = g.nodes.get(epId);
  assert.ok(node, 'the endpoint node exists');
  assert.equal(node.handler, 'symbol:users.controller.ts#UsersController.list');
  const edge = g.edges.find((e) => e.type === 'HANDLES' && e.from === epId);
  assert.equal(edge.to, 'symbol:users.controller.ts#UsersController.list');
  assert.equal(edge.grade, 'EXACT');
  assert.equal(edge.evidence.rule, 'nestjs.routes');
});

test('an endpoint already in the graph keeps its own fields and this handler still gets its edge; a different handler is collected into handlers', () => {
  const files = nestApp('users.controller', 'UsersController', [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('users')",
    'export class UsersController {',
    '  @Get() list() {}',
    '}',
  ].join('\n'));
  const g = new Graph();
  const epId = 'endpoint:GET /users';
  g.addNode({ id: epId, path: '/users', httpMethod: 'GET', handler: 'symbol:legacy.php#UsersController.list', owner: 'other-lane' });
  bridge(files, {}, g);
  const node = g.nodes.get(epId);
  assert.equal(node.owner, 'other-lane', 'the pre-existing field is kept');
  assert.equal(node.handler, 'symbol:legacy.php#UsersController.list', 'the original handler is not overwritten');
  assert.deepEqual(node.handlers, ['symbol:legacy.php#UsersController.list', 'symbol:users.controller.ts#UsersController.list'].sort());
  const edge = g.edges.find((e) => e.type === 'HANDLES' && e.from === epId && e.to === 'symbol:users.controller.ts#UsersController.list');
  assert.ok(edge, 'the new handler still gets its own HANDLES edge');
  assert.equal(edge.evidence.rule, 'nestjs.routes');
});

// ---------------------------------------------------------------------------
// MAY_CALL edges
// ---------------------------------------------------------------------------

test('MAY_CALL edges cover a same-class method, an injected field, a static method and an imported function; a local receiver and a package call are only counted', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { Logger } from 'pino';",
    "import { readFileSync } from 'node:fs';",
    "import { helper } from './helper';",
    "import { Formatter } from './formatter';",
    "import { UsersRepository } from './repository';",
    '',
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly logger: Logger, private readonly repo: UsersRepository) {}',
    '',
    '  list() {',
    '    this.helperCall();',
    '    this.helperCall();',
    "    this.logger.log('hi');",
    '    this.repo.find();',
    "    Formatter.format('x');",
    '    helper();',
    "    readFileSync('x');",
    '    const items = [];',
    '    items.map((x) => x);',
    '  }',
    '',
    '  helperCall() {}',
    '}',
  ].join('\n')];
  const helperFile = ['helper.ts', 'export function helper() {}'];
  const formatterFile = ['formatter.ts', [
    'export class Formatter {',
    '  static format(x) { return x; }',
    '}',
  ].join('\n')];
  const repositoryFile = ['repository.ts', [
    'export class UsersRepository {',
    '  find() {}',
    '}',
  ].join('\n')];
  const { g, stats } = bridge([usersService, helperFile, formatterFile, repositoryFile]);
  assert.deepEqual(stats.calls, { resolved: 5, external: 2, unresolved: 1 }, 'a decorator is no call at all, so these totals are exactly the calls the method body writes');

  const may = mayCallEdges(g);
  assert.equal(may.length, 4, 'one edge per caller/target pair even though helperCall is called twice');
  for (const e of may) assert.equal(e.grade, 'SOUND_SET');

  const thisMethod = byRule(may, 'ts-this-method');
  assert.equal(thisMethod.from, 'symbol:users.service.ts#UsersService.list');
  assert.equal(thisMethod.to, 'symbol:users.service.ts#UsersService.helperCall');

  const injectedField = byRule(may, 'ts-injected-field');
  assert.equal(injectedField.from, 'symbol:users.service.ts#UsersService.list');
  assert.equal(injectedField.to, 'symbol:repository.ts#UsersRepository.find');

  const staticMethod = byRule(may, 'ts-static-method');
  assert.equal(staticMethod.to, 'symbol:formatter.ts#Formatter.format');

  const fn = byRule(may, 'ts-function');
  assert.equal(fn.to, 'symbol:helper.ts#helper');
});

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

const SCHEMA_TEXT = [
  'model User {',
  '  id    Int    @id',
  '  name  String',
  '  email String @map("email_address")',
  '  age   Int',
  '  posts Post[]',
  '}',
  '',
  'model Post {',
  '  id     Int    @id',
  '  userId Int',
  '}',
].join('\n');

function prismaOpts(schemaText = SCHEMA_TEXT) {
  return { prisma: { schema: readPrismaSchema(schemaText) } };
}

const prismaServiceFile = ['prisma.service.ts', [
  "import { Injectable } from '@nestjs/common';",
  "import { PrismaClient } from '@prisma/client';",
  '@Injectable()',
  'export class PrismaService extends PrismaClient {}',
].join('\n')];

test('a Prisma client call makes its own statement per call site: reads use the mapped column name, and a second call does not share the first one\'s columns', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async list(email: string) {',
    '    const a = await this.prisma.user.findMany({ where: { email }, select: { id: true, name: true } });',
    '    const b = await this.prisma.user.findMany({ select: { age: true } });',
    '    return [a, b];',
    '  }',
    '}',
  ].join('\n')];
  const { g, stats } = bridge([prismaServiceFile, usersService], prismaOpts());
  assert.equal(stats.prisma.statements, 2);
  assert.equal(stats.prisma.clientCalls, 2);

  const sid0 = 'statement:prisma:users.service.ts#UsersService.list/0';
  const sid1 = 'statement:prisma:users.service.ts#UsersService.list/1';
  const s0 = g.nodes.get(sid0);
  const s1 = g.nodes.get(sid1);
  assert.ok(s0 && s1, 'one statement per call site, in call order');
  assert.equal(s0.statementType, 'select');
  assert.equal(s1.statementType, 'select');

  const readsOf = (sid) => g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to).sort();
  const idOf = (col) => nodeId('column', columnKey(null, 'User', col));
  assert.deepEqual(readsOf(sid0), [idOf('email_address'), idOf('id'), idOf('name')].sort(), 'the @map name is what the call reads, not the field name');
  assert.deepEqual(readsOf(sid1), [idOf('age')]);
  const shared = readsOf(sid0).filter((c) => readsOf(sid1).includes(c));
  assert.deepEqual(shared, [], 'the two call sites never share a column: each statement carries only its own select');

  const implEdges = g.edges.filter((e) => e.type === 'IMPLEMENTS_STMT');
  assert.equal(implEdges.length, 2);
  for (const e of implEdges) {
    assert.equal(e.from, 'symbol:users.service.ts#UsersService.list');
    assert.equal(e.grade, 'EXACT');
    assert.equal(e.evidence.rule, 'prisma.client');
  }

  const executesEdge = g.edges.find((e) => e.from === sid0 && e.type === 'EXECUTES');
  assert.equal(executesEdge.to, nodeId('table', tableKey(null, 'User')));
  assert.equal(executesEdge.grade, 'EXACT');
  assert.equal(executesEdge.evidence.access, 'read');
});

test('a findMany with no select reads every scalar column, the whole row', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async all() {',
    '    return this.prisma.user.findMany();',
    '  }',
    '}',
  ].join('\n')];
  const { g } = bridge([prismaServiceFile, usersService], prismaOpts());
  const sid = 'statement:prisma:users.service.ts#UsersService.all/0';
  const node = g.nodes.get(sid);
  assert.ok(node);
  const reads = g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to).sort();
  const idOf = (col) => nodeId('column', columnKey(null, 'User', col));
  assert.deepEqual(reads, [idOf('age'), idOf('email_address'), idOf('id'), idOf('name')].sort());
});

test('a create writes its data fields, and Prisma returns the whole row it just wrote', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async add(name: string, email: string) {',
    '    return this.prisma.user.create({ data: { name, email } });',
    '  }',
    '}',
  ].join('\n')];
  const { g } = bridge([prismaServiceFile, usersService], prismaOpts());
  const sid = 'statement:prisma:users.service.ts#UsersService.add/0';
  const node = g.nodes.get(sid);
  assert.equal(node.statementType, 'insert');
  const idOf = (col) => nodeId('column', columnKey(null, 'User', col));
  const writes = g.edges.filter((e) => e.from === sid && e.type === 'WRITES').map((e) => e.to).sort();
  assert.deepEqual(writes, [idOf('email_address'), idOf('name')].sort());
  const reads = g.edges.filter((e) => e.from === sid && e.type === 'READS').map((e) => e.to).sort();
  assert.deepEqual(reads, [idOf('age'), idOf('email_address'), idOf('id'), idOf('name')].sort(), 'a create returns the whole created row by default');
});

test('include reaches a relation this statement does not name, and an unknown argument key is said, not dropped', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async withPosts() {',
    '    return this.prisma.user.findMany({ include: { posts: true }, someWeirdOption: true });',
    '  }',
    '}',
  ].join('\n')];
  const { g } = bridge([prismaServiceFile, usersService], prismaOpts());
  const sid = 'statement:prisma:users.service.ts#UsersService.withPosts/0';
  const node = g.nodes.get(sid);
  assert.equal(node.hasUnresolved, true);
  const relation = node.unresolved.find((u) => u.reason === 'relation-not-followed');
  assert.ok(relation, JSON.stringify(node.unresolved));
  assert.match(relation.detail, /User\.posts reaches another table/);
  const unknownArg = node.unresolved.find((u) => u.reason === 'argument-not-read');
  assert.ok(unknownArg, JSON.stringify(node.unresolved));
  assert.match(unknownArg.detail, /someWeirdOption/);
});

test('a where held in a variable makes the statement columnsRuntimeOnly, because its fields are only known when it runs', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async filtered(someFilter) {',
    '    return this.prisma.user.findMany({ where: someFilter, select: { id: true } });',
    '  }',
    '}',
  ].join('\n')];
  const { g } = bridge([prismaServiceFile, usersService], prismaOpts());
  const sid = 'statement:prisma:users.service.ts#UsersService.filtered/0';
  const node = g.nodes.get(sid);
  assert.equal(node.columnsRuntimeOnly, true);
  assert.match(node.columnsRuntimeOnlyReason, /filter/);
});

test('a delegate that names no model counts in stats.prisma.unknownModel, and an operation the rule does not know in unknownOperation; neither makes a statement', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  weird() {',
    '    this.prisma.nonExistent.findMany();',
    '    this.prisma.user.someWeirdOp();',
    '  }',
    '}',
  ].join('\n')];
  const { g, stats } = bridge([prismaServiceFile, usersService], prismaOpts());
  assert.equal(stats.prisma.unknownModel, 1);
  assert.equal(stats.prisma.unknownOperation, 1);
  assert.equal(stats.prisma.statements, 0);
  assert.ok(![...g.nodes.keys()].some((id) => id.startsWith('statement:')), 'no statement is made for either call');
});

test('a client typed with nestjs-prisma\'s PrismaService grades IMPLEMENTS_STMT SOUND_SET and carries evidence.library', () => {
  const libService = ['lib.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from 'nestjs-prisma';",
    '@Injectable()',
    'export class LibService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async list() {',
    '    return this.prisma.user.findMany({ select: { id: true } });',
    '  }',
    '}',
  ].join('\n')];
  const { g } = bridge([libService], prismaOpts());
  const sid = 'statement:prisma:lib.service.ts#LibService.list/0';
  const edge = g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid);
  assert.equal(edge.grade, 'SOUND_SET');
  assert.deepEqual(edge.evidence.library, ['nestjs-prisma.PrismaService']);
  const executesEdge = g.edges.find((e) => e.from === sid && e.type === 'EXECUTES');
  assert.equal(executesEdge.grade, 'SOUND_SET', 'the whole statement is capped at the client role\'s grade');
});

test('with prisma: null, no statement is made and stats.prisma is null', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async list() {',
    '    return this.prisma.user.findMany();',
    '  }',
    '}',
  ].join('\n')];
  const { g, stats } = bridge([prismaServiceFile, usersService], { prisma: null });
  assert.equal(stats.prisma, null);
  assert.ok(![...g.nodes.keys()].some((id) => id.startsWith('statement:')));
});

test('a table already in the graph is reused, not duplicated; tables and columns made fresh are stubs declaredBy prisma', () => {
  const usersService = ['users.service.ts', [
    "import { Injectable } from '@nestjs/common';",
    "import { PrismaService } from './prisma.service';",
    '@Injectable()',
    'export class UsersService {',
    '  constructor(private readonly prisma: PrismaService) {}',
    '',
    '  async list() {',
    '    return this.prisma.user.findMany({ select: { id: true } });',
    '  }',
    '}',
  ].join('\n')];
  const g = new Graph();
  const tableId = nodeId('table', tableKey(null, 'User'));
  g.addNode({ id: tableId, schema: 'main', owner: 'another-lane' });
  bridge([prismaServiceFile, usersService], prismaOpts(), g);
  const tableCount = [...g.nodes.values()].filter((n) => n.id === tableId).length;
  assert.equal(tableCount, 1);
  const table = g.nodes.get(tableId);
  assert.equal(table.owner, 'another-lane', 'the pre-existing table is reused as-is, not overwritten with a stub');
  assert.ok(!table.stub, 'a table already present is not turned into a stub');

  const colId = nodeId('column', columnKey(null, 'User', 'id'));
  const col = g.nodes.get(colId);
  assert.equal(col.stub, true);
  assert.equal(col.declaredBy, 'prisma');
});
