// repo_identity.test.mjs — whether two packs are one codebase, and the history that gives a project its own base.
//
// The Compare tab once set one registered project against another, and every
// route of one read as added to the other. These hold the three things that stop
// it: the repository rule, the pack history a project compares with itself
// through, and the path re-pointing that keeps a base commit's analysis reading
// that commit's files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRemote, sameRepository } from '../src/core/repo_identity.mjs';
import { HISTORY_KEEP, keepPreviousPack, listHistory, loadHistoryPack, pruneHistory, withPackLock } from '../src/cli/pack_history.mjs';
import { cleanupWorktree, replayFlags, repointPaths } from '../src/cli/base_commit.mjs';

const packAt = (base, project = 'shop', digest = 'd') => ({ digest, meta: { project, builtAt: '2026-09-14T00:00:00.000Z', base }, nodes: [], edges: [] });

test('a remote is the same repository however it is written, a token in it is not kept, and another port is another server', () => {
  for (const u of ['https://github.com/Org/Repo.git', 'ssh://github.com:22/org/repo', 'https://github.com/org/repo/']) {
    assert.equal(normalizeRemote(u), 'github.com/org/repo', u);
  }
  for (const u of ['git@example.com:team/app.git', 'https://user:secret@example.com/team/app/']) {
    assert.equal(normalizeRemote(u), 'example.com/team/app', u);
  }
  assert.equal(normalizeRemote('https://git.example.com:8443/Team/App.git'), 'git.example.com:8443/Team/App', 'a port that is not a default one stays');
  assert.notEqual(normalizeRemote('https://git.example.com:8443/team/app'), normalizeRemote('https://git.example.com:9443/team/app'));
  assert.notEqual(normalizeRemote('https://git.example.com/Team/App'), normalizeRemote('https://git.example.com/team/app'), 'a self-hosted path keeps its case');
  assert.equal(normalizeRemote(''), null);
});

test('the strongest evidence both packs carry decides, and a shallow clone\'s missing root does not', () => {
  const r = (a, b) => { const x = sameRepository(packAt(a, a.project ?? null), packAt(b, b.project ?? null)); return [x.verdict, x.by]; };
  assert.deepEqual(r({ rootCommit: 'a1', remote: 'example.com/x/one' }, { rootCommit: 'a1', remote: 'example.com/y/fork' }), ['same', 'root commit'], 'a fork shares its history');
  // An equal project id alone proves nothing: an old analyzer named every pack "project".
  assert.deepEqual(r({ project: 'project' }, { project: 'project' }), ['unknown', null]);
  assert.deepEqual(r({ rootCommit: 'a1' }, { rootCommit: 'b2' }), ['different', 'root commit']);
  // Shallow clones record no root: the remote decides.
  assert.deepEqual(r({ rootCommit: null, remote: 'example.com/macrozheng/mall' }, { rootCommit: null, remote: 'example.com/jeecgboot/jeecgboot' }), ['different', 'remote']);
  assert.deepEqual(r({ repoPath: '/w/mall' }, { repoPath: '/w/mall' }), ['same', 'path']);
  // Packs built before any of this was recorded: two project ids are two projects.
  assert.deepEqual(r({ repoPath: '/w/mall', project: 'mall' }, { repoPath: '/w/jeecg', project: 'jeecg' }), ['different', 'project id']);
  assert.deepEqual(r({}, {}), ['unknown', null]);
  // A monorepo: one history, two project folders.
  assert.deepEqual(r({ rootCommit: 'a1', projectPath: 'services/order' }, { rootCommit: 'a1', projectPath: 'services/billing' }), ['different', 'project folder']);
  assert.deepEqual(r({ rootCommit: 'a1', projectPath: 'services/order' }, { rootCommit: 'a1', projectPath: 'services/order' }), ['same', 'root commit']);
});

/** A fresh project directory with a pack directory in it. */
function projectDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packDir = path.join(dir, '.cascade', 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  return { dir, packDir, write: (p) => fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(p)) };
}
const digestOf = (i) => String(i).padStart(12, '0');

test('a certified run keeps a copy of the pack it replaces, the newest few, and not a rebuild of the same build', (t) => {
  const { dir, packDir, write } = projectDir(t);
  write(packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(0)));
  assert.equal(keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(0))), null, 'the same build is not kept twice');
  for (let i = 1; i <= HISTORY_KEEP + 2; i += 1) {
    const next = packAt({ commit: String(i).repeat(40), dirty: i === 3 }, 'shop', digestOf(i));
    keepPreviousPack(packDir, next);
    assert.ok(fs.existsSync(path.join(packDir, 'pack.json')), 'keeping copies the served pack, it never moves it');
    write(next);
    pruneHistory(packDir);
  }
  const kept = listHistory(packDir);
  assert.equal(kept.length, HISTORY_KEEP);
  assert.equal(kept[0].digest, digestOf(HISTORY_KEEP + 1), 'newest first');
  assert.ok(!kept.some((e) => e.digest === digestOf(0)), 'the oldest went');
  assert.equal(fs.readdirSync(path.join(dir, '.cascade', 'history')).filter((f) => f !== 'index.json').length, HISTORY_KEEP);
  assert.equal(loadHistoryPack(packDir, { commit: '5555555' }).pack.digest, digestOf(5));
  assert.equal(loadHistoryPack(packDir, { commit: '555' }), null, 'a commit prefix is at least seven characters');
  assert.equal(loadHistoryPack(packDir, { commit: '3333333' }), null, 'a build with uncommitted edits is not that commit');
  assert.equal(loadHistoryPack(packDir, { id: kept.find((e) => e.dirty).id }).entry.dirty, true, 'it is chosen by its id');
});

test('a damaged history index removes nothing outside the history, and is rebuilt from what is there', (t) => {
  const { dir, packDir, write } = projectDir(t);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'keep.txt'), 'source');
  write(packAt({ commit: 'a'.repeat(40) }, 'shop', digestOf(1)));
  keepPreviousPack(packDir, packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  const index = path.join(dir, '.cascade', 'history', 'index.json');
  const forged = { schema: 'cascade:pack-history:1', entries: [null, ...Array.from({ length: 6 }, () => ({ id: '../../src' }))] };
  fs.writeFileSync(index, JSON.stringify(forged));
  pruneHistory(packDir, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'keep.txt'), 'utf8'), 'source', 'an id that is not the shape this module writes is never a path');
  fs.writeFileSync(index, '{ not json');
  assert.deepEqual(listHistory(packDir), [], 'pruned to nothing above, and the rebuilt index agrees with the directories');
  write(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  fs.writeFileSync(index, '{ not json');
  assert.equal(listHistory(packDir).length, 1, 'an unreadable index is rebuilt from the kept directories, not forgotten');
  // A pack that is not what its entry says is not handed out, with the index or without it.
  const keptId = listHistory(packDir)[0].id;
  fs.writeFileSync(path.join(dir, '.cascade', 'history', keptId, 'pack.json'), JSON.stringify(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(9))));
  assert.equal(loadHistoryPack(packDir, { commit: 'bbbbbbb' }), null);
  fs.writeFileSync(index, '{ not json');
  assert.deepEqual(listHistory(packDir), [], 'a directory whose pack lost the digest in its name is not a kept build');
});

test('two runs take turns on the pack lock, and a lock a dead run left is broken', (t) => {
  const { packDir } = projectDir(t);
  const lock = path.join(packDir, '.write.lock');
  fs.writeFileSync(lock, '1');
  assert.throws(() => withPackLock(packDir, () => 'x', { waitMs: 300 }), /another analyze of this project holds/);
  const old = (Date.now() - 20 * 60 * 1000) / 1000;
  fs.utimesSync(lock, old, old);
  const said = [];
  assert.equal(withPackLock(packDir, () => 'ran', { log: (s) => said.push(s) }), 'ran');
  assert.match(said[0], /breaking it/);
  assert.equal(fs.existsSync(lock), false, 'the lock is released after the run');
});

test('a profile path inside the repository is read in the worktree, and one outside it stays where it is', () => {
  const opts = { fromDir: '/r/app/.cascade', toDir: '/tmp/wt/app/.cascade', repoRoot: '/r/app', worktreeRoot: '/tmp/wt/app' };
  const outside = [];
  const doc = repointPaths({
    catalog: { ddl: ['../db/schema.sql'] },
    webRoots: [{ root: '../../app-front/src', kind: 'vue' }],
    templateRoots: [{ root: '/r/app/src/main/webapp' }],
    note: 'just words',
  }, opts, outside);
  assert.deepEqual(doc.catalog.ddl, ['../db/schema.sql'], 'relative and inside: the same spelling, now resolving in the worktree');
  assert.equal(doc.webRoots[0].root, '/r/app-front/src', 'outside the repository: today\'s checkout, by absolute path');
  assert.equal(doc.templateRoots[0].root, '/tmp/wt/app/src/main/webapp', 'absolute and inside: moved into the worktree');
  assert.equal(doc.note, 'just words');
  assert.deepEqual(outside, ['/r/app-front/src']);
});

test('a path spelled through a symlink is still inside the repository, and the base reads it in the worktree', (t) => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-alias-')));
  t.after(() => fs.rmSync(real, { recursive: true, force: true }));
  const repoRoot = path.join(real, 'repo');
  fs.mkdirSync(path.join(repoRoot, 'db'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'db', 'schema.sql'), '');
  const alias = path.join(real, 'alias');
  fs.symlinkSync(repoRoot, alias);
  const outside = [];
  const doc = repointPaths({ ddl: [path.join(alias, 'db', 'schema.sql')] }, { fromDir: path.join(repoRoot, '.cascade'), toDir: '/wt/.cascade', repoRoot, worktreeRoot: '/wt' }, outside);
  assert.deepEqual(doc.ddl, ['/wt/db/schema.sql']);
  assert.deepEqual(outside, []);
});

test('the lane flags the head was analyzed with are replayed at the base, inside paths moved and outside ones listed', () => {
  const outside = [];
  const argv = replayFlags(
    { ddl: ['db/schema.sql'], mappers: ['src/main/resources/mapper'], javaSrc: [], webSrc: ['/elsewhere/front/src'], openapi: [], har: [], otel: [], noJava: true },
    { projectRoot: '/r/app', repoRoot: '/r/app', worktreeRoot: '/tmp/wt' }, outside);
  assert.deepEqual(argv, ['--ddl', '/tmp/wt/db/schema.sql', '--mappers', '/tmp/wt/src/main/resources/mapper', '--web-src', '/elsewhere/front/src', '--no-java']);
  assert.deepEqual(outside, ['/elsewhere/front/src']);
});

test('a worktree git would not remove is an error that says how to remove it, not a success', () => {
  const calls = [];
  const stuck = (_cmd, args) => { calls.push(args.slice(2).join(' ')); return { status: args[2] === 'worktree' && args[3] === 'list' ? 0 : 1, stdout: 'worktree /tmp/wt\n' }; };
  const left = cleanupWorktree({ repoRoot: '/r', worktreeRoot: '/tmp/wt', run: stuck });
  assert.match(left, /still registered in \/r\. Remove it with: git -C \/r worktree remove --force \/tmp\/wt/);
  assert.ok(calls.includes('worktree prune'), 'it tried to prune before giving up');
  const clean = () => ({ status: 0, stdout: 'worktree /r\n' });
  assert.equal(cleanupWorktree({ repoRoot: '/r', worktreeRoot: '/tmp/wt', run: clean }), null);
});
