// pack_publish.test.mjs — what a pack records about how it was analyzed, and how it is put on disk.
//
// A base commit is analyzed again from what the current pack recorded, so the
// record has to name the same inputs wherever the checkout sits: a flag typed
// relative to the shell, a folder beside the project in the same repository, a
// frontend outside it. And a server reads a pack with its sidecars, so a sidecar
// must never be read with a pack it was not written for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisRecord, publishPack, writePackAndIndex } from '../src/cli/commands/analyze/write.mjs';
import { compareConditions } from '../src/core/pack_diff.mjs';
import { contentDigestOf, externalSourcesOf } from '../src/cli/external_sources.mjs';
import { Graph } from '../src/core/graph.mjs';
import { HISTORY_KEEP, historyDirOf, listHistory } from '../src/cli/pack_history.mjs';
import { indexOfPack } from '../src/cli/overlay_provider.mjs';
import { emptyIndex } from '../src/core/facts_store.mjs';
import { INCREMENTAL_ENGINE_VERSION } from '../src/core/incremental.mjs';
import { workerVersions } from '../src/core/worker_versions.mjs';

function layout(t) {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-record-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  for (const d of ['repo/service/db', 'repo/service/mapper-b', 'repo/service/mapper-a', 'repo/shared/src', 'repo/templates', 'front/src', 'shell']) {
    fs.mkdirSync(path.join(top, d), { recursive: true });
  }
  return top;
}

const recordOf = (top, flags, selection = {}) => analysisRecord({
  flags, selectionRel: { root: path.join(top, 'repo/service'), ...selection }, optOuts: [], profileDigest: 'p', enginePrintNow: 'e', evidence: [],
  base: { repoPath: path.join(top, 'repo/service'), projectPath: 'service' }, profileFile: null, dotCascade: null, catalogMeta: null, cwd: path.join(top, 'shell'),
});

test('a flag is recorded as the file the run read: relative to the shell it was typed in, then portable', (t) => {
  const top = layout(t);
  const r = recordOf(top, { ddl: ['../repo/service/db'], mappers: ['../repo/service/mapper-b', '../repo/service/mapper-a', '../repo/service/mapper-b'] });
  assert.deepEqual(r.invocation.ddl, ['db'], 'typed from another directory, recorded relative to the project');
  assert.deepEqual(r.invocation.mappers, ['mapper-a', 'mapper-b', 'mapper-b'], 'sorted as the selection sorts them, and kept twice as the selection keeps them, so a replay selects the same');
});

test('a folder beside the project in the same repository is recorded relative, and a checkout outside the repository absolute', (t) => {
  const top = layout(t);
  const r = recordOf(top, { javaSrc: [path.join(top, 'repo/shared/src')], webSrc: [path.join(top, 'front/src')] }, { templateRoots: [{ root: path.join(top, 'repo/templates') }] });
  assert.deepEqual(r.invocation.javaSrc, ['../shared/src'], 'a worktree of the repository has the same folder in the same place');
  assert.deepEqual(r.invocation.webSrc, [path.join(top, 'front/src')], 'outside the repository there is only one of it');
  assert.deepEqual(r.selection.templateRoots, [{ root: '../templates' }], 'a nested root is a path like any other');
  assert.equal(r.selection.root, undefined, 'the checkout\'s own root is not recorded as a condition');
});

test('the DDL order is kept, because it is the order the migrations apply in', (t) => {
  const top = layout(t);
  fs.writeFileSync(path.join(top, 'repo/service/db/2.sql'), '');
  fs.writeFileSync(path.join(top, 'repo/service/db/1.sql'), '');
  const r = recordOf(top, { ddl: ['../repo/service/db/2.sql', '../repo/service/db/1.sql'] });
  assert.deepEqual(r.invocation.ddl, ['db/2.sql', 'db/1.sql']);
});

test('the sidecars name the pack they belong to and the pack goes last, so a reader never takes an index for another build', (t) => {
  const top = layout(t);
  const dir = path.join(top, 'repo/service/.cascade/pack');
  const index = emptyIndex({ project: 'shop', engineVersion: INCREMENTAL_ENGINE_VERSION, workers: workerVersions(), root: top, selection: {} });
  const stale = (msg) => { throw new Error(msg); };
  publishPack(dir, { pack: { digest: 'aaaaaaaaaaaa', meta: {}, nodes: [], edges: [] }, index, routes: '{"routes":1}\n', keep: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'facts-index.json'), 'utf8')).packDigest, 'aaaaaaaaaaaa');
  assert.equal(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'), '{"routes":1}\n', 'the route index is published under the same lock');
  assert.equal(indexOfPack(path.join(dir, 'facts-index.json'), { digest: 'aaaaaaaaaaaa' }, stale).packDigest, 'aaaaaaaaaaaa');
  // A run that died after its sidecars and before its pack: the new index beside the old pack.
  assert.throws(() => indexOfPack(path.join(dir, 'facts-index.json'), { digest: 'bbbbbbbbbbbb' }, stale), /belongs to build aaaaaaaaaaaa, and the pack is build bbbbbbbbbbbb/);
  const legacy = { ...index };
  fs.writeFileSync(path.join(dir, 'facts-index.json'), JSON.stringify(legacy));
  assert.equal(indexOfPack(path.join(dir, 'facts-index.json'), { digest: 'bbbbbbbbbbbb' }, stale).packDigest, undefined, 'an index from before indexes named their pack is read as it is');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-') || n === '.write.lock'), [], 'nothing half-written and no lock left behind');
});

test('the pack is published last and the verdict and receipt after it, all under the lock, and a pack that cannot be written leaves the old one served', (t) => {
  const top = layout(t);
  const dir = path.join(top, 'repo/service/.cascade/pack');
  const index = emptyIndex({ project: 'shop', engineVersion: INCREMENTAL_ENGINE_VERSION, workers: workerVersions(), root: top, selection: {} });
  const seen = [];
  const exists = (name) => fs.existsSync(path.join(dir, name));
  publishPack(dir, {
    pack: { digest: 'aaaaaaaaaaaa', meta: {}, nodes: [], edges: [] }, index, routes: '{}\n', keep: false,
    afterPack: () => seen.push([exists('facts-index.json'), exists('routes.json'), exists('pack.json'), exists('.write.lock')]),
  });
  assert.deepEqual(seen, [[true, true, true, true]], 'sidecars, then the pack, then what certifies it, every step inside the lock');

  // The pack's own rename fails (a directory where the file goes): the index is the
  // new build's, the pack is not replaced, nothing certifies it, and the lock is freed.
  const blocked = path.join(top, 'blocked/.cascade/pack');
  fs.mkdirSync(path.join(blocked, 'pack.json', 'x'), { recursive: true });
  let certified = false;
  assert.throws(() => publishPack(blocked, { pack: { digest: 'bbbbbbbbbbbb', meta: {}, nodes: [], edges: [] }, index, keep: false, afterPack: () => { certified = true; } }));
  assert.equal(certified, false, 'no verdict or receipt is written for a pack that was not published');
  assert.equal(JSON.parse(fs.readFileSync(path.join(blocked, 'facts-index.json'), 'utf8')).packDigest, 'bbbbbbbbbbbb', 'the index went first');
  assert.throws(() => indexOfPack(path.join(blocked, 'facts-index.json'), { digest: 'cccccccccccc' }, (m) => { throw new Error(m); }), /belongs to build bbbbbbbbbbbb/, 'and a reader of the old pack refuses it');
  assert.deepEqual(fs.readdirSync(blocked).filter((n) => n.includes('.tmp-') || n === '.write.lock'), []);
});

test('a rejected run takes the project\'s lock, not one of its own', (t) => {
  const top = layout(t);
  const out = path.join(top, 'repo/service/.cascade/pack');
  const index = emptyIndex({ project: 'shop', engineVersion: INCREMENTAL_ENGINE_VERSION, workers: workerVersions(), root: top, selection: {} });
  let where = null;
  publishPack(`${out}-rejected`, { pack: { digest: 'aaaaaaaaaaaa', meta: {}, nodes: [], edges: [] }, index, keep: false, lockDir: out,
    afterPack: () => { where = [fs.existsSync(path.join(out, '.write.lock')), fs.existsSync(path.join(`${out}-rejected`, '.write.lock'))]; } });
  assert.deepEqual(where, [true, false]);
});

test('the history is held to its size even when certifying the new pack fails, and a half-kept build does not linger', (t) => {
  const top = layout(t);
  const dir = path.join(top, 'repo/service/.cascade/pack');
  const index = emptyIndex({ project: 'shop', engineVersion: INCREMENTAL_ENGINE_VERSION, workers: workerVersions(), root: top, selection: {} });
  const packOf = (i) => ({ digest: String(i).padStart(12, '0'), meta: { builtAt: `2026-09-14T00:00:${String(i).padStart(2, '0')}.000Z`, base: { commit: String(i % 10).repeat(40) } }, nodes: [], edges: [] });
  for (let i = 1; i <= HISTORY_KEEP + 1; i += 1) publishPack(dir, { pack: packOf(i), index, keep: true });
  assert.equal(listHistory(dir).length, HISTORY_KEEP);
  const orphan = path.join(historyDirOf(dir), 'abcdefabcdef-0123456789ab');
  fs.mkdirSync(orphan);
  assert.throws(() => publishPack(dir, { pack: packOf(HISTORY_KEEP + 2), index, keep: true, afterPack: () => { throw new Error('receipt could not be written'); } }), /receipt could not be written/);
  assert.equal(listHistory(dir).length, HISTORY_KEEP, 'pruned all the same');
  assert.equal(fs.existsSync(orphan), false, 'a build directory the index does not list is removed');
});

test('a certified run holds the lock of the project\'s state, so two outputs of one project that share a history take turns', (t) => {
  const top = layout(t);
  const dotCascade = path.join(top, 'repo/service/.cascade');
  const index = emptyIndex({ project: 'shop', engineVersion: INCREMENTAL_ENGINE_VERSION, workers: workerVersions(), root: top, selection: {} });
  let held = null;
  writePackAndIndex({
    g: new Graph(), pack: { digest: 'aaaaaaaaaaaa', meta: { project: 'shop' }, nodes: [], edges: [] }, result: { index }, out: path.join(dotCascade, 'custom'),
    red: false, calibrated: true, gateState: { verdict: 'GREEN' }, calibrationDir: path.join(dotCascade, 'calibration'), gateStateFile: path.join(dotCascade, 'calibration', 'gate-state.json'),
    projectId: 'shop', serviceNames: { names: [] }, otelFiles: [], relOf: (p) => p, lockDir: dotCascade,
    afterPack: () => { held = [fs.existsSync(path.join(dotCascade, '.write.lock')), fs.existsSync(path.join(dotCascade, 'custom', '.write.lock')), fs.existsSync(path.join(dotCascade, 'calibration', 'gate-state.json'))]; },
  });
  assert.deepEqual(held, [true, false, true], 'the state directory\'s lock, with the verdict already written');
});

test('what was read from outside the repository is recorded by content, and a change to it is a difference in conditions', (t) => {
  const top = layout(t);
  fs.writeFileSync(path.join(top, 'front/src/App.vue'), '<template>one</template>');
  fs.mkdirSync(path.join(top, 'front/src/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(top, 'front/src/node_modules/lib.js'), 'x');
  const first = recordOf(top, { webSrc: [path.join(top, 'front/src')] });
  assert.deepEqual(Object.keys(first.external.sources), [path.join(top, 'front/src')], 'only the outside root; paths in the repository are versioned by the commit');
  fs.writeFileSync(path.join(top, 'front/src/node_modules/lib.js'), 'y');
  assert.deepEqual(recordOf(top, { webSrc: [path.join(top, 'front/src')] }).external.sources, first.external.sources, 'node_modules is not read, so it is not counted');
  fs.writeFileSync(path.join(top, 'front/src/App.vue'), '<template>two</template>');
  const second = recordOf(top, { webSrc: [path.join(top, 'front/src')] });
  const pack = (analysis) => ({ digest: 'x', meta: { lanes: ['web'], analysis }, nodes: [], edges: [] });
  assert.deepEqual(compareConditions(pack(first), pack(second)).differences.map((d) => d.what), ['externalSources']);
  assert.deepEqual(compareConditions(pack(first), pack(first)).differences, []);
});

test('an outside input is hashed as a lane reads it: links followed without looping, no project output, no argument taken for a path, no lane that was off', (t) => {
  const top = layout(t);
  const front = path.join(top, 'front/src');
  fs.writeFileSync(path.join(front, 'App.vue'), 'x');
  fs.symlinkSync(front, path.join(front, 'self'));
  assert.match(contentDigestOf(front), /^[0-9a-f]{16}$/, 'a link back into the tree does not loop');
  // The Java lane follows links, so a changed link target is a changed input.
  const shared = path.join(top, 'shared-generated');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'Gen.java'), 'class Gen {}');
  fs.symlinkSync(shared, path.join(front, 'generated'));
  const linked = contentDigestOf(front);
  fs.writeFileSync(path.join(shared, 'Gen.java'), 'class Gen { int x; }');
  assert.notEqual(contentDigestOf(front), linked);
  // The project's own output written under the root after the digest is not an input.
  const settled = contentDigestOf(front);
  fs.mkdirSync(path.join(front, '.cascade', 'pack'), { recursive: true });
  fs.writeFileSync(path.join(front, '.cascade', 'pack', 'pack.json'), '{}');
  assert.equal(contentDigestOf(front), settled);
  const argument = path.join(top, 'audit-schema');
  fs.mkdirSync(argument);
  const sources = externalSourcesOf({ webSrc: [front], noWeb: true, ddl: [] }, { sqlArgs: ['--default-schema', argument], webRoots: [] });
  assert.deepEqual(sources, {}, 'a lane turned off and an argument string are not inputs');
  const locked = path.join(top, 'locked');
  fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
  fs.chmodSync(path.join(locked, 'inner'), 0o000);
  let digest;
  try { digest = contentDigestOf(locked); } finally { fs.chmodSync(path.join(locked, 'inner'), 0o755); }
  if (process.getuid?.() !== 0) assert.equal(digest, 'unreadable');
  const pack = (d) => ({ digest: 'x', meta: { lanes: ['web'], analysis: { external: { sources: { [locked]: d } } } }, nodes: [], edges: [] });
  assert.ok(compareConditions(pack('unreadable'), pack('unreadable')).unknown.includes('externalSources'), 'two unreadable inputs are not taken to agree');
});
