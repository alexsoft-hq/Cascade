// shared.mjs — the primitives every step of the web bridge is written on.
//
// WHAT THIS MODULE OWNS: string comparison, path spelling, URL spelling, and
// the four walk limits. Nothing here knows what a screen is, what a call is or
// what a prefix is; every one of these is the kind of thing that would
// otherwise be written twice, slightly differently, in two of the modules
// beside it — and two spellings of one path are two nodes.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the fact stream, the profile, or
// any other module in this directory. It imports nothing.
//
// Every path in the fact stream is ROOT-RELATIVE and POSIX, whatever the
// platform ran the analysis, so nothing here touches node:path's separator
// rules.

/** Ascending string order, and the only comparator in this directory. */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Weakest link across a call's URL candidates: the lower rank wins. */
export const GRADE_RANK = Object.freeze({
  UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4,
});

/** How far a resolution walk follows re-exports, aliases and route parents before giving up. */
export const HOP_LIMIT = 16;

/** How many rounds the wrapper fixpoint runs. Monotone, so it converges long before this. */
export const FIXPOINT_LIMIT = 32;

/**
 * How deep RENDERS follows one component importing another, or one template
 * including another, before it stops. A child of a child of a child of a child
 * is still a candidate; past that the claim "this screen renders that function"
 * is not worth making.
 */
export const RENDERS_DEPTH = 4;

export function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function joinPosix(a, b) {
  if (a === '' || a === '.') return normalizePosix(b);
  return normalizePosix(`${a}/${b}`);
}

export function normalizePosix(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    // A LEADING `..` is kept. The paths here are relative to the analyzed root,
    // and a frontend checked out beside its backend rather than inside it is
    // `../front/src/...` — dropping the `..` would make every file in it
    // resolve to a path that is not there.
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop(); else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** A URL path with one leading slash, no doubled slashes and no trailing slash. */
export function normalizeUrl(u) {
  let s = String(u ?? '');
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * The package a config record belongs to: the directory its file sits in. A
 * record whose `file` has no dot in its last segment IS a directory (the
 * assumed-alias record names the package directory itself when the package has
 * no package.json), so it is its own package.
 */
export function configDirOf(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.includes('.') ? dirOf(file) : file;
}

/** The npm package name a bare specifier names: `a/b` -> `a`, `@s/n/x` -> `@s/n`. */
export function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The top of a "what did we fail on, and how often" list: most common first,
 * ties broken by name so two runs print the same rows, cut to `limit`.
 *
 * Four of the lane's statistics are this list under four names, and writing the
 * sort out four times is how the four end up ordered three different ways.
 */
export function topCounts(counts, limit, key) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ [key]: value, count }));
}
