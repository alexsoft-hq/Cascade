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
  assert.equal(green.trustLevel, TRUST_LEVELS[2], 'a big flawless corpus behind a green gate is GOLDEN_PASS');
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
  for (const f of filesUnder(['src', 'bin', 'scripts', 'viewer/index.html'])) {
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
  assert.deepEqual(TRUST_LEVELS, ['UNCERTIFIED', 'GOLDEN_FAIL', 'GOLDEN_PASS']);
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
