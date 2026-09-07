// doctor.test.mjs — the prerequisite pre-flight (SPEC §17.9).
//
// Every case here is driven by FAKE probes. That is the point of the split: the
// states a developer machine is not in — no JDK at all, a JRE pretending to be
// one, an unwritable cache, a registry that will not parse — are exactly the
// ones a reader needs the table to be right about, and they cannot be produced
// by running the real thing on this laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDoctorReport, formatDoctorTable, jdkCandidateDirs, DOCTOR_SCHEMA, MIN_NODE_MAJOR,
} from '../src/core/doctor.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** A machine on which everything required is present. */
const healthy = () => ({
  node: { version: 'v20.11.1' },
  git: { ok: true, version: 'git version 2.44.0' },
  python: { path: '/x/.venv/bin/python', ok: true, version: 'Python 3.12.2' },
  sqlglot: { ok: true, version: '30.17.0' },
  jdk: {
    candidates: [
      { dir: '/jh/bin', via: 'JAVA_HOME', javac: true, java: true },
      { dir: '/opt/homebrew/opt/openjdk/bin', via: 'homebrew keg (arm64)', javac: false, java: false },
    ],
    chosen: { javac: '/jh/bin/javac', java: '/jh/bin/java', via: 'JAVA_HOME' },
    version: 'javac 21.0.2',
  },
  webParser: { path: '/e/adapters/web/vendor/babel-parser.cjs', ok: true },
  drivers: [{ dialect: 'mysql', module: 'pymysql', pip: 'pymysql', ok: false, error: "No module named 'pymysql'" }],
  docker: { ok: false, error: 'no daemon' },
  registry: { path: '/h/.cascade/registry.json', exists: true, ok: true, projects: 3 },
  cache: { path: '/c/cascade', ok: true },
});

const byId = (r, id) => r.checks.find((c) => c.id === id);

test('a healthy machine: every required check ok, exit-worthy, optional gaps still listed', () => {
  const r = buildDoctorReport(healthy());
  assert.equal(r.schema, DOCTOR_SCHEMA);
  assert.equal(r.ok, true, 'ok is decided by the REQUIRED checks only');
  // The optional gaps are reported, not hidden: a missing driver is a fact the
  // reader wants before `catalog fetch` fails, and not a reason to exit 1.
  assert.equal(byId(r, 'driver-mysql').status, 'missing');
  assert.equal(byId(r, 'driver-mysql').required, false);
  assert.equal(byId(r, 'docker').status, 'missing');
  assert.equal(byId(r, 'docker').required, false);
  assert.equal(r.counts.missing, 2);
  // Every check that is not ok carries a remedy; an ok one carries none (a
  // remedy beside a working prerequisite is noise a reader learns to skip).
  for (const c of r.checks) {
    if (c.status === 'ok') assert.equal(c.remedy, null, `${c.id} is ok and must not suggest a fix`);
    else assert.ok(c.remedy && c.remedy.length > 10, `${c.id} must say what to do`);
  }
});

test('node below the floor is `missing`, and the floor is the one package.json declares', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE_MAJOR}`, 'the doctor floor and engines.node must be one number');

  const r = buildDoctorReport({ ...healthy(), node: { version: 'v18.19.0' } });
  assert.equal(byId(r, 'node').status, 'missing');
  assert.equal(r.ok, false);
  assert.match(byId(r, 'node').remedy, new RegExp(String(MIN_NODE_MAJOR)));
});

test('an unreadable node version is `missing`, never an optimistic pass', () => {
  for (const version of [undefined, '', 'unknown']) {
    const r = buildDoctorReport({ ...healthy(), node: { version } });
    assert.equal(byId(r, 'node').status, 'missing', `version ${JSON.stringify(version)}`);
    assert.equal(r.ok, false);
  }
});

test('a JRE is not a JDK: the trail says which half each candidate had', () => {
  const r = buildDoctorReport({
    ...healthy(),
    jdk: {
      candidates: [
        { dir: '/jre/bin', via: 'JAVA_HOME', javac: false, java: true },
        { dir: '/half/bin', via: 'sdkman', javac: true, java: false },
        { dir: '/none/bin', via: 'homebrew keg (arm64)', javac: false, java: false },
      ],
      chosen: null,
    },
  });
  const jdk = byId(r, 'jdk');
  assert.equal(jdk.status, 'missing');
  assert.equal(r.ok, false);
  assert.match(jdk.detail, /\/jre\/bin \(JAVA_HOME\): java only, no javac \(a JRE, not a JDK\)/);
  assert.match(jdk.detail, /\/half\/bin \(sdkman\): javac only, no java/);
  assert.match(jdk.detail, /\/none\/bin \(homebrew keg \(arm64\)\): absent/);
});

test('when a JDK IS found the report names the winner AND the candidates it passed over', () => {
  const jdk = byId(buildDoctorReport(healthy()), 'jdk');
  assert.equal(jdk.status, 'ok');
  assert.match(jdk.detail, /\/jh\/bin\/javac via JAVA_HOME: javac 21\.0\.2/);
  assert.match(jdk.detail, /searched: .*homebrew keg \(arm64\)\): absent/);
});

test('the registry: absent is fine, unparseable is a warn — and neither decides the exit code', () => {
  const absent = buildDoctorReport({ ...healthy(), registry: { path: '/h/.cascade/registry.json', exists: false } });
  assert.equal(byId(absent, 'registry').status, 'ok');
  assert.match(byId(absent, 'registry').detail, /does not exist yet/);
  assert.equal(absent.ok, true);

  const broken = buildDoctorReport({
    ...healthy(),
    registry: { path: '/h/.cascade/registry.json', exists: true, ok: false, error: 'Unexpected token }' },
  });
  assert.equal(byId(broken, 'registry').status, 'warn');
  assert.match(byId(broken, 'registry').detail, /Unexpected token \}/);
  assert.equal(broken.ok, true, 'a warn on an OPTIONAL check must not fail the pre-flight');
});

test('an unwritable cache directory is REQUIRED and fails the pre-flight', () => {
  const r = buildDoctorReport({ ...healthy(), cache: { path: '/c/cascade', ok: false, error: 'EACCES' } });
  assert.equal(byId(r, 'cache-dir').status, 'missing');
  assert.equal(byId(r, 'cache-dir').required, true);
  assert.equal(r.ok, false);
  assert.match(byId(r, 'cache-dir').detail, /EACCES/);
});

test('a probe the caller could not run at all is `missing`, not absent from the table', () => {
  // No probes whatsoever: every required line must still appear, and say so.
  const r = buildDoctorReport({});
  assert.equal(r.ok, false);
  const required = r.checks.filter((c) => c.required).map((c) => c.id);
  assert.deepEqual(required, ['node', 'git', 'python-venv', 'sqlglot', 'jdk', 'web-parser', 'cache-dir']);
  for (const c of r.checks) assert.notEqual(c.status, 'ok', `${c.id} must not pass on no evidence`);
});

test('the table prints one line per check, a remedy line under each failure, and a verdict', () => {
  const text = formatDoctorTable(buildDoctorReport(healthy()));
  const lines = text.trimEnd().split('\n');
  assert.match(lines[0], /^ok\s+node >= 20\s+v20\.11\.1$/);
  assert.equal(lines.filter((l) => l.trimStart().startsWith('->')).length, 2, 'two optional gaps, two remedies');
  assert.match(lines.at(-1), /^all 7 required prerequisite\(s\) ok \(8 ok, 0 warn, 2 missing\)$/);

  const bad = formatDoctorTable(buildDoctorReport({ ...healthy(), git: { ok: false, error: 'not found' } }));
  assert.match(bad.trimEnd().split('\n').at(-1), /^1 required prerequisite\(s\) not satisfied: git$/);
});

test('the web lane parser is REQUIRED, and a bundle that loads but misparses is not ok', () => {
  const ok = byId(buildDoctorReport(healthy()), 'web-parser');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.required, true);
  assert.match(ok.detail, /babel-parser\.cjs loads and parses/);

  // The failure the check exists for: the file is there and does not work. A
  // stat cannot see that, and it would otherwise surface as "0 frontend calls".
  const broken = buildDoctorReport({
    ...healthy(),
    webParser: { path: '/e/adapters/web/vendor/babel-parser.cjs', ok: false, error: 'exports is not defined' },
  });
  assert.equal(byId(broken, 'web-parser').status, 'missing');
  assert.equal(broken.ok, false, 'a broken parser must fail the pre-flight, not be a footnote');
  assert.match(byId(broken, 'web-parser').detail, /exports is not defined/);
  assert.match(byId(broken, 'web-parser').remedy, /vendored, not installed/);
});

test('jdkCandidateDirs: order is JAVA_HOME, sdkman, the distro path, then the kegs', () => {
  const dirs = jdkCandidateDirs({ JAVA_HOME: '/jh', HOME: '/tmp/fakehome' });
  assert.deepEqual(dirs.map((d) => d.via), [
    'JAVA_HOME', 'sdkman', 'debian default-java', 'homebrew keg (arm64)', 'homebrew keg (x86_64)',
  ]);
  assert.equal(dirs[0].dir, '/jh/bin');
  assert.equal(dirs[1].dir, '/tmp/fakehome/.sdkman/candidates/java/current/bin');
  // An explicit SDKMAN_CANDIDATES_DIR is honoured ahead of the ~/.sdkman guess.
  const sdk = jdkCandidateDirs({ SDKMAN_CANDIDATES_DIR: '/opt/sdk/candidates', HOME: '/tmp/fakehome' });
  assert.equal(sdk[0].dir, '/opt/sdk/candidates/java/current/bin');
  // With no environment at all the list is still the three system locations —
  // §17.9 forbids a lookup that only works on one OS.
  assert.deepEqual(jdkCandidateDirs({}).map((d) => d.dir), [
    '/usr/lib/jvm/default-java/bin', '/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin',
  ]);
});

// ---------------------------------------------------------------------------
// The command itself. It runs the REAL probes on whatever machine this is, so
// the assertions are about the report's SHAPE, not about what is installed.
// ---------------------------------------------------------------------------

test('`cascade doctor --json` emits the report, and the exit code follows `ok`', () => {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { encoding: 'utf8' });
  const report = JSON.parse(r.stdout);
  assert.equal(report.schema, DOCTOR_SCHEMA);
  assert.equal(r.status, report.ok ? 0 : 1, 'exit 0 only when every required prerequisite is ok');
  // node is the one check that must pass here: this process IS the node.
  assert.equal(report.checks.find((c) => c.id === 'node').status, 'ok');
  assert.equal(report.checks.find((c) => c.id === 'node').detail, process.version);
  // and the table form covers the same checks
  const table = spawnSync(process.execPath, [CLI, 'doctor'], { encoding: 'utf8' });
  for (const c of report.checks) assert.ok(table.stdout.includes(c.label), `${c.label} missing from the table`);
});

test('the two commands a reader needs FIRST open the usage line: setup, then doctor', () => {
  // The point is the order a reader meets them in, not a fixed string: `setup`
  // supplies the prerequisite and `doctor` says whether it worked, so both come
  // before the commands that need them. Asserting the whole first word would
  // break on any new command; asserting the ORDER is the rule itself.
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  const line = r.stderr.split('\n')[0];
  assert.match(line, /^usage: cascade </);
  const names = line.replace(/^usage: cascade </, '').replace(/>.*$/, '').split('|');
  assert.equal(names[0], 'setup', `setup should open the list, got ${names.join('|')}`);
  assert.equal(names[1], 'doctor', `doctor should follow it, got ${names.join('|')}`);
});
