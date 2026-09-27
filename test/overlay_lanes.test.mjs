// overlay_lanes.test.mjs — an edit's impact reaches the same persistence layer the certified pack does.
//
// `cascade impact` answers "what does my uncommitted edit touch?" from an
// OVERLAY: the pack's facts with the edited files re-read. The overlay used to
// assemble its graph without the JPA and MyBatis-Plus bridges, so on a project
// whose SQL comes from Spring Data or MyBatis-Plus generic CRUD an edit that
// changed nothing but a comment reported no statement and no column at all,
// where the same file read from the pack reached them. Measured on jeepay:
// 0 statements and 0 columns from the working tree, 7 and 3 from the pack.
//
// What is held here, on one small project of each kind: an edit that changes
// no code (a comment) touches the same statements and the same columns from the
// working tree as from the pack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

const MYBATIS_PLUS = {
  ddl: 'CREATE TABLE sys_log (id BIGINT PRIMARY KEY, content VARCHAR(255));\n',
  edited: 'SysLogServiceImpl.java',
  sources: {
    // The column is spelled out, so the mapping is EXACT and a conservative walk crosses it.
    'SysLog.java': 'package com.example;\nimport com.baomidou.mybatisplus.annotation.*;\n@TableName("sys_log")\npublic class SysLog { @TableId("id") private Long id; @TableField("content") private String content; }\n',
    'SysLogMapper.java': 'package com.example;\nimport com.baomidou.mybatisplus.core.mapper.BaseMapper;\npublic interface SysLogMapper extends BaseMapper<SysLog> {}\n',
    'SysLogService.java': 'package com.example;\nimport java.util.List;\nimport com.baomidou.mybatisplus.extension.service.IService;\npublic interface SysLogService extends IService<SysLog> { List<SysLog> byContent(String c); }\n',
    // `this.list(wrapper)` is IService's own generic query: its statement is the
    // service's, and the wrapper names the column it reads, which is what an edit
    // to this file has to reach.
    'SysLogServiceImpl.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.stereotype.Service;\nimport com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;\nimport com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;\n@Service\npublic class SysLogServiceImpl extends ServiceImpl<SysLogMapper, SysLog> implements SysLogService {\n    public List<SysLog> byContent(String c) {\n        LambdaQueryWrapper<SysLog> w = new LambdaQueryWrapper<SysLog>();\n        w.eq(SysLog::getContent, c);\n        return this.list(w);\n    }\n}\n',
    'SysLogController.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/logs")\npublic class SysLogController {\n    @Autowired private SysLogService sysLogService;\n    @GetMapping public List<SysLog> list(@RequestParam String c) { return sysLogService.byContent(c); }\n}\n',
  },
};

const JPA = {
  ddl: 'CREATE TABLE owners (id INT PRIMARY KEY, last_name VARCHAR(80));\n',
  edited: 'OwnerService.java',
  sources: {
    'Owner.java': 'package com.example;\nimport jakarta.persistence.*;\n@Entity\n@Table(name = "owners")\npublic class Owner { @Id private Integer id; @Column(name = "last_name") private String lastName; }\n',
    'OwnerRepository.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OwnerRepository extends JpaRepository<Owner, Integer> { List<Owner> findByLastName(String lastName); }\n',
    'OwnerService.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.stereotype.Service;\n@Service\npublic class OwnerService {\n    @Autowired private OwnerRepository owners;\n    public List<Owner> byName(String n) { return owners.findByLastName(n); }\n}\n',
    'OwnerController.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/owners")\npublic class OwnerController {\n    @Autowired private OwnerService service;\n    @GetMapping public List<Owner> find(@RequestParam String name) { return service.byName(name); }\n}\n',
  },
};

// SQL written in a Java annotation, which `analyze` reads through the SQL
// analyzer beside the mapper XML: a JPA native query, and a MyBatis @Select.
const JPA_NATIVE = {
  ddl: JPA.ddl,
  edited: 'OwnerService.java',
  sources: {
    ...JPA.sources,
    'OwnerRepository.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.data.jpa.repository.*;\npublic interface OwnerRepository extends JpaRepository<Owner, Integer> {\n    @Query(value = "SELECT id, last_name FROM owners WHERE last_name = ?1", nativeQuery = true)\n    List<Owner> findByLastName(String lastName);\n}\n',
  },
};

const MYBATIS_ANNOTATION = {
  ddl: JPA.ddl,
  edited: 'OwnerService.java',
  sources: {
    'Owner.java': 'package com.example;\npublic class Owner { private Integer id; private String lastName; }\n',
    'OwnerMapper.java': 'package com.example;\nimport java.util.List;\nimport org.apache.ibatis.annotations.*;\n@Mapper\npublic interface OwnerMapper {\n    @Select("SELECT id, last_name FROM owners WHERE last_name = #{name}")\n    List<Owner> findByName(@Param("name") String name);\n}\n',
    'OwnerService.java': 'package com.example;\nimport java.util.List;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.stereotype.Service;\n@Service\npublic class OwnerService {\n    @Autowired private OwnerMapper owners;\n    public List<Owner> byName(String n) { return owners.findByName(n); }\n}\n',
    'OwnerController.java': JPA.sources['OwnerController.java'],
  },
};

/** A real checkout of one small project, analyzed; returns how to run the CLI against it. */
function analyzedProject(t, fixture) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-lanes-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const src = path.join(repo, 'src', 'main', 'java', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'db', 'schema.sql'), fixture.ddl, 'utf8');
  for (const [name, text] of Object.entries(fixture.sources)) fs.writeFileSync(path.join(src, name), text, 'utf8');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'fixture');
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });
  assert.equal(cli(['init', '--root', repo, '--project', 'overlaylanes']).status, 0);
  const analyze = cli(['analyze', '--root', repo, '--project', 'overlaylanes', '--ddl', path.join(repo, 'db', 'schema.sql'),
    '--java-src', path.join(repo, 'src', 'main', 'java'), '--no-mappers']);
  assert.equal(analyze.status, 0, analyze.stderr);
  return { repo, cli, edited: path.join(src, fixture.edited) };
}

/** What one impact answer touched, as printed: the counts, and the downstream columns with their count. */
function touchedBy(stdout) {
  const counts = /touched: (\d+) symbols, (\d+) statements, (\d+) endpoints/.exec(stdout);
  const header = /downstream columns affected \((\d+)\):\n/.exec(stdout);
  assert.ok(counts && header, stdout);
  // The columns are the indented lines under the heading, up to the first line that is not.
  const after = stdout.slice(header.index + header[0].length).split('\n');
  const columns = after.slice(0, Math.max(0, after.findIndex((l) => !l.startsWith('  ')))).map((l) => l.trim());
  return {
    symbols: Number(counts[1]), statements: Number(counts[2]), endpoints: Number(counts[3]),
    columnCount: Number(header[1]), columns,
  };
}

function sameReachFromTheWorkingTree(t, fixture) {
  if (!findJdk()) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md'); return; }
  if (!fs.existsSync(sqlLaneVenv().python)) { t.skip('no venv python: the SQL lane cannot run (see docs/setup/sql-lane.md)'); return; }
  const { repo, cli, edited } = analyzedProject(t, fixture);
  const fromPack = cli(['impact', '--root', repo, '--file', edited, '--mode', 'base-only']);
  assert.equal(fromPack.status, 0, fromPack.stderr);
  fs.appendFileSync(edited, '// an edit that changes no code\n');
  const fromTree = cli(['impact', '--root', repo, '--file', edited]);
  assert.equal(fromTree.status, 0, fromTree.stderr);
  assert.match(fromTree.stdout, /^overlay [0-9a-f]+ \(fresh\): re-parsed 1 java/m, 'the edit was read from the working tree');
  const pack = touchedBy(fromPack.stdout);
  assert.ok(pack.columnCount > 0, `the fixture reaches columns from the pack: ${fromPack.stdout}`);
  assert.deepEqual(touchedBy(fromTree.stdout), pack, 'the working tree reaches exactly what the pack reaches');
}

test('an edit to a MyBatis-Plus service reaches the same statements and columns from the working tree as from the pack', { timeout: 900000 }, (t) => {
  sameReachFromTheWorkingTree(t, MYBATIS_PLUS);
});

test('an edit to a Spring Data service reaches the same statements and columns from the working tree as from the pack', { timeout: 900000 }, (t) => {
  sameReachFromTheWorkingTree(t, JPA);
});

test('an edit to a service over a JPA native query reaches the same statements and columns from the working tree as from the pack', { timeout: 900000 }, (t) => {
  sameReachFromTheWorkingTree(t, JPA_NATIVE);
});

test('an edit to a service over a MyBatis @Select reaches the same statements and columns from the working tree as from the pack', { timeout: 900000 }, (t) => {
  sameReachFromTheWorkingTree(t, MYBATIS_ANNOTATION);
});
