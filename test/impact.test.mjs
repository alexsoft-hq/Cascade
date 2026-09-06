import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nodeId } from '../src/core/graph.mjs';
import { impactAnswer, ImpactError } from '../src/mcp/impact.mjs';
import { assertContract } from '../src/mcp/contract.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function basis() {
  return {
    project: 'demo',
    buildDigest: 'deadbeef',
    builtAt: '2026-09-01T00:00:00Z',
    freshness: { verdict: 'current', behindTotal: 0 },
  };
}

function trust() {
  return { trustLevel: 'UNCERTIFIED', axes: ['column'], knownGaps: [] };
}

/**
 * Chain graph (mirrors impact.mjs's own doc example, and test/graph.test.mjs's
 * fixture):
 *   screen:S -RENDERS(EXACT)-> endpoint:E -HANDLES(EXACT)-> symbol:SVC
 *   symbol:SVC -(call, interface candidateCount 1, binding resolved)-> symbol:IMPL
 *     (classifies to MAY_CALL/SOUND_SET, never CALLS/EXACT)
 *   symbol:IMPL -IMPLEMENTS_STMT(EXACT)-> statement:ST -EXECUTES(EXACT)-> table:T
 *   statement:ST -WRITES(EXACT)-> column:T.C
 *
 * impactOf(C) walks backward from column:T.C:
 *   C <- ST            (WRITES, EXACT)                => statement:ST   grade EXACT
 *   ST <- IMPL         (IMPLEMENTS_STMT, EXACT)        => symbol:IMPL   grade EXACT
 *   IMPL <- SVC        (call/interface, SOUND_SET)     => symbol:SVC    grade SOUND_SET (weakest link)
 *   SVC <- E           (HANDLES, EXACT)                => endpoint:E    grade SOUND_SET (stays weakest)
 *   E <- S             (RENDERS, EXACT)                => screen:S      grade SOUND_SET (stays weakest)
 * table:T is never reached backward from C (EXECUTES runs statement -> table,
 * the wrong direction for impactOf's backward walk).
 */
function buildChainGraph() {
  const S = nodeId('screen', 'S');
  const E = nodeId('endpoint', 'E');
  const SVC = nodeId('symbol', 'SVC');
  const IMPL = nodeId('symbol', 'IMPL');
  const ST = nodeId('statement', 'ST');
  const T = nodeId('table', 'T');
  const C = nodeId('column', 'T.C');

  const facts = [
    { fact: 'edge', from: S, to: E, type: 'RENDERS', grade: 'EXACT' },
    { fact: 'edge', from: E, to: SVC, type: 'HANDLES', grade: 'EXACT' },
    { fact: 'call', from: SVC, to: IMPL, evidence: { callKind: 'interface', candidateCount: 1, binding: 'resolved' } },
    { fact: 'edge', from: IMPL, to: ST, type: 'IMPLEMENTS_STMT', grade: 'EXACT' },
    { fact: 'edge', from: ST, to: T, type: 'EXECUTES', grade: 'EXACT' },
    { fact: 'edge', from: ST, to: C, type: 'WRITES', grade: 'EXACT' },
  ];
  const g = buildGraph(facts);
  return { g, S, E, SVC, IMPL, ST, T, C };
}

function affectedIds(resp) {
  return resp.answer.affected.map((a) => a.id);
}

// ---------------------------------------------------------------------------
// Contract validity
// ---------------------------------------------------------------------------

test('impactAnswer: a conservative answer for column:T.C is accepted by assertContract', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  assert.doesNotThrow(() => assertContract(resp));
});

// ---------------------------------------------------------------------------
// Weakest-link grading
// ---------------------------------------------------------------------------

test('impactAnswer: affected includes the screen node, graded SOUND_SET (weakest link via the candidate call edge)', () => {
  const { g, C, S } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  const screenEntry = resp.answer.affected.find((a) => a.id === S);
  assert.ok(screenEntry, 'expected screen:S in affected');
  assert.equal(screenEntry.grade, 'SOUND_SET');
  assert.notEqual(screenEntry.grade, 'EXACT');
});

test('impactAnswer: statement:ST is reached purely via EXACT edges and graded EXACT', () => {
  const { g, C, ST } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  const entry = resp.answer.affected.find((a) => a.id === ST);
  assert.ok(entry, 'expected statement:ST in affected');
  assert.equal(entry.grade, 'EXACT');
});

test('impactAnswer: symbol:IMPL is reached purely via EXACT edges and graded EXACT', () => {
  const { g, C, IMPL } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  const entry = resp.answer.affected.find((a) => a.id === IMPL);
  assert.ok(entry, 'expected symbol:IMPL in affected');
  assert.equal(entry.grade, 'EXACT');
});

test('impactAnswer: symbol:SVC and endpoint:E are also downgraded to SOUND_SET (weakest link propagates onward)', () => {
  const { g, C, SVC, E } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  const svcEntry = resp.answer.affected.find((a) => a.id === SVC);
  const eEntry = resp.answer.affected.find((a) => a.id === E);
  assert.equal(svcEntry.grade, 'SOUND_SET');
  assert.equal(eEntry.grade, 'SOUND_SET');
});

// ---------------------------------------------------------------------------
// Deterministic ordering (confirmed-first: grade desc, kind asc, id asc)
// ---------------------------------------------------------------------------

test('impactAnswer: the first affected item is graded EXACT', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  assert.equal(resp.answer.affected[0].grade, 'EXACT');
});

test('impactAnswer: grades are non-increasing across the affected list', () => {
  const RANK = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  const ranks = resp.answer.affected.map((a) => RANK[a.grade]);
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] <= ranks[i - 1], `rank increased at index ${i}: ${ranks[i - 1]} -> ${ranks[i]}`);
  }
});

test('impactAnswer: full order is grade desc, then kind asc, then id asc on the 5-item chain graph', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust() });
  // EXACT group ('statement' < 'symbol'), then SOUND_SET group
  // ('endpoint' < 'screen' < 'symbol').
  assert.deepEqual(affectedIds(resp), [
    'statement:ST',
    'symbol:IMPL',
    'endpoint:E',
    'screen:S',
    'symbol:SVC',
  ]);
});

// ---------------------------------------------------------------------------
// Truncation honesty
// ---------------------------------------------------------------------------

test('truncation: limit:2 reports shown=2, total=5, nextOffset=2, truncated.any=true', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), limit: 2 });
  assert.equal(resp.answer.affected.length, 2);
  assert.equal(resp.truncated.any, true);
  assert.equal(resp.truncated.fields[0].shown, 2);
  assert.equal(resp.truncated.fields[0].total, 5);
  assert.equal(resp.truncated.fields[0].nextOffset, 2);
  assert.doesNotThrow(() => assertContract(resp));
});

test('truncation: shown always equals the actual affected list length', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), limit: 2 });
  assert.equal(resp.truncated.fields[0].shown, resp.answer.affected.length);
});

test('truncation: a limit larger than the result set yields truncated.any=false and nextOffset=null', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), limit: 1000 });
  assert.equal(resp.truncated.any, false);
  assert.equal(resp.truncated.fields[0].nextOffset, null);
  assert.equal(resp.truncated.fields[0].shown, resp.answer.affected.length);
  assert.doesNotThrow(() => assertContract(resp));
});

// ---------------------------------------------------------------------------
// Paging (offset) — "more available" is signalled by nextOffset, not shown<total
//
// A legitimate last/interior page (offset>0) has shown<total yet nothing left
// to fetch, so nextOffset is null and truncated.any is false. Paging past the
// end returns an empty page whose reason is 'not-in-this-axis' (you didn't
// reach the end of a truly-empty axis; you paged beyond it). Both satisfy the
// contract. (This pins the corrected contract.checkTruncated semantics.)
// ---------------------------------------------------------------------------

test('paging past the end (offset >> total) returns an empty, contract-valid page with reason not-in-this-axis', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), offset: 99 });
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.affected.length, 0);
  assert.equal(resp.answer.empty.affected, 'not-in-this-axis');
  assert.equal(resp.truncated.any, false);
  assert.equal(resp.truncated.fields[0].nextOffset, null);
  assert.equal(resp.truncated.fields[0].total, 5);
});

test('paging to the ordinary last page (offset>0, shown<total, nothing left) is contract-valid with nextOffset null', () => {
  const { g, C } = buildChainGraph();
  // total is 5; offset:1 with the default limit returns the last 4 items —
  // a legitimate final page: shown<total but nothing further to page to.
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), offset: 1 });
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.answer.affected.length, 4);
  assert.equal(resp.truncated.fields[0].shown, 4);
  assert.equal(resp.truncated.fields[0].total, 5);
  assert.equal(resp.truncated.any, false);
  assert.equal(resp.truncated.fields[0].nextOffset, null);
});

test('mid truncation (limit<total from offset 0) sets nextOffset and truncated.any', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'conservative', basis: basis(), trust: trust(), limit: 2 });
  assert.doesNotThrow(() => assertContract(resp));
  assert.equal(resp.truncated.any, true);
  assert.equal(resp.truncated.fields[0].shown, 2);
  assert.equal(resp.truncated.fields[0].nextOffset, 2);
});

// ---------------------------------------------------------------------------
// Empty result reason ("0 results != safe")
// ---------------------------------------------------------------------------

test('impactAnswer: a target with nothing depending on it reports affected=[] and empty.affected="none"', () => {
  const lonely = nodeId('column', 'X.Y');
  const g2 = buildGraph([{ fact: 'node', id: lonely }]);
  const resp = impactAnswer(g2, { target: lonely, mode: 'conservative', basis: basis(), trust: trust() });
  assert.deepEqual(resp.answer.affected, []);
  assert.equal(resp.answer.empty.affected, 'none');
  assert.doesNotThrow(() => assertContract(resp));
});

test('impactAnswer: a schema relation is not impact — a sibling column of the target table has nothing depending on it', () => {
  const { g, T } = buildChainGraph();
  // table:T declares a second column that no statement reads or writes.
  const other = nodeId('column', 'T.Other');
  g.addEdge({ from: T, to: other, type: 'DECLARES', grade: 'EXACT' });
  const resp = impactAnswer(g, { target: other, mode: 'conservative', basis: basis(), trust: trust() });
  assert.deepEqual(resp.answer.affected, []);
  assert.equal(resp.answer.empty.affected, 'none');
  assert.doesNotThrow(() => assertContract(resp));
  // …while an unfiltered backward walk climbs DECLARES to the table and hands
  // this column the whole call chain above it.
  assert.ok(g.impactOf(other, { mode: 'conservative' }).size > 0);
});

// ---------------------------------------------------------------------------
// strict mode narrows honestly
// ---------------------------------------------------------------------------

test('strict mode: affected excludes the screen (candidate edge excluded)', () => {
  const { g, C, S } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'strict', basis: basis(), trust: trust() });
  assert.ok(!affectedIds(resp).includes(S), 'strict mode must not include screen:S');
});

test('strict mode: affected is exactly {statement:ST, symbol:IMPL} — the all-EXACT backward paths', () => {
  const { g, C, ST, IMPL } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'strict', basis: basis(), trust: trust() });
  assert.deepEqual(new Set(affectedIds(resp)), new Set([ST, IMPL]));
});

test('strict mode: every reached item is graded EXACT', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, mode: 'strict', basis: basis(), trust: trust() });
  for (const item of resp.answer.affected) assert.equal(item.grade, 'EXACT');
  assert.doesNotThrow(() => assertContract(resp));
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

test('impactAnswer: throws ImpactError when graph is null', () => {
  const { C } = buildChainGraph();
  assert.throws(() => impactAnswer(null, { target: C, basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when graph is omitted', () => {
  const { C } = buildChainGraph();
  assert.throws(() => impactAnswer(undefined, { target: C, basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when target is missing', () => {
  const { g } = buildChainGraph();
  assert.throws(() => impactAnswer(g, { basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when limit is 0', () => {
  const { g, C } = buildChainGraph();
  assert.throws(() => impactAnswer(g, { target: C, limit: 0, basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when limit is negative', () => {
  const { g, C } = buildChainGraph();
  assert.throws(() => impactAnswer(g, { target: C, limit: -1, basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when limit is a non-integer', () => {
  const { g, C } = buildChainGraph();
  assert.throws(() => impactAnswer(g, { target: C, limit: 1.5, basis: basis(), trust: trust() }), ImpactError);
});

test('impactAnswer: throws ImpactError when offset is negative', () => {
  const { g, C } = buildChainGraph();
  assert.throws(() => impactAnswer(g, { target: C, offset: -1, basis: basis(), trust: trust() }), ImpactError);
});

// ---------------------------------------------------------------------------
// basis / trust / limits pass through faithfully
// ---------------------------------------------------------------------------

test('impactAnswer: trust is passed through faithfully', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, basis: basis(), trust: trust() });
  assert.equal(resp.trust.trustLevel, 'UNCERTIFIED');
});

test('impactAnswer: limits are passed through faithfully', () => {
  const { g, C } = buildChainGraph();
  const lims = [{ id: 'row-cap', note: 'demo limit' }];
  const resp = impactAnswer(g, { target: C, basis: basis(), trust: trust(), limits: lims });
  assert.deepEqual(resp.limits, lims);
});

test('impactAnswer: limits defaults to [] when omitted', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, basis: basis(), trust: trust() });
  assert.deepEqual(resp.limits, []);
});

test('impactAnswer: basis is passed through faithfully', () => {
  const { g, C } = buildChainGraph();
  const resp = impactAnswer(g, { target: C, basis: basis(), trust: trust() });
  assert.equal(resp.basis.buildDigest, 'deadbeef');
  assert.equal(resp.basis.project, 'demo');
});
