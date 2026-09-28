// ts_dispatch.test.mjs — a call through an abstract class, an interface or a base class: the set of methods it may run, what a Nest module's binding makes of it, and the grade that says whether the set is complete.
//
// In the style of test/ts_bridge.test.mjs: every fixture is a small TypeScript
// project written out here and read by the real worker, so what is under test
// is the DECISION the bridge makes (src/adapters/ts/dispatch.mjs,
// src/adapters/ts/nest_providers.mjs), not one repository's spelling.
//
// The grade: SOUND_SET when the set is complete (`this` is always an instance
// of a class of the tree, unless the type's package may be published; a field
// holds what the modules bind, when they are all read), HEURISTIC with the
// reason when it may be short. Never EXACT, not even for a set of one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';

const recordsOf = (files) => files.flatMap(([name, source]) => factsOfFile(name, source));

function bridge(files, opts = {}) {
  const g = new Graph();
  const stats = addTsFacts(g, recordsOf(files), opts);
  return { g, stats };
}

const src = (...lines) => lines.join('\n');
/** The MAY_CALL edges leaving one symbol, by the symbol they reach. */
const callsFrom = (g, from) => g.edges.filter((e) => e.type === 'MAY_CALL' && e.from === from)
  .sort((a, b) => (a.to < b.to ? -1 : 1));

// A repository written the nestjs-boilerplate way: an abstract class, and two
// implementations of it, one per database.
const REPO = ['repo/user.repository.ts', src(
  'export abstract class UserRepository {',
  '  abstract findById(id: string): Promise<unknown>;',
  '  describe() { return "users"; }',
  '}',
)];
const RELATIONAL = ['repo/relational.repository.ts', src(
  "import { UserRepository } from './user.repository';",
  'export class UsersRelationalRepository extends UserRepository {',
  '  findById(id: string) { return null; }',
  '}',
)];
const DOCUMENT = ['repo/document.repository.ts', src(
  "import { UserRepository } from './user.repository';",
  'export class UsersDocumentRepository implements UserRepository {',
  '  findById(id: string) { return null; }',
  '  describe() { return "documents"; }',
  '}',
)];
const SERVICE = ['users.service.ts', src(
  "import { Injectable } from '@nestjs/common';",
  "import { UserRepository } from './repo/user.repository';",
  '@Injectable()',
  'export class UsersService {',
  '  constructor(private readonly users: UserRepository) {}',
  '  one(id: string) { return this.users.findById(id); }',
  '  name() { return this.users.describe(); }',
  '}',
)];
const ONE = 'symbol:users.service.ts#UsersService.one';
const BOTH = [
  'symbol:repo/document.repository.ts#UsersDocumentRepository.findById',
  'symbol:repo/relational.repository.ts#UsersRelationalRepository.findById',
];

test('a call through a field typed with an abstract class reaches every class of the project that extends or implements it, never the abstract declaration; with no module to settle it, HEURISTIC', () => {
  const { g, stats } = bridge([REPO, RELATIONAL, DOCUMENT, SERVICE]);
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), BOTH);
  for (const e of edges) {
    assert.equal(e.grade, 'HEURISTIC', 'an object of the right shape that names neither class may be what fills the field');
    assert.equal(e.evidence.rule, 'ts-field-dispatch');
    assert.equal(e.evidence.dispatch.type, 'repo/user.repository.ts#UserRepository');
    assert.equal(e.evidence.dispatch.candidates, 2);
    assert.equal(e.evidence.dispatch.incomplete, 'no module binds the type');
  }
  assert.equal(g.nodes.has('symbol:repo/user.repository.ts#UserRepository.findById'), false, 'an abstract method has no body and is no symbol');
  assert.equal(stats.calls.dispatched, 2);
  assert.equal(stats.calls.dispatchEdges, 4);
  assert.equal(stats.calls.dispatchHeuristic, 2);
  assert.match(stats.diagnostics.find((d) => d.kind === 'TS_DISPATCH_INCOMPLETE').reason, /^2 call\(s\) through a type .* graded HEURISTIC: 4 edge\(s\): no module binds the type$/);
});

test('a concrete method of the abstract class is in the set for each subclass that inherits it, beside each override', () => {
  const { g } = bridge([REPO, RELATIONAL, DOCUMENT, SERVICE]);
  assert.deepEqual(callsFrom(g, 'symbol:users.service.ts#UsersService.name').map((e) => e.to), [
    'symbol:repo/document.repository.ts#UsersDocumentRepository.describe',
    'symbol:repo/user.repository.ts#UserRepository.describe',
  ], 'the relational repository runs the inherited describe, the document one its own');
});

test('a call through an interface reaches the classes that implement it: directly, through an interface that extends it, and through a superclass', () => {
  const files = [
    ['store.ts', src(
      'export interface Store { get(key: string): string; }',
      'export interface CachedStore extends Store { flush(): void; }',
    )],
    ['memory.ts', src(
      "import { Store } from './store';",
      'export class MemoryStore implements Store { get(key: string) { return key; } }',
    )],
    ['redis.ts', src(
      "import { CachedStore } from './store';",
      'export class RedisStore implements CachedStore { get(key: string) { return key; } flush() {} }',
    )],
    ['tiered.ts', src(
      "import { MemoryStore } from './memory';",
      'export class TieredStore extends MemoryStore {}',
    )],
    ['reader.ts', src(
      "import { Store } from './store';",
      'export class Reader {',
      '  constructor(private readonly store: Store) {}',
      "  read() { return this.store.get('k'); }",
      '}',
    )],
  ];
  const { g } = bridge(files);
  const edges = callsFrom(g, 'symbol:reader.ts#Reader.read');
  assert.deepEqual(edges.map((e) => e.to), ['symbol:memory.ts#MemoryStore.get', 'symbol:redis.ts#RedisStore.get'],
    'TieredStore runs the get it inherits from MemoryStore, so it adds no member of its own');
  assert.equal(edges[0].evidence.dispatch.type, 'store.ts#Store');
});

const CALC = [
  ['calc.ts', src(
    'export abstract class Calculator {',
    '  run() { return this.compute() + this.label(); }',
    '  protected abstract compute(): number;',
    '  label() { return "base"; }',
    '}',
  )],
  ['twr.ts', src(
    "import { Calculator } from './calc';",
    'export class TwrCalculator extends Calculator { compute() { return 1; } label() { return "twr"; } }',
  )],
  ['mwr.ts', src(
    "import { Calculator } from './calc';",
    'export class MwrCalculator extends Calculator { compute() { return 2; } }',
  )],
];

test('this.m() in a base class reaches each subclass\'s override and the base\'s own declaration, SOUND_SET: this is always an instance of a class of the tree', () => {
  const { g } = bridge(CALC);
  const edges = callsFrom(g, 'symbol:calc.ts#Calculator.run');
  assert.deepEqual(edges.map((e) => `${e.grade} ${e.evidence.rule} ${e.to}`), [
    'SOUND_SET ts-this-dispatch symbol:calc.ts#Calculator.label',
    'SOUND_SET ts-this-dispatch symbol:mwr.ts#MwrCalculator.compute',
    'SOUND_SET ts-this-dispatch symbol:twr.ts#TwrCalculator.compute',
    'SOUND_SET ts-this-dispatch symbol:twr.ts#TwrCalculator.label',
  ]);
  const compute = edges.find((e) => e.to.endsWith('MwrCalculator.compute'));
  assert.deepEqual(compute.evidence.dispatch, { type: 'calc.ts#Calculator', candidates: 2 });
});

test('a type of a package that may be published may be extended outside the tree, so its set is HEURISTIC and says why', () => {
  const publishedOf = (file) => (file === 'calc.ts' ? 'the package of package.json (calc-lib) may be published' : null);
  const { g, stats } = bridge(CALC, { publishedOf });
  const edges = callsFrom(g, 'symbol:calc.ts#Calculator.run');
  assert.equal(edges.length, 4);
  for (const e of edges) {
    assert.equal(e.grade, 'HEURISTIC');
    assert.equal(e.evidence.dispatch.incomplete, 'the package of package.json (calc-lib) may be published');
  }
  assert.equal(stats.calls.dispatchHeuristic, 2);
});

test('a set of one is still a set: SOUND_SET, with its one candidate named, and never EXACT', () => {
  const [base, twr] = CALC;
  const { g } = bridge([base, twr]);
  const edge = callsFrom(g, 'symbol:calc.ts#Calculator.run').find((e) => e.to.endsWith('compute'));
  assert.equal(edge.to, 'symbol:twr.ts#TwrCalculator.compute');
  assert.equal(edge.grade, 'SOUND_SET');
  assert.equal(edge.evidence.dispatch.candidates, 1);
});

test('a type no class of the project extends is linked as it always was, with nothing about a dispatch on the edge', () => {
  const files = [
    ['svc.ts', src(
      "import { Repo } from './repo';",
      'export class Svc {',
      '  constructor(private readonly repo: Repo) {}',
      '  a() { this.repo.find(); this.b(); }',
      '  b() {}',
      '}',
    )],
    ['repo.ts', 'export class Repo { find() {} }'],
  ];
  const { g, stats } = bridge(files);
  const edges = callsFrom(g, 'symbol:svc.ts#Svc.a');
  assert.deepEqual(edges.map((e) => [e.grade, e.evidence.rule, e.to]), [
    ['SOUND_SET', 'ts-injected-field', 'symbol:repo.ts#Repo.find'],
    ['SOUND_SET', 'ts-this-method', 'symbol:svc.ts#Svc.b'],
  ]);
  for (const e of edges) assert.deepEqual(Object.keys(e.evidence).sort(), ['basis', 'line', 'rule']);
  assert.deepEqual(stats.calls, { resolved: 2, external: 0, unresolved: 0 }, 'no dispatch count when none happened');
});

// ---------------------------------------------------------------------------
// what the Nest modules bind
// ---------------------------------------------------------------------------

const MAIN = ['main.ts', src(
  "import { NestFactory } from '@nestjs/core';",
  "import { AppModule } from './app.module';",
  'async function bootstrap() {',
  '  const app = await NestFactory.create(AppModule);',
  '  await app.listen(3000);',
  '}',
  'bootstrap();',
)];

/** A persistence module binding UserRepository as `providers` says. */
const persistence = (name, providers, file = 'persistence.module.ts') => [file, src(
  "import { Module } from '@nestjs/common';",
  "import { UserRepository } from './repo/user.repository';",
  "import { UsersRelationalRepository } from './repo/relational.repository';",
  "import { UsersDocumentRepository } from './repo/document.repository';",
  `@Module({ providers: [${providers}], exports: [UserRepository] })`,
  `export class ${name} {}`,
)];

/** An application whose root module imports what `imports` names, and provides UsersService. */
function app(providers, { imports = 'RelationalPersistenceModule', service = SERVICE, more = [], appProviders = 'UsersService', appImports = [] } = {}) {
  return [
    MAIN, REPO, RELATIONAL, DOCUMENT, service, ...more,
    persistence('RelationalPersistenceModule', providers),
    ['app.module.ts', src(
      "import { Module } from '@nestjs/common';",
      "import { RelationalPersistenceModule } from './persistence.module';",
      "import { DocumentPersistenceModule } from './document.module';",
      "import { UsersService } from './users.service';",
      ...appImports,
      'const chosen = isDocument() ? DocumentPersistenceModule : RelationalPersistenceModule;',
      `@Module({ imports: [${imports}], providers: [${appProviders}] })`,
      'export class AppModule {}',
    )],
  ];
}
const RELATIONAL_BINDING = '{ provide: UserRepository, useClass: UsersRelationalRepository }';

test('the modules the application loads bind the abstract class with useClass: the set narrows to that class, SOUND_SET, and the edge names the module', () => {
  const { g, stats } = bridge(app(RELATIONAL_BINDING));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), ['symbol:repo/relational.repository.ts#UsersRelationalRepository.findById']);
  assert.equal(edges[0].grade, 'SOUND_SET', 'settled by what the source binds, and still a set');
  assert.deepEqual(edges[0].evidence.dispatch, {
    type: 'repo/user.repository.ts#UserRepository', candidates: 1, bound: ['persistence.module.ts#RelationalPersistenceModule'],
    boundBy: 'the modules the application loads', narrowedFrom: 2,
  });
  assert.equal(stats.calls.narrowed, 2, 'both calls through the field');
  assert.equal(stats.calls.dispatchHeuristic, undefined);
});

test('when the application picks its module through a constant that holds one or another, it loads both as far as this engine knows: both bindings, SOUND_SET', () => {
  const document = persistence('DocumentPersistenceModule', '{ provide: UserRepository, useClass: UsersDocumentRepository }', 'document.module.ts');
  const { g, stats } = bridge(app(RELATIONAL_BINDING, { imports: 'chosen', more: [document] }));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), BOTH, 'nestjs-boilerplate picks its persistence module like this');
  for (const e of edges) {
    assert.equal(e.grade, 'SOUND_SET');
    assert.deepEqual(e.evidence.dispatch.bound, ['document.module.ts#DocumentPersistenceModule', 'persistence.module.ts#RelationalPersistenceModule']);
    assert.equal(e.evidence.dispatch.boundBy, 'the modules the application loads', 'the constant names both, so both are walked');
  }
  assert.equal(stats.calls.narrowed, 2);
});

test('a module a static method returns binds like any other, read from the object it returns', () => {
  const dynamic = ['dynamic.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { UserRepository } from './repo/user.repository';",
    "import { UsersDocumentRepository } from './repo/document.repository';",
    '@Module({})',
    'export class DynamicPersistenceModule {',
    '  static forRoot() {',
    '    return { module: DynamicPersistenceModule, providers: [{ provide: UserRepository, useClass: UsersDocumentRepository }] };',
    '  }',
    '}',
  )];
  const { g } = bridge(app(RELATIONAL_BINDING, {
    imports: 'RelationalPersistenceModule, DynamicPersistenceModule.forRoot()', more: [dynamic], appImports: ["import { DynamicPersistenceModule } from './dynamic.module';"],
  }));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), BOTH);
  assert.equal(edges[0].grade, 'SOUND_SET');
  assert.deepEqual(edges[0].evidence.dispatch.bound, ['dynamic.module.ts#DynamicPersistenceModule.forRoot', 'persistence.module.ts#RelationalPersistenceModule']);
  assert.equal(edges[0].evidence.dispatch.boundBy, 'the modules the application loads');
});

test('a binding made by a factory is not read: the set stays the hierarchy, HEURISTIC, the edge says why, and a diagnostic names the type', () => {
  const { g, stats } = bridge(app('{ provide: UserRepository, useFactory: () => new UsersDocumentRepository() }'));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => [e.grade, e.to]), BOTH.map((to) => ['HEURISTIC', to]));
  assert.match(edges[0].evidence.dispatch.incomplete, /bound by useFactory in persistence\.module\.ts#RelationalPersistenceModule, which is not read/);
  const d = stats.diagnostics.find((x) => x.kind === 'TS_BINDING_NOT_READ');
  assert.match(d.reason, /^repo\/user\.repository\.ts#UserRepository: bound by useFactory/);
  assert.equal(stats.calls.narrowed, undefined);
});

test('a provider list this engine cannot read anywhere in the tree may bind the type, so an unsettled set stays HEURISTIC', () => {
  const spread = ['spread.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { providers } from './providers';",
    '@Module({ providers: [...providers] })',
    'export class SpreadModule {}',
  )];
  // No loaded module provides UsersService, so every module of the tree is asked, the spread one among them.
  const { g } = bridge(app(RELATIONAL_BINDING, { more: [spread], appProviders: '' }));
  const edges = callsFrom(g, ONE);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /^spread\.module\.ts#SpreadModule: its providers are not a list this engine can read whole, so one may bind the type$/);
});

test('a package\'s module handed the type may bind it, so the set is not settled', () => {
  const handed = ['handed.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { CqrsModule } from '@nestjs/cqrs';",
    "import { UserRepository } from './repo/user.repository';",
    '@Module({ imports: [CqrsModule.forFeature([UserRepository])] })',
    'export class HandedModule {}',
  )];
  // What an async package module only reads (imports, inject, useFactory) is not handed to it to bind: ghostfolio's CacheModule.registerAsync.
  const asyncOptions = ['async.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { CacheModule } from '@nestjs/cache-manager';",
    "import { RelationalPersistenceModule } from './persistence.module';",
    "import { UserRepository } from './repo/user.repository';",
    '@Module({ imports: [CacheModule.registerAsync({ imports: [RelationalPersistenceModule], inject: [UserRepository], useFactory: (r) => ({}) })] })',
    'export class AsyncModule {}',
  )];
  const reads = bridge(app(RELATIONAL_BINDING, { imports: 'RelationalPersistenceModule, AsyncModule', more: [asyncOptions], appImports: ["import { AsyncModule } from './async.module';"] })).g;
  assert.equal(callsFrom(reads, ONE)[0].grade, 'SOUND_SET');
  const { g } = bridge(app(RELATIONAL_BINDING, { imports: 'RelationalPersistenceModule, HandedModule', more: [handed], appImports: ["import { HandedModule } from './handed.module';"] }));
  assert.match(callsFrom(g, ONE)[0].evidence.dispatch.incomplete, /^handed\.module\.ts#HandedModule: CqrsModule\.forFeature\(\.\.\.\) is handed UserRepository, and a package's module may bind it$/);
});

test('a parameter that names its token with @Inject is filled by that token, not by its type: HEURISTIC', () => {
  const service = ['users.service.ts', src(
    "import { Injectable, Inject } from '@nestjs/common';",
    "import { UserRepository } from './repo/user.repository';",
    '@Injectable()',
    'export class UsersService {',
    "  constructor(@Inject('USERS') private readonly users: UserRepository) {}",
    '  one(id: string) { return this.users.findById(id); }',
    '}',
  )];
  const { g } = bridge(app(RELATIONAL_BINDING, { service }));
  const edges = callsFrom(g, ONE);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /^the parameter is filled by the token @Inject names, not by its type$/);
});

test('a class the code makes with new is handed whatever it likes, so its field is not what a module binds: HEURISTIC', () => {
  const maker = ['maker.ts', src(
    "import { UsersService } from './users.service';",
    'export function make(repo) { return new UsersService(repo); }',
  )];
  const { g } = bridge(app(RELATIONAL_BINDING, { more: [maker] }));
  const edges = callsFrom(g, ONE);
  assert.equal(edges.length, 2);
  assert.match(edges[0].evidence.dispatch.incomplete, /^maker\.ts:2 makes the class with new, handing it whatever it likes$/);
});

test('a new through a local is known by the local it goes through, not by its name: it may make any class, this one too', () => {
  const maker = ['maker.ts', src(
    "import { UsersService } from './users.service';",
    'export function make(repo) {',
    '  const Svc = UsersService;',
    '  return new Svc(repo);',
    '}',
  )];
  const { g } = bridge(app(RELATIONAL_BINDING, { more: [maker] }));
  const edges = callsFrom(g, ONE);
  assert.equal(edges.length, 2);
  assert.equal(edges[0].grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /^maker\.ts:4, through Svc, which may hold any class, makes the class with new/);
  // A local that only shares the class's name is not the class either.
  const shadow = ['shadow.ts', src(
    'export function make(repo) {',
    '  const UsersService = class {};',
    '  return new UsersService(repo);',
    '}',
  )];
  const shadowed = bridge(app(RELATIONAL_BINDING, { more: [shadow] })).g;
  assert.match(callsFrom(shadowed, ONE)[0].evidence.dispatch.incomplete, /^shadow\.ts:3, through UsersService, which may hold any class/);
});

test('a new through a field declared with a package\'s type makes the package\'s object, and settles nothing away; one through any other field may make any class', () => {
  const seed = (type, imports) => ['seed.ts', src(
    ...imports,
    'export class Seed {',
    `  constructor(private readonly model: ${type}) {}`,
    '  run() { return new this.model({ email: "a" }); }',
    '}',
  )];
  const mongoose = bridge(app(RELATIONAL_BINDING, { more: [seed('Model<User>', ["import { Model } from 'mongoose';"])] })).g;
  assert.equal(callsFrom(mongoose, ONE)[0].grade, 'SOUND_SET', 'nestjs-boilerplate\'s document seeds do this');
  const own = bridge(app(RELATIONAL_BINDING, { more: [seed('Factory', ["import { Factory } from './factory';"]), ['factory.ts', 'export class Factory {}']] })).g;
  assert.match(callsFrom(own, ONE)[0].evidence.dispatch.incomplete, /^seed\.ts:4, through this\.model, which may hold any class/);
});

test('a class no loaded module provides, and nobody makes with new, is settled by every module of the tree', () => {
  const { g } = bridge(app(RELATIONAL_BINDING, { appProviders: '' }));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), ['symbol:repo/relational.repository.ts#UsersRelationalRepository.findById']);
  assert.equal(edges[0].grade, 'SOUND_SET');
  assert.equal(edges[0].evidence.dispatch.boundBy, 'every module of the tree');
});

// ---------------------------------------------------------------------------
// review 3b: what the tree reading does not cover, a class token bound to
// another object, a parameter decorator this engine does not know, and the
// overrides a property or a mixin makes
// ---------------------------------------------------------------------------

const REPO3 = ['repo.ts', src(
  'export abstract class Repo { abstract find(): number; }',
  'export class A extends Repo { find() { return 1; } }',
  'export class B extends Repo { find() { return 2; } }',
  'export class C extends Repo { find() { return 3; } }',
)];
const MAIN3 = ['main.ts', src(
  "import { NestFactory } from '@nestjs/core';",
  "import { AppModule } from './app.module';",
  'async function bootstrap() { const app = await NestFactory.create(AppModule); await app.listen(3000); }',
  'bootstrap();',
)];
const CTRL3 = (param = 'private readonly repo: Repo', imports = []) => ['c.controller.ts', src(
  "import { Controller, Get, Inject, Optional } from '@nestjs/common';",
  "import { Repo } from './repo';",
  ...imports,
  "@Controller('c')",
  'export class CController {',
  `  constructor(${param}) {}`,
  '  @Get() list() { return this.repo.find(); }',
  '}',
)];
const LIST3 = 'symbol:c.controller.ts#CController.list';
const targets = (g, from) => callsFrom(g, from).map((e) => e.to.slice(e.to.indexOf('#') + 1));

test('a class loaded as a module that no module decorator this engine reads is on may bind anything, so the set is not settled', () => {
  const wrapped = ['wrapped.module.ts', src(
    "import { MyModule } from './my-module';",
    "import { Repo, B } from './repo';",
    '@MyModule({ providers: [{ provide: Repo, useClass: B }] })',
    'export class WrappedModule {}',
  )];
  const mod = ['app.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { CController } from './c.controller';",
    "import { WrappedModule } from './wrapped.module';",
    "import { Repo, A } from './repo';",
    '@Module({ imports: [WrappedModule], controllers: [CController], providers: [{ provide: Repo, useClass: A }] })',
    'export class AppModule {}',
  )];
  const { g } = bridge([REPO3, CTRL3(), wrapped, mod, MAIN3, ['my-module.ts', 'export const MyModule = (o) => (t) => t;']]);
  const edges = callsFrom(g, LIST3);
  assert.equal(edges[0].grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /^wrapped\.module\.ts#WrappedModule: loaded as a module, and no module decorator this engine reads is on it/);
});

test('dispatch_tree_fallback_includes_function_built_dynamic_module: a module an ordinary function builds is a binding this engine does not read, so the tree does not settle the set', () => {
  const persist = ['persist.ts', src(
    "import { Module, DynamicModule } from '@nestjs/common';",
    "import { Repo, A, B } from './repo';",
    'export function relationalPersistence(): DynamicModule { return { module: RelHolder, providers: [{ provide: Repo, useClass: A }], exports: [Repo] }; }',
    '@Module({}) export class RelHolder {}',
    '@Module({ providers: [{ provide: Repo, useClass: B }], exports: [Repo] }) export class DocumentPersistenceModule {}',
  )];
  const mod = ['app.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { CController } from './c.controller';",
    "import { relationalPersistence } from './persist';",
    '@Module({ imports: [relationalPersistence()], controllers: [CController] })',
    'export class AppModule {}',
  )];
  const { g } = bridge([REPO3, CTRL3(), persist, mod, MAIN3]);
  const edges = callsFrom(g, LIST3);
  assert.ok(targets(g, LIST3).includes('A.find'), 'the class the function binds is what runs');
  for (const e of edges) assert.equal(e.grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /relationalPersistence\(\.\.\.\)/);
});

test('custom_inject_decorator_is_not_settled_by_type_binding: a parameter decorator the nestjs pack does not name may inject by token, so the type binding does not settle it', () => {
  const inject = ['inject.ts', src(
    "import { Inject } from '@nestjs/common';",
    "export const TOKEN = 'T';",
    'export const InjectRepo = () => Inject(TOKEN);',
  )];
  const mod = ['app.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { CController } from './c.controller';",
    "import { Repo, A, C } from './repo';",
    "import { TOKEN } from './inject';",
    '@Module({ controllers: [CController], providers: [{ provide: Repo, useClass: A }, { provide: TOKEN, useClass: C }] })',
    'export class AppModule {}',
  )];
  const custom = bridge([REPO3, inject, CTRL3('@InjectRepo() private readonly repo: Repo', ["import { InjectRepo } from './inject';"]), mod, MAIN3]).g;
  assert.deepEqual(targets(custom, LIST3), ['A.find', 'B.find', 'C.find']);
  for (const e of callsFrom(custom, LIST3)) assert.equal(e.grade, 'HEURISTIC');
  assert.match(callsFrom(custom, LIST3)[0].evidence.dispatch.incomplete, /InjectRepo/);
  // A decorator the pack names as harmless changes nothing: the binding settles it.
  const optional = bridge([REPO3, inject, CTRL3('@Optional() private readonly repo: Repo'), mod, MAIN3]).g;
  assert.deepEqual(callsFrom(optional, LIST3).map((e) => [e.grade, e.to.slice(e.to.indexOf('#') + 1)]), [['SOUND_SET', 'A.find']]);
});

test('plain_class_token_rebound_by_provider_is_not_sound_set: a class no class extends consults the bindings of its token too', () => {
  const svc = ['users.service.ts', src(
    "import { Injectable } from '@nestjs/common';",
    '@Injectable()',
    'export class UsersService { find() { return 1; } }',
  )];
  const fake = ['fake.service.ts', src(
    "import { Injectable } from '@nestjs/common';",
    '@Injectable()',
    'export class FakeUsersService { find() { return 2; } }',
  )];
  const ctrl = ['users.controller.ts', src(
    "import { Controller, Get } from '@nestjs/common';",
    "import { UsersService } from './users.service';",
    "@Controller('users')",
    'export class UsersController {',
    '  constructor(private readonly users: UsersService) {}',
    '  @Get() list() { return this.users.find(); }',
    '}',
  )];
  const mod = (providers) => ['app.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { UsersController } from './users.controller';",
    "import { UsersService } from './users.service';",
    "import { FakeUsersService } from './fake.service';",
    `@Module({ controllers: [UsersController], providers: [${providers}] })`,
    'export class AppModule {}',
  )];
  const LIST = 'symbol:users.controller.ts#UsersController.list';
  const run = (providers) => callsFrom(bridge([svc, fake, ctrl, mod(providers), MAIN3]).g, LIST);
  const plain = run('UsersService');
  assert.deepEqual(plain.map((e) => [e.grade, e.evidence.rule, e.to]), [['SOUND_SET', 'ts-injected-field', 'symbol:users.service.ts#UsersService.find']], 'bound to itself: as it always was');
  assert.equal(plain[0].evidence.dispatch, undefined);
  const useClass = run('{ provide: UsersService, useClass: FakeUsersService }');
  assert.deepEqual(useClass.map((e) => [e.grade, e.to]), [['SOUND_SET', 'symbol:fake.service.ts#FakeUsersService.find']], 'the class the module binds is what runs');
  for (const how of ['useValue: { find: () => 3 }', 'useFactory: () => new FakeUsersService()', 'useExisting: FakeUsersService']) {
    const edges = run(`FakeUsersService, { provide: UsersService, ${how} }`);
    assert.ok(edges.length > 0, how);
    for (const e of edges) assert.equal(e.grade, 'HEURISTIC', how);
    assert.match(edges[0].evidence.dispatch.incomplete, new RegExp(how.split(':')[0]), how);
  }
});

test('this_dispatch_includes_property_and_mixin_overrides: a function held in a property, and a class a mixin function returns, override a method too', () => {
  const arrow = bridge([['base.ts', src(
    'export class Base { run() { return this.step(); } step() { return 1; } }',
    'export class Sub extends Base { step = () => 2; }',
  )]]).g;
  assert.deepEqual(targets(arrow, 'symbol:base.ts#Base.run'), ['Base.step', 'Sub.step']);
  assert.ok(arrow.nodes.has('symbol:base.ts#Sub.step'), 'the property\'s function is a symbol');
  const mixin = bridge([['mix.ts', src(
    'type Ctor = new (...a: any[]) => {};',
    'export function Loud<T extends Ctor>(B: T) { return class extends B { step() { return 9; } }; }',
    'export class Base { run() { return this.step(); } step() { return 1; } }',
    'export class Mixed extends Loud(Base) {}',
  )]]).g;
  assert.deepEqual(targets(mixin, 'symbol:mix.ts#Base.run'), ['Base.step', 'Loud().step']);
  for (const e of callsFrom(mixin, 'symbol:mix.ts#Base.run')) assert.equal(e.grade, 'SOUND_SET');
});

test('a class that extends a call this engine cannot read may be a subclass with its own overrides, so this.m() on the classes it names is HEURISTIC', () => {
  const g = bridge([['opaque.ts', src(
    "import { makeMixin } from 'some-package';",
    'export class Base { run() { return this.step(); } step() { return 1; } }',
    'export class Other extends Base { step() { return 2; } }',
    'export class Mixed extends makeMixin(Base) {}',
  )]]).g;
  const edges = callsFrom(g, 'symbol:opaque.ts#Base.run');
  assert.deepEqual(edges.map((e) => e.to.slice(e.to.indexOf('#') + 1)), ['Base.step', 'Other.step']);
  for (const e of edges) assert.equal(e.grade, 'HEURISTIC');
  assert.match(edges[0].evidence.dispatch.incomplete, /^opaque\.ts#Mixed extends makeMixin\(\.\.\.\), a class this engine does not read, which may override the method$/);
});
