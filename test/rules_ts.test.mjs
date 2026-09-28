// rules_ts.test.mjs — validation of the three TypeScript rule kinds: ts.route-decorator, ts.type-role, prisma.operation.
//
// In the style of test/rules.test.mjs: a pack with a problem is refused with
// every problem named, and the engine's own shipped examples still hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, builtinRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { testRules } from '../src/core/rules/examples.mjs';
import { KINDS } from '../src/core/rules/kinds/index.mjs';
import { factsOfFile, valueOfSource } from '../adapters/ts/tsfacts.mjs';

const packOf = (rules, over = {}) => ({ pack: 'p', version: 1, description: 'A test pack.', rules, ...over });
const refusal = (sources) => {
  try { buildRegistry(sources); } catch (e) { if (e instanceof RuleError) return e.problems; throw e; }
  assert.fail('the pack was accepted');
  return [];
};
const has = (problems, re) => assert.ok(problems.some((m) => re.test(m)), `a problem matching ${re}: ${problems.join(' | ')}`);

// ---------------------------------------------------------------------------
// ts.route-decorator
// ---------------------------------------------------------------------------

const VALID_APP = {
  create: 'NestFactory.create', listen: 'listen', globalPrefix: 'setGlobalPrefix', versioning: 'enableVersioning',
  uriType: 'VersioningType.URI', uriPrefix: 'v', neutral: 'VERSION_NEUTRAL', routerModule: 'RouterModule.register',
};
const routeRule = (paramsOver = {}, over = {}) => ({
  id: 'p.routes', kind: 'ts.route-decorator', description: 'Routes.',
  params: { controller: 'Controller', module: 'Module', verbs: { Get: 'GET' }, app: VALID_APP, ...paramsOver },
  examples: [{ source: 'export class A {}', expect: [] }],
  ...over,
});

test('ts.route-decorator refuses an unknown params key', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([routeRule({ bogus: 1 })]) }]);
  has(problems, /p\.routes params has an unknown key "bogus"/);
});

test('ts.route-decorator refuses params.verbs mapping a decorator to something that is not an HTTP verb', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([routeRule({ verbs: { Get: 'NOPE' } })]) }]);
  has(problems, /p\.routes params\.verbs has "Get": "NOPE", which is not a decorator name and an HTTP verb \(or ANY\)/);
});

test('ts.route-decorator refuses params.app missing a key, and one with a non-string value', () => {
  const missing = refusal([{ where: 'r.json', pack: packOf([routeRule({ app: { ...VALID_APP, routerModule: undefined } })]) }]);
  has(missing, /p\.routes params\.app\.routerModule must be a name as the source writes it/);
  const wrongType = refusal([{ where: 'r.json', pack: packOf([routeRule({ app: { ...VALID_APP, uriPrefix: 123 } })]) }]);
  has(wrongType, /p\.routes params\.app\.uriPrefix must be a name as the source writes it/);
});

test('ts.route-decorator refuses an example expect entry whose version is not a string, a list of strings, or "<unknown>"', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([routeRule({}, {
    examples: [{ source: 'export class A {}', expect: [{ class: 'A', method: 'm', verb: 'GET', path: '/a', version: 123 }] }],
  })]) }]);
  has(problems, /p\.routes expect\[0\] must be \{class, method, verb, path\} with an optional version, a list of versions or "<unknown>"/);
});

test('the shipped nestjs.routes examples all hold', () => {
  const results = testRules(builtinRegistry(), { only: 'nestjs.routes', env: { tsFacts: factsOfFile } });
  assert.ok(results.length > 0, 'the pack is carried');
  for (const r of results) assert.deepEqual(r.failures, [], `${r.id}: ${JSON.stringify(r.failures)}`);
  assert.deepEqual(results.filter((r) => r.notRun), [], 'a TypeScript example needs no external toolchain to run');
});

// ---------------------------------------------------------------------------
// ts.type-role
// ---------------------------------------------------------------------------

const typeRoleRule = (paramsOver = {}, over = {}) => ({
  id: 'p.role', kind: 'ts.type-role', description: 'Role.',
  params: { role: 'prisma-client', module: '@prisma/client', export: 'PrismaClient', ...paramsOver },
  examples: [{ source: 'export class A {}', expect: [] }],
  ...over,
});

test('ts.type-role refuses a role it does not know', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([typeRoleRule({ role: 'spring-bean' })]) }]);
  has(problems, /p\.role params\.role must be one of prisma-client, got "spring-bean"/);
});

test('ts.type-role refuses params missing module or export', () => {
  const noModule = refusal([{ where: 'r.json', pack: packOf([typeRoleRule({ module: undefined })]) }]);
  has(noModule, /p\.role params\.module must be the package the type is imported from/);
  const noExport = refusal([{ where: 'r.json', pack: packOf([typeRoleRule({ export: undefined })]) }]);
  has(noExport, /p\.role params\.export must be the name that package exports/);
});

test('a compiled ts.type-role rule\'s means matches only {external: module, name: export}, never a project meaning of the same name', () => {
  const compiled = KINDS['ts.type-role'].compile({ id: 'p.role', params: { role: 'prisma-client', module: '@prisma/client', export: 'PrismaClient' } });
  assert.equal(compiled.means({ external: '@prisma/client', name: 'PrismaClient' }), true);
  assert.equal(compiled.means({ external: '@prisma/client', name: 'Other' }), false, 'the export must match too');
  assert.equal(compiled.means({ external: 'some-other-package', name: 'PrismaClient' }), false, 'the module must match too');
  assert.equal(compiled.means({ file: 'x.ts', name: 'PrismaClient' }), false, 'a project class of the same name is not a package export');
});

// ---------------------------------------------------------------------------
// prisma.operation
// ---------------------------------------------------------------------------

const opRule = (paramsOver = {}, over = {}) => ({
  id: 'p.ops', kind: 'prisma.operation', description: 'Ops.',
  params: {
    arguments: { where: 'filter', select: 'project' },
    operations: { findMany: { statement: 'select', wholeRow: true } },
    ...paramsOver,
  },
  examples: [{ operation: 'findMany', args: '{}', fields: ['id'], expect: {} }],
  ...over,
});

test('prisma.operation refuses an argument key mapped to a role it does not know', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([opRule({ arguments: { where: 'nonsense' } })]) }]);
  has(problems, /p\.ops params\.arguments\.where must be one of project, relations, filter, read, write, none/);
});

test('prisma.operation refuses an operation with a statement type it does not know', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([opRule({ operations: { findMany: { statement: 'weird' } } })]) }]);
  has(problems, /p\.ops params\.operations\.findMany\.statement must be one of select, insert, update, delete, upsert/);
});

test('prisma.operation refuses params.combinators that is not an array of names', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([opRule({ combinators: 'AND' })]) }]);
  has(problems, /p\.ops params\.combinators must be an array of names/);
});

test('prisma.operation refuses params.transaction missing method or clientParam', () => {
  const noMethod = refusal([{ where: 'r.json', pack: packOf([opRule({ transaction: { clientParam: 0 } })]) }]);
  has(noMethod, /p\.ops params\.transaction\.method must be a name as the source calls it/);
  const noClientParam = refusal([{ where: 'r.json', pack: packOf([opRule({ transaction: { method: '$transaction' } })]) }]);
  has(noClientParam, /p\.ops params\.transaction\.clientParam must be a whole number from 0/);
});

test('prisma.operation refuses a nested write it cannot read: rows, link and how its value is read are closed', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([opRule({ nestedWrites: { create: { rows: 'insert', link: 'maybe' }, connect: 'x' } })]) }]);
  has(problems, /p\.ops params\.nestedWrites\.create\.rows must be one of write, delete, none/);
  has(problems, /p\.ops params\.nestedWrites\.create\.link must be one of set, clear/);
  has(problems, /p\.ops params\.nestedWrites\.create must say how its value is read: value, arguments, or both/);
  has(problems, /p\.ops params\.nestedWrites has "connect", which is not a nested write/);
});

test('prisma.operation refuses a relation count, relation filters or extensions it cannot read', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([opRule({
    relationCount: { key: '_count', arguments: { where: 'nope' } }, relationFilters: 'some',
    extensions: { methods: ['$extends'], rewriting: ['query'], define: { module: '', export: 'Prisma' }, other: 1 },
  })]) }]);
  has(problems, /p\.ops params\.relationCount\.arguments\.where must be one of project/);
  has(problems, /p\.ops params\.relationFilters must be an array of names/);
  has(problems, /p\.ops params\.extensions has an unknown key "other"/);
  has(problems, /p\.ops params\.extensions\.define\.module must name a package/);
  has(problems, /p\.ops params\.extensions\.define\.export and \.method must be names/);
});

test('with the models handed in, a relation key is followed into the model it reaches; without them it is said as not followed, as before', () => {
  const op = builtinRegistry().ofKind('prisma.operation')[0].compiled;
  const user = { name: 'User', fields: [{ name: 'id', relation: false }, { name: 'posts', relation: true, type: 'Post', list: true }] };
  const post = { name: 'Post', fields: [{ name: 'id', relation: false }, { name: 'title', relation: false }] };
  const args = [valueOfSource('{ include: { posts: { select: { title: true } } } }')];
  const followed = op.effectsOf('findMany', args, user, new Map([['User', user], ['Post', post]]));
  assert.deepEqual(followed.follow.map((f) => [f.relation, f.target, f.how, [...f.fx.reads]]), [['posts', 'Post', 'project', ['title']]]);
  assert.deepEqual([...followed.relations], []);
  const alone = op.effectsOf('findMany', args, user);
  assert.deepEqual([...alone.relations], ['posts']);
  assert.deepEqual(alone.follow, []);
});

test('compiled.effectsOf reads a simple where and select', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: {
      arguments: { where: 'filter', select: 'project' },
      operations: { findMany: { statement: 'select', wholeRow: true } },
    },
  });
  const model = { fields: [{ name: 'id', relation: false }, { name: 'email', relation: false }] };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ where: { email: e }, select: { id: true } }')], model);
  assert.equal(fx.statement, 'select');
  assert.deepEqual([...fx.reads].sort(), ['email', 'id']);
  assert.equal(fx.wholeRow, false, 'a select was given, so the whole row is not returned');
});

test('compiled.effectsOf reads a named compound key through the model\'s compounds, never by splitting it on _', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { where: 'filter', select: 'project' }, operations: { findUnique: { statement: 'select', wholeRow: true } } },
  });
  const model = {
    fields: [{ name: 'id', relation: false }, { name: 'email', relation: false }, { name: 'a', relation: false }, { name: 'b', relation: false }],
    compounds: { id_email: ['a', 'b'] },
  };
  const fx = compiled.effectsOf('findUnique', [valueOfSource('{ where: { id_email: { a: 1, b: 2 } }, select: { id: true } }')], model);
  assert.deepEqual([...fx.reads].sort(), ['a', 'b', 'id'], 'id_email means a and b, the compound\'s own fields, not the id and email a split would guess');
});

test('a key shaped like fields joined by _ is not a compound unless the model declares one: it is an unknown key, never guessed by splitting', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { where: 'filter' }, operations: { findMany: { statement: 'select' } } },
  });
  const model = { fields: [{ name: 'a', relation: false }, { name: 'b', relation: false }], compounds: {} };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ where: { a_b: { a: 1, b: 2 } } }')], model);
  assert.deepEqual([...fx.reads], []);
  assert.deepEqual([...fx.unknownKeys], ['a_b']);
});

test('a select value that is neither true nor false may read its field: mayReads, graded apart from reads, and the key is named in runtimeOnly', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { select: 'project' }, operations: { findMany: { statement: 'select', wholeRow: true } } },
  });
  const model = { fields: [{ name: 'id', relation: false }, { name: 'email', relation: false }] };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ select: { id: true, email: flag } }')], model);
  assert.deepEqual([...fx.reads], ['id']);
  assert.deepEqual([...fx.mayReads], ['email']);
  assert.equal(fx.wholeRow, false, 'a select was given (even a dynamic one), so the whole row is not claimed');
  assert.ok([...fx.runtimeOnly].some((r) => r.includes('email')), `runtimeOnly should name the key: ${JSON.stringify([...fx.runtimeOnly])}`);
});

test('a computed top-level argument key ({ [key]: {...} }) is runtimeOnly like a spread, and claims no whole row', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { select: 'project' }, operations: { findMany: { statement: 'select', wholeRow: true } } },
  });
  const model = { fields: [{ name: 'id', relation: false }] };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ [key]: { id: true } }')], model);
  assert.deepEqual([...fx.reads], []);
  assert.equal(fx.wholeRow, false, 'which argument this call sends is not known, so no column is claimed for certain');
  assert.ok(fx.runtimeOnly.has('arguments'));
});

test('a filter combinator is read from params.combinators, not hardcoded: with none declared, OR is just an unknown key', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { where: 'filter' }, operations: { findMany: { statement: 'select' } } },
  });
  const model = { fields: [{ name: 'email', relation: false }, { name: 'name', relation: false }] };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ where: { OR: [{ email: e }, { name: n }] } }')], model);
  assert.deepEqual([...fx.reads], [], 'OR is not a combinator this rule declared, so it is not followed into the filter');
  assert.deepEqual([...fx.unknownKeys], ['OR']);
});

test('with params.combinators declaring OR, a where reads through it the same way the shipped pack reads AND/OR/NOT', () => {
  const compiled = KINDS['prisma.operation'].compile({
    id: 'p.ops',
    params: { arguments: { where: 'filter' }, operations: { findMany: { statement: 'select' } }, combinators: ['OR'] },
  });
  const model = { fields: [{ name: 'email', relation: false }, { name: 'name', relation: false }] };
  const fx = compiled.effectsOf('findMany', [valueOfSource('{ where: { OR: [{ email: e }, { name: n }] } }')], model);
  assert.deepEqual([...fx.reads].sort(), ['email', 'name']);
});

test('compile() carries params.transaction through so the bridge can read it, and null when the pack declares none', () => {
  const withTx = KINDS['prisma.operation'].compile({
    id: 'p.ops', params: { arguments: {}, operations: { findMany: { statement: 'select' } }, transaction: { method: '$transaction', clientParam: 0 } },
  });
  assert.deepEqual(withTx.transaction, { method: '$transaction', clientParam: 0 });
  const withoutTx = KINDS['prisma.operation'].compile({ id: 'p.ops', params: { arguments: {}, operations: { findMany: { statement: 'select' } } } });
  assert.equal(withoutTx.transaction, null);
});

test('the shipped prisma pack (prisma.client, prisma.nestjs-prisma-service, prisma.operations) holds its examples', () => {
  const results = testRules(builtinRegistry(), { only: 'prisma', env: { tsFacts: factsOfFile, tsValue: valueOfSource } });
  assert.ok(results.length >= 3, 'all three rules of the pack were selected');
  for (const r of results) assert.deepEqual(r.failures, [], `${r.id}: ${JSON.stringify(r.failures)}`);
  assert.deepEqual(results.filter((r) => r.notRun), []);
});

test('a key named like a property every object has (toString, constructor) is an unknown key, not a compound', () => {
  const op = builtinRegistry().ofKind('prisma.operation')[0].compiled;
  const fx = op.effectsOf('findMany', [valueOfSource('{ where: { toString: 1, constructor: 2 } }')], { fields: [{ name: 'id', relation: false }], compounds: {} });
  assert.deepEqual([...fx.unknownKeys].sort(), ['constructor', 'toString']);
  assert.deepEqual([...fx.reads], []);
});

// ---------------------------------------------------------------------------
// ts.provider-binding
// ---------------------------------------------------------------------------

const providerRule = (paramsOver = {}, over = {}) => ({
  id: 'p.providers', kind: 'ts.provider-binding', description: 'Providers.',
  params: { module: 'Module', list: 'providers', token: 'provide', useClass: 'useClass', notRead: ['useFactory'], inject: 'Inject', ...paramsOver },
  examples: [{ source: 'export class A {}', expect: [] }],
  ...over,
});

test('ts.provider-binding refuses an unknown params key, a missing name and an empty notRead', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([providerRule({ bogus: 1, useClass: undefined, notRead: [] })]) }]);
  has(problems, /p\.providers params has an unknown key "bogus"/);
  has(problems, /p\.providers params\.useClass must be a name as the source writes it/);
  has(problems, /p\.providers params\.notRead must list the keys of a binding this kind does not read/);
});

test('ts.provider-binding refuses a grade: a binding draws no edge to grade', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([providerRule({}, { grade: 'SOUND_SET' })]) }]);
  has(problems, /gives a grade, but a ts\.provider-binding rule draws no edge to grade/);
});

test('ts.provider-binding refuses an example expect entry of another shape', () => {
  const problems = refusal([{ where: 'r.json', pack: packOf([providerRule({}, {
    examples: [{ source: 'export class A {}', expect: [{ module: 'M', token: 'T' }] }],
  })]) }]);
  has(problems, /expect\[0\] must be \{module, token, useClass\}, \{module, token, notRead\} or \{module, unread: true\}/);
});

test('the shipped nestjs.providers examples all hold, and a provider list held in a variable is read as unread, not as a class', () => {
  const registry = builtinRegistry();
  const results = testRules(registry, { only: 'nestjs.providers', env: { tsFacts: factsOfFile } });
  assert.equal(results.length, 1, 'the rule is carried');
  for (const r of results) assert.deepEqual(r.failures, [], `${r.id}: ${JSON.stringify(r.failures)}`);
  assert.deepEqual(results.filter((r) => r.notRun), []);
  const compiled = registry.ofKind('ts.provider-binding')[0].compiled;
  const cls = factsOfFile('m.ts', "import { Module } from '@nestjs/common';\n@Module({ providers: list })\nexport class M {}").find((r) => r.kind === 'class');
  assert.deepEqual(compiled.providersOf(cls), { readable: true, spread: true, entries: [] });
});
