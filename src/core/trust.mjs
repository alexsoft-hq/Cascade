// trust.mjs — the trust level, COMPUTED (SPEC §14.3, §2.2).
//
// SPEC §14.3 names this as the representative defect to fix: a brand-new project
// with no golden corpus must not bake a certification label into its pack. The
// MUST is blunt — `trustLevel` is a COMPUTED VALUE, string literals forbidden.
// So this module owns the three level names, and it is the only place in the
// engine that may write them down. `test/trust.test.mjs` greps the tree and
// fails the build if the literal reappears anywhere else outside the tests.
//
// The computation is deliberately pessimistic, in this order:
//
//   1. No calibration state at all (a bare `--pack`, a pack built before the
//      calibration layer) -> UNCERTIFIED, gap `no-calibration-state`. Not
//      knowing is not the same as passing.
//   2. A gate that is not GREEN/BOOTSTRAP -> UNCERTIFIED. A pack whose own
//      regression gate went red cannot lend confidence to an answer.
//   3. Fewer than 30 approved golden cases -> UNCERTIFIED (§14.1: N=30 is where
//      a project golden starts; below that every gate is INSUFFICIENT_SAMPLE and
//      §14.3 requires the level to be UNCERTIFIED, not "probably fine").
//   4. 30+ cases and a relation that actually got something WRONG, with a Wilson
//      lower bound below its §2.2 target -> GOLDEN_FAIL.
//   5. A relation that got everything right but is still short of its target is
//      INSUFFICIENT_SAMPLE, not a failure (§2.2 says so in as many words) — and
//      a level with any unscored relation stays UNCERTIFIED. Note what that
//      implies: 30 flawless cases bound at 0.8865, so no 95% target can be shown
//      at N=30. §14.1's N=30 is where a corpus may START being scored, not where
//      it becomes sufficient; `nForTarget` in the summary says how many it takes.
//   6. Otherwise GOLDEN_PASS — which §2.2 is careful to call evidence of NO
//      REGRESSION, not a certification.
//
// Pure: state in, verdict out. The CLI reads the files.

/**
 * The only place these three names are spelled. A consumer compares against
 * these constants; nothing else in `src/` or `bin/` writes the strings.
 */
export const TRUST_LEVELS = Object.freeze(['UNCERTIFIED', 'GOLDEN_FAIL', 'GOLDEN_PASS']);

/** The smallest project golden that may be scored at all (SPEC §14.1). */
export const MIN_GOLDEN_CASES = 30;

/** Gate verdicts that let an answer be more than UNCERTIFIED. */
const PASSING_GATES = Object.freeze(['GREEN', 'BOOTSTRAP']);

/**
 * The trust block every response carries.
 *
 * @param {{gateState?:Object|null, golden?:Object|null, axes?:string[],
 *          knownGaps?:string[]}} input
 * @returns {{trustLevel:string, axes:string[], gatesNotShown:string[],
 *            knownGaps:string[], basis:{goldenCases:number, wilson:Object|null,
 *            gate:Object|null}}}
 */
export function computeTrust(input = {}) {
  const gateState = input.gateState && typeof input.gateState === 'object' ? input.gateState : null;
  const golden = input.golden && typeof input.golden === 'object' ? input.golden : null;
  const axes = Array.isArray(input.axes) ? input.axes.slice() : [];
  const gaps = new Set(Array.isArray(input.knownGaps) ? input.knownGaps : []);
  const gatesNotShown = [];

  const goldenCases = Number.isInteger(golden?.approvedCases) ? golden.approvedCases : 0;
  const relations = golden?.summary && typeof golden.summary.relations === 'object' ? golden.summary.relations : null;
  const wilson = relations ? wilsonView(relations) : null;

  let level = TRUST_LEVELS[0]; // UNCERTIFIED unless everything below says otherwise
  if (!gateState) {
    gaps.add('no-calibration-state');
    gatesNotShown.push('calibration-gate');
  } else if (!PASSING_GATES.includes(gateState.verdict)) {
    gaps.add('calibration-gate-red');
    gatesNotShown.push('calibration-gate');
  }

  if (goldenCases < MIN_GOLDEN_CASES) {
    gaps.add(goldenCases === 0 ? 'no-project-golden' : 'project-golden-below-minimum');
    for (const rel of relations ? Object.keys(relations).sort() : []) gatesNotShown.push(`golden:${rel}`);
    if (!relations) gatesNotShown.push('golden:all-relations');
  } else if (wilson) {
    // Every relation that could not be scored is NAMED, so an AI reading the
    // response can tell "this relation passed" from "this relation was never
    // measured" (SPEC §14.3: golden 0 -> every gate INSUFFICIENT_SAMPLE).
    for (const [rel, r] of Object.entries(wilson).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (r.status === 'INSUFFICIENT_SAMPLE') gatesNotShown.push(`golden:${rel}`);
    }
    const anyFail = Object.values(wilson).some((r) => r.status === 'FAIL');
    const anyPass = Object.values(wilson).some((r) => r.status === 'PASS');
    const anyUnscored = Object.values(wilson).some((r) => r.status !== 'PASS');
    if (anyFail) level = TRUST_LEVELS[1]; // GOLDEN_FAIL
    else if (anyPass && !anyUnscored && gateState && PASSING_GATES.includes(gateState.verdict)) level = TRUST_LEVELS[2]; // GOLDEN_PASS
    else gaps.add('golden-relations-not-all-scored');
  } else {
    gaps.add('golden-never-checked');
    gatesNotShown.push('golden:all-relations');
  }

  // A red (or missing) gate can never be talked up by a golden run: whatever the
  // corpus says, the level falls back to UNCERTIFIED.
  if ((!gateState || !PASSING_GATES.includes(gateState.verdict)) && level === TRUST_LEVELS[2]) {
    level = TRUST_LEVELS[0];
  }

  return {
    trustLevel: level,
    axes,
    gatesNotShown: [...new Set(gatesNotShown)].sort(),
    knownGaps: [...gaps].sort(),
    basis: {
      goldenCases,
      wilson,
      gate: gateState
        ? { mode: gateState.mode ?? null, verdict: gateState.verdict ?? null, evaluatedAt: gateState.evaluatedAt ?? null }
        : null,
    },
  };
}

/**
 * The level a caller with NO state at all gets. It is the RETURN VALUE of
 * `computeTrust`, evaluated once — not a literal — so a tool that needs a
 * fallback still gets a computed answer (§14.3).
 */
export const NO_STATE_TRUST = Object.freeze(computeTrust({}));

/** Shorthand for the same thing where only the level is wanted. */
export const NO_STATE_TRUST_LEVEL = NO_STATE_TRUST.trustLevel;

/**
 * Re-derive pass/fail from the numbers rather than believing a stored boolean:
 * a summary is a file on disk, and a file on disk can be edited (§16.1 tamper).
 */
function wilsonView(relations) {
  const out = {};
  for (const [rel, r] of Object.entries(relations)) {
    const n = Number.isInteger(r?.n) ? r.n : 0;
    const recall = boundView(r?.recall);
    const precision = boundView(r?.precision);
    let status = 'PASS';
    if (recall.status === 'FAIL' || precision.status === 'FAIL') status = 'FAIL';
    else if (n < MIN_GOLDEN_CASES) status = 'INSUFFICIENT_SAMPLE';
    else if (recall.status === 'INSUFFICIENT_SAMPLE' || precision.status === 'INSUFFICIENT_SAMPLE') status = 'INSUFFICIENT_SAMPLE';
    else if (recall.status === 'UNKNOWN' && precision.status === 'UNKNOWN') status = 'INSUFFICIENT_SAMPLE';
    out[rel] = { n, recall, precision, status };
  }
  return out;
}

function boundView(b) {
  if (!b || typeof b !== 'object') return { lowerBound: null, target: null, status: 'UNKNOWN' };
  const lower = typeof b.lowerBound === 'number' ? b.lowerBound : null;
  const target = typeof b.target === 'number' ? b.target : null;
  const n = Number.isInteger(b.n) ? b.n : 0;
  const hits = Number.isInteger(b.hits) ? b.hits : 0;
  if (target == null) return { lowerBound: lower, target: null, status: 'NOT_GATED' };
  if (lower == null) return { lowerBound: null, target, status: 'UNKNOWN' };
  if (lower >= target) return { lowerBound: lower, target, status: 'PASS' };
  // SPEC §2.2: a flawless corpus that is merely too small is INSUFFICIENT_SAMPLE,
  // not a failure. Something has to have gone WRONG for the level to be
  // GOLDEN_FAIL — otherwise a 30-case corpus would libel the engine.
  return { lowerBound: lower, target, status: n > 0 && hits === n ? 'INSUFFICIENT_SAMPLE' : 'FAIL' };
}
