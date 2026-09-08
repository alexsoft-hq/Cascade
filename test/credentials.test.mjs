import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  serverKey, parseCredentials, serializeCredentials, isInside,
  setCredential, removeCredential, listCredentials, findPassword, readCredentials,
  credentialsPath, CredentialsError,
} from '../src/core/credentials.mjs';

// The credentials file (SPEC §12.3, §17.3): the ONE place a database password
// is kept, in the tool home, at mode 0600, keyed by server and user.
//
// The rules this file holds are the rules that make such a file acceptable at
// all. A password readable by another account on the machine is not a secret,
// so a widened file is REFUSED rather than used; a password under an analyzed
// project travels with the project, so the home may not resolve inside one; and
// `list` shows what is stored WITHOUT showing the secret, which is the only way
// a reader can audit it.
//
// Every test here points CASCADE_HOME at a temporary directory, so no test ever
// reads or writes the developer's own ~/.cascade/credentials.

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

const SECRET = 'pw-SECRET-123';
const OTHER = 'pw-SECOND-456';
const URL_ONE = 'jdbc:mysql://db.example.com:3306/shop';
const SERVER_ONE = 'mysql://db.example.com:3306/shop';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'cat', GIT_AUTHOR_EMAIL: 'cat@example.com',
  GIT_COMMITTER_NAME: 'cat', GIT_COMMITTER_EMAIL: 'cat@example.com',
};

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-cred-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const env = { ...process.env, CASCADE_HOME: home, XDG_CACHE_HOME: path.join(base, 'cache') };
  delete env.CASCADE_DB_PASSWORD;
  return { base, home, file: path.join(home, 'credentials'), env };
}

/** A registered project, so the "home inside the project" rule has a project. */
function makeProject(base, env) {
  const root = path.join(base, 'shop');
  fs.mkdirSync(path.join(root, 'src', 'main', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main', 'resources', 'application.yml'),
    'spring:\n  datasource:\n    url: jdbc:mysql://db.example.com:3306/shop\n    username: shop_app\n', 'utf8');
  const git = (args) => execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV },
  });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'shop']);
  const r = spawnSync(process.execPath, [CLI, 'init', '--root', root, '--project', 'shop'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

const run = (env, args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
const modeOf = (file) => (fs.statSync(file).mode & 0o777).toString(8);

// ---------------------------------------------------------------------------
// The format, as a value
// ---------------------------------------------------------------------------

test('a server key is dialect, host, port and database — no user and no password', () => {
  assert.equal(serverKey({ dialect: 'mysql', host: 'db.example.com', port: 3306, database: 'shop' }), SERVER_ONE);
  assert.equal(serverKey({ dialect: 'postgres', host: 'pg.example.com', port: 5432, database: 'shop' }),
    'postgres://pg.example.com:5432/shop');
});

test('a password may hold any character, because every line is JSON', () => {
  const wild = 'a:b\\c"d\teé f';
  const text = serializeCredentials([{ server: SERVER_ONE, user: 'shop_app', password: wild }]);
  assert.equal(text.split('\n').filter(Boolean).length, 1, 'one entry is one line');
  const { entries, malformed } = parseCredentials(text);
  assert.deepEqual(malformed, []);
  assert.equal(entries[0].password, wild, 'the password survives the round trip byte for byte');
});

test('a line that is not an entry is REPORTED, never silently dropped', () => {
  const { entries, malformed } = parseCredentials(
    `${JSON.stringify({ server: SERVER_ONE, user: 'a', password: 'x' })}\nnot json\n{"server":"s"}\n`,
  );
  assert.equal(entries.length, 1);
  assert.deepEqual(malformed, [2, 3]);
});

test('isInside is what keeps the file out of an analyzed tree', () => {
  assert.equal(isInside('/p/app/.cascade/home/credentials', '/p/app'), true);
  assert.equal(isInside('/p/app', '/p/app'), true);
  assert.equal(isInside('/somewhere/else/.cascade/credentials', '/p/app'), false);
  // A sibling whose name STARTS with the project's is not inside it.
  assert.equal(isInside('/p/app-notes/credentials', '/p/app'), false);
});

test('credentialsPath follows CASCADE_HOME, which is what lets a test have its own', () => {
  assert.equal(credentialsPath({ CASCADE_HOME: '/tmp/h' }), path.join('/tmp/h', 'credentials'));
});

// ---------------------------------------------------------------------------
// The file, on disk
// ---------------------------------------------------------------------------

test('set creates the file at 0600, and a second entry for the same server under another user is kept', (t) => {
  const { file } = sandbox(t);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  assert.equal(modeOf(file), '600');
  setCredential(file, { server: SERVER_ONE, user: 'reporting', password: OTHER });
  assert.deepEqual(listCredentials(file), [
    { server: SERVER_ONE, user: 'shop_app' },
    { server: SERVER_ONE, user: 'reporting' },
  ]);
  assert.equal(findPassword(file, SERVER_ONE, 'shop_app'), SECRET);
  assert.equal(findPassword(file, SERVER_ONE, 'reporting'), OTHER);
  assert.equal(findPassword(file, SERVER_ONE, 'nobody'), null);
});

test('re-saving a password REPLACES its line instead of leaving the old one behind', (t) => {
  const { file } = sandbox(t);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  const again = setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: OTHER });
  assert.equal(again.replaced, true);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8').includes(SECRET), false, 'the old password is gone from the file');
});

test('remove deletes exactly one entry', (t) => {
  const { file } = sandbox(t);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  setCredential(file, { server: SERVER_ONE, user: 'reporting', password: OTHER });
  assert.deepEqual(removeCredential(file, SERVER_ONE, 'shop_app'), { removed: true, remaining: 1 });
  assert.deepEqual(listCredentials(file), [{ server: SERVER_ONE, user: 'reporting' }]);
  assert.deepEqual(removeCredential(file, SERVER_ONE, 'shop_app'), { removed: false, remaining: 1 });
});

test('a file group or others can read is REFUSED, with the chmod that fixes it', (t) => {
  const { file } = sandbox(t);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  for (const mode of [0o644, 0o640, 0o604]) {
    fs.chmodSync(file, mode);
    assert.throws(() => readCredentials(file), (e) => {
      assert.ok(e instanceof CredentialsError);
      assert.match(e.message, new RegExp(`is mode 0${mode.toString(8)}`));
      assert.match(e.message, /Run: chmod 600 /);
      return true;
    }, `mode 0${mode.toString(8)} must be refused`);
  }
  // …and 0600 is read, so the rule is about the group and other bits and not
  // about refusing everything.
  fs.chmodSync(file, 0o600);
  assert.equal(findPassword(file, SERVER_ONE, 'shop_app'), SECRET);
});

test('a missing file is an empty list, not an error — nobody has saved one yet', (t) => {
  const { file } = sandbox(t);
  assert.deepEqual(readCredentials(file), { entries: [], malformed: [], exists: false });
  assert.deepEqual(listCredentials(file), []);
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

test('cascade catalog credentials set stores one, list shows it, and NEITHER prints the password', (t) => {
  const { base, file, env } = sandbox(t);
  makeProject(base, env);

  const set = run({ ...env, CASCADE_DB_PASSWORD: SECRET }, [
    'catalog', 'credentials', 'set', '--url', URL_ONE, '--user', 'shop_app',
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stderr, /stored the password for mysql:\/\/db\.example\.com:3306\/shop as user shop_app/);
  assert.equal(set.stdout.includes(SECRET), false);
  assert.equal(set.stderr.includes(SECRET), false);
  assert.equal(modeOf(file), '600');
  assert.equal(findPassword(file, SERVER_ONE, 'shop_app'), SECRET);

  const list = run(env, ['catalog', 'credentials', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /credentials in .*credentials \(1\):/);
  assert.match(list.stdout, /mysql:\/\/db\.example\.com:3306\/shop {2}as user shop_app/);
  assert.equal(list.stdout.includes(SECRET), false, 'list must never print a password');
  assert.equal(list.stderr.includes(SECRET), false);
});

test('cascade catalog credentials remove takes one entry away and says how many are left', (t) => {
  const { base, file, env } = sandbox(t);
  makeProject(base, env);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  setCredential(file, { server: SERVER_ONE, user: 'reporting', password: OTHER });

  const r = run(env, ['catalog', 'credentials', 'remove', '--url', URL_ONE, '--user', 'shop_app']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /removed mysql:\/\/db\.example\.com:3306\/shop as user shop_app .*\(1 entry\(ies\) left\)/);
  assert.deepEqual(listCredentials(file), [{ server: SERVER_ONE, user: 'reporting' }]);

  const again = run(env, ['catalog', 'credentials', 'remove', '--url', URL_ONE, '--user', 'shop_app']);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /no entry for mysql:\/\/db\.example\.com:3306\/shop as user shop_app/);
});

test('the command refuses a file that group or others can read, and names the chmod', (t) => {
  const { base, file, env } = sandbox(t);
  makeProject(base, env);
  setCredential(file, { server: SERVER_ONE, user: 'shop_app', password: SECRET });
  fs.chmodSync(file, 0o644);

  const r = run(env, ['catalog', 'credentials', 'list']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is mode 0644, which lets other accounts on this machine read it/);
  assert.match(r.stderr, new RegExp(`Run: chmod 600 ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(r.stderr.includes(SECRET), false);
});

test('a CASCADE_HOME inside the analyzed project is refused, and the refusal says why', (t) => {
  const { base, env } = sandbox(t);
  const root = makeProject(base, env);
  const inside = { ...env, CASCADE_HOME: path.join(root, '.cascade', 'home') };

  for (const args of [
    ['catalog', 'credentials', 'list'],
    ['catalog', 'credentials', 'set', '--url', URL_ONE, '--user', 'shop_app'],
  ]) {
    const r = run({ ...inside, CASCADE_DB_PASSWORD: SECRET }, [...args, '--root', root]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /which is inside the project at/);
    assert.match(r.stderr, /travels with the tree/);
    assert.match(r.stderr, /gitignore stops none of them/);
  }
  assert.equal(fs.existsSync(path.join(root, '.cascade', 'home', 'credentials')), false,
    'nothing may be written under the project');
});

test('credentials with no subcommand prints the three it has', (t) => {
  const { env } = sandbox(t);
  const r = run(env, ['catalog', 'credentials']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cascade catalog credentials list/);
  assert.match(r.stderr, /cascade catalog credentials set/);
  assert.match(r.stderr, /cascade catalog credentials remove/);
});

test('set with no password anywhere and no terminal says what it needed', (t) => {
  const { base, env } = sandbox(t);
  makeProject(base, env);
  const r = run(env, ['catalog', 'credentials', 'set', '--url', URL_ONE, '--user', 'shop_app']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no password to store and no terminal to ask on/);
  assert.match(r.stderr, /CASCADE_DB_PASSWORD/);
});
