#!/usr/bin/env node
// ci-java-smoke.mjs — the java lane's CI check, as code rather than a shell
// one-liner, so the same assertions run in CI and in `node --test`.
//
// It compiles adapters/java/JavaFacts.java, runs it over test/fixtures/java-smoke,
// and asserts the contract every consumer relies on (SPEC §18.1):
//   - at least one JSONL record on stdout;
//   - the FIRST line is the header and declares "schema":"cascade:javafacts:1";
//   - the run saw the fixture's files.
//
// Usage: node scripts/ci-java-smoke.mjs [--javac <path>] [--java <path>]
// Exit 0 on success, 1 on a failed assertion, 2 when no JDK is available (the
// caller decides whether that is a skip or a failure — this script never
// pretends a missing JDK is a pass).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jdkCandidateDirs } from '../src/core/doctor.mjs';

export const JAVAFACTS_SCHEMA = 'cascade:javafacts:1';
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Find a JDK (javac + java). The search ORDER is `jdkCandidateDirs()` in
 * src/core/doctor.mjs — the same list `cascade analyze` and `cascade doctor`
 * walk, so this script cannot find a JDK the engine would not (SPEC §17.9).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{javac:string, java:string, via:string}|null}
 */
export function findJdk(env = process.env) {
  for (const { dir, via } of jdkCandidateDirs(env)) {
    const javac = path.join(dir, 'javac');
    const java = path.join(dir, 'java');
    if (fs.existsSync(javac) && fs.existsSync(java)) return { javac, java, via };
  }
  try {
    execFileSync('javac', ['-version'], { stdio: 'ignore' });
    return { javac: 'javac', java: 'java', via: 'PATH' };
  } catch {
    return null;
  }
}

/**
 * Compile and run the java adapter over the smoke fixture, then check the
 * output contract. Throws Error on any breach.
 * @param {{javac:string, java:string}} jdk
 * @param {{fixture?:string, buildDir?:string}} [opts]
 * @returns {{lines:number, header:Object}}
 */
export function runJavaSmoke(jdk, opts = {}) {
  const fixture = opts.fixture ?? path.join(ENGINE_ROOT, 'test', 'fixtures', 'java-smoke');
  const buildDir = opts.buildDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-smoke-'));
  const source = path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java');

  if (!fs.existsSync(fixture)) throw new Error(`missing fixture directory ${fixture}`);
  fs.mkdirSync(buildDir, { recursive: true });
  execFileSync(jdk.javac, ['-d', buildDir, source], { stdio: ['ignore', 'ignore', 'inherit'] });

  const stdout = execFileSync(jdk.java, ['-cp', buildDir, 'JavaFacts', '--root', fixture, fixture], { maxBuffer: 1 << 26 }).toString('utf8');
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 1) throw new Error('java adapter produced no JSON lines over the smoke fixture');

  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (e) {
    throw new Error(`first output line is not JSON: ${e.message} -- ${lines[0].slice(0, 200)}`);
  }
  if (header.schema !== JAVAFACTS_SCHEMA) {
    throw new Error(`first line must declare "schema":"${JAVAFACTS_SCHEMA}", got ${JSON.stringify(header.schema)}`);
  }
  if (!(header.files > 0)) throw new Error(`the adapter reported ${header.files} files over ${fixture}`);
  return { lines: lines.length, header };
}

// CLI entry point (only when run directly, so `node --test` can import this).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argOf = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
  };
  const javac = argOf('javac');
  const java = argOf('java');
  const jdk = javac && java ? { javac, java } : findJdk();
  if (!jdk) {
    process.stderr.write('java smoke: no JDK found (set JAVA_HOME or install one). This is not a pass.\n');
    process.exit(2);
  }
  try {
    const { lines, header } = runJavaSmoke(jdk);
    process.stdout.write(`java smoke OK: ${lines} JSONL records, schema ${header.schema}, `
      + `${header.files} files, ${header.types} types, ${header.endpoints} endpoints, ${header.calls} calls\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`java smoke FAILED: ${e.message}\n`);
    process.exit(1);
  }
}
