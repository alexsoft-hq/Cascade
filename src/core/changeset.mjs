// changeset.mjs — "what changed between pin and pin (or base vs working tree)"
// as a single source of truth. Foundation for both the incremental core (§11)
// and the working-tree overlay (§10).
//
// SPEC §11.1 contract (MUST):
//  1. Read `git diff --name-status -z` (NUL-separated). `--name-only` without -z
//     quotes non-ASCII paths and silently drops them; the parser only trusts NUL.
//  2. UNKNOWN is not an empty list. If the previous pin is unknown or the diff
//     cannot be read, the changeset is UNKNOWN and `changedFiles()` THROWS —
//     blocking the "unknown -> harmless(0)" conversion at the type level.
//  3. A rename is not grounds for reuse — decompose R into delete(old)+add(new),
//     because some facts carry a path.
//  4. Emit both path conventions: repo-relative and source-root-relative.

export const CHANGESET_SCHEMA = 'cascade:changeset:1';
export const STATUS_UNKNOWN = 'UNKNOWN';

// The NUL delimiter of `git ... -z`, built with String.fromCharCode(0) ON
// PURPOSE: a literal NUL byte in source makes git treat this file as binary
// and hides its diffs (SPEC §16.3 hygiene). Runtime behavior is identical.
const NUL = String.fromCharCode(0);

/** @typedef {'A'|'M'|'D'} FileStatus */ // renames are decomposed away (rule 3)

/**
 * Parse the raw bytes of `git diff --name-status -z <a> <b>`.
 *
 * The -z format is a flat NUL-separated stream. For A/M/D each record is two
 * fields: `<status>NUL<path>NUL`. For R/C it is three: `<status>NUL<old>NUL<new>NUL`.
 * Status may carry a similarity score (e.g. "R100").
 *
 * @param {string|Buffer} raw
 * @returns {{status:FileStatus, path:string}[]}  renames decomposed
 */
export function parseNameStatusZ(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const toks = s.split(NUL);
  // A trailing NUL yields a final empty token we drop.
  if (toks.length && toks[toks.length - 1] === '') toks.pop();

  const out = [];
  let i = 0;
  while (i < toks.length) {
    const code = toks[i++];
    if (code === undefined || code === '') continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = toks[i++];
      const newPath = toks[i++];
      if (oldPath === undefined || newPath === undefined) {
        throw new ChangesetError(`truncated ${letter} record in name-status -z stream`);
      }
      // Rule 3: decompose. A copy (C) keeps the old file, so only add the new.
      if (letter === 'R') out.push({ status: 'D', path: oldPath });
      out.push({ status: 'A', path: newPath });
    } else if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      const path = toks[i++];
      if (path === undefined) throw new ChangesetError(`truncated ${letter} record in name-status -z stream`);
      // Type-change (T) is treated as a modification for invalidation purposes.
      out.push({ status: letter === 'T' ? 'M' : letter, path });
    } else {
      throw new ChangesetError(`unknown status code ${JSON.stringify(code)} in name-status -z stream`);
    }
  }
  // Deterministic order (SPEC §2.1): sort by path then status.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.status < b.status ? -1 : a.status > b.status ? 1 : 0));
  return out;
}

/**
 * Build a changeset for one repo.
 * @param {Object} opts
 * @param {string} opts.repo
 * @param {string} [opts.fromCommit]  previous pin; if null/undefined -> UNKNOWN
 * @param {string} opts.toCommit
 * @param {string|Buffer} [opts.rawNameStatusZ]  output of git diff --name-status -z
 * @param {string} [opts.sourceRoot]  e.g. "src/main/java" — to emit source-root-relative paths
 * @returns {Object} changeset record
 */
export function buildChangeset({ repo, fromCommit, toCommit, rawNameStatusZ, sourceRoot }) {
  if (!repo) throw new ChangesetError('repo is required');
  if (fromCommit == null || rawNameStatusZ == null) {
    // Rule 2: not an empty list — an explicit UNKNOWN.
    return {
      schema: CHANGESET_SCHEMA,
      repo,
      status: STATUS_UNKNOWN,
      fromCommit: fromCommit ?? null,
      toCommit: toCommit ?? null,
      reason: fromCommit == null ? 'previous pin unknown' : 'diff unavailable',
      files: null,
    };
  }
  const parsed = parseNameStatusZ(rawNameStatusZ);
  const files = parsed.map((f) => ({
    status: f.status,
    repoPath: f.path,
    // Rule 4: also emit source-root-relative when the file is under sourceRoot.
    srcPath: relativeToSourceRoot(f.path, sourceRoot),
  }));
  return {
    schema: CHANGESET_SCHEMA,
    repo,
    status: 'OK',
    fromCommit,
    toCommit,
    files,
  };
}

/**
 * The changed files of a changeset. THROWS on UNKNOWN (Rule 2) — callers cannot
 * accidentally treat "we don't know" as "nothing changed".
 * @param {Object} changeset
 * @returns {{status:FileStatus, repoPath:string, srcPath:string|null}[]}
 */
export function changedFiles(changeset) {
  if (!changeset || changeset.status === STATUS_UNKNOWN) {
    throw new ChangesetError(
      `changeset for ${changeset?.repo ?? '<unknown repo>'} is UNKNOWN. We refuse to convert unknown into harmless(0)`,
    );
  }
  return changeset.files;
}

function relativeToSourceRoot(path, sourceRoot) {
  if (!sourceRoot) return null;
  const root = sourceRoot.endsWith('/') ? sourceRoot : sourceRoot + '/';
  return path.startsWith(root) ? path.slice(root.length) : null;
}

export class ChangesetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangesetError';
  }
}
