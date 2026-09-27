// rules.test.mjs — the rule packs: every example the engine carries holds, and a pack that is wrong is refused whole.
//
// A rule pack is the engine's knowledge written as data, so what these tests hold
// is the contract that makes data safe to trust: the shape is closed (an unknown
// key is refused, not ignored), every problem is named by file and rule in one
// report, a grade never exceeds what the kind allows, two rules never settle a
// disagreement by load order, and every rule's examples run as tests here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRegistry, builtinRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { testRules } from '../src/core/rules/examples.mjs';
import { KINDS } from '../src/core/rules/kinds/index.mjs';
import { deriveTypeRoles } from '../src/core/rules/kinds/java_type_role.mjs';
import { withTypeRoles } from '../src/core/java_roles.mjs';
import { ddlDialectTokenOf } from '../src/core/discover.mjs';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const cli = (...args) => spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'rules', ...args], { encoding: 'utf8' });

/** A small valid dialect rule, to be broken one way at a time. */
const dialectRule = (over = {}) => ({
  id: 'p.names', kind: 'sql.dialect-path', description: 'Names in paths.',
  params: { dialects: [{ dialect: 'mysql', names: ['mysql'] }] },
  examples: [{ path: 'db/mysql/a.sql', expect: 'mysql' }],
  ...over,
});
const packOf = (rules, over = {}) => ({ pack: 'p', version: 1, description: 'A test pack.', rules, ...over });
const refusal = (sources, kinds) => {
  try { buildRegistry(sources, kinds); } catch (e) { if (e instanceof RuleError) return e.problems; throw e; }
  assert.fail('the packs were accepted');
  return [];
};

/** The real Java worker over example sources, or null without a JDK. */
function javaWorker() {
  const jdk = findJdk();
  if (!jdk) return null;
  return (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rules-test-'));
    try {
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
        fs.writeFileSync(path.join(dir, f.name), f.text);
      }
      return runJavaLane(jdk, dir, [dir], { quiet: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('every rule the engine carries holds every one of its examples, the Java ones through the real worker', (t) => {
  const javaFacts = javaWorker();
  const results = testRules(builtinRegistry(), { env: javaFacts ? { javaFacts } : {} });
  assert.ok(results.length > 0, 'the engine carries rules');
  for (const r of results) assert.deepEqual(r.failures, [], `${r.id}: ${JSON.stringify(r.failures)}`);
  const notRun = results.filter((r) => r.notRun);
  if (!javaFacts) {
    assert.ok(notRun.every((r) => r.kind === 'java.type-role'), 'only a Java example ever waits for a JDK');
    t.skip('no JDK found: the java.type-role examples were not run (see docs/setup/java-lane.md)');
    return;
  }
  assert.deepEqual(notRun, [], 'with a JDK every example is run');
});

/** A worker `type` record, as the Java worker writes one. */
const typeRecord = (fqn, over = {}) => ({ kind: 'type', fqn, typeKind: 'interface', implements: [], implementsArgs: [], extends: null, extendsArgs: [], typeParams: [], file: `${fqn.replace(/\./g, '/')}.java`, ...over });
const mpRules = () => builtinRegistry().ofKind('java.type-role');

test('the MyBatis-Plus rules give the records the Java worker used to, from the supertypes a type names', () => {
  const facts = [
    typeRecord('p.UserMapper', { implements: ['BaseMapper'], implementsArgs: [['User']] }),
    typeRecord('p.OrderMapper', { implements: ['BaseMapperX'], implementsArgs: [['Order']] }),
    typeRecord('p.UserServiceImpl', { typeKind: 'class', extends: 'ServiceImpl', extendsArgs: ['UserMapper', 'User'], implements: ['IService'], implementsArgs: [['User']] }),
    typeRecord('p.Finder', { typeKind: 'class' }),
  ];
  assert.deepEqual(deriveTypeRoles(facts, mpRules()), [
    { kind: 'mpMapper', fqn: 'p.UserMapper', base: 'BaseMapper', entityTypeSimple: 'User', file: 'p/UserMapper.java', rule: 'mybatis-plus.mapper' },
    { kind: 'mpService', fqn: 'p.UserServiceImpl', base: 'IService', mapperTypeSimple: null, entityTypeSimple: 'User', file: 'p/UserServiceImpl.java', rule: 'mybatis-plus.service-interface' },
    { kind: 'mpService', fqn: 'p.UserServiceImpl', base: 'ServiceImpl', mapperTypeSimple: 'UserMapper', entityTypeSimple: 'User', file: 'p/UserServiceImpl.java', rule: 'mybatis-plus.service-impl' },
  ], 'implements before extends, one record per base, and OrderMapper left for the bridge to reach through BaseMapperX');
});

test('the role records join the worker\'s in the place the worker put its own', () => {
  const facts = [typeRecord('p.A', { implements: ['BaseMapper'], implementsArgs: [['E']] }), { kind: 'import', owner: 'p.A', fqn: 'x.BaseMapper' }];
  const joined = withTypeRoles(facts);
  assert.equal(joined.length, 3);
  assert.deepEqual(joined.map((r) => r.kind), [...joined].map((r) => r.kind), 'a stable, key-sorted stream');
  assert.ok(joined.some((r) => r.kind === 'mpMapper' && r.fqn === 'p.A'));
  assert.equal(withTypeRoles([typeRecord('p.B')]).length, 1, 'no role, nothing added');
});

test('two rules that give one type two different records are refused, never settled by rule order', () => {
  const reg = buildRegistry([{ where: 'm.json', pack: { pack: 'm', version: 1, description: 'Two mapper rules.', rules: [
    { id: 'm.first', kind: 'java.type-role', description: 'First.', params: { role: 'mybatis-plus-mapper', supertypes: ['BaseMapper'], entityArg: 0 }, examples: [{ source: 'class A {}', expect: [] }] },
    { id: 'm.second', kind: 'java.type-role', description: 'Second.', params: { role: 'mybatis-plus-mapper', supertypes: ['BaseMapper'], entityArg: 1 }, examples: [{ source: 'class A {}', expect: [] }] },
  ] } }]);
  assert.throws(() => deriveTypeRoles([typeRecord('p.M', { implements: ['BaseMapper'], implementsArgs: [['A', 'B']] })], reg.ofKind('java.type-role')),
    /the rules m\.first and m\.second give p\.M two different mpMapper records/);
});

test('a type-role rule refuses a role it does not know, a supertype that is not a Java name, and a type argument its role does not take', () => {
  const problems = refusal([{ where: 't.json', pack: packOf([{
    id: 'p.bad', kind: 'java.type-role', description: 'Bad.', params: { role: 'mybatis-plus-mapper', supertypes: ['Base Mapper'], mapperArg: 0 },
    examples: [{ source: 'class A {}', expect: [{ type: 'A' }] }],
  }, {
    id: 'p.unknown-role', kind: 'java.type-role', description: 'Unknown.', params: { role: 'spring-bean', supertypes: ['X'] }, examples: [{ source: 'class A {}', expect: [] }],
  }]) }]);
  const has = (re) => assert.ok(problems.some((m) => re.test(m)), `a problem matching ${re}: ${problems.join(' | ')}`);
  has(/p\.bad params has a key "mapperArg" that a mybatis-plus-mapper rule does not take/);
  has(/p\.bad params\.supertypes has "Base Mapper", which is not a simple Java type name/);
  has(/p\.bad expect\[0\] must be \{type, role\}/);
  has(/p\.unknown-role params\.role must be one of mybatis-plus-mapper, mybatis-plus-service, got "spring-bean"/);
});

test('a pack with problems is refused with every problem, each named by its file and its rule', () => {
  const problems = refusal([{ where: 'bad.json', pack: packOf([dialectRule()], { stray: 1 }) }]);
  assert.deepEqual(problems, ['bad.json: has an unknown key "stray"'], 'an unknown pack key is refused, and a pack whose own shape is wrong is not read further');
  const ruleProblems = refusal([{ where: 'bad.json', pack: packOf([
    dialectRule({ id: 'names', extra: true }),
    dialectRule({ id: 'p.empty', examples: [] }),
    dialectRule({ id: 'p.graded', grade: 'EXACT' }),
    dialectRule({ id: 'p.unknown-kind', kind: 'java.nothing' }),
  ]) }]);
  const has = (re) => assert.ok(ruleProblems.some((m) => re.test(m)), `a problem matching ${re}: ${ruleProblems.join(' | ')}`);
  has(/^bad\.json: names has an unknown key "extra"$/);
  has(/^bad\.json: names "id" must be "p\.<name>"/);
  has(/^bad\.json: p\.empty needs at least one example/);
  has(/^bad\.json: p\.graded gives a grade, but a sql\.dialect-path rule draws no edge to grade$/);
  has(/^bad\.json: p\.unknown-kind "kind" must be one of java\.type-role, sql\.dialect-path, got "java\.nothing"$/);
});

test('a dialect rule refuses words that are not plain words, one word naming two databases, and an example it does not declare', () => {
  const problems = refusal([{ where: 'd.json', pack: packOf([dialectRule({
    params: { dialects: [{ dialect: 'mysql', names: ['my.sql', 'x'] }, { dialect: 'maria', names: ['mysql', 'maria'] }, { dialect: 'pg', names: ['mysql'] }] },
    examples: [{ path: 'a.sql', expect: 'oracle' }],
  })]) }]);
  const has = (re) => assert.ok(problems.some((m) => re.test(m)), `a problem matching ${re}: ${problems.join(' | ')}`);
  has(/names has "my\.sql", which is not a lower-case word/);
  has(/names has "x", which is not a lower-case word of two or more/);
  has(/expects "oracle", which is neither null nor a dialect this rule declares/);
  assert.ok(problems.every((m) => m.startsWith('d.json: p.names ')));
  const again = refusal([{ where: 'd.json', pack: packOf([dialectRule({
    params: { dialects: [{ dialect: 'mysql', names: ['mysql'] }, { dialect: 'maria', names: ['mysql'] }] },
  })]) }]);
  assert.ok(again.some((m) => /names has "mysql", which dialects\[0\] already names: one word cannot name two databases/.test(m)));
});

test('the same rule id in two packs is refused, naming where it was first defined', () => {
  const problems = refusal([
    { where: 'one.json', pack: packOf([dialectRule()]) },
    { where: 'two.json', pack: packOf([dialectRule()]) },
  ]);
  assert.deepEqual(problems, ['two.json: p.names is already defined in one.json']);
});

test('a grade above what the kind allows is refused', () => {
  const capped = { ...KINDS['sql.dialect-path'], name: 'test.capped', gradeCap: 'SOUND_SET' };
  const kinds = { 'test.capped': capped };
  const problems = refusal([{ where: 'g.json', pack: packOf([dialectRule({ kind: 'test.capped', grade: 'EXACT' })]) }], kinds);
  assert.deepEqual(problems, ['g.json: p.names gives EXACT, above what a test.capped rule may give (SOUND_SET)']);
  assert.doesNotThrow(() => buildRegistry([{ where: 'g.json', pack: packOf([dialectRule({ kind: 'test.capped', grade: 'HEURISTIC' })]) }], kinds));
});

test('two rules that name different databases for one path stop the run, and never settle it by load order', () => {
  const reg = buildRegistry([
    { where: 'a.json', pack: packOf([dialectRule({ id: 'a.names' })], { pack: 'a' }) },
    { where: 'b.json', pack: packOf([dialectRule({ id: 'b.names', params: { dialects: [{ dialect: 'maria', names: ['mysql'] }] }, examples: [{ path: 'x.sql', expect: null }] })], { pack: 'b' }) },
  ]);
  const rules = reg.ofKind('sql.dialect-path');
  assert.throws(() => ddlDialectTokenOf('db/mysql/schema.sql', rules), (e) => e instanceof RuleError
    && /the rules a\.names and b\.names name different databases \(mysql, maria\)/.test(e.message));
  assert.equal(ddlDialectTokenOf('db/schema.sql', rules), null, 'a path neither rule names is no conflict');
});

test('the engine\'s dialect lookup names the rule it read the answer from', () => {
  assert.deepEqual(ddlDialectTokenOf('script/ddl/tibero/com_DDL_tibero.sql'), { dialect: 'tibero', token: 'tibero', at: 11, rule: 'sql-dialects.path-names' });
});

test('an example that no longer holds is reported with what the rule gave instead', () => {
  const reg = buildRegistry([{ where: 'w.json', pack: packOf([dialectRule({ examples: [{ path: 'db/mysql/a.sql', expect: null }] })]) }]);
  assert.deepEqual(testRules(reg), [{ id: 'p.names', pack: 'p', kind: 'sql.dialect-path', total: 1, failures: [{ example: { path: 'db/mysql/a.sql', expect: null }, got: 'mysql' }], notRun: null }]);
});

test('cascade rules lists, shows and tests the engine\'s packs, and says so in JSON too', () => {
  const list = cli('list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /sql-dialects@1 {2}Which database/);
  assert.match(list.stdout, /sql-dialects\.path-names {2}sql\.dialect-path {2}\d+ example\(s\)/);
  const show = cli('show', 'sql-dialects.path-names', '--json');
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).kind, 'sql.dialect-path');
  const run = cli('test');
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^ok {4}sql-dialects\.path-names {2}(\d+)\/\1 example\(s\) hold$/m);
  assert.match(run.stdout, /^(ok {2}|SKIP) {2}mybatis-plus\.mapper {2}/m);
  assert.doesNotMatch(run.stdout + run.stderr, /"code":"summary"/, 'the worker\'s own summary line stays off the output');
  const none = cli('test', 'no-such-pack');
  assert.equal(none.status, 1, 'naming nothing is not a pass');
  const missing = cli('show', 'no.such-rule');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no rule "no\.such-rule"/);
});
