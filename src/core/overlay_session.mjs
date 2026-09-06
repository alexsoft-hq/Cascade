// overlay_session.mjs — the IDENTITY of one working-tree overlay (SPEC §10.2).
//
// An overlay answer is not anchored to a commit: it describes bytes that exist
// only in the editor. So it needs its own anchor, and §10.2 makes two of them
// MUST-carry fields of the result:
//
//   overlaySessionId   what this answer was computed over — the base pack, the
//                      commit it was built at, and the exact content of every
//                      dirty file. Two calls agree iff nothing moved.
//   docVersions        path -> sha256 of the unsaved document, so a reader can
//                      tell WHICH version of the file the answer describes.
//
// And it decides one thing, which is the whole reason the id folds in the base
// commit: if the user COMMITTED since the pack was built, the base no longer
// describes HEAD, so the overlay is DISCARDED rather than laid onto a base that
// has moved underneath it (§10.2 MUST). The caller then answers `behind` and
// says to run `cascade analyze`.
//
// PURE and side-effect free: it reads no file and asks git nothing. The caller
// supplies the commits and the hashes.

import { sha256 } from './canonical.mjs';

export const OVERLAY_SESSION_SCHEMA = 'cascade:overlay-session:1';

/** The overlay is usable. */
export const STATE_FRESH = 'fresh';
/** HEAD moved since the pack was built — §10.2 says discard, do not overlay. */
export const STATE_STALE_COMMIT = 'stale-commit';

/**
 * Identify one overlay session.
 *
 * @param {Object} input
 * @param {string} input.baseDigest   the base pack's content digest
 * @param {string} input.baseCommit   the commit the base pack was built at
 * @param {string|null} input.headCommit  the repository's HEAD right now
 * @param {{path:string, sha256:(string|null)}[]} [input.dirtyFiles]
 *        every file this analysis read that is not what `baseCommit` describes.
 *        A DELETED file has no bytes, so its sha256 is null and it enters the
 *        id as "<path>:absent" — a deletion is a version of the document too,
 *        and two overlays that differ only by one deletion must not share an id.
 *
 *        NOT ONLY THE ANALYZED ROOT'S FILES. `--web-src ../front/src` puts a
 *        frontend BESIDE the backend, often in a repository of its own, and its
 *        files are analysis inputs like any other: they belong in this list,
 *        spelled root-relative with the `../` they need, and they are folded in
 *        exactly like the rest. Filtering them out would give two different
 *        working trees one id, and a memo keyed on that id would answer the
 *        second edit with the first edit's answer. The caller is the one that
 *        has to go and look for them (bin/cascade.mjs), because a file outside
 *        the root is in no diff the root can produce.
 * @returns {{schema:string, overlaySessionId:string, baseCommitDigest:string,
 *            baseCommit:string, headCommit:(string|null),
 *            docVersions:Object<string,(string|null)>, files:string[], state:string}}
 */
export function overlaySession({ baseDigest, baseCommit, headCommit = null, dirtyFiles = [] }) {
  requireString('baseDigest', baseDigest);
  requireString('baseCommit', baseCommit);
  if (!Array.isArray(dirtyFiles)) throw new OverlaySessionError('dirtyFiles must be an array');

  const docVersions = {};
  for (const f of dirtyFiles) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0) {
      throw new OverlaySessionError('every dirty file needs a non-empty path');
    }
    if (f.sha256 != null && typeof f.sha256 !== 'string') {
      throw new OverlaySessionError(`dirty file ${f.path}: sha256 must be a string or null (deleted)`);
    }
    // Last entry wins deliberately: git can report the same path twice (a
    // rename decomposed into D+A), and the WORKING TREE holds one version.
    docVersions[f.path] = f.sha256 ?? null;
  }
  const files = Object.keys(docVersions).sort();
  // Newline-joined, path and version separated by ":" — the parts are a sorted
  // list of (path, hex-or-"absent"), neither of which can contain a newline.
  const material = [baseDigest, baseCommit, ...files.map((p) => `${p}:${docVersions[p] ?? 'absent'}`)].join('\n');

  return {
    schema: OVERLAY_SESSION_SCHEMA,
    overlaySessionId: sha256(material),
    baseCommitDigest: baseDigest,
    baseCommit,
    headCommit: headCommit ?? null,
    docVersions,
    files,
    // A missing HEAD (no git, a repository with no commit) is NOT proof that
    // HEAD still equals the base, so it is stale too — unknown is never treated
    // as unchanged (SPEC §11.1 rule 2, applied to the overlay).
    state: headCommit === baseCommit ? STATE_FRESH : STATE_STALE_COMMIT,
  };
}

/** The short form used in console lines and the viewer. */
export function shortSessionId(id) {
  return typeof id === 'string' ? id.slice(0, 12) : '';
}

function requireString(name, v) {
  if (typeof v !== 'string' || v.length === 0) throw new OverlaySessionError(`${name} must be a non-empty string`);
}

export class OverlaySessionError extends Error {
  constructor(message) { super(message); this.name = 'OverlaySessionError'; }
}
