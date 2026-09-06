import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile } from '../src/core/profile.mjs';
import {
  buildReceipt, verifyReceipt, receiptTtlDaysOf,
  RECEIPT_SCHEMA, RECEIPT_FILES, DEFAULT_TTL_DAYS, ReceiptError,
} from '../src/core/receipt.mjs';

// SPEC §14.4 — the deployment receipt. The adversarial cases live in
// test/calibration_tamper.test.mjs; this file pins the shape and the refusals.

const FILES = [
  { name: 'pack/pack.json', sha256: 'a'.repeat(64) },
  { name: 'pack/facts-index.json', sha256: 'b'.repeat(64) },
  { name: 'calibration/gate-state.json', sha256: 'c'.repeat(64) },
];
const ENGINE = 'e'.repeat(64);

function receipt(over = {}) {
  return buildReceipt({
    builtAt: '2026-01-01T00:00:00.000Z',
    enginePrint: ENGINE,
    pack: { digest: 'deadbeef1234', project: 'com.example.shop' },
    gate: { mode: 'NO_CHANGE', verdict: 'GREEN', evaluatedAt: '2026-01-01T00:00:00.000Z' },
    files: FILES,
    ...over,
  });
}

function actual(over = {}) {
  const files = {};
  for (const f of FILES) files[f.name] = f.sha256;
  return {
    files, enginePrint: ENGINE, gateState: { mode: 'NO_CHANGE', verdict: 'GREEN' },
    now: '2026-01-10T00:00:00.000Z', ...over,
  };
}

test('a receipt records what it covers, with an expiry derived from the TTL', () => {
  const r = receipt();
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(r.ttlDays, DEFAULT_TTL_DAYS);
  assert.equal(r.expiresAt, '2026-01-31T00:00:00.000Z');
  assert.deepEqual(r.files.map((f) => f.name), [...RECEIPT_FILES].sort());
  assert.equal(receipt({ ttlDays: 7 }).expiresAt, '2026-01-08T00:00:00.000Z');
});

test('the TTL comes from the profile, and falls back to the documented default', () => {
  assert.equal(receiptTtlDaysOf(normalizeProfile({})), DEFAULT_TTL_DAYS);
  assert.equal(receiptTtlDaysOf(normalizeProfile({ calibration: { receiptTtlDays: 7 } })), 7);
  assert.equal(receiptTtlDaysOf(null), DEFAULT_TTL_DAYS);
  assert.equal(receiptTtlDaysOf({ calibration: { receiptTtlDays: 0 } }), DEFAULT_TTL_DAYS);
});

test('a RED run never gets a receipt', () => {
  assert.throws(() => receipt({ gate: { mode: 'ENGINE_MOVED', verdict: 'RED' } }),
    (e) => e instanceof ReceiptError && /RED run does not get a receipt/.test(e.message));
  assert.throws(() => receipt({ builtAt: 'not-a-time' }), (e) => /is not a timestamp/.test(e.message));
  assert.throws(() => receipt({ enginePrint: '' }), (e) => /engine print/.test(e.message));
});

test('an untouched project verifies, and every claim is counted as checked', () => {
  const r = verifyReceipt({ receipt: receipt(), actual: actual() });
  assert.equal(r.ok, true, JSON.stringify(r.disagreements));
  assert.equal(r.checked, 6); // three files + engine print + verdict cross-check + expiry
  assert.equal(r.expiresAt, '2026-01-31T00:00:00.000Z');
});

test('there is no receipt at all: that is a refusal, with the cure named', () => {
  const r = verifyReceipt({ receipt: null, actual: actual() });
  assert.equal(r.ok, false);
  assert.equal(r.disagreements[0].check, 'receipt');
  assert.match(r.disagreements[0].reason, /cascade analyze/);
});

test('an unknown receipt schema is refused rather than half-read (§17.7)', () => {
  const r = verifyReceipt({ receipt: { ...receipt(), schema: 'cascade:receipt:2' }, actual: actual() });
  assert.equal(r.ok, false);
  assert.equal(r.disagreements[0].check, 'schema');
  assert.equal(r.disagreements.length, 1, 'nothing else is even attempted against a schema we cannot read');
});

test('a file that exists but the receipt never covered means the receipt describes a different run', () => {
  const partial = receipt({ files: FILES.slice(0, 2) });
  const r = verifyReceipt({ receipt: partial, actual: actual() });
  assert.equal(r.ok, false);
  const hit = r.disagreements.find((d) => d.check === 'file:calibration/gate-state.json');
  assert.match(hit.reason, /the receipt does not cover it/);
});

test('a receipt with no gate state to corroborate it is not verified', () => {
  const r = verifyReceipt({ receipt: receipt(), actual: actual({ gateState: null }) });
  assert.equal(r.ok, false);
  assert.match(r.disagreements.find((d) => d.check === 'gate-verdict').reason, /no gate state on disk to corroborate/);
});

test('an engine that cannot be fingerprinted is not "close enough"', () => {
  const r = verifyReceipt({ receipt: receipt(), actual: actual({ enginePrint: null }) });
  assert.equal(r.ok, false);
  assert.match(r.disagreements.find((d) => d.check === 'engine-print').reason, /could not be fingerprinted/);
});
