// typeorm.test.mjs — the TypeORM part of the TypeScript lane: the worker records it reads, the entities as a catalog, the naming strategy, and one statement per call site.
//
// In the style of test/ts_bridge.test.mjs: every fixture is a small TypeScript
// project written out here, so what is under test is the decision the lane
// makes over a project's records, not one repository's spelling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Graph } from '../src/core/graph.mjs';
import { addTsFacts } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { buildRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { normalizeProfile, validateProfile, ProfileError, PROFILE_KEY_CONSUMERS } from '../src/core/profile.mjs';
import { typeormDeclared } from '../src/cli/commands/analyze/lanes.mjs';

const recordsOf = (files) => files.flatMap(([name, source]) => factsOfFile(name, source));

function bridge(files, opts = {}) {
  const g = new Graph();
  const stats = addTsFacts(g, recordsOf(files), opts);
  return { g, stats };
}

const src = (...lines) => lines.join('\n');
const edgesFrom = (g, id, type) => g.edges.filter((e) => e.from === id && (!type || e.type === type));
const gradeOf = (g, from, type, to) => g.edges.find((e) => e.from === from && e.type === type && e.to === to)?.grade ?? null;

const MODULE_KNOWN = ['app.module.ts', src(
  "import { Module } from '@nestjs/common';",
  "import { TypeOrmModule } from '@nestjs/typeorm';",
  "@Module({ imports: [TypeOrmModule.forRoot({ type: 'postgres' })] })",
  'export class AppModule {}',
)];

const USER_ENTITY = ['user.entity.ts', src(
  "import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, DeleteDateColumn } from 'typeorm';",
  "import { Role } from './role.entity';",
  "@Entity('users')",
  'export class User {',
  '  @PrimaryGeneratedColumn() id: number;',
  '  @Column() email: string;',
  "  @Column({ name: 'display_name' }) displayName: string;",
  '  @Column() bio: string;',
  '  @DeleteDateColumn() deletedAt: Date;',
  '  @ManyToOne(() => Role, { eager: true }) role: Role;',
  '}',
)];

const ROLE_ENTITY = ['role.entity.ts', src(
  "import { Entity, Column, PrimaryColumn } from 'typeorm';",
  '@Entity()',
  'export class Role {',
  '  @PrimaryColumn() id: number;',
  '  @Column() title: string;',
  '}',
)];

const service = (body) => ['users.service.ts', src(
  "import { Injectable } from '@nestjs/common';",
  "import { InjectRepository } from '@nestjs/typeorm';",
  "import { Repository, DataSource, EntityManager } from 'typeorm';",
  "import { User } from './user.entity';",
  "import { Role } from './role.entity';",
  '@Injectable()',
  'export class UsersService {',
  '  constructor(@InjectRepository(User) private readonly users: Repository<User>, private ds: DataSource) {}',
  ...body,
  '}',
)];

const SID = (member, n) => `statement:typeorm:users.service.ts#UsersService.${member}/${n}`;

// ---------------------------------------------------------------------------
// the worker: what it records for this lane
// ---------------------------------------------------------------------------

test('the worker records the type arguments of a field and of an extends clause, what a method returns, and every new', () => {
  const recs = factsOfFile('r.ts', src(
    "import { Repository, DataSource } from 'typeorm';",
    'export const ds = new DataSource({ type: "mysql" });',
    'export class TagRepo extends Repository<Tag> {',
    '  constructor(private readonly r: Repository<Tag>) { super(); }',
    '  opts() { return { a: 1 }; }',
    '}',
  ));
  assert.deepEqual(recs.find((r) => r.kind === 'class').extendsArgs, ['Tag']);
  assert.deepEqual(recs.find((r) => r.kind === 'ctorParam').typeArgs, ['Tag']);
  assert.deepEqual(recs.find((r) => r.kind === 'method' && r.name === 'opts').returns, [{ k: 'obj', v: { a: { k: 'num', v: 1 } } }]);
  const n = recs.find((r) => r.kind === 'new');
  assert.equal(n.callee, 'DataSource');
  assert.equal(n.holder, 'ds');
  assert.deepEqual(n.args[0].v.type, { k: 'str', v: 'mysql' });
});

test('the worker records a call made on another call\'s result as a step of the first call\'s chain, with the name the whole is held in', () => {
  const recs = factsOfFile('c.ts', src(
    'export class S {',
    "  m() { const qb = this.repo.createQueryBuilder('u').where('u.a = 1'); return qb.getMany(); }",
    '}',
  ));
  const calls = recs.filter((r) => r.kind === 'call');
  assert.deepEqual(calls.map((c) => c.callee), ['this.repo.createQueryBuilder', 'qb.getMany'], 'a chained step is not a call record of its own, so no other count moves');
  assert.deepEqual(calls[0].chain.map((s) => s.name), ['where']);
  assert.equal(calls[0].chainHolder, 'qb');
  assert.equal(calls[0].holder, undefined, 'the first call\'s own value is not what qb holds');
});

// ---------------------------------------------------------------------------
// the entities as a catalog, under the naming strategy the options name
// ---------------------------------------------------------------------------

test('every entity column is a catalog node, read or not, and a relation that owns its join column is a JOINS edge', () => {
  const { g, stats } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([])]);
  const t = stats.typeorm;
  assert.equal(t.entities, 2);
  assert.equal(t.naming.known, true);
  for (const c of ['id', 'email', 'display_name', 'bio', 'deletedAt', 'roleId']) assert.ok(g.nodes.has(`column:users.${c}`), c);
  assert.ok(g.nodes.has('table:role'), 'a class name in snake case, the default strategy');
  const table = g.nodes.get('table:users');
  assert.equal(table.declaredBy, 'typeorm');
  assert.equal(table.stub, true, 'declared by the mapping, never presented as read from a schema');
  const join = g.edges.find((e) => e.type === 'JOINS');
  assert.deepEqual([join.from, join.to, join.grade], ['table:role', 'table:users', 'EXACT']);
  assert.deepEqual(join.evidence.columns, ['users.roleId=role.id']);
});

test('forRoot() with no options leaves the strategy, the prefix and the schema to run time: no table name is EXACT, and the run says why', () => {
  const unread = ['app.module.ts', MODULE_KNOWN[1].replace("TypeOrmModule.forRoot({ type: 'postgres' })", 'TypeOrmModule.forRoot()')];
  const { g, stats } = bridge([unread, USER_ENTITY, ROLE_ENTITY, service(['  one(email: string) { return this.users.findOneBy({ email }); }'])]);
  assert.equal(stats.typeorm.naming.known, false);
  assert.match(stats.typeorm.naming.reason, /forRoot at app\.module\.ts:\d+: it takes no options in the source/);
  const sid = SID('one', 0);
  // @Entity('users') is written, but an entityPrefix or a DataSource schema the run does not know may change it (EntityMetadata.build).
  assert.equal(gradeOf(g, sid, 'EXECUTES', 'table:users'), 'HEURISTIC');
  assert.equal(gradeOf(g, sid, 'READS', 'column:users.email'), 'HEURISTIC', 'a property name another strategy would change');
  assert.equal(g.edges.find((e) => e.type === 'DECLARES' && e.to === 'column:users.display_name').grade, 'HEURISTIC', 'its table may be another');
  const diag = stats.diagnostics.find((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED');
  assert.match(diag.reason, /the naming strategy is not known.*the entityPrefix is not known.*the DataSource schema is not known/);
});

test('SnakeNamingStrategy named in the options is read, and what it derives is EXACT; a class this engine does not model is not', () => {
  const snake = (cls, mod) => ['data-source.ts', src(
    "import { DataSource } from 'typeorm';",
    `import { ${cls} } from '${mod}';`,
    `export const ds = new DataSource({ type: 'postgres', namingStrategy: new ${cls}() });`,
  )];
  const known = bridge([snake('SnakeNamingStrategy', 'typeorm-naming-strategies'), USER_ENTITY, ROLE_ENTITY]);
  assert.equal(known.stats.typeorm.naming.strategy, 'snake');
  assert.equal(known.stats.typeorm.naming.known, true);
  assert.ok(known.g.nodes.has('column:users.deleted_at') && known.g.nodes.has('column:users.role_id'));
  const own = bridge([snake('MyNaming', './my-naming'), USER_ENTITY, ROLE_ENTITY]);
  assert.equal(own.stats.typeorm.naming.known, false);
  assert.match(own.stats.typeorm.naming.reason, /namingStrategy is MyNaming, a class this engine does not model/);
});

test('a factory the options are handed to is not another place they are written: forRootAsync with an options class reads that class\'s return', () => {
  const app = ['app.module.ts', src(
    "import { Module } from '@nestjs/common';",
    "import { TypeOrmModule } from '@nestjs/typeorm';",
    "import { DataSource } from 'typeorm';",
    "import { Config } from './config';",
    '@Module({ imports: [TypeOrmModule.forRootAsync({ useClass: Config, dataSourceFactory: async (options) => new DataSource(options).initialize() })] })',
    'export class AppModule {}',
  )];
  const config = ['config.ts', src('export class Config {', "  createTypeOrmOptions() { return { type: 'postgres', synchronize: false }; }", '}')];
  const { stats } = bridge([app, config, USER_ENTITY, ROLE_ENTITY]);
  assert.equal(stats.typeorm.naming.known, true, stats.typeorm.naming.reason);
  assert.deepEqual(stats.typeorm.naming.sites.map((s) => s.how), ['TypeOrmModule.forRootAsync']);
});

// ---------------------------------------------------------------------------
// statements: one per call site
// ---------------------------------------------------------------------------

test('a repository call is a statement of its own, numbered among its method\'s TypeORM calls, with EXACT reads of what it names', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  async m(email: string) {',
    '    const u = this.users.create({ email });',
    '    await this.users.findOne({ where: { email }, select: { bio: true } });',
    '    return this.users.update({ id: 1 }, { bio: "x" });',
    '  }',
  ])]);
  const first = g.nodes.get(SID('m', 0));
  assert.ok(first, 'create sends no SQL and takes no place');
  assert.equal(first.statementType, 'select');
  assert.equal(first.source, 'typeorm');
  assert.equal(gradeOf(g, 'symbol:users.service.ts#UsersService.m', 'IMPLEMENTS_STMT', SID('m', 0)), 'EXACT');
  const reads = edgesFrom(g, SID('m', 0), 'READS').map((e) => e.to).sort();
  // A partial select still returns the primary key, and the eager role is joined and selected whole with it.
  assert.deepEqual(reads, ['column:role.id', 'column:role.title', 'column:users.bio', 'column:users.email', 'column:users.id', 'column:users.roleId']);
  const second = g.nodes.get(SID('m', 1));
  assert.equal(second.statementType, 'update');
  assert.equal(gradeOf(g, SID('m', 1), 'WRITES', 'column:users.bio'), 'EXACT');
  assert.equal(gradeOf(g, SID('m', 1), 'READS', 'column:users.id'), 'EXACT');
});

test('a find returns the whole row and loads the eager relation with it; count does not, and loadEagerRelations: false stops it', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  a() { return this.users.find(); }',
    '  b() { return this.users.count(); }',
    '  c() { return this.users.find({ loadEagerRelations: false }); }',
  ])]);
  assert.equal(gradeOf(g, SID('a', 0), 'EXECUTES', 'table:role'), 'EXACT');
  assert.equal(gradeOf(g, SID('a', 0), 'READS', 'column:role.title'), 'EXACT');
  assert.equal(g.edges.find((e) => e.from === SID('a', 0) && e.to === 'table:role').evidence.rule, 'typeorm-eager-relation');
  assert.equal(gradeOf(g, SID('b', 0), 'EXECUTES', 'table:role'), null);
  assert.equal(gradeOf(g, SID('c', 0), 'EXECUTES', 'table:role'), null);
  assert.equal(gradeOf(g, SID('c', 0), 'READS', 'column:users.bio'), 'EXACT');
});

test('save of a value not written out MAY write any column: SOUND_SET, and the statement says the entity is only known when it runs', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service(['  s(u: User) { return this.users.save(u); }'])]);
  const node = g.nodes.get(SID('s', 0));
  assert.equal(node.statementType, 'upsert');
  assert.equal(node.columnsRuntimeOnly, true);
  assert.equal(gradeOf(g, SID('s', 0), 'WRITES', 'column:users.email'), 'SOUND_SET');
  assert.equal(gradeOf(g, SID('s', 0), 'WRITES', 'column:users.roleId'), 'SOUND_SET', 'a relation\'s join column too');
});

test('softDelete writes the delete date column the entity declares', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service(['  d(id: number) { return this.users.softDelete({ id }); }'])]);
  assert.equal(g.nodes.get(SID('d', 0)).statementType, 'update');
  assert.equal(gradeOf(g, SID('d', 0), 'WRITES', 'column:users.deletedAt'), 'EXACT');
});

test('a query builder held in a name is one statement with every step on that name; a step under a condition MAY read', () => {
  const { g, stats } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  async q(bio?: string) {',
    "    const qb = this.users.createQueryBuilder('u').leftJoinAndSelect('u.role', 'r').where('u.email = :e', { e: 1 });",
    "    if (bio) qb.andWhere('u.bio LIKE :b', { b: bio });",
    '    return qb.getMany();',
    '  }',
  ])]);
  assert.equal(stats.typeorm.builders, 1);
  const sid = SID('q', 0);
  assert.equal(g.nodes.get(sid).typeormEvidence.builder, true);
  assert.equal(gradeOf(g, sid, 'READS', 'column:users.email'), 'EXACT');
  assert.equal(gradeOf(g, sid, 'READS', 'column:role.title'), 'EXACT', 'a join that selects returns the joined row');
  assert.equal(g.edges.filter((e) => e.from === sid && e.to === 'column:users.bio').map((e) => e.grade).join(), 'EXACT', 'the whole row is returned, whatever the condition');
  assert.equal(g.nodes.has(SID('q', 1)), false, 'qb.getMany() is a step of the builder, not a statement of its own');
});

test('a builder step under a condition that names a column nothing else reads is SOUND_SET', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  async q(bio?: string) {',
    "    const qb = this.users.createQueryBuilder('u').select(['u.id']);",
    "    if (bio) qb.andWhere('u.bio LIKE :b', { b: bio });",
    '    return qb.getRawMany();',
    '  }',
  ])]);
  assert.equal(gradeOf(g, SID('q', 0), 'READS', 'column:users.bio'), 'SOUND_SET');
  assert.equal(gradeOf(g, SID('q', 0), 'READS', 'column:users.id'), 'EXACT');
});

test('an entity manager names the entity in its first argument, and a transaction hands its callback a manager', () => {
  const { g } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  t() { return this.ds.transaction(async (m) => { await m.update(Role, { id: 1 }, { title: "t" }); }); }',
    '  r() { return this.ds.getRepository(Role).findBy({ title: "x" }); }',
  ])]);
  assert.equal(gradeOf(g, SID('t', 0), 'WRITES', 'column:role.title'), 'EXACT');
  assert.equal(gradeOf(g, SID('r', 0), 'READS', 'column:role.title'), 'EXACT');
});

test('a class that extends Repository<Entity> is a repository of it, and a method of its own of an operation\'s name is its own', () => {
  const repo = ['tag.repository.ts', src(
    "import { Repository } from 'typeorm';",
    "import { Role } from './role.entity';",
    'export class RoleRepository extends Repository<Role> {',
    '  byTitle(title: string) { return this.findOneBy({ title }); }',
    '  count() { return 0; }',
    '  n() { return this.count(); }',
    '}',
  )];
  const { g } = bridge([MODULE_KNOWN, ROLE_ENTITY, repo]);
  assert.equal(gradeOf(g, 'statement:typeorm:tag.repository.ts#RoleRepository.byTitle/0', 'READS', 'column:role.title'), 'EXACT');
  assert.equal(g.nodes.has('statement:typeorm:tag.repository.ts#RoleRepository.n/0'), false, 'this.count() runs the class\'s own count');
});

test('raw SQL, an operation the pack does not name, and a call on a receiver not typed here make no statement, and each is said', () => {
  const { g, stats } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY, service([
    '  a() { return this.users.query("select 1"); }',
    '  b() { return this.users.findTrees(); }',
    '  c(m: any) { return m.find(Role, {}); }',
  ])]);
  assert.equal(g.nodes.has(SID('a', 0)), false);
  assert.equal(stats.typeorm.raw, 1);
  assert.equal(stats.typeorm.unknownOperation, 1);
  assert.equal(stats.typeorm.untypedReceiver, 1);
  const kinds = stats.diagnostics.map((d) => d.kind);
  assert.ok(kinds.includes('TS_TYPEORM_CALL_UNREAD') && kinds.includes('TS_TYPEORM_RECEIVER_UNREAD'), kinds.join());
});

test('a project with no entity and no TypeORM call is left as it was: no typeorm stats, no node', () => {
  const { g, stats } = bridge([['s.ts', src('export class S {', '  m() { return [1].find((x) => x); }', '}')]]);
  assert.equal('typeorm' in stats, false);
  assert.deepEqual([...g.nodes.keys()], ['symbol:s.ts#S.m']);
});

// ---------------------------------------------------------------------------
// the axes
// ---------------------------------------------------------------------------

test('the entities are a catalog: shipped with a note naming them when every name is written or follows a known rule, degraded when one was assumed', () => {
  const typeorm = (heuristicNames, known) => ({ statements: 4, tables: 3, columns: 12, heuristicNames, naming: { strategy: 'default', known, reason: 'forRoot() takes no options', why: known ? null : 'the naming strategy is not known (forRoot() takes no options)' } });
  const exact = declareAxes({ ddl: false, statements: false, code: true, ts: { typeorm: typeorm(0, true) } });
  assert.deepEqual(exact.catalog, { status: 'shipped', reason: null, sources: ['TypeORM entities (3 table(s), 12 column(s))'] });
  assert.equal(exact.statements.status, 'shipped');
  assert.equal(exact.column.status, 'shipped');
  const assumed = declareAxes({ ddl: false, statements: false, code: true, ts: { typeorm: typeorm(9, false) } });
  assert.equal(assumed.catalog.status, 'degraded');
  assert.match(assumed.catalog.reason, /9 TypeORM table or column name\(s\).*the naming strategy is not known \(forRoot\(\) takes no options\)/);
  assert.equal(assumed.column.status, 'degraded');
  assert.equal(assumed.column.reason, assumed.catalog.reason, 'one rule for both axes');
  const withDdl = declareAxes({ ddl: true, statements: false, code: true, ts: { typeorm: typeorm(9, false) } });
  assert.equal(withDdl.catalog.status, 'degraded', 'a DDL does not make an assumed entity name known');
  const none = declareAxes({ ddl: false, statements: false, code: true, ts: { prisma: { statements: 3 } } });
  assert.equal(none.catalog.status, 'not-shipped', 'a pack without TypeORM answers as before');
  assert.equal(none.column.status, 'degraded');
});

// ---------------------------------------------------------------------------
// the kinds refuse what they cannot read
// ---------------------------------------------------------------------------

test('a typeorm pack with an unknown transform, an unknown argument part and an unknown builder role is refused, each named', () => {
  const pack = JSON.parse(fs.readFileSync(new URL('../src/core/rules/packs/typeorm.json', import.meta.url), 'utf8'));
  const rule = (id) => pack.rules.find((r) => r.id === id);
  rule('typeorm.entities').params.strategies[0].column = 'kebab';
  rule('typeorm.operations').params.operations.find.args = ['guess'];
  rule('typeorm.query-builder').params.methods.where = 'maybe';
  let problems = [];
  try { buildRegistry([{ where: 'typeorm.json', pack }]); } catch (e) { if (e instanceof RuleError) problems = e.problems; else throw e; }
  const has = (re) => assert.ok(problems.some((m) => re.test(m)), `${re}: ${problems.join(' | ')}`);
  has(/typeorm\.entities params\.strategies\[0\]\.column must be one of none, snake, camel/);
  has(/typeorm\.operations params\.operations\.find\.args must list parts from/);
  has(/typeorm\.query-builder params\.methods must map each method to one of/);
});

// ---------------------------------------------------------------------------
// the strategy a profile declares
// ---------------------------------------------------------------------------

test('what the profile declares is used where the options are not written out, and the names become EXACT only when all three are known', () => {
  const unread = ['app.module.ts', MODULE_KNOWN[1].replace("TypeOrmModule.forRoot({ type: 'postgres' })", 'TypeOrmModule.forRoot()')];
  const files = [unread, USER_ENTITY, ROLE_ENTITY, service(['  one(email: string) { return this.users.findOneBy({ email }); }'])];
  const all = bridge(files, { typeorm: { namingStrategy: 'default', entityPrefix: '', schema: '' } });
  assert.deepEqual([all.stats.typeorm.naming.known, all.stats.typeorm.naming.from, all.stats.typeorm.heuristicNames], [true, 'profile', 0]);
  assert.equal(gradeOf(all.g, SID('one', 0), 'READS', 'column:users.email'), 'EXACT');
  assert.equal(all.stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED'), false);
  const strategyOnly = bridge(files, { typeorm: { namingStrategy: 'default' } });
  assert.equal(strategyOnly.stats.typeorm.naming.known, true);
  assert.equal(gradeOf(strategyOnly.g, SID('one', 0), 'EXECUTES', 'table:users'), 'HEURISTIC', 'the entityPrefix and the schema are still not known');
  assert.match(strategyOnly.stats.diagnostics.find((d) => d.kind === 'TS_TYPEORM_NAMING_ASSUMED').reason, /the entityPrefix is not known/);
  const snake = bridge(files, { typeorm: { namingStrategy: 'snake', entityPrefix: '', schema: '' } });
  assert.ok(snake.g.nodes.has('column:users.deleted_at'), 'the declared strategy names the columns');
});

test('a declared part that differs from what the options say is used, and said', () => {
  const { g, stats } = bridge([MODULE_KNOWN, USER_ENTITY, ROLE_ENTITY], { typeorm: { namingStrategy: 'snake', entityPrefix: 'app_' } });
  assert.deepEqual(stats.typeorm.naming.differs, ['namingStrategy snake, where the options name default', 'entityPrefix "app_", where the options say ""']);
  assert.ok(g.nodes.has('column:app_users.role_id'));
  assert.ok(stats.diagnostics.some((d) => d.kind === 'TS_TYPEORM_NAMING_DECLARED'));
});

test('tsBackend.typeorm is a block of namingStrategy, entityPrefix and schema, each null or a string, the strategy one the pack names', () => {
  assert.doesNotThrow(() => validateProfile(normalizeProfile({ tsBackend: { typeorm: { namingStrategy: 'snake', entityPrefix: '' } } })));
  assert.throws(() => validateProfile(normalizeProfile({ tsBackend: { typeorm: { namingStrategy: 7 } } })), (e) => e instanceof ProfileError);
  assert.throws(() => validateProfile(normalizeProfile({ tsBackend: { typeorm: { prefix: 'x' } } })), (e) => e instanceof ProfileError && /unknown key "prefix"/.test(e.message));
  assert.deepEqual(normalizeProfile({ tsBackend: { typeorm: { schema: 'billing' } } }).tsBackend.typeorm, { namingStrategy: null, entityPrefix: null, schema: 'billing' });
  // Which names are strategies is the pack's, checked where the analysis reads the block.
  assert.deepEqual(typeormDeclared({ namingStrategy: 'snake', entityPrefix: null, schema: '' }), { namingStrategy: 'snake', entityPrefix: null, schema: '' });
  assert.equal(typeormDeclared({ namingStrategy: null, entityPrefix: null, schema: null }), null);
  assert.throws(() => typeormDeclared({ namingStrategy: 'SnakeNamingStrategy' }), (e) => e instanceof ProfileError && /one of default, snake/.test(e.message));
  for (const k of ['namingStrategy', 'entityPrefix', 'schema']) assert.equal(PROFILE_KEY_CONSUMERS[`tsBackend.typeorm.${k}`].status, 'consumed');
});
