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
import { HISTORY_KEEP, archivePreviousPack, listHistory, loadHistoryPack } from '../src/cli/pack_history.mjs';
import { repointPaths } from '../src/cli/base_commit.mjs';

const packAt = (base, project = 'shop', digest = 'd') => ({ digest, meta: { project, builtAt: '2026-09-14T00:00:00.000Z', base }, nodes: [], edges: [] });

test('a remote is the same repository however it is written, and a token in it is not kept', () => {
  for (const u of ['https://example.com/Org/Repo.git', 'git@example.com:org/repo.git', 'ssh://git@example.com:22/org/repo', 'https://user:secret@example.com/org/repo/']) {
    assert.equal(normalizeRemote(u), 'example.com/org/repo', u);
  }
  assert.equal(normalizeRemote(''), null);
});

test('the strongest evidence both packs carry decides, and a shallow clone\'s missing root does not', () => {
  const r = (a, b) => { const x = sameRepository(packAt(a, a.project ?? null), packAt(b, b.project ?? null)); return [x.verdict, x.by]; };
  assert.deepEqual(r({ rootCommit: 'a1', remote: 'example.com/x/one' }, { rootCommit: 'a1', remote: 'example.com/y/fork' }), ['same', 'root commit'], 'a fork shares its history');
  assert.deepEqual(r({ rootCommit: 'a1' }, { rootCommit: 'b2' }), ['different', 'root commit']);
  // Shallow clones record no root: the remote decides.
  assert.deepEqual(r({ rootCommit: null, remote: 'example.com/macrozheng/mall' }, { rootCommit: null, remote: 'example.com/jeecgboot/jeecgboot' }), ['different', 'remote']);
  assert.deepEqual(r({ repoPath: '/w/mall' }, { repoPath: '/w/mall' }), ['same', 'path']);
  // Packs built before any of this was recorded: two project ids are two projects.
  assert.deepEqual(r({ repoPath: '/w/mall', project: 'mall' }, { repoPath: '/w/jeecg', project: 'jeecg' }), ['different', 'project id']);
  assert.deepEqual(r({}, {}), ['unknown', null]);
});

test('a certified run keeps the pack it replaces, the newest few, and not a rebuild of the same build', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packDir = path.join(dir, '.cascade', 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const write = (p) => fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(p));
  write(packAt({ commit: 'c'.repeat(40) }, 'shop', 'd0'));
  assert.equal(archivePreviousPack(packDir, packAt({ commit: 'c'.repeat(40) }, 'shop', 'd0')), null, 'the same build is not kept twice');
  for (let i = 1; i <= HISTORY_KEEP + 2; i += 1) {
    const next = packAt({ commit: String(i).repeat(40), dirty: i === 3 }, 'shop', `d${i}`);
    archivePreviousPack(packDir, next);
    write(next);
  }
  const kept = listHistory(packDir);
  assert.equal(kept.length, HISTORY_KEEP);
  assert.equal(kept[0].digest, `d${HISTORY_KEEP + 1}`, 'newest first');
  assert.ok(!kept.some((e) => e.digest === 'd0'), 'the oldest went');
  assert.equal(fs.readdirSync(path.join(dir, '.cascade', 'history')).filter((f) => f !== 'index.json').length, HISTORY_KEEP);
  assert.equal(loadHistoryPack(packDir, { commit: '5555555' }).pack.digest, 'd5');
  assert.equal(loadHistoryPack(packDir, { commit: '555' }), null, 'a commit prefix is at least seven characters');
  assert.equal(loadHistoryPack(packDir, { commit: '3333333' }).entry.dirty, true);
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
