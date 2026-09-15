import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveProject, registrationTarget, ResolveError } from '../src/core/resolve.mjs';
import { emptyRegistry, upsertProject } from '../src/core/registry.mjs';

// Absolute paths in this platform's spelling: the resolver resolves what it is given.
const at = (p) => path.resolve(p);
const CWD = at('/work/here');
const ENV = { CASCADE_HOME: at('/home/.cascade') };

const registryWith = (...entries) => {
  let reg = emptyRegistry();
  for (const e of entries) reg = upsertProject(reg, e);
  return () => reg;
};
const empty = () => emptyRegistry();

test('--pack wins over every other flag and implies no .cascade', () => {
  const r = resolveProject({
    pack: 'out/pack', project: 'alpha', root: at('/other'), cwd: CWD, env: ENV,
    readRegistry: registryWith({ id: 'alpha', dotCascadePath: at('/p/alpha/.cascade'), source: 'init' }),
  });
  assert.deepEqual(r, { packDir: path.join(CWD, 'out', 'pack'), dotCascade: null, source: 'pack-flag', projectId: null });
});

test('--project resolves through the registry, ahead of --root and cwd', () => {
  const r = resolveProject({
    project: 'alpha', root: at('/other'), cwd: CWD, env: ENV,
    readRegistry: registryWith({ id: 'alpha', dotCascadePath: at('/p/alpha/.cascade'), source: 'init' }),
  });
  assert.deepEqual(r, {
    packDir: path.join(at('/p/alpha/.cascade'), 'pack'),
    dotCascade: at('/p/alpha/.cascade'),
    source: 'registry',
    projectId: 'alpha',
  });
});

test('--root beats cwd', () => {
  const r = resolveProject({ root: at('/other/app'), cwd: CWD, env: ENV, readRegistry: empty });
  assert.deepEqual(r, {
    packDir: path.join(at('/other/app'), '.cascade', 'pack'), dotCascade: path.join(at('/other/app'), '.cascade'), source: 'root', projectId: null,
  });
});

test('a relative --root is resolved against cwd', () => {
  const r = resolveProject({ root: '../app', cwd: CWD, env: ENV, readRegistry: empty });
  assert.equal(r.dotCascade, path.join(at('/work/app'), '.cascade'));
  assert.equal(r.source, 'root');
});

test('with no flags at all the project is the cwd .cascade', () => {
  const r = resolveProject({ cwd: CWD, env: ENV, readRegistry: empty });
  assert.deepEqual(r, {
    packDir: path.join(CWD, '.cascade', 'pack'), dotCascade: path.join(CWD, '.cascade'), source: 'cwd', projectId: null,
  });
});

test('an unknown --project against an empty registry says the registry is empty and how to fix it', () => {
  assert.throws(
    () => resolveProject({ project: 'ghost', cwd: CWD, env: ENV, readRegistry: empty }),
    (e) => {
      assert.ok(e instanceof ResolveError);
      assert.match(e.message, /unknown project "ghost"/);
      assert.ok(e.message.includes(`registry at ${path.join(ENV.CASCADE_HOME, 'registry.json')} is empty`), e.message);
      assert.match(e.message, /cascade init/);
      return true;
    },
  );
});

test('an unknown --project against a populated registry lists the registered ids', () => {
  assert.throws(
    () => resolveProject({
      project: 'ghost', cwd: CWD, env: ENV,
      readRegistry: registryWith(
        { id: 'zulu', dotCascadePath: at('/p/z/.cascade'), source: 'init' },
        { id: 'alpha', dotCascadePath: at('/p/a/.cascade'), source: 'init' },
      ),
    }),
    (e) => {
      assert.ok(e instanceof ResolveError);
      assert.match(e.message, /registered ids are alpha, zulu/);
      return true;
    },
  );
});

test('the registry is read from CASCADE_HOME, so the home tier is overridable in tests', () => {
  let seen = null;
  resolveProject({
    project: 'alpha', cwd: CWD, env: { CASCADE_HOME: at('/custom/home') },
    readRegistry: (file) => { seen = file; return upsertProject(emptyRegistry(), { id: 'alpha', dotCascadePath: at('/p/a/.cascade'), source: 'init' }); },
  });
  assert.equal(seen, path.join(at('/custom/home'), 'registry.json'));
});

test('empty-string flags are treated as absent, not as an empty path', () => {
  const r = resolveProject({ pack: '', project: '', root: '', cwd: CWD, env: ENV, readRegistry: empty });
  assert.equal(r.source, 'cwd');
});

test('registrationTarget accepts a pack written inside the resolved .cascade', () => {
  const resolved = { dotCascade: at('/p/a/.cascade'), projectId: 'alpha' };
  assert.deepEqual(registrationTarget(resolved, at('/p/a/.cascade/pack'), CWD), { dotCascade: at('/p/a/.cascade'), projectId: 'alpha' });
  assert.deepEqual(registrationTarget(resolved, at('/p/a/.cascade'), CWD), { dotCascade: at('/p/a/.cascade'), projectId: 'alpha' });
});

test('registrationTarget refuses a bare --out elsewhere, and a pack-flag resolution', () => {
  const resolved = { dotCascade: at('/p/a/.cascade'), projectId: 'alpha' };
  assert.equal(registrationTarget(resolved, '/tmp/scratch/pack', CWD), null);
  assert.equal(registrationTarget(resolved, '/p/a/.cascade-other/pack', CWD), null);
  assert.equal(registrationTarget({ dotCascade: null, projectId: null }, '/p/a/.cascade/pack', CWD), null);
  assert.equal(registrationTarget(null, '/p/a/.cascade/pack', CWD), null);
});

test('registrationTarget resolves a relative --out against cwd', () => {
  const resolved = { dotCascade: path.join(CWD, '.cascade'), projectId: null };
  assert.deepEqual(registrationTarget(resolved, '.cascade/pack', CWD), { dotCascade: path.join(CWD, '.cascade'), projectId: null });
  assert.equal(registrationTarget(resolved, '../elsewhere/pack', CWD), null);
});
