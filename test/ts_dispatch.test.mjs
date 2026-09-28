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
function app(providers, { imports = 'RelationalPersistenceModule', service = SERVICE, more = [], appProviders = 'UsersService' } = {}) {
  return [
    MAIN, REPO, RELATIONAL, DOCUMENT, service, ...more,
    persistence('RelationalPersistenceModule', providers),
    ['app.module.ts', src(
      "import { Module } from '@nestjs/common';",
      "import { RelationalPersistenceModule } from './persistence.module';",
      "import { DocumentPersistenceModule } from './document.module';",
      "import { UsersService } from './users.service';",
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

test('when the application picks its module through a variable, every module of the tree settles the set: both bindings, SOUND_SET', () => {
  const document = persistence('DocumentPersistenceModule', '{ provide: UserRepository, useClass: UsersDocumentRepository }', 'document.module.ts');
  const { g, stats } = bridge(app(RELATIONAL_BINDING, { imports: 'chosen', more: [document] }));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), BOTH, 'nestjs-boilerplate picks its persistence module like this');
  for (const e of edges) {
    assert.equal(e.grade, 'SOUND_SET');
    assert.deepEqual(e.evidence.dispatch.bound, ['document.module.ts#DocumentPersistenceModule', 'persistence.module.ts#RelationalPersistenceModule']);
    assert.equal(e.evidence.dispatch.boundBy, 'every module of the tree');
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
  const { g } = bridge(app(RELATIONAL_BINDING, { imports: 'chosen', more: [dynamic] }));
  const edges = callsFrom(g, ONE);
  assert.deepEqual(edges.map((e) => e.to), BOTH);
  assert.deepEqual(edges[0].evidence.dispatch.bound, ['dynamic.module.ts#DynamicPersistenceModule.forRoot', 'persistence.module.ts#RelationalPersistenceModule']);
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
  const { g } = bridge(app(RELATIONAL_BINDING, { imports: 'chosen', more: [spread] }));
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
  const { g } = bridge(app(RELATIONAL_BINDING, { imports: 'chosen', more: [handed] }));
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
  assert.match(edges[0].evidence.dispatch.incomplete, /filled by the token its decorator names/);
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
