import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  REGISTRY_SCHEMA,
  emptyRegistry,
  validateRegistry,
  upsertProject,
  findProject,
  projectIds,
  readRegistry,
  writeRegistryAtomic,
  RegistryError,
} from '../src/core/registry.mjs';

const entry = (id, dir, over = {}) => ({ id, dotCascadePath: dir, source: 'init', stack: ['sql'], lastCertifiedAt: null, ...over });

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('emptyRegistry declares the schema and has no projects', () => {
  assert.deepEqual(emptyRegistry(), { schema: REGISTRY_SCHEMA, projects: [] });
});

test('upsertProject adds an entry, normalizes it and does not mutate the input', () => {
  const before = emptyRegistry();
  const after = upsertProject(before, entry('alpha', '/p/alpha/.cascade'));
  assert.deepEqual(before.projects, [], 'input registry must not be mutated');
  assert.equal(after.projects.length, 1);
  assert.deepEqual(after.projects[0], {
    id: 'alpha', dotCascadePath: '/p/alpha/.cascade', source: 'init', stack: ['sql'], lastCertifiedAt: null,
  });
});

test('upsertProject keeps entries sorted by id', () => {
  let reg = emptyRegistry();
  for (const id of ['zulu', 'alpha', 'mike']) reg = upsertProject(reg, entry(id, `/p/${id}/.cascade`));
  assert.deepEqual(projectIds(reg), ['alpha', 'mike', 'zulu']);
  assert.deepEqual(reg.projects.map((p) => p.id), ['alpha', 'mike', 'zulu']);
});

test('upsertProject replaces the entry with the same .cascade path (one directory is one project)', () => {
  let reg = upsertProject(emptyRegistry(), entry('alpha', '/p/a/.cascade'));
  reg = upsertProject(reg, entry('alpha', '/p/a/.cascade', { source: 'analyze', stack: ['sql', 'java'], lastCertifiedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(reg.projects.length, 1);
  assert.equal(reg.projects[0].source, 'analyze');
  assert.deepEqual(reg.projects[0].stack, ['sql', 'java']);
  assert.equal(reg.projects[0].lastCertifiedAt, '2026-01-01T00:00:00.000Z');
});

test('upsertProject renames the project that owns a path (same path, different id)', () => {
  let reg = upsertProject(emptyRegistry(), entry('old', '/p/a/.cascade'));
  reg = upsertProject(reg, entry('new', '/p/a/.cascade'));
  assert.deepEqual(projectIds(reg), ['new']);
});

test('upsertProject refuses an id already held by another directory, and says how to resolve it', () => {
  const reg = upsertProject(emptyRegistry(), entry('alpha', '/p/one/.cascade'));
  assert.throws(
    () => upsertProject(reg, entry('alpha', '/p/two/.cascade')),
    (e) => {
      assert.ok(e instanceof RegistryError);
      assert.match(e.message, /ambiguous project id "alpha"/);
      assert.match(e.message, /\/p\/one\/\.cascade/);
      assert.match(e.message, /--force/);
      return true;
    },
  );
});

test('upsertProject with force re-points an ambiguous id to the new directory', () => {
  let reg = upsertProject(emptyRegistry(), entry('alpha', '/p/one/.cascade'));
  reg = upsertProject(reg, entry('alpha', '/p/two/.cascade'), { force: true });
  assert.equal(reg.projects.length, 1);
  assert.equal(reg.projects[0].dotCascadePath, '/p/two/.cascade');
});

test('upsertProject rejects malformed entries', () => {
  const reg = emptyRegistry();
  assert.throws(() => upsertProject(reg, entry('Bad Id', '/p/a/.cascade')), RegistryError);
  assert.throws(() => upsertProject(reg, entry('alpha', '')), RegistryError);
  assert.throws(() => upsertProject(reg, entry('alpha', '/p/a/.cascade', { source: '' })), RegistryError);
  assert.throws(() => upsertProject(reg, entry('alpha', '/p/a/.cascade', { stack: 'sql' })), RegistryError);
  assert.throws(() => upsertProject(reg, entry('alpha', '/p/a/.cascade', { lastCertifiedAt: 7 })), RegistryError);
});

test('findProject / projectIds read an entry back', () => {
  const reg = upsertProject(emptyRegistry(), entry('alpha', '/p/a/.cascade'));
  assert.equal(findProject(reg, 'alpha').dotCascadePath, '/p/a/.cascade');
  assert.equal(findProject(reg, 'nope'), null);
  assert.deepEqual(projectIds(reg), ['alpha']);
});

test('validateRegistry refuses an unknown schema instead of guessing', () => {
  assert.throws(() => validateRegistry({ schema: 'cascade:registry:2', projects: [] }), /Refusing to read it/);
  assert.throws(() => validateRegistry({ projects: [] }), RegistryError);
  assert.throws(() => validateRegistry({ schema: REGISTRY_SCHEMA, projects: {} }), RegistryError);
  assert.throws(() => validateRegistry([]), RegistryError);
});

test('validateRegistry refuses duplicate ids', () => {
  const dup = { schema: REGISTRY_SCHEMA, projects: [entry('a', '/x/.cascade'), entry('a', '/y/.cascade')] };
  assert.throws(() => validateRegistry(dup), /duplicate project id/);
});

test('readRegistry: a missing file is an empty registry, not an error', (t) => {
  const home = tmpHome(t);
  assert.deepEqual(readRegistry(path.join(home, 'registry.json')), emptyRegistry());
});

test('readRegistry refuses malformed JSON rather than silently resetting the file', (t) => {
  const home = tmpHome(t);
  const file = path.join(home, 'registry.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readRegistry(file), (e) => {
    assert.ok(e instanceof RegistryError);
    assert.match(e.message, /never reset automatically/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'the broken file must be left untouched');
});

test('writeRegistryAtomic creates the home dir, round-trips, and leaves no temp file', (t) => {
  const home = tmpHome(t);
  const file = path.join(home, 'nested', 'registry.json');
  const reg = upsertProject(emptyRegistry(), entry('alpha', '/p/a/.cascade'));
  writeRegistryAtomic(file, reg);

  assert.deepEqual(readRegistry(file), reg);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['registry.json']);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
});

test('writeRegistryAtomic refuses to write an invalid registry', (t) => {
  const home = tmpHome(t);
  const file = path.join(home, 'registry.json');
  assert.throws(() => writeRegistryAtomic(file, { schema: 'other', projects: [] }), RegistryError);
  assert.equal(fs.existsSync(file), false);
});
