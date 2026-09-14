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
import { execFileSync } from 'node:child_process';
import { normalizeRemote, sameRepository } from '../src/core/repo_identity.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { HISTORY_KEEP, historyDirOf, keepPreviousPack, listHistory, loadHistoryPack, pruneHistory, withPackLock } from '../src/cli/pack_history.mjs';
import { analyzedTreeOf, basePackAt, cleanupWorktree, copyConventions, replayFlags, repointPaths } from '../src/cli/base_commit.mjs';
import { externalSourcesOf } from '../src/cli/external_sources.mjs';
import { repositoryIdentity } from '../src/cli/commands/analyze/inputs.mjs';

// A pack whose digest is the real digest of its body: the history checks it. `digestOf(i)` names build i.
const BODIES = new Map();
const digestOf = (i) => { const nodes = [{ id: `endpoint:GET /build-${i}` }]; const d = digest12({ nodes, edges: [] }); BODIES.set(d, nodes); return d; };
const packAt = (base, project = 'shop', digest = 'd') => ({ digest, meta: { project, builtAt: '2026-09-14T00:00:00.000Z', base }, nodes: BODIES.get(digest) ?? [], edges: [] });

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
  assert.equal(normalizeRemote('https://github.com:443/org/repo'), 'github.com/org/repo', 'https on its own port');
  assert.equal(normalizeRemote('git://example.com:9418/team/app'), 'example.com/team/app', 'the git protocol on its own port');
  assert.notEqual(normalizeRemote('https://git.example.com:22/team/app'), normalizeRemote('https://git.example.com/team/app'), 'port 22 is ssh\'s, not https\'s');
  assert.notEqual(normalizeRemote('ssh://git.example.com:443/team/app'), normalizeRemote('ssh://git.example.com/team/app'), 'port 443 is https\'s, not ssh\'s');
  assert.equal(normalizeRemote('git@git.example.com:2026/team.git'), normalizeRemote('ssh://git@git.example.com/2026/team.git'), 'a path after the scp colon is a path, even when it starts with digits');
  assert.equal(normalizeRemote('git.example.com:2026/team.git'), 'git.example.com/2026/team', 'with no user too');
  assert.notEqual(normalizeRemote('git.example.com:2026/team.git'), normalizeRemote('ssh://git.example.com:2026/team.git'), 'port 2026 is a port only after a scheme');
  const stored = (remote) => packAt({ remote });
  assert.equal(sameRepository(stored(normalizeRemote('ssh://git.example.com:2026/team')), stored(normalizeRemote('git.example.com:2026/team'))).verdict, 'different', 'a recorded remote is compared as recorded, not normalized twice');
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

test('two runs take turns on the pack lock, and a lock left behind is never broken by a run, however old', (t) => {
  const { packDir } = projectDir(t);
  const lock = path.join(packDir, '.write.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(() => withPackLock(packDir, () => 'x', { waitMs: 300 }), new RegExp(`analyze process ${process.pid} \\(running\\) holds`));
  // Two runs that both judged an old lock abandoned would both break it and both publish.
  const old = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(lock, old, old);
  fs.writeFileSync(lock, '999999');
  assert.throws(() => withPackLock(packDir, () => 'x', { waitMs: 300 }), /\(not running\) holds .*remove the file/);
  fs.rmSync(lock);
  assert.equal(withPackLock(packDir, () => 'ran'), 'ran');
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

test('a worktree git would not remove, or would not list, is an error that says how to remove it, not a success', () => {
  // Git and the file removal are both stand-ins: this test deletes nothing on disk.
  const calls = [];
  const removed = [];
  const rm = (p) => removed.push(p);
  const stuck = (_cmd, args) => { calls.push(args.slice(2).join(' ')); return { status: args[2] === 'worktree' && args[3] === 'list' ? 0 : 1, stdout: 'worktree /nowhere/wt\n' }; };
  const left = cleanupWorktree({ repoRoot: '/r', worktreeRoot: '/nowhere/wt', run: stuck, rm });
  assert.match(left, /may still be registered in \/r\. Remove it with: git -C \/r worktree remove --force \/nowhere\/wt/);
  assert.ok(calls.includes('worktree prune'), 'it tried to prune before giving up');
  assert.deepEqual(removed, ['/nowhere/wt']);
  const blind = () => ({ status: 128, stdout: '' });
  assert.match(cleanupWorktree({ repoRoot: '/r', worktreeRoot: '/nowhere/wt', run: blind, rm }), /may still be registered/, 'a list git could not give proves nothing was removed');
  const clean = () => ({ status: 0, stdout: 'worktree /r\n' });
  assert.equal(cleanupWorktree({ repoRoot: '/r', worktreeRoot: '/nowhere/wt', run: clean, rm }), null);
});

test('a monorepo project is told from its neighbour even when one of the two packs was built before folders were recorded', () => {
  const r = (a, b) => { const v = sameRepository(packAt(a.base, a.project), packAt(b.base, b.project)); return [v.verdict, v.by]; };
  assert.deepEqual(r({ project: 'api', base: { rootCommit: 'a1' } }, { project: 'web', base: { rootCommit: 'a1', projectPath: 'apps/web' } }), ['different', 'project id']);
  assert.deepEqual(r({ project: 'web', base: { rootCommit: 'a1' } }, { project: 'web', base: { rootCommit: 'a1', projectPath: 'apps/web' } }), ['same', 'root commit'], 'the same project across the upgrade');
});

test('the root commit is the one along first parents, so merging in an unrelated history does not make the repository another', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-roots-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'a.txt'), '1');
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  const before = repositoryIdentity(path.join(dir, 'app'), dir);
  git('checkout', '-q', '--orphan', 'vendored'); git('rm', '-q', '-rf', '.');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  git('add', '-A'); git('commit', '-q', '-m', 'other history');
  git('checkout', '-q', 'main'); git('merge', '-q', '--allow-unrelated-histories', '-m', 'merge', 'vendored');
  assert.equal(git('rev-list', '--max-parents=0', 'HEAD').split('\n').length, 2, 'the merge added a second root');
  const after = repositoryIdentity(path.join(dir, 'app'), dir);
  assert.equal(after.rootCommit, before.rootCommit);
  assert.equal(after.projectPath, 'app');
});

test('an index that lists one build twice is rebuilt, and pruning never deletes a build the index keeps', (t) => {
  const { dir, packDir, write } = projectDir(t);
  write(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  const kept = keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  const index = path.join(dir, '.cascade', 'history', 'index.json');
  fs.writeFileSync(index, JSON.stringify({ schema: 'cascade:pack-history:1', entries: Array.from({ length: HISTORY_KEEP + 1 }, () => kept) }));
  pruneHistory(packDir);
  assert.deepEqual(listHistory(packDir).map((e) => e.id), [kept.id], 'the duplicates were not trusted');
  assert.equal(fs.existsSync(path.join(historyDirOf(packDir), kept.id, 'pack.json')), true);
});

test('a commit never names a build whose pack says it was made with uncommitted edits, whatever the index says', (t) => {
  const { dir, packDir, write } = projectDir(t);
  write(packAt({ commit: 'b'.repeat(40), dirty: false }, 'shop', digestOf(2)));
  const kept = keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  const file = path.join(dir, '.cascade', 'history', kept.id, 'pack.json');
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.meta.base.dirty = true;
  fs.writeFileSync(file, JSON.stringify(body));
  assert.equal(loadHistoryPack(packDir, { commit: 'bbbbbbb' }), null);
  fs.rmSync(file);
  assert.equal(loadHistoryPack(packDir, { id: kept.id }), null, 'a build pruned since the index was read is not an error');
});

test('a run whose lock was broken does not remove the lock of the run that broke it', (t) => {
  const { packDir } = projectDir(t);
  const lock = path.join(packDir, '.write.lock');
  withPackLock(packDir, () => fs.writeFileSync(lock, 'another-run'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another-run');
});

test('the base reads no profile when the current pack read none, even when the commit tracks one', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-conv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dotCascade = path.join(root, 'repo', '.cascade');
  const target = path.join(root, 'wt', '.cascade');
  fs.mkdirSync(dotCascade, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(dotCascade, 'manifest.json'), JSON.stringify({ project: 'shop', repositories: [{ path: '..' }] }));
  fs.writeFileSync(path.join(target, 'profile.json'), JSON.stringify({ tracked: 'at that commit' }));
  copyConventions({ dotCascade, target, projectRoot: path.join(root, 'repo'), repoRoot: path.join(root, 'repo'), worktreeRoot: path.join(root, 'wt'), invocation: { profile: null }, commit: 'c'.repeat(40) }, []);
  assert.equal(fs.existsSync(path.join(target, 'profile.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')).repositories[0].commit, 'c'.repeat(40));

  // A profile kept outside the repository is read as it is today, and said to be.
  const external = path.join(root, 'conventions', 'strict.json');
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(external, JSON.stringify({ packagePrefixes: ['com.example'] }));
  const outside = [];
  copyConventions({ dotCascade, target, projectRoot: path.join(root, 'repo'), repoRoot: path.join(root, 'repo'), worktreeRoot: path.join(root, 'wt'), invocation: { profile: external }, commit: 'c'.repeat(40) }, outside);
  assert.deepEqual(outside, [external]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'profile.json'), 'utf8')), { packagePrefixes: ['com.example'] });
});

test('keeping a build that is already kept never removes it, even when the index cannot be written', (t) => {
  const { dir, packDir, write } = projectDir(t);
  write(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  const kept = keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  const index = path.join(dir, '.cascade', 'history', 'index.json');
  fs.rmSync(index);
  fs.mkdirSync(path.join(index, 'blocked'), { recursive: true });
  assert.throws(() => keepPreviousPack(packDir, packAt({ commit: 'd'.repeat(40) }, 'shop', digestOf(4))));
  assert.equal(fs.existsSync(path.join(historyDirOf(packDir), kept.id, 'pack.json')), true, 'the build kept before this call is still there');
});

test('pruning removes only what the history made: a stray build copy and a dead run\'s staging, not a folder somebody put there', (t) => {
  const { packDir, write } = projectDir(t);
  write(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  const history = historyDirOf(packDir);
  const stray = path.join(history, 'abcdefabcdef-0123456789ab');
  const staging = path.join(history, '.staging-abcdefabcdef-0123456789ab-1');
  const theirs = path.join(history, 'fedcbafedcba-0123456789ab');
  for (const d of [stray, staging, theirs]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(stray, 'pack.json'), '{}');
  fs.writeFileSync(path.join(theirs, 'notes.txt'), 'mine');
  pruneHistory(packDir);
  assert.deepEqual([fs.existsSync(stray), fs.existsSync(staging), fs.existsSync(theirs)], [false, false, true]);
  assert.equal(listHistory(packDir).length, 1);
});

test('a kept pack whose body was edited under its old digest is neither handed out nor reused', (t) => {
  const { dir, packDir, write } = projectDir(t);
  write(packAt({ commit: 'b'.repeat(40) }, 'shop', digestOf(2)));
  const kept = keepPreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', digestOf(3)));
  const file = path.join(dir, '.cascade', 'history', kept.id, 'pack.json');
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.nodes.push({ id: 'table:t' });
  fs.writeFileSync(file, JSON.stringify(body));
  assert.equal(loadHistoryPack(packDir, { commit: 'bbbbbbb' }), null);
  keepPreviousPack(packDir, packAt({ commit: 'd'.repeat(40) }, 'shop', digestOf(4)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nodes, BODIES.get(digestOf(2)), 'keeping the same build again restores it from the pack');
});

test('the base is looked up in the tree the pack read, and refused when what it read outside the repository has changed since', (t) => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reproduce-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const tree = path.join(top, 'other');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, 'a.txt'), '1');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'one']]) execFileSync('git', ['-C', tree, ...args], { env, stdio: 'ignore' });
  // The configuration sits in a directory that is not a repository at all.
  const dotCascade = path.join(top, 'mine', '.cascade');
  fs.mkdirSync(path.join(dotCascade, 'pack'), { recursive: true });
  const front = path.join(top, 'front');
  fs.mkdirSync(front);
  fs.writeFileSync(path.join(front, 'App.vue'), 'one');
  const invocation = { webSrc: [front] };
  const head = { meta: { base: { repoPath: tree, ...repositoryIdentity(tree, tree) }, analysis: { invocation, selection: {}, external: { sources: externalSourcesOf(invocation, {}) } } } };
  fs.writeFileSync(path.join(front, 'App.vue'), 'two');
  const die = (msg) => { throw new Error(msg); };
  assert.throws(() => basePackAt({ rev: 'HEAD', dotCascade, packDir: path.join(dotCascade, 'pack'), headPack: head, die }),
    new RegExp(`inputs outside the repository have changed since the current pack was analyzed \\(${front.replace(/[/.]/g, '\\$&')}\\)`),
    'found the commit in the tree the pack read, then refused on the changed frontend');
});

test('a copied project compares in its own checkout, and a pack analyzed with --root elsewhere compares in the tree it read', (t) => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tree-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
  const repoWith = (dir, file) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), file); git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', file); return dir; };
  const a = repoWith(path.join(top, 'a'), 'one.txt');
  const b = path.join(top, 'b');
  execFileSync('git', ['clone', '-q', a, b], { env, stdio: 'ignore' });
  fs.writeFileSync(path.join(b, 'two.txt'), 'two'); git(b, 'add', '-A'); git(b, 'commit', '-q', '-m', 'two');
  const headOf = (repoPath) => ({ meta: { base: { repoPath, ...repositoryIdentity(repoPath, repoPath) } } });
  fs.mkdirSync(path.join(b, '.cascade'));
  assert.equal(analyzedTreeOf(path.join(b, '.cascade'), headOf(a)), b, 'the copy still records the original path, and its own checkout is the same repository: it is used');

  const mine = repoWith(path.join(top, 'mine'), 'mine.txt');
  const other = repoWith(path.join(top, 'other'), 'other.txt');
  fs.mkdirSync(path.join(mine, '.cascade'));
  assert.equal(analyzedTreeOf(path.join(mine, '.cascade'), headOf(other)), other, 'the configuration\'s tree is another repository and the recorded one is the pack\'s');
  assert.equal(analyzedTreeOf(path.join(mine, '.cascade'), headOf(path.join(top, 'gone'))), mine, 'a recorded path that is gone falls back to the configuration\'s tree');
});
