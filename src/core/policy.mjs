// policy.mjs — the grade lattice. The soul of the product.
//
// SPEC §3.1 (grades), §8.3 (total decision table). This is the ONE place a
// confidence grade is computed (Invariant I-1). Workers emit *evidence only*
// (call kind, binding status, candidate count) and never a grade; central
// policy turns evidence × analysis-mode into a grade.
//
// Invariant I-1 (MUST): a SOUND_SET candidate set is NEVER promoted to EXACT,
// even when it narrows to a single candidate. "One possible target" is not
// "the target is unique if executed".
//
// Invariant I-7 (MUST): the table is a TOTAL function evidence→grade. An
// unmatched combination is never handled silently — it is lowered to the
// nearest conservative grade and a POLICY_GAP diagnostic is attached.

/** @typedef {'EXACT'|'SOUND_SET'|'HEURISTIC'|'RUNTIME_ONLY'|'UNRESOLVED'} Grade */

export const GRADES = Object.freeze(['EXACT', 'SOUND_SET', 'HEURISTIC', 'RUNTIME_ONLY', 'UNRESOLVED']);

// Lattice rank — higher = more certain. Used only to *cap* (lower), never to promote.
const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });

// Analysis modes and the ceiling each imposes on the computed grade (SPEC §6.4
// in the reference; here as an explicit post-cap). A mode never raises a grade.
export const MODES = Object.freeze(['BUILD_CAPTURED', 'RESOLVED_SOURCE', 'SOURCE_ONLY', 'LEGACY_HEURISTIC']);
const MODE_CEILING = Object.freeze({
  BUILD_CAPTURED: 'EXACT',
  RESOLVED_SOURCE: 'EXACT', // direct static calls may be EXACT; virtual capped to SOUND_SET by the table itself
  SOURCE_ONLY: 'HEURISTIC',
  LEGACY_HEURISTIC: 'HEURISTIC',
});

/**
 * Evidence a worker emits about a call/binding site. All fields optional; the
 * classifier is total over any shape.
 * @typedef {Object} Evidence
 * @property {'static'|'special'|'final'|'virtual'|'interface'} [callKind]
 * @property {'resolved'|'recovered'|'unresolved'} [binding]
 * @property {number} [candidateCount]   // size of the CHA/points-to candidate set
 * @property {boolean} [conditional]     // bean is qualifier/profile-conditional, etc.
 * @property {boolean} [reflection]      // target chosen via reflection/config/registry
 * @property {boolean} [parseFailed]     // parse/binding/dependency failure
 */

/**
 * @typedef {Object} Classification
 * @property {Grade} grade
 * @property {string} rule       // which table row fired
 * @property {string[]} reasons
 * @property {{code:string,message:string}} [diagnostic]  // POLICY_GAP etc.
 */

/**
 * Classify evidence into a grade. Total function (Invariant I-7).
 * @param {Evidence} [evidence]
 * @param {typeof MODES[number]} [mode='RESOLVED_SOURCE']
 * @returns {Classification}
 */
export function classify(evidence = {}, mode = 'RESOLVED_SOURCE') {
  if (!MODES.includes(mode)) {
    throw new PolicyError(`unknown analysis mode: ${JSON.stringify(mode)}`);
  }
  const e = evidence || {};
  let raw;

  if (e.parseFailed || e.binding === 'unresolved') {
    raw = { grade: 'UNRESOLVED', rule: 'parse/binding/dependency failure', reasons: ['unresolved'] };
  } else if (e.reflection) {
    raw = { grade: 'RUNTIME_ONLY', rule: 'reflection/config/runtime registry', reasons: ['reflection'] };
  } else if (e.binding === 'recovered') {
    raw = { grade: 'HEURISTIC', rule: 'recovered binding', reasons: ['recovered'] };
  } else if (e.callKind === 'static' || e.callKind === 'special' || e.callKind === 'final') {
    raw = { grade: 'EXACT', rule: 'static|special|final direct call', reasons: [`callKind=${e.callKind}`] };
  } else if (e.callKind === 'virtual' || e.callKind === 'interface') {
    // Invariant I-1: candidate set, even of size 1, stays SOUND_SET. No promotion.
    const reasons = [`callKind=${e.callKind}`, `candidateCount=${e.candidateCount ?? 'unknown'}`];
    if (e.candidateCount === 1) reasons.push('single-candidate-NOT-promoted (I-1)');
    raw = {
      grade: 'SOUND_SET',
      rule: e.conditional ? 'CHA candidate set (conditional)' : 'CHA candidate set',
      reasons,
    };
  } else if (e.conditional) {
    raw = { grade: 'SOUND_SET', rule: 'conditional bean set', reasons: ['conditional'] };
  } else {
    // No row matched: never silent. Lower to the nearest conservative grade and flag.
    raw = {
      grade: 'HEURISTIC',
      rule: 'POLICY_GAP fallback',
      reasons: ['no matching row'],
      diagnostic: {
        code: 'POLICY_GAP',
        message: `no decision-table row for evidence ${safe(e)}; lowered to conservative HEURISTIC`,
      },
    };
  }

  // Apply the mode ceiling (only ever lowers).
  const ceiling = MODE_CEILING[mode];
  if (RANK[raw.grade] > RANK[ceiling]) {
    raw = {
      ...raw,
      grade: ceiling,
      reasons: [...raw.reasons, `capped by mode ${mode} (ceiling ${ceiling})`],
    };
  }
  return raw;
}

/** True iff `a` is at least as certain as `b` on the lattice. */
export function atLeast(a, b) {
  if (RANK[a] === undefined) throw new PolicyError(`unknown grade: ${a}`);
  if (RANK[b] === undefined) throw new PolicyError(`unknown grade: ${b}`);
  return RANK[a] >= RANK[b];
}

/** Merge two lanes' grades: on disagreement, take the more conservative (never EXACT). */
export function reconcileLanes(gradeA, gradeB, sameTarget) {
  const min = RANK[gradeA] <= RANK[gradeB] ? gradeA : gradeB;
  if (sameTarget) return { grade: min, diagnostic: null };
  // Different targets → forbid EXACT, union is a SOUND_SET (Invariant I-7).
  return {
    grade: 'SOUND_SET',
    diagnostic: { code: 'LANE_MISMATCH', message: 'source and bytecode lanes point to different targets' },
  };
}

function safe(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}
