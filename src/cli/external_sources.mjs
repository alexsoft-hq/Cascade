// external_sources.mjs — what an analysis read from outside the repository, by content.
//
// A path inside the repository is versioned by the commit a pack records. A path
// outside it (a frontend checked out beside the repository, a schema kept
// elsewhere) is not: its content changes with no commit of this project, so a
// path alone cannot say two packs read the same thing. So every such input the
// run actually selected gets a digest of its content, recorded in
// `meta.analysis.external.sources` and compared as a condition
// (src/core/pack_diff.mjs), and a base commit refuses a current pack whose outside
// inputs have changed on disk since it was analyzed (src/cli/base_commit.mjs).
//
// THE DIGEST reads at least what any lane would read: every regular file by path
// relative to the root, FOLLOWING symbolic links (the Java lane follows them, so a
// changed link target is a changed input), each real directory read once under
// the first path that reaches it, and every other path to it (a link, a loop)
// recorded as that first path, so a link pointed elsewhere changes the digest and
// no arrangement of links reads a tree twice, with no `node_modules`, `.git` or `.cascade` (a
// project's own output is not its input). Reading more than one lane reads can
// only call two inputs different that the lane would call the same, never the
// other way round. A frontend root also reads its PACKAGE configuration from the
// nearest `package.json` above it (`.env*`, the dev-server and path-alias
// configs, `tsconfig.json`), which sits outside the root: those files are one
// more input, `<package dir>#package-config`. A root that is gone is `missing`; a root that could not be
// read is `unreadable`, which is never taken to agree with anything.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isWebPackageConfigFile } from '../core/invalidate.mjs';


export const UNREADABLE = 'unreadable';

const CHUNK = 1 << 20;

/** A file's sha256, read a megabyte at a time: an outside tree can hold files far larger than a source file. */
function sha256File(file) {
  const [hash, buf, fd] = [createHash('sha256'), Buffer.allocUnsafe(CHUNK), fs.openSync(file, 'r')];
  try {
    for (let n = fs.readSync(fd, buf, 0, CHUNK, null); n > 0; n = fs.readSync(fd, buf, 0, CHUNK, null)) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The input lists a run was given, with the flag that turns each lane off. */
const INVOCATION_LANES = [['ddl', 'noDdl'], ['mappers', 'noMappers'], ['javaSrc', 'noJava'], ['webSrc', 'noWeb'], ['openapi', 'noOpenapi'], ['har', null], ['otel', null]];

/**
 * The outside inputs of one analysis record, each with its content digest. Only
 * the path fields of lanes that ran: an argument string or a lane turned off is not an input.
 * @param {object} invocation  `meta.analysis.invocation`, paths portable
 * @param {object} selection   `meta.analysis.selection`, paths portable
 * @returns {Object<string,string>} absolute path -> digest, sorted by path
 */
export function externalSourcesOf(invocation = {}, selection = {}) {
  const paths = inputPathsOf(invocation ?? {}, selection ?? {}).filter(isOutside);
  const webRoots = [...(invocation?.noWeb ? [] : invocation?.webSrc ?? []), ...(selection?.webRoots ?? [])].filter(isOutside);
  const keys = new Set([...paths, ...webRoots.map((root) => `${packageDirOf(root)}${PACKAGE_CONFIG}`)]);
  return Object.fromEntries([...keys].sort().map((p) => [p, digestOfSource(p)]));
}

const isOutside = (p) => typeof p === 'string' && path.isAbsolute(p);

/** Every input path of the lanes that ran, as recorded. */
function inputPathsOf(invocation, selection) {
  const paths = INVOCATION_LANES.flatMap(([key, off]) => (off && invocation[off] ? [] : invocation[key] ?? []));
  for (const key of ['javaRoots', 'mapperDirs', 'webRoots', 'ddls']) paths.push(...(selection[key] ?? []));
  return [...paths, ...(selection.templateRoots ?? []).map((t) => t?.root)];
}

const PACKAGE_CONFIG = '#package-config';

/**
 * The outside inputs that are not what an analysis recorded: computed again from
 * its recorded invocation and selection, so an input that appeared (a nearer
 * `package.json` above a frontend root) counts as well as one whose content
 * changed or that went away.
 * @param {{invocation?:object, selection?:object, external?:object}} analysis  `meta.analysis`
 * @returns {string[]} the keys that differ, sorted
 */
export function changedSince(analysis) {
  const recorded = analysis?.external?.sources ?? {};
  const now = externalSourcesOf(analysis?.invocation, analysis?.selection);
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(now)])].sort();
  return keys.filter((k) => recorded[k] === UNREADABLE || recorded[k] !== now[k]);
}

/** One recorded source's digest now: a path's content, or a package directory's configuration files. */
function digestOfSource(key) {
  if (!key.endsWith(PACKAGE_CONFIG)) return contentDigestOf(key);
  const dir = key.slice(0, -PACKAGE_CONFIG.length);
  try {
    const files = fs.readdirSync(dir).filter((n) => isWebPackageConfigFile(n) && fs.statSync(path.join(dir, n)).isFile()).sort();
    return createHash('sha256').update(files.map((n) => `${n}\t${sha256File(path.join(dir, n))}`).join('\n')).digest('hex').slice(0, 16);
  } catch {
    return fs.existsSync(dir) ? UNREADABLE : 'missing';
  }
}

/** The directory holding the nearest `package.json` at or above a frontend root, as the web lane finds it; the root itself when there is none. */
function packageDirOf(root) {
  for (let cur = root; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    if (path.dirname(cur) === cur) return root;
  }
}

/** A digest of a file, or of every regular file under a directory; `missing` when it is gone, `unreadable` when it cannot be read. */
export function contentDigestOf(abs) {
  if (!fs.existsSync(abs)) return 'missing';
  const lines = [];
  try {
    visit(abs, '', { lines, firstPath: new Map() });
  } catch {
    return UNREADABLE;
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

const SKIPPED = new Set(['node_modules', '.git', '.cascade']);

function visit(p, rel, walk) {
  const st = fs.statSync(p);
  if (st.isFile()) walk.lines.push(`${rel}\t${sha256File(p)}`);
  else if (st.isDirectory()) visitDirectory(p, rel, walk);
}

/** A real directory read once; any later path to it is recorded as the path it was first read under. */
function visitDirectory(p, rel, walk) {
  const real = fs.realpathSync(p);
  if (walk.firstPath.has(real)) { walk.lines.push(`${rel}\t-> ${walk.firstPath.get(real) || '.'}`); return; }
  walk.firstPath.set(real, rel);
  for (const name of fs.readdirSync(p).filter((n) => !SKIPPED.has(n)).sort()) visit(path.join(p, name), rel ? `${rel}/${name}` : name, walk);
}
