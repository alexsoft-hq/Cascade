import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  homeDir,
  cacheDir,
  registryPath,
  configPath,
  dotCascade,
  projectPaths,
  casPath,
  gitignoreBody,
  ensureProjectDirs,
  ownStateDirRel,
  isOwnStatePath,
  withoutOwnState,
  PathsError,
} from '../src/core/paths.mjs';

test('homeDir({}) defaults to <os.homedir()>/.cascade', () => {
  assert.equal(homeDir({}), path.join(os.homedir(), '.cascade'));
});

test('homeDir returns CASCADE_HOME override when set', () => {
  assert.equal(homeDir({ CASCADE_HOME: '/x/y' }), '/x/y');
});

test("cacheDir('proj', {}) ends with /cascade/proj under the default cache base", () => {
  const d = cacheDir('proj', {});
  assert.equal(d, path.join(os.homedir(), '.cache', 'cascade', 'proj'));
  assert.ok(d.endsWith(path.join('cascade', 'proj')));
});

test('cacheDir honors XDG_CACHE_HOME override', () => {
  const d = cacheDir('proj', { XDG_CACHE_HOME: '/c' });
  assert.ok(d.startsWith('/c/'), `expected ${d} to start with /c/`);
});

test('cacheDir throws PathsError on invalid projectId', () => {
  assert.throws(() => cacheDir('Bad Id', {}), PathsError);
  assert.throws(() => cacheDir('UPPER', {}), PathsError);
  assert.throws(() => cacheDir('', {}), PathsError);
  assert.throws(() => cacheDir('has/slash', {}), PathsError);
});

test('cacheDir accepts valid projectIds without throwing', () => {
  assert.doesNotThrow(() => cacheDir('a', {}));
  assert.doesNotThrow(() => cacheDir('a.b-c_1', {}));
});

test('registryPath / configPath are under homeDir and end with the right filename', () => {
  const env = { CASCADE_HOME: '/home/x' };
  assert.equal(registryPath(env), path.join('/home/x', 'registry.json'));
  assert.equal(configPath(env), path.join('/home/x', 'config.json'));
  assert.ok(registryPath(env).endsWith('registry.json'));
  assert.ok(configPath(env).endsWith('config.json'));
});

test("dotCascade('/p') === '/p/.cascade'", () => {
  assert.equal(dotCascade('/p'), '/p/.cascade');
});

test('dotCascade throws PathsError on non-string/empty projectRoot', () => {
  assert.throws(() => dotCascade(''), PathsError);
  assert.throws(() => dotCascade(undefined), PathsError);
});

test('projectPaths returns the documented shape, all under .cascade', () => {
  const p = projectPaths('/p');
  const root = '/p/.cascade';
  assert.equal(p.manifest, path.join(root, 'manifest.json'));
  // SPEC §6.2 shows the profile in YAML; JSON is that shape in the form a
  // dependency-free core can read, so `cascade init` writes profile.json.
  assert.equal(p.profile, path.join(root, 'profile.json'));
  assert.equal(p.pack, path.join(root, 'pack'));
  assert.ok(p.catalog.endsWith(path.join('catalog', 'columns.jsonl')));
  for (const key of ['root', 'manifest', 'profile', 'pack', 'golden', 'calibration', 'catalog', 'receipt', 'runlog', 'gitignore']) {
    assert.ok(key in p, `expected projectPaths to include ${key}`);
    assert.ok(p[key].startsWith(root), `expected ${key} (${p[key]}) to be under ${root}`);
  }
});

test('casPath matches /cas/edges-<digest12> and lives under the cache dir, not the project', () => {
  const cp = casPath('proj', 'edges', { x: 1 }, {});
  assert.match(cp, /\/cas\/edges-[0-9a-f]{12}$/);
  assert.ok(cp.startsWith(cacheDir('proj', {})));
});

test('casPath is content-addressed: same content -> same path, different content -> different path', () => {
  const a = casPath('proj', 'edges', { x: 1 }, {});
  const b = casPath('proj', 'edges', { x: 1 }, {});
  const c = casPath('proj', 'edges', { x: 2 }, {});
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('gitignoreBody is a newline-terminated string containing pack/ and catalog/', () => {
  const body = gitignoreBody();
  assert.equal(typeof body, 'string');
  assert.ok(body.endsWith('\n'));
  assert.ok(body.includes('pack/'));
  assert.ok(body.includes('catalog/'));
  // The two files init writes must stay trackable — they are not ignored.
  assert.ok(!/^manifest\.json$/m.test(body));
  assert.ok(!/^profile\.json$/m.test(body));
});

test('ensureProjectDirs creates the durable directories, writes .gitignore, and is idempotent', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const p = ensureProjectDirs(tmp);

  for (const dir of [p.root, p.pack, p.golden, p.calibration, path.dirname(p.catalog)]) {
    assert.ok(fs.statSync(dir).isDirectory(), `expected ${dir} to be a directory`);
  }
  assert.ok(fs.statSync(p.gitignore).isFile());
  assert.ok(fs.readFileSync(p.gitignore, 'utf8').includes('pack/'));

  // idempotent: calling again must not throw and must not clobber an existing gitignore
  assert.doesNotThrow(() => ensureProjectDirs(tmp));

  const returned = ensureProjectDirs(tmp);
  assert.deepEqual(returned, projectPaths(tmp));
});

// ---------------------------------------------------------------------------
// The project's own `.cascade/` is not source (shared by the overlay and by the
// plain `git diff` path, so the two can never disagree about a changed file).
// ---------------------------------------------------------------------------

test('ownStateDirRel locates .cascade/ under the analyzed root, and refuses one outside it', () => {
  assert.equal(ownStateDirRel('/repo', '/repo/.cascade'), '.cascade');
  assert.equal(ownStateDirRel('/repo', '/repo/apps/web/.cascade'), 'apps/web/.cascade');
  // Outside the root (a bare `--pack /tmp/x`): there is nothing to exclude, and
  // inventing a prefix would filter real source files.
  assert.equal(ownStateDirRel('/repo', '/elsewhere/.cascade'), null);
  assert.equal(ownStateDirRel('/repo', '/repo'), null, 'the root itself is not a state directory');
  assert.equal(ownStateDirRel('', '/repo/.cascade'), null);
  assert.equal(ownStateDirRel('/repo', ''), null);
});

test('isOwnStatePath matches the directory and what is under it, and nothing that merely starts the same', () => {
  assert.equal(isOwnStatePath('.cascade', '.cascade'), true);
  assert.equal(isOwnStatePath('.cascade/pack/pack.json', '.cascade'), true);
  assert.equal(isOwnStatePath('.cascade/calibration/baseline.json', '.cascade'), true);
  assert.equal(isOwnStatePath('.cascaderc', '.cascade'), false, 'a prefix match is not a directory match');
  assert.equal(isOwnStatePath('src/main/java/A.java', '.cascade'), false);
  // No state directory known: nothing is excluded.
  assert.equal(isOwnStatePath('.cascade/pack/pack.json', null), false);
});

test('withoutOwnState filters exactly those paths, and leaves the order alone', () => {
  const files = ['.cascade/manifest.json', '.cascade/pack/pack.json', 'schema.sql', 'src/main/java/A.java'];
  assert.deepEqual(withoutOwnState(files, '.cascade'), ['schema.sql', 'src/main/java/A.java']);
  assert.deepEqual(withoutOwnState(files, null), files, 'with no state directory the list passes through untouched');
  assert.deepEqual(withoutOwnState(undefined, '.cascade'), []);
});
