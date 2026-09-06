import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKER_VERSION_SOURCES, workerVersions } from '../src/core/worker_versions.mjs';

// Every fact shard's key folds in the version of the worker that produced it
// (SPEC §17.7), and the engine reads those versions from a MIRROR so it does not
// have to start a JVM and two Python interpreters to plan a run. A mirror that
// drifts silently would let two generations of facts share one cache — the exact
// failure the version is there to prevent. So the drift is a test, not a habit.

const ROOT = new URL('../', import.meta.url);

test('every mirrored worker version matches the constant in the worker source', () => {
  for (const src of WORKER_VERSION_SOURCES) {
    const file = fileURLToPath(new URL(src.file, ROOT));
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(src.re);
    assert.ok(m, `${src.file} no longer declares its version constant (looked for ${src.re})`);
    assert.equal(
      m[1], src.expected,
      `${src.file} declares version ${m[1]} but src/core/worker_versions.mjs mirrors ${src.expected} — `
      + 'bump the mirror (and remember that a bump invalidates every cached shard from that worker, on purpose)',
    );
  }
});

test('workerVersions() names exactly the five workers the facts index records', () => {
  assert.deepEqual(Object.keys(workerVersions()).sort(), ['catalog', 'java', 'lineage', 'mybatis', 'web']);
  for (const [name, v] of Object.entries(workerVersions())) {
    assert.match(v, /^[a-z-]+\/\d+$/, `${name} version ${v} should read like "<worker>/<n>"`);
  }
});

test('the drift check covers every worker source, the web one included', () => {
  const names = WORKER_VERSION_SOURCES.map((s) => s.name).sort();
  assert.deepEqual(names, ['catalog', 'catalog-live', 'java', 'lineage', 'mybatis', 'web']);
  // ...and the regex really is anchored to the worker's own declaration, so a
  // constant that moves without the mirror moving is caught rather than matched
  // loosely somewhere else in the file.
  const web = WORKER_VERSION_SOURCES.find((s) => s.name === 'web');
  assert.equal(web.file, 'adapters/web/webfacts.mjs');
  assert.equal(/^const VERSION = '([^']+)'/m.exec("const VERSION = 'webfacts/9';\n")[1], 'webfacts/9');
  assert.equal(/^const VERSION = '([^']+)'/m.test("  const VERSION = 'webfacts/9';\n"), false,
    'an indented look-alike must not satisfy the check');
});
