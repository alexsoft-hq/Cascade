// overlay_inputs.mjs — the inputs a base pack was built from, recorded by `analyze` and checked by the overlay.
//
// ONE RULE (review 3, design 7). The working-tree overlay lays the edited files
// over the inputs the base pack was built from. Some of those inputs are no file
// a diff of the analyzed root reports: the profile, a DDL or a snapshot kept
// outside the root or in `.cascade/`, a frontend in a repository of its own.
// Read again silently, a change to one of them lands in the answer as if the
// edit had made it. So each is compared with what the run read:
//
//   the profile        its digest, which the pack records; another one declines
//   the catalog        the key of the catalog shard the run wrote, computed from
//                      the files as they are now; another key declines
//   a frontend repo    the commit the run read it at, recorded beside the fact
//                      index; one that moved on is behind, as a moved backend is.
//                      A file there that differed from that commit when the run
//                      read it is one of the pack's dirty files, so the overlay
//                      reads it again, and sees it when the edit is undone
//
// and what they are now goes into the overlay session id, so a server that
// memoizes an overlay does not answer from one built over the old inputs.
//
// The recording is here too (`overlayInputsRecord`), so what `analyze` writes
// and what the overlay reads cannot be two spellings of one thing.

import fs from 'node:fs';
import path from 'node:path';
import { profileDigestOf } from '../core/calibration.mjs';
import { catalogShardKey } from '../core/facts_store.mjs';
import { sqlLaneArgs } from '../core/lanes.mjs';
import { normalizeProfile } from '../core/profile.mjs';
import { workerVersions } from '../core/worker_versions.mjs';
import { underAny } from '../core/invalidate.mjs';
import { gitText, realPath, splitZ } from './env.mjs';
import { safeHash } from './state.mjs';

/** A repository's HEAD, or null when the directory is in none. */
function headOf(dirAbs) {
  if (!fs.existsSync(dirAbs)) return null;
  return ((gitText(dirAbs, ['rev-parse', 'HEAD']) ?? '').trim()) || null;
}

/** The top of the repository a directory is in, or null. */
function topOf(dirAbs) {
  if (!fs.existsSync(dirAbs)) return null;
  const top = ((gitText(dirAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
  return top ? realPath(top) : null;
}

/**
 * The frontend roots a diff of the analyzed root cannot see: those outside it
 * (`--web-src ../front/src`), and those inside it that are a repository of
 * their own (review 4, O-3), each with the top of the repository it is in,
 * null when it is in none. A root in the analyzed root's own repository is not
 * one of them unless it lies outside the root.
 */
function webRootsOfTheirOwn(rootAbs, webRoots) {
  const rootTop = topOf(rootAbs);
  const out = [];
  for (const rel of webRoots ?? []) {
    const outside = rel.startsWith('../');
    const top = topOf(path.resolve(rootAbs, rel));
    if (!outside && (top === null || top === rootTop)) continue;
    out.push({ rel, top, ownRepository: top !== null && top !== rootTop });
  }
  return out;
}

/**
 * WHAT `analyze` RECORDS beside the fact index for the overlay: the directory
 * the profile's relative paths are resolved against (the project's `.cascade`,
 * as the run resolved `mappers.alternatives` and `tsBackend.prismaSchema`), and
 * for each frontend root in a repository other than the analyzed root's (outside
 * the root, or nested in it), the commit the run read it at (null when it is in
 * none).
 *
 * @param {{rootAbs:string, webRoots:string[], manifestDir:(string|null)}} a
 *        webRoots as the selection records them, relative to the root
 */
export function overlayInputsRecord({ rootAbs, webRoots, manifestDir }) {
  const webRepositories = webRootsOfTheirOwn(rootAbs, webRoots)
    .filter((r) => r.top === null || r.ownRepository)
    .map((r) => ({ root: r.rel, commit: r.top === null ? null : headOf(path.resolve(rootAbs, r.rel)) }));
  return { manifestDir: manifestDir ?? null, ...(webRepositories.length > 0 ? { webRepositories } : {}) };
}

/**
 * THE FILES UNDER THOSE FRONTEND ROOTS THAT DIFFER FROM THE HEAD OF THE
 * REPOSITORY THEY ARE IN (edited, deleted, or new), as paths relative to the
 * analyzed root (`../front/src/api/orders.js`). A diff of the analyzed root
 * cannot report them: another repository shares no commit with it, and a file
 * git has never seen is listed only for the directory the command runs in.
 * `analyze` records them as the pack's dirty files (the pack read a working
 * tree, not a commit), and the overlay reads them as edited.
 *
 * @param {{rootAbs:string, webRoots:string[]}} a  webRoots relative to the root
 * @returns {string[]} sorted
 */
export function webRepositoryChanges({ rootAbs, webRoots }) {
  const out = new Set();
  for (const { rel, top } of webRootsOfTheirOwn(rootAbs, webRoots)) {
    if (top === null) continue;
    const dirAbs = path.resolve(rootAbs, rel);
    const toRel = (repoRelPath) => path.relative(rootAbs, path.resolve(top, repoRelPath)).split(path.sep).join('/');
    const names = [
      ...splitZ(gitText(dirAbs, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])),
      ...splitZ(gitText(dirAbs, ['diff', '--name-only', '-z', 'HEAD', '--'])),
    ].map(toRel);
    for (const p of names) if (underAny(p, [rel])) out.add(p);
  }
  return [...out].sort();
}

/**
 * The directory the profile's relative paths are resolved against, as the run
 * resolved them: the one it recorded, or the root when it had no `.cascade`.
 * An index written before it was recorded falls back to the directory the
 * profile sits in, the project's `.cascade` in the usual layout.
 */
export function manifestDirOf(idx, packDir, pack) {
  if (idx?.overlayInputs) return idx.overlayInputs.manifestDir ?? idx.root;
  const file = pack?.meta?.profile;
  return typeof file === 'string' ? path.dirname(file) : path.dirname(packDir);
}

/** The profile as the run digested it: the served profile, or the defaults when there is no file. */
function profileNow(pack, profile, rootAbs) {
  const digest = profileDigestOf(profile ?? normalizeProfile({}));
  const recorded = pack?.meta?.analysis?.profileDigest ?? null;
  if (recorded === null || recorded === digest) return { digest, declined: null };
  const file = typeof pack?.meta?.profile === 'string' ? pack.meta.profile : null;
  const named = file ? path.relative(rootAbs, file).split(path.sep).join('/') : 'the documented defaults';
  return {
    digest,
    declined: `the profile (${named}) is not the one this pack was built with: it changed since, or this engine reads it differently. `
      + 'The overlay builds from the pack\'s inputs, and over another profile a changed prefix, alternative or convention would read as your edit',
  };
}

/** Which of the catalog files differ from the hashes the pack recorded, or all of them when it recorded none. */
function changedCatalogFiles(pack, files) {
  const meta = pack?.meta?.catalog ?? {};
  const recorded = meta.source === 'snapshot' ? [meta.sha256] : (meta.paths ?? []).map((p) => p.sha256);
  const changed = files.filter((f, i) => recorded.length !== files.length || safeHash(f.abs) !== recorded[i]);
  return (changed.length > 0 ? changed : files).map((f) => f.rel);
}

/**
 * The catalog the run read, as a key computed from the files now; a key other
 * than the one the run wrote is a catalog input that moved: a DDL outside the
 * root, one the diff did not report, or a snapshot fetched again.
 */
function catalogNow({ idx, pack, catalogIn }) {
  const wrote = idx?.catalog?.shardKey ?? null;
  if (!wrote || catalogIn.files.length === 0) return { key: null, declined: null };
  const key = catalogShardKey({
    files: catalogIn.files.map((f) => ({ path: f.rel, contentSha256: safeHash(f.abs) ?? 'absent' })),
    workerVersion: workerVersions().catalog,
    args: catalogIn.shardArgs,
  });
  if (key === wrote) return { key, declined: null };
  const what = catalogIn.fromSnapshot ? 'the pinned catalog snapshot' : 'the schema file(s)';
  return {
    key,
    declined: `${what} ${changedCatalogFiles(pack, catalogIn.files).join(', ')} changed since this pack was built, and a moved column changes what every statement resolves to`,
  };
}

/** Each frontend repository the run recorded, and whether it is still at that commit. */
function frontsNow(idx, rootAbs) {
  const heads = {};
  const moved = [];
  const unversioned = [];
  for (const r of idx?.overlayInputs?.webRepositories ?? []) {
    if (r.commit === null) { unversioned.push(r.root); continue; }
    const now = headOf(path.resolve(rootAbs, r.root));
    heads[r.root] = now;
    if (now !== r.commit) moved.push(`the frontend repository at ${r.root} is at ${(now ?? 'no commit').slice(0, 12)} and this pack read it at ${r.commit.slice(0, 12)}`);
  }
  return { heads, moved, unversioned };
}

/**
 * THE BASE PACK'S INPUTS, AS THEY ARE NOW: what goes into the session id, and
 * the verdict. `stale` discards the overlay the way a moved HEAD does;
 * `declined` refuses it with the reason; `limits` are said on an answer that is
 * laid all the same.
 *
 * @param {{idx:object, pack:object, profile:(object|null), rootAbs:string,
 *          catalogIn:{files:{rel:string, abs:string}[], shardArgs:string[], fromSnapshot:boolean}}} a
 * @returns {{fingerprint:object, stale:(string|null), declined:(string|null), limits:object[]}}
 */
export function baseInputsNow({ idx, pack, profile, rootAbs, catalogIn }) {
  const prof = profileNow(pack, profile, rootAbs);
  const cat = prof.declined ? { key: null, declined: null } : catalogNow({ idx, pack, catalogIn });
  const fronts = frontsNow(idx, rootAbs);
  const limits = fronts.unversioned.length === 0 ? [] : [{
    scope: 'overlay',
    reason: `the frontend at ${fronts.unversioned.join(', ')} is in no git repository, so the overlay cannot tell what changed there since the pack was built; an edit there is not seen in this answer`,
  }];
  return {
    fingerprint: { profile: prof.digest, catalog: cat.key, fronts: fronts.heads },
    stale: fronts.moved.length > 0 ? `${fronts.moved.join('; ')}, so the overlay is discarded rather than laid onto a frontend that has moved` : null,
    declined: prof.declined ?? cat.declined,
    limits,
  };
}

/** The catalog inputs to check, from the profile the run used: the SQL arguments come from it. */
export function sqlArgsOf(profile) {
  return sqlLaneArgs(profile ?? normalizeProfile({}));
}
