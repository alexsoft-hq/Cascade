// jpa_native.test.mjs — `@Query(nativeQuery = true)` end to end, through the CLI.
//
// A native query is SQL, so it must NOT be read by the JPA bridge's own JPQL
// reader: `cascade analyze` hands its text to the SAME lineage.py the MyBatis
// statements go through, with the same dialect, the same catalog and the same
// content-addressed shards. This test proves that with the real workers over a
// four-file synthetic repository — which is why it needs both a JDK and the
// venv Python, and SKIPS WITH THE REASON when either is missing (SPEC §16.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

const FILES = {
  'schema.sql': `CREATE TABLE \`owners\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT,
  \`last_name\` varchar(30) DEFAULT NULL,
  \`city\` varchar(80) DEFAULT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB;
`,
  'src/main/java/com/example/Owner.java': `package com.example;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "owners")
public class Owner {
    @Id
    private Long id;
    private String lastName;
    @Column(name = "city")
    private String city;
}
`,
  'src/main/java/com/example/OwnerRepository.java': `package com.example;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface OwnerRepository extends JpaRepository<Owner, Long> {
    // Positional JPA bind markers: not valid SQL in any dialect until they are
    // normalized to \`?\`, which is what makes this the interesting case.
    @Query(value = "select id, last_name from owners where city = ?1", nativeQuery = true)
    List<Owner> rawByCity(String city);
}
`,
  'src/main/java/com/example/OwnerController.java': `package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OwnerController {
    private final OwnerRepository owners;

    public OwnerController(OwnerRepository owners) {
        this.owners = owners;
    }

    @GetMapping("/owners/raw")
    public Object raw(String city) {
        return this.owners.rawByCity(city);
    }
}
`,
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'jpa', GIT_AUTHOR_EMAIL: 'jpa@example.com',
  GIT_COMMITTER_NAME: 'jpa', GIT_COMMITTER_EMAIL: 'jpa@example.com',
};

test('a native @Query is analysed by the SQL lane, not by the JPQL reader', { timeout: 600000 }, (t) => {
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH (see docs/setup/java-lane.md)');
    return;
  }
  if (!fs.existsSync(VENV_PY)) {
    t.skip(`no venv python at ${VENV_PY} — lineage.py cannot run (see docs/setup/sql-lane.md)`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jpa-native-'));
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
  assert.equal(cli(['init', '--root', repo, '--project', 'jpanative']).status, 0);
  const run = cli([
    'analyze', '--root', repo, '--project', 'jpanative',
    '--ddl', path.join(repo, 'schema.sql'),
    '--java-src', path.join(repo, 'src/main/java'),
    '--no-mappers',
  ]);
  assert.equal(run.status, 0, run.stderr);
  // The native query goes through the SAME reading convention as a mapper
  // statement — dialect AND identifier-identity rule — and the line says both.
  assert.match(run.stderr, /JPA lane: 1 native @Query statement\(s\) -> SQL lineage \(dialect mysql, identifiers fold-lower\)/, run.stderr);
  assert.match(run.stderr, /1 statements \(native 1\)/, run.stderr);

  const packJson = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph = loadPack(packJson, { verifyDigest: true });
  const sid = 'statement:com.example.OwnerRepository.rawByCity';
  const node = graph.nodes.get(sid);
  assert.ok(node, 'the native statement is in the pack');
  assert.equal(node.statementType, 'native');
  // The verb the SQL analyzer read is kept under its own key rather than lost.
  assert.equal(node.sqlStatementType, 'select');
  assert.equal(node.hasUnresolved, undefined, 'the SQL parsed — no unresolved part');

  // The columns come from lineage.py, so they are EXACT: a real SQL parse, not a
  // name derived from an attribute.
  const reads = graph.edges.filter((e) => e.from === sid && e.type === 'READS');
  assert.deepEqual(reads.map((e) => e.to).sort(), ['column:owners.city', 'column:owners.id', 'column:owners.last_name']);
  for (const e of reads) assert.equal(e.grade, 'EXACT');
  const exec = graph.edges.filter((e) => e.from === sid && e.type === 'EXECUTES');
  assert.deepEqual(exec.map((e) => [e.to, e.evidence.access, e.grade]), [['table:owners', 'read', 'EXACT']]);

  // Exactly ONE binding: the Java bridge and the JPA bridge must not both add it.
  const binds = graph.edges.filter((e) => e.type === 'IMPLEMENTS_STMT' && e.to === sid);
  assert.equal(binds.length, 1, 'the method binds to its statement once');
  assert.equal(binds[0].from, 'symbol:com.example.OwnerRepository#rawByCity');

  // And the whole chain is walkable: the endpoint reaches the column.
  const reached = graph.impactOf('column:owners.city', { mode: 'conservative' });
  assert.ok(reached.has('endpoint:GET /owners/raw'), [...reached.keys()].join(', '));
});
