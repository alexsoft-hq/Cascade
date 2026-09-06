// protocol.mjs — the worker fact protocol. The language-neutral seam (SPEC §7.1).
//
// Every language lane (Java/SQL/web/…) speaks NOT arbitrary stdout but a stream
// of versioned JSONL fact envelopes. This module defines the envelope, validates
// it, and checks payload integrity — so a corrupted or truncated worker stream
// cannot silently poison the graph (fail-closed, §3.3).
//
// Envelope shape:
//   { protocolVersion:1, kind:"EdgeFact", seq:1024, payload:{...}, payloadHash:"sha256:<hex>" }
//
// Rules (SPEC §7.1):
//  - protocol/IR version mismatch is fail-fast (a different major means a
//    different contract — do not attempt to interpret).
//  - unknown top-level fields are preserved forward-compatibly (a newer worker
//    may add envelope fields), but unknown FACT KINDS are rejected.
//  - payloadHash MUST equal sha256 of the canonical payload — this is how a
//    truncated/tampered stream is detected without a signing key.

import { sha256, canonicalJson } from './canonical.mjs';

export const PROTOCOL_VERSION = 1;

/** The minimum fact kinds a worker may emit (SPEC §7.1). Additive: append only. */
export const FACT_KINDS = Object.freeze([
  'SymbolFact', 'EdgeFact', 'EvidenceFact', 'DiagnosticFact', 'SummaryFact', 'MetricFact',
]);

const HASH_PREFIX = 'sha256:';

/**
 * Compute the canonical payload hash string for an envelope.
 * @param {unknown} payload
 * @returns {string} "sha256:<64hex>"
 */
export function payloadHashOf(payload) {
  return HASH_PREFIX + sha256(canonicalJson(payload));
}

/**
 * Build a valid envelope (used by workers and tests). Computes payloadHash.
 * @param {typeof FACT_KINDS[number]} kind
 * @param {number} seq
 * @param {object} payload
 * @param {object} [extra]  additional forward-compatible envelope fields
 * @returns {object}
 */
export function makeEnvelope(kind, seq, payload, extra = {}) {
  if (!FACT_KINDS.includes(kind)) throw new ProtocolError(`unknown fact kind: ${JSON.stringify(kind)}`);
  if (!Number.isInteger(seq) || seq < 0) throw new ProtocolError(`seq must be a non-negative integer, got ${seq}`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload must be an object');
  }
  // Enforce per-kind required fields at construction (like contract.makeResponse)
  // so a worker cannot emit a structurally-wrong fact in the first place.
  requirePayload(kind, payload);
  return {
    ...extra,
    protocolVersion: PROTOCOL_VERSION,
    kind,
    seq,
    payload,
    payloadHash: payloadHashOf(payload),
  };
}

/**
 * Validate one envelope. Throws ProtocolError on any breach. Version mismatch is
 * fail-fast. Payload integrity is verified against payloadHash.
 * @param {object} env
 * @returns {object} the same envelope (for chaining)
 */
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new ProtocolError('envelope must be an object');
  // Fail-fast on version: a mismatch means a different contract.
  if (env.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `protocol version mismatch: envelope ${JSON.stringify(env.protocolVersion)} != supported ${PROTOCOL_VERSION} (fail-fast)`,
    );
  }
  if (!FACT_KINDS.includes(env.kind)) throw new ProtocolError(`unknown fact kind: ${JSON.stringify(env.kind)}`);
  if (!Number.isInteger(env.seq) || env.seq < 0) throw new ProtocolError(`seq must be a non-negative integer, got ${env.seq}`);
  if (!env.payload || typeof env.payload !== 'object' || Array.isArray(env.payload)) {
    throw new ProtocolError('payload must be an object');
  }
  if (typeof env.payloadHash !== 'string' || !env.payloadHash.startsWith(HASH_PREFIX)) {
    throw new ProtocolError('payloadHash must be a "sha256:<hex>" string');
  }
  const expected = payloadHashOf(env.payload);
  if (env.payloadHash !== expected) {
    throw new ProtocolError(`payload integrity failure for kind ${env.kind} seq ${env.seq}: hash mismatch`);
  }
  // Light per-kind shape checks (deeper schemas arrive with each lane). Never
  // silently accept a structurally wrong fact.
  requirePayload(env.kind, env.payload);
  return env;
}

function requirePayload(kind, p) {
  const need = (fields) => {
    for (const f of fields) if (!(f in p)) throw new ProtocolError(`${kind} payload missing required field: ${f}`);
  };
  switch (kind) {
    case 'SymbolFact': need(['id']); break;                 // a node: id (kind:key)
    case 'EdgeFact': need(['from', 'to', 'type']); break;   // grade OR evidence resolved downstream by policy
    case 'EvidenceFact': need(['kind', 'path']); break;
    case 'DiagnosticFact': need(['code', 'severity']); break;
    case 'MetricFact': need(['name']); break;
    case 'SummaryFact': need(['subject']); break;
    default: break;
  }
}

/**
 * Parse a JSONL stream of envelopes.
 * @param {string} text
 * @param {{strict?:boolean, allowTrailingPartial?:boolean}} [opts]
 *   strict (default true): throw on the first malformed/invalid line.
 *   non-strict: collect problems and continue, returning them in `.errors`.
 *   allowTrailingPartial (default false): if the LAST line is truncated (a
 *     crashed worker mid-write), drop it silently only when non-strict — a
 *     restart resumes from the last completed shard (SPEC §7.1). In strict mode
 *     a trailing partial is still an error.
 * @returns {{envelopes:object[], errors:{line:number,message:string,raw:string}[]}}
 */
export function parseJsonl(text, opts = {}) {
  const strict = opts.strict !== false;
  const lines = String(text).split('\n');
  const envelopes = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue; // blank/trailing newline
    const isLast = i === lines.length - 1 || lines.slice(i + 1).every((l) => l.trim() === '');
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      if (isLast && opts.allowTrailingPartial && !strict) continue; // crashed mid-write
      const err = { line: i + 1, message: `invalid JSON: ${e.message}`, raw };
      if (strict) throw new ProtocolError(`${err.message} at line ${err.line}`);
      errors.push(err);
      continue;
    }
    try {
      envelopes.push(validateEnvelope(obj));
    } catch (e) {
      const err = { line: i + 1, message: e.message, raw };
      if (strict) throw e;
      errors.push(err);
    }
  }
  return { envelopes, errors };
}

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}
