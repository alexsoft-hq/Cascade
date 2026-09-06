import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIncremental, underAny, MODE_COLD, MODE_INCREMENTAL, InvalidateError } from '../src/core/invalidate.mjs';
import { emptyIndex } from '../src/core/facts_store.mjs';
import { buildChangeset, CHANGESET_SCHEMA } from '../src/core/changeset.mjs';

// SPEC §11.2 invalidation, as a rules table. Each case names the rule it pins.

const WORKERS = { java: 'javafacts/2', mybatis: 'mybatis-extract/1', lineage: 'lineage/1', catalog: 'catalog-ddl/1' };
const ENGINE = 'cascade-incremental/1';
const SELECTION = {
  root: '/repo',
  javaRoots: ['mall-admin/src/main/java', 'mall-portal/src/main/java'],
  mapperDirs: ['mall-mbg/src/main/resources/mapper'],
  ddl: 'document/sql/mall.sql',
  sqlArgs: ['--dialect', 'mysql'],
  packagePrefixes: ['com.example'],
};

function indexWith(files = [], extra = {}) {
  const idx = emptyIndex({
    project: 'shop', engineVersion: ENGINE, workers: { ...WORKERS },
    root: SELECTION.root, selection: { ...SELECTION }, base: { commit: 'base0', dirty: false, dirtyFiles: [] },
  });
  for (const f of files) idx.files[f] = { lane: 'java', shardKey: 'a'.repeat(12), sha256: 'b'.repeat(64), lines: 1 };
  return { ...idx, ...extra };
}

/** A changeset the way the CLI hands one over: root-relative paths, status OK. */
function changesetOf(entries) {
  return {
    schema: CHANGESET_SCHEMA, repo: '/repo', status: 'OK', fromCommit: 'base0', toCommit: 'head1',
    files: entries.map(([status, repoPath]) => ({ status, repoPath, srcPath: null })),
  };
}

const plan = (over = {}) => planIncremental({
  index: indexWith(['mall-admin/src/main/java/com/example/A.java', 'mall-admin/src/main/java/com/example/B.java']),
  changeset: changesetOf([]),
  selection: SELECTION, workers: WORKERS, engineVersion: ENGINE,
  ...over,
});

// ---------------------------------------------------------------------------
// when the run must be COLD — and must SAY WHY
// ---------------------------------------------------------------------------

test('cold: --cold was asked for', () => {
  const p = plan({ requestedMode: 'cold' });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /--cold/);
});

test('cold: no previous index — there is nothing to reuse', () => {
  const p = plan({ index: null });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /no previous facts-index\.json/);
});

test('cold: the engine version moved (a mixed-generation graph is not a graph)', () => {
  const p = plan({ index: indexWith([], { engineVersion: 'cascade-incremental/0' }) });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /cascade-incremental\/0 -> cascade-incremental\/1/);
});

test('cold: ANY worker version moved, and the reason names which one (SPEC §17.7)', () => {
  for (const w of Object.keys(WORKERS)) {
    const bumped = { ...WORKERS, [w]: 'bumped/9' };
    const p = plan({ workers: bumped });
    assert.equal(p.mode, MODE_COLD, `${w} bump should force cold`);
    assert.match(p.reason, new RegExp(`the ${w} worker changed`));
  }
});

test('cold: the analyzed root moved', () => {
  const p = plan({ selection: { ...SELECTION, root: '/elsewhere' } });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /analyzed root moved/);
});

test('cold: the lane selection changed — cold and incremental must see the same inputs', () => {
  for (const change of [
    { javaRoots: ['mall-admin/src/main/java'] },
    { mapperDirs: [] },
    { ddl: null },
    { sqlArgs: ['--dialect', 'oracle'] },
    { packagePrefixes: [] },
    // A project that GAINS the web lane is analyzing a different set of inputs
    // than the pack beside it was built from (RM26). Reusing the shards would
    // ship a pack whose axes describe one selection and whose facts come from
    // another, so it takes one cold run and says why.
    { webRoots: ['front/src'] },
  ]) {
    const p = plan({ selection: { ...SELECTION, ...change } });
    assert.equal(p.mode, MODE_COLD, `changing ${Object.keys(change)[0]} should force cold`);
    assert.match(p.reason, /lane selection changed/);
  }
});

test('the web lane\'s roots are part of the selection, and losing one is a change too', () => {
  const withWeb = { ...SELECTION, webRoots: ['admin/src', 'front/src'] };
  const idx = emptyIndex({
    project: 'shop', engineVersion: ENGINE, workers: { ...WORKERS },
    root: SELECTION.root, selection: withWeb, base: { commit: 'base0', dirty: false, dirtyFiles: [] },
  });
  const run = (sel) => planIncremental({
    index: idx, changeset: changesetOf([]), selection: sel, workers: WORKERS, engineVersion: ENGINE,
  });
  // The same roots in a different order are the same selection...
  assert.equal(run({ ...withWeb, webRoots: ['front/src', 'admin/src'] }).mode, MODE_INCREMENTAL);
  // ...and dropping one is not.
  const dropped = run({ ...withWeb, webRoots: ['front/src'] });
  assert.equal(dropped.mode, MODE_COLD);
  assert.match(dropped.reason, /lane selection changed/);
});

test('cold: selection field ORDER is not a change (the comparison is canonical)', () => {
  const p = plan({ selection: { ...SELECTION, javaRoots: [...SELECTION.javaRoots].reverse() } });
  assert.equal(p.mode, MODE_INCREMENTAL);
});

test('cold: an UNKNOWN changeset is never an empty list (SPEC §11.1 rule 2)', () => {
  const unknown = buildChangeset({ repo: '/repo', fromCommit: null, toCommit: 'head1' });
  const p = plan({ changeset: unknown });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /changeset is UNKNOWN/);
  assert.match(p.reason, /previous pin unknown/);
  assert.deepEqual(p.reparseJava, [], 'a cold plan carries no partial reparse list to be mistaken for one');
});

test('cold: no changeset at all is UNKNOWN too, not "nothing changed"', () => {
  const p = plan({ changeset: null });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /changeset is UNKNOWN/);
});

test('planIncremental refuses to run without a selection, workers or engine version', () => {
  assert.throws(() => planIncremental({}), InvalidateError);
  assert.throws(() => planIncremental({ selection: SELECTION }), InvalidateError);
  assert.throws(() => planIncremental({ selection: SELECTION, workers: WORKERS }), InvalidateError);
});

// ---------------------------------------------------------------------------
// the invalidation rules themselves
// ---------------------------------------------------------------------------

test('a changed java file under a java root reparses THAT FILE ONLY', () => {
  const p = plan({ changeset: changesetOf([['M', 'mall-admin/src/main/java/com/example/A.java']]) });
  assert.equal(p.mode, MODE_INCREMENTAL);
  assert.deepEqual(p.reparseJava, ['mall-admin/src/main/java/com/example/A.java']);
  assert.deepEqual(p.dropJava, []);
  assert.equal(p.reuse.java, 1, 'the other indexed file is reused');
  assert.equal(p.sqlChanged, false);
  assert.equal(p.catalogChanged, false);
});

test('an ADDED java file is a reparse even though it has no shard yet', () => {
  const p = plan({ changeset: changesetOf([['A', 'mall-portal/src/main/java/com/example/New.java']]) });
  assert.deepEqual(p.reparseJava, ['mall-portal/src/main/java/com/example/New.java']);
  assert.equal(p.reuse.java, 2);
});

test('a DELETED java file drops its shard and is not reparsed', () => {
  const p = plan({ changeset: changesetOf([['D', 'mall-admin/src/main/java/com/example/A.java']]) });
  assert.deepEqual(p.dropJava, ['mall-admin/src/main/java/com/example/A.java']);
  assert.deepEqual(p.reparseJava, []);
  assert.equal(p.reuse.java, 1);
});

test('a RENAME reaches here already decomposed into delete+add (SPEC §11.1 rule 3)', () => {
  const raw = ['R100', 'mall-admin/src/main/java/com/example/A.java', 'mall-admin/src/main/java/com/example/Z.java', '']
    .join(String.fromCharCode(0));
  const cs = buildChangeset({ repo: '/repo', fromCommit: 'base0', toCommit: 'head1', rawNameStatusZ: raw });
  const p = plan({ changeset: cs });
  assert.deepEqual(p.dropJava, ['mall-admin/src/main/java/com/example/A.java']);
  assert.deepEqual(p.reparseJava, ['mall-admin/src/main/java/com/example/Z.java']);
});

test('a java file OUTSIDE every source root is not our business', () => {
  const p = plan({ changeset: changesetOf([['M', 'tools/scratch/Thing.java'], ['M', 'mall-admin/src/test/Foo.java']]) });
  assert.deepEqual(p.reparseJava, []);
  assert.equal(p.reuse.java, 2);
});

test('a non-java file under a java root changes nothing in the java lane', () => {
  const p = plan({ changeset: changesetOf([['M', 'mall-admin/src/main/java/com/example/notes.txt']]) });
  assert.deepEqual(p.reparseJava, []);
});

test('ANY changed mapper xml marks the statement set changed (the include index is global)', () => {
  const p = plan({ changeset: changesetOf([['M', 'mall-mbg/src/main/resources/mapper/PmsProductMapper.xml']]) });
  assert.equal(p.sqlChanged, true);
  assert.equal(p.catalogChanged, false);
  assert.deepEqual(p.reparseJava, [], 'a mapper edit does not reparse java');
});

test('a changed DDL marks the catalog changed (every lineage key carries its digest)', () => {
  const p = plan({ changeset: changesetOf([['M', 'document/sql/mall.sql']]) });
  assert.equal(p.catalogChanged, true);
  assert.equal(p.sqlChanged, false);
});

test('untracked files in the analyzed roots count as ADDED', () => {
  const p = plan({ untracked: ['mall-admin/src/main/java/com/example/Untracked.java', 'notes.md'] });
  assert.deepEqual(p.reparseJava, ['mall-admin/src/main/java/com/example/Untracked.java']);
});

// ---------------------------------------------------------------------------
// the dirty-tree hole, closed
// ---------------------------------------------------------------------------

test('a file the PREVIOUS run read dirty is re-read: git cannot diff a state no commit held', () => {
  const idx = indexWith(['mall-admin/src/main/java/com/example/A.java', 'mall-admin/src/main/java/com/example/B.java'], {});
  idx.base = { commit: 'base0', dirty: true, dirtyFiles: ['mall-admin/src/main/java/com/example/B.java'] };
  const p = plan({ index: idx, changeset: changesetOf([]) });
  assert.deepEqual(p.reparseJava, ['mall-admin/src/main/java/com/example/B.java']);
  assert.equal(p.reuse.java, 1);
  assert.match(p.notes.join(' '), /dirty when the previous pack was built/);
});

test('a previously-dirty UNTRACKED file that has since been deleted is DROPPED, not reparsed', () => {
  const idx = indexWith(['mall-admin/src/main/java/com/example/A.java', 'mall-admin/src/main/java/com/example/Gone.java']);
  idx.base = { commit: 'base0', dirty: true, dirtyFiles: ['mall-admin/src/main/java/com/example/Gone.java'] };
  const p = plan({
    index: idx, changeset: changesetOf([]),
    stillExists: (f) => !f.endsWith('Gone.java'),
  });
  assert.deepEqual(p.dropJava, ['mall-admin/src/main/java/com/example/Gone.java']);
  assert.deepEqual(p.reparseJava, []);
});

test('a previously-dirty mapper or DDL re-invalidates its lane too', () => {
  const idx = indexWith([]);
  idx.base = { commit: 'base0', dirty: true, dirtyFiles: ['mall-mbg/src/main/resources/mapper/X.xml', 'document/sql/mall.sql'] };
  const p = plan({ index: idx, changeset: changesetOf([]) });
  assert.equal(p.sqlChanged, true);
  assert.equal(p.catalogChanged, true);
});

test('deleting a file that carried no facts is a stated no-op, not a silent one', () => {
  const p = plan({ changeset: changesetOf([['D', 'mall-admin/src/main/java/com/example/package-info.java']]) });
  assert.match(p.notes.join(' '), /had no shard in the previous index/);
});

// ---------------------------------------------------------------------------
// underAny
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the web lane (RM29)
// ---------------------------------------------------------------------------

const WEB_SELECTION = { ...SELECTION, webRoots: ['front/src'] };
const webIndex = () => {
  const idx = indexWith(['mall-admin/src/main/java/com/example/A.java']);
  idx.selection = { ...WEB_SELECTION };
  idx.files['front/src/api/items.js'] = { lane: 'web', shardKey: 'c'.repeat(12), sha256: 'd'.repeat(64), lines: 4 };
  idx.files['front/src/views/List.vue'] = { lane: 'web', shardKey: 'e'.repeat(12), sha256: 'f'.repeat(64), lines: 2 };
  return idx;
};
const webPlan = (over = {}) => planIncremental({
  index: webIndex(), changeset: changesetOf([]),
  selection: WEB_SELECTION, workers: WORKERS, engineVersion: ENGINE,
  ...over,
});

test('a changed frontend file under a web root is reparsed; a deleted one is dropped', () => {
  const p = webPlan({ changeset: changesetOf([['M', 'front/src/api/items.js'], ['D', 'front/src/views/List.vue']]) });
  assert.equal(p.mode, MODE_INCREMENTAL);
  assert.deepEqual(p.reparseWeb, ['front/src/api/items.js']);
  assert.deepEqual(p.dropWeb, ['front/src/views/List.vue']);
  assert.deepEqual(p.reparseJava, [], 'a frontend edit costs the java lane nothing');
  assert.equal(p.reuse.web, 0, 'both web shards were claimed by this change');
  assert.equal(p.reuse.java, 1, 'and the java shard is untouched');
});

test('a .d.ts, a test file and a frontend file outside every web root are not this lane\'s business', () => {
  const p = webPlan({
    changeset: changesetOf([
      ['M', 'front/src/types/thing.d.ts'],
      ['M', 'front/src/api/items.test.js'],
      ['M', 'elsewhere/app.js'],
    ]),
  });
  assert.deepEqual(p.reparseWeb, []);
  assert.equal(p.reuse.web, 2, 'both web shards stay reusable');
});

test('a package config file sets webConfigChanged and invalidates NO shard', () => {
  for (const f of ['front/package.json', 'front/.env.development', 'front/vite.config.ts', 'front/vue.config.js', 'front/tsconfig.json', 'front/jsconfig.json']) {
    const p = webPlan({ changeset: changesetOf([['M', f]]) });
    assert.equal(p.webConfigChanged, true, `${f} must be recognised as package configuration`);
    assert.deepEqual(p.reparseWeb, [], `${f} must not force a source file to be re-read`);
    assert.equal(p.reuse.web, 2);
  }
  assert.equal(webPlan({ changeset: changesetOf([['M', 'front/src/api/items.js']]) }).webConfigChanged, false);
});

test('a frontend file the PREVIOUS run read dirty is re-read, and dropped when it is gone', () => {
  const idx = webIndex();
  idx.base = { commit: 'base0', dirty: true, dirtyFiles: ['front/src/api/items.js', 'front/src/views/List.vue'] };
  const p = planIncremental({
    index: idx, changeset: changesetOf([]), selection: WEB_SELECTION,
    workers: WORKERS, engineVersion: ENGINE,
    stillExists: (f) => f !== 'front/src/views/List.vue',
  });
  assert.deepEqual(p.reparseWeb, ['front/src/api/items.js']);
  assert.deepEqual(p.dropWeb, ['front/src/views/List.vue']);
});

test('gaining a web root is a different selection, so the run is cold and says so', () => {
  const p = planIncremental({
    index: indexWith(['mall-admin/src/main/java/com/example/A.java']),
    changeset: changesetOf([]), selection: WEB_SELECTION, workers: WORKERS, engineVersion: ENGINE,
  });
  assert.equal(p.mode, MODE_COLD);
  assert.match(p.reason, /lane selection changed/);
});

test('underAny: prefix matching is on path SEGMENTS, not on characters', () => {
  assert.equal(underAny('src/main/java/A.java', ['src/main/java']), true);
  assert.equal(underAny('src/main/java', ['src/main/java']), true);
  assert.equal(underAny('src/main/javascript/a.java', ['src/main/java']), false);
  assert.equal(underAny('anything', ['']), true, 'the root itself contains everything');
  assert.equal(underAny('anything', ['.']), true);
  assert.equal(underAny('a.java', []), false);
});
