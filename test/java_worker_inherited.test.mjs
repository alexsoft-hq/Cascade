// java_worker_inherited.test.mjs — what adapters/java/JavaFacts.java records for
// a receiver its compilation unit never declares (javafacts/7, RM20 §1), read
// back off real compiled-and-run output.
//
// The worker is parse-only and file-local: it cannot open the superclass to find
// out what `mybatisMapper` is. What it CAN do — and all it does here — is tell
// two spellings apart that used to be one silent skip:
//
//   a receiver the file DECLARES (a local, a parameter, a field it could not
//   type) -> still skipped, now counted as `skippedLocalReceivers`;
//   a receiver NOTHING in the file declares -> a `call` record carrying the NAME
//   and no type, for the bridge to resolve against the whole tree.
//
// It decides nothing: `StringUtils` and `mybatisMapper` leave this worker in
// exactly the same shape, because from inside one file they are the same
// evidence. Which is a static call and which is an inherited field is
// src/adapters/java_bridge.mjs's reading (I-1/I-6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { JAVA_WORKER_VERSION } from '../src/core/worker_versions.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * The template shape, in `com.example`: a generic abstract base holding the
 * collaborator, and subclasses that call it. Every construct below is a Java
 * one; nothing here names a project.
 */
const SOURCES = {
  'Base.java': `package com.example;
public abstract class Base<E, M> {
    protected M mapper;
    public Base(M mapper) { this.mapper = mapper; }
    public int insert(E model) { return 1; }
}
`,
  // The subclass declares NO variable called `mapper` anywhere: every use of the
  // name is the inherited field.
  'AaaDaoImpl.java': `package com.example;
import org.apache.commons.lang3.StringUtils;
public class AaaDaoImpl extends Base<Aaa, AaaMapper> {
    public AaaDaoImpl(AaaMapper m) { super(m); }
    public Aaa find(int id) { return mapper.findAaa(id); }
    public Aaa findChecked(String name) {
        if (StringUtils.isEmpty(name)) { return null; }
        return this.mapper.findByName(name);
    }
}
`,
  // Same inherited field, SHADOWED by a local of the same name. The file
  // declares `mapper`, so every receiver spelled `mapper` in it stays a skip.
  'BbbDaoImpl.java': `package com.example;
public class BbbDaoImpl extends Base<Bbb, BbbMapper> {
    public BbbDaoImpl(BbbMapper m) { super(m); }
    public Bbb find(int id) {
        BbbMapper mapper = pick();
        return mapper.findBbb(id);
    }
    BbbMapper pick() { return null; }
}
`,
  // A parameter receiver and a local receiver: the standing, disclosed skip.
  'Locals.java': `package com.example;
public class Locals {
    public void viaParam(AaaMapper handed) { handed.findAaa(1); }
    public void viaLocal() {
        AaaMapper made = null;
        made.findAaa(2);
    }
}
`,
  'Aaa.java': 'package com.example;\npublic class Aaa { private int id; }\n',
  'Bbb.java': 'package com.example;\npublic class Bbb { private int id; }\n',
  // The four MyBatis statement annotations, in the three spellings the framework
  // accepts for their text: one literal, a `+` concatenation, and an array.
  'AaaMapper.java': `package com.example;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
public interface AaaMapper {
    @Select("select * from aaa where id = #{id}")
    Aaa findAaa(int id);
    @Select("select * from aaa "
            + "where name = #{n}")
    Aaa findByName(String n);
    @Insert({"insert into aaa (name)", "values (#{n})"})
    int add(String n);
    @Update("update aaa set name = #{n} where id = #{id}")
    int rename(int id, String n);
    @Delete({"<script>", "delete from aaa", "</script>"})
    int wipe();
    // A value that is not a literal: the text is not in this file, so no record
    // is made for it and a diagnostic says why.
    @Select(SQL)
    Aaa byConstant();
    String SQL = "select 1";
}
`,
  'BbbMapper.java': 'package com.example;\npublic interface BbbMapper { Bbb findBbb(int id); }\n',
};

function runWorker(jdk, dir) {
  const buildDir = path.join(dir, 'classes');
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java')],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const src = path.join(dir, 'src');
  const out = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', src, src], { maxBuffer: 1 << 26 })
    .toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

test('javafacts/7: a receiver the file never declares is emitted by NAME; one it declares is still skipped', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-inherited-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), text, 'utf8');

  const records = runWorker(jdk, dir);
  const header = records[0];
  assert.equal(header.kind, 'header');
  assert.equal(header.version, JAVA_WORKER_VERSION);
  assert.equal(header.parseErrors, 0);

  const identifiers = records
    .filter((r) => r.kind === 'call' && r.via === 'identifier')
    .map((r) => ({ from: r.from, receiver: r.receiver, method: r.method, toTypeSimple: r.toTypeSimple }))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  // THREE, and only three: `mapper.findAaa`, `this.mapper.findByName` and
  // `StringUtils.isEmpty`. The worker knows no type for any of them, and says so
  // with `toTypeSimple: null` rather than inventing one.
  assert.deepEqual(identifiers, [
    { from: 'com.example.AaaDaoImpl#find', receiver: 'mapper', method: 'findAaa', toTypeSimple: null },
    { from: 'com.example.AaaDaoImpl#findChecked', receiver: 'StringUtils', method: 'isEmpty', toTypeSimple: null },
    { from: 'com.example.AaaDaoImpl#findChecked', receiver: 'mapper', method: 'findByName', toTypeSimple: null },
  ]);

  // The shadowing file emits NO identifier receiver at all: it declares `mapper`
  // itself, so the name is a local as far as this file can tell, and a call on
  // it is the standing skip.
  assert.equal(identifiers.filter((r) => r.from.startsWith('com.example.BbbDaoImpl')).length, 0);

  // …and the skip is COUNTED: one shadowing local, one parameter receiver, one
  // local receiver. `mapper.findBbb`, `handed.findAaa`, `made.findAaa`.
  assert.equal(header.skippedLocalReceivers, 3);
  assert.equal(header.skippedCalls, 3, 'nothing else in this tree is skipped');

  // `field` records are unchanged: the base declares `mapper`, the subclasses
  // declare nothing. The bridge's chain walk has exactly one place to find it.
  // (A primitive-typed field yields no record — there is no type to resolve.)
  const fields = records.filter((r) => r.kind === 'field').map((r) => `${r.owner}.${r.name}:${r.typeSimple}`).sort();
  assert.deepEqual(fields, ['com.example.AaaMapper.SQL:String', 'com.example.Base.mapper:M']);
});

test('javafacts/7: a MyBatis statement annotation is recorded as text, a verb and a line — and nothing else', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-mapsql-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), text, 'utf8');

  const records = runWorker(jdk, dir);
  const sql = records.filter((r) => r.kind === 'mapperAnnotationSql');
  assert.deepEqual(sql.map((r) => [r.ownerFqn, r.method, r.verb]), [
    ['com.example.AaaMapper', 'add', 'insert'],
    ['com.example.AaaMapper', 'findAaa', 'select'],
    ['com.example.AaaMapper', 'findByName', 'select'],
    ['com.example.AaaMapper', 'rename', 'update'],
    ['com.example.AaaMapper', 'wipe', 'delete'],
  ], 'records arrive in the worker\'s own sort order: owner, then method, then verb');

  const textOf = (m) => sql.find((r) => r.method === m).text;
  assert.equal(textOf('findAaa'), 'select * from aaa where id = #{id}');
  // A `+` concatenation is ONE string, joined exactly as the source wrote it —
  // the trailing space in the first literal is the author's, and is kept.
  assert.equal(textOf('findByName'), 'select * from aaa where name = #{n}');
  // An ARRAY is joined with a space, which is what MyBatis itself does; joining
  // without one would weld `values` onto the line before it.
  assert.equal(textOf('add'), 'insert into aaa (name) values (#{n})');
  assert.equal(textOf('wipe'), '<script> delete from aaa </script>');

  for (const r of sql) {
    assert.equal(r.file, 'com/example/AaaMapper.java');
    assert.ok(Number.isInteger(r.line) && r.line > 0, `${r.method} must carry its line`);
  }
  // The worker read no SQL: `select * from aaa` is text here, and which table
  // that is stays the SQL analyzer's reading.
  assert.deepEqual(Object.keys(sql[0]).sort(),
    ['file', 'kind', 'line', 'method', 'ownerFqn', 'text', 'verb']);

  // A value that is not a literal makes NO record — and says so on stderr rather
  // than disappearing.
  assert.equal(sql.filter((r) => r.method === 'byConstant').length, 0);
  assert.equal(records[0].mapperAnnotationSql, 5);
});
