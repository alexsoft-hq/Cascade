import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { findJdk, runJavaSmoke, JAVAFACTS_SCHEMA } from '../scripts/ci-java-smoke.mjs';

// The java lane needs a JDK. When one is absent this test SKIPS WITH A REASON —
// never silently (SPEC §16.3: an existence check must not become a permanent
// self-omission). The CI `java` job has a JDK, so the check really runs there.
test('java adapter smoke: compiles, runs over the fixture and emits cascade:javafacts:1', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-smoke-test-'));
  t.after(() => fs.rmSync(buildDir, { recursive: true, force: true }));

  const { lines, header } = runJavaSmoke(jdk, { buildDir });
  assert.ok(lines >= 1, 'expected at least one JSONL record');
  assert.equal(header.schema, JAVAFACTS_SCHEMA);
  assert.equal(header.kind, 'header');
  assert.equal(header.files, 4, 'the fixture has four java files');
  assert.equal(header.entities, 2, 'the fixture declares an @Entity and a @MappedSuperclass');
  assert.equal(header.repositories, 1, 'the fixture declares one Spring Data repository');
  assert.ok(header.endpoints >= 1, 'the fixture controller must yield an endpoint');
  assert.ok(header.calls >= 1, 'the fixture must yield at least one call edge');
});

// THREE RUNS, BYTE FOR BYTE. Every pack digest in this repository rests on the
// claim that a worker over unchanged source prints unchanged bytes: a map
// iterated in hash order, a set of files walked in directory order, a
// HashMap.toString anywhere in the record shape, and the digest becomes a coin
// toss that only shows up as an unexplained rebuild months later. The web
// worker has the same check (test/webfacts.test.mjs); this is the Java one.
test('three runs of the java worker over the same tree print identical bytes', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-java-determinism-'));
  t.after(() => fs.rmSync(buildDir, { recursive: true, force: true }));

  const first = runJavaSmoke(jdk, { buildDir }).stdout;
  assert.ok(first.length > 0, 'the worker printed nothing');
  for (let run = 2; run <= 3; run += 1) {
    assert.equal(runJavaSmoke(jdk, { buildDir }).stdout, first, `run ${run} does not match run 1 byte for byte`);
  }
});

test('the java smoke fixture stays tiny and package-neutral', () => {
  const fixture = new URL('./fixtures/java-smoke/com/example/', import.meta.url);
  const files = fs.readdirSync(fixture);
  assert.ok(files.length <= 5, `the fixture must stay <= 5 files, found ${files.length}`);
  for (const f of files) {
    const text = fs.readFileSync(new URL(f, fixture), 'utf8');
    assert.match(text, /^package com\.example;/m, `${f} must live in com.example`);
  }
});
