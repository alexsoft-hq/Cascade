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
//   3. No approved golden case at all -> UNCERTIFIED, gap `no-project-golden`.
//   4. A relation that actually got something WRONG, with a Wilson lower bound
//      below its §2.2 target -> GOLDEN_FAIL, whatever the rest says.
//   5. A relation that got everything right but is still short of its target is
//      INSUFFICIENT_SAMPLE, not a failure (§2.2 says so in as many words) — and
//      a level with any unscored relation is never GOLDEN_PASS. Note what that
//      implies: 30 flawless cases bound at 0.8865, so no 95% target can be shown
//      at N=30. §14.1's N=30 is where a corpus may START being scored, not where
//      it becomes sufficient; `nForTarget` in the summary says how many it takes.
//   6. THE ONE EXCEPTION TO THE FLOOR: a relation whose cases cover its whole
//      population in this pack is scored on all of them (`exhaustive` in the
//      summary). A bound is how a SAMPLE speaks about a population; a census has
//      no population left to infer about. spring-petclinic has 17 endpoints, and
//      under the floor alone its `endpoint->tables` row could never be shown.
//   7. Every relation PASS, each of them either hand-labelled or exhaustive ->
//      GOLDEN_PASS, which §2.2 is careful to call evidence of NO REGRESSION,
//      not a certification.
//   8. Otherwise, with nothing failing, the anchor relation (`endpoint->tables`)
//      passing, and at least one passing relation resting only on cases a TRACE
//      labelled -> RUNTIME_PASS. What that level claims is exactly what execution
//      can show: the answer covered what actually ran. It claims nothing about
//      precision (a trace carries no negatives) and nothing about a route nobody
//      exercised. A relation that could not be SCORED is named in `gatesNotShown`
//      rather than used to demote the one that was.
//
// Pure: state in, verdict out. The CLI reads the files.

import { RUNTIME_ANCHOR_RELATION } from './golden.mjs';

/**
 * The only place these four names are spelled. A consumer compares against
 * these constants; nothing else in `src/` or `bin/` writes the strings.
 *
 * In ascending order of what they claim, which is why they are an array.
 */
export const TRUST_LEVELS = Object.freeze(['UNCERTIFIED', 'GOLDEN_FAIL', 'RUNTIME_PASS', 'GOLDEN_PASS']);

/** The smallest project golden that may be scored at all (SPEC §14.1). */
export const MIN_GOLDEN_CASES = 30;

/** Gate verdicts that let an answer be more than UNCERTIFIED. */
const PASSING_GATES = Object.freeze(['GREEN', 'BOOTSTRAP']);

/** The two levels that CLAIM something. Neither survives a gate that is not passing. */
const PASSING_LEVELS = Object.freeze([TRUST_LEVELS[2], TRUST_LEVELS[3]]);

/**
 * The level a SCORED corpus earns, and the relations it could not show.
 *
 * The order below is the whole rule, and it is pessimistic at every step: a
 * failure outranks every pass, a full pass outranks a partial one, and a partial
 * one has to name the relation it rests on.
 *
 * @param {Object} wilson  the re-derived per-relation view
 * @param {boolean} gatePassing
 * @returns {{level:string, unscored:string[], gaps:string[]}}
 */
function goldenVerdict(wilson, gatePassing) {
  const rows = Object.entries(wilson).sort(([a], [b]) => (a < b ? -1 : 1));
  const unscored = rows.filter(([, r]) => r.status === 'INSUFFICIENT_SAMPLE').map(([rel]) => rel);
  const values = rows.map(([, r]) => r);
  if (values.some((r) => r.status === 'FAIL')) return { level: TRUST_LEVELS[1], unscored, gaps: [] };
  // GOLDEN_PASS. Every relation passing, and none of them passing on runtime
  // labels alone unless the runtime saw ALL of it: a recall-only sample is not
  // the evidence this level stands for.
  const everyRelation = values.length > 0 && values.every((r) => r.status === 'PASS');
  const grounded = values.every((r) => r.handCases > 0 || r.exhaustive);
  if (gatePassing && everyRelation && grounded) return { level: TRUST_LEVELS[3], unscored, gaps: [] };
  // RUNTIME_PASS. Nothing FAILED (the check above already returned if anything
  // did), the anchor relation PASSED, and at least one passing relation was
  // labelled by a trace and by nothing else.
  //
  // A relation that could not be SCORED does not hold this down. It is named in
  // `gatesNotShown` instead, which is the honest shape: "this was measured and
  // passed" and "these were not measured" are two facts, and demoting the first
  // because of the second loses both. Three of the four relations sit in exactly
  // that state after a first trace, and no amount of tracing moves them.
  const anchor = wilson[RUNTIME_ANCHOR_RELATION];
  const byRunAlone = values.some((r) => r.status === 'PASS' && r.runtimeCases > 0 && r.handCases === 0);
  if (gatePassing && anchor?.status === 'PASS' && byRunAlone) {
    return { level: TRUST_LEVELS[2], unscored, gaps: [] };
  }
  return { level: TRUST_LEVELS[0], unscored, gaps: ['golden-relations-not-all-scored'] };
}

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
  const gatePassing = !!gateState && PASSING_GATES.includes(gateState.verdict);

  let level = TRUST_LEVELS[0]; // UNCERTIFIED unless everything below says otherwise
  if (!gateState) {
    gaps.add('no-calibration-state');
    gatesNotShown.push('calibration-gate');
  } else if (!gatePassing) {
    gaps.add('calibration-gate-red');
    gatesNotShown.push('calibration-gate');
  }

  if (goldenCases === 0) {
    gaps.add('no-project-golden');
    for (const rel of relations ? Object.keys(relations).sort() : []) gatesNotShown.push(`golden:${rel}`);
    if (!relations) gatesNotShown.push('golden:all-relations');
  } else if (wilson) {
    // A corpus under §14.1's N=30 is still DISCLOSED as thin, but it no longer
    // decides the level on its own: a relation that covers its whole population
    // is a census, and `goldenVerdict` is where that is judged, per relation.
    if (goldenCases < MIN_GOLDEN_CASES) gaps.add('project-golden-below-minimum');
    // Every relation that could not be scored is NAMED, so an AI reading the
    // response can tell "this relation passed" from "this relation was never
    // measured" (SPEC §14.3: golden 0 -> every gate INSUFFICIENT_SAMPLE).
    const verdict = goldenVerdict(wilson, gatePassing);
    level = verdict.level;
    for (const rel of verdict.unscored) gatesNotShown.push(`golden:${rel}`);
    for (const g of verdict.gaps) gaps.add(g);
  } else {
    gaps.add('golden-never-checked');
    gatesNotShown.push('golden:all-relations');
  }

  // A red (or missing) gate can never be talked up by a golden run: whatever the
  // corpus says, a level that CLAIMS something falls back to UNCERTIFIED. A
  // GOLDEN_FAIL stands, because a failure the corpus found is not made better by
  // a gate that also went red.
  if (!gatePassing && PASSING_LEVELS.includes(level)) level = TRUST_LEVELS[0];

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
    // A CENSUS, RE-DERIVED. `population` is how many inputs this relation has in
    // the pack, and it is the same kind of stored count as `n` and `hits`: the
    // flag the summary carries is not believed, the comparison is redone here.
    const population = Number.isInteger(r?.population) ? r.population : null;
    const exhaustive = population !== null && population > 0 && n >= population;
    const runtimeCases = Number.isInteger(r?.runtimeCases) ? r.runtimeCases : 0;
    const handCases = Number.isInteger(r?.handCases) ? r.handCases : Math.max(0, n - runtimeCases);
    const gated = [recall, precision].filter((b) => b.target != null);
    let status = 'PASS';
    if (recall.status === 'FAIL' || precision.status === 'FAIL') status = 'FAIL';
    else if (exhaustive) status = gated.every((b) => b.perfect) ? 'PASS' : 'FAIL';
    else if (n < MIN_GOLDEN_CASES) status = 'INSUFFICIENT_SAMPLE';
    else if (recall.status === 'INSUFFICIENT_SAMPLE' || precision.status === 'INSUFFICIENT_SAMPLE') status = 'INSUFFICIENT_SAMPLE';
    else if (recall.status === 'UNKNOWN' && precision.status === 'UNKNOWN') status = 'INSUFFICIENT_SAMPLE';
    out[rel] = { n, population, exhaustive, runtimeCases, handCases, recall, precision, status };
  }
  return out;
}

function boundView(b) {
  if (!b || typeof b !== 'object') return { lowerBound: null, target: null, perfect: false, status: 'UNKNOWN' };
  const lower = typeof b.lowerBound === 'number' ? b.lowerBound : null;
  const target = typeof b.target === 'number' ? b.target : null;
  const n = Number.isInteger(b.n) ? b.n : 0;
  const hits = Number.isInteger(b.hits) ? b.hits : 0;
  // EVERY CASE RIGHT, said in the two numbers rather than read off a flag: this
  // is what an exhaustive relation is scored on, and what keeps a small flawless
  // sample from being called a failure.
  const perfect = n > 0 && hits === n;
  if (target == null) return { lowerBound: lower, target: null, perfect, status: 'NOT_GATED' };
  if (lower == null) return { lowerBound: null, target, perfect, status: 'UNKNOWN' };
  if (lower >= target) return { lowerBound: lower, target, perfect, status: 'PASS' };
  // SPEC §2.2: a flawless corpus that is merely too small is INSUFFICIENT_SAMPLE,
  // not a failure. Something has to have gone WRONG for the level to be
  // GOLDEN_FAIL — otherwise a 30-case corpus would libel the engine.
  return { lowerBound: lower, target, perfect, status: perfect ? 'INSUFFICIENT_SAMPLE' : 'FAIL' };
}
