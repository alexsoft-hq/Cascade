// dco.test.mjs — the sign-off check, against a real git repository.
//
// The pure half (`signOffs`, `checkCommit`, `checkCommits`) is exercised
// directly; the impure half is exercised by BUILDING a repository in a temp
// directory with commits of each shape — signed, unsigned, signed by somebody
// else — and running the script over it exactly as CI does. A check that has
// only ever been tested against hand-written strings is a check nobody has
// tested against git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signOffs, checkCommit, checkCommits, formatDcoReport } from '../scripts/check-dco.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(ENGINE_ROOT, 'scripts', 'check-dco.mjs');

// Reserved by RFC 2606: an address at example.com is nobody's real address, so
// the fixture can carry one and the internal-coordinates gate stays quiet.
const ALICE = { name: 'Alice Example', email: 'alice@example.com' };
const BOB = { name: 'Bob Example', email: 'bob@example.com' };

/**
 * A git repository with one commit per entry. `signer` null means no trailer.
 * @param {string} dir
 * @param {{author:{name:string,email:string}, signer:({name:string,email:string}|null), subject:string}[]} commits
 * @returns {string[]} the SHAs, oldest first
 */
function buildRepo(dir, commits) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never let the developer's own git identity or hooks leak into the fixture.
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  fs.mkdirSync(dir, { recursive: true });
  git('init', '--quiet', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');

  const shas = [];
  let n = 0;
  for (const c of commits) {
    n += 1;
    fs.writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
    git('add', '-A');
    const message = c.signer
      ? `${c.subject}\n\nSigned-off-by: ${c.signer.name} <${c.signer.email}>\n`
      : `${c.subject}\n`;
    git('-c', `user.name=${c.author.name}`, '-c', `user.email=${c.author.email}`,
      'commit', '--quiet', '--no-verify', '-m', message);
    shas.push(git('rev-parse', 'HEAD').trim());
  }
  return shas;
}

const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });

// ---------------------------------------------------------------------------
// the pure half
// ---------------------------------------------------------------------------

test('signOffs reads every spelling git itself accepts, and nothing that only looks like one', () => {
  assert.deepEqual(signOffs('x\n\nSigned-off-by: A B <a@example.com>\n'), [{ name: 'A B', email: 'a@example.com' }]);
  assert.deepEqual(signOffs('x\n\nsigned-off-by:   A B  <a@example.com>  \n'), [{ name: 'A B', email: 'a@example.com' }]);
  assert.deepEqual(signOffs('x\n\nSIGNED-OFF-BY: A <a@example.com>'), [{ name: 'A', email: 'a@example.com' }]);
  // two trailers -> two entries, in order
  assert.deepEqual(
    signOffs('x\n\nSigned-off-by: A <a@example.com>\nSigned-off-by: B <b@example.com>\n').map((s) => s.email),
    ['a@example.com', 'b@example.com'],
  );
  // prose that merely mentions it is not a trailer
  assert.deepEqual(signOffs('I forgot to add Signed-off-by to this one'), []);
  assert.deepEqual(signOffs('Co-Authored-By: A <a@example.com>'), []);
  assert.deepEqual(signOffs(''), []);
  assert.deepEqual(signOffs(undefined), []);
});

test('checkCommit: the trailer must carry the AUTHOR\'s e-mail, case-insensitively', () => {
  const base = { sha: 'abc', authorName: 'Alice Example', authorEmail: 'alice@example.com' };
  assert.equal(checkCommit({ ...base, body: 'x\n\nSigned-off-by: Alice Example <alice@example.com>\n' }).ok, true);
  // a different spelling of the NAME is fine; the address identifies
  assert.equal(checkCommit({ ...base, body: 'x\n\nSigned-off-by: alice <ALICE@Example.com>\n' }).ok, true);
  // somebody else's sign-off certifies nothing about this commit
  const other = checkCommit({ ...base, body: 'x\n\nSigned-off-by: Bob Example <bob@example.com>\n' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /signed off by <bob@example\.com> but authored by <alice@example\.com>/);
  // ...but a co-signed commit that INCLUDES the author passes
  assert.equal(checkCommit({
    ...base,
    body: 'x\n\nSigned-off-by: Bob Example <bob@example.com>\nSigned-off-by: Alice Example <alice@example.com>\n',
  }).ok, true);
  const none = checkCommit({ ...base, body: 'x\n' });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'no Signed-off-by trailer');
});

test('the report names the offending SHAs and how to fix them', () => {
  const v = checkCommits([
    { sha: '1111111', authorName: 'A', authorEmail: 'a@example.com', body: 'ok\n\nSigned-off-by: A <a@example.com>\n' },
    { sha: '2222222', authorName: 'A', authorEmail: 'a@example.com', body: 'nope\n' },
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.checked, 2);
  const text = formatDcoReport(v);
  assert.match(text, /1 of 2 commit\(s\) are not signed off/);
  assert.match(text, /2222222 {2}no Signed-off-by trailer/);
  assert.equal(text.includes('1111111'), false, 'a passing commit is not listed as a problem');
  assert.match(text, /git commit -s/);
  assert.match(text, /git rebase --signoff/);
  assert.equal(formatDcoReport(checkCommits([])), 'DCO: no commits in range — nothing to check\n');
});

// ---------------------------------------------------------------------------
// against a real repository
// ---------------------------------------------------------------------------

test('a branch whose every commit is signed off exits 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-ok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  buildRepo(dir, [
    { author: ALICE, signer: ALICE, subject: 'base' },
    { author: ALICE, signer: ALICE, subject: 'one' },
    { author: BOB, signer: BOB, subject: 'two' },
  ]);
  const r = run(['--range', 'HEAD~2..HEAD'], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DCO: 2 commit\(s\) signed off/);
});

test('an unsigned commit exits 1 and its SHA is printed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shas = buildRepo(dir, [
    { author: ALICE, signer: ALICE, subject: 'base' },
    { author: ALICE, signer: ALICE, subject: 'signed' },
    { author: ALICE, signer: null, subject: 'forgot the trailer' },
    { author: ALICE, signer: BOB, subject: 'signed by somebody else' },
  ]);
  const r = run(['--range', 'HEAD~3..HEAD', '--json'], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.checked, 3);
  assert.deepEqual(v.failed.map((f) => f.sha).sort(), [shas[2], shas[3]].sort());
  assert.deepEqual(v.commits.filter((c) => c.ok).map((c) => c.sha), [shas[1]]);

  // the human form names both, with the reason each failed
  const human = run(['--range', 'HEAD~3..HEAD'], dir);
  assert.equal(human.status, 1);
  assert.match(human.stdout, new RegExp(`${shas[2]} {2}no Signed-off-by trailer`));
  assert.match(human.stdout, new RegExp(`${shas[3]} {2}signed off by <bob@example\\.com>`));
});

test('--commits checks exactly the SHAs it is given, ignoring the range default', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-commits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shas = buildRepo(dir, [
    { author: ALICE, signer: ALICE, subject: 'signed' },
    { author: ALICE, signer: null, subject: 'unsigned' },
  ]);
  assert.equal(run(['--commits', shas[0]], dir).status, 0);
  const bad = run(['--commits', shas[1]], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, new RegExp(shas[1]));
  assert.equal(run(['--commits', shas[0], shas[1]], dir).status, 1, 'a mixed set fails on the bad one');
});

test('--repo points the check at another directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  buildRepo(dir, [
    { author: ALICE, signer: ALICE, subject: 'base' },
    { author: ALICE, signer: null, subject: 'unsigned' },
  ]);
  const r = run(['--repo', dir, '--range', 'HEAD~1..HEAD'], ENGINE_ROOT);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('a range that cannot be read exits 2 — an unreadable range is not "nothing unsigned"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-norange-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  buildRepo(dir, [{ author: ALICE, signer: ALICE, subject: 'base' }]);
  // No `origin/main` in this repository — the default range cannot resolve.
  const r = run([], dir);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /cannot read the range origin\/main\.\.HEAD/);
  assert.match(r.stderr, /fetch-depth: 0/, 'the message must name the CI mistake it usually is');
});

test('merge commits are skipped: a merge is a join, not a contribution', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-dco-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  buildRepo(dir, [{ author: ALICE, signer: ALICE, subject: 'base' }]);
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '--quiet', '-b', 'side');
  fs.writeFileSync(path.join(dir, 'side.txt'), 'side\n');
  git('add', '-A');
  git('-c', `user.name=${ALICE.name}`, '-c', `user.email=${ALICE.email}`,
    'commit', '--quiet', '-m', `side\n\nSigned-off-by: ${ALICE.name} <${ALICE.email}>\n`);
  git('checkout', '--quiet', 'main');
  fs.writeFileSync(path.join(dir, 'main.txt'), 'main\n');
  git('add', '-A');
  git('-c', `user.name=${ALICE.name}`, '-c', `user.email=${ALICE.email}`,
    'commit', '--quiet', '-m', `main\n\nSigned-off-by: ${ALICE.name} <${ALICE.email}>\n`);
  // The merge itself carries NO trailer. It must not be counted.
  git('-c', `user.name=${ALICE.name}`, '-c', `user.email=${ALICE.email}`,
    'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');

  const r = run(['--range', `${base}..HEAD`, '--json'], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.checked, 2, 'the two real commits, not the merge');
});

test('this repository ships the DCO 1.1 text the check enforces', () => {
  const dco = fs.readFileSync(path.join(ENGINE_ROOT, 'DCO'), 'utf8');
  assert.match(dco, /Developer Certificate of Origin\nVersion 1\.1/);
  assert.match(dco, /Developer's Certificate of Origin 1\.1/);
  for (const clause of ['(a) The contribution was created', '(b) The contribution is based upon',
    '(c) The contribution was provided directly', '(d) I understand and agree']) {
    assert.ok(dco.includes(clause), `the DCO text is missing clause ${clause.slice(0, 3)}`);
  }
});
