import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, atLeast, reconcileLanes, GRADES, MODES, PolicyError } from '../src/core/policy.mjs';

test('static callKind → EXACT', () => {
  assert.equal(classify({ callKind: 'static' }).grade, 'EXACT');
});

test('special callKind → EXACT', () => {
  assert.equal(classify({ callKind: 'special' }).grade, 'EXACT');
});

test('final callKind → EXACT', () => {
  assert.equal(classify({ callKind: 'final' }).grade, 'EXACT');
});

// Invariant I-1: a candidate set, even of size 1, is never promoted to EXACT.
test('I-1: virtual callKind with candidateCount 1 stays SOUND_SET, never EXACT', () => {
  const r = classify({ callKind: 'virtual', candidateCount: 1 });
  assert.equal(r.grade, 'SOUND_SET');
  assert.notEqual(r.grade, 'EXACT');
});

test('I-1: interface callKind with candidateCount 1 stays SOUND_SET, never EXACT', () => {
  const r = classify({ callKind: 'interface', candidateCount: 1 });
  assert.equal(r.grade, 'SOUND_SET');
  assert.notEqual(r.grade, 'EXACT');
});

test('I-1: virtual/interface stays SOUND_SET for candidateCount 0, 2, and undefined', () => {
  for (const callKind of ['virtual', 'interface']) {
    for (const candidateCount of [0, 2, undefined]) {
      const r = classify({ callKind, candidateCount });
      assert.equal(r.grade, 'SOUND_SET', `callKind=${callKind} candidateCount=${candidateCount}`);
    }
  }
});

test("binding 'recovered' → HEURISTIC", () => {
  assert.equal(classify({ binding: 'recovered' }).grade, 'HEURISTIC');
});

test('reflection true → RUNTIME_ONLY', () => {
  assert.equal(classify({ reflection: true }).grade, 'RUNTIME_ONLY');
});

test('parseFailed true → UNRESOLVED', () => {
  assert.equal(classify({ parseFailed: true }).grade, 'UNRESOLVED');
});

test("binding 'unresolved' → UNRESOLVED", () => {
  assert.equal(classify({ binding: 'unresolved' }).grade, 'UNRESOLVED');
});

test('unmatched evidence ({}) → conservative HEURISTIC fallback with POLICY_GAP diagnostic (totality)', () => {
  const r = classify({});
  assert.equal(r.grade, 'HEURISTIC');
  assert.equal(r.diagnostic && r.diagnostic.code, 'POLICY_GAP');
});

test("unmatched evidence ({callKind:'weird'}) → conservative HEURISTIC fallback with POLICY_GAP diagnostic", () => {
  const r = classify({ callKind: 'weird' });
  assert.equal(r.grade, 'HEURISTIC');
  assert.equal(r.diagnostic && r.diagnostic.code, 'POLICY_GAP');
});

test('mode ceiling: SOURCE_ONLY caps EXACT down to HEURISTIC', () => {
  const r = classify({ callKind: 'static' }, 'SOURCE_ONLY');
  assert.equal(r.grade, 'HEURISTIC');
});

test('mode ceiling: BUILD_CAPTURED lets static calls stay EXACT', () => {
  const r = classify({ callKind: 'static' }, 'BUILD_CAPTURED');
  assert.equal(r.grade, 'EXACT');
});

test('mode ceiling: LEGACY_HEURISTIC caps EXACT down to HEURISTIC too', () => {
  const r = classify({ callKind: 'static' }, 'LEGACY_HEURISTIC');
  assert.equal(r.grade, 'HEURISTIC');
});

test('a mode never raises a grade — UNRESOLVED stays UNRESOLVED under every mode', () => {
  for (const mode of MODES) {
    const r = classify({ parseFailed: true }, mode);
    assert.equal(r.grade, 'UNRESOLVED');
  }
});

test('classify throws PolicyError on an unknown mode string', () => {
  assert.throws(() => classify({ callKind: 'static' }, 'NOT_A_REAL_MODE'), PolicyError);
});

test('classify with default evidence and default mode does not throw', () => {
  assert.doesNotThrow(() => classify());
});

test('property: every combinatorial evidence shape yields a grade in GRADES, and I-1 never yields EXACT for a single-candidate virtual/interface call', () => {
  const callKinds = [undefined, 'static', 'special', 'final', 'virtual', 'interface'];
  const bindings = [undefined, 'resolved', 'recovered', 'unresolved'];
  const candidateCounts = [undefined, 0, 1, 2];
  const conditionals = [undefined, true, false];
  const reflections = [undefined, true, false];
  const parseFaileds = [undefined, true, false];

  let count = 0;
  for (const callKind of callKinds) {
    for (const binding of bindings) {
      for (const candidateCount of candidateCounts) {
        for (const conditional of conditionals) {
          for (const reflection of reflections) {
            for (const parseFailed of parseFaileds) {
              const evidence = { callKind, binding, candidateCount, conditional, reflection, parseFailed };
              const r = classify(evidence);
              count++;
              assert.ok(
                GRADES.includes(r.grade),
                `grade ${r.grade} not in GRADES for evidence ${JSON.stringify(evidence)}`,
              );
              if ((callKind === 'virtual' || callKind === 'interface') && candidateCount === 1) {
                assert.notEqual(
                  r.grade,
                  'EXACT',
                  `I-1 violated for evidence ${JSON.stringify(evidence)}`,
                );
              }
            }
          }
        }
      }
    }
  }
  // Sanity: we actually exercised a large combinatorial space (well over ~200).
  assert.ok(count >= 200, `expected at least 200 combinations, got ${count}`);
});

test('reconcileLanes: same target takes the more conservative grade', () => {
  const r = reconcileLanes('EXACT', 'SOUND_SET', true);
  assert.equal(r.grade, 'SOUND_SET');
  assert.equal(r.diagnostic, null);
});

test('reconcileLanes: same target, equal grades pass through unchanged', () => {
  const r = reconcileLanes('HEURISTIC', 'HEURISTIC', true);
  assert.equal(r.grade, 'HEURISTIC');
  assert.equal(r.diagnostic, null);
});

test('reconcileLanes: different target forbids EXACT, unions to SOUND_SET with LANE_MISMATCH diagnostic', () => {
  const r = reconcileLanes('EXACT', 'EXACT', false);
  assert.equal(r.grade, 'SOUND_SET');
  assert.equal(r.diagnostic && r.diagnostic.code, 'LANE_MISMATCH');
});

test('atLeast: EXACT is at least as certain as SOUND_SET', () => {
  assert.equal(atLeast('EXACT', 'SOUND_SET'), true);
});

test('atLeast: SOUND_SET is NOT at least as certain as EXACT', () => {
  assert.equal(atLeast('SOUND_SET', 'EXACT'), false);
});

test('atLeast: a grade is at least as certain as itself', () => {
  for (const g of GRADES) {
    assert.equal(atLeast(g, g), true);
  }
});

test('atLeast throws PolicyError on an unknown grade (first arg)', () => {
  assert.throws(() => atLeast('NOT_A_GRADE', 'EXACT'), PolicyError);
});

test('atLeast throws PolicyError on an unknown grade (second arg)', () => {
  assert.throws(() => atLeast('EXACT', 'NOT_A_GRADE'), PolicyError);
});
