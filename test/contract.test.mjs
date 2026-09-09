import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeResponse,
  assertContract,
  FRESHNESS_VERDICTS,
  EMPTY_REASONS,
  ContractError,
} from '../src/mcp/contract.mjs';

// Builds a fresh, contract-valid raw shape (pre-makeResponse) each call so
// tests never share mutable state.
function validShape() {
  return {
    answer: { items: [1, 2] },
    basis: {
      project: 'p',
      buildDigest: 'abc',
      builtAt: '2026-01-01T00:00:00Z',
      freshness: { verdict: 'current', behindTotal: 0 },
    },
    trust: { trustLevel: 'UNCERTIFIED', axes: ['column'] },
    limits: [],
    truncated: { any: false, fields: [{ field: 'items', shown: 2, total: 2, order: 'by-x' }] },
  };
}

test('a valid shape passes through makeResponse and assertContract without throwing', () => {
  const resp = makeResponse(validShape());
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer, { items: [1, 2] });
});

test('I-8: a shallow copy of a valid response loses the marker and assertContract throws', () => {
  const resp = makeResponse(validShape());
  const copy = { ...resp };
  assert.throws(() => assertContract(copy), ContractError);
});

test('I-8: a hand-built plain object with all four fields, never passed through makeResponse, is caught as forgery', () => {
  const forged = validShape(); // has answer/basis/trust/limits/truncated but no MARKER
  assert.throws(() => assertContract(forged), ContractError);
});

test('basis.freshness missing throws', () => {
  const shape = validShape();
  delete shape.basis.freshness;
  assert.throws(() => makeResponse(shape), ContractError);
});

test('basis.freshness.verdict not in FRESHNESS_VERDICTS throws', () => {
  const shape = validShape();
  shape.basis.freshness = { verdict: 'not-a-real-verdict', behindTotal: 0 };
  assert.throws(() => makeResponse(shape), ContractError);
});

// ---- basis.siblings: the other packs a federated answer walked (RM44) ------
// A row that came from another project is anchored to THAT project's snapshot,
// so each sibling is held to the same rule the basis itself is held to.

test('basis.siblings: absent is fine, and a well-formed list passes', () => {
  const shape = validShape();
  assert.doesNotThrow(() => makeResponse(shape));
  shape.basis.siblings = [{ project: 'q', buildDigest: 'def', builtAt: null, freshness: { verdict: 'unknown' } }];
  assert.doesNotThrow(() => makeResponse(shape));
});

test('basis.siblings: a sibling with no digest, no verdict or no name is refused', () => {
  const withSiblings = (siblings) => { const s = validShape(); s.basis.siblings = siblings; return s; };
  assert.throws(() => makeResponse(withSiblings('nope')), /must be an array/);
  assert.throws(() => makeResponse(withSiblings([{ buildDigest: 'd', freshness: { verdict: 'unknown' } }])),
    /needs the project it names/);
  assert.throws(() => makeResponse(withSiblings([{ project: 'q', freshness: { verdict: 'unknown' } }])),
    /anchor to no snapshot/);
  assert.throws(() => makeResponse(withSiblings([{ project: 'q', buildDigest: 'd' }])),
    /needs a freshness verdict/);
  assert.throws(() => makeResponse(withSiblings([{ project: 'q', buildDigest: 'd', freshness: { verdict: 'probably' } }])),
    /needs a freshness verdict/);
});

test('basis.buildDigest null throws — no snapshot anchor', () => {
  const shape = validShape();
  shape.basis.buildDigest = null;
  assert.throws(() => makeResponse(shape), ContractError);
});

test("verdict 'current' with behindTotal 5 throws (arithmetic cross-check)", () => {
  const shape = validShape();
  shape.basis.freshness = { verdict: 'current', behindTotal: 5 };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('every declared FRESHNESS_VERDICTS value except current tolerates a nonzero behindTotal', () => {
  for (const verdict of FRESHNESS_VERDICTS) {
    if (verdict === 'current') continue;
    const shape = validShape();
    shape.basis.freshness = { verdict, behindTotal: 5 };
    assert.doesNotThrow(() => makeResponse(shape), `verdict=${verdict}`);
  }
});

test('trust.trustLevel blank throws', () => {
  const shape = validShape();
  shape.trust = { trustLevel: '', axes: ['column'] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('trust.trustLevel missing throws', () => {
  const shape = validShape();
  shape.trust = { axes: ['column'] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('trust.axes empty throws', () => {
  const shape = validShape();
  shape.trust = { trustLevel: 'UNCERTIFIED', axes: [] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('truncated: shown > total throws', () => {
  const shape = validShape();
  shape.truncated = { any: false, fields: [{ field: 'items', shown: 5, total: 2, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('truncated: shown < total but no nextOffset throws', () => {
  const shape = validShape();
  shape.answer = { items: [1] };
  shape.truncated = { any: true, fields: [{ field: 'items', shown: 1, total: 5, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('truncated: shown < total with a nextOffset present is fine (baseline for the any-mismatch tests)', () => {
  const shape = validShape();
  shape.answer = { items: [1] };
  shape.truncated = { any: true, fields: [{ field: 'items', shown: 1, total: 5, order: 'by-x', nextOffset: 1 }] };
  assert.doesNotThrow(() => makeResponse(shape));
});

test('truncated: any=true but no field is actually cut throws', () => {
  const shape = validShape();
  shape.truncated = { any: true, fields: [{ field: 'items', shown: 2, total: 2, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('truncated: any=false but a field is actually cut throws', () => {
  const shape = validShape();
  shape.answer = { items: [1] };
  shape.truncated = { any: false, fields: [{ field: 'items', shown: 1, total: 5, order: 'by-x', nextOffset: 1 }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('truncated: shown not matching the actual answer list length throws', () => {
  const shape = validShape();
  shape.answer = { items: [1, 2] }; // length 2
  shape.truncated = { any: false, fields: [{ field: 'items', shown: 3, total: 3, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('empty-list reason enforcement: an empty list with no answer.empty reason throws (0 results != safe)', () => {
  const shape = validShape();
  shape.answer = { rows: [] };
  shape.truncated = { any: false, fields: [{ field: 'rows', shown: 0, total: 0, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('empty-list reason enforcement: a reason not in EMPTY_REASONS throws', () => {
  const shape = validShape();
  shape.answer = { rows: [], empty: { rows: 'some-made-up-reason' } };
  shape.truncated = { any: false, fields: [{ field: 'rows', shown: 0, total: 0, order: 'by-x' }] };
  assert.throws(() => makeResponse(shape), ContractError);
});

test('empty-list reason enforcement: every valid EMPTY_REASONS value passes', () => {
  for (const reason of EMPTY_REASONS) {
    const shape = validShape();
    shape.answer = { rows: [], empty: { rows: reason } };
    shape.truncated = { any: false, fields: [{ field: 'rows', shown: 0, total: 0, order: 'by-x' }] };
    assert.doesNotThrow(() => makeResponse(shape), `reason=${reason}`);
  }
});

test('empty-list reason enforcement: a non-empty list carrying an answer.empty reason throws (no blanket declaration)', () => {
  const shape = validShape();
  shape.answer = { items: [1, 2], empty: { items: 'none' } };
  // truncated.fields already describes 'items' with shown=2/total=2 matching length 2.
  assert.throws(() => makeResponse(shape), ContractError);
});

test('makeResponse itself throws at construction time on an invalid shape', () => {
  assert.throws(() => makeResponse({}), ContractError);
});

test('makeResponse throws when answer/basis/trust/limits/truncated are entirely absent', () => {
  // `undefined ?? {}` is written out rather than collapsed: it is the call site
  // being described — a caller that had nothing and passed the empty object.
  // eslint-disable-next-line no-constant-binary-expression
  assert.throws(() => makeResponse(undefined ?? {}), ContractError);
});
