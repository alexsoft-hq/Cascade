import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  loadManifest,
  validateManifest,
  MANIFEST_SCHEMA,
  ManifestError,
} from '../src/core/manifest.mjs';

const FULL_SHA = 'a'.repeat(40);

function validManifestObj(overrides = {}) {
  return {
    schema: MANIFEST_SCHEMA,
    project: 'myapp',
    repositories: [
      { key: 'backend', path: './app', commit: FULL_SHA, kind: 'backend-java' },
    ],
    profile: './profile.yaml',
    ...overrides,
  };
}

test('a valid manifest object passes validateManifest', () => {
  const out = validateManifest(validManifestObj(), '/some/dir/manifest.json');
  assert.equal(out.schema, MANIFEST_SCHEMA);
  assert.equal(out.project, 'myapp');
  assert.equal(out.repositories.length, 1);
  assert.equal(out.repositories[0].commit, FULL_SHA);
  assert.equal(out.repositories[0].kind, 'backend-java');
  assert.equal(out.profileRef, './profile.yaml');
});

test('§5 crux: repo absPath resolves relative to the manifest file directory (./app)', () => {
  const out = validateManifest(validManifestObj(), '/one/place/manifest.json');
  assert.equal(out.repositories[0].absPath, '/one/place/app');
});

test('§5 crux: repo absPath resolves relative to the manifest file directory (../web)', () => {
  const obj = validManifestObj({
    repositories: [{ key: 'web', path: '../web', commit: FULL_SHA, kind: 'frontend-web' }],
  });
  const out = validateManifest(obj, '/one/place/manifest.json');
  assert.equal(out.repositories[0].absPath, '/one/web');
});

test('§2.1: digest excludes repo path — identical manifests differing only in repo path (and manifestFilePath) produce the SAME manifestDigest', () => {
  const objA = validManifestObj({
    repositories: [{ key: 'backend', path: './app', commit: FULL_SHA, kind: 'backend-java' }],
  });
  const objB = validManifestObj({
    repositories: [{ key: 'backend', path: '../elsewhere/app', commit: FULL_SHA, kind: 'backend-java' }],
  });
  const outA = validateManifest(objA, '/one/place/manifest.json');
  const outB = validateManifest(objB, '/another/spot/manifest.json');
  assert.equal(outA.manifestDigest, outB.manifestDigest);
});

test('§2.1: digest changes when a commit differs', () => {
  const objA = validManifestObj();
  const objB = validManifestObj({
    repositories: [{ key: 'backend', path: './app', commit: 'b'.repeat(40), kind: 'backend-java' }],
  });
  const outA = validateManifest(objA, '/one/place/manifest.json');
  const outB = validateManifest(objB, '/one/place/manifest.json');
  assert.notEqual(outA.manifestDigest, outB.manifestDigest);
});

test('digest is stable across two calls', () => {
  const obj = validManifestObj();
  const out1 = validateManifest(obj, '/one/place/manifest.json');
  const out2 = validateManifest(obj, '/one/place/manifest.json');
  assert.equal(out1.manifestDigest, out2.manifestDigest);
});

test('validateManifest throws ManifestError on wrong schema', () => {
  const obj = validManifestObj({ schema: 'cascade:manifest:2' });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on empty/invalid project', () => {
  assert.throws(() => validateManifest(validManifestObj({ project: '' }), '/p/manifest.json'), ManifestError);
  assert.throws(() => validateManifest(validManifestObj({ project: 'Bad Project' }), '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on empty repositories array', () => {
  assert.throws(() => validateManifest(validManifestObj({ repositories: [] }), '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on a short SHA commit', () => {
  const obj = validManifestObj({
    repositories: [{ key: 'backend', path: './app', commit: 'abc123', kind: 'backend-java' }],
  });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on a branch name commit', () => {
  const obj = validManifestObj({
    repositories: [{ key: 'backend', path: './app', commit: 'main', kind: 'backend-java' }],
  });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on a kind not in the allowed set', () => {
  const obj = validManifestObj({
    repositories: [{ key: 'backend', path: './app', commit: FULL_SHA, kind: 'python' }],
  });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on duplicate repo keys', () => {
  const obj = validManifestObj({
    repositories: [
      { key: 'backend', path: './app', commit: FULL_SHA, kind: 'backend-java' },
      { key: 'backend', path: './app2', commit: FULL_SHA, kind: 'backend-java' },
    ],
  });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('validateManifest throws ManifestError on a non-string profile', () => {
  const obj = validManifestObj({ profile: 123 });
  assert.throws(() => validateManifest(obj, '/p/manifest.json'), ManifestError);
});

test('loadManifest reads, validates and normalizes a real manifest.json from disk', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const manifestPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(validManifestObj()), 'utf8');

  const loaded = loadManifest(manifestPath);
  assert.equal(loaded.file, manifestPath);
  assert.equal(loaded.repositories[0].absPath, path.join(tmp, 'app'));
  assert.equal(loaded.project, 'myapp');
});

test('loadManifest throws on a missing file', () => {
  assert.throws(() => loadManifest('/nonexistent/path/manifest.json'), ManifestError);
});

test('loadManifest throws on invalid JSON', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const manifestPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifestPath, '{ not valid json', 'utf8');

  assert.throws(() => loadManifest(manifestPath), ManifestError);
});
