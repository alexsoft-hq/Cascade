// contract.mjs — the honesty layer. The core differentiator (SPEC §9).
//
// Humans read footnotes; an AI treats what it receives as the whole truth. So
// every MCP response is forced to carry four fields: basis / trust / limits /
// truncated (+ answer). This module is the ONLY place a valid response is
// stamped, and the ONLY place one is validated.
//
// Invariant I-8 (MUST): contract fields carry a private Symbol marker stamped
// only inside this module. A route or tool that emits a shape-only placeholder
// pretending to be the contract is killed by assertContract() on the missing
// marker — even a shallow copy loses the marker and is caught. A server
// response that violates the contract MUST surface as 500 contract-violation,
// never 200.

import { TRUST_LEVELS } from '../core/trust.mjs';

const MARKER = Symbol('cascade.contract.v1');

export const FRESHNESS_VERDICTS = Object.freeze(['current', 'behind', 'provisional-overlay', 'unknown']);

/**
 * The trust levels a response may carry. The names live in src/core/trust.mjs,
 * which is the ONLY module allowed to write them down (SPEC §14.3 forbids a
 * literal trust level anywhere else); the contract re-exports them so a
 * transport can validate against the enum without minting one of its own.
 */
export { TRUST_LEVELS };
export const EMPTY_REASONS = Object.freeze(['none', 'not-shipped', 'not-in-this-axis']);

/**
 * Build and stamp a contract-valid response. Validates before returning.
 * @param {Object} r
 * @param {Object} r.answer     the payload; lists inside are described by `truncated`
 * @param {Object} r.basis      { project, pins, buildDigest, builtAt, ageHours, freshness }
 * @param {Object} r.trust      { trustLevel, axes:[...], gatesNotShown, knownGaps }
 * @param {Array}  r.limits     applicable limits (may be empty ONLY if truly none apply AND declared so)
 * @param {Object} r.truncated  { any:boolean, fields:[{field,shown,total,order,nextOffset}] }
 * @returns {Object} a frozen, marked, validated response
 */
export function makeResponse(r) {
  const resp = {
    answer: r.answer,
    basis: r.basis,
    trust: r.trust,
    limits: r.limits,
    truncated: r.truncated,
  };
  Object.defineProperty(resp, MARKER, { value: true, enumerable: false });
  assertContract(resp); // fail at construction, not at the wire
  return resp;
}

/**
 * Validate a response against the contract. Throws ContractError on any breach.
 * Intended to run once more immediately before serialization (I-8).
 * @param {Object} resp
 */
export function assertContract(resp) {
  if (!resp || typeof resp !== 'object') fail('response is not an object');
  // I-8: the private marker cannot be forged or survive a shallow copy.
  if (resp[MARKER] !== true) {
    fail('missing contract marker. The response was not built by contract.makeResponse (possible forgery or shallow copy)');
  }
  for (const f of ['answer', 'basis', 'trust', 'limits', 'truncated']) {
    if (!(f in resp)) fail(`missing required field: ${f}`);
  }
  checkBasis(resp.basis);
  checkTrust(resp.trust);
  checkLimits(resp.limits);
  checkTruncated(resp.truncated, resp.answer);
  checkEmpty(resp.answer);
}

function checkBasis(basis) {
  if (!basis || typeof basis !== 'object') fail('basis must be an object');
  const fr = basis.freshness;
  if (!fr || typeof fr !== 'object') fail('basis.freshness is required (unknown != current)');
  if (!FRESHNESS_VERDICTS.includes(fr.verdict)) {
    fail(`basis.freshness.verdict must be one of ${FRESHNESS_VERDICTS.join('|')}, got ${JSON.stringify(fr.verdict)}`);
  }
  if (basis.buildDigest == null) {
    // A basis without a build digest cannot anchor the answer to a snapshot.
    // The ONE exception is an answer that is not about a snapshot at all: the
    // multi-project server describing ITSELF (`projects` — which projects are
    // served, what is in the pack cache). It has to DECLARE that, in both
    // fields, and it still carries a freshness verdict of its own. Anything
    // else with no digest is the defect this check exists for.
    if (basis.scope !== 'server' || basis.project !== '*') {
      fail('basis.buildDigest is required. We refuse a basis with no snapshot anchor '
        + '(only a server-level answer may omit it, and it must say so with scope:"server" and project:"*")');
    }
  }
  // If current, behind counts must be absent or zero (arithmetic cross-check —
  // the last line of defense after serialization drops any Symbol).
  if (fr.verdict === 'current' && Number(fr.behindTotal || 0) !== 0) {
    fail('basis.freshness.verdict=current but behindTotal != 0');
  }
  // EVERY OTHER PACK THIS ANSWER WALKED (RM44). A federated answer crosses into
  // another project's pack, and a row that came from there is anchored to THAT
  // snapshot, not to this one. So each sibling is held to the same rule the
  // basis itself is held to: a build digest, and a freshness verdict from the
  // same closed set. An answer that walked no other pack carries no `siblings`.
  if (basis.siblings !== undefined) {
    if (!Array.isArray(basis.siblings)) fail('basis.siblings must be an array of the other packs this answer walked');
    for (const s of basis.siblings) {
      if (!s || typeof s !== 'object') fail('basis.siblings entry must be an object');
      if (typeof s.project !== 'string' || s.project.length === 0) fail('basis.siblings entry needs the project it names');
      if (s.buildDigest == null) fail(`basis.siblings entry ${s.project} has no buildDigest, so the rows it contributed anchor to no snapshot`);
      const sf = s.freshness;
      if (!sf || typeof sf !== 'object' || !FRESHNESS_VERDICTS.includes(sf.verdict)) {
        fail(`basis.siblings entry ${s.project} needs a freshness verdict, one of ${FRESHNESS_VERDICTS.join('|')}`);
      }
    }
  }
}

function checkTrust(trust) {
  if (!trust || typeof trust !== 'object') fail('trust must be an object');
  if (typeof trust.trustLevel !== 'string' || trust.trustLevel.length === 0) {
    fail('trust.trustLevel must be a non-empty computed string (no missing/blank level)');
  }
  // §14.3: the level is a computed value from a closed set. A response carrying
  // a level nobody can compute is a decorative label, which is the exact defect
  // that section names — so it is rejected here rather than shipped.
  if (!TRUST_LEVELS.includes(trust.trustLevel)) {
    fail(`trust.trustLevel must be one of ${TRUST_LEVELS.join('|')}, got ${JSON.stringify(trust.trustLevel)} (computed by src/core/trust.mjs, never written as a literal)`);
  }
  if (!Array.isArray(trust.axes) || trust.axes.length === 0) {
    // An answer that leans on no gate axis is a decorative contract.
    fail('trust.axes must list at least the axis this answer relied on');
  }
}

function checkLimits(limits) {
  if (!Array.isArray(limits)) fail('limits must be an array');
  // Note: an EMPTY limits array is allowed but MUST be a deliberate "no limit
  // applies" — callers that skip limits entirely fail on the missing field above.
}

function checkTruncated(truncated, answer) {
  if (!truncated || typeof truncated !== 'object') fail('truncated must be an object');
  if (typeof truncated.any !== 'boolean') fail('truncated.any must be a boolean');
  if (!Array.isArray(truncated.fields)) fail('truncated.fields must be an array');
  let anyMore = false;
  for (const d of truncated.fields) {
    for (const k of ['field', 'shown', 'total', 'order']) {
      if (!(k in d)) fail(`truncated.fields entry missing ${k}`);
    }
    if (d.shown > d.total) fail(`truncated: shown(${d.shown}) > total(${d.total}) for ${d.field}`);
    // "More available" is signalled by nextOffset, NOT by shown<total. Under
    // paging (offset>0) a legitimate last/interior page has shown<total yet
    // nothing further to fetch (nextOffset null). The producer owns the offset
    // arithmetic and is tested at its own layer; here we enforce only the
    // self-consistency the response alone can prove.
    if (d.nextOffset != null) {
      anyMore = true;
      if (!Number.isInteger(d.nextOffset) || d.nextOffset <= 0 || d.nextOffset > d.total) {
        fail(`truncated field ${d.field} nextOffset(${d.nextOffset}) out of range 1..${d.total}`);
      }
    }
    // Cross-check the declared shown against the actual list length in answer.
    const actual = answer && Array.isArray(answer[d.field]) ? answer[d.field].length : undefined;
    if (actual !== undefined && actual !== d.shown) {
      fail(`truncated.shown(${d.shown}) != actual list length(${actual}) for ${d.field}`);
    }
  }
  if (truncated.any !== anyMore) fail(`truncated.any(${truncated.any}) disagrees with nextOffset presence(${anyMore})`);
}

function checkEmpty(answer) {
  if (!answer || typeof answer !== 'object') return;
  const empty = answer.empty;
  // Every empty list in the answer MUST carry a reason; a non-empty list MUST NOT.
  for (const [k, v] of Object.entries(answer)) {
    if (k === 'empty') continue;
    if (Array.isArray(v) && v.length === 0) {
      const reason = empty && empty[k];
      if (!reason) fail(`empty list ${k} has no answer.empty reason (0 results != safe)`);
      if (!EMPTY_REASONS.includes(reason.kind ?? reason)) {
        fail(`answer.empty.${k} reason must be one of ${EMPTY_REASONS.join('|')}`);
      }
    } else if (Array.isArray(v) && v.length > 0 && empty && empty[k]) {
      fail(`non-empty list ${k} must not carry an answer.empty reason (no blanket declaration)`);
    }
  }
}

function fail(message) {
  throw new ContractError(message);
}

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}
