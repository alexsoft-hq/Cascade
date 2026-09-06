import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNameStatusZ,
  buildChangeset,
  changedFiles,
  CHANGESET_SCHEMA,
  STATUS_UNKNOWN,
  ChangesetError,
} from '../src/core/changeset.mjs';

// The git `-z` format is NUL-separated. Build the delimiter with
// String.fromCharCode(0) — never a literal NUL byte in the source file,
// or git will treat this file as binary and hide its diffs.
const N = String.fromCharCode(0);

test('parseNameStatusZ: parses A/M/D records into {status, path}, sorted by path', () => {
  const raw = ['M', 'a.java', 'A', 'b.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.deepEqual(out, [
    { status: 'M', path: 'a.java' },
    { status: 'A', path: 'b.java' },
  ]);
});

test('parseNameStatusZ: sorts by path first', () => {
  const raw = ['D', 'z.java', 'A', 'a.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.deepEqual(out.map((f) => f.path), ['a.java', 'z.java']);
});

test('Rule 3: an R100 rename record decomposes into D(old) + A(new), no R status remains', () => {
  const raw = ['R100', 'old.java', 'new.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.equal(out.length, 2);
  assert.ok(out.some((f) => f.status === 'D' && f.path === 'old.java'), 'missing D(old.java)');
  assert.ok(out.some((f) => f.status === 'A' && f.path === 'new.java'), 'missing A(new.java)');
  assert.ok(!out.some((f) => f.status === 'R'), 'no R status should remain');
});

test('a C (copy) record produces only an add of the new path — old file is kept, no delete', () => {
  const raw = ['C100', 'orig.java', 'copy.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.deepEqual(out, [{ status: 'A', path: 'copy.java' }]);
});

test('a T (type change) record is treated as M', () => {
  const raw = ['T', 'file.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.deepEqual(out, [{ status: 'M', path: 'file.java' }]);
});

test('truncated stream: an R record missing its new-path field throws ChangesetError', () => {
  // Only status + old path present, no new path and no trailing NUL.
  const raw = ['R100', 'old.java'].join(N);
  assert.throws(() => parseNameStatusZ(raw), ChangesetError);
});

test('truncated stream: an A record missing its path field throws ChangesetError', () => {
  const raw = 'A';
  assert.throws(() => parseNameStatusZ(raw), ChangesetError);
});

test('unknown status code throws ChangesetError', () => {
  const raw = ['X', 'file.java', ''].join(N);
  assert.throws(() => parseNameStatusZ(raw), ChangesetError);
});

test('non-ASCII path round-trips through the NUL split intact', () => {
  const raw = ['A', '한글파일.java', ''].join(N);
  const out = parseNameStatusZ(raw);
  assert.deepEqual(out, [{ status: 'A', path: '한글파일.java' }]);
});

test('Rule 2: buildChangeset with fromCommit null → UNKNOWN status, files null', () => {
  const cs = buildChangeset({ repo: 'r', fromCommit: null, toCommit: 'HEAD', rawNameStatusZ: 'A' + N + 'x' + N });
  assert.equal(cs.status, STATUS_UNKNOWN);
  assert.equal(cs.files, null);
  assert.equal(cs.schema, CHANGESET_SCHEMA);
});

test('Rule 2: buildChangeset with rawNameStatusZ null → UNKNOWN status, files null', () => {
  const cs = buildChangeset({ repo: 'r', fromCommit: 'abc123', toCommit: 'HEAD', rawNameStatusZ: null });
  assert.equal(cs.status, STATUS_UNKNOWN);
  assert.equal(cs.files, null);
});

test('buildChangeset happy path: repoPath and sourceRoot-relative srcPath are both emitted', () => {
  const raw = ['A', 'src/main/java/com/x/Foo.java', 'M', 'README.md', ''].join(N);
  const cs = buildChangeset({
    repo: 'r',
    fromCommit: 'a',
    toCommit: 'b',
    rawNameStatusZ: raw,
    sourceRoot: 'src/main/java',
  });
  assert.equal(cs.status, 'OK');
  const foo = cs.files.find((f) => f.repoPath === 'src/main/java/com/x/Foo.java');
  assert.ok(foo, 'expected Foo.java entry');
  assert.equal(foo.srcPath, 'com/x/Foo.java');

  const readme = cs.files.find((f) => f.repoPath === 'README.md');
  assert.ok(readme, 'expected README.md entry');
  assert.equal(readme.srcPath, null);
});

test('changedFiles throws ChangesetError on an UNKNOWN changeset (Rule 2 safety invariant)', () => {
  const cs = buildChangeset({ repo: 'r', fromCommit: null, toCommit: 'HEAD' });
  assert.throws(() => changedFiles(cs), ChangesetError);
});

test('changedFiles returns the files array on an OK changeset', () => {
  const raw = ['A', 'x.java', ''].join(N);
  const cs = buildChangeset({ repo: 'r', fromCommit: 'a', toCommit: 'b', rawNameStatusZ: raw });
  const files = changedFiles(cs);
  assert.equal(files, cs.files);
  assert.deepEqual(files.map((f) => f.repoPath), ['x.java']);
});
