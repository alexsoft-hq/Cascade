import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageIdentity, releaseSelection } from '../src/packaging/release_checks.mjs';

test('candidate requires both lock identities to match package metadata', () => {
  const pkg = { name: '@example/cascade', version: '0.9.0' };
  const lock = { ...pkg, packages: { '': { ...pkg } } };
  assert.deepEqual(packageIdentity(pkg, lock), pkg);
  assert.throws(() => packageIdentity(pkg, { ...lock, version: '0.8.0' }), /identities differ/);
  assert.throws(() => packageIdentity(pkg, { ...lock, packages: { '': { ...pkg, version: '0.8.0' } } }), /identities differ/);
});

test('release validation needs an explicit immutable version selection', () => {
  assert.throws(() => releaseSelection({}), /Select/);
  assert.throws(() => releaseSelection({ npmVersion: 'latest' }), /exact semantic/);
  assert.throws(() => releaseSelection({ tarball: 'candidate.tgz' }), /exact semantic/);
  assert.throws(() => releaseSelection({ tag: 'v0.8.0', npmVersion: '0.9.0' }), /differ/);
  assert.throws(() => releaseSelection({ tarball: 'candidate.tgz', npmVersion: '0.9.0' }), /cannot be combined/);
  assert.equal(releaseSelection({ tag: 'v0.8.0' }).version, '0.8.0');
  assert.equal(releaseSelection({ npmVersion: '0.8.0' }).version, '0.8.0');
  assert.equal(releaseSelection({ tarball: 'candidate.tgz', expectedVersion: '0.9.0' }).version, '0.9.0');
});
