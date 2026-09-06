// invalidate.mjs — "given what changed, what must be recomputed?" (SPEC §11.2).
//
// PURE. It takes the previous facts index, a changeset (src/core/changeset.mjs)
// and the lane selection, and returns a PLAN. It runs no worker, reads no file,
// and never decides "nothing changed" from an absence of information: an UNKNOWN
// changeset is a COLD run with the reason attached (§11.1 rule 2).
//
// The rules, and why each is safe:
//
//  * a changed or added `.java` under a Java source root -> reparse THAT FILE ONLY.
//    Safe because JavaFacts is file-local: it emits the types, imports (including
//    wildcard packages), fields, methods, endpoints and calls of the file in front
//    of it, and resolves nothing across files. Every cross-file step — simple name
//    to FQN, interface to implementation dispatch, mapper method to statement — is
//    done afterwards in src/adapters/java_bridge.mjs over the ASSEMBLED fact set,
//    which the incremental path rebuilds in full on every run. So editing file A
//    can change how file B's calls resolve, and it still does: the resolution is
//    redone, only the PARSING is reused. (Verified by the metamorphic oracle in
//    test/incremental.test.mjs, which mutates a random subset of files each round
//    and requires the incremental pack to equal the cold pack.)
//  * a deleted `.java` -> drop its shard (and with it every fact that carried
//    that path).
//  * a changed or added frontend source file under a web source root -> reparse
//    THAT FILE ONLY, and a deleted one -> drop its shard. Safe for the same
//    reason: adapters/web/webfacts.mjs records what one file imports, exports,
//    binds and calls, and every cross-file step — an import resolved through an
//    alias, a wrapper traced to the client library it forwards to, a URL matched
//    against a route — happens afterwards in src/adapters/web_bridge.mjs over the
//    whole assembled set, which the incremental path rebuilds in full.
//  * a changed PACKAGE CONFIG (`package.json`, `.env*`, `vite.config.*`,
//    `vue.config.js`, `tsconfig.json`, `jsconfig.json`) -> `webConfigChanged`,
//    and nothing else. Those records are never cached at all (the executor
//    re-reads them every run), so no shard has to be invalidated for them: what
//    the flag is for is the RECORD of why a run did what it did.
//  * ANY changed mapper XML -> rerun mybatis_extract over ALL mapper files,
//    because `<include refid>` resolves through a global, cross-file fragment
//    index. Lineage is NOT invalidated wholesale: each statement keeps its own
//    shard, so only statements whose flattened SQL actually moved are recomputed.
//  * a changed DDL/catalog -> every lineage shard is invalid, because the catalog
//    digest is part of the lineage key (a column that appears or disappears
//    changes what every statement resolves to).
//  * everything else is reused from the CAS.
//
// The plan is advisory for the SQL lanes and binding for the Java lane: the
// executor re-derives the statement/catalog shard keys from the CURRENT bytes, so
// a mapper edited and then reverted is a cache hit even though the changeset
// lists it. `sqlChanged`/`catalogChanged` are therefore reported as EXPECTATIONS
// and the executor states what it actually did.

import { canonicalJson } from './canonical.mjs';
import { STATUS_UNKNOWN } from './changeset.mjs';
import { isWebSourceFile } from './discover.mjs';

/**
 * The files that configure a frontend PACKAGE rather than live inside it as
 * source. Kept in step with `readPackageConfig` in adapters/web/webfacts.mjs,
 * which is the code that actually reads them.
 * @param {string} file  a root-relative path
 * @returns {boolean}
 */
export function isWebPackageConfigFile(file) {
  const name = String(file ?? '').split('/').pop();
  if (name === 'package.json' || name === 'tsconfig.json' || name === 'jsconfig.json') return true;
  if (/^\.env(\..+)?$/.test(name)) return true;
  return /^(?:vue|vite)\.config\.[a-z]+$/.test(name);
}

/**
 * Is this file a package config belonging to one of the frontend roots?
 *
 * A frontend's package directory usually sits ABOVE its source root
 * (`front/package.json` over `front/src`), and with `--web-src ../front/src` it
 * can even sit outside the analyzed root, so "under a web root" is the wrong
 * test. The right one is: the file's directory contains a web root, or sits
 * inside one.
 * @param {string} file  root-relative
 * @param {string[]} webRoots  root-relative
 * @returns {boolean}
 */
function isWebConfigOf(file, webRoots) {
  if (!isWebPackageConfigFile(file)) return false;
  if (underAny(file, webRoots)) return true;
  const slash = file.lastIndexOf('/');
  const dir = slash < 0 ? '' : file.slice(0, slash);
  return (webRoots ?? []).some((r) => underAny(r, [dir]));
}

export const MODE_COLD = 'cold';
export const MODE_INCREMENTAL = 'incremental';

/**
 * @param {Object} input
 * @param {'auto'|'cold'|'incremental'} [input.requestedMode]
 * @param {Object|null} input.index      the previous `facts-index.json`, or null
 * @param {Object|null} input.changeset  a changeset record (may be UNKNOWN)
 * @param {string[]} [input.untracked]   root-relative paths git does not track (added)
 * @param {{root:string, javaRoots:string[], mapperDirs:string[], webRoots:string[], ddls:string[], sqlArgs:string[], packagePrefixes:string[]}} input.selection
 *        root-relative lane inputs; `root` is absolute and identifies the tree.
 * @param {{java:string, mybatis:string, lineage:string, catalog:string}} input.workers
 * @param {string} input.engineVersion
 * @param {(file:string)=>boolean} [input.stillExists]  for files the previous run
 *        recorded as dirty: a dirty UNTRACKED file that has since been removed is
 *        invisible to git, so its shard is dropped by an existence check instead.
 * @returns {{mode:string, reason:(string|null), notes:string[],
 *            reparseJava:string[], dropJava:string[],
 *            reparseWeb:string[], dropWeb:string[],
 *            sqlChanged:boolean, catalogChanged:boolean, webConfigChanged:boolean,
 *            reuse:{java:number, web:number}}}
 */
export function planIncremental(input) {
  const {
    requestedMode = 'auto',
    index = null,
    changeset = null,
    untracked = [],
    selection,
    workers,
    engineVersion,
    stillExists = () => true,
  } = input ?? {};
  if (!selection || typeof selection !== 'object') throw new InvalidateError('selection is required');
  if (!workers || typeof workers !== 'object') throw new InvalidateError('workers is required');
  if (typeof engineVersion !== 'string') throw new InvalidateError('engineVersion must be a string');

  const cold = (reason) => ({
    mode: MODE_COLD, reason, notes: [],
    reparseJava: [], dropJava: [], reparseWeb: [], dropWeb: [],
    sqlChanged: true, catalogChanged: true, webConfigChanged: true,
    reuse: { java: 0, web: 0 },
  });

  if (requestedMode === MODE_COLD) return cold('--cold was given: every shard is ignored and every lane recomputed');
  if (!index) return cold('no previous facts-index.json beside the pack, so there is nothing to reuse');
  if (index.engineVersion !== engineVersion) {
    return cold(`the engine changed (${index.engineVersion} -> ${engineVersion}); a mixed-generation graph is not a graph`);
  }
  for (const name of Object.keys(workers)) {
    if (index.workers?.[name] !== workers[name]) {
      return cold(`the ${name} worker changed (${index.workers?.[name] ?? 'unrecorded'} -> ${workers[name]}), so every shard it produced is a different generation and none of them can be reused`);
    }
  }
  if (index.root !== selection.root) {
    return cold(`the analyzed root moved (${index.root} -> ${selection.root})`);
  }
  const prevSel = canonicalJson(normalizeSelection(index.selection ?? {}));
  const nowSel = canonicalJson(normalizeSelection(selection));
  if (prevSel !== nowSel) {
    return cold('the lane selection changed since the last run (different roots, mapper dirs, DDL or SQL arguments), and cold and incremental must analyze the same inputs');
  }
  if (!changeset || changeset.status === STATUS_UNKNOWN) {
    return cold(`the changeset is UNKNOWN: ${changeset?.reason ?? 'no changeset was produced'} (unknown is never read as an empty list of changes)`);
  }
  if (!Array.isArray(changeset.files)) return cold('the changeset carries no file list');

  // ---- classify ------------------------------------------------------------
  const notes = [];
  const javaRoots = selection.javaRoots ?? [];
  const mapperDirs = selection.mapperDirs ?? [];
  // A SET of files can feed the catalog (RM20 §3); an index written before that
  // carries a single `ddl`, and one file is a set of one.
  const ddls = selection.ddls ?? (selection.ddl ? [selection.ddl] : []);

  const webRoots = selection.webRoots ?? [];

  const reparse = new Set();
  const drop = new Set();
  const reparseWeb = new Set();
  const dropWeb = new Set();
  let sqlChanged = false;
  let catalogChanged = false;
  let webConfigChanged = false;

  const consider = (status, file) => {
    if (ddls.includes(file)) catalogChanged = true;
    if (file.endsWith('.xml') && underAny(file, mapperDirs)) sqlChanged = true;
    if (isWebConfigOf(file, webRoots)) webConfigChanged = true;
    if (isWebSourceFile(file) && underAny(file, webRoots)) {
      if (status === 'D') dropWeb.add(file);
      else reparseWeb.add(file);
    }
    if (!file.endsWith('.java') || !underAny(file, javaRoots)) return;
    if (status === 'D') drop.add(file);
    else reparse.add(file);
  };

  for (const f of changeset.files) consider(f.status, f.repoPath);
  for (const f of untracked) consider('A', f);

  // A file the PREVIOUS run read in a dirty state is not described by any commit,
  // so `git diff <base>` cannot tell us whether it moved back. Re-read it, or drop
  // it if it is gone (an untracked file that was deleted leaves no git trace).
  for (const f of index.base?.dirtyFiles ?? []) {
    if (ddls.includes(f)) catalogChanged = true;
    if (f.endsWith('.xml') && underAny(f, mapperDirs)) sqlChanged = true;
    if (isWebConfigOf(f, webRoots)) webConfigChanged = true;
    if (f.endsWith('.java') && underAny(f, javaRoots)) {
      if (stillExists(f)) { reparse.add(f); drop.delete(f); }
      else { drop.add(f); reparse.delete(f); }
    }
    if (isWebSourceFile(f) && underAny(f, webRoots)) {
      if (stillExists(f)) { reparseWeb.add(f); dropWeb.delete(f); }
      else { dropWeb.add(f); reparseWeb.delete(f); }
    }
  }
  if ((index.base?.dirtyFiles ?? []).length > 0) {
    notes.push(`${index.base.dirtyFiles.length} file(s) were dirty when the previous pack was built and are re-read, not reused: git cannot diff a working-tree state against a commit that never held it`);
  }

  // A deletion wins over a re-parse: git decomposes a rename into D(old)+A(new)
  // (§11.1 rule 3), and the two paths are different files. The same rule holds
  // for both lanes.
  for (const f of drop) reparse.delete(f);
  for (const f of dropWeb) reparseWeb.delete(f);

  const prevFiles = Object.entries(index.files ?? {});
  const reused = prevFiles.filter(([f, e]) => (e?.lane ?? 'java') !== 'web' && !reparse.has(f) && !drop.has(f)).length;
  const reusedWeb = prevFiles.filter(([f, e]) => e?.lane === 'web' && !reparseWeb.has(f) && !dropWeb.has(f)).length;
  const has = (f) => Object.prototype.hasOwnProperty.call(index.files ?? {}, f);
  const unknownDrops = [...drop].filter((f) => !has(f));
  if (unknownDrops.length) {
    notes.push(`${unknownDrops.length} deleted java file(s) had no shard in the previous index (they carried no facts), so there is nothing to drop`);
  }
  const unknownWebDrops = [...dropWeb].filter((f) => !has(f));
  if (unknownWebDrops.length) {
    notes.push(`${unknownWebDrops.length} deleted frontend file(s) had no shard in the previous index (they carried no facts), so there is nothing to drop`);
  }

  return {
    mode: MODE_INCREMENTAL,
    reason: null,
    notes,
    reparseJava: [...reparse].sort(),
    dropJava: [...drop].sort(),
    reparseWeb: [...reparseWeb].sort(),
    dropWeb: [...dropWeb].sort(),
    sqlChanged,
    catalogChanged,
    webConfigChanged,
    reuse: { java: reused, web: reusedWeb },
  };
}

/** Is `file` inside one of `dirs` (all root-relative, "" / "." meaning the root)? */
export function underAny(file, dirs) {
  if (typeof file !== 'string' || !Array.isArray(dirs)) return false;
  for (const d of dirs) {
    if (d === '' || d === '.') return true;
    const prefix = d.endsWith('/') ? d : d + '/';
    if (file === d || file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * The selection fields that must match for a shard to be reusable.
 *
 * `webRoots` is in here for the same reason as the Java roots: a project that
 * GAINS or LOSES the web lane is analyzing a different set of inputs than the
 * pack beside it was built from, and a run that quietly reused the old shards
 * would ship a pack whose axes describe one selection and whose facts come from
 * another. One cold run, with "the lane selection changed" as the reason, is the
 * correct price.
 */
function normalizeSelection(sel) {
  return {
    javaRoots: [...(sel.javaRoots ?? [])].sort(),
    mapperDirs: [...(sel.mapperDirs ?? [])].sort(),
    webRoots: [...(sel.webRoots ?? [])].sort(),
    ddls: sel.ddls ?? (sel.ddl ? [sel.ddl] : []),
    sqlArgs: [...(sel.sqlArgs ?? [])],
    packagePrefixes: [...(sel.packagePrefixes ?? [])].sort(),
  };
}

export { normalizeSelection };

export class InvalidateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidateError';
  }
}
