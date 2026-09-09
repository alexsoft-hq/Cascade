// lanes_run.mjs — the workers, and which files they are pointed at.
//
// The lanes themselves live in `adapters/` (a Java program, a Node worker, three
// Python scripts). This module is the CLI's side of that boundary: it compiles
// the Java worker when its source has changed, invokes both workers and parses
// their JSONL, expands the `--ddl` globs, reads the frontend packages a run will
// really touch, and decides which tree `analyze` is about.
//
// It also holds the ONE WIRING POINT where the lane bridges are handed to the
// core assembler, because the CLI is the layer that knows both sides.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGraphFromSql } from '../adapters/sql_bridge.mjs';
import { addJavaFacts } from '../adapters/java_bridge.mjs';
import { addWebFacts } from '../adapters/web_bridge.mjs';
import { addRuntimeFacts } from '../adapters/runtime_bridge.mjs';
import { addOpenApiRoutes } from '../adapters/openapi_bridge.mjs';
import { addJpaFacts } from '../adapters/jpa_bridge.mjs';
import { addMybatisPlusFacts } from '../adapters/mp_bridge.mjs';
import { routerDependencyOf } from '../core/discover.mjs';
import { ENGINE_ROOT, manifestAt } from './env.mjs';

// THE ONE WIRING POINT (SPEC §4, I-3). `src/core/` imports nothing from
// `src/adapters/` — a lane is a plug-in, and the core is what it plugs into.
// The CLI is the layer that knows both sides, so this is where the bridges are
// handed to the core assembler (src/core/assemble.mjs). `analyze` and the
// working-tree overlay both take this object, which is also what stops the two
// from assembling a graph by two different routes. A test wires fakes instead.
export const LANE_BRIDGES = Object.freeze({ buildGraphFromSql, addJavaFacts, addJpaFacts, addMybatisPlusFacts, addOpenApiRoutes, addWebFacts, addRuntimeFacts });

// Compile adapters/java/JavaFacts.java into a build cache (only when stale) and
// run it over the given source roots. Returns parsed cascade:javafacts:1 records.
//
// The build directory is named after the WORKER SOURCE'S CONTENT and is
// published by an atomic rename, because several `cascade` processes can run at
// once (the test suite does exactly that) and a shared, mtime-keyed directory
// let two of them write the same .class files concurrently — the loser then ran
// a half-written class. Content-addressing also means a checkout that moves the
// worker back and forth never reuses the wrong generation.
export function runJavaLane(jdk, root, srcRoots) {
  const src = path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java');
  const build = javaWorkerBuildDir(jdk, src);
  const out = execFileSync(jdk.java, ['-cp', build, 'JavaFacts', '--root', root, ...srcRoots], { maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Run the web lane's worker over the given targets and parse its JSONL
 * (adapters/web/webfacts.mjs, `cascade:webfacts:1`).
 *
 * A target is a source ROOT (a cold run walks it) or a single FILE (an
 * incremental run re-reads exactly what changed): the worker takes both, and
 * everything it emits is per file, so the two invocations produce the same
 * records for the same bytes.
 *
 * @param {string} root   the analyzed root, absolute
 * @param {string[]} targets  frontend source roots or files, absolute
 * @param {{configsOnly?:boolean}} [opts]  with `configsOnly`, no source file is
 *        walked and only the package configuration comes back
 * @returns {Object[]} the worker's records, header and summary included
 */
export function runWebLane(root, targets, opts = {}) {
  const worker = path.join(ENGINE_ROOT, 'adapters', 'web', 'webfacts.mjs');
  // `--web-root` names the roots this project DECLARES, on every invocation.
  // The worker looks for an HTML template a `templateUrl` names relative to
  // them, and an incremental run is handed changed FILES rather than roots: a
  // search derived from the arguments would look in different places on the two
  // runs and could resolve one `templateUrl` to two files.
  const declared = (opts.sourceRoots ?? []).flatMap((d) => ['--web-root', d]);
  // ...and the TEMPLATE roots, on every invocation for the same reason: an
  // incremental run is handed changed files, and a template file only says which
  // view name it answers to relative to the root it sits under.
  const templates = (opts.templateRoots ?? []).flatMap((t) => ['--template-root', JSON.stringify({
    root: t.root, engine: t.engine, suffix: t.suffix,
  })]);
  const args = [worker, ...(opts.configsOnly ? ['--configs-only'] : []), '--root', root, ...declared, ...templates, ...targets];
  const out = execFileSync(process.execPath, args, { maxBuffer: 1 << 28 }).toString('utf8');
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}


/** The compiled worker for THIS source, compiling it first if nobody has yet. */
export function javaWorkerBuildDir(jdk, src) {
  const key = createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 12);
  const build = path.join(ENGINE_ROOT, '.java-build', key);
  if (fs.existsSync(path.join(build, 'JavaFacts.class'))) return build;
  // Compile somewhere private, then publish with ONE rename. A rename onto an
  // existing directory fails, which is the right outcome: another process got
  // there first, its build is by construction the same bytes, so use it.
  const tmp = `${build}.tmp-${process.pid}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    execFileSync(jdk.javac, ['-d', tmp, src], { stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      fs.renameSync(tmp, build);
    } catch {
      if (!fs.existsSync(path.join(build, 'JavaFacts.class'))) throw new Error(`could not publish the compiled Java worker to ${build}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return build;
}

/**
 * EXPAND `--ddl` PATTERNS. Each value is a literal path or a glob; `*` matches
 * within one path segment, `**` across segments, `?` one character.
 *
 * A repository that ships one schema per service asks for all of them with one
 * pattern, and typing three paths in the right order is the same thing said
 * longhand — so both are accepted, and the ORDER survives either way: patterns
 * expand in the order they were typed, and each pattern's own matches come back
 * sorted, because "in path order" has to mean the same thing on every machine.
 *
 * A pattern that matches nothing is passed through UNCHANGED, so the run dies on
 * "--ddl <that path> does not exist" naming what the user typed, rather than
 * silently analysing a smaller set than they asked for.
 *
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function expandDdlPatterns(patterns) {
  const out = [];
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) { out.push(pattern); continue; }
    const matches = globFiles(pattern);
    if (matches.length === 0) { out.push(pattern); continue; }
    out.push(...matches);
  }
  return out.filter((p, i) => out.indexOf(p) === i);
}

/**
 * Files matching one glob, sorted. Walks only the directories the pattern's
 * literal prefix allows, so a pattern rooted deep in a tree does not scan the
 * whole of it.
 * @param {string} pattern
 * @returns {string[]}
 */
export function globFiles(pattern) {
  const abs = path.resolve(pattern);
  const parts = abs.split(path.sep);
  // The longest leading run of literal segments is a real directory to start in.
  const firstWild = parts.findIndex((p) => /[*?]/.test(p));
  if (firstWild < 0) return fs.existsSync(abs) ? [abs] : [];
  const base = parts.slice(0, firstWild).join(path.sep) || path.sep;
  const body = abs
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    // NUL as a SENTINEL, on purpose: `**` is replaced by a byte no path can
    // contain, so the `*` rule above cannot eat half of it, and the sentinel is
    // then replaced by what `**` means. A control character in a regular
    // expression is a mistake everywhere else, which is why the rule is on.
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  const re = new RegExp(`^${body}$`);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 24) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && re.test(full)) found.push(full);
    }
  };
  walk(base, 0);
  return found.sort();
}


/**
 * THE FRONTEND PACKAGES THIS RUN REALLY READS: the nearest `package.json` above
 * each web source root, with the router it depends on.
 *
 * The filesystem edge for `screenAxisOf` (src/core/lanes.mjs). It exists because
 * discovery walks the ANALYZED ROOT and `--web-src ../front/src` points outside
 * it: nothing discovery measured can say whether that frontend has a router, and
 * a run that reads a whole Vue application must not decide "no screens" on a
 * walk that never went there. Unreadable or absent JSON is no evidence, not a
 * failure: the switch simply falls through to its next rule.
 *
 * @param {string[]} webRootsAbs  the frontend source roots this run will read
 * @returns {{path:string, router:(string|null)}[]}
 */
export function webPackagesRead(webRootsAbs) {
  const out = new Map();
  for (const start of webRootsAbs ?? []) {
    let dir = path.resolve(start);
    for (let i = 0; i < 16; i += 1) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        if (!out.has(file)) {
          let router;
          try {
            const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
            router = routerDependencyOf({ ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) });
          } catch { router = null; }
          out.set(file, { path: file, router });
        }
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * WHICH TREE `analyze` READS.
 *
 * `--root` wins, always: the operator has named the directory. With no --root,
 * a run that resolved to a REGISTERED project analyzes that project's own tree,
 * because "analyze mall" can only mean "analyze mall's source":
 *
 *   - the manifest lists ONE repository -> that repository (its path is already
 *     resolved against the manifest's own directory)
 *   - it lists several -> the directory the manifest's `.cascade/` sits in,
 *     which is the workspace holding them all
 *   - there is no manifest -> the same directory, for want of anything better
 *
 * cwd is the answer only when nothing resolved, which is the plain
 * `cd <project> && cascade analyze` case this always handled.
 *
 * @param {{dotCascade:(string|null), source:string}} resolved  from resolveProject
 * @param {(string|undefined)} rootFlag  the raw --root, if one was given
 * @param {string} cwd
 * @returns {{root:string, from:string}}  the directory, and why it is that one
 */
export function analyzeRoot(resolved, rootFlag, cwd) {
  if (typeof rootFlag === 'string' && rootFlag.length > 0) {
    return { root: path.resolve(cwd, rootFlag), from: '--root' };
  }
  if (resolved && resolved.source === 'registry' && typeof resolved.dotCascade === 'string') {
    const manifest = manifestAt(resolved.dotCascade);
    const repos = manifest ? manifest.repositories : [];
    if (repos.length === 1) {
      return { root: path.resolve(repos[0].absPath), from: "the registered project's manifest" };
    }
    if (repos.length > 1) {
      return { root: path.dirname(resolved.dotCascade), from: `the registered project's workspace, ${repos.length} repositories` };
    }
    return { root: path.dirname(resolved.dotCascade), from: 'the registered project, which has no manifest' };
  }
  return { root: path.resolve(cwd), from: 'the current directory' };
}
