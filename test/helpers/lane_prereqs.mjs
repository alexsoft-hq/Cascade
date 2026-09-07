// lane_prereqs.mjs — ONE place that answers "can this test drive the real CLI?"
//
// A test that shells out to `cascade analyze` over a tree with a `.sql` file in
// it needs the SQL lane, and the SQL lane needs a python with sqlglot. On a
// machine that has never run `python3 -m venv .venv`, the CLI exits 2 with a
// clear message and the test used to fail with `2 !== 0`, which reads as broken
// code rather than as a missing prerequisite.
//
// The rule this file makes uniform is the one `test/java_smoke.test.mjs` and
// `test/helpers/mall_fixture.mjs` already follow: SKIP OUT LOUD, naming the
// prerequisite and the command that supplies it. CI is where the skip is
// forbidden: the `node` job builds the venv and then asserts that these files
// ran with `skipped 0`, so a permanent self-omission cannot hide here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The interpreter the CLI looks for, and whether it is there. */
export function sqlLaneVenv() {
  const python = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');
  return { ok: fs.existsSync(python), python };
}

/**
 * `t.skip(...)` and return true when the SQL lane cannot run, so a caller reads
 * `if (skipWithoutSqlLane(t)) return;`.
 * @param {import('node:test').TestContext} t
 * @returns {boolean} true when the test was skipped
 */
export function skipWithoutSqlLane(t) {
  const { ok, python } = sqlLaneVenv();
  if (ok) return false;
  t.skip(`no SQL lane interpreter at ${path.relative(ENGINE_ROOT, python)}: this test drives the real CLI over a tree that has a .sql file in it, `
    + 'so the run selects the SQL lane and needs sqlglot. Build it with `python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt` '
    + '(see docs/setup/sql-lane.md). CI builds it in the `node` job, where this test may not skip');
  return true;
}
