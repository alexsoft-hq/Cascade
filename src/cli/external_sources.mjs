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
// changed link target is a changed input), each real directory once (a link back
// into the tree does not loop), with no `node_modules`, `.git` or `.cascade` (a
// project's own output is not its input). Reading more than one lane reads can
// only call two inputs different that the lane would call the same, never the
// other way round. A root that is gone is `missing`; a root that could not be
// read is `unreadable`, which is never taken to agree with anything.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './state.mjs';

export const UNREADABLE = 'unreadable';

/** The input lists a run was given, with the flag that turns each lane off. */
const INVOCATION_LANES = [['ddl', 'noDdl'], ['mappers', 'noMappers'], ['javaSrc', 'noJava'], ['webSrc', 'noWeb'], ['openapi', 'noOpenapi'], ['har', null], ['otel', null]];

/**
 * The outside inputs of one analysis record, each with its content digest. Only
 * the path fields of lanes that ran: an argument string or a lane turned off is not an input.
 * @param {object} invocation  `meta.analysis.invocation`, paths portable
 * @param {object} selection   `meta.analysis.selection`, paths portable
 * @returns {Object<string,string>} absolute path -> digest, sorted by path
 */
export function externalSourcesOf(invocation, selection) {
  const paths = new Set();
  for (const [key, off] of INVOCATION_LANES) {
    if (!(off && invocation?.[off])) for (const p of invocation?.[key] ?? []) paths.add(p);
  }
  for (const key of ['javaRoots', 'mapperDirs', 'webRoots', 'ddls']) for (const p of selection?.[key] ?? []) paths.add(p);
  for (const t of selection?.templateRoots ?? []) paths.add(t?.root);
  const outside = [...paths].filter((p) => typeof p === 'string' && path.isAbsolute(p)).sort();
  return Object.fromEntries(outside.map((p) => [p, contentDigestOf(p)]));
}

/** The recorded outside inputs whose content on disk is not what was recorded, as `path` strings. */
export function changedSince(sources) {
  return Object.entries(sources ?? {}).filter(([p, d]) => d === UNREADABLE || contentDigestOf(p) !== d).map(([p]) => p);
}

/** A digest of a file, or of every regular file under a directory; `missing` when it is gone, `unreadable` when it cannot be read. */
export function contentDigestOf(abs) {
  if (!fs.existsSync(abs)) return 'missing';
  const lines = [];
  try {
    visit(abs, '', { lines, seen: new Set() });
  } catch {
    return UNREADABLE;
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

const SKIPPED = new Set(['node_modules', '.git', '.cascade']);

function visit(p, rel, walk) {
  const st = fs.statSync(p);
  if (st.isFile()) { walk.lines.push(`${rel}\t${sha256File(p)}`); return; }
  if (!st.isDirectory()) return;
  const real = fs.realpathSync(p);
  if (walk.seen.has(real)) { walk.lines.push(`${rel}\t-> seen`); return; }
  walk.seen.add(real);
  const names = fs.readdirSync(p).filter((name) => !SKIPPED.has(name)).sort();
  for (const name of names) visit(path.join(p, name), rel ? `${rel}/${name}` : name, walk);
}
