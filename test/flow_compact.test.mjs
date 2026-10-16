import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactFlowResponse } from '../src/mcp/flow_compact.mjs';
import { assertContract, makeResponse } from '../src/mcp/contract.mjs';
import { flow } from '../src/mcp/tools.mjs';

const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/golden/fullstack/flow/endpoint_GET_things_id.a7ba1e0e.json', import.meta.url), 'utf8')).answer;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

function decode(answer) {
  const { evidence, format: _format, budget: _budget, ...out } = answer;
  const expand = (value) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(expand);
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      key === 'basisRef' ? ['basis', evidence.reasons[item]] : [key, expand(item)]));
  };
  for (const [field, values] of Object.entries(out)) {
    if (!Array.isArray(values)) continue;
    out[field] = values.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (key === 'pathRefs' || key === 'walkedPathRefs') return [key.slice(0, -4), value.map((ref) => expand(evidence.edges[ref]))];
      if (key === 'linkRef') return ['link', expand(evidence.links[value])];
      return [key, value];
    })));
  }
  return out;
}

test('compact flow preserves full paths, grades and evidence by independent expansion', () => {
  const full = fixture(), original = structuredClone(full);
  const compact = compactFlowResponse(full, { maxBytes: 262144, offset: 0 });
  assertContract(compact);
  assert.deepEqual(decode(compact.answer), full.answer);
  assert.deepEqual(compact.truncated, full.truncated);
  assert.deepEqual(compact.basis, full.basis);
  assert.deepEqual(compact.limits, full.limits);
  assert.deepEqual(full, original);
  assert.ok(bytes(compact.answer) < bytes(full.answer));
});

test('compact flow byte cut keeps whole proofs and resumable per-lane offsets', () => {
  const full = fixture();
  const field = full.truncated.fields.find((d) => full.answer[d.field].length > 0).field;
  const source = full.answer[field][0];
  full.answer[field] = Array.from({ length: 30 }, (_, i) => ({ ...source, id: `row${i}`, detail: 'x'.repeat(700) }));
  const meta = full.truncated.fields.find((d) => d.field === field);
  Object.assign(meta, { shown: 30, total: 50, nextOffset: 35 });
  full.truncated.any = true;
  const compact = compactFlowResponse(makeResponse(full), { maxBytes: 6000, offset: 5 });
  assertContract(compact); assert.ok(bytes(compact.answer) <= 6000);
  const cut = compact.truncated.fields.find((d) => d.field === field);
  assert.ok(cut.byteLimited); assert.equal(cut.nextOffset, 5 + cut.shown);
  assert.deepEqual(cut.retry, { action: 'increase-maxBytes', offset: 5 + cut.shown });
  assert.deepEqual(decode(compact.answer)[field], full.answer[field].slice(0, cut.shown));
  assert.deepEqual(compact.answer.walk, full.answer.walk);
});

test('compact zero-fit does not skip a row or claim an empty graph', () => {
  const full = fixture();
  const fields = full.truncated.fields.filter((d) => full.answer[d.field].length > 0);
  for (const { field } of fields) full.answer[field] = full.answer[field].map((row) => ({ ...row, detail: 'x'.repeat(20000) }));
  const compact = compactFlowResponse(makeResponse(full), { maxBytes: 4096, offset: 0 });
  assertContract(compact);
  for (const { field } of fields) {
    const cut = compact.truncated.fields.find((d) => d.field === field);
    assert.equal(cut.shown, 0); assert.equal(cut.nextOffset, null);
    assert.deepEqual(cut.retry, { action: 'increase-maxBytes', offset: 0 });
    assert.equal(compact.answer.empty[field], 'not-in-this-axis');
  }
  full.answer.entry.extra = 'x'.repeat(5000);
  assert.equal(compactFlowResponse(full, { maxBytes: 4096, offset: 0 }), null);
});

test('flow rejects invalid compact options before walking', () => {
  for (const args of [{ compact: 'true' }, { maxBytes: 4096 }, { compact: true, maxBytes: 100 }, { compact: true, maxBytes: 5000.5 }]) {
    assert.throws(() => flow({}, args, {}), { code: 'bad-input' });
  }
});
