// env.mjs — where this engine is, and the small impure edges every command
// borrows: the interpreter it runs SQL with, the JDK it compiles the Java
// worker with, the scratch directories it cleans up after itself, git, and the
// two ways a path is spelled.
//
// It is the bottom of `src/cli/`: it imports from `src/core/` and from nothing
// else in this directory, so every other module here can use it without a cycle.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jdkCandidateDirs } from '../core/doctor.mjs';
import { loadManifest } from '../core/manifest.mjs';
import { slugify } from '../core/init.mjs';
import { projectPaths, sqlPythonCandidates } from '../core/paths.mjs';
import { resolveProject } from '../core/resolve.mjs';
import { makeScratch } from '../core/scratch.mjs';

/** Read a JSONL FILE, and read a JSONL STRING. Both drop blank lines. */
export const jsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const parseJsonl = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** The checkout (or the installed package) this process is running out of. */
export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * THE PATH A CLIENT WOULD START THIS TOOL BY, through whatever symlink an
 * installer left behind.
 *
 * `cascade agent` writes it into somebody else's `.mcp.json` and `cascade init`
 * re-invokes it to hand a terminal to `catalog fetch`, so it has to be the
 * binary's own absolute path and not this module's: a client starts the server
 * from a working directory nobody controls.
 */
export const CLI_PATH = realPath(path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'));

/**
 * THE SQL LANE'S INTERPRETER, resolved once for every command that needs one.
 *
 * The candidates and their order are a pure rule (src/core/paths.mjs); this is
 * the filesystem edge that walks them. When none of them exists the answer
 * still carries the whole list, because "no python" is not an answer a reader
 * can act on and "I looked here, here and here" is.
 *
 * @returns {{ok:boolean, path:string, from:(string|null), tried:{path:string, from:string}[]}}
 */
export function sqlPython() {
  const tried = sqlPythonCandidates({ engineRoot: ENGINE_ROOT, env: process.env });
  for (const c of tried) {
    if (fs.existsSync(c.path)) return { ok: true, path: c.path, from: c.from, tried };
  }
  return { ok: false, path: tried[tried.length - 1].path, from: null, tried };
}

/**
 * What to tell a reader who has no interpreter: what wanted it, the one command
 * that supplies it, and every place that was looked in. A bare "not found" is
 * not something anybody can act on.
 * @param {string} what  the thing that needed it, e.g. "this run"
 * @param {{tried:{path:string, from:string}[]}} res  from sqlPython()
 */
export function noSqlPython(what, res) {
  return `${what} needs the SQL lane's python and there is none. Run \`cascade setup\` to build it, `
    + 'or set CASCADE_PYTHON to an interpreter that already has sqlglot.\n'
    + res.tried.map((c) => `  looked in ${c.path} (${c.from})`).join('\n');
}

// Scratch directories that survive no exit path. Every `.analyze-*` this
// process creates is removed when the process ends, however it ends — the
// calibration gate exits 3 from inside the run, and a `finally` never sees it.
export const SCRATCH = makeScratch({
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  rm: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  onExit: (handler) => process.on('exit', handler),
  warn: (line) => process.stderr.write(line + '\n'),
});

// Locate a JDK (javac+java) for the Java lane. The ORDER lives in
// src/core/doctor.mjs (`jdkCandidateDirs`) so `cascade doctor` reports the same
// search this runs — one lookup, two readers (SPEC §17.9).
// Returns {javac, java, via} or null.
export function findJdk(env = process.env) {
  for (const { dir, via } of jdkCandidateDirs(env)) {
    const javac = path.join(dir, 'javac');
    const java = path.join(dir, 'java');
    if (fs.existsSync(javac) && fs.existsSync(java)) return { javac, java, via };
  }
  // Fall back to PATH resolution (execFileSync will search PATH for a bare name).
  try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); return { javac: 'javac', java: 'java', via: 'PATH' }; }
  catch { return null; }
}

// Working-tree files that differ from the pack's base commit: tracked
// modifications (diff vs base) plus untracked files. Repo-root-relative paths.

/** `git -C dir …` as text, or null when git fails / this is not a repo. */
export function gitText(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8');
  } catch { return null; }
}

/** Split a `-z` (NUL-separated) git list into non-empty entries. */
export function splitZ(raw) {
  return raw == null ? [] : raw.split(String.fromCharCode(0)).filter((s) => s.length > 0);
}

// The impure half of discovery (src/core/discover.mjs is pure and takes these).
export const DISCOVER_IO = {
  readDir: (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() })),
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  gitHead: (dir) => {
    try {
      return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    } catch { return null; }
  },
};

// The registry identifies a project by its `.cascade/` directory, so the SAME
// directory must always be spelled the same way. path.resolve() does not follow
// symlinks (on macOS /var is a link to /private/var, and a --root given through
// one spelling would otherwise register as a second project), so resolve links
// here, at the filesystem edge. A path that does not exist is returned as given.
export function realPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * The `.cascade/` layout for an already-resolved project. `resolveProject` hands
 * back the directory itself; `projectPaths` wants the root beside it.
 */
export function catalogPathsOf(dotCascadeDir) {
  return projectPaths(path.dirname(dotCascadeDir));
}

// The environment variable `cascade catalog fetch` reads the DB password from
// unless --password-env names another. Mirrors catalog_live.py's default.
export const DEFAULT_PASSWORD_ENV = 'CASCADE_DB_PASSWORD';

/**
 * Every *.xml under the given directories (or the files themselves), sorted,
 * MINUS the ones this run reads past.
 *
 * `exclude` is the other database vendors' copies of a mapper this tree ships
 * once per vendor (RM56, `mappers.alternatives`). They are dropped HERE, in the
 * one place the lane's file list is built, so the worker, the shard keys and
 * the census can never disagree about which files the statement axis is made
 * of. Absolute paths, compared exactly.
 */
export function listMapperXml(dirs, exclude = []) {
  const skip = new Set((exclude ?? []).map((p) => path.resolve(p)));
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
    } else if (st.isFile() && p.endsWith('.xml') && !skip.has(p)) out.push(p);
  };
  for (const d of dirs) walk(d);
  return [...new Set(out)].sort();
}

export function projectIdFrom(...candidates) {
  for (const c of candidates) {
    const slug = typeof c === 'string' ? slugify(c) : null;
    if (slug) return slug;
  }
  return null;
}

/** The manifest beside a `.cascade/`, or null when there is none to read. */
export function manifestAt(dotCascade) {
  if (!dotCascade) return null;
  const file = path.join(dotCascade, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try { return loadManifest(file); } catch { return null; }
}

// Locate the project the command should act on (src/core/resolve.mjs decides;
// this only supplies the flags). `strictProject` is false for `analyze`, where
// --project has always also named the pack: an unregistered id there falls back
// to the root/cwd `.cascade/` with a visible note instead of failing.
export function resolveOrDie({ opt, die }, { strictProject = true } = {}) {
  const args = { pack: opt('pack'), project: opt('project'), root: opt('root'), cwd: process.cwd(), env: process.env };
  try {
    return resolveProject(args);
  } catch (e) {
    if (strictProject) die(e.message);
    process.stderr.write(`${e.message}\n  -> continuing with the local .cascade/ (the name is used for the pack only)\n`);
    return resolveProject({ ...args, project: undefined });
  }
}
