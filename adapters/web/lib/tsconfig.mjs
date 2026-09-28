// tsconfig.mjs — the path aliases of a directory that has a tsconfig of its own.
//
// WHAT THIS MODULE OWNS (RM67). A package's own `tsconfig.json` is read where
// the package is (webfacts.mjs, `readTsconfig`). A workspace that keeps several
// applications and libraries under ONE package.json puts a `tsconfig.json` in
// each of them instead, and that file usually says nothing but
// `"extends": "../../tsconfig.base.json"`: the aliases every import in it goes
// through (`@acme/ui/…`) are declared in the base. So for every directory
// between a source file and its package that holds a `tsconfig.json` or a
// `jsconfig.json`, the aliases that file MEANS are read the way the compiler
// reads them — the `extends` chain followed, each option taken from the nearest
// file that sets it, a `paths` target relative to that `baseUrl` or, with none,
// to the file that sets `paths` — and recorded with the directory they govern
// (`scope`). The bridge applies a scope's aliases to the files under it, before
// the package's own.
//
// WHAT IT MUST NEVER KNOW ABOUT: the syntax tree, the packs, the bridge. It reads
// JSON files and hands back config records.

import fs from 'node:fs';
import path from 'node:path';

/** The names a directory's own compiler configuration is found under, in the order tried. */
const CONFIG_NAMES = Object.freeze(['tsconfig.json', 'jsconfig.json']);

/** How far an `extends` chain is followed before it is taken to be a loop. */
const MAX_EXTENDS = 16;

/**
 * What one configuration file MEANS for `paths`: the map and the directory its
 * targets are relative to, after its `extends` chain. Only a relative `extends`
 * is followed; one naming a package is somebody else's defaults and declares no
 * alias of this project.
 *
 * @returns {{paths:object, base:string}|null}
 */
export function tsconfigPathsOf(first, parseJsonc) {
  const chain = [];
  const seen = new Set();
  for (let file = first; file && !seen.has(file) && seen.size < MAX_EXTENDS;) {
    seen.add(file);
    let json;
    try { json = parseJsonc(fs.readFileSync(file, 'utf8')); } catch { break; }
    const co = json && typeof json.compilerOptions === 'object' && json.compilerOptions !== null ? json.compilerOptions : {};
    chain.push({ dir: path.dirname(file), co });
    const ext = json && typeof json.extends === 'string' && json.extends.startsWith('.') ? json.extends : null;
    file = ext === null ? null : path.resolve(path.dirname(file), ext.endsWith('.json') ? ext : `${ext}.json`);
  }
  const withPaths = chain.find((c) => c.co.paths && typeof c.co.paths === 'object');
  if (!withPaths) return null;
  const withBase = chain.find((c) => typeof c.co.baseUrl === 'string');
  return { paths: withPaths.co.paths, base: withBase ? path.resolve(withBase.dir, withBase.co.baseUrl) : withPaths.dir };
}

/**
 * Every directory strictly between a source file and its package that holds a
 * configuration file of its own, with that file. A directory is looked at once
 * however many files sit under it.
 *
 * @returns {{dir:string, file:string}[]} sorted by directory
 */
function nestedConfigDirs(found, packageOf) {
  const dirs = new Set();
  for (const abs of found) {
    const pkg = packageOf(abs);
    if (pkg === null) continue;
    for (let dir = path.dirname(abs); dir !== pkg && dir.startsWith(pkg + path.sep); dir = path.dirname(dir)) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  const out = [];
  for (const dir of [...dirs].sort()) {
    const name = CONFIG_NAMES.find((n) => fs.existsSync(path.join(dir, n)));
    if (name) out.push({ dir, file: path.join(dir, name) });
  }
  return out;
}

/**
 * THE SCOPED ALIAS RECORDS: one per `paths` entry of every nested configuration,
 * each naming the directory it governs. `to` is relative to the PACKAGE, the way
 * every other alias record's is, so the bridge joins it the same way.
 *
 * @param {Set<string>} found  the absolute source files this run reads
 * @param {Function} packageOf  absolute path -> its package directory, or null
 * @param {Function} rel  absolute path -> root-relative posix path
 * @param {Function} parseJsonc  JSON with comments and trailing commas
 * @returns {object[]} config records
 */
export function scopedAliasRecords({ found, packageOf, rel, parseJsonc }) {
  const records = [];
  for (const { dir, file } of nestedConfigDirs(found, packageOf)) {
    const read = tsconfigPathsOf(file, parseJsonc);
    if (read === null) continue;
    const pkg = packageOf(file);
    for (const key of Object.keys(read.paths).sort()) {
      const targets = read.paths[key];
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const from = key.replace(/\/\*$/, '');
      const toAbs = path.resolve(read.base, String(targets[0]).replace(/\/\*$/, ''));
      const to = path.relative(pkg, toAbs).split(path.sep).join('/');
      records.push({ kind: 'config', file: rel(file), line: 1, what: 'alias', from, to, scope: rel(dir) });
    }
  }
  return records;
}
