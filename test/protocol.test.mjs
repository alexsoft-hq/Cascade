import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  FACT_KINDS,
  payloadHashOf,
  makeEnvelope,
  validateEnvelope,
  parseJsonl,
  ProtocolError,
} from '../src/core/protocol.mjs';

// ---------------------------------------------------------------------------
// PROTOCOL_VERSION / FACT_KINDS
// ---------------------------------------------------------------------------

test('PROTOCOL_VERSION is 1', () => {
  assert.equal(PROTOCOL_VERSION, 1);
});

test('FACT_KINDS includes exactly the six documented kinds', () => {
  assert.deepEqual(
    [...FACT_KINDS].sort(),
    ['DiagnosticFact', 'EdgeFact', 'EvidenceFact', 'MetricFact', 'SummaryFact', 'SymbolFact'].sort(),
  );
});

// ---------------------------------------------------------------------------
// payloadHashOf
// ---------------------------------------------------------------------------

test('payloadHashOf: returns a "sha256:"-prefixed string with a 64-hex tail', () => {
  const h = payloadHashOf({ from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  assert.ok(h.startsWith('sha256:'));
  assert.match(h.slice('sha256:'.length), /^[0-9a-f]{64}$/);
});

test('payloadHashOf: order-independent — same payload, keys inserted in a different order, same hash', () => {
  const p1 = { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' };
  const p2 = { type: 'CALLS', from: 'symbol:a', to: 'symbol:b' };
  assert.equal(payloadHashOf(p1), payloadHashOf(p2));
});

// ---------------------------------------------------------------------------
// makeEnvelope — happy path
// ---------------------------------------------------------------------------

test('makeEnvelope: builds a well-formed EdgeFact envelope with a matching payloadHash', () => {
  const payload = { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' };
  const env = makeEnvelope('EdgeFact', 3, payload);
  assert.equal(env.protocolVersion, 1);
  assert.equal(env.kind, 'EdgeFact');
  assert.equal(env.seq, 3);
  assert.equal(env.payload, payload);
  assert.equal(env.payloadHash, payloadHashOf(payload));
  assert.doesNotThrow(() => validateEnvelope(env));
});

// ---------------------------------------------------------------------------
// makeEnvelope — construction-time validation
// ---------------------------------------------------------------------------

test('makeEnvelope: throws ProtocolError on an unknown fact kind', () => {
  assert.throws(() => makeEnvelope('WeirdFact', 1, { id: 'x' }), ProtocolError);
});

test('makeEnvelope: throws ProtocolError on a negative seq', () => {
  assert.throws(() => makeEnvelope('SymbolFact', -1, { id: 'x' }), ProtocolError);
});

test('makeEnvelope: throws ProtocolError on a non-integer seq', () => {
  assert.throws(() => makeEnvelope('SymbolFact', 1.5, { id: 'x' }), ProtocolError);
});

test('makeEnvelope: throws ProtocolError on a non-object payload (null, array, string)', () => {
  for (const bad of [null, ['x'], 'x']) {
    assert.throws(() => makeEnvelope('SymbolFact', 1, bad), ProtocolError);
  }
});

test('makeEnvelope: SymbolFact requires id — missing throws, complete succeeds', () => {
  assert.throws(() => makeEnvelope('SymbolFact', 1, {}), ProtocolError);
  const env = makeEnvelope('SymbolFact', 1, { id: 'symbol:a' });
  assert.equal(env.kind, 'SymbolFact');
});

test('makeEnvelope: EdgeFact requires from,to,type — any missing throws, complete succeeds', () => {
  const full = { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' };
  for (const field of ['from', 'to', 'type']) {
    const partial = { ...full };
    delete partial[field];
    assert.throws(() => makeEnvelope('EdgeFact', 1, partial), ProtocolError, `missing ${field} should throw`);
  }
  const env = makeEnvelope('EdgeFact', 1, full);
  assert.equal(env.kind, 'EdgeFact');
});

test('makeEnvelope: EvidenceFact requires kind,path — missing throws, complete succeeds', () => {
  assert.throws(() => makeEnvelope('EvidenceFact', 1, { kind: 'test' }), ProtocolError);
  assert.throws(() => makeEnvelope('EvidenceFact', 1, { path: 'a/b.java' }), ProtocolError);
  const env = makeEnvelope('EvidenceFact', 1, { kind: 'test', path: 'a/b.java' });
  assert.equal(env.kind, 'EvidenceFact');
});

test('makeEnvelope: DiagnosticFact requires code,severity — missing throws, complete succeeds', () => {
  assert.throws(() => makeEnvelope('DiagnosticFact', 1, { code: 'E1' }), ProtocolError);
  assert.throws(() => makeEnvelope('DiagnosticFact', 1, { severity: 'error' }), ProtocolError);
  const env = makeEnvelope('DiagnosticFact', 1, { code: 'E1', severity: 'error' });
  assert.equal(env.kind, 'DiagnosticFact');
});

test('makeEnvelope: MetricFact requires name — missing throws, complete succeeds', () => {
  assert.throws(() => makeEnvelope('MetricFact', 1, {}), ProtocolError);
  const env = makeEnvelope('MetricFact', 1, { name: 'loc' });
  assert.equal(env.kind, 'MetricFact');
});

test('makeEnvelope: SummaryFact requires subject — missing throws, complete succeeds', () => {
  assert.throws(() => makeEnvelope('SummaryFact', 1, {}), ProtocolError);
  const env = makeEnvelope('SummaryFact', 1, { subject: 'symbol:a' });
  assert.equal(env.kind, 'SummaryFact');
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

test('validateEnvelope: throws ProtocolError when payload is mutated without recomputing the hash', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.payload = { ...env.payload, type: 'MAY_CALL' }; // mutate without touching payloadHash
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

test('validateEnvelope: throws ProtocolError when payloadHash is not a "sha256:"-prefixed string', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.payloadHash = 'not-a-hash';
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

// ---------------------------------------------------------------------------
// Version fail-fast
// ---------------------------------------------------------------------------

test('validateEnvelope: throws ProtocolError mentioning version/mismatch on a protocolVersion 2 envelope', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.protocolVersion = 2; // payloadHash is still correct for its payload
  assert.throws(
    () => validateEnvelope(env),
    (err) => err instanceof ProtocolError && /version|mismatch/i.test(err.message),
  );
});

test('validateEnvelope: throws ProtocolError when protocolVersion is missing', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  delete env.protocolVersion;
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

// ---------------------------------------------------------------------------
// validateEnvelope — general shape validation
// ---------------------------------------------------------------------------

test('validateEnvelope: throws ProtocolError when the envelope itself is not an object (null, array, string)', () => {
  for (const bad of [null, ['x'], 'x']) {
    assert.throws(() => validateEnvelope(bad), ProtocolError);
  }
});

test('validateEnvelope: throws ProtocolError on an unknown fact kind', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.kind = 'WeirdFact';
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

test('validateEnvelope: throws ProtocolError on a bad seq', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.seq = -5;
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

test('validateEnvelope: throws ProtocolError on a non-object payload', () => {
  const env = makeEnvelope('EdgeFact', 1, { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' });
  env.payload = 'not-an-object';
  assert.throws(() => validateEnvelope(env), ProtocolError);
});

// ---------------------------------------------------------------------------
// Forward-compat: unknown top-level envelope fields
// ---------------------------------------------------------------------------

test('makeEnvelope/validateEnvelope: an extra unknown top-level field is preserved and still validates', () => {
  const payload = { from: 'symbol:a', to: 'symbol:b', type: 'CALLS' };
  const env = makeEnvelope('EdgeFact', 1, payload, { runId: 'r1' });
  assert.equal(env.runId, 'r1');
  assert.doesNotThrow(() => validateEnvelope(env));
});

// ---------------------------------------------------------------------------
// parseJsonl
// ---------------------------------------------------------------------------

function envLine(seq) {
  return JSON.stringify(makeEnvelope('SymbolFact', seq, { id: `symbol:${seq}` }));
}

test('parseJsonl: N valid envelopes → all parsed, no errors (strict default)', () => {
  const text = [envLine(1), envLine(2), envLine(3)].join('\n');
  const { envelopes, errors } = parseJsonl(text);
  assert.equal(envelopes.length, 3);
  assert.equal(errors.length, 0);
});

test('parseJsonl: blank lines and a trailing newline are skipped, not errors', () => {
  const text = ['', envLine(1), '', envLine(2), ''].join('\n') + '\n';
  const { envelopes, errors } = parseJsonl(text);
  assert.equal(envelopes.length, 2);
  assert.equal(errors.length, 0);
});

test('parseJsonl: strict mode throws ProtocolError on a malformed JSON line', () => {
  const text = [envLine(1), '{not valid json', envLine(2)].join('\n');
  assert.throws(() => parseJsonl(text), ProtocolError);
});

test('parseJsonl: strict mode throws ProtocolError on a well-formed but invalid envelope line', () => {
  const badEnv = JSON.stringify({ ...JSON.parse(envLine(1)), kind: 'WeirdFact' });
  const text = [envLine(1), badEnv].join('\n');
  assert.throws(() => parseJsonl(text), ProtocolError);
});

test('parseJsonl: non-strict mode collects malformed and invalid lines into .errors with line numbers, valid ones still returned', () => {
  const badEnv = JSON.stringify({ ...JSON.parse(envLine(2)), kind: 'WeirdFact' });
  // line 1: valid, line 2: malformed JSON, line 3: invalid envelope
  const text = [envLine(1), '{not valid json', badEnv].join('\n');
  const { envelopes, errors } = parseJsonl(text, { strict: false });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].payload.id, 'symbol:1');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.equal(errors[1].line, 3);
});

test('parseJsonl: a crashed trailing partial line is dropped with {strict:false, allowTrailingPartial:true}', () => {
  const full = envLine(2);
  const partial = full.slice(0, Math.floor(full.length / 2)); // truncated mid-write
  const text = [envLine(1), partial].join('\n');
  const { envelopes, errors } = parseJsonl(text, { strict: false, allowTrailingPartial: true });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].payload.id, 'symbol:1');
  assert.equal(errors.length, 0);
});

test('parseJsonl: the same crashed trailing partial line throws in strict mode', () => {
  const full = envLine(2);
  const partial = full.slice(0, Math.floor(full.length / 2));
  const text = [envLine(1), partial].join('\n');
  assert.throws(() => parseJsonl(text, { strict: true }), ProtocolError);
});
