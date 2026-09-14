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
import { analysisRecord, publishPack } from '../src/cli/commands/analyze/write.mjs';
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
  assert.deepEqual(r.invocation.mappers, ['mapper-a', 'mapper-b'], 'the lanes sort and de-duplicate mapper roots, so the record does too');
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
