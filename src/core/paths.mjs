// paths.mjs — the two-tier storage model (SPEC §5).
//
// Two physically separate tiers, plus the tool home:
//   1. Durable per-project state lives next to the manifest, under `.cascade/`
//      (small; human-revisited; some of it trackable in git).
//   2. Regenerable, content-addressed cache lives OUTSIDE the project tree, under
//      $XDG_CACHE_HOME/cascade/<projectId>/cas/ (large; sha256-named; disposable).
//   3. The tool home (~/.cascade) holds the registry and global config.
//
// SPEC §5 rules honored here:
//  - `.cascade/` sits beside the manifest — repo root for a single repo, the
//    workspace folder for a multi-repo project. This module never assumes cwd;
//    every path derives from an explicit `projectRoot`/`manifestFilePath`.
//  - The big regenerable cache is always kept out of the source tree (§5.1).
//  - Content-addressed naming (`<kind>-<digest12>`) is delegated to canonical.mjs
//    so digests never depend on absolute paths / time / machine (§2.1).
//  - `cascade init` writes `.cascade/.gitignore` so the SQL-bearing pack and the
//    DB catalog snapshot are ignored by default — privacy enforced in code (§5.1,
//    §17.1), not merely documented.
//
// This module is pure path computation. The ONE exception is `ensureProjectDirs`,
// which is the only export that touches the filesystem; it is kept obviously apart.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { artifactDirName } from './canonical.mjs';

// A project id names a cache directory outside the tree; keep it filesystem-safe
// and lower-case so the same project resolves to the same cache on any platform.
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The Cascade tool home. Holds registry.json and config.json (SPEC §5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path to the home directory
 */
export function homeDir(env = process.env) {
  const override = env.CASCADE_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), '.cascade');
}

/**
 * WHERE THE SQL LANE'S INTERPRETER MAY LIVE, in the order a run tries them.
 *
 * The lane is a Python program (sqlglot), so it needs an interpreter that has
 * sqlglot in it. There are three honest places for one, and the order is the
 * order of decreasing explicitness:
 *
 *   1. `CASCADE_PYTHON`, when the reader has said which interpreter to use.
 *   2. `<engine>/.venv`, the development checkout's own — what the setup page
 *      has always told a contributor to build, and what CI builds.
 *   3. `<cascade home>/venv`, which is where `cascade setup` puts it when the
 *      engine is not a checkout. An installed copy lives inside a package
 *      directory that the next upgrade replaces, so a virtual environment built
 *      there would vanish with it; the tool home belongs to the reader.
 *
 * Pure: it returns candidates. The caller looks at the filesystem.
 *
 * @param {{engineRoot:string, env?:NodeJS.ProcessEnv}} a
 * @returns {{path:string, from:string}[]}
 */
export function sqlPythonCandidates({ engineRoot, env = process.env }) {
  const out = [];
  if (typeof env.CASCADE_PYTHON === 'string' && env.CASCADE_PYTHON.length > 0) {
    out.push({ path: env.CASCADE_PYTHON, from: 'CASCADE_PYTHON' });
  }
  out.push({ path: path.join(engineRoot, '.venv', 'bin', 'python'), from: "this checkout's own .venv" });
  out.push({ path: path.join(homeDir(env), 'venv', 'bin', 'python'), from: 'the tool home, where `cascade setup` builds one' });
  return out;
}

/**
 * Where `cascade setup` BUILDS the interpreter it is asked for. A checkout gets
 * `<engine>/.venv`, which is the path every document and the CI workflow
 * already name; anything else gets the tool home, which survives an upgrade.
 * @param {{engineRoot:string, isCheckout:boolean, env?:NodeJS.ProcessEnv}} a
 * @returns {string} the virtual environment directory
 */
export function sqlVenvTarget({ engineRoot, isCheckout, env = process.env }) {
  return isCheckout ? path.join(engineRoot, '.venv') : path.join(homeDir(env), 'venv');
}

/**
 * The regenerable, content-addressed cache root for one project — always OUTSIDE
 * the project tree (SPEC §5.1). Base is `$XDG_CACHE_HOME` or `~/.cache`, then
 * `cascade/<projectId>`.
 * @param {string} projectId  must match ^[a-z0-9][a-z0-9._-]*$
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path to the project cache root
 */
export function cacheDir(projectId, env = process.env) {
  assertProjectId(projectId);
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'cascade', projectId);
}

/**
 * Path to the home registry.json (SPEC §5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function registryPath(env = process.env) {
  return path.join(homeDir(env), 'registry.json');
}

/**
 * Path to the home config.json (SPEC §5).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function configPath(env = process.env) {
  return path.join(homeDir(env), 'config.json');
}

/**
 * The `.cascade/` directory that sits beside the manifest for a project.
 * @param {string} projectRoot  repo root (single repo) or workspace folder (multi-repo)
 * @returns {string}
 */
export function dotCascade(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new PathsError('projectRoot must be a non-empty string');
  }
  return path.join(projectRoot, '.cascade');
}

/**
 * The durable per-project paths under `.cascade/` (SPEC §5). All are computed;
 * nothing is created (use `ensureProjectDirs` for that).
 * @param {string} projectRoot
 * @returns {{root:string, manifest:string, profile:string, pack:string, golden:string, calibration:string, catalog:string, catalogSnapshot:string, receipt:string, runlog:string, gitignore:string}}
 */
export function projectPaths(projectRoot) {
  const root = dotCascade(projectRoot);
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    // SPEC §6.2 gives the profile's SHAPE in YAML; JSON is that same shape in
    // the form a dependency-free engine can read (§4 — no YAML parser in core),
    // so `cascade init` writes profile.json. loadProfile still rejects .yaml
    // explicitly rather than pretending to parse it.
    profile: path.join(root, 'profile.json'),
    pack: path.join(root, 'pack'),
    golden: path.join(root, 'golden'),
    calibration: path.join(root, 'calibration'),
    catalog: path.join(root, 'catalog', 'columns.jsonl'),
    // The provenance of the catalog above when it came from a live DB: dialect,
    // server version and identity, fetch time, and the sha256 of columns.jsonl
    // (SPEC §12.3, §17.2). It sits in the SAME gitignored `catalog/` directory,
    // because it names a host the user may not want published either.
    catalogSnapshot: path.join(root, 'catalog', 'snapshot.json'),
    receipt: path.join(root, 'receipt.json'),
    runlog: path.join(root, 'runlog.json'),
    gitignore: path.join(root, '.gitignore'),
  };
}

/**
 * The content-addressed artifact directory for one artifact, inside the project
 * cache: `<cacheDir>/cas/<kind>-<digest12>` (SPEC §5.1). The name is derived from
 * content only — never from paths/time/machine (§2.1) — via canonical.mjs.
 * @param {string} projectId
 * @param {string} kind  e.g. "javafacts", "edges", "graphmodel"
 * @param {unknown} contentValue  the artifact content (or a digest-bearing summary)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function casPath(projectId, kind, contentValue, env = process.env) {
  return path.join(cacheDir(projectId, env), 'cas', artifactDirName(kind, contentValue));
}

/**
 * The same directory as `casPath`, addressed by a key that was ALREADY computed
 * (SPEC §5.1). The incremental core (src/core/facts_store.mjs) derives a shard key
 * from things the artifact's own bytes do not contain — the producing worker's
 * version, the file's path, the catalog digest — so it cannot hand the content
 * itself to `casPath`; it hands the finished key here instead. Same layout,
 * `<cacheDir>/cas/<kind>-<key>`, so both spellings address one store.
 * @param {string} projectId
 * @param {string} kind
 * @param {string} key  lower-case hex, 6-64 chars (as produced by digest12/sha256)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function casDir(projectId, kind, key, env = process.env) {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new PathsError(`invalid artifact kind: ${JSON.stringify(kind)}`);
  if (typeof key !== 'string' || !/^[0-9a-f]{6,64}$/.test(key)) {
    throw new PathsError(`invalid content key ${JSON.stringify(key)}. Expected 6-64 lower-case hex chars`);
  }
  return path.join(cacheDir(projectId, env), 'cas', `${kind}-${key}`);
}

/**
 * The project's OWN state directory, as a root-relative prefix — or null when
 * `.cascade/` does not sit under the analyzed root at all.
 *
 * `cascade init` writes manifest.json, profile.json and later the calibration
 * and golden files INTO the tree, so git reports them as changed from the very
 * first run. They are not source: listing them as "changed but not in the
 * graph" is noise on every answer, and treating one as an edit would be wrong.
 * Both the working-tree overlay and the plain `git diff` path filter with this,
 * so the two can never disagree about what counts as a changed file.
 *
 * Both arguments must already be resolved the same way (symlinks included) —
 * that is the caller's job, at the filesystem edge.
 *
 * @param {string} rootAbs        the analyzed root
 * @param {string} dotCascadeAbs  that project's `.cascade/`
 * @returns {string|null} e.g. `.cascade`, or `sub/.cascade`, or null
 */
export function ownStateDirRel(rootAbs, dotCascadeAbs) {
  if (typeof rootAbs !== 'string' || rootAbs.length === 0) return null;
  if (typeof dotCascadeAbs !== 'string' || dotCascadeAbs.length === 0) return null;
  const rel = path.relative(rootAbs, dotCascadeAbs).split(path.sep).join('/');
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/** Whether a root-relative path is inside the project's own `.cascade/`. */
export function isOwnStatePath(relPath, ownDirRel) {
  if (!ownDirRel || typeof relPath !== 'string') return false;
  const p = relPath.split('\\').join('/');
  return p === ownDirRel || p.startsWith(ownDirRel + '/');
}

/** The same filter over a list, kept in one place so both callers agree. */
export function withoutOwnState(relPaths, ownDirRel) {
  return (relPaths ?? []).filter((p) => !isOwnStatePath(p, ownDirRel));
}

/**
 * The exact text `cascade init` writes into `.cascade/.gitignore`.
 *
 * Ignores what carries user business logic or secrets: `pack/` (SQL source
 * text — SPEC §5.1/§17.1), `catalog/` (DB catalog snapshot, column comments),
 * and any `*.env` (connection env files — §17.3). Everything else under
 * `.cascade/` — manifest.json, profile.json, golden/, calibration/ — stays
 * trackable by NOT being listed here (git tracks by default).
 * @returns {string} newline-terminated gitignore body
 */
export function gitignoreBody() {
  return [
    '# Written by `cascade init`. Do not hand-edit.',
    '# Ignore what carries SQL source text, business logic, or secrets.',
    '# Left trackable (intentionally NOT ignored): manifest.json, profile.json,',
    '# golden/, calibration/.',
    'pack/',
    'catalog/',
    '*.env',
    '',
  ].join('\n');
}

/**
 * FILESYSTEM-WRITING export (the only one). mkdir -p the durable `.cascade/`
 * dirs and write `.cascade/.gitignore` (from `gitignoreBody()`) if it is absent —
 * an existing one is never overwritten. Returns the same shape as `projectPaths`.
 * @param {string} projectRoot
 * @returns {ReturnType<typeof projectPaths>}
 */
export function ensureProjectDirs(projectRoot) {
  const p = projectPaths(projectRoot);
  // The durable directories (§5). The regenerable cache lives elsewhere and is
  // created lazily by whoever writes CAS artifacts — never here.
  for (const dir of [p.root, p.pack, p.golden, p.calibration, path.dirname(p.catalog)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(p.gitignore)) {
    fs.writeFileSync(p.gitignore, gitignoreBody(), 'utf8');
  }
  return p;
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw new PathsError(
      `invalid projectId ${JSON.stringify(projectId)}. It must match ${PROJECT_ID_RE}`,
    );
  }
}

export class PathsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathsError';
  }
}
