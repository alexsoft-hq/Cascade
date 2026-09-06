import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, sha256, digest12, artifactDirName, CanonicalError } from '../src/core/canonical.mjs';

test('key insertion order does not leak into bytes (SPEC §2.1)', () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('arrays preserve order; nesting is recursive', () => {
  assert.equal(canonicalJson([3, { b: 1, a: 2 }, [2, 1]]), '[3,{"a":2,"b":1},[2,1]]');
});

test('undefined is lowered to null, deterministically', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"a":null,"b":1}');
  assert.equal(canonicalJson([undefined]), '[null]');
  assert.equal(canonicalJson(undefined), 'null');
});

test('non-finite numbers and bigint are refused, not silently mangled', () => {
  assert.throws(() => canonicalJson({ x: NaN }), CanonicalError);
  assert.throws(() => canonicalJson({ x: Infinity }), CanonicalError);
  assert.throws(() => canonicalJson({ x: 1n }), CanonicalError);
});

test('sha256 is stable and hex; digest12 is 12 chars', () => {
  const d = sha256('hello');
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(sha256('hello'), d);
  assert.equal(digest12({ a: 1 }).length, 12);
  assert.match(digest12({ a: 1 }), /^[0-9a-f]{12}$/);
});

test('digest is order-independent (content-addressed)', () => {
  assert.equal(digest12({ a: 1, b: 2 }), digest12({ b: 2, a: 1 }));
  assert.notEqual(digest12({ a: 1 }), digest12({ a: 2 }));
});

test('artifactDirName = <kind>-<digest12>, validates kind', () => {
  const name = artifactDirName('javafacts', { x: 1 });
  assert.match(name, /^javafacts-[0-9a-f]{12}$/);
  assert.throws(() => artifactDirName('Bad Kind', {}), CanonicalError);
  assert.throws(() => artifactDirName('9leading', {}), CanonicalError);
});
