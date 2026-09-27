// rules_explain.test.mjs — `cascade rules explain <type>`: why a Java type has a role, or has none, in the rules' own reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
import { explainTypeRoles } from '../src/core/rules/explain.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const CLI = fileURLToPath(new URL('../bin/cascade.mjs', import.meta.url));
const type = (fqn, over) => ({ kind: 'type', fqn, package: fqn.slice(0, fqn.lastIndexOf('.')), typeKind: 'interface', implements: [], implementsArgs: [], extends: null, extendsArgs: [], typeParams: [], file: `${fqn.replace(/\./g, '/')}.java`, ...over });
const imported = (owner, fqn) => ({ kind: 'import', owner, simple: fqn.slice(fqn.lastIndexOf('.') + 1), fqn, file: `${owner.replace(/\./g, '/')}.java` });

const FACTS = [
  imported('p.BaseMapperX', 'com.github.yulichang.base.MPJBaseMapper'),
  type('p.BaseMapperX', { typeParams: ['T'], implements: ['MPJBaseMapper'], implementsArgs: [['T']] }),
  type('p.OrderMapper', { implements: ['BaseMapperX'], implementsArgs: [['Order']] }),
  imported('p.AppMapper', 'p.base.BaseMapper'),
  type('p.base.BaseMapper', { typeParams: ['D', 'E'] }),
  type('p.AppMapper', { implements: ['BaseMapper'], implementsArgs: [['AppDto', 'App']] }),
];
const explained = (name) => explainTypeRoles(FACTS, builtinRegistry().ofKind('java.type-role'), name);

test('a supertype a rule reads gives the role, with what the file means by its name', () => {
  const [x] = explained('p.BaseMapperX');
  assert.equal(x.supertypes[0].meaning, 'the file means com.github.yulichang.base.MPJBaseMapper (an import of that name)');
  assert.deepEqual(x.supertypes[0].rules.map((v) => [v.rule, v.gives?.entityTypeSimple, v.gives?.grade]), [['mybatis-plus-join.mapper', 'T', 'SOUND_SET']]);
});

test('a type of the project no rule names is left to the bridge, and a type of the same name from elsewhere is said to be another', () => {
  const [order] = explained('OrderMapper');
  assert.deepEqual(order.supertypes[0].rules, []);
  assert.equal(order.supertypes[0].inProject, true);
  const [app] = explained('AppMapper');
  assert.deepEqual(app.supertypes[0].rules.map((v) => [v.rule, v.gives, v.why]),
    [['mybatis-plus.mapper', null, 'BaseMapper here is not com.baomidou.mybatisplus.core.mapper.BaseMapper']]);
  assert.equal(app.supertypes[0].meaning, 'the file means p.base.BaseMapper (an import of that name)');
  assert.deepEqual(explained('Nothing'), []);
});

test('cascade rules explain reads the pack\'s fact cache and says the whole chain as the bridge reads it', { timeout: 600000 }, (t) => {
  if (!findJdk()) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  if (!fs.existsSync(sqlLaneVenv().python)) { t.skip('no venv python: the SQL lane cannot run (see docs/setup/sql-lane.md)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-explain-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const src = path.join(repo, 'src', 'main', 'java', 'p');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(repo, 'db'));
  fs.writeFileSync(path.join(repo, 'db', 'schema.sql'), 'CREATE TABLE t_order (id BIGINT PRIMARY KEY);\n');
  fs.writeFileSync(path.join(src, 'Order.java'), 'package p;\nimport com.baomidou.mybatisplus.annotation.*;\n@TableName("t_order")\npublic class Order { @TableId("id") private Long id; }\n');
  fs.writeFileSync(path.join(src, 'BaseMapperX.java'), 'package p;\nimport com.github.yulichang.base.MPJBaseMapper;\npublic interface BaseMapperX<T> extends MPJBaseMapper<T> {}\n');
  fs.writeFileSync(path.join(src, 'OrderMapper.java'), 'package p;\npublic interface OrderMapper extends BaseMapperX<Order> {}\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'fixture');
  const env = { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  assert.equal(cli(['init', '--root', repo, '--project', 'explain']).status, 0);
  const analyze = cli(['analyze', '--root', repo, '--project', 'explain', '--ddl', path.join(repo, 'db', 'schema.sql'), '--java-src', path.join(repo, 'src', 'main', 'java'), '--no-mappers']);
  assert.equal(analyze.status, 0, analyze.stderr);
  const out = cli(['rules', 'explain', 'OrderMapper', '--project', 'explain']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /BaseMapperX<Order>: the file means p\.BaseMapperX \(a type of the file's own package\)/);
  assert.match(out.stdout, /as the MyBatis-Plus bridge reads the whole chain: mapper of p\.Order, SOUND_SET, relying on mybatis-plus-join\.mapper \(com\.github\.yulichang\.base\.MPJBaseMapper\)/);
  const missing = cli(['rules', 'explain', 'NoSuchType', '--project', 'explain']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no type named "NoSuchType" in this pack/);
});
