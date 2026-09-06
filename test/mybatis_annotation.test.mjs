// mybatis_annotation.test.mjs — MyBatis statements written as an ANNOTATION
// (`@Select` / `@Insert` / `@Update` / `@Delete`) rather than in a mapper XML
// (RM20 §4), in two halves:
//
//   1. the translation, over hand-written facts: which synthetic mapper XML is
//      produced, what is escaped and what is markup, and what happens when a
//      method carries BOTH an annotation and an XML statement;
//   2. the whole lane end to end through the CLI, over a four-file `com.example`
//      repository with all four verbs and one `<script>` body — the real worker,
//      the real flattener, the real lineage.
//
// The second half needs a JDK and the venv Python and SKIPS WITH THE REASON when
// either is missing (SPEC §16.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { annotationMapperXml, restampToJavaSource, annotationMapperFileName } from '../src/adapters/mybatis_annotation.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

const ann = (over) => ({
  kind: 'mapperAnnotationSql', ownerFqn: 'com.example.UserMapper', method: 'selectAll',
  verb: 'select', text: 'select * from users', line: 12, file: 'com/example/UserMapper.java', ...over,
});

// ---------------------------------------------------------------------------
// 1. the translation
// ---------------------------------------------------------------------------

test('annotationMapperXml: one synthetic mapper file per interface, one element per method', () => {
  const r = annotationMapperXml([
    ann({}),
    ann({ method: 'insertOne', verb: 'insert', text: 'insert into users (name) values (#{name})', line: 15 }),
    ann({ ownerFqn: 'com.example.PetMapper', method: 'wipe', verb: 'delete', text: 'delete from pets', line: 9, file: 'com/example/PetMapper.java' }),
  ]);
  assert.equal(r.statements, 3);
  assert.deepEqual(r.files.map((f) => f.mapperFqn), ['com.example.PetMapper', 'com.example.UserMapper']);
  const user = r.files.find((f) => f.mapperFqn === 'com.example.UserMapper');
  assert.equal(user.fileName, 'com.example.UserMapper.xml');
  assert.match(user.xml, /<mapper namespace="com\.example\.UserMapper">/);
  // The ELEMENT is the verb, so the flattener stamps the same statement type a
  // mapper XML would.
  assert.match(user.xml, /<insert id="insertOne">insert into users \(name\) values \(#\{name\}\)<\/insert>/);
  assert.match(user.xml, /<select id="selectAll">select \* from users<\/select>/);
});

test('annotationMapperXml: a plain body is ESCAPED, a <script> body is markup and goes in whole', () => {
  const r = annotationMapperXml([
    ann({ method: 'after', text: 'select * from users where id > #{id} and a & b' }),
    ann({
      method: 'byIds', verb: 'delete',
      text: "<script> delete from users where id in <foreach item='i' collection='ids' open='(' separator=',' close=')'>#{i}</foreach> </script>",
    }),
  ]);
  const xml = r.files[0].xml;
  // `id > #{id}` must not become a tag, and `&` must not become an entity error.
  assert.match(xml, /<select id="after">select \* from users where id &gt; #\{id\} and a &amp; b<\/select>/);
  // …while the dynamic tags of a <script> are the whole point of it.
  assert.match(xml, /<delete id="byIds"> delete from users where id in <foreach item='i'/);
  assert.doesNotMatch(xml, /&lt;foreach/);
  assert.equal(r.scripts, 1);
});

test('annotationMapperXml: a method with BOTH an annotation and an XML statement — the XML wins, out loud', () => {
  const r = annotationMapperXml(
    [ann({}), ann({ method: 'byId', text: 'select * from users where id = #{id}' })],
    ['com.example.UserMapper.byId'],
  );
  assert.deepEqual(r.overriddenByXml, ['com.example.UserMapper.byId']);
  assert.equal(r.statements, 1, 'only the annotation nobody else declares becomes a statement');
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].kind, 'MAPPER_STATEMENT_DECLARED_TWICE');
  assert.match(r.diagnostics[0].reason, /MyBatis rejects that at startup/);
  assert.match(r.diagnostics[0].reason, /keeps the XML statement/);
});

test('annotationMapperXml: a facts stream with no annotation at all produces nothing', () => {
  const r = annotationMapperXml([{ kind: 'type', fqn: 'com.example.A' }, null, 'nope']);
  assert.deepEqual(r.files, []);
  assert.equal(r.statements, 0);
  assert.deepEqual(r.diagnostics, []);
});

test('annotationMapperFileName: a mapper FQN becomes a file name that cannot escape a directory', () => {
  assert.equal(annotationMapperFileName('com.example.UserMapper'), 'com.example.UserMapper.xml');
  assert.equal(annotationMapperFileName('../../etc/passwd'), '.._.._etc_passwd.xml');
});

test('restampToJavaSource: the statement points at the JAVA file and the annotation line, never at the scratch file', () => {
  const r = annotationMapperXml([ann({})]);
  const out = restampToJavaSource([
    { kind: 'statement', namespace: 'com.example.UserMapper', id: 'selectAll', type: 'select', sql: 'select * from users', file: 'com.example.UserMapper.xml', line: 2 },
    { kind: 'diagnostic', message: 'ignored' },
  ], r.files);
  assert.equal(out.length, 1, 'only statements come back');
  assert.equal(out[0].file, 'com/example/UserMapper.java');
  assert.equal(out[0].line, 12);
});

// ---------------------------------------------------------------------------
// 2. the whole lane, through the CLI
// ---------------------------------------------------------------------------

const FILES = {
  'schema.sql': `CREATE TABLE \`users\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(30) DEFAULT NULL,
  \`city\` varchar(80) DEFAULT NULL,
  \`state\` int(4) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;
`,
  'src/main/java/com/example/UserMapper.java': `package com.example;

import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface UserMapper {

    @Select("select id, name from users where state = #{state}")
    List<Object> selectByState(@Param("state") int state);

    // A concatenation of literals: MyBatis reads it as one string, so must we.
    @Insert("insert into users (name, city) "
            + "values (#{name}, #{city})")
    int insertUser(@Param("name") String name, @Param("city") String city);

    // An ARRAY of literals: MyBatis joins them with a space.
    @Update({"update users",
             "set city = #{city}",
             "where id = #{id}"})
    int updateCity(@Param("id") long id, @Param("city") String city);

    // A <script> body: the dynamic tags must go through the SAME flattener a
    // mapper XML does, or the bind list is read as literal text.
    @Delete({"<script>",
             "delete from users",
             "where id in ",
             "<foreach item='one' collection='ids' open='(' separator=',' close=')'>",
             "  #{one}",
             "</foreach>",
             "</script>"})
    int deleteByIds(@Param("ids") List<Long> ids);
}
`,
  'src/main/java/com/example/UserController.java': `package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class UserController {
    private final UserMapper users;

    public UserController(UserMapper users) {
        this.users = users;
    }

    @GetMapping("/users/by-state")
    public Object byState(int state) {
        return this.users.selectByState(state);
    }
}
`,
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ann', GIT_AUTHOR_EMAIL: 'ann@example.com',
  GIT_COMMITTER_NAME: 'ann', GIT_COMMITTER_EMAIL: 'ann@example.com',
};

test('MyBatis annotation SQL end to end: four verbs and a <script>, through the real flattener', { timeout: 600000 }, (t) => {
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH (see docs/setup/java-lane.md)');
    return;
  }
  if (!fs.existsSync(VENV_PY)) {
    t.skip(`no venv python at ${VENV_PY} — mybatis_extract.py and lineage.py cannot run (see docs/setup/sql-lane.md)`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mybatis-ann-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body, 'utf8');
  }
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });
  assert.equal(cli(['init', '--root', repo, '--project', 'mbann']).status, 0);
  const run = cli([
    'analyze', '--root', repo, '--project', 'mbann',
    '--ddl', path.join(repo, 'schema.sql'),
    '--java-src', path.join(repo, 'src/main/java'),
    '--no-mappers',
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /MyBatis lane: 4 annotation statement\(s\) in 1 mapper\(s\), 1 with a <script> body/, run.stderr);

  const packJson = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph = loadPack(packJson, { verifyDigest: true });
  const sid = (m) => `statement:com.example.UserMapper.${m}`;

  // Every verb is a statement, and it keeps the verb the ANNOTATION named.
  assert.deepEqual(
    ['selectByState', 'insertUser', 'updateCity', 'deleteByIds'].map((m) => [m, graph.nodes.get(sid(m))?.statementType]),
    [['selectByState', 'select'], ['insertUser', 'insert'], ['updateCity', 'update'], ['deleteByIds', 'delete']],
  );

  // The source preview opens the JAVA file at the annotation, not a scratch XML.
  const one = graph.nodes.get(sid('selectByState'));
  assert.equal(one.file, 'src/main/java/com/example/UserMapper.java');
  assert.equal(typeof one.line, 'number');
  assert.ok(one.line > 0);

  // The SQL was really parsed: reads, writes and the tables behind them. The
  // WHERE column is a read too — `state` is named by the statement.
  assert.deepEqual(
    graph.edges.filter((e) => e.from === sid('selectByState') && e.type === 'READS').map((e) => e.to).sort(),
    ['column:users.id', 'column:users.name', 'column:users.state'],
  );
  // Two columns from the CONCATENATION: `insert into users (name, city)` is one
  // literal and `values (#{name}, #{city})` is the next, and a statement that
  // kept only the first half would parse to nothing at all.
  assert.deepEqual(
    graph.edges.filter((e) => e.from === sid('insertUser') && e.type === 'WRITES').map((e) => e.to).sort(),
    ['column:users.city', 'column:users.name'],
  );
  assert.deepEqual(
    graph.edges.filter((e) => e.from === sid('insertUser') && e.type === 'EXECUTES').map((e) => [e.to, e.evidence.access]),
    [['table:users', 'write']],
  );
  assert.deepEqual(
    graph.edges.filter((e) => e.from === sid('updateCity') && e.type === 'WRITES').map((e) => e.to),
    ['column:users.city'],
  );
  // The <script> was flattened by the mapper flattener: the <foreach> became a
  // bind list, so this parses as a DELETE of a real table rather than as text.
  assert.deepEqual(
    graph.edges.filter((e) => e.from === sid('deleteByIds') && e.type === 'EXECUTES').map((e) => [e.to, e.evidence.access]),
    [['table:users', 'delete']],
  );

  // Each method binds to its own statement, exactly once.
  for (const m of ['selectByState', 'insertUser', 'updateCity', 'deleteByIds']) {
    const binds = graph.edges.filter((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid(m));
    assert.equal(binds.length, 1, m);
    assert.equal(binds[0].from, `symbol:com.example.UserMapper#${m}`);
  }

  // …and the chain is walkable end to end: the endpoint reaches the column.
  const reached = graph.impactOf('column:users.name', { mode: 'conservative' });
  assert.ok(reached.has('endpoint:GET /users/by-state'), [...reached.keys()].join(', '));
});
