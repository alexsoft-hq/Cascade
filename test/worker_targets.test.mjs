// worker_targets.test.mjs — a worker is handed any number of targets, more than a command line holds.
//
// An incremental run hands the Java and web workers the files that changed.
// When the fact cache is gone while the pack's fact index remains (a wiped
// cache, a CI job that restores only `.cascade/`), every file has changed: on
// ruoyi-vue-pro that is 6,548 Java paths, and the run died with E2BIG before
// the worker started. The targets now go over in a file, one per line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { runJavaLane, runWebLane } from '../src/cli/lanes_run.mjs';

/** A real file, and 20,000 paths of 200 characters that name nothing: about 4 MB, past macOS's and Linux's limits. */
function manyTargets(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-targets-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, name), text);
  const missing = Array.from({ length: 20000 }, (_, i) => path.join(dir, 'gone', `${String(i).padStart(6, '0')}${'x'.repeat(180)}${path.extname(name)}`));
  return { dir, targets: [path.join(dir, name), ...missing] };
}

test('the Java worker reads a target list longer than a command line holds', (t) => {
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  const { dir, targets } = manyTargets(t, 'A.java', 'package p;\npublic class A {}\n');
  const types = runJavaLane(jdk, dir, targets, { quiet: true }).filter((r) => r.kind === 'type');
  assert.deepEqual(types.map((r) => r.fqn), ['p.A']);
});

test('the web worker reads a target list longer than a command line holds', (t) => {
  const { dir, targets } = manyTargets(t, 'a.js', "export function load() { return fetch('/api/items'); }\n");
  const functions = runWebLane(dir, targets).filter((r) => r.kind === 'function');
  assert.deepEqual(functions.map((r) => r.name), ['load']);
});
