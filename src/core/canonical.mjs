// canonical.mjs — deterministic serialization + content-addressed digests.
//
// SPEC §2.1 (byte-for-byte determinism) and §5 (content-addressed store) rest
// on this module. Every artifact digest and every `<kind>-<digest12>` directory
// name is computed here. If serialization is not deterministic, the whole
// determinism gate (SPEC §16 metamorphic "commit isolation") is meaningless.
//
// Rules (MUST):
//  - Object keys are sorted recursively (insertion order must not leak into bytes).
//  - `undefined` is lowered to `null` (explicit and stable; never a dropped key
//    whose presence depends on evaluation order).
//  - No incidental whitespace.
//  - Time / machine / absolute paths are NOT the concern of this module — callers
//    MUST keep those out of anything they hand here (they belong in runlog.json,
//    outside the digest — SPEC §5.1).

import { createHash } from 'node:crypto';

/**
 * Canonical JSON string for `value`. Deterministic across key insertion order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return ser(value);
}

function ser(v) {
  if (v === undefined || v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v)) {
      throw new CanonicalError(`non-finite number is not canonically serializable: ${v}`);
    }
    return JSON.stringify(v);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (t === 'bigint') {
    // BigInt has no JSON form; refuse rather than lose precision silently.
    throw new CanonicalError('bigint is not canonically serializable');
  }
  if (Array.isArray(v)) {
    return `[${v.map(ser).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      parts.push(`${JSON.stringify(k)}:${ser(v[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  // functions, symbols, etc.
  throw new CanonicalError(`value of type ${t} is not canonically serializable`);
}

/**
 * Lowercase hex SHA-256 of a string or a canonically-serialized value.
 * @param {string|unknown} input  a raw string, or any value to canonicalize first
 * @returns {string} 64-char hex
 */
export function sha256(input) {
  const s = typeof input === 'string' ? input : canonicalJson(input);
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * First 12 hex chars of the SHA-256 of a value's canonical form.
 * Used for content-addressed artifact directory names (`<kind>-<digest12>`).
 * @param {unknown} value
 * @returns {string} 12-char hex
 */
export function digest12(value) {
  return sha256(canonicalJson(value)).slice(0, 12);
}

/**
 * Content-addressed directory name for an artifact.
 * @param {string} kind  e.g. "javafacts", "edges", "graphmodel"
 * @param {unknown} value  the artifact content (or a digest-bearing summary)
 * @returns {string} `<kind>-<digest12>`
 */
export function artifactDirName(kind, value) {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new CanonicalError(`invalid artifact kind: ${JSON.stringify(kind)}`);
  }
  return `${kind}-${digest12(value)}`;
}

export class CanonicalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanonicalError';
  }
}
