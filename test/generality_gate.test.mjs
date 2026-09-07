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
// AND ONE CEILING. `endpointColumnPairs` is guarded the other way up, because
// the defect it exists for makes the engine reach MORE than it should: RM37's
// smear put 9,400 false endpoint-to-column pairs into jeecg without adding one
// column any union count would have noticed, and every floor in this file
// stayed green. A rise past the fan-out budget is the regression there, and the
// planted-smear test below is the one that would have caught it.
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
  CORPUS, GUARDED, CEILINGS, GATE_SCHEMA, BASELINE_FILE,
  gateDir, checkoutStatus, runOne, readBaseline, compareToBaseline, baselineFrom, renderTable,
  endpointColumnPairs,
} from '../scripts/generality-gate.mjs';
import { Graph, FLOW_EDGE_TYPES } from '../src/core/graph.mjs';

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
    webCallsResolved: 40, screensReachingATable: 7, endpointColumnPairs: 100, ...over,
  });
  const base = {
    schema: GATE_SCHEMA,
    repos: {
      x: {
        sha: 'a'.repeat(40), endpointsReachingAStatement: 10, tablesReached: 5, columnsReached: 20,
        webCallsResolved: 40, screensReachingATable: 7, endpointColumnPairs: 100,
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

// ---------------------------------------------------------------------------
// the fan-out ceiling — the eye the gate did not have when RM37 slipped through
// ---------------------------------------------------------------------------

/**
 * A pack shaped like the corpus: an endpoint per controller, each controller
 * calling ITS OWN service, each service running one statement over one table of
 * `columnsEach` columns.
 *
 * `smeared: true` plants exactly the defect RM37 removed. One generic base
 * method resolved in every subclass at once, so every controller's export
 * called every SIBLING service as well as its own. Nothing new is reachable in
 * the pack as a whole, and everything is reachable from everywhere.
 *
 * @param {{controllers:number, columnsEach:number, smeared:boolean}} shape
 */
function corpusShapedPack({ controllers, columnsEach, smeared }) {
  const g = new Graph();
  for (let i = 0; i < controllers; i += 1) {
    g.addNode({ id: `endpoint:GET /c${i}/export`, kind: 'endpoint' });
    g.addEdge({ from: `endpoint:GET /c${i}/export`, to: `symbol:C${i}.export`, type: 'HANDLES', grade: 'EXACT' });
    g.addEdge({ from: `symbol:S${i}.list`, to: `statement:s${i}`, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    g.addEdge({ from: `statement:s${i}`, to: `table:t${i}`, type: 'EXECUTES', grade: 'EXACT' });
    for (let c = 0; c < columnsEach; c += 1) {
      g.addEdge({ from: `statement:s${i}`, to: `column:t${i}.c${c}`, type: 'READS', grade: 'EXACT' });
    }
  }
  for (let i = 0; i < controllers; i += 1) {
    // The honest call: this controller's own service. The smear adds the rest,
    // graded HEURISTIC exactly as a candidate-set call is.
    for (let j = 0; j < controllers; j += 1) {
      if (j !== i && !smeared) continue;
      g.addEdge({ from: `symbol:C${i}.export`, to: `symbol:S${j}.list`, type: 'MAY_CALL', grade: 'HEURISTIC' });
    }
  }
  return g;
}

/** The union counts the gate guarded BEFORE this round, measured off the graph. */
function unionCounts(graph) {
  const columns = new Set();
  const tables = new Set();
  let endpointsReachingAStatement = 0;
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    const reached = graph.reach(n.id, { mode: 'heuristic', edgeTypes: FLOW_EDGE_TYPES });
    let hasStatement = false;
    for (const id of reached.keys()) {
      if (id.startsWith('column:')) columns.add(id);
      else if (id.startsWith('table:')) tables.add(id);
      else if (id.startsWith('statement:')) hasStatement = true;
    }
    if (hasStatement) endpointsReachingAStatement += 1;
  }
  return { endpointsReachingAStatement, tablesReached: tables.size, columnsReached: columns.size };
}

test('a planted smear moves NO union count, and the fan-out metric catches it anyway', () => {
  const shape = { controllers: 8, columnsEach: 6 };
  const clean = corpusShapedPack({ ...shape, smeared: false });
  const smeared = corpusShapedPack({ ...shape, smeared: true });

  // FIRST, the reason this round exists: every number the gate guarded before
  // it is identical across the defect. This is not an assumption, it is
  // measured off the two graphs.
  assert.deepEqual(unionCounts(smeared), unionCounts(clean),
    'the smear adds no column, no table and no endpoint that was not already reached');

  // SECOND, what the fan-out metric sees: each of the 8 endpoints now reaches
  // all 48 columns instead of its own 6.
  const before = endpointColumnPairs(clean);
  const after = endpointColumnPairs(smeared);
  assert.equal(before.endpoints, 8);
  assert.equal(before.pairs, 48, 'one endpoint, its own six columns');
  assert.equal(after.pairs, 384, 'every endpoint reaching every service\'s columns');
  assert.deepEqual(before.capped, [], 'nothing was cut short');
  assert.deepEqual(after.capped, []);

  // THIRD, the gate goes RED on it, and on nothing else.
  const measured = (g) => ({
    id: 'demo', sha: 'a'.repeat(40), ok: true, ...unionCounts(g),
    webCallsResolved: 0, screensReachingATable: 0, endpointColumnPairs: endpointColumnPairs(g).pairs,
  });
  const baseline = { schema: GATE_SCHEMA, repos: { demo: { sha: 'a'.repeat(40), ...measured(clean) } } };
  const cmp = compareToBaseline([measured(smeared)], baseline);
  assert.equal(cmp.regressions.length, 1, `expected exactly one regression, got ${JSON.stringify(cmp.regressions)}`);
  assert.match(cmp.regressions[0], /^demo\.endpointColumnPairs: 48 -> 384, over the 50 this run was allowed/);
  assert.match(cmp.regressions[0], /inflated by more than 5 percent/);
  assert.deepEqual(cmp.improvements, []);
  assert.deepEqual(cmp.drift, []);
  assert.deepEqual(cmp.unknown, []);

  // And the fix for it is green: the clean pack against the clean baseline.
  assert.deepEqual(compareToBaseline([measured(clean)], baseline).regressions, []);
});

test('the fan-out ceiling: a fall is an improvement, a rise inside the budget is drift and fails nothing', () => {
  const at = (pairs) => ({
    id: 'x', sha: 'a'.repeat(40), ok: true, endpointsReachingAStatement: 10, tablesReached: 5,
    columnsReached: 20, webCallsResolved: 40, screensReachingATable: 7, endpointColumnPairs: pairs,
  });
  const base = { schema: GATE_SCHEMA, repos: { x: { ...at(100) } } };
  assert.equal(CEILINGS.endpointColumnPairs, 0.05, 'the budget a run may drift by');

  // RM37 itself: 25,397 pairs down to 15,997 is a precision gain, and the gate
  // reports it rather than failing on it.
  const tighter = compareToBaseline([at(80)], base);
  assert.deepEqual(tighter.regressions, []);
  assert.deepEqual(tighter.improvements, ['x.endpointColumnPairs: 100 -> 80, tighter']);

  // A rule that resolves one more call raises this number honestly. Inside the
  // budget it fails nothing, and it is still printed.
  const nudged = compareToBaseline([at(104)], base);
  assert.deepEqual(nudged.regressions, []);
  assert.deepEqual(nudged.drift, ['x.endpointColumnPairs: 100 -> 104, inside the 105 allowed']);
  assert.deepEqual(nudged.improvements, []);

  // One past the budget is a failure, so the boundary is where it says it is.
  assert.deepEqual(compareToBaseline([at(105)], base).regressions, []);
  assert.equal(compareToBaseline([at(106)], base).regressions.length, 1);
});

test('the fan-out walk counts a column once per endpoint, and says out loud when it stopped short', () => {
  // A diamond: two symbols under one endpoint reaching the SAME statement. The
  // pair is one, not two, or a refactor that split a method in half would read
  // as a smear.
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /d', kind: 'endpoint' });
  for (const s of ['A', 'B']) {
    g.addEdge({ from: 'endpoint:GET /d', to: `symbol:${s}`, type: 'HANDLES', grade: 'EXACT' });
    g.addEdge({ from: `symbol:${s}`, to: 'statement:one', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  }
  g.addEdge({ from: 'statement:one', to: 'column:t.c', type: 'READS', grade: 'EXACT' });
  assert.equal(endpointColumnPairs(g).pairs, 1);

  // A DECLARES hop is not flow: climbing table -> column would credit an
  // endpoint that touched only the table with every column of it.
  g.addEdge({ from: 'statement:one', to: 'table:t', type: 'EXECUTES', grade: 'EXACT' });
  g.addEdge({ from: 'table:t', to: 'column:t.other', type: 'DECLARES', grade: 'EXACT' });
  assert.equal(endpointColumnPairs(g).pairs, 1, 'DECLARES is ownership, not reach');

  // And a cap that binds is DISCLOSED, never a quietly smaller number.
  const wide = corpusShapedPack({ controllers: 4, columnsEach: 6, smeared: true });
  const cut = endpointColumnPairs(wide, { nodeCap: 5 });
  assert.equal(cut.capped.length, 4, 'every endpoint hit the cap');
  assert.ok(cut.pairs < endpointColumnPairs(wide).pairs, 'a capped walk reports less, and says so');
});

test('baselineFrom and renderTable describe the same run', () => {
  const m = {
    id: 'demo', sha: 'c'.repeat(40), frontSha: 'd'.repeat(40), ok: true, endpoints: 10, endpointsReachingAStatement: 8,
    statements: 20, statementsReached: 15, tables: 5, tablesReached: 4, columns: 40, columnsReached: 33,
    webCalls: 60, webCallsResolved: 41, screens: 56, screensReachingATable: 41, endpointColumnPairs: 77,
    axes: { catalog: 'shipped', column: 'degraded' }, nodes: 1, edges: 1, wallMs: 1200,
  };
  const b = baselineFrom([m]);
  assert.equal(b.schema, GATE_SCHEMA);
  assert.equal(b.repos.demo.columnsReached, 33);
  assert.equal(b.repos.demo.screensReachingATable, 41);
  assert.equal(b.repos.demo.endpointColumnPairs, 77, 'a guarded number is in the baseline it is guarded against');
  assert.equal(b.repos.demo.frontSha, 'd'.repeat(40), 'a pinned frontend is part of what was measured');
  assert.equal(b.repos.demo.wallMs, undefined, 'wall time is never a baseline: it belongs to the machine');
  const table = renderTable([m]);
  assert.match(table, /8 \/ 10 \(80%\)/);
  assert.match(table, /33 \/ 40/);
  assert.match(table, /41 \/ 60/, 'the web calls that reached a route, over the ones that carry a URL');
  assert.match(table, /41 \/ 56/, 'the screens that reach a table, over the screens there are');
  assert.match(table, /\| 77 +\|/, 'the fan-out sum, which has no denominator to print it over');
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
  for (const d of cmp.drift) t.diagnostic(`[drift] ${d}`);
  assert.deepEqual(
    cmp.regressions, [],
    'the engine reached LESS than the pinned baseline, or one endpoint reached further into it than the '
      + 'fan-out budget allows. Read what moved; if it is the intended change, re-run '
      + '`node scripts/generality-gate.mjs --accept` (it prints the diff and rewrites the baseline).',
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
