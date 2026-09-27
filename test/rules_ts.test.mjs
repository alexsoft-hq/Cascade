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

test('the shipped prisma pack (prisma.client, prisma.nestjs-prisma-service, prisma.operations) holds its examples', () => {
  const results = testRules(builtinRegistry(), { only: 'prisma', env: { tsFacts: factsOfFile, tsValue: valueOfSource } });
  assert.ok(results.length >= 3, 'all three rules of the pack were selected');
  for (const r of results) assert.deepEqual(r.failures, [], `${r.id}: ${JSON.stringify(r.failures)}`);
  assert.deepEqual(results.filter((r) => r.notRun), []);
});
