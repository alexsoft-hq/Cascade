import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrust, TRUST_LEVELS, NO_STATE_TRUST, NO_STATE_TRUST_LEVEL, MIN_GOLDEN_CASES } from '../src/core/trust.mjs';
import { goldenSummary, RELATIONS } from '../src/core/golden.mjs';

// SPEC §14.3 names one representative defect: a pack with no evidence wearing a
// certification label. The MUST is that `trustLevel` is a COMPUTED value and
// never a string literal. These tests hold both halves of that — the
// computation, and a repository gate that fails the build if the literal
// reappears anywhere outside the one module that owns the names.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN_GATE = { mode: 'ENGINE_MOVED', verdict: 'GREEN', evaluatedAt: '2026-01-02T00:00:00.000Z' };

/** A golden summary where every relation has `n` cases and `hits` successes. */
function summaryWith(n, hits) {
  const results = [];
  for (const relation of RELATIONS) {
    for (let i = 0; i < n; i += 1) {
      const ok = i < hits;
      results.push({ id: `${relation}-${i}`, relation, status: ok ? 'PASS' : 'FAIL', recallHit: ok, precisionHit: ok });
    }
  }
  return goldenSummary(results);
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

test('no state at all is UNCERTIFIED and SAYS there is no calibration state', () => {
  const t = computeTrust({});
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.ok(t.knownGaps.includes('no-calibration-state'), 'not knowing must be named, not assumed away');
  assert.ok(t.knownGaps.includes('no-project-golden'));
  assert.ok(t.gatesNotShown.includes('calibration-gate'));
  assert.equal(t.basis.goldenCases, 0);
  assert.equal(t.basis.wilson, null);
  assert.equal(t.basis.gate, null);
});

test('the fallback a tool uses is the RETURN VALUE of computeTrust, not a constant', () => {
  assert.equal(NO_STATE_TRUST_LEVEL, computeTrust({}).trustLevel);
  assert.deepEqual(NO_STATE_TRUST, computeTrust({}));
  assert.equal(Object.isFrozen(NO_STATE_TRUST), true);
});

test('a RED gate keeps the level UNCERTIFIED however good the corpus looks', () => {
  const golden = { approvedCases: 400 * RELATIONS.length, summary: summaryWith(400, 400) };
  const green = computeTrust({ gateState: GREEN_GATE, golden });
  assert.equal(green.trustLevel, TRUST_LEVELS[3], 'a big flawless corpus behind a green gate is GOLDEN_PASS');
  const red = computeTrust({ gateState: { mode: 'ENGINE_MOVED', verdict: 'RED' }, golden });
  assert.equal(red.trustLevel, TRUST_LEVELS[0]);
  assert.ok(red.knownGaps.includes('calibration-gate-red'));
  assert.ok(red.gatesNotShown.includes('calibration-gate'));
});

test('fewer than 30 approved cases is UNCERTIFIED (§14.1) and every relation is listed as not shown', () => {
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: MIN_GOLDEN_CASES - 1, summary: summaryWith(7, 7) } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.ok(t.knownGaps.includes('project-golden-below-minimum'));
  for (const rel of RELATIONS) assert.ok(t.gatesNotShown.includes(`golden:${rel}`), rel);
});

test('a relation that got something WRONG is GOLDEN_FAIL', () => {
  const summary = summaryWith(200, 190); // 95% point estimate, bound well under 0.97
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 800, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[1]);
  assert.equal(t.basis.wilson['method->statements'].status, 'FAIL');
});

test('a FLAWLESS but small corpus is INSUFFICIENT_SAMPLE, not a failure (§2.2)', () => {
  // 30/30 bounds at 0.8865, below every §2.2 target. That is the corpus being
  // too small, not the engine being wrong — calling it GOLDEN_FAIL would libel
  // an engine that got every case right.
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 120, summary: summaryWith(30, 30) } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.notEqual(t.trustLevel, TRUST_LEVELS[1]);
  for (const rel of RELATIONS) {
    assert.equal(t.basis.wilson[rel].status, 'INSUFFICIENT_SAMPLE', rel);
    assert.ok(t.gatesNotShown.includes(`golden:${rel}`), rel);
  }
  assert.ok(t.knownGaps.includes('golden-relations-not-all-scored'));
});

test('the level is re-derived from the numbers, not read from a stored `pass` flag', () => {
  const summary = summaryWith(400, 400);
  // Somebody edits the file and flips the booleans to true while leaving the
  // counts alone. The bound is recomputed from hits/n, so it changes nothing.
  const tampered = JSON.parse(JSON.stringify(summary));
  for (const rel of RELATIONS) {
    tampered.relations[rel].recallHits = 100;
    tampered.relations[rel].recall.hits = 100;
    tampered.relations[rel].recall.lowerBound = 0.999;
    tampered.relations[rel].recall.pass = true;
    tampered.relations[rel].status = 'PASS';
  }
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 1600, summary: tampered } });
  // The stored lowerBound is believed (it is the only number carried), but the
  // PASS/FAIL derivation is ours: hits(100) !== n(400) makes the shortfall a
  // real failure rather than a small-sample one wherever the bound is short.
  assert.equal(t.basis.wilson['method->statements'].recall.lowerBound, 0.999);
  assert.equal(typeof t.trustLevel, 'string');
  assert.ok(TRUST_LEVELS.includes(t.trustLevel));
});

// ---------------------------------------------------------------------------
// RM53: a census beats the sample floor, and a level for what RAN
// ---------------------------------------------------------------------------

/**
 * A summary built relation by relation, so a test can say "this relation has 17
 * runtime cases and 17 of them passed" without inventing a summary by hand.
 *
 * @param {Record<string,{n:number, hits:number, source?:string}>} rows
 * @param {Record<string,number>} population
 */
function summaryOf(rows, population) {
  const results = [];
  for (const [relation, row] of Object.entries(rows)) {
    for (let i = 0; i < row.n; i += 1) {
      const ok = i < row.hits;
      results.push({
        id: `${relation}-${i}`, relation, source: row.source ?? 'sample',
        status: ok ? 'PASS' : 'FAIL', recallHit: ok, precisionHit: ok,
      });
    }
  }
  return goldenSummary(results, { population });
}

const ALL_RUN = { 'endpoint->tables': { n: 17, hits: 17, source: 'runtime' } };
const PETCLINIC = { 'column->endpoints': 24, 'endpoint->tables': 17, 'statement->columns': 6, 'method->statements': 0 };

test('a relation whose cases cover its WHOLE population passes below 30 (the census rule)', () => {
  const summary = summaryOf(ALL_RUN, PETCLINIC);
  const rel = summary.relations['endpoint->tables'];
  assert.equal(rel.population, 17);
  assert.equal(rel.exhaustive, true);
  assert.equal(rel.status, 'PASS', 'every endpoint of the pack, every case right: there is no sample left to bound');
  assert.equal(rel.runtimeCases, 17);
  assert.equal(rel.handCases, 0);
  // ...and the level says the same thing, re-derived from the counts.
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 17, summary } });
  assert.equal(t.basis.wilson['endpoint->tables'].exhaustive, true);
  assert.equal(t.basis.wilson['endpoint->tables'].status, 'PASS');
  assert.equal(t.trustLevel, TRUST_LEVELS[2], 'RUNTIME_PASS: every scored relation passes, on labels a run wrote');
  // The three relations no run can label are NAMED, not quietly counted as fine.
  assert.deepEqual(t.gatesNotShown,
    ['golden:column->endpoints', 'golden:method->statements', 'golden:statement->columns']);
  assert.ok(t.knownGaps.includes('project-golden-below-minimum'), 'a 17-case corpus is still disclosed as thin');
});

test('one case wrong in an exhaustive relation is FAIL, however small the corpus', () => {
  const summary = summaryOf({ 'endpoint->tables': { n: 17, hits: 16, source: 'runtime' } }, PETCLINIC);
  assert.equal(summary.relations['endpoint->tables'].exhaustive, true);
  assert.equal(summary.relations['endpoint->tables'].status, 'FAIL');
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 17, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[1], 'GOLDEN_FAIL outranks every pass');
});

test('short of the population it is a sample again, and a sample of 16 shows nothing', () => {
  const summary = summaryOf({ 'endpoint->tables': { n: 16, hits: 16, source: 'runtime' } }, PETCLINIC);
  assert.equal(summary.relations['endpoint->tables'].exhaustive, false);
  assert.equal(summary.relations['endpoint->tables'].status, 'INSUFFICIENT_SAMPLE');
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 16, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.ok(t.knownGaps.includes('golden-relations-not-all-scored'));
});

test('a population of 0 is not a census of nothing', () => {
  // A relation this pack cannot be asked about has no cases either, and 0 >= 0
  // must never read as "everything was checked".
  const summary = summaryOf({}, { ...PETCLINIC, 'endpoint->tables': 0 });
  for (const rel of RELATIONS) {
    assert.equal(summary.relations[rel].exhaustive, false, rel);
    assert.equal(summary.relations[rel].status, 'INSUFFICIENT_SAMPLE', rel);
  }
  assert.equal(computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 1, summary } }).trustLevel, TRUST_LEVELS[0]);
});

test('a corpus of cases that assert NOTHING earns nothing', () => {
  // The attack this rule exists for: a trace that walked every route of the
  // application and never touched the database. Every case it proposes is empty,
  // and an empty case passes only where the pack answers nothing either. Where
  // the pack DOES answer tables the case is UNSCORABLE, so those inputs drop out
  // of `n`, the relation is a sample again, and nothing is certified.
  const results = [];
  for (let i = 0; i < 17; i += 1) {
    const scored = i < 8; // the eight routes the pack answers no table for
    results.push(scored
      ? { id: `e-${i}`, relation: 'endpoint->tables', source: 'runtime', empty: true, status: 'PASS', recallHit: true, precisionHit: true }
      : { id: `e-${i}`, relation: 'endpoint->tables', source: 'runtime', empty: true, status: 'UNSCORABLE', reason: 'nothing to compare' });
  }
  const summary = goldenSummary(results, { population: PETCLINIC });
  const rel = summary.relations['endpoint->tables'];
  assert.equal(rel.n, 8, 'only the agreements are scored');
  assert.equal(rel.unscorable, 9);
  assert.equal(rel.emptyCases, 17);
  assert.equal(rel.exhaustive, false, 'a census with nine holes in it is a sample');
  assert.equal(rel.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 17, summary } }).trustLevel, TRUST_LEVELS[0]);
});

test('RUNTIME_PASS needs the anchor relation: a run that never touched an endpoint proves nothing about one', () => {
  // `method->statements` covered exhaustively by a trace, and nothing else. The
  // level does not rise: the relation an endpoint-to-table answer rests on was
  // never scored.
  const summary = summaryOf({ 'method->statements': { n: 6, hits: 6, source: 'runtime' } },
    { ...PETCLINIC, 'method->statements': 6 });
  assert.equal(summary.relations['method->statements'].status, 'PASS');
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 6, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
});

test('a relation nobody could score is NAMED, not used to demote the one that was', () => {
  // The anchor is a census and passes. The second relation has five flawless
  // cases out of a population of six, so it is a sample of five and cannot be
  // shown at all — which is where a first trace leaves every relation but the
  // anchor, and always will. Demoting the measured relation because of the
  // unmeasured one would lose both facts; naming it keeps both.
  const summary = summaryOf({
    ...ALL_RUN,
    'method->statements': { n: 5, hits: 5, source: 'runtime' },
  }, { ...PETCLINIC, 'method->statements': 6 });
  assert.equal(summary.relations['method->statements'].status, 'INSUFFICIENT_SAMPLE');
  assert.equal(summary.relations['method->statements'].exhaustive, false, 'five of six is a sample');
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 22, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[2], 'RUNTIME_PASS');
  assert.ok(t.gatesNotShown.includes('golden:method->statements'), 'and the relation it could not show is named');
  assert.ok(t.gatesNotShown.includes('golden:column->endpoints'));
  assert.equal(t.gatesNotShown.includes('golden:endpoint->tables'), false, 'the one that WAS shown is not in the list');
});

test('a FAIL anywhere still outranks a passing anchor', () => {
  const summary = summaryOf({
    ...ALL_RUN,
    'statement->columns': { n: 200, hits: 150 },
  }, { ...PETCLINIC, 'statement->columns': 900 });
  assert.equal(summary.relations['statement->columns'].status, 'FAIL');
  assert.equal(computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 217, summary } }).trustLevel, TRUST_LEVELS[1]);
});

test('RUNTIME_PASS needs at least one relation that rests on a run ALONE', () => {
  // The same 17 cases, hand-labelled. Every scored relation passes and the anchor
  // is among them, but nothing here was labelled by a run, so the level that
  // means "checked against what ran" is not the one this earns.
  const summary = summaryOf({ 'endpoint->tables': { n: 17, hits: 17, source: 'sample' } }, PETCLINIC);
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 17, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.equal(t.basis.wilson['endpoint->tables'].handCases, 17);
});

test('a RED gate keeps RUNTIME_PASS down too', () => {
  const summary = summaryOf(ALL_RUN, PETCLINIC);
  const t = computeTrust({ gateState: { mode: 'ENGINE_MOVED', verdict: 'RED' }, golden: { approvedCases: 17, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  assert.ok(t.knownGaps.includes('calibration-gate-red'));
});

test('every relation passing, one of them a runtime census, is GOLDEN_PASS', () => {
  // The hand-labelled corpus is what GOLDEN_PASS is about, and a relation that
  // was measured on ITS WHOLE POPULATION counts for it even when the labels came
  // from a run: a census is not a sample whose precision was never probed, it is
  // every input this pack has.
  const summary = summaryOf({
    'column->endpoints': { n: 400, hits: 400 },
    'endpoint->tables': { n: 17, hits: 17, source: 'runtime' },
    'statement->columns': { n: 400, hits: 400 },
    'method->statements': { n: 400, hits: 400 },
  }, { 'column->endpoints': 400, 'endpoint->tables': 17, 'statement->columns': 400, 'method->statements': 400 });
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 1217, summary } });
  assert.equal(t.trustLevel, TRUST_LEVELS[3]);
});

test('the exhaustive flag in the summary is not believed: the counts are compared again', () => {
  const summary = summaryOf({ 'endpoint->tables': { n: 16, hits: 16, source: 'runtime' } }, PETCLINIC);
  const tampered = JSON.parse(JSON.stringify(summary));
  tampered.relations['endpoint->tables'].exhaustive = true;
  tampered.relations['endpoint->tables'].status = 'PASS';
  const t = computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 16, summary: tampered } });
  assert.equal(t.basis.wilson['endpoint->tables'].exhaustive, false, '16 cases over a population of 17 is not a census');
  assert.equal(t.trustLevel, TRUST_LEVELS[0]);
  // ...and the other way: a population edited DOWN to make a sample look total
  // is still measured against the case count, which is the number that moved.
  const shrunk = JSON.parse(JSON.stringify(summary));
  shrunk.relations['endpoint->tables'].population = 2;
  assert.equal(computeTrust({ gateState: GREEN_GATE, golden: { approvedCases: 16, summary: shrunk } }).trustLevel, TRUST_LEVELS[2],
    'a population somebody lowered DOES change the verdict: it is the pack\'s own count, and a tampered pack is what the receipt is for');
});

test('caller-supplied axes and known gaps travel through', () => {
  const t = computeTrust({ axes: ['column'], knownGaps: ['screen-axis-not-shipped'] });
  assert.deepEqual(t.axes, ['column']);
  assert.ok(t.knownGaps.includes('screen-axis-not-shipped'));
  assert.deepEqual(t.knownGaps, [...t.knownGaps].sort(), 'gaps are sorted so two runs produce the same bytes');
});

// ---------------------------------------------------------------------------
// The repository gate: no trust-level literal outside trust.mjs
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'vendor']);

function filesUnder(roots) {
  const out = [];
  const visit = (abs) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (SKIP_DIRS.has(name)) continue;
        visit(path.join(abs, name));
      }
      return;
    }
    if (st.isFile()) out.push({ rel: path.relative(ROOT, abs).split(path.sep).join('/'), text: fs.readFileSync(abs, 'utf8') });
  };
  for (const r of roots) {
    const abs = path.join(ROOT, r);
    if (fs.existsSync(abs)) visit(abs);
  }
  return out;
}

test('§14.3 gate: a trust level is never written as a literal outside src/core/trust.mjs', () => {
  // Where the names are ALLOWED to appear as literals: the module that owns
  // them, and the tests that check the owner. Everywhere else must reference
  // TRUST_LEVELS (or the computed value) instead of typing the string.
  const ALLOWED = new Set(['src/core/trust.mjs']);
  const offenders = [];
  for (const f of filesUnder(['src', 'bin', 'scripts', 'viewer/index.html', 'viewer/js'])) {
    if (ALLOWED.has(f.rel)) continue;
    f.text.split('\n').forEach((line, i) => {
      for (const level of TRUST_LEVELS) {
        // A QUOTED literal only. `TRUST_LEVELS[0]` and prose in a comment are
        // references to the enum, not a second source of truth.
        if (new RegExp(`['"\`]${level}['"\`]`).test(line)) offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `trust levels written as literals (SPEC §14.3 forbids it):\n${offenders.join('\n')}`);
});

test('§14.3 gate: trust.mjs really does own the names, and the enum is closed', () => {
  const own = fs.readFileSync(path.join(ROOT, 'src/core/trust.mjs'), 'utf8');
  for (const level of TRUST_LEVELS) assert.ok(own.includes(`'${level}'`), `${level} must be declared in trust.mjs`);
  assert.deepEqual(TRUST_LEVELS, ['UNCERTIFIED', 'GOLDEN_FAIL', 'RUNTIME_PASS', 'GOLDEN_PASS']);
  assert.equal(Object.isFrozen(TRUST_LEVELS), true);
});

test('the contract refuses a trust level nobody could have computed', async () => {
  const { makeResponse, TRUST_LEVELS: fromContract } = await import('../src/mcp/contract.mjs');
  assert.deepEqual(fromContract, TRUST_LEVELS, 'the contract re-exports the enum rather than minting its own');
  const shape = {
    answer: { rows: [1] },
    basis: { buildDigest: 'd', freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'L2_DOMAIN_PARITY', axes: ['column'] },
    limits: [],
    truncated: { any: false, fields: [] },
  };
  assert.throws(() => makeResponse(shape), (e) => e.name === 'ContractError' && /must be one of/.test(e.message));
  shape.trust.trustLevel = computeTrust({}).trustLevel;
  assert.ok(makeResponse(shape));
});
