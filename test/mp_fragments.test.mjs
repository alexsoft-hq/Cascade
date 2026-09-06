// mp_fragments.test.mjs — a raw SQL fragment inside a MyBatis-Plus wrapper,
// end to end through the REAL CLI, the REAL Java worker and the REAL lineage.py
// (SPEC §9.5, §18.2).
//
// WHAT THIS PROVES, and why a bridge-level test could not.
// `apply / last / setSql / inSql / notInSql / having` hand MyBatis-Plus a piece
// of SQL TEXT. Until RM17 the lane could only name the fragment and stop: the
// column it mentioned was missing from the statement, so `column_impact` on that
// column returned nothing about a query that really reads it. The fix routes the
// fragment through the SAME analyzer every other statement goes through — so the
// thing worth testing is the WHOLE path: the worker records the op, the lane
// writes it into a statement, python resolves it against the DDL, and the bridge
// attaches the result. Any one of those links faked would prove nothing.
//
// jeecg-boot, the MyBatis-Plus fixture, uses none of these ops, so the project
// below is synthetic `com.example`. Every expectation is read off the SOURCE and
// the DDL in this file:
//
//   SysLog maps `id` and `logType`; the DDL also has `create_time`, which the
//   class does NOT map. `monthly()` filters with `SysLog::getLogType` (that is
//   `log_type`) and an `apply("date_format(create_time,'%Y-%m') = {0}", ym)`.
//   So `create_time` can reach the statement ONLY through the fragment: no
//   method reference names it and no projection covers it.
//
//   `withRole()` uses `inSql("id", "select id from sys_role where …")` — a
//   fragment that reaches a SECOND table the entity never names.
//
//   `weird()` uses `last("this is not sql ((")`, which cannot parse. It must
//   stay unresolved WITH its text: nothing is invented (§3.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

const DDL = `CREATE TABLE sys_log (
  id varchar(32) NOT NULL COMMENT 'key',
  log_type int COMMENT 'kind',
  create_time datetime COMMENT 'when',
  PRIMARY KEY (id)
);
CREATE TABLE sys_role (
  id varchar(32) NOT NULL,
  role_code varchar(64),
  PRIMARY KEY (id)
);
`;

const SOURCES = {
  // The entity maps TWO columns. `create_time` exists in the DDL and is not
  // mapped here — which is what makes the fragment the only way to reach it.
  'SysLog.java': `package com.example;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
@TableName("sys_log")
public class SysLog {
    @TableId
    private String id;
    private Integer logType;
    public Integer getLogType() { return logType; }
}
`,
  'SysLogMapper.java': `package com.example;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
public interface SysLogMapper extends BaseMapper<SysLog> {
}
`,
  'SysLogService.java': `package com.example;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import java.util.List;
public class SysLogService {
    private SysLogMapper sysLogMapper;

    public List<SysLog> monthly(String ym) {
        LambdaQueryWrapper<SysLog> w = new LambdaQueryWrapper<SysLog>();
        w.eq(SysLog::getLogType, 1);
        w.apply("date_format(create_time,'%Y-%m') = {0}", ym);
        return sysLogMapper.selectList(w);
    }

    public List<SysLog> withRole() {
        QueryWrapper<SysLog> w = new QueryWrapper<SysLog>();
        w.inSql("id", "select id from sys_role where role_code = 'admin'");
        return sysLogMapper.selectList(w);
    }

    public List<SysLog> weird() {
        LambdaQueryWrapper<SysLog> w = new LambdaQueryWrapper<SysLog>();
        w.last("this is not sql ((");
        return sysLogMapper.selectList(w);
    }
}
`,
};

test('a wrapper SQL fragment becomes real lineage, through the CLI and the workers', { timeout: 900000 }, (t) => {
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — see docs/setup/java-lane.md');
    return;
  }
  if (!fs.existsSync(VENV_PY)) {
    t.skip(`no venv python at ${VENV_PY} — the SQL lane cannot run (see docs/setup/sql-lane.md)`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mp-frag-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const src = path.join(repo, 'src', 'main', 'java', 'com', 'example');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(repo, 'db'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'db', 'schema.sql'), DDL, 'utf8');
  for (const [name, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, name), text, 'utf8');
  // cascade pins every analysis to a commit, so the fixture is a real checkout.
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'fixture');

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  const init = cli(['init', '--root', repo, '--project', 'fragdemo']);
  assert.equal(init.status, 0, init.stderr);
  const profilePath = path.join(repo, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.ok(profile.frameworkPacks.includes('mybatis-plus'), `frameworkPacks: ${profile.frameworkPacks}`);
  // The DDL is MySQL (`date_format`, backtick-free but MySQL-shaped), and the
  // dialect is what the analyzer parses the fragment with — declared, never guessed.
  profile.sqlDialects = { main: 'mysql' };
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');

  const analyze = cli([
    'analyze', '--root', repo, '--project', 'fragdemo',
    '--ddl', path.join(repo, 'db', 'schema.sql'),
    '--java-src', path.join(repo, 'src', 'main', 'java'),
    '--no-mappers',
  ]);
  assert.equal(analyze.status, 0, analyze.stderr);
  const err = analyze.stderr;

  // The lane phase ran the fragments through lineage.py — three of them: the
  // `apply`, the `inSql` and the `last`.
  assert.match(err, /MyBatis-Plus lane: 3 wrapper SQL fragment\(s\) -> SQL lineage \(dialect mysql, identifiers fold-lower\)/, err);
  assert.match(err, /2 read by the SQL analyzer \(4 column fact\(s\)\), 1 unresolved/, err);

  const pack = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph = pack.graph ?? pack;
  const SID = 'statement:com.example.SysLogMapper.selectList';
  const stmt = graph.nodes.find((n) => n.id === SID);
  assert.ok(stmt, 'the three call sites are one statement on BaseMapper#selectList');

  const from = (type) => graph.edges.filter((e) => e.from === SID && e.type === type);
  const reads = Object.fromEntries(from('READS').map((e) => [e.to, e]));

  // ---- 1. the fragment's own column -------------------------------------
  // `date_format(create_time,'%Y-%m') = {0}`. `create_time` is named by no
  // method reference (`SysLog::getLogType` is `log_type`) and by no projection
  // (the class does not map it), so this edge exists only because the fragment
  // was analyzed. `{0}` is MyBatis-Plus's own bind placeholder and had to be
  // normalized to `?` for the SQL to parse at all.
  const ct = reads['column:sys_log.create_time'];
  assert.ok(ct, `no READS on sys_log.create_time; reads were ${Object.keys(reads).join(', ')}`);
  assert.equal(ct.evidence.fragmentOp, 'apply', 'the edge names the op the fragment came from');
  assert.deepEqual(ct.evidence.roles, ['sql-fragment']);
  assert.equal(ct.grade, 'EXACT', '@TableName is declared and the fragment text is literal SQL');

  // ---- 2. a fragment that reaches ANOTHER table --------------------------
  // `inSql("id", "select id from sys_role where role_code = 'admin'")`.
  assert.equal(reads['column:sys_role.id'].evidence.fragmentOp, 'inSql');
  assert.equal(reads['column:sys_role.role_code'].evidence.fragmentOp, 'inSql');
  const executes = Object.fromEntries(from('EXECUTES').map((e) => [e.to, e.evidence]));
  assert.deepEqual(Object.keys(executes).sort(), ['table:sys_log', 'table:sys_role']);
  assert.equal(executes['table:sys_role'].via, 'mybatis-plus-fragment');
  assert.equal(executes['table:sys_role'].fragmentOp, 'inSql');
  assert.equal(executes['table:sys_log'].via, 'mybatis-plus', 'the entity\'s own table keeps its own edge');

  // `id` is reached BOTH as the wrapper literal `inSql`'s first argument names
  // and as the projection — the roles are kept side by side, not collapsed.
  assert.deepEqual(reads['column:sys_log.id'].evidence.roles, ['predicate', 'projection', 'sql-fragment']);

  // ---- 3. what did NOT parse stays unresolved, with its text -------------
  assert.equal(stmt.hasUnresolved, true);
  const frag = stmt.unresolved.filter((u) => u.reason === 'wrapper-sql-fragment');
  assert.equal(frag.length, 1, 'only the fragment that failed is reported');
  assert.match(frag[0].detail, /last\("this is not sql \(\("\)/, frag[0].detail);
  assert.match(frag[0].detail, /could not parse it/, frag[0].detail);
  assert.match(frag[0].detail, /NOT in this statement's column list/, frag[0].detail);
  // The analyzer underlines the bad token with terminal escapes; a pack is read
  // by tools and browsers, so the words survive and the escape bytes do not.
  assert.equal(JSON.stringify(pack).includes('\u001b'), false, 'no ANSI escape reaches the pack');

  // ---- 4. the fragments are cached like any other statement --------------
  // A fragment is a statement to the shard store, so a second run reuses the
  // analysis instead of paying python again — and the pack is identical.
  const index = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'facts-index.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(index.statements).sort(),
    [
      'com.example.SysLogService.monthly#frag0',
      'com.example.SysLogService.weird#frag0',
      'com.example.SysLogService.withRole#frag0',
    ],
    'each fragment is a shard entry named <owner>.<method>#frag<n>',
  );
  const again = cli([
    'analyze', '--root', repo, '--project', 'fragdemo',
    '--ddl', path.join(repo, 'db', 'schema.sql'),
    '--java-src', path.join(repo, 'src', 'main', 'java'),
    '--no-mappers',
  ]);
  assert.equal(again.status, 0, again.stderr);
  const pack2 = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack2.digest, pack.digest, 'the same inputs produce the same pack');
});
