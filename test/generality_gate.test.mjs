// generality_gate.test.mjs — the generality gate as a REGRESSION TEST.
//
// `scripts/generality-gate.mjs` runs the engine over a pinned corpus of real
// repositories with no per-project configuration. This turns that run into a
// number the repository defends: every guarded reach count must be at least what
// `test/fixtures/generality-gate.baseline.json` records for that commit.
//
// WHY A FLOOR AND NOT AN EQUALITY. A rule that resolves more calls raises these
// numbers, and a test that demanded equality would fail on every improvement and
// train everybody to re-accept it without looking. A floor fails only on the
// thing worth failing on: a change that made the engine reach LESS. Raising the
// floor is deliberate — `node scripts/generality-gate.mjs --accept`, with the
// diff printed.
//
// THE SKIP IS LOUD. The corpus is about a gigabyte of other people's source and
// is not cloned by `npm test`; when it is absent this test says so, names the
// directory it looked in and the command that fills it, and skips. CI runs it in
// its own `gate` job (weekly and on demand), where the clones are really there —
// SPEC §16.3: an existence check must not become a permanent self-omission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CORPUS, GUARDED, GATE_SCHEMA, BASELINE_FILE,
  gateDir, checkoutStatus, runOne, readBaseline, compareToBaseline, baselineFrom, renderTable,
} from '../scripts/generality-gate.mjs';

// ---------------------------------------------------------------------------
// the parts that need no corpus at all
// ---------------------------------------------------------------------------

test('the corpus is pinned: every entry names a repository, a full sha and what it is', () => {
  assert.ok(CORPUS.length >= 10, `the corpus has ${CORPUS.length} entries`);
  const ids = new Set();
  for (const e of CORPUS) {
    assert.match(e.id, /^[a-z0-9][a-z0-9-]*$/, `${e.id} must be a plain id`);
    assert.ok(!ids.has(e.id), `${e.id} is listed twice`);
    ids.add(e.id);
    assert.match(e.url, /^https:\/\//, `${e.id} must name an https url`);
    assert.match(e.sha, /^[0-9a-f]{40}$/, `${e.id} must pin a full sha`);
    assert.ok(typeof e.note === 'string' && e.note.length > 5, `${e.id} must say what it is`);
    // `ddl` is the ONLY per-project input the gate may give, and it is a list of
    // repository-relative paths — never a flag, never a profile edit.
    assert.ok(e.ddl === null || (Array.isArray(e.ddl) && e.ddl.every((f) => typeof f === 'string')), `${e.id}.ddl`);
    // A frontend in a repository of its own is pinned exactly like the backend:
    // a url, a full sha and the source directory inside it. Anything less and
    // the screen numbers below would be a property of whatever was checked out.
    if (e.front !== undefined) {
      assert.match(e.front.url, /^https:\/\//, `${e.id}.front must name an https url`);
      assert.match(e.front.sha, /^[0-9a-f]{40}$/, `${e.id}.front must pin a full sha`);
      assert.match(e.front.dir, /^[A-Za-z0-9._\-/]+$/, `${e.id}.front.dir must be a path inside that clone`);
      assert.deepEqual(Object.keys(e.front).sort(), ['dir', 'sha', 'url'], `${e.id}.front carries nothing else`);
    }
  }
  // Four of them are a backend AND a frontend, which is what the round trip is.
  const pairs = CORPUS.filter((e) => e.front).map((e) => e.id);
  assert.ok(pairs.length >= 2, `the corpus pins ${pairs.length} frontend repositories of their own`);
});

test('the frontend pairs are named where a reader looks: their own repo, or the note', () => {
  // Two of the four frontends sit INSIDE the backend repository, so they need
  // no second clone and no flag. That is worth stating in the entry, because a
  // reader comparing the table's screen column against the CORPUS would
  // otherwise read "no front" as "no frontend".
  for (const e of CORPUS.filter((x) => !x.front && /frontend/.test(x.note))) {
    assert.match(e.note, /inside this repository/, `${e.id} must say where its frontend is`);
  }
});

test('the baseline is a floor for every guarded count, and nothing else', () => {
  const baseline = readBaseline();
  assert.ok(baseline, `no baseline at ${BASELINE_FILE}`);
  assert.equal(baseline.schema, GATE_SCHEMA);
  for (const [id, b] of Object.entries(baseline.repos)) {
    assert.ok(CORPUS.some((e) => e.id === id), `${id} is in the baseline but not in the corpus`);
    assert.match(b.sha, /^[0-9a-f]{40}$/, `${id} must record the commit it was measured at`);
    for (const k of GUARDED) assert.ok(Number.isInteger(b[k]), `${id}.${k} must be an integer`);
  }
});

test('compareToBaseline: a DROP fails, a RISE does not, and a moved pin is not comparable', () => {
  const at = (sha, over) => ({
    id: 'x', sha, ok: true, endpointsReachingAStatement: 10, tablesReached: 5, columnsReached: 20,
    webCallsResolved: 40, screensReachingATable: 7, ...over,
  });
  const base = {
    schema: GATE_SCHEMA,
    repos: {
      x: {
        sha: 'a'.repeat(40), endpointsReachingAStatement: 10, tablesReached: 5, columnsReached: 20,
        webCallsResolved: 40, screensReachingATable: 7,
      },
    },
  };

  assert.deepEqual(compareToBaseline([at('a'.repeat(40))], base).regressions, []);
  assert.deepEqual(
    compareToBaseline([at('a'.repeat(40), { tablesReached: 4 })], base).regressions,
    ['x.tablesReached: 5 -> 4'],
  );
  // The screen end is guarded the same way: a frontend call this engine stops
  // following, or a screen that stops reaching a table, is a regression too.
  assert.deepEqual(
    compareToBaseline([at('a'.repeat(40), { screensReachingATable: 6 })], base).regressions,
    ['x.screensReachingATable: 7 -> 6'],
  );
  assert.deepEqual(
    compareToBaseline([at('a'.repeat(40), { webCallsResolved: 39 })], base).regressions,
    ['x.webCallsResolved: 40 -> 39'],
  );
  const up = compareToBaseline([at('a'.repeat(40), { columnsReached: 30 })], base);
  assert.deepEqual(up.regressions, []);
  assert.deepEqual(up.improvements, ['x.columnsReached: 20 -> 30'], 'a rise is reported and changes nothing');
  // A run at another commit measures another program; comparing them would be
  // meaningless, so it is reported as unknown rather than as a pass or a fail.
  const moved = compareToBaseline([at('b'.repeat(40))], base);
  assert.deepEqual(moved.regressions, []);
  assert.equal(moved.unknown.length, 1);
  assert.match(moved.unknown[0], /not comparable/);
  // A repository with no baseline row is not silently passed either.
  assert.match(compareToBaseline([at('a'.repeat(40), { id: 'y' })], base).unknown[0], /not in the baseline/);
  // A run that FAILED is a regression, whatever the baseline says.
  assert.deepEqual(
    compareToBaseline([{ id: 'x', sha: 'a'.repeat(40), ok: false, error: 'analyze wrote no pack' }], base).regressions,
    ['x: the run FAILED — analyze wrote no pack'],
  );
});

test('baselineFrom and renderTable describe the same run', () => {
  const m = {
    id: 'demo', sha: 'c'.repeat(40), frontSha: 'd'.repeat(40), ok: true, endpoints: 10, endpointsReachingAStatement: 8,
    statements: 20, statementsReached: 15, tables: 5, tablesReached: 4, columns: 40, columnsReached: 33,
    webCalls: 60, webCallsResolved: 41, screens: 56, screensReachingATable: 41,
    axes: { catalog: 'shipped', column: 'degraded' }, nodes: 1, edges: 1, wallMs: 1200,
  };
  const b = baselineFrom([m]);
  assert.equal(b.schema, GATE_SCHEMA);
  assert.equal(b.repos.demo.columnsReached, 33);
  assert.equal(b.repos.demo.screensReachingATable, 41);
  assert.equal(b.repos.demo.frontSha, 'd'.repeat(40), 'a pinned frontend is part of what was measured');
  assert.equal(b.repos.demo.wallMs, undefined, 'wall time is never a baseline: it belongs to the machine');
  const table = renderTable([m]);
  assert.match(table, /8 \/ 10 \(80%\)/);
  assert.match(table, /33 \/ 40/);
  assert.match(table, /41 \/ 60/, 'the web calls that reached a route, over the ones that carry a URL');
  assert.match(table, /41 \/ 56/, 'the screens that reach a table, over the screens there are');
  assert.match(table, /column=degraded/);
});

// ---------------------------------------------------------------------------
// the run itself — only when the corpus is really on this machine
// ---------------------------------------------------------------------------

test('the pinned corpus reaches at least what the baseline records', { timeout: 3_600_000 }, (t) => {
  const ready = CORPUS.map((e) => ({ entry: e, st: checkoutStatus(e) }));
  const usable = ready.filter((r) => r.st.present);
  if (usable.length === 0) {
    t.skip(`no corpus repository is cloned at its pin under ${gateDir()} — `
      + `run \`node scripts/generality-gate.mjs --fetch\` (about 1 GB), or set CASCADE_GATE_DIR to a directory that has them. `
      + `Checked: ${ready.map((r) => `${r.entry.id} (${r.st.why})`).join('; ')}`);
    return;
  }
  const missing = ready.filter((r) => !r.st.present);
  if (missing.length > 0) {
    // Not a skip and not a failure: the repositories that ARE here are still
    // measured, and the ones that are not are named so nobody reads a partial
    // run as a whole one.
    t.diagnostic(`${missing.length} corpus repo(s) not measured: ${missing.map((r) => `${r.entry.id} (${r.st.why})`).join('; ')}`);
  }

  const results = usable.map((r) => runOne(r.entry, { log: (s) => t.diagnostic(s) }));
  t.diagnostic(`\n${renderTable(results)}`);
  const cmp = compareToBaseline(results, readBaseline());
  for (const u of cmp.unknown) t.diagnostic(`[unknown] ${u}`);
  for (const i of cmp.improvements) t.diagnostic(`[improved] ${i}`);
  assert.deepEqual(
    cmp.regressions, [],
    'the engine reached LESS than the pinned baseline. Read what moved; if the drop is the intended change, '
      + 're-run `node scripts/generality-gate.mjs --accept` (it prints the diff and rewrites the baseline).',
  );
});

test('the baseline file is committed, and every corpus entry the CI gate runs has a row', () => {
  // A corpus entry with no baseline row is a repository the gate would measure
  // and never compare — worse than not listing it, because the table looks full.
  assert.ok(fs.existsSync(BASELINE_FILE), `${BASELINE_FILE} must be committed`);
  const baseline = readBaseline();
  const missing = CORPUS.filter((e) => !baseline.repos[e.id]).map((e) => e.id);
  assert.deepEqual(missing, [], `corpus entries with no baseline row: ${missing.join(', ')}`);
});
