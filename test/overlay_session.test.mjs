import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  overlaySession, shortSessionId, OVERLAY_SESSION_SCHEMA,
  STATE_FRESH, STATE_STALE_COMMIT, OverlaySessionError,
} from '../src/core/overlay_session.mjs';

// The overlay's identity (SPEC §10.2). Two things are under test:
//   1. the id is a FUNCTION of what the answer was computed over — same inputs,
//      same id; any input moved, different id (so a cache keyed on it cannot
//      serve a stale answer);
//   2. the stale rule: a commit since the pack was built DISCARDS the overlay.

const BASE = { baseDigest: 'abc123def456', baseCommit: 'c'.repeat(40) };
const HEAD = BASE.baseCommit;
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

test('the session carries its schema, the base anchor and the doc versions', () => {
  const s = overlaySession({
    ...BASE, headCommit: HEAD,
    dirtyFiles: [{ path: 'src/B.java', sha256: H2 }, { path: 'src/A.java', sha256: H1 }],
  });
  assert.equal(s.schema, OVERLAY_SESSION_SCHEMA);
  assert.equal(s.baseCommitDigest, BASE.baseDigest);
  assert.equal(s.baseCommit, BASE.baseCommit);
  assert.equal(s.headCommit, HEAD);
  assert.deepEqual(s.docVersions, { 'src/A.java': H1, 'src/B.java': H2 });
  assert.deepEqual(s.files, ['src/A.java', 'src/B.java'], 'files are sorted, so the id does not depend on git ordering');
  assert.equal(s.state, STATE_FRESH);
  assert.match(s.overlaySessionId, /^[0-9a-f]{64}$/);
  assert.equal(shortSessionId(s.overlaySessionId), s.overlaySessionId.slice(0, 12));
});

test('the id is stable under reordering and unchanged bytes', () => {
  const a = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'a', sha256: H1 }, { path: 'b', sha256: H2 }] });
  const b = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'b', sha256: H2 }, { path: 'a', sha256: H1 }] });
  assert.equal(a.overlaySessionId, b.overlaySessionId);
});

test('every input moves the id: base pack, base commit, a file, its content, a deletion', () => {
  const id = (o) => overlaySession({ ...BASE, headCommit: HEAD, ...o }).overlaySessionId;
  const one = id({ dirtyFiles: [{ path: 'a', sha256: H1 }] });
  assert.notEqual(one, id({ baseDigest: 'other-digest', dirtyFiles: [{ path: 'a', sha256: H1 }] }), 'a different base pack is a different session');
  assert.notEqual(one, id({ baseCommit: 'd'.repeat(40), headCommit: 'd'.repeat(40), dirtyFiles: [{ path: 'a', sha256: H1 }] }), 'a different base commit is a different session');
  assert.notEqual(one, id({ dirtyFiles: [{ path: 'a', sha256: H2 }] }), 'edited bytes must not reuse a cached overlay');
  assert.notEqual(one, id({ dirtyFiles: [{ path: 'b', sha256: H1 }] }), 'the same bytes at another path is another session');
  assert.notEqual(one, id({ dirtyFiles: [{ path: 'a', sha256: H1 }, { path: 'b', sha256: H2 }] }), 'one more dirty file is another session');
  assert.notEqual(one, id({ dirtyFiles: [{ path: 'a', sha256: null }] }), 'a DELETED file is a version of the document too');
  assert.notEqual(id({ dirtyFiles: [] }), one, 'a clean tree is not the same session as an edited one');
});

test('a deleted file enters the id as "absent" and its docVersion is null', () => {
  const s = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'gone.java', sha256: null }] });
  assert.equal(s.docVersions['gone.java'], null);
  // "absent" is not a hex digest, so it can never collide with a real content hash.
  const withHash = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'gone.java', sha256: H1 }] });
  assert.notEqual(s.overlaySessionId, withHash.overlaySessionId);
});

test('a frontend OUTSIDE the analyzed root is part of the identity too', () => {
  // `--web-src ../front/src`: the frontend sits beside the backend, often in a
  // repository of its own, and its files are analysis inputs like any other. If
  // they did not enter the id, two successive edits over there would share one
  // session, and a memo keyed on it would answer the second with the first.
  const id = (dirtyFiles) => overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles }).overlaySessionId;
  const OUT = '../front/src/views/Items.vue';
  const first = id([{ path: OUT, sha256: H1 }]);
  assert.notEqual(first, id([{ path: OUT, sha256: H2 }]), 'a second edit to a file beside the root is a second session');
  assert.notEqual(first, id([]), 'an edited frontend is not the same session as a clean one');
  assert.notEqual(first, id([{ path: OUT, sha256: null }]), 'a deleted file beside the root is a version of it too');
  // A backend edit and a frontend edit are different sessions, and a session
  // with both is a third: the id is a function of the whole input set.
  const inRoot = id([{ path: 'src/main/java/A.java', sha256: H1 }]);
  assert.notEqual(first, inRoot);
  assert.notEqual(first, id([{ path: OUT, sha256: H1 }, { path: 'src/main/java/A.java', sha256: H1 }]));

  const s = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: OUT, sha256: H1 }] });
  assert.deepEqual(s.files, [OUT], 'the path is kept as written, `../` and all');
  assert.equal(s.docVersions[OUT], H1);
});

test('a path beside the root and the same name under it are two documents', () => {
  // `../front/src/x.vue` and `front/src/x.vue` are different files on disk, and
  // the id is built from the path as written, so they can never collide.
  const id = (p) => overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: p, sha256: H1 }] }).overlaySessionId;
  assert.notEqual(id('../front/src/x.vue'), id('front/src/x.vue'));
});

test('a commit since the pack was built makes the session stale — §10.2 discards the overlay', () => {
  const s = overlaySession({ ...BASE, headCommit: 'f'.repeat(40), dirtyFiles: [{ path: 'a', sha256: H1 }] });
  assert.equal(s.state, STATE_STALE_COMMIT);
  assert.equal(s.headCommit, 'f'.repeat(40));
});

test('an UNKNOWN head is stale, not fresh — "we could not check" is never "unchanged"', () => {
  const s = overlaySession({ ...BASE, headCommit: null, dirtyFiles: [] });
  assert.equal(s.state, STATE_STALE_COMMIT);
});

test('the same path reported twice keeps the working tree version, not both', () => {
  // git decomposes a rename into D(old) + A(new); a path can therefore arrive
  // twice, and the file on disk is the authority.
  const s = overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'a', sha256: null }, { path: 'a', sha256: H1 }] });
  assert.deepEqual(s.files, ['a']);
  assert.equal(s.docVersions.a, H1);
});

test('bad input throws instead of producing a meaningless anchor', () => {
  assert.throws(() => overlaySession({ baseCommit: 'c', headCommit: 'c' }), OverlaySessionError);
  assert.throws(() => overlaySession({ baseDigest: 'd', headCommit: 'c' }), OverlaySessionError);
  assert.throws(() => overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: 'nope' }), OverlaySessionError);
  assert.throws(() => overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ sha256: H1 }] }), OverlaySessionError);
  assert.throws(() => overlaySession({ ...BASE, headCommit: HEAD, dirtyFiles: [{ path: 'a', sha256: 7 }] }), OverlaySessionError);
});
