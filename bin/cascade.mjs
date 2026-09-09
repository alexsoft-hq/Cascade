#!/usr/bin/env node
// cascade — CLI. A thin shell over src/core and src/mcp:
//   cascade init [--root <dir>] [--project <id>] [--force] [--json]
//       discover the tree, write `.cascade/manifest.json` + `profile.json` +
//       `.gitignore`, and register the project in ~/.cascade/registry.json.
//   cascade analyze [--ddl <f|glob>...|--no-ddl] [--mappers <dir>...|--no-mappers]
//                   [--java-src <dir>...|--no-java] [--web-src <dir>...|--no-web]
//                   [--cold|--incremental]
//       run the lanes end to end and write a pack into the project's `.cascade/`.
//       Every input is optional: what no flag names comes from the project's
//       manifest + profile + discovery, and a lane with no input is DECLARED
//       missing in `pack.meta.axes` instead of killing the run (SPEC §10.4).
//       `--no-<lane>` switches a lane off even when the project would supply it.
//       An unflagged run reads MAIN java sources only; the test roots it left
//       out are named on the lane line, and --java-src still analyzes one.
//       The WEB lane (--web-src) reads a frontend, traces each HTTP call to the
//       client that sends it and attaches it to the route this pack serves, as
//       a CALLS_HTTP edge. Route declarations are still recorded and not turned
//       into screens; the axis says which of the two you have.
//       The run is INCREMENTAL whenever a previous `facts-index.json` and its
//       content-addressed shards are both present and still apply; otherwise it
//       is cold AND SAYS WHY. `--cold` forces a full recompute, `--incremental`
//       only asks for one (an impossible one still runs cold, out loud).
//   cascade estimate [--root <dir>] [--project <id>] [--json]
//       the coverage estimate: which axes will ship / degrade / not ship on this
//       tree, and — when a pack exists — the measured EXACT-answerable share.
//   cascade verify [--project|--root|--pack]
//       recompute the deployment receipt (SPEC §14.4) from the files on disk and
//       refuse it on any disagreement or on expiry — exit 4, never a partial pass.
//   cascade golden <propose|approve|seal|check> [--project|--root|--pack]
//       the project golden corpus (SPEC §14.1): the tool proposes candidates, a
//       HUMAN approves them, a hash decides which are held out, and `check`
//       scores the approved ones through the shipped MCP tools.
//   cascade catalog discover|fetch [--root <dir>] [--candidate <n>] [--yes]
//       the DB catalog adapter (SPEC §12): `discover` lists where a database
//       might be, redacted, connecting to nothing; `fetch` opens ONE read-only
//       connection — after showing the exact target and being told `--yes` —
//       and pins the result as a snapshot with provenance. Analysis then reads
//       that file and never connects (§2.3).
//   cascade pack --catalog <f> --lineage <f> --out <dir> [--project NAME]
//       build a content-addressed pack from SQL-lane outputs (catalog + lineage
//       JSONL) and write it to <dir>/pack.json.
//   cascade mcp | view [--pack <dir> | --project <id>... | --root <dir>]
//                      [--memory-budget <MB>]
//       serve the tool catalog over stdio (mcp) or HTTP (view). With no
//       --pack/--root/--project every project in ~/.cascade/registry.json is
//       served, lazily: a pack is parsed on the first call that needs it and the
//       loaded ones are held in an LRU under the memory budget (default 512 MB
//       of pack JSON). A call then names its project (`project` argument, or
//       ?project= over HTTP); on a multi-project server one that does not is
//       answered `ambiguous`, never guessed.
//   cascade impact [--pack <dir> | --project <id> | --root <dir>]
//       query one pack from the shell; the project is located by src/core/resolve.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';
import { readHar, addHarFacts } from '../src/adapters/har_bridge.mjs';
import { readOtelTrace, addRuntimeFacts, otelMethodsInclude } from '../src/adapters/runtime_bridge.mjs';
import { addOpenApiRoutes, readOpenApiDocument } from '../src/adapters/openapi_bridge.mjs';
import { addJpaFacts, nativeQueryStatements } from '../src/adapters/jpa_bridge.mjs';
import { annotationMapperXml, restampToJavaSource } from '../src/adapters/mybatis_annotation.mjs';
import { addMybatisPlusFacts, wrapperFragmentStatements } from '../src/adapters/mp_bridge.mjs';
import { assembleGraph } from '../src/core/assemble.mjs';
import { projectPack, loadPack, PACK_SCHEMA } from '../src/core/pack.mjs';
import { discover, isWebSourceFile, routerDependencyOf } from '../src/core/discover.mjs';
import { buildManifest, buildProfile, writeInitFiles, writeStateFile, catalogSignpost, lanesOf, slugify } from '../src/core/init.mjs';
import { validateManifest, loadManifest } from '../src/core/manifest.mjs';
import { normalizeProfile, validateProfile, loadProfile, profileDiagnostics, sqlDialectOf, trustGapsFor, PROFILE_DEFAULTS } from '../src/core/profile.mjs';
import { selectLanes, sqlLaneArgs, declareAxes, screenAxisOf, serviceNamesOf } from '../src/core/lanes.mjs';
import { buildEstimate } from '../src/core/estimate.mjs';
import { buildChangeset, changedFiles } from '../src/core/changeset.mjs';
import { overlaySession, shortSessionId } from '../src/core/overlay_session.mjs';
import { overlayGraph, classifyDirtyFiles } from '../src/core/overlay.mjs';
import { runOverlayLanes, ephemeralIo, OverlayStaleError } from '../src/core/overlay_lanes.mjs';
import { planIncremental, underAny, MODE_COLD } from '../src/core/invalidate.mjs';
import {
  createFactsStore, nodeFactsIo, validateIndex, serializeIndex, webFactsSummary,
  catalogDigestOf as catalogDigestForShards,
} from '../src/core/facts_store.mjs';
import { runLanesWithShards, runLineageForStatements, INCREMENTAL_ENGINE_VERSION } from '../src/core/incremental.mjs';
import { workerVersions, CATALOG_LIVE_WORKER_VERSION } from '../src/core/worker_versions.mjs';
import { ensureProjectDirs, projectPaths, registryPath, cacheDir, ownStateDirRel, isOwnStatePath, withoutOwnState, sqlPythonCandidates, sqlVenvTarget } from '../src/core/paths.mjs';
import {
  calibrationMetrics, enginePrint, isEngineSourcePath, pinOf, profileDigestOf,
  sealBaseline, gateStateOf, gateEvaluate, gateLine, validateBaseline, sqlLaneTallies,
} from '../src/core/calibration.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { buildDoctorReport, formatDoctorTable, jdkCandidateDirs } from '../src/core/doctor.mjs';
import {
  proposeCases, approveCases, sealCases, checkCases, parseCases, serializeCases,
  inventoryOf, RELATIONS, MIN_CASES,
} from '../src/core/golden.mjs';
import { buildReceipt, verifyReceipt, receiptTtlDaysOf, RECEIPT_FILES } from '../src/core/receipt.mjs';
import { catalogDigestOf } from '../src/core/facts_store.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { readRegistry, upsertProject, writeRegistryAtomic, findProject, projectIds } from '../src/core/registry.mjs';
import {
  AGENT_CLIENTS, codexTomlBlock, filesFor, mcpServerEntry, mergeManagedBlock, mergeMcpConfig,
} from '../src/core/agent_setup.mjs';
import { describeCandidate, parseConnectionUrl, DEFAULT_PORTS, CONNECTION_DIALECTS } from '../src/core/dbconfig.mjs';
import {
  credentialsPath, serverKey, findPassword, listCredentials,
  setCredential, removeCredential, modeVerdict, isInside, CredentialsError,
} from '../src/core/credentials.mjs';
import { resolveProject, registrationTarget } from '../src/core/resolve.mjs';
import { makeScratch } from '../src/core/scratch.mjs';
import { toolList, callTool } from '../src/mcp/catalog.mjs';
import { serve } from '../src/mcp/stdio.mjs';
import { serveHttp } from '../src/mcp/http.mjs';
import { createProjectHost, packDirOf, DEFAULT_BUDGET_MB } from '../src/mcp/projects.mjs';
import { buildRoutesIndex, serializeRoutesIndex, ROUTES_FILE } from '../src/mcp/federation.mjs';
import { readSourceFor } from '../src/viewer/source.mjs';
import http from 'node:http';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const optAll = (name) => argv.reduce((acc, a, i) => (a === `--${name}` && i + 1 < argv.length ? [...acc, argv[i + 1]] : acc), []);
const flag = (name) => argv.includes(`--${name}`);
const die = (m) => { process.stderr.write(m + '\n'); process.exit(2); };
const jsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const parseJsonl = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
function sqlPython() {
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
function noSqlPython(what, res) {
  return `${what} needs the SQL lane's python and there is none. Run \`cascade setup\` to build it, `
    + 'or set CASCADE_PYTHON to an interpreter that already has sqlglot.\n'
    + res.tried.map((c) => `  looked in ${c.path} (${c.from})`).join('\n');
}

// Scratch directories that survive no exit path. Every `.analyze-*` this
// process creates is removed when the process ends, however it ends — the
// calibration gate exits 3 from inside the run, and a `finally` never sees it.
const SCRATCH = makeScratch({
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  rm: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  onExit: (handler) => process.on('exit', handler),
  warn: (line) => process.stderr.write(line + '\n'),
});

// Locate a JDK (javac+java) for the Java lane. The ORDER lives in
// src/core/doctor.mjs (`jdkCandidateDirs`) so `cascade doctor` reports the same
// search this runs — one lookup, two readers (SPEC §17.9).
// Returns {javac, java, via} or null.
function findJdk(env = process.env) {
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
// Returns [] when there is no git base or git fails (the overlay then declines).
function gitChangedFiles(base, ownDirRel = null) {
  if (!base || !base.repoPath || !base.commit) return [];
  const run = (args) => {
    try { return execFileSync('git', ['-C', base.repoPath, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8'); }
    catch { return ''; }
  };
  const tracked = run(['diff', '--name-only', base.commit, '--']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  const set = new Set();
  for (const line of (tracked + '\n' + untracked).split('\n')) { const f = line.trim(); if (f) set.add(f); }
  // The engine's own `.cascade/` is not source. The overlay has always excluded
  // it; this path (used by `--mode base-only` and by `ctx.changedFiles`) does the
  // same, through the SAME helper, so the two cannot describe different diffs.
  return withoutOwnState([...set].sort(), ownDirRel);
}

/** The `.cascade/` a served pack belongs to, as a path relative to its repo. */
function ownStateOf(base, packDir) {
  if (!base || !base.repoPath) return null;
  return ownStateDirRel(realPath(base.repoPath), path.dirname(realPath(packDir)));
}

// ---------------------------------------------------------------------------
// The LIVE working-tree overlay (SPEC §10, RM4/M7)
// ---------------------------------------------------------------------------
// `gitChangedFiles` above answers "which files did you touch" and the base pack
// answers what they touched BEFORE the edit. This builds the other half: the
// dirty files are re-parsed and a new in-memory graph is assembled from the
// cached shards of everything else, so `changed_impact` describes the bytes on
// disk. Nothing is written — not the pack, not the fact cache (§10.1 MUST NOT).
//
// This function is the IMPURE edge only: git, the filesystem and the two worker
// invocations. Every decision — the session id, the stale rule, which lane
// claims a file, what counts as provisional — is in src/core/overlay*.mjs.

/**
 * A provider `() => overlayState` for the tool context, plus the reason it
 * could not be built. The provider is called ONCE PER REQUEST (the working tree
 * moves between calls) and memoizes on the overlaySessionId: repeated calls with
 * the same dirty bytes cost one git diff and a few hashes.
 */
function makeOverlayProvider({ packDir, pack, baseGraph, profile }) {
  const indexFile = path.join(packDir, 'facts-index.json');
  const stale = (msg) => { throw new OverlayStaleError(`${msg}. Run \`cascade analyze\` to rebuild the pack and its fact cache`); };

  let index = null;
  const load = () => {
    if (index) return index;
    if (!fs.existsSync(indexFile)) stale(`no fact index at ${indexFile}: this pack was built before the incremental core, so its shards are not on disk`);
    try { index = validateIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8'))); }
    catch (e) { stale(`the fact index at ${indexFile} is unusable (${e.message})`); }
    if (index.engineVersion !== INCREMENTAL_ENGINE_VERSION) {
      stale(`the fact index was written by ${index.engineVersion}, this engine is ${INCREMENTAL_ENGINE_VERSION}`);
    }
    const now = workerVersions();
    for (const name of Object.keys(now)) {
      if (index.workers?.[name] !== now[name]) {
        stale(`the ${name} worker changed (${index.workers?.[name] ?? 'unrecorded'} -> ${now[name]}), so the cached shards are a different generation`);
      }
    }
    return index;
  };

  let cache = null; // single-entry LRU: {id, state}
  let jdk = null;

  return () => {
    const idx = load();
    const rootAbs = idx.root;
    const baseCommit = pack.meta?.base?.commit ?? idx.base?.commit ?? null;
    if (!baseCommit) stale('the pack records no base commit, so there is nothing to diff the working tree against');
    if (!fs.existsSync(rootAbs)) stale(`the analyzed root ${rootAbs} is gone`);

    // ---- what differs from the base commit, right now --------------------
    const gitTopRaw = ((gitText(rootAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
    if (!gitTopRaw) stale(`${rootAbs} is not inside a git repository, so the working-tree diff cannot be read`);
    const gitTop = realPath(gitTopRaw);
    const headCommit = ((gitText(rootAbs, ['rev-parse', 'HEAD']) ?? '').trim()) || null;
    // A path OUTSIDE the analyzed root is normally not an input to this analysis
    // and is dropped. The web lane is the exception: `--web-src ../front/src` is
    // the common case, so a path under a declared web root is kept, `../` and
    // all, exactly as the fact index records it.
    const webRootsRel = idx.selection?.webRoots ?? [];
    const toRootRel = (repoRelPath) => {
      const rel = path.relative(rootAbs, path.resolve(gitTop, repoRelPath));
      if (path.isAbsolute(rel)) return null;
      const posix = rel.split(path.sep).join('/');
      if (!posix.startsWith('..')) return posix;
      return underAny(posix, webRootsRel) ? posix : null;
    };
    const raw = gitText(rootAbs, ['diff', '--name-status', '-z', baseCommit, '--']);
    // ONE diff parser for the whole engine (src/core/changeset.mjs): an UNKNOWN
    // changeset is never silently an empty list.
    const cs = buildChangeset({ repo: rootAbs, fromCommit: raw == null ? null : baseCommit, toCommit: headCommit ?? 'WORKING-TREE', rawNameStatusZ: raw });
    if (cs.status !== 'OK') {
      return declined(`the working-tree diff against ${baseCommit.slice(0, 12)} could not be read (${cs.reason}). That commit may no longer be in this repository`, { headCommit, baseCommit });
    }
    // The engine's OWN directory is not source. `cascade init` writes
    // `.cascade/manifest.json` and friends into the tree, so git reports them as
    // changed on the very first run; listing them as "impact unknown" on every
    // answer would be noise, and treating them as an edit would be wrong.
    const dotRel = ownStateDirRel(rootAbs, path.dirname(realPath(packDir)));
    const isOwnState = (p) => isOwnStatePath(p, dotRel);
    const byPath = new Map();
    for (const f of changedFiles(cs)) {
      const p = toRootRel(f.repoPath);
      if (p !== null && !isOwnState(p)) byPath.set(p, f.status);
    }
    for (const p of splitZ(gitText(rootAbs, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])).map(toRootRel)) {
      if (p !== null && !isOwnState(p)) byPath.set(p, 'A');
    }
    // A file the PACK read in a dirty state is not described by baseCommit, so
    // `git diff baseCommit` cannot see it move back. It is dirty by definition.
    for (const p of pack.meta?.base?.dirtyFiles ?? []) {
      if (!byPath.has(p)) byPath.set(p, fs.existsSync(path.resolve(rootAbs, p)) ? 'M' : 'D');
    }
    // A FRONTEND OUTSIDE THE ANALYZED ROOT is scanned WHERE IT IS, and it has
    // to be: `--web-src ../front/src` is the common case, and neither command
    // above reaches it.
    //
    //  - a file git has never seen is only listed for the directory the command
    //    RUNS IN, so `ls-files --others` at the analyzed root cannot see a new
    //    `.vue` beside it. That is true whether the frontend is a repository of
    //    its own or another directory of this one, so this scan runs for both,
    //    from the web root;
    //  - a TRACKED change in a SEPARATE repository needs its own diff as well:
    //    a diff of the backend's root reports nothing about another repository,
    //    and there is no commit the two share, so that root is diffed against
    //    ITS OWN HEAD. In the same repository the diff above already covered it.
    //
    // Without this an edited or new file over there would be invisible and the
    // overlay would answer from the base shards while calling itself fresh, and
    // the session id would not move when the frontend did.
    for (const rel of webRootsRel) {
      if (!rel.startsWith('../')) continue;
      const dirAbs = path.resolve(rootAbs, rel);
      if (!fs.existsSync(dirAbs)) continue;
      const topRaw = ((gitText(dirAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
      if (!topRaw) continue;
      const top = realPath(topRaw);
      const toRel = (repoRelPath) => path.relative(rootAbs, path.resolve(top, repoRelPath)).split(path.sep).join('/');
      const names = [
        ...splitZ(gitText(dirAbs, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])),
        ...(top === gitTop ? [] : splitZ(gitText(dirAbs, ['diff', '--name-only', '-z', 'HEAD', '--']))),
      ].map(toRel);
      for (const p of names) {
        if (!underAny(p, [rel])) continue;
        if (!byPath.has(p)) byPath.set(p, fs.existsSync(path.resolve(rootAbs, p)) ? 'M' : 'D');
      }
    }
    const entries = [...byPath.entries()].map(([p, status]) => ({ path: p, status })).sort((a, b) => (a.path < b.path ? -1 : 1));

    const session = overlaySession({
      baseDigest: pack.digest,
      baseCommit,
      headCommit,
      dirtyFiles: entries.map((e) => ({
        path: e.path,
        sha256: e.status === 'D' ? null : safeHash(path.resolve(rootAbs, e.path)),
      })),
    });
    const dirtyFiles = entries.map((e) => e.path);

    if (cache && cache.id === session.overlaySessionId) return cache.state;

    // A clean tree needs no overlay at all: the pack already describes this
    // commit, so the answer is the certified base and the verdict is `current`
    // (§10.3) rather than a provisional one computed over nothing.
    if (entries.length === 0 && session.state === 'fresh') {
      return remember(session, {
        applied: false, state: 'clean', session, dirtyFiles: [],
        reason: `the working tree matches ${baseCommit.slice(0, 12)}, the commit this pack was built from, so there is nothing to overlay`,
        limits: [],
      });
    }

    // ---- the two ways an overlay does not happen -------------------------
    if (session.state !== 'fresh') {
      return remember(session, {
        applied: false, state: session.state, session, dirtyFiles,
        reason: `the pack was built at ${baseCommit.slice(0, 12)} but HEAD is now ${(headCommit ?? 'unknown').slice(0, 12)}, so the overlay is discarded rather than laid onto a base that has moved`,
        limits: [{ scope: 'overlay', reason: `HEAD moved past the pack's base commit; the answer below is the BASE pack's, not the working tree's. Run \`cascade analyze\` (it is incremental) to certify the new commit` }],
      });
    }
    const selection = idx.selection ?? {};
    // A pack built before this project had a frontend cannot answer a frontend
    // question: there are no web shards to lay an edit onto, and an overlay that
    // quietly skipped the lane would report "no impact" for an edited `.vue`.
    if ((selection.webRoots ?? []).length === 0 && (profile?.frameworkPacks ?? []).includes('web')) {
      return declined('this pack was built without a web lane, but the profile now declares the web framework pack, so a frontend edit has no facts to lay over', { headCommit, baseCommit });
    }
    const dirty = classifyDirtyFiles(entries, selection);
    if (dirty.ddl.length > 0) {
      return remember(session, {
        applied: false, state: 'declined', session, dirtyFiles,
        reason: `schema file changed (${dirty.ddl.join(', ')}), and catalog changes need a certified re-analysis`,
        limits: [{ scope: 'overlay', reason: `the DDL is dirty (${dirty.ddl.join(', ')}); a moved column changes what EVERY statement resolves to, so the overlay declines instead of answering over a stale catalog. Run \`cascade analyze\`` }],
      });
    }
    // The reading convention is folded into every SQL shard key. If it moved,
    // every statement would be recomputed inside a latency gate meant for one
    // file — decline out loud instead of taking minutes.
    const sqlArgs = sqlLaneArgs(profile ?? normalizeProfile({}));
    const nowArgs = [...sqlArgs.mybatisArgs, ...sqlArgs.lineageArgs];
    if (JSON.stringify(nowArgs) !== JSON.stringify(selection.sqlArgs ?? [])) {
      return remember(session, {
        applied: false, state: 'declined', session, dirtyFiles,
        reason: `the SQL reading convention changed since this pack was built (${JSON.stringify(selection.sqlArgs ?? [])} -> ${JSON.stringify(nowArgs)})`,
        limits: [{ scope: 'overlay', reason: 'the profile\'s SQL arguments no longer match the ones the pack was built with, so no cached statement applies. Run `cascade analyze`' }],
      });
    }

    // ---- run the lanes over the dirty files ------------------------------
    const absOf = (rel) => path.resolve(rootAbs, rel);
    const store = createFactsStore({ io: ephemeralIo(nodeFactsIo(fs)), projectId: idx.project, env: process.env });
    const mapperDirsAbs = (selection.mapperDirs ?? []).map(absOf);
    const ddlRels = selection.ddls ?? (selection.ddl ? [selection.ddl] : []);
    const ddlAbsList = ddlRels.map(absOf);
    const pyRes = sqlPython();
    const py = pyRes.path;
    const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
    const runpy = (script, args) => execFileSync(py, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
    const needPy = (what) => { if (!pyRes.ok) stale(noSqlPython(`the overlay must rerun ${what} and`, pyRes)); };
    const run = {
      java: (targets) => {
        if (!jdk) {
          jdk = findJdk();
          if (!jdk) stale('the overlay must re-parse Java but no JDK was found (set JAVA_HOME, or see docs/setup/java-lane.md)');
        }
        return runJavaLane(jdk, rootAbs, targets);
      },
      mybatis: () => { needPy('the MyBatis extractor'); return parseJsonl(runpy('mybatis_extract.py', ['--root', rootAbs, ...sqlArgs.mybatisArgs, ...mapperDirsAbs])); },
      lineage: (statements, catalogRecords) => {
        needPy('SQL lineage');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-'));
        try {
          const catFile = path.join(tmp, 'catalog.jsonl');
          const stmtFile = path.join(tmp, 'statements.jsonl');
          fs.writeFileSync(catFile, catalogRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
          fs.writeFileSync(stmtFile, statements.map((r) => JSON.stringify(r)).join('\n') + '\n');
          return parseJsonl(runpy('lineage.py', ['--catalog', catFile, '--statements', stmtFile, ...sqlArgs.lineageArgs]));
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      },
      catalog: () => { needPy('the DDL catalog'); return parseJsonl(runpy('catalog_ddl.py', ['--identifier-case', sqlArgs.identifierCase, ...ddlAbsList])); },
      web: (targets) => runWebLane(rootAbs, targets, { sourceRoots: (selection.webRoots ?? []).map(absOf), templateRoots: templateRootsAbs }),
      webConfigs: (roots) => runWebLane(rootAbs, roots, { configsOnly: true, sourceRoots: (selection.webRoots ?? []).map(absOf), templateRoots: templateRootsAbs }),
    };
    const webRootsAbs = (selection.webRoots ?? []).map(absOf);
    // The template roots the certified run used, read back from the fact index
    // so the overlay reads exactly the same set (RM48).
    const templateRootsAbs = (selection.templateRoots ?? [])
      .filter((t) => t && typeof t === 'object' && typeof t.root === 'string')
      .map((t) => ({ root: absOf(t.root), engine: t.engine, suffix: t.suffix }));

    const lanes = runOverlayLanes({
      index: idx, store, dirty, run, abs: absOf, hash: sha256File, workers: workerVersions(), webRootsAbs,
      templateRootsAbs,
      inputs: {
        mapperFiles: listMapperXml(mapperDirsAbs).map((p) => ({ rel: path.relative(rootAbs, p).split(path.sep).join('/'), abs: p })),
        ddlFiles: ddlRels.map((rel, i) => ({ rel, abs: ddlAbsList[i] })),
        dialect: sqlArgs.dialect, identifierCase: sqlArgs.identifierCase,
        defaultSchema: sqlArgs.defaultSchema,
        mybatisArgs: sqlArgs.mybatisArgs, lineageArgs: sqlArgs.lineageArgs,
        catalogArgs: [`identifier-case=${sqlArgs.identifierCase}`],
      },
    });
    const tBuild = Date.now();
    const built = overlayGraph({
      bridges: LANE_BRIDGES,
      baseShards: lanes.baseShards, dirtyFacts: lanes.dirtyFacts, dropFiles: lanes.dropFiles,
      webBaseShards: lanes.webBaseShards, webDirtyFacts: lanes.webDirtyFacts,
      webDropFiles: lanes.webDropFiles, webConfigRecords: lanes.webConfigRecords,
      // The web bridge's options come from the LIVE profile for the same reason
      // `generatedSources` does: the overlay describes the bytes on disk, and a
      // gateway route declared since the pack was built takes effect here first.
      // The SAME options the certified run used, screen axis included: an
      // overlay whose gate was off would report `touched.screens: []` on a file
      // the base pack does put on a screen, and the difference would read as
      // "your edit changed which screens exist".
      web: webRootsAbs.length > 0 || templateRootsAbs.length > 0
        ? {
          gatewayRoutes: profile?.gatewayRoutes ?? {},
          packages: [],
          // The gate is resolved the SAME way the certified run resolved it,
          // including the third state: `screenAxisOf` reads the frontend
          // packages this overlay reads, so an out-of-root frontend keeps its
          // screens here too.
          screenAxis: {
            ...(profile?.screenAxis ?? {}),
            enabled: screenAxisOf(profile, {
              webPackages: webPackagesRead(webRootsAbs),
              templateRoots: templateRootsAbs,
            }).enabled,
          },
          codeLength: profile?.moduleAttribution?.codeLength ?? null,
        }
        : null,
      catalogRecords: lanes.catalogRecords, lineageRecords: lanes.lineageRecords,
      baseGraph, overlaySessionId: session.overlaySessionId,
      dirtyFiles, packagePrefixes: selection.packagePrefixes ?? [],
      // From the LIVE profile, for the same reason `generatedSources` below is:
      // a gateway prefix declared since the pack was built takes effect here first.
      gatewayRoutes: profile?.gatewayRoutes ?? {},
      // Same identity rule as the run that built the base pack — the overlay
      // declines above when the SQL arguments (which carry it) have moved.
      identifierCase: sqlArgs.identifierCase,
      // From the LIVE profile, not the index: the fact index does not record a
      // generated-source declaration, and the overlay describes the bytes on
      // disk now. A declaration edited since the pack was built therefore takes
      // effect on the overlaid files first — visible in `limits` as a changed
      // skip count, never silently.
      generatedSources: profile?.generatedSources ?? { annotations: [], pathGlobs: [] },
    });
    const timingsMs = { ...lanes.timingsMs, build: Date.now() - tBuild };
    timingsMs.total = timingsMs.loadBase + timingsMs.java + timingsMs.web + timingsMs.sql + timingsMs.build;

    return remember(session, {
      applied: true, state: 'fresh', session, graph: built.graph,
      dirtyFiles, parsedFiles: lanes.parsedFiles, droppedFiles: lanes.dropFiles,
      parsedWebFiles: lanes.parsedWebFiles, droppedWebFiles: lanes.webDropFiles,
      webConfigFiles: dirty.webConfig,
      unmatched: dirty.other, provisional: built.provisional, taggedEdges: built.taggedEdges,
      reusedShards: lanes.reusedShards, javaStats: built.javaStats, webStats: built.webStats,
      timingsMs, limits: [],
    });
  };

  function remember(session, state) {
    cache = { id: session.overlaySessionId, state };
    return state;
  }
  function declined(reason, { headCommit, baseCommit }) {
    return { applied: false, state: 'declined', session: null, dirtyFiles: [], reason, limits: [{ scope: 'overlay', reason: `${reason}. Run \`cascade analyze\`` }], baseCommit, headCommit };
  }
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
function webPackagesRead(webRootsAbs) {
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

/** sha256 of a file that may have vanished between the diff and the hash. */
function safeHash(abs) {
  try { return sha256File(abs); } catch { return null; }
}

// The pack's own metadata, as the `overview` tool reads it back out of ctx:
// what this pack IS (project, digest, build time, lanes) and what it was built
// from. One helper, called identically by `mcp` and `view`, so the stdio server
// and the viewer can never describe the same pack differently.
function packMeta(pack) {
  return {
    project: pack.meta?.project ?? 'project',
    digest: pack.digest,
    builtAt: pack.meta?.builtAt ?? null,
    lanes: pack.meta?.lanes ?? null,
    base: pack.meta?.base ?? null,
    ddl: pack.meta?.ddl ?? null,
    // The identity rule this pack's names were matched under (SPEC §8.1), so a
    // tool argument can be resolved the way the analyzer resolved the same
    // spelling. Null on a pack built before the field existed: no fold.
    identifierCase: pack.meta?.identifierCase ?? null,
    // What this pack DECLARES it could and could not ship (SPEC §10.4), and the
    // lane tallies that no edge in the graph can carry (an unresolved call
    // leaves nothing behind — that is why it is counted at ingest).
    axes: pack.meta?.axes ?? null,
    laneStats: pack.meta?.laneStats ?? null,
  };
}

/**
 * The projects a SERVER serves (SPEC §13 MUST, §15 M8). Four ways to say it,
 * one order:
 *
 *   --pack <dir> / --root <dir>   ONE anonymous project, id from the pack meta
 *   --project a --project b       exactly those registry entries
 *   (nothing)                     every registered project, lazily
 *   (nothing, empty registry)     the local `.cascade/`, as one anonymous project
 *
 * Nothing here loads a pack: the entries are registry records, and the host
 * parses a pack only when a tool first asks that project a question.
 * @param {string} cmdName  for the error messages ("mcp" / "view")
 */
function servedEntries(cmdName) {
  const packFlag = opt('pack');
  const rootFlag = opt('root');
  const ids = optAll('project');
  if (packFlag || rootFlag) {
    if (ids.length) {
      die(`cascade ${cmdName}: --pack/--root serve ONE pack, so --project has nothing to select. `
        + 'Drop it, or drop --pack/--root and name the registered projects with --project');
    }
    return [anonymousEntry(resolveProject({ pack: packFlag, root: rootFlag, cwd: process.cwd(), env: process.env }))];
  }
  const regFile = registryPath(process.env);
  let reg;
  try { reg = readRegistry(regFile); } catch (e) { die(e.message); }
  if (ids.length) {
    return ids.map((id) => {
      const entry = findProject(reg, id);
      if (!entry) {
        die(`unknown project ${JSON.stringify(id)}: registered ids are ${projectIds(reg).join(', ') || '(none)'} (registry ${regFile})`);
      }
      return entry;
    });
  }
  if (reg.projects.length > 0) return reg.projects;
  const local = resolveProject({ cwd: process.cwd(), env: process.env });
  if (!fs.existsSync(path.join(local.packDir, 'pack.json'))) {
    die(`no project is registered in ${regFile}, and there is no pack at ${path.join(local.packDir, 'pack.json')}. `
      + 'Run `cascade init` then `cascade analyze`, or serve a built pack with --pack <dir>');
  }
  return [anonymousEntry(local)];
}

/**
 * WHO THIS RUN IS ABOUT, decided once (SPEC §5.1).
 *
 * The same id names the fact cache on disk and goes into `pack.meta.project`,
 * so a pack and the shards it was built from can never disagree about which
 * project they belong to. The order is the resolver's: an id the registry
 * already knows, then the project's own manifest, then `--project`, then the
 * name of the directory being analyzed. Each candidate is slugified, and
 * `slugify` returns null for anything that is not a legal id, so the first
 * usable one wins.
 *
 * null means no candidate produced a legal id. That is a real answer, not a
 * name to invent: the run then has no durable cache and the pack says so.
 *
 * @param {...(string|null|undefined)} candidates  in priority order
 * @returns {string|null}
 */
function projectIdFrom(...candidates) {
  for (const c of candidates) {
    const slug = typeof c === 'string' ? slugify(c) : null;
    if (slug) return slug;
  }
  return null;
}

/** The manifest beside a `.cascade/`, or null when there is none to read. */
function manifestAt(dotCascade) {
  if (!dotCascade) return null;
  const file = path.join(dotCascade, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try { return loadManifest(file); } catch { return null; }
}

/**
 * One served project that the registry does not name: a `--pack <dir>` (or a
 * local `.cascade/`) server. The id comes from the pack's own meta, so the
 * `project` argument still means something to a client. The pack is parsed once
 * here for that name and then dropped — the host re-reads it lazily, under the
 * memory budget, when a tool actually needs the graph.
 */
function anonymousEntry(resolved) {
  const file = path.join(resolved.packDir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run \`cascade analyze\` first`);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')).meta ?? {}; }
  catch (e) { die(`cannot read ${file}: ${e.message}`); }
  const id = resolved.projectId || slugify(String(meta.project ?? '')) || 'project';
  return {
    id,
    dotCascadePath: resolved.dotCascade,
    packDir: resolved.packDir,
    source: resolved.source,
    stack: meta.lanes ?? [],
    lastCertifiedAt: meta.builtAt ?? null,
  };
}

/**
 * Load ONE served project into a tool context: the graph, its basis, its
 * COMPUTED trust (SPEC §14.3), the pack metadata, the project's profile, the
 * live git diff and the live working-tree overlay. This is what the project
 * host calls on a cache miss, so `mcp` and `view` cannot describe the same
 * project differently. `packJson`/`packDir` ride along for the viewer's
 * /api/meta and /api/source; the tools never look at them.
 */
function loadServedProject(entry) {
  const dir = packDirOf(entry);
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack at ${file}. Run \`cascade analyze\` for project ${entry.id}`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pack.schema !== PACK_SCHEMA) throw new Error(`unexpected pack schema in ${file}: ${pack.schema}`);
  const graph = loadPack(pack, { verifyDigest: true });
  const prof = servedProfile(dir, pack);
  return {
    graph,
    basis: {
      // The id the CLIENT addressed (the registry id / the `project` argument),
      // not the name the pack happens to carry: on a server holding several
      // packs those names can collide — an older `analyze` stamped every pack
      // "project" — and then no answer would say which project it came from.
      // The pack's own declared name is not hidden; it rides along whenever it
      // differs, and `overview` relays it in answer.pack.project.
      project: entry.id,
      ...(pack.meta?.project && pack.meta.project !== entry.id ? { packProject: pack.meta.project } : {}),
      buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null,
      // Served from a static pack with no live source check: freshness is
      // unknown, never "current".
      freshness: { verdict: 'unknown' },
      // WHAT WAS OBSERVED RUNNING, and how much of it. Present only when a
      // trace was read, so its absence is "no trace" and never "a trace that
      // saw nothing". Every answer carries it for the same reason `freshness`
      // is carried: an `observed` mark on a row is only readable next to the
      // coverage it came from.
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    // COMPUTED (SPEC §14.3 MUST): this project's last gate verdict plus its
    // approved golden corpus. A bare `--pack` has no `.cascade/` to read and
    // computes from NO state — UNCERTIFIED with `no-calibration-state`.
    trust: computeTrust({ ...calibrationStateOf(entry.dotCascadePath ?? null), knownGaps: trustGapsFor(prof, pack.meta?.axes ?? null) }),
    limits: [],
    pack: packMeta(pack),
    profile: prof,
    changedFiles: () => gitChangedFiles(pack.meta?.base, ownStateOf(pack.meta?.base, dir)),
    overlay: makeOverlayProvider({ packDir: dir, pack, baseGraph: graph, profile: prof }),
    packJson: pack,
    packDir: dir,
  };
}

// THE ONE WIRING POINT (SPEC §4, I-3). `src/core/` imports nothing from
// `src/adapters/` — a lane is a plug-in, and the core is what it plugs into.
// The CLI is the layer that knows both sides, so this is where the bridges are
// handed to the core assembler (src/core/assemble.mjs). `analyze` and the
// working-tree overlay both take this object, which is also what stops the two
// from assembling a graph by two different routes. A test wires fakes instead.
const LANE_BRIDGES = Object.freeze({ buildGraphFromSql, addJavaFacts, addJpaFacts, addMybatisPlusFacts, addOpenApiRoutes, addWebFacts, addRuntimeFacts });

/** `--memory-budget <MB>` (default 512), as bytes of pack JSON (SPEC §17.6). */
function memoryBudgetBytes() {
  const raw = opt('memory-budget', String(DEFAULT_BUDGET_MB));
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) die(`--memory-budget must be a positive number of megabytes, got ${JSON.stringify(raw)}`);
  return Math.floor(mb * 1024 * 1024);
}

/**
 * The profile a SERVER answers with: the file the pack recorded at analyze time
 * when it is still there, else the profile beside the pack. Null when neither
 * exists — the query layer then falls back to its own defaults rather than
 * inventing a convention.
 */
function servedProfile(packDir, pack) {
  const candidates = [pack?.meta?.profile, path.join(packDir, '..', 'profile.json')].filter(Boolean);
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try { return loadProfile(f); } catch (e) { process.stderr.write(`profile ${f} ignored: ${e.message}\n`); }
  }
  return null;
}

/**
 * The profile a command reads: `--profile <file>`, else `<dotCascade>/profile.json`,
 * else the documented defaults. Never guesses a convention the project did not
 * write down — it says which of the three it used.
 */
function readProfile(dotCascade) {
  const explicit = opt('profile');
  if (explicit) {
    const file = path.resolve(explicit);
    try {
      return { profile: loadProfile(file), profileFile: file, profileNote: `profile: ${file} (--profile)` };
    } catch (e) { die(e.message); }
  }
  const file = dotCascade ? path.join(dotCascade, 'profile.json') : null;
  if (file && fs.existsSync(file)) {
    try {
      return { profile: loadProfile(file), profileFile: file, profileNote: `profile: ${file}` };
    } catch (e) { die(e.message); }
  }
  return {
    profile: normalizeProfile({}),
    profileFile: null,
    profileNote: `profile: none found${file ? ` at ${file}` : ''}, so we use the documented defaults `
      + `(no package prefixes, no schema default, catalog.source=${PROFILE_DEFAULTS.catalog.source}); run \`cascade init\` to write one`,
  };
}

// Compile adapters/java/JavaFacts.java into a build cache (only when stale) and
// run it over the given source roots. Returns parsed cascade:javafacts:1 records.
//
// The build directory is named after the WORKER SOURCE'S CONTENT and is
// published by an atomic rename, because several `cascade` processes can run at
// once (the test suite does exactly that) and a shared, mtime-keyed directory
// let two of them write the same .class files concurrently — the loser then ran
// a half-written class. Content-addressing also means a checkout that moves the
// worker back and forth never reuses the wrong generation.
function runJavaLane(jdk, root, srcRoots) {
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
/**
 * A list said in one line: the first five, then how many more.
 *
 * A run over a tree with a directory of vendored plugin scripts has thirteen
 * web roots, and thirteen lines saying the same thing is a wall a reader skips
 * rather than a finding. The count is always exact; only the names are cut.
 *
 * @param {string[]} items
 * @returns {string}
 */
function listOfFive(items) {
  const all = [...items];
  return all.length <= 5 ? all.join(', ') : `${all.slice(0, 5).join(', ')}, and ${all.length - 5} more`;
}

function runWebLane(root, targets, opts = {}) {
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
function expandDdlPatterns(patterns) {
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
function globFiles(pattern) {
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

/** The compiled worker for THIS source, compiling it first if nobody has yet. */
function javaWorkerBuildDir(jdk, src) {
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

// ---- the filesystem/git edge the incremental core is injected with ---------
// src/core/{invalidate,incremental,facts_store}.mjs are pure; these four small
// helpers are the only impure things they are handed.

/** sha256 of a file's BYTES (not its decoded text) — the shard keys' input. */
function sha256File(absPath) {
  return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

// ---- the calibration layer's impure edges (SPEC §14) -----------------------
// src/core/{calibration,trust,golden,receipt}.mjs are pure; these helpers are
// the filesystem they are handed.

const ENGINE_SKIP_DIRS = new Set(['node_modules', '.venv', '__pycache__', '.git', 'vendor']);

/** The engine's own sources, repository-relative and hashed, sorted by path. */
function engineSourceList() {
  const out = [];
  const walk = (absDir, rel) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ENGINE_SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile() && isEngineSourcePath(childRel)) out.push({ path: childRel, sha256: sha256File(childAbs) });
    }
  };
  for (const top of ['src', 'bin', 'adapters']) walk(path.join(ENGINE_ROOT, top), top);
  return out;
}

let ENGINE_PRINT_CACHE = null;
/** sha256 of THIS engine's sources — the fingerprint the gate splits modes on. */
function runningEnginePrint() {
  if (ENGINE_PRINT_CACHE === null) ENGINE_PRINT_CACHE = enginePrint({ files: engineSourceList() });
  return ENGINE_PRINT_CACHE;
}

/** The durable state directory of a resolved project (`.cascade/`, or the pack's parent). */
function stateDirOf(resolved, outDir) {
  if (resolved && typeof resolved.dotCascade === 'string' && resolved.dotCascade.length > 0) return resolved.dotCascade;
  return path.dirname(path.resolve(outDir));
}

/** Read + parse a JSON file, or null when it is not there. Throws on bad JSON. */
function readJsonOrNull(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** sha256 of a file's bytes, or null when the file is absent. */
function hashOrNull(file) {
  try { return sha256File(file); } catch { return null; }
}

/**
 * The calibration state a SERVER answers with: the last gate verdict and the
 * approved golden corpus. Both are read through the resolver's `.cascade/`;
 * a bare `--pack` has none, and the trust level then computes from no state
 * (UNCERTIFIED, `no-calibration-state`) rather than assuming the best.
 */
function calibrationStateOf(dotCascade) {
  if (!dotCascade) return { gateState: null, golden: null };
  let gateState = null;
  try { gateState = readJsonOrNull(path.join(dotCascade, 'calibration', 'gate-state.json')); }
  catch (e) { process.stderr.write(`gate state ignored: ${e.message}\n`); }
  let golden = null;
  const casesFile = path.join(dotCascade, 'golden', 'cases.jsonl');
  if (fs.existsSync(casesFile)) {
    try {
      const cases = parseCases(fs.readFileSync(casesFile, 'utf8'));
      golden = { approvedCases: cases.filter((c) => !!c.approvedAt).length, summary: gateState?.goldenSummary ?? null };
    } catch (e) { process.stderr.write(`golden corpus ignored: ${e.message}\n`); }
  }
  return { gateState, golden };
}

/**
 * The `basis.runtimeEvidence` block, from the trace census the pack carries.
 *
 * It is a COVERAGE statement, not a result: which traces were read, how many
 * spans they held, what window they cover, and how much of the graph they
 * touched. A reader seeing `observed: true` on a row needs it to know how much
 * "observed" is worth here, and a reader seeing NO mark needs it to know that
 * unobserved means unvisited rather than dead.
 *
 * @param {Object} pack  the pack as it was read from disk
 * @returns {{runtimeEvidence:Object}|null}  null when no trace was read
 */
function runtimeEvidenceBasis(pack) {
  const s = pack?.meta?.laneStats?.otel;
  if (!s || typeof s !== 'object') return null;
  return {
    runtimeEvidence: {
      source: 'otel',
      files: Array.isArray(s.sources) ? s.sources : [],
      spans: s.spans ?? 0,
      observations: s.observations ?? 0,
      window: s.window ?? null,
      services: Array.isArray(s.services) ? s.services : [],
      observedEdges: (s.edgesObserved ?? 0) + (s.edgesAdded ?? 0),
      observedStatements: s.statementsObserved ?? 0,
      observedEndpoints: s.endpointsObserved ?? 0,
      note: 'coverage is only what was exercised. A row marked observed really ran during this capture, a row not marked was not seen by it, '
        + 'and neither of those raised or lowered a static grade',
    },
  };
}

/** A path inside the project's state directory, as the receipt spells it. */
function relToState(stateDir, abs) {
  return path.relative(stateDir, abs).split(path.sep).join('/');
}

/**
 * The bound `callTool` the golden corpus asks its questions through. §14.1 is
 * emphatic that the grader must not see the engine's internals: it scores the
 * SHIPPED query surface, the same one an AI reaches over MCP, so every case
 * goes through the dispatcher and never through a private walk.
 */
function goldenAsk(graph, pack, profile) {
  const ctx = {
    graph,
    basis: {
      project: pack.meta?.project ?? 'project', buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null, freshness: { verdict: 'unknown' },
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    trust: computeTrust({ knownGaps: trustGapsFor(profile, pack.meta?.axes ?? null) }),
    limits: [],
    pack: packMeta(pack),
    profile,
  };
  return (name, args) => callTool(name, args, ctx);
}

/** Every *.xml under the given directories (or the files themselves), sorted. */
function listMapperXml(dirs) {
  const out = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
    } else if (st.isFile() && p.endsWith('.xml')) out.push(p);
  };
  for (const d of dirs) walk(d);
  return [...new Set(out)].sort();
}

/** `git -C dir …` as text, or null when git fails / this is not a repo. */
function gitText(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8');
  } catch { return null; }
}

/** Split a `-z` (NUL-separated) git list into non-empty entries. */
function splitZ(raw) {
  return raw == null ? [] : raw.split(String.fromCharCode(0)).filter((s) => s.length > 0);
}

// The impure half of discovery (src/core/discover.mjs is pure and takes these).
const DISCOVER_IO = {
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
function realPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Locate the project the command should act on (src/core/resolve.mjs decides;
// this only supplies the flags). `strictProject` is false for `analyze`, where
// --project has always also named the pack: an unregistered id there falls back
// to the root/cwd `.cascade/` with a visible note instead of failing.
// The `.cascade/` layout for an already-resolved project. `resolveProject`
// hands back the directory itself; `projectPaths` wants the root beside it.
function catalogPathsOf(dotCascadeDir) {
  return projectPaths(path.dirname(dotCascadeDir));
}

// The environment variable `cascade catalog fetch` reads the DB password from
// unless --password-env names another. Mirrors catalog_live.py's default.
const DEFAULT_PASSWORD_ENV = 'CASCADE_DB_PASSWORD';

// ---------------------------------------------------------------------------
// Asking the person at the keyboard. Both readers are SYNCHRONOUS, because
// everything else in this file is: a promise here would turn the whole command
// into an async program for the sake of one question.
//
// Neither is ever reached without a TTY. Every caller checks `process.stdin.isTTY`
// first and takes the non-interactive path otherwise, which is what makes a
// piped or CI run fail with a sentence instead of hanging on a read.
// ---------------------------------------------------------------------------

/** One line from the terminal, echoed as typed. Returns '' at end of input. */
function promptLine(question) {
  process.stderr.write(question);
  return readLineFromTty(false);
}

/**
 * One line from the terminal with NOTHING echoed: the password reader. The
 * terminal is put in raw mode so the driver stops echoing, which also means
 * this loop owns backspace and Ctrl-C.
 */
function promptHidden(question) {
  process.stderr.write(question);
  const line = readLineFromTty(true);
  process.stderr.write('\n');
  return line;
}

function readLineFromTty(hidden) {
  const wasRaw = process.stdin.isRaw === true;
  if (hidden && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  const byte = Buffer.alloc(1);
  const typed = [];
  try {
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(process.stdin.fd, byte, 0, 1, null);
      } catch (e) {
        // A non-blocking stdin says "nothing yet" rather than blocking; the
        // read is retried. EOF on some platforms arrives as EOF, not as 0.
        if (e.code === 'EAGAIN') continue;
        if (e.code === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      const c = byte[0];
      if (c === 0x0a || c === 0x0d) break;                       // enter
      if (hidden && c === 0x03) { process.stderr.write('\n'); process.exit(130); }  // ctrl-c
      if (hidden && (c === 0x7f || c === 0x08)) { typed.pop(); continue; }          // backspace
      typed.push(c);
    }
  } finally {
    if (hidden && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(wasRaw);
  }
  // Decoded at the END, so a multi-byte character typed into the prompt survives
  // being read one byte at a time.
  return Buffer.from(typed).toString('utf8').replace(/\r$/, '');
}

/** A yes/no question whose default is NO: anything but y or yes is no. */
function confirmYesNo(question) {
  return /^(y|yes)$/i.test(promptLine(question).trim());
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
function analyzeRoot(resolved, rootFlag, cwd) {
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

function resolveOrDie({ strictProject = true } = {}) {
  const args = { pack: opt('pack'), project: opt('project'), root: opt('root'), cwd: process.cwd(), env: process.env };
  try {
    return resolveProject(args);
  } catch (e) {
    if (strictProject) die(e.message);
    process.stderr.write(`${e.message}\n  -> continuing with the local .cascade/ (the name is used for the pack only)\n`);
    return resolveProject({ ...args, project: undefined });
  }
}

// `cascade setup` — build the SQL lane's interpreter, in one command.
//
// The lane is a Python program, and until now the only way to get one was to
// read a setup page and type two commands with the right working directory.
// That is a documentation exercise standing between a reader and their first
// answer, so this does it: find a python3, build the virtual environment where
// the resolver will look for it, install the PINNED requirements, and then
// PROVE it by importing sqlglot rather than trusting that pip said ok.
//
// It never touches a system interpreter's packages: everything goes inside the
// environment it creates, and `--force` is the only way to replace one.
if (cmd === 'setup') {
  const already = sqlPython();
  const isCheckout = fs.existsSync(path.join(ENGINE_ROOT, '.git'));
  const target = flag('home')
    ? sqlVenvTarget({ engineRoot: ENGINE_ROOT, isCheckout: false })
    : sqlVenvTarget({ engineRoot: ENGINE_ROOT, isCheckout });
  const targetPy = path.join(target, 'bin', 'python');
  const req = path.join(ENGINE_ROOT, 'adapters', 'sql', 'requirements.txt');

  const sqlglotVersion = (py) => {
    try {
      return execFileSync(py, ['-c', 'import sqlglot; print(sqlglot.__version__)'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    } catch { return null; }
  };

  // Already done means: the interpreter a run would PICK is the one this
  // command would build, and it works. `--home` naming a different place, or a
  // resolved candidate that is not the target, is a reason to build.
  const targetIsWhatRunsWould = already.ok && path.resolve(already.path) === path.resolve(targetPy);
  if (targetIsWhatRunsWould && !flag('force')) {
    const v = sqlglotVersion(already.path);
    if (v) {
      process.stdout.write(`the SQL lane is already set up: ${already.path} (${already.from}), sqlglot ${v}\n`);
      process.stdout.write('pass --force to build it again\n');
      process.exit(0);
    }
    process.stdout.write(`${already.path} exists but cannot import sqlglot, so it is being rebuilt\n`);
  }

  // A python3 to build WITH. Never the one being built.
  let base = null;
  for (const cand of [process.env.CASCADE_PYTHON3, 'python3', 'python'].filter(Boolean)) {
    try {
      const v = execFileSync(cand, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
      if (/^3\.(\d+)$/.test(v)) { base = { cmd: cand, version: v }; break; }
    } catch { /* try the next spelling */ }
  }
  if (!base) {
    die('no python3 on PATH to build the SQL lane with. Install one (macOS: `brew install python`; Debian or Ubuntu: `sudo apt-get install python3 python3-venv`), '
      + 'or set CASCADE_PYTHON to an interpreter that already has sqlglot and skip this command');
  }

  if (flag('force') && fs.existsSync(target)) {
    process.stdout.write(`removing ${target}\n`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  process.stdout.write(`building ${target} with ${base.cmd} (python ${base.version})…\n`);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(base.cmd, ['-m', 'venv', target], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    die(`could not create a virtual environment at ${target}: ${(e && e.message) || e}. `
      + 'On Debian or Ubuntu the venv module ships separately: `sudo apt-get install python3-venv`');
  }
  process.stdout.write(`installing ${path.relative(ENGINE_ROOT, req)}…\n`);
  try {
    execFileSync(path.join(target, 'bin', 'pip'), ['install', '--disable-pip-version-check', '-r', req], { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (e) {
    die(`the requirements did not install into ${target}: ${(e && e.message) || e}`);
  }

  // Proof, not a claim: the lane's own import, run by the interpreter a run
  // will actually use.
  const version = sqlglotVersion(targetPy);
  if (!version) die(`${targetPy} was built but cannot import sqlglot. Try \`cascade setup --force\`, and see docs/setup/sql-lane.md`);
  const now = sqlPython();
  process.stdout.write(`ready: ${targetPy}, sqlglot ${version}\n`);
  if (now.ok && path.resolve(now.path) !== path.resolve(targetPy)) {
    process.stdout.write(`note: a run will still prefer ${now.path} (${now.from}), which comes first\n`);
  }
  process.stdout.write('next: `cascade doctor` to check every prerequisite, then `cascade init --root <your project>`\n');
  process.exit(0);
}

if (cmd === 'doctor') {
  // The prerequisite pre-flight (SPEC §17.9). THIS block is the impure half —
  // it runs the probes; src/core/doctor.mjs turns them into the table, and is
  // tested with fake probes so the states this machine is not in are covered
  // too.
  const runOut = (file, args, opts = {}) => {
    try {
      return {
        ok: true,
        out: execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, ...opts })
          .toString('utf8').trim(),
      };
    } catch (e) {
      // A tool that is absent and one that is broken are DIFFERENT answers, and
      // the remedy differs too, so the error text is relayed rather than
      // flattened into "not found". The tool's OWN last line beats node's
      // "Command failed: <the whole command line>", which says nothing and
      // pastes an absolute path into the report.
      if (e && e.code === 'ENOENT') return { ok: false, error: `not found: ${file}` };
      const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
      return { ok: false, error: said || String((e && e.message) || 'failed').split('\n')[0] };
    }
  };

  const pyRes = sqlPython();
  const venvPy = pyRes.path;
  const pyProbe = pyRes.ok
    ? (() => { const r = runOut(venvPy, ['-V']); return { path: venvPy, from: pyRes.from, ok: r.ok, version: r.out, error: r.error }; })()
    : { path: venvPy, from: null, ok: false, error: `no interpreter in any of: ${pyRes.tried.map((c) => c.path).join(', ')}` };
  const pyModule = (mod) => {
    if (!pyProbe.ok) return { ok: false, error: `no venv python at ${venvPy}` };
    const r = runOut(venvPy, ['-c', `import ${mod}, sys; sys.stdout.write(getattr(${mod}, "__version__", "unknown"))`]);
    return r.ok ? { ok: true, version: r.out } : { ok: false, error: r.error };
  };

  const jdkCands = jdkCandidateDirs(process.env).map(({ dir, via }) => ({
    dir, via,
    javac: fs.existsSync(path.join(dir, 'javac')),
    java: fs.existsSync(path.join(dir, 'java')),
  }));
  const jdk = findJdk();
  const javacV = jdk ? runOut(jdk.javac, ['-version']) : null;

  // The cache root of a project id that cannot collide with a real one, so the
  // probe never writes inside somebody's shard directory.
  const cacheProbeDir = cacheDir('doctor-probe');
  let cache;
  try {
    fs.mkdirSync(cacheProbeDir, { recursive: true });
    const probeFile = path.join(cacheProbeDir, 'write-probe');
    fs.writeFileSync(probeFile, 'ok');
    fs.rmSync(probeFile, { force: true });
    cache = { path: cacheProbeDir, ok: true };
  } catch (e) {
    cache = { path: cacheProbeDir, ok: false, error: e.message };
  }

  const regFile = registryPath();
  let registry;
  if (!fs.existsSync(regFile)) registry = { path: regFile, exists: false };
  else {
    try { registry = { path: regFile, exists: true, ok: true, projects: projectIds(readRegistry(regFile)).length }; }
    catch (e) { registry = { path: regFile, exists: true, ok: false, error: e.message }; }
  }

  // The web lane's parser: LOADED and USED, not just looked for. A file that is
  // present and broken is the failure mode a stat cannot see.
  const webParserFile = path.join(ENGINE_ROOT, 'adapters', 'web', 'vendor', 'babel-parser.cjs');
  let webParser;
  try {
    const probe = execFileSync(process.execPath, [
      '-e',
      'const p = require(process.argv[1]); const a = p.parse("const a = 1;", { sourceType: "unambiguous" });'
      + ' process.stdout.write(a.program.body[0].type);',
      webParserFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).toString('utf8').trim();
    webParser = probe === 'VariableDeclaration'
      ? { path: webParserFile, ok: true }
      : { path: webParserFile, ok: false, error: `the parser loaded but read \`const a = 1;\` as ${probe || 'nothing'}` };
  } catch (e) {
    const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
    webParser = { path: webParserFile, ok: false, error: said || String((e && e.message) || 'failed').split('\n')[0] };
  }

  const gitV = runOut('git', ['--version']);
  const dockerV = runOut('docker', ['info', '--format', '{{.ServerVersion}}']);

  const report = buildDoctorReport({
    node: { version: process.version },
    git: { ok: gitV.ok, version: gitV.out, error: gitV.error },
    python: pyProbe,
    sqlglot: pyModule('sqlglot'),
    jdk: { candidates: jdkCands, chosen: jdk, version: javacV && javacV.ok ? javacV.out : undefined },
    webParser,
    drivers: [
      { dialect: 'mysql', module: 'pymysql', pip: 'pymysql', ...pyModule('pymysql') },
      { dialect: 'postgres', module: 'psycopg', pip: 'psycopg[binary]', ...pyModule('psycopg') },
      { dialect: 'oracle', module: 'oracledb', pip: 'oracledb', ...pyModule('oracledb') },
    ],
    docker: { ok: dockerV.ok, version: dockerV.out ? `server ${dockerV.out}` : undefined, error: dockerV.error },
    registry,
    cache,
  });

  if (flag('json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(formatDoctorTable(report));
  process.exit(report.ok ? 0 : 1);
}

if (cmd === 'init') {
  // discover -> manifest + profile -> .gitignore -> registry (SPEC §15 M1).
  const root = path.resolve(opt('root', process.cwd()));
  const force = flag('force');
  const asJson = flag('json');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
  const projectId = opt('project') ?? slugify(path.basename(root));
  if (!projectId) die(`cannot derive a project id from ${JSON.stringify(path.basename(root))}. Pass --project <id> (lower-case, [a-z0-9._-])`);

  const discovery = discover(root, DISCOVER_IO);
  const p = projectPaths(root);
  // THE PROFILE THAT IS ALREADY THERE, when there is one. Two keys are the
  // user's word the moment they exist (`gatewayRoutes`, `serviceNames`), so a
  // re-run with --force must not overwrite them with what discovery read.
  let existingProfile = null;
  if (fs.existsSync(p.profile)) {
    try { existingProfile = JSON.parse(fs.readFileSync(p.profile, 'utf8')); }
    catch (e) { process.stderr.write(`the profile at ${p.profile} could not be read (${e.message}), so this run treats it as absent\n`); }
  }
  let manifest;
  let profile;
  let profileDiagnostics = [];
  try {
    manifest = buildManifest(discovery, { projectId, root, manifestDir: p.root });
    validateManifest(manifest, p.manifest);
    const built = buildProfile(discovery, { root, manifestDir: p.root, existing: existingProfile });
    profile = built.profile;
    profileDiagnostics = built.diagnostics;
  } catch (e) {
    die(e.message);
  }
  const diagnostics = [...discovery.diagnostics, ...profileDiagnostics];

  ensureProjectDirs(root);
  const { written, kept } = writeInitFiles({
    manifestPath: p.manifest, profilePath: p.profile, manifest, profile, force,
  });

  const lanes = lanesOf(discovery);
  const regFile = registryPath(process.env);
  try {
    writeRegistryAtomic(regFile, upsertProject(readRegistry(regFile), {
      id: projectId, dotCascadePath: realPath(p.root), source: 'init', stack: lanes, lastCertifiedAt: null,
    }, { force }));
  } catch (e) {
    die(`${e.message}\n  (nothing was written to ${regFile}; the project files above are in place)`);
  }

  const c = discovery.counts;
  process.stderr.write(`project ${projectId} at ${root}\n`);
  process.stderr.write(`repositories (${discovery.repos.length}): ${discovery.repos.map((r) => `${r.path}@${r.commit.slice(0, 8)}`).join(', ')}\n`);
  process.stderr.write(`files scanned ${discovery.filesScanned}${discovery.capped ? ' (CAPPED: see diagnostics)' : ''}: `
    + `${c.javaFiles} java (${c.springHandlerFiles} spring handlers, ${c.jpaEntityFiles} JPA entities), `
    + `${c.mybatisMapperXml} mybatis mapper xml, ${c.ddlFiles} DDL, ${c.kotlinFiles} kotlin, ${c.frontendPackageJson} frontend package.json\n`);
  process.stderr.write(`build tool ${discovery.buildTool ?? 'none detected'}; package prefixes [${discovery.packagePrefixes.join(', ')}]; lanes [${lanes.join(',')}]\n`);
  // WHO THIS SERVICE IS AND WHERE IT FORWARDS, read out of the tree (RM46).
  // Both used to be blanks a person filled in, and both decide whether an
  // answer can cross from this project into the next one.
  for (const s of discovery.serviceNames ?? []) {
    process.stderr.write(`service name: ${s.name} (from ${s.file})\n`);
  }
  // A FRONTEND WITH NO PACKAGE MANIFEST, said in one line (RM47). It is the one
  // thing about this profile a reader would not expect, and the way to turn it
  // off is in the same sentence as the way it was turned on.
  // ONE LINE, however many roots. A tree with a directory of vendored plugin
  // scripts has thirteen of them, and thirteen lines saying the same thing is a
  // wall a reader skips rather than a finding.
  const vendoredKept = diagnostics.some((d) => d.kind === 'WEB_ROOTS_KEPT');
  const vendored = discovery.webVendoredRoots ?? [];
  if (vendored.length > 0) {
    const named = [...new Set(vendored.flatMap((r) => r.routerPacks ?? []))].sort();
    const files = vendored.reduce((n, r) => n + r.files, 0);
    process.stderr.write(`frontend without a package: reading ${listOfFive(vendored.map((r) => r.root))} `
      + `(${vendored.length} root(s), ${files} file(s)`
      + `${named.length > 0 ? `, router ${named.join(', ')}` : ', no router declaration in any of them'})`
      + `${vendoredKept ? '. The profile already answers for webRoots, so these were not applied' : '. Set webRoots to [] in the profile to stop'}\n`);
  }
  // WHERE A VIEW NAME BECOMES A PAGE (RM48). One line, however many roots, with
  // the engine and the suffix on each: a root nobody recorded is why a
  // `@Controller` would come out with no screen.
  const templateRoots = discovery.templateRoots ?? [];
  if (templateRoots.length > 0) {
    const templatesKept = diagnostics.some((d) => d.kind === 'TEMPLATE_ROOTS_KEPT');
    const froms = [...new Set(templateRoots.map((r) => r.from))].sort();
    process.stderr.write(`template roots: ${templateRoots.length} (${froms.join(', ')}) `
      + `${listOfFive(templateRoots.map((r) => `${r.root} ${r.engine} ${r.suffix}`))}`
      + `${templatesKept ? '. The profile already answers for templateRoots, so these were not applied' : '. Set templateRoots to [] in the profile to stop'}
`);
  }
  const routeFiles = [...new Set((discovery.gatewayRoutes ?? []).map((r) => r.file))].sort();
  if (routeFiles.length > 0) {
    const routesKept = diagnostics.some((d) => d.kind === 'GATEWAY_ROUTES_KEPT');
    process.stderr.write(`gateway routes: ${discovery.gatewayRoutes.length} read from ${routeFiles.join(', ')}`
      + `${routesKept ? ' (the profile already declares its own, so these were not applied)' : ''}\n`);
    for (const r of discovery.gatewayRoutes) {
      process.stderr.write(`  ${r.front} -> ${r.to === '' ? '/' : r.to} at ${r.service ?? 'a service this route does not name'}\n`);
    }
  }
  for (const f of written) process.stderr.write(`wrote ${f}\n`);
  for (const f of kept) process.stderr.write(`kept ${f} (already present: re-run with --force to overwrite)\n`);
  process.stderr.write(`registered ${projectId} -> ${p.root} in ${regFile}\n`);
  if (diagnostics.length === 0) {
    process.stderr.write('diagnostics: none\n');
  } else {
    const byKind = new Map();
    for (const d of diagnostics) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    process.stderr.write(`diagnostics (${diagnostics.length}): ${[...byKind].map(([k, n]) => `${k} x${n}`).join(', ')}\n`);
    for (const d of diagnostics.slice(0, 5)) process.stderr.write(`  [${d.severity}] ${d.kind} ${d.path}: ${d.reason}\n`);
    if (diagnostics.length > 5) process.stderr.write(`  … ${diagnostics.length - 5} more (see --json for all of them)\n`);
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({
      schema: 'cascade:init-report:1',
      project: projectId,
      root,
      lanes,
      discovery: { ...discovery, diagnostics },
      manifest: p.manifest,
      profile: p.profile,
      written,
      kept,
      registry: regFile,
    }, null, 2) + '\n');
  }

  // THE SIGNPOST, last, so it is the thing still on screen. A missing schema is
  // not one diagnostic among a dozen: it decides whether the ERD has any lines
  // in it and whether a column question can be answered in full, and the reader
  // has to meet that here rather than three commands later.
  const noDdl = (discovery.ddlPaths ?? []).length === 0;
  if (noDdl && (profile.catalog?.source ?? 'none') === 'none') {
    const candidates = discovery.connectionCandidates ?? [];
    process.stderr.write('\n' + catalogSignpost({
      candidates,
      profilePath: path.relative(root, p.profile) || p.profile,
    }));
    // In a terminal the reader can act on it now instead of retyping a command
    // they just read. Outside one (a script, CI, a pipe) the block IS the
    // answer: nothing prompts, nothing connects.
    if (candidates.length > 0 && process.stdin.isTTY) {
      const pick = promptLine(`\nFetch one of these now? Enter 1-${candidates.length}, or press Enter to skip: `);
      const n = Number(pick.trim());
      if (Number.isInteger(n) && n >= 1 && n <= candidates.length) {
        // The hand-off is literal: the same command the block printed, run with
        // this terminal attached, so its own confirmation and its own hidden
        // password prompt are the ones the reader answers.
        try {
          execFileSync(process.execPath, [realPath(fileURLToPath(import.meta.url)), 'catalog', 'fetch', '--root', root, '--candidate', String(n)], { stdio: 'inherit' });
        } catch {
          process.stderr.write(`\nthe fetch did not finish. \`cascade catalog fetch --candidate ${n}\` runs it again when you are ready.\n`);
        }
      }
    }
  }
  process.exit(0);
}

// `cascade agent` — put the MCP server AND the rule that gets it used into a
// project, in one command.
//
// The server has been wireable for a while, and every page that shows how ends
// at the same place: a config with an absolute path in it. What no page said is
// WHEN the agent should ask. A model with the server attached and no rule about
// it edits a mapper without a question, because nothing in its context says a
// question is due, and half of what this tool is worth sits on that rule.
//
// So this writes both, and it can, because the tool knows its own path, its own
// project id and its own tool names. The rule goes in a MANAGED BLOCK between
// two markers, so the file stays the user's: text above and below it survives,
// and a second run replaces the block in place rather than appending a second
// copy. The merge rules and the text itself are in src/core/agent_setup.mjs;
// this block is the filesystem edge.
if (cmd === 'agent') {
  const clientArg = opt('client', 'claude-code');
  const clients = clientArg === 'all' ? [...AGENT_CLIENTS] : [clientArg];
  for (const c of clients) {
    if (!AGENT_CLIENTS.includes(c)) die(`--client ${JSON.stringify(clientArg)} is not one of ${AGENT_CLIENTS.join('|')}|all`);
  }
  const write = flag('write');

  // WHICH PROJECT. The registry is the authority, because the id it holds is
  // the id the server will answer to. `--project` names an entry; otherwise the
  // entry is the one whose `.cascade/` IS this root's, compared as real paths
  // so a symlinked temp directory is still the same project.
  const regFile = registryPath(process.env);
  let reg;
  try { reg = readRegistry(regFile); } catch (e) { die(e.message); }

  const projectFlag = opt('project');
  let projectEntry;
  let root;
  if (typeof projectFlag === 'string' && projectFlag.length > 0) {
    projectEntry = findProject(reg, projectFlag);
    if (!projectEntry) {
      const ids = projectIds(reg);
      die(`unknown project ${JSON.stringify(projectFlag)}: `
        + `${ids.length > 0 ? `registered ids are ${ids.join(', ')}` : `the registry at ${regFile} is empty`}. `
        + 'Run `cascade init --root <dir>` and `cascade analyze` first, then this command');
    }
    root = analyzeRoot({ source: 'registry', dotCascade: path.resolve(projectEntry.dotCascadePath) }, undefined, process.cwd()).root;
  } else {
    root = path.resolve(process.cwd(), opt('root', process.cwd()));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
    const dot = realPath(path.join(root, '.cascade'));
    projectEntry = reg.projects.find((p) => realPath(p.dotCascadePath) === dot) ?? null;
    if (!projectEntry) {
      die(`no project is registered for ${root}: nothing in ${regFile} points at ${path.join(root, '.cascade')}. `
        + `Run \`cascade init --root ${root}\` and \`cascade analyze\` first, then this command`);
    }
  }
  const projectId = projectEntry.id;

  // The path a client will start. Absolute, and through whatever symlink the
  // installer left behind, because a client starts the server from a working
  // directory nobody controls.
  const entry = mcpServerEntry({
    execPath: process.execPath,
    cliPath: realPath(fileURLToPath(import.meta.url)),
    projectId,
  });

  // PLAN EVERYTHING, THEN WRITE. A config that exists and does not parse stops
  // the whole command with nothing written, rather than after the first half.
  const planned = [];
  for (const client of clients) {
    for (const f of filesFor(client, { projectId, entry })) {
      const abs = path.join(root, f.rel);
      if (planned.some((p) => p.abs === abs)) continue;
      const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      let content;
      try {
        if (f.kind === 'mcp-json') content = mergeMcpConfig(existing, f.entry);
        else if (f.kind === 'managed') content = mergeManagedBlock(existing, f.content);
        else content = f.content;
      } catch (e) {
        die(`${abs} is not something this command can merge into: ${e.message}. `
          + 'Nothing was written. Fix that file by hand, or move it aside and run this again');
      }
      planned.push({ abs, rel: f.rel, content, existing });
    }
  }

  process.stdout.write(`cascade agent: project ${projectId} at ${root} (${clients.join(', ')})\n\n`);
  if (!write) {
    for (const p of planned) {
      process.stdout.write(`--- ${p.rel} ---\n`);
      process.stdout.write(p.content.endsWith('\n') ? p.content : `${p.content}\n`);
      process.stdout.write('\n');
    }
    process.stdout.write('nothing was written: pass --write to put these files in place\n');
  } else {
    for (const p of planned) {
      const state = p.existing === null ? 'created' : (p.existing === p.content ? 'unchanged' : 'updated');
      if (state !== 'unchanged') {
        fs.mkdirSync(path.dirname(p.abs), { recursive: true });
        fs.writeFileSync(p.abs, p.content, 'utf8');
      }
      process.stdout.write(`${state} ${p.rel}\n`);
    }
  }
  if (clients.includes('codex')) {
    // Codex keeps ONE config for every project, so a per-project command that
    // edited a file in the home directory would be a surprise. It is printed.
    process.stdout.write('\nCodex reads one config for every project, so this part is yours to paste. Put it in ~/.codex/config.toml:\n\n');
    process.stdout.write(codexTomlBlock(entry));
  }
  if (write && clients.includes('claude-code')) {
    process.stdout.write(`\nnext: run \`claude\` in ${root} once and approve the cascade server when it asks, `
      + 'because Claude Code holds a project .mcp.json server at "Pending approval" until you do, '
      + 'and `claude mcp get cascade` prints that state\n');
  }
  process.exit(0);
}

if (cmd === 'analyze') {
  // Run the lanes end to end -> pack, one command. Every lane input is OPTIONAL:
  // what a flag does not name comes from the project's manifest + profile +
  // discovery, and a lane with no input is DECLARED missing rather than fatal
  // (SPEC §10.4 MUST — a partial pack, never a die()).
  // Where the pack goes is decided by the project resolver (SPEC §15 M1), not by
  // joining a literal onto cwd: --pack > --project (registry) > --root > cwd.
  const resolved = resolveOrDie({ strictProject: false });
  const out = opt('out', resolved.packDir);
  // WHAT GETS ANALYZED. This used to be `--root` or cwd, full stop, so
  // `cascade analyze --project mall` run from anywhere else analyzed the
  // directory the shell happened to be in and wrote the result into mall's pack:
  // a pack named after one project describing another. The resolver already
  // knows which project this is; `analyzeRoot` asks it where that project lives.
  //
  // Symlinks are resolved here, at the filesystem edge: on macOS /var is a link
  // to /private/var, and git reports the physical path, so a root given through
  // the other spelling would make every "is this file under a source root?"
  // comparison fail silently, by returning "nothing changed". Every lane input
  // below is resolved the same way.
  const rootChoice = analyzeRoot(resolved, opt('root'), process.cwd());
  const root = realPath(rootChoice.root);
  process.stderr.write(`analyzing ${root} (${rootChoice.from})\n`);

  // ---- the reading convention (SPEC §6.2) --------------------------------
  const { profile, profileFile, profileNote } = readProfile(resolved.dotCascade);
  if (profileNote) process.stderr.write(profileNote + '\n');
  let diagnostics;
  try {
    diagnostics = profileDiagnostics(profile);
  } catch (e) { die(e.message); }
  // Fail closed on a dialect this engine cannot route: a wrong dialect
  // mis-parses every statement and the result would still look healthy.
  try { sqlDialectOf(profile); } catch (e) { die(e.message); }

  // ---- project identity (SPEC §6.1): is the pinned commit what we analyze? --
  const manifestFile = resolved.dotCascade ? path.join(resolved.dotCascade, 'manifest.json') : null;
  let manifest = null;
  if (manifestFile && fs.existsSync(manifestFile)) {
    try { manifest = loadManifest(manifestFile); }
    catch (e) { process.stderr.write(`manifest ignored: ${e.message}\n`); }
  }

  // ---- what runs, over what (src/core/lanes.mjs decides) -----------------
  const flags = {
    // Repeatable, and each value may be a glob: a schema split over three
    // services is `--ddl a.sql --ddl b.sql --ddl c.sql` or `--ddl 'db/*/schema.sql'`.
    ddl: expandDdlPatterns(optAll('ddl')), noDdl: flag('no-ddl'),
    mappers: optAll('mappers'), noMappers: flag('no-mappers'),
    javaSrc: optAll('java-src'), noJava: flag('no-java'),
    webSrc: optAll('web-src'), noWeb: flag('no-web'),
    // An OpenAPI / Swagger document the project publishes. Repeatable, because a
    // repository with several services publishes one document per service.
    openapi: optAll('openapi'), noOpenapi: flag('no-openapi'),
    // A browser recording, as runtime evidence on the screen axis (RM30). No
    // `--no-har` sibling and no discovery: nothing reads one unless a person
    // names it here or in the profile.
    har: optAll('har'),
    // An OpenTelemetry trace export, as runtime evidence on the DISPATCH axis:
    // which implementation really handled a request, and which statement really
    // ran. Same posture as --har, and for the same reason: no discovery, and
    // nothing it writes is ever walked.
    otel: optAll('otel'),
  };
  for (const [off, on, name] of [[flags.noDdl, flags.ddl.length, 'ddl'], [flags.noMappers, flags.mappers.length, 'mappers'], [flags.noJava, flags.javaSrc.length, 'java-src'], [flags.noWeb, flags.webSrc.length, 'web-src'], [flags.noOpenapi, flags.openapi.length, 'openapi']]) {
    if (off && on) die(`--no-${name === 'java-src' ? 'java' : name === 'web-src' ? 'web' : name} and --${name} contradict each other. Pass one or the other`);
  }
  const needDiscovery = (flags.ddl.length === 0 && !flags.noDdl)
    || (flags.mappers.length === 0 && !flags.noMappers)
    || (flags.javaSrc.length === 0 && !flags.noJava)
    || (flags.webSrc.length === 0 && !flags.noWeb)
    || (flags.openapi.length === 0 && !flags.noOpenapi);
  let discovery = null;
  if (needDiscovery) {
    process.stderr.write('discovering the tree (no lane flag given for every lane)…\n');
    discovery = discover(path.resolve(root), DISCOVER_IO);
  }
  // The catalog can come from a DDL file or from the PINNED SNAPSHOT that
  // `cascade catalog fetch` wrote (SPEC §12, §15 M5). This run never connects
  // to a database either way — §2.3 allows zero network calls in the extraction
  // path, and a snapshot is a file like any other.
  const snapshotFile = resolved.dotCascade ? catalogPathsOf(resolved.dotCascade).catalog : null;
  const sel = selectLanes({
    flags, profile, discovery, root: path.resolve(root),
    manifestDir: resolved.dotCascade, cwd: process.cwd(),
    catalogSnapshot: snapshotFile,
  });
  diagnostics = [...diagnostics, ...sel.diagnostics];
  const ddls = sel.ddls.map(realPath);
  const ddl = ddls[0] ?? null;
  const snapshot = sel.snapshot ? realPath(sel.snapshot) : null;
  const mappers = sel.mappers.map(realPath);
  const javaSrc = sel.javaSrc.map(realPath);
  const webSrc = sel.webSrc.map(realPath);
  for (const f of sel.openapi) if (!fs.existsSync(f)) die(`--openapi ${f} does not exist`);
  const openapiFiles = sel.openapi.map(realPath);
  for (const f of sel.har) if (!fs.existsSync(f)) die(`--har ${f} does not exist`);
  const harFiles = sel.har.map(realPath);
  for (const f of sel.otel) if (!fs.existsSync(f)) die(`--otel ${f} does not exist`);
  const otelFiles = sel.otel.map(realPath);
  for (const f of ddls) if (!fs.existsSync(f)) die(`--ddl ${f} does not exist`);
  for (const d of webSrc) if (!fs.existsSync(d)) die(`--web-src ${d} does not exist`);
  // §17.4: a structured, actionable error — not "0 tables" three screens later.
  if (snapshot && !fs.existsSync(snapshot)) {
    process.stderr.write(JSON.stringify({
      error: 'db-catalog-missing',
      catalogSource: 'jdbc',
      expected: snapshot,
      remedy: 'cascade catalog fetch --candidate <n> --password-env <VAR> --yes',
    }) + '\n');
    die(`profile catalog.source is "jdbc" but there is no pinned snapshot at ${snapshot}.\n`
      + '  Analysis never connects to a database. It reads a snapshot you fetched deliberately.\n'
      + '  Run `cascade catalog discover` to see the connection candidates, then\n'
      + '  `cascade catalog fetch --candidate <n> --password-env <VAR> --yes` to pin one.\n'
      + '  Or set catalog.source to "file"/"none" in the profile.');
  }
  let snapshotProvenance = null;
  let snapshotSha256 = null;
  if (snapshot) {
    snapshotSha256 = sha256File(snapshot);
    const provFile = catalogPathsOf(resolved.dotCascade).catalogSnapshot;
    try { snapshotProvenance = JSON.parse(fs.readFileSync(provFile, 'utf8')); }
    catch { snapshotProvenance = null; }
    if (snapshotProvenance && snapshotProvenance.sha256 && snapshotProvenance.sha256 !== snapshotSha256) {
      // The provenance describes a fetch; the file is what gets analyzed. When
      // they disagree the file wins and the disagreement is stated — a snapshot
      // edited by hand must not travel under a fetch's credentials (§17.2).
      diagnostics.push({
        kind: 'SNAPSHOT_PROVENANCE_STALE', severity: 'warn', key: 'catalog.source',
        reason: `${snapshot} no longer hashes to the sha256 recorded in ${provFile} `
          + `(${snapshotProvenance.sha256.slice(0, 12)}… vs ${snapshotSha256.slice(0, 12)}…). The file on disk is what was analyzed. `
          + 'Re-run `cascade catalog fetch` to make the provenance describe it again',
      });
    }
  }
  if (sel.lanes.length === 0) {
    const c = discovery ? discovery.counts : null;
    die('nothing to analyze: no DDL, no mapper XML and no Java source were given or found.\n'
      + (c
        ? `  discovery under ${path.resolve(root)} found: ${c.javaFiles} java file(s) (${c.springHandlerFiles} with a Spring mapping), `
          + `${c.mybatisMapperXml} mybatis mapper xml, ${c.ddlFiles} DDL file(s) with CREATE TABLE, ${c.kotlinFiles} kotlin, ${c.frontendPackageJson} frontend package.json, ${c.webFiles} frontend source file(s)\n`
          + `  mapper directories: ${discovery.mapperDirs.length ? discovery.mapperDirs.join(', ') : '(none)'}\n`
          + `  java source roots: ${discovery.javaSourceRoots.length ? discovery.javaSourceRoots.join(', ') : '(none)'}\n`
          + `  web source roots: ${(discovery.webSourceRoots ?? []).length ? discovery.webSourceRoots.join(', ') : '(none)'}\n`
          + `  profile frameworkPacks: [${(profile.frameworkPacks ?? []).join(', ')}], catalog.source: ${profile.catalog?.source}\n`
        : '')
      + '  pass --ddl / --mappers / --java-src / --web-src explicitly, or run `cascade init` so the profile declares the lanes.');
  }
  // THE ONE REMINDER. This project told `init` where its database is, nobody
  // has fetched the schema, and the run is about to produce a pack whose ERD
  // has no relationship lines and whose column answers are partial. That is a
  // supported answer and the run continues, but it is said HERE, at the top,
  // rather than left for whoever opens the empty diagram later.
  const recordedConnection = (profile.catalog?.source ?? 'none') === 'none'
    && typeof profile.catalog?.connectionFrom === 'string' && profile.catalog.connectionFrom.length > 0;
  if (recordedConnection && ddls.length === 0 && !snapshot) {
    // The profile stores that path relative to the manifest directory; the
    // reader is standing in the repository, so it is shown from there.
    const from = resolved.dotCascade
      ? path.relative(path.resolve(root), path.resolve(resolved.dotCascade, profile.catalog.connectionFrom)) || profile.catalog.connectionFrom
      : profile.catalog.connectionFrom;
    process.stderr.write(`no schema has been fetched: the profile records a database at ${from} `
      + 'and nothing has read it, so this pack gets no ERD relationship lines and partial column answers. '
      + 'Run `cascade catalog fetch --candidate 1` to pin one.\n');
  }

  // The lane line states BOTH what ran and what was left out: a default that is
  // never printed is indistinguishable from a hidden filter (SPEC §17.8).
  const excluded = sel.excludedTestRoots.length > 0
    ? `; ${sel.excludedTestRoots.length} test root(s) excluded (the standard src/test layout; pass --java-src to include): ${sel.excludedTestRoots.join(', ')}`
    : '';
  const catalogLine = snapshot
    ? `catalog ${snapshot} (pinned snapshot${snapshotProvenance ? `, ${snapshotProvenance.dialect} ${snapshotProvenance.serverIdentity} fetched ${snapshotProvenance.fetchedAt}` : ', provenance file missing'})`
    : `ddl ${ddls.length > 0 ? `${ddls.length} file(s) (${sel.sources.ddl}): ${ddls.join(', ')}` : 'none'}`;
  process.stderr.write(`lanes [${sel.lanes.join(',')}]: ${catalogLine}; `
    + `mappers ${mappers.length} dir(s) (${sel.sources.mappers}); `
    + `java-src ${javaSrc.length} root(s) (${sel.sources.javaSrc}${excluded}); `
    + `web ${webSrc.length > 0 ? `${webSrc.map((d) => path.relative(root, d) || '.').join(', ')} (${sel.sources.webSrc})` : 'none'}; `
    + `openapi ${openapiFiles.length > 0 ? `${openapiFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.openapi})` : 'none'}; `
    + `har ${harFiles.length > 0 ? `${harFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.har})` : 'none'}; `
    + `otel ${otelFiles.length > 0 ? `${otelFiles.map((f) => path.relative(root, f)).join(', ')} (${sel.sources.otel})` : 'none'}\n`);

  // WHICH OF THOSE ROOTS NOBODY PACKAGED (RM47). A root the profile names is
  // read exactly like one a package.json gave, and the census has to say which
  // is which: nothing declares a framework for a vendored root, so the router
  // pack was read out of its source rather than out of a dependency list.
  if (webSrc.length > 0 && sel.sources.webSrc !== 'flag') {
    const vendored = (profile.webRoots ?? [])
      .filter((r) => r && typeof r.root === 'string' && (r.kind ?? 'declared') === 'vendored')
      .map((r) => path.relative(root, path.resolve(resolved.dotCascade ?? root, r.root)) || '.');
    if (vendored.length > 0) {
      process.stderr.write(`web roots from the profile: ${vendored.length} vendored (no package manifest): ${listOfFive(vendored)}\n`);
    }
  }

  // WHO THIS PACK IS, AND WHERE ITS CALLS GO. The two answers this run uses,
  // said on the run that uses them: the names go into the routes sidecar beside
  // the pack, and the routes rewrite a call's prefix before it is matched. The
  // name is the profile's when it declares one and THIS RUN's discovery
  // otherwise, and the line says which, because a name nobody recorded is one
  // that goes away the next time discovery reads a different tree.
  const serviceNames = serviceNamesOf(profile, discovery);
  const gatewayKeys = profile.gatewayRoutes && typeof profile.gatewayRoutes === 'object'
    ? Object.keys(profile.gatewayRoutes).sort() : [];
  if (serviceNames.names.length > 0 || gatewayKeys.length > 0) {
    const readIn = serviceNames.files.slice(0, 3).join(', ')
      + (serviceNames.files.length > 3 ? `, and ${serviceNames.files.length - 3} more` : '');
    process.stderr.write(`service name(s) [${serviceNames.names.join(', ')}]`
      + (serviceNames.from === 'discovery'
        ? ` (discovered in ${readIn}, not in the profile: run \`cascade init --force\` to record it)`
        : '')
      + `; gateway routes ${gatewayKeys.length}${gatewayKeys.length > 0 ? `: ${gatewayKeys.join(', ')}` : ''}\n`);
  }

  // THE SCREEN AXIS SWITCH, resolved once, here, and read nowhere else (I-5).
  // The third state needs the frontend packages this run will really read, which
  // is a filesystem question and so cannot live in the pure decision.
  const screenGate = screenAxisOf(profile, {
    webPackages: webPackagesRead(webSrc),
    templateRoots: sel.templateRoots,
  });
  if (webSrc.length > 0 || sel.templateRoots.length > 0) {
    process.stderr.write(`screen axis ${screenGate.enabled ? 'ON' : 'OFF'} (${screenGate.from}): ${screenGate.reason}\n`);
  }
  // WHERE THIS RUN LOOKS FOR A PAGE (RM48), said before the lanes run: a view
  // name resolves against exactly these roots, and a root nobody recorded is why
  // a `@Controller` would come out with no screen.
  if (sel.templateRoots.length > 0) {
    process.stderr.write(`template roots ${sel.templateRoots.length} (${sel.sources.templateRoots}): `
      + `${sel.templateRoots.map((t) => `${path.relative(root, t.root) || '.'} ${t.engine} ${t.suffix}`).join(', ')}\n`);
  }

  // WHICH .sql FILES WERE CLASSIFIED HOW, one line each, whenever the engine —
  // rather than the user — decided. A catalog assembled from a set nobody named
  // is only trustworthy if the set is printed.
  if (sel.ddlChoice) {
    const ch = sel.ddlChoice;
    if (ch.chosen.length > 0 || ch.skipped.length > 0) {
      process.stderr.write(`DDL classification (dialect ${ch.dialect ?? 'undetermined'}`
        + `${ch.dialectFrom === 'profile' ? ', declared in the profile' : ch.dialectFrom === 'files' ? ', taken from the files themselves' : ''}):\n`);
      for (const c of ch.chosen) {
        process.stderr.write(`  applied  ${c.path}: schema, ${c.dialect ?? 'portable'} (${c.createTables} CREATE TABLE, ${c.alters} ALTER TABLE)\n`);
      }
      for (const c of ch.skipped) {
        process.stderr.write(`  left out ${c.path}: ${c.reason}\n`);
      }
      if (ch.migrations > 0) {
        process.stderr.write(`  ${ch.migrations} migration file(s) were NOT applied. To apply them, name them yourself IN ORDER:`
          + ' `cascade analyze --ddl <schema.sql> --ddl <first-migration.sql> --ddl <next.sql>`\n');
      }
      if (ch.testFiles > 0) {
        process.stderr.write(`  ${ch.testFiles} DDL file(s) under a \`src/test/\` root were left out, the same default that keeps`
          + ' test sources out of the Java lane. Pass one with --ddl to use it anyway\n');
      }
    }
  }

  const pyRes = sqlPython();
  const py = pyRes.path;
  const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
  const needPython = ddls.length > 0 || mappers.length > 0;
  if (needPython && !pyRes.ok) die(noSqlPython('this run reads SQL, so it', pyRes));
  const runpy = (script, args) => execFileSync(py, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
  const sqlArgs = sqlLaneArgs(profile);

  // ---- the incremental core (SPEC §11, §15 M6) ---------------------------
  // Everything that DECIDES is pure and lives in src/core/{changeset,invalidate,
  // facts_store,incremental}.mjs. This block only supplies the impure edges: git,
  // the filesystem, and the four worker invocations.
  const rootAbs = root;
  const wantCold = flag('cold');
  const wantIncremental = flag('incremental');
  if (wantCold && wantIncremental) die('--cold and --incremental contradict each other. Pass one or the other');

  // git prints repo-top-relative paths; the fact index speaks --root-relative,
  // so every path crosses over here, once, and anything outside --root is
  // dropped (it cannot be an input to this analysis).
  const gitTopRaw = ((gitText(rootAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
  const gitTop = gitTopRaw ? realPath(gitTopRaw) : null;
  const headCommit = ((gitText(rootAbs, ['rev-parse', 'HEAD']) ?? '').trim()) || null;
  const toRootRel = (repoRelPath) => {
    if (!gitTop) return null;
    const rel = path.relative(rootAbs, path.resolve(gitTop, repoRelPath));
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
  };
  const relOf = (absPath) => path.relative(rootAbs, realPath(path.resolve(absPath))).split(path.sep).join('/');
  const absOf = (relPath) => path.resolve(rootAbs, relPath);

  const selectionRel = {
    root: rootAbs,
    javaRoots: javaSrc.map(relOf).sort(),
    mapperDirs: mappers.map(relOf).sort(),
    // The web lane's roots. Sharded per file since RM29, and part of the
    // SELECTION: a project that gains or loses the web lane analyzes a different
    // set of inputs, and src/core/invalidate.mjs turns that into one cold run
    // with "the lane selection changed" as the reason.
    webRoots: webSrc.map(relOf).sort(),
    // WHERE A VIEW NAME BECOMES A PAGE (RM48). Part of the SELECTION for the
    // same reason the web roots are: a project that gains or loses its template
    // roots analyzes a different set of inputs, and one cold run with "the lane
    // selection changed" is the correct price.
    templateRoots: sel.templateRoots
      .map((t) => ({ root: relOf(t.root), engine: t.engine, suffix: t.suffix }))
      .sort((a, b) => (a.root < b.root ? -1 : 1)),
    // Whichever file feeds the catalog axis. Recording it here is what makes a
    // switch between a DDL and a snapshot force a cold run instead of quietly
    // mixing two generations of catalog facts (src/core/invalidate.mjs).
    ddls: ddls.length > 0 ? ddls.map(relOf) : snapshot ? [relOf(snapshot)] : [],
    sqlArgs: [...sqlArgs.mybatisArgs, ...sqlArgs.lineageArgs],
    packagePrefixes: [...(profile.packagePrefixes ?? [])].sort(),
  };

  const indexFile = path.join(out, 'facts-index.json');
  let prevIndex = null;
  if (fs.existsSync(indexFile)) {
    try { prevIndex = validateIndex(JSON.parse(fs.readFileSync(indexFile, 'utf8'))); }
    catch (e) { process.stderr.write(`facts index at ${indexFile} is unusable (${e.message}), so this run is cold\n`); }
  }

  // The changeset: the previous pack's base commit vs the WORKING TREE (this
  // engine analyzes the tree, not the blob — §2.1 item 2 is the overlay's job).
  // Untracked files under the analyzed roots count as added.
  const baseCommit = prevIndex?.base?.commit ?? null;
  let changeset = buildChangeset({ repo: rootAbs, fromCommit: null, toCommit: headCommit });
  if (baseCommit && gitTop) {
    const raw = gitText(rootAbs, ['diff', '--name-status', '-z', baseCommit, '--']);
    if (raw == null) {
      changeset = { ...changeset, reason: `git diff against ${baseCommit.slice(0, 12)} failed. The commit is not in this repository any more` };
    } else {
      try {
        const cs = buildChangeset({ repo: rootAbs, fromCommit: baseCommit, toCommit: headCommit ?? 'WORKING-TREE', rawNameStatusZ: raw });
        changeset = { ...cs, files: cs.files.map((f) => ({ ...f, repoPath: toRootRel(f.repoPath) })).filter((f) => f.repoPath !== null) };
      } catch (e) {
        changeset = { ...changeset, reason: `the git diff could not be parsed: ${e.message}` };
      }
    }
  }
  const untrackedRel = splitZ(gitText(rootAbs, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']))
    .map(toRootRel).filter((f) => f !== null);

  // "Dirty" for this pack means an ANALYSIS INPUT differs from HEAD — that is
  // what makes the pack provisional rather than a commit's certified state
  // (§2.1 item 2). An unrelated edited file elsewhere in the repo does not.
  const isAnalysisInput = (f) => (f.endsWith('.java') && underAny(f, selectionRel.javaRoots))
    || (f.endsWith('.xml') && underAny(f, selectionRel.mapperDirs))
    || (isWebSourceFile(f) && underAny(f, selectionRel.webRoots))
    // A template is an input of the web lane like any frontend source (RM48).
    || selectionRel.templateRoots.some((t) => f.endsWith(t.suffix) && underAny(f, [t.root]))
    || selectionRel.ddls.includes(f);
  const dirtyFiles = [...new Set([
    ...splitZ(gitText(rootAbs, ['diff', '--name-only', '-z', 'HEAD', '--'])).map(toRootRel),
    ...untrackedRel,
  ])].filter((f) => f !== null && isAnalysisInput(f)).sort();
  const base = headCommit
    ? { repoPath: rootAbs, commit: headCommit, dirty: dirtyFiles.length > 0, dirtyFiles }
    : null;

  // WHO THIS RUN IS ABOUT (SPEC §5.1), computed once for the whole command.
  // It addresses the fact cache, and further down it is what the pack records
  // as `meta.project`. Without a filesystem-safe id there is nowhere durable to
  // put shards, so the run is cold and nothing is kept.
  const projectId = projectIdFrom(resolved.projectId, manifest?.project, opt('project'), path.basename(rootAbs));

  let plan;
  if (!projectId) {
    plan = {
      mode: MODE_COLD, notes: [], reparseJava: [], dropJava: [], sqlChanged: true, catalogChanged: true, reuse: { java: 0 },
      reason: `no filesystem-safe project id could be derived for the fact cache. Run \`cascade init --project <id>\` to make this project's runs incremental`,
    };
  } else {
    plan = planIncremental({
      requestedMode: wantCold ? 'cold' : 'auto',
      index: prevIndex,
      changeset,
      untracked: untrackedRel,
      selection: selectionRel,
      workers: workerVersions(),
      engineVersion: INCREMENTAL_ENGINE_VERSION,
      stillExists: (f) => fs.existsSync(absOf(f)),
    });
  }
  if (wantIncremental && plan.mode === MODE_COLD) {
    process.stderr.write(`--incremental was asked for, but this run must be cold: ${plan.reason}\n`);
  }
  // With no usable project id the shards go to a throwaway in-memory store: the
  // run still works, it just cannot be reused next time — and it says so above.
  const memFiles = new Map();
  const storeIo = projectId ? nodeFactsIo(fs) : {
    readFile: (p) => memFiles.get(p), writeFile: (p, s) => memFiles.set(p, s),
    exists: (p) => memFiles.has(p), mkdir: () => {},
  };
  const store = createFactsStore({ io: storeIo, projectId: projectId ?? 'nocache', env: process.env });

  // The scratch directory is registered with the exit sweeper BEFORE the work
  // starts: the calibration RED path below calls process.exit(3) from inside
  // this try, and process.exit does not run `finally`. The eager remove in the
  // finally keeps the normal path tidy; the handler catches every other exit.
  const tmpDir = SCRATCH.create(path.join(ENGINE_ROOT, '.analyze-'));
  try {
    const catFile = path.join(tmpDir, 'catalog.jsonl');
    const stmtFile = path.join(tmpDir, 'statements.jsonl');
    let jdk = null;
    const run = {
      catalog: () => {
        if (snapshot) {
          // No worker: the snapshot IS catalog records. It was produced once,
          // by `cascade catalog fetch`, with the user's explicit confirmation.
          process.stderr.write('SQL lane: catalog (pinned snapshot)…\n');
          return jsonl(snapshot);
        }
        process.stderr.write('SQL lane: catalog…\n');
        // The SAME identity rule the lineage worker matches statements with
        // (§8.1): it is what decides whether two files declaring `SUPPLIER` and
        // `supplier` declare one table or two.
        return parseJsonl(runpy('catalog_ddl.py', ['--identifier-case', sqlArgs.identifierCase, ...ddls]));
      },
      mybatis: () => {
        process.stderr.write('SQL lane: mybatis statements…\n');
        return parseJsonl(runpy('mybatis_extract.py', ['--root', root, ...sqlArgs.mybatisArgs, ...mappers]));
      },
      lineage: (statements, catalogRecords) => {
        process.stderr.write(`SQL lane: lineage (dialect ${sqlArgs.dialect || 'sqlglot default/ANSI'}, identifiers ${sqlArgs.identifierCase}) over ${statements.length} statement(s)…\n`);
        fs.writeFileSync(catFile, catalogRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.writeFileSync(stmtFile, statements.map((r) => JSON.stringify(r)).join('\n') + '\n');
        return parseJsonl(runpy('lineage.py', ['--catalog', catFile, '--statements', stmtFile, ...sqlArgs.lineageArgs]));
      },
      java: (targets) => {
        if (!jdk) {
          jdk = findJdk();
          if (!jdk) die('the Java lane was selected but no JDK was found. Set JAVA_HOME or install one (see docs/setup/java-lane.md).');
        }
        process.stderr.write(`Java lane: parsing ${targets.length} ${plan.mode === MODE_COLD ? 'source root(s)' : 'changed file(s)'}…\n`);
        return runJavaLane(jdk, root, targets);
      },
      web: (targets) => {
        process.stderr.write(`Web lane: reading ${targets.length} ${plan.mode === MODE_COLD ? 'frontend source root(s)' : 'changed frontend file(s)'}…\n`);
        try {
          return runWebLane(root, targets, { sourceRoots: webSrc, templateRoots: sel.templateRoots });
        } catch (e) {
          const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
          die(`the web lane failed: ${said || (e && e.message) || 'unknown error'}`);
          return [];
        }
      },
      // Never cached: a package's `.env` values, dev-server proxy rules and path
      // aliases describe the PACKAGE, so there is no file whose shard could hold
      // them honestly. Reading them walks no source file.
      webConfigs: (roots) => {
        try {
          return runWebLane(root, roots, { configsOnly: true, sourceRoots: webSrc, templateRoots: sel.templateRoots });
        } catch (e) {
          const said = String((e && e.stderr) || '').trim().split('\n').filter(Boolean).pop();
          die(`the web lane failed to read the frontend package configuration: ${said || (e && e.message) || 'unknown error'}`);
          return [];
        }
      },
    };

    const shardDiagnostics = [];
    const result = runLanesWithShards({
      plan,
      index: prevIndex,
      store,
      selection: {
        ...selectionRel, javaRootsAbs: javaSrc, webRootsAbs: webSrc,
        templateRootsAbs: sel.templateRoots,
      },
      inputs: {
        mapperFiles: listMapperXml(mappers).map((p) => ({ rel: relOf(p), abs: p })),
        ddlFiles: ddls.length > 0
          ? ddls.map((f) => ({ rel: relOf(f), abs: path.resolve(f) }))
          : snapshot ? [{ rel: relOf(snapshot), abs: path.resolve(snapshot) }] : [],
        dialect: sqlArgs.dialect,
        identifierCase: sqlArgs.identifierCase,
        defaultSchema: sqlArgs.defaultSchema,
        mybatisArgs: sqlArgs.mybatisArgs,
        lineageArgs: sqlArgs.lineageArgs,
        // The snapshot's shard is keyed by the LIVE worker's version too, so a
        // catalog_live.py change cannot be answered from a shard the previous
        // generation produced (SPEC §17.7). See src/core/worker_versions.mjs
        // for why this rides in `args` rather than in the index's worker map.
        catalogArgs: snapshot
          ? [`worker=${CATALOG_LIVE_WORKER_VERSION}`, 'source=snapshot']
          : [`identifier-case=${sqlArgs.identifierCase}`],
      },
      run,
      hash: sha256File,
      abs: absOf,
      workers: workerVersions(),
      project: projectId ?? 'nocache',
      base,
      diag: (d) => { shardDiagnostics.push(d); },
    });
    diagnostics = [...diagnostics, ...shardDiagnostics];

    const catalog = result.catalogRecords;
    let lineage = result.lineageRecords;
    const lanes = sel.lanes.slice();

    // ---- MyBatis statements written as ANNOTATIONS (RM20 §4) -------------
    //
    // `@Select("select * from t_user")` is a MyBatis statement with no XML
    // anywhere. It goes through the SAME flattener as a mapper XML statement —
    // written out as a synthetic mapper file into this run's scratch directory
    // and read by `mybatis_extract.py` — because the annotation form accepts the
    // same `<script>` dynamic tags, and one reading of `<foreach>` is the only
    // way both spellings can stay in step. What comes back is re-stamped onto
    // the Java file and the annotation's line, so nothing in the pack points at
    // the scratch file.
    let annotationStmts = [];
    let annotationXml = null;
    if (javaSrc.length > 0) {
      const existingKeys = result.statementRecords
        ? result.statementRecords.filter((r) => r && r.kind === 'statement').map((r) => `${r.namespace}.${r.id}`)
        : [];
      annotationXml = annotationMapperXml(result.javaFacts, existingKeys);
      diagnostics = [...diagnostics, ...annotationXml.diagnostics];
      if (annotationXml.files.length > 0) {
        if (!fs.existsSync(py)) {
          diagnostics.push({
            kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
            reason: `${annotationXml.statements} MyBatis statement annotation(s) were found but there is no venv python at ${py} to read their SQL. See docs/setup/sql-lane.md. Those statements carry no table or column fact in this pack`,
          });
        } else {
          const annDir = path.join(tmpDir, 'annotation-mappers');
          fs.mkdirSync(annDir, { recursive: true });
          for (const f of annotationXml.files) fs.writeFileSync(path.join(annDir, f.fileName), f.xml, 'utf8');
          process.stderr.write(`MyBatis lane: ${annotationXml.statements} annotation statement(s) in ${annotationXml.files.length} mapper(s)`
            + `${annotationXml.scripts > 0 ? `, ${annotationXml.scripts} with a <script> body` : ''} -> the mapper flattener…\n`);
          annotationStmts = restampToJavaSource(
            parseJsonl(runpy('mybatis_extract.py', ['--root', annDir, ...sqlArgs.mybatisArgs, annDir])),
            annotationXml.files,
          );
        }
      }
    }
    if (annotationStmts.length > 0) {
      const ann = runLineageForStatements({
        store, index: prevIndex, statements: annotationStmts,
        catalogDigest: catalogDigestForShards(catalog), catalogRecords: catalog,
        inputs: {
          dialect: sqlArgs.dialect,
          identifierCase: sqlArgs.identifierCase,
          defaultSchema: sqlArgs.defaultSchema,
        },
        run, workerVersion: workerVersions().lineage,
        force: plan.mode === MODE_COLD,
        diag: (d) => { diagnostics.push(d); },
      });
      lineage = [...lineage, ...ann.lineageRecords];
      Object.assign(result.index.statements, ann.statementEntries);
      if (!lanes.includes('sql')) lanes.push('sql');
    }

    // ---- the JPA lane's NATIVE queries (SPEC §15 M10) --------------------
    // `@Query(nativeQuery = true)` is SQL, not JPQL, so it belongs to the SQL
    // analyzer — the same lineage.py, the same content-addressed shards, the
    // same dialect and default schema as a MyBatis statement. It is run here,
    // AFTER the Java lane produced the repository facts and BEFORE the graph is
    // built, so those statements arrive as ordinary lineage records.
    const nativeStmts = javaSrc.length > 0 ? nativeQueryStatements(result.javaFacts) : [];
    if (nativeStmts.length > 0) {
      if (!fs.existsSync(py)) {
        diagnostics.push({
          kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
          reason: `${nativeStmts.length} @Query(nativeQuery=true) statement(s) were found but there is no venv python at ${py} to analyze their SQL. See docs/setup/sql-lane.md. Those statements carry no table or column fact in this pack`,
        });
      } else {
        process.stderr.write(`JPA lane: ${nativeStmts.length} native @Query statement(s) -> SQL lineage (dialect ${sqlArgs.dialect || 'sqlglot default/ANSI'}, identifiers ${sqlArgs.identifierCase})…\n`);
        const nat = runLineageForStatements({
          store, index: prevIndex, statements: nativeStmts,
          catalogDigest: catalogDigestForShards(catalog), catalogRecords: catalog,
          inputs: {
            dialect: sqlArgs.dialect,
            identifierCase: sqlArgs.identifierCase,
            defaultSchema: sqlArgs.defaultSchema,
          },
          run, workerVersion: workerVersions().lineage,
          force: plan.mode === MODE_COLD,
          diag: (d) => { diagnostics.push(d); },
        });
        lineage = [...lineage, ...nat.lineageRecords];
        Object.assign(result.index.statements, nat.statementEntries);
      }
    }

    // WHICH LANES ASSEMBLE. The Java bridge runs when there were Java source
    // roots; the JPA bridge when the Java lane found entity/repository facts or
    // the profile asks for the pack by name (SPEC §15 M10 wiring). The decision
    // is made HERE — the core assembler is handed options, never a profile to
    // interpret.
    const runJava = javaSrc.length > 0;
    const runJpa = runJava && ((profile.frameworkPacks ?? []).includes('jpa')
      || result.javaFacts.some((r) => r && (r.kind === 'entity' || r.kind === 'repository')));
    // …and the MyBatis-Plus bridge on the same two witnesses: the profile names
    // the pack, or the Java lane actually saw a `@TableName` / `BaseMapper<T>` /
    // `ServiceImpl<M, T>` in the source. A project that has neither pays nothing.
    const runMp = runJava && ((profile.frameworkPacks ?? []).includes('mybatis-plus')
      || result.javaFacts.some((r) => r && (r.kind === 'mpEntity' || r.kind === 'mpMapper' || r.kind === 'mpService')));

    // ---- the MyBatis-Plus lane's WRAPPER SQL FRAGMENTS (SPEC §18.2) -------
    // `apply / last / setSql / inSql / notInSql / exists / notExists / having`
    // hand MyBatis-Plus raw SQL. It is SQL, so it belongs to the SQL analyzer —
    // the same lineage.py, the same catalog, dialect and identity rule, the same
    // content-addressed shards as a mapper statement or a native @Query. Run
    // here, after the Java lane produced the wrapper facts and BEFORE the graph
    // is built, so the bridge can attach what came back to the statement the
    // wrapper feeds.
    const mpOpts = runMp ? {
      namingStrategy: profile.mybatisPlus?.namingStrategy ?? null,
      tablePrefix: profile.mybatisPlus?.tablePrefix ?? null,
      logicDeleteValue: profile.mybatisPlus?.logicDeleteValue ?? null,
      logicNotDeleteValue: profile.mybatisPlus?.logicNotDeleteValue ?? null,
      schema: sqlArgs.defaultSchema,
      identifierCase: sqlArgs.identifierCase,
    } : null;
    let fragmentLineage = [];
    const fragStmts = runMp ? wrapperFragmentStatements(result.javaFacts, mpOpts) : [];
    if (fragStmts.length > 0) {
      if (!fs.existsSync(py)) {
        diagnostics.push({
          kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
          reason: `${fragStmts.length} MyBatis-Plus wrapper SQL fragment(s) were found but there is no venv python at ${py} to analyze them. See docs/setup/sql-lane.md. Those fragments stay unresolved on their statements`,
        });
      } else {
        process.stderr.write(`MyBatis-Plus lane: ${fragStmts.length} wrapper SQL fragment(s) -> SQL lineage (dialect ${sqlArgs.dialect || 'sqlglot default/ANSI'}, identifiers ${sqlArgs.identifierCase})…\n`);
        const frag = runLineageForStatements({
          store, index: prevIndex, statements: fragStmts,
          catalogDigest: catalogDigestForShards(catalog), catalogRecords: catalog,
          inputs: {
            dialect: sqlArgs.dialect,
            identifierCase: sqlArgs.identifierCase,
            defaultSchema: sqlArgs.defaultSchema,
          },
          run, workerVersion: workerVersions().lineage,
          force: plan.mode === MODE_COLD,
          diag: (d) => { diagnostics.push(d); },
        });
        // NOT merged into `lineage`: a fragment is not a statement of its own in
        // the graph — its facts belong to the wrapper's statement, which is what
        // the reader called. The shard entries ARE recorded, so the next run
        // reuses the analysis instead of paying for it twice.
        fragmentLineage = frag.lineageRecords;
        Object.assign(result.index.statements, frag.statementEntries);
      }
    }
    // ---- the OpenAPI documents (RM29) -------------------------------------
    // A document is read HERE, beside the lanes, because it is an input like any
    // other: bytes on disk that this run turns into facts. It is NOT sharded and
    // not cached — a document is one file, parsed in milliseconds, and a cache
    // that could hand back a stale contract would be the one thing a drift
    // readout must never do.
    const openapiDocs = [];
    for (const file of openapiFiles) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); }
      catch (e) { die(`--openapi ${file} could not be read: ${e.message}`); }
      const doc = readOpenApiDocument(text, { path: rel });
      openapiDocs.push(doc);
      if (doc.unreadable.length > 0) {
        for (const u of doc.unreadable) {
          diagnostics.push({
            kind: 'UNREADABLE_INPUT', severity: 'warn', key: 'openapi.documents',
            reason: `${rel}: ${u.reason}`,
          });
          process.stderr.write(`  [warn] OPENAPI_UNREADABLE ${rel}:${u.line}: ${u.construct}\n`);
        }
      } else {
        process.stderr.write(`OpenAPI lane: ${rel} (${doc.version === 'unknown' ? 'version not declared' : `openapi ${doc.version}`}`
          + `${doc.basePath ? `, base path ${doc.basePath}` : ''}): ${doc.paths.length} route(s) declared\n`);
      }
    }

    // ---- the web lane's FACTS (RM26, sharded in RM29) ---------------------
    // The worker ran inside `runLanesWithShards` above, over the roots on a cold
    // run and over the changed files on an incremental one; what arrives here is
    // the assembled stream, in the byte order a cold worker prints. The counts
    // are RECOMPUTED from those records rather than read from a `summary`: an
    // incremental run has no single worker invocation to read one from, and a
    // number derived from the same records the bridge sees cannot describe a
    // different run from the facts beside it.
    const webFacts = result.webFacts ?? [];
    let webWorkerStats = null;
    if (webSrc.length > 0 || sel.templateRoots.length > 0) {
      const summary = webFactsSummary(webFacts);
      const u = summary.urlByShape;
      webWorkerStats = {
        files: summary.files, parseErrors: summary.parseErrors, recoveredErrors: summary.recoveredErrors,
        vueFiles: summary.vueFiles, tsFiles: summary.tsFiles, jsFiles: summary.jsFiles,
        calls: summary.calls, callsWithUrl: summary.callsWithUrl,
        urlByShape: { literal: u.literal, template: u.template, constant: u.constant, unresolved: u.unresolved },
        methodBySource: summary.methodBySource ?? {},
        routes: summary.routes, byPack: summary.byPack ?? {},
        aliases: summary.aliases, proxies: summary.proxies, envFiles: summary.envFiles,
        platformSinks: summary.platformSinks ?? {},
        // What a frontend written before modules put in the stream (RM47).
        registrations: summary.registrations ?? {},
        templatesRead: summary.templatesRead ?? 0,
        injectedCalls: summary.injectedCalls ?? 0,
        // The server-rendered pages this run read (RM48).
        templates: summary.templates ?? {},
        roots: webSrc.map(relOf).sort(),
        templateRoots: sel.templateRoots.map((t) => ({ root: relOf(t.root), engine: t.engine, suffix: t.suffix })),
      };
      const t = webWorkerStats.templates;
      process.stderr.write(`Web lane: ${webWorkerStats.files} file(s) (${webWorkerStats.vueFiles} .vue, ${webWorkerStats.tsFiles} .ts/.tsx, ${webWorkerStats.jsFiles} .js/.jsx`
        + `${(t.files ?? 0) > 0 ? `, ${t.files} template(s): ${Object.entries(t.byEngine ?? {}).sort().map(([e, n]) => `${n} ${e}`).join(', ')}` : ''}), `
        + `${webWorkerStats.parseErrors} parse error(s); ${webWorkerStats.callsWithUrl} call site(s) carry a URL `
        + `(${u.literal} literal, ${u.template} template, ${u.constant} constant, ${u.unresolved} unresolved), `
        + `${webWorkerStats.routes} route declaration(s), ${webWorkerStats.aliases} alias(es), ${webWorkerStats.proxies} proxy rule(s)\n`);
      if ((t.files ?? 0) > 0) {
        process.stderr.write(`  the pages: ${t.scripts ?? 0} inline script block(s), ${t.forms ?? 0} form(s), `
          + `${t.links ?? 0} link(s), ${t.includes ?? 0} include(s), `
          + `${t.contextVars ?? 0} variable(s) holding the context path\n`);
      }
      for (const r of webFacts) {
        if (r.kind !== 'parse_error') continue;
        // A parse error on a real frontend file is a FINDING: that file's calls
        // and routes are absent from everything below, and nothing else would
        // say so.
        process.stderr.write(`  [warn] WEB_PARSE_ERROR ${r.file}:${r.line}:${r.col}: ${r.message}\n`);
      }
      // A ROOT NOBODY PACKAGED THAT SAID NOTHING (RM47). Discovery decided that
      // directory was served, and the run read it: if it holds no call this
      // lane could read a URL out of and no route declaration, that is worth a
      // line. A directory of somebody else's plugin scripts looks exactly like a
      // frontend from the outside, and silence there reads as "there is nothing
      // in this product", which is a different sentence.
      const vendoredRel = (profile.webRoots ?? [])
        .filter((r) => r && typeof r.root === 'string' && (r.kind ?? 'declared') === 'vendored')
        .map((r) => relOf(path.resolve(resolved.dotCascade ?? root, r.root)))
        .sort();
      const silent = vendoredRel.filter((rootRel) => {
        const under = (f) => typeof f === 'string' && (f === rootRel || f.startsWith(`${rootRel}/`));
        return !webFacts.some((r) => under(r.file)
          && ((r.kind === 'call' && r.url) || r.kind === 'route' || r.kind === 'registration'));
      });
      if (silent.length > 0) {
        process.stderr.write(`  [warn] WEB_ROOT_SAID_NOTHING ${silent.length} root(s) have no readable HTTP call `
          + `and no route declaration in them: ${listOfFive(silent)}. `
          + 'Take them out of webRoots in the profile if they are not a frontend of yours\n');
      }
    }

    // facts -> Graph through the ONE core-owned seam the working-tree overlay
    // also goes through (src/core/assemble.mjs), with the bridges injected: the
    // identity rule handed in is the SAME one the lineage worker matched with,
    // so the bridge cannot key a table differently from the worker that
    // resolved it.
    // The web bridge's own wall time, measured around the bridge and not around
    // the whole assembly: it is the number the lane line reports, so it has to
    // be the bridge's and nobody else's. Printed, never written into the pack —
    // a clock reading in a pack is a byte that changes when nothing did.
    let webBridgeMs = 0;
    const bridges = {
      ...LANE_BRIDGES,
      addWebFacts: (graph, facts, o) => {
        const t = Date.now();
        try { return addWebFacts(graph, facts, o); } finally { webBridgeMs = Date.now() - t; }
      },
    };
    // THE TRACES, read before the graph is assembled and attached at the end of
    // it (src/core/assemble.mjs runs this bridge last). A trace that cannot be
    // read does not stop the run: it comes back with `unreadable` set, is
    // reported as a warning below, and contributes nothing.
    const otelTraces = otelFiles.map((f) => readOtelTrace(fs.readFileSync(f, 'utf8'), { file: relOf(f) }));
    const {
      graph: g, javaStats: jstats, jpaStats, mpStats, openapiStats, webStats: webBridgeStats,
      runtimeStats,
    } = assembleGraph({
      bridges,
      catalogRecords: catalog, lineageRecords: lineage, javaFacts: result.javaFacts,
      webFacts, openapiDocuments: openapiDocs, otelTraces,
      identifierCase: sqlArgs.identifierCase,
      java: runJava ? {
        packagePrefixes: profile.packagePrefixes ?? [],
        generatedSources: profile.generatedSources ?? { annotations: [], pathGlobs: [] },
        // The SAME declaration the web bridge reads below, applied to the other
        // half of the same problem: a Java service that calls another service
        // through a declared gateway prefix has nowhere else to say so.
        gatewayRoutes: profile.gatewayRoutes ?? {},
      } : null,
      jpa: runJpa ? {
        namingStrategy: profile.jpa?.namingStrategy ?? null,
        schema: sqlArgs.defaultSchema,
        identifierCase: sqlArgs.identifierCase,
      } : null,
      mybatisPlus: mpOpts ? { ...mpOpts, fragmentLineage } : null,
      // The documents run BEFORE the web bridge (src/core/assemble.mjs): a
      // frontend call must be able to land on a route only a document declares.
      openapi: openapiDocs.length > 0 ? {} : null,
      web: webWorkerStats ? {
        // `gatewayRoutes` reaches the web bridge here and the Java bridge above:
        // one declaration, applied to a frontend call and to an imperative
        // service-to-service call, which are the same rewrite either way.
        gatewayRoutes: profile.gatewayRoutes ?? {},
        packages: discovery?.webPackages ?? [],
        // I-5: the `screenAxis` block and `moduleAttribution.codeLength` are
        // read here and nowhere else. `enabled` is the gate on the whole axis.
        screenAxis: { ...(profile.screenAxis ?? {}), enabled: screenGate.enabled },
        codeLength: profile.moduleAttribution?.codeLength ?? null,
      } : null,
      // The runtime evidence lane runs LAST: it annotates the dispatch edges,
      // the statements and the routes every lane above it wrote.
      runtime: otelFiles.length > 0 ? {} : null,
    });
    let laneStats = null;
    if (runJava) {
      laneStats = jstats;
      process.stderr.write(`Java lane: ${jstats.endpoints} endpoints, ${jstats.calls} calls, ${jstats.dispatch} dispatch, ${jstats.implementsStmt} stmt-bindings `
        + `(${jstats.unresolvedCalls} unresolved, ${jstats.externalCalls} external, ${jstats.unboundMapperMethods} mapper method(s) with no statement in this pack)\n`);
      process.stderr.write(`Java lane: ${jstats.parseErrors} parse error(s) over ${jstats.parsedFiles} file(s) with facts\n`);
      // WHAT THE INHERITANCE RULES DID (RM20 §1-§2). Both are reported whatever
      // the numbers, including all-zero: "0 inherited fields" on a project with
      // no generic base class is an answer, and leaving the line out would make
      // a rule that never fired indistinguishable from a rule that is not there.
      const ir = jstats.identifierReceivers ?? { total: 0, inheritedField: 0, generatedField: 0, staticReceiver: 0, unresolved: 0 };
      process.stderr.write(`Java lane: ${ir.total} receiver(s) the file never declares: `
        + `${ir.inheritedField} resolved to a field inherited from a superclass, `
        + `${ir.generatedField ?? 0} to a field a Lombok annotation generates, `
        + `${ir.staticReceiver} are a TYPE (a static call, resolved and not followed), `
        + `${ir.unresolved} unexplained\n`);
      // WHY the calls that are still unresolved are, not just how many. The
      // count above is what a reader calibrates trust on, and one of these four
      // reasons is a thing they can fix in a minute.
      const byReason = Object.entries(jstats.unresolvedCallsByReason ?? {}).filter(([, n]) => n > 0);
      if (byReason.length > 0) {
        process.stderr.write(`Java lane: ${jstats.unresolvedCalls} call(s) still unresolved (`
          + `${byReason.map(([k, n]) => `${k} ${n}`).join(', ')})\n`);
      }
      for (const t of (jstats.typesOutsideRoots ?? []).slice(0, 3)) {
        process.stderr.write(`  [warn] TYPE_OUTSIDE_ROOTS ${t.package}.${t.simple}: ${t.calls} call(s) name it and no analyzed source root holds it. `
          + 'If the module is in this tree, pass --java-src <module>/src/main/java\n');
      }
      const im = jstats.inheritedMembers ?? { synthesized: 0, calls: 0 };
      process.stderr.write(`Java lane: ${jstats.callsByRule['interface-dispatch-inherited'] ?? 0} dispatch edge(s) to a method the implementor only INHERITS: `
        + `${im.synthesized} member(s) instantiated for their concrete class, ${im.calls} call(s) carried into them\n`);
      if (jstats.duplicateFqns.count > 0) {
        // Not a warning: a multi-module repo declaring one FQN twice is normal
        // (jeecg-boot's local-api / cloud-api pair). Said out loud so nobody
        // reading the census concludes the analysis doubled or dropped a type.
        const d = jstats.duplicateFqns;
        process.stderr.write(`Java lane: ${d.count} type(s) declared in more than one file (${d.declarations} declarations: `
          + `${Object.entries(d.byKind).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')}): `
          + `one node each, the graph keeps the last declaration read: ${d.types.slice(0, 3).map((t) => t.fqn).join(', ')}\n`);
      }

      if (runJpa) {
        laneStats = { ...jstats, jpa: jpaStats };
        const byType = Object.entries(jpaStats.statementsByType).filter(([, n]) => n > 0)
          .map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
        process.stderr.write(`JPA lane: ${jpaStats.entities} entities (+${jpaStats.mappedSuperclasses} mapped superclass(es)), `
          + `${jpaStats.repositories} repositories, ${jpaStats.statements} statements (${byType}), `
          + `${jpaStats.joins} association join(s), ${jpaStats.unresolvedStatements} statement(s) with an unresolved part, `
          + `naming strategy ${jpaStats.namingStrategy} (${jpaStats.namingStrategyDeclared ? 'declared' : 'ASSUMED: derived names are HEURISTIC'})\n`);
        for (const u of jpaStats.unresolved.slice(0, 10)) {
          process.stderr.write(`  [warn] JPA_UNRESOLVED ${u.statement ?? '(mapping)'}: ${u.reason} (${u.detail})\n`);
        }
        if (jpaStats.unresolved.length > 10) {
          process.stderr.write(`  … ${jpaStats.unresolved.length - 10} more JPA_UNRESOLVED (all of them are on the statement nodes)\n`);
        }
      }

      if (runMp) {
        laneStats = { ...laneStats, mybatisPlus: mpStats };
        const byVerb = Object.entries(mpStats.statementsByVerb).sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
        process.stderr.write(`MyBatis-Plus lane: ${mpStats.entities} entities (${mpStats.entitiesTableDeclared} with @TableName), `
          + `${mpStats.statements} generic-CRUD statements (${byVerb}), `
          + `${mpStats.wrappers} condition wrapper(s): ${mpStats.wrappersWithColumns} resolved to columns, `
          + `${mpStats.wrappersRuntimeOnly} built outside the method (columns decided at run time), `
          + `${mpStats.logicDeleteRewrites} @TableLogic delete(s) rewritten as writes, `
          + `naming strategy ${mpStats.namingStrategy} (${mpStats.namingStrategyDeclared ? 'declared' : 'ASSUMED: derived names are HEURISTIC'})\n`);
        if (mpStats.sqlFragments > 0) {
          process.stderr.write(`MyBatis-Plus lane: ${mpStats.sqlFragments} raw SQL fragment(s) in wrappers; `
            + `counted where they LAND, on ${mpStats.fragmentsResolved + mpStats.fragmentsUnresolved} statement(s): `
            + `${mpStats.fragmentsResolved} read by the SQL analyzer (${mpStats.fragmentColumns} column fact(s)), `
            + `${mpStats.fragmentsUnresolved} unresolved (the text is on the statement)\n`);
        }
        if (mpStats.opsUninterpretedTotal > 0) {
          process.stderr.write(`  [warn] MP_OP_UNINTERPRETED ${mpStats.opsUninterpretedTotal} wrapper op(s) this lane has no reading for: `
            + `${Object.entries(mpStats.opsUninterpreted).map(([n, c]) => `${n} x${c}`).join(', ')}. Whatever column they name is NOT in the statements above\n`);
        }
        for (const u of mpStats.unresolved.slice(0, 10)) {
          process.stderr.write(`  [warn] MP_UNRESOLVED ${u.statement ?? '(mapping)'}: ${u.reason} (${u.detail})\n`);
        }
        if (mpStats.unresolved.length > 10) {
          process.stderr.write(`  … ${mpStats.unresolved.length - 10} more MP_UNRESOLVED (all of them are on the statement nodes)\n`);
        }
      }
    }
    // ---- the web BRIDGE's own line (RM28) ---------------------------------
    // What the frontend's calls turned into: how many reached a route this pack
    // serves, at which grade, how many did not and why, and the prefix each
    // client instance was read (or guessed) to have. The prefix is the number a
    // reader acts on: a wrong one turns every call in a package into a miss.
    let webStats = webWorkerStats;
    if (webWorkerStats && webBridgeStats) {
      webStats = { ...webWorkerStats, ...webBridgeStats };
      const w = webBridgeStats;
      const reasons = Object.entries(w.unresolved.byReason)
        .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      // One line per DISTINCT answer, not per instance: a package whose four
      // clients all resolved to the same prefix has one thing to say.
      const prefixes = [...new Set(Object.entries(w.prefix).sort(([a], [b]) => (a < b ? -1 : 1))
        .flatMap(([dir, p]) => p.instances.map((i) => `${dir || '.'}: ${i.value === '' ? '(none)' : i.value} (${i.from})`)))]
        .join('; ') || 'none';
      process.stderr.write(`Web lane: ${w.calls.withUrl} call site(s), `
        + `${w.resolved.SOUND_SET + w.resolved.HEURISTIC} resolved (${w.resolved.SOUND_SET} sound, ${w.resolved.HEURISTIC} heuristic), `
        + `${w.unresolved.total} unresolved (${reasons}), ${w.outboundEndpoints} outside-pack; prefix ${prefixes}\n`);
      process.stderr.write(`Web lane: ${w.instances} client instance(s), ${w.wrappers.count} wrapper(s) `
        + `(deepest ${w.wrappers.maxDepth}), ${w.matches.exact} exact and ${w.matches.template} template match(es), `
        + `${w.assumedAliases} call(s) through an assumed alias; bridge ${webBridgeMs} ms\n`);
      for (const u of w.unmatchedUrls.slice(0, 5)) {
        process.stderr.write(`  [warn] WEB_NO_ROUTE ${u.url} (${u.count} call site(s)): nothing in this pack serves it\n`);
      }
      const s = webBridgeStats.screens;
      const pg = s.byKind ?? { router: 0, page: 0 };
      process.stderr.write(`Web lane: ${s.enabled ? `${s.screens} screen(s) from ${s.declared} route declaration(s) and ${pg.page} page(s) a controller renders` : `the screen axis is off, so 0 screen(s) from ${s.declared} route declaration(s)`}, `
        + `${s.withComponent} with a component (${s.componentUnresolved} unresolved), `
        + `${s.renders.EXACT} exact, ${s.renders.SOUND_SET} candidate and ${s.renders.HEURISTIC ?? 0} heuristic RENDERS edge(s); `
        + `${w.functions.created} frontend function node(s) (${w.functions.withHttp} send a request, ${w.functions.reachingHttp} lead to one), `
        + `${w.callsEdges.EXACT + w.callsEdges.SOUND_SET + w.callsEdges.HEURISTIC} CALLS edge(s) `
        + `(${w.callsEdges.EXACT} exact, ${w.callsEdges.SOUND_SET} sound, ${w.callsEdges.HEURISTIC} heuristic; `
        + `${w.callsByRule['passed-as-value'] ?? 0} of them a function handed over as a value)\n`);
      // THE PAGES (RM48). A template a handler names is a page; one nothing
      // names is a fragment or dead markup, and saying how many of each is what
      // stops a silence from reading as "this application has no pages".
      const tp = webBridgeStats.templates;
      if (tp && tp.files > 0) {
        process.stderr.write(`Web lane: ${tp.files} template(s) (${Object.entries(tp.byEngine).sort().map(([e, n]) => `${n} ${e}`).join(', ')}), `
          + `${tp.rendered} of them rendered by a handler or pulled into one, ${tp.unrendered} named by nothing; `
          + `${tp.views} handler(s) name a view (${tp.viewNames} view name(s), ${tp.redirects} redirect(s), `
          + `${tp.unresolvedViews} return(s) this engine could not read)\n`);
        for (const u of (tp.unresolvedViewNames ?? []).slice(0, 5)) {
          process.stderr.write(`  [warn] VIEW_NAME_UNRESOLVED ${u.name} (${u.count} handler(s)): no template under a declared template root answers to that name, so that page is not here\n`);
        }
      }
      for (const u of s.unresolvedSpecifiers.slice(0, 5)) {
        process.stderr.write(`  [warn] SCREEN_COMPONENT_UNRESOLVED ${u.specifier} (${u.count} route declaration(s)): this lane read no file at that specifier, so those screens render nothing\n`);
      }
      for (const u of (s.unresolvedNames ?? []).slice(0, 5)) {
        process.stderr.write(`  [warn] SCREEN_COMPONENT_UNREGISTERED ${u.name} (${u.count} time(s)): nothing in the files this lane read registers that name, so no edge was drawn for it\n`);
      }
      if (s.serverDriven.detected) {
        process.stderr.write(`  [warn] SCREENS_FROM_SERVER a call fetches the menu (${s.serverDriven.menuEndpoints.join(', ')}) and ${s.declared} route(s) are declared in the source: `
          + `${s.declared < s.serverDriven.ceiling ? 'most screens arrive when the app runs' : `screens beyond the ${s.declared} declared arrive when the app runs`}, `
          + 'so the screens here are the ones the source states, not the ones the product has\n');
      }
    }

    // ---- the RECORDINGS (RM30 §E) ----------------------------------------
    // Read AFTER the web bridge, because a recorded path carries the FRONTEND
    // prefix and the prefix decisions are the web bridge's. Every edge it adds
    // is RUNTIME_ONLY: shown, never walked.
    let harStats = null;
    if (harFiles.length > 0) {
      const recordings = harFiles.map((f) => readHar(fs.readFileSync(f, 'utf8'), { file: relOf(f) }));
      harStats = addHarFacts(g, recordings, { prefix: webBridgeStats ? webBridgeStats.prefix : {} });
      process.stderr.write(`HAR lane: ${harStats.files} recording(s), ${harStats.entries} request(s): `
        + `${harStats.matched} matched a route this pack serves, ${harStats.unmatched} matched none, ${harStats.assets} static asset(s); `
        + `${harStats.pairs} screen-to-route pair(s) observed over ${harStats.screensObserved} screen(s) and ${harStats.endpointsObserved} route(s), `
        + `${harStats.pagesWithoutScreen} page(s) the source never declared\n`);
      for (const u of harStats.unreadable) {
        process.stderr.write(`  [warn] HAR_UNREADABLE ${u.file}: ${u.reason}\n`);
      }
      for (const u of harStats.unmatchedPaths.slice(0, 5)) {
        process.stderr.write(`  [warn] HAR_NO_ROUTE ${u.method} ${u.path} (${u.count} request(s)): nothing in this pack serves it, so the recording says the browser asked for something this analysis cannot place\n`);
      }
    }

    // ---- the TRACES: what really ran, beside what could really run --------
    // The bridge itself ran inside `assembleGraph` above (it needs every node
    // the other lanes put in the graph). This is its census.
    if (runtimeStats) {
      const rs = runtimeStats;
      // A file read as an AGENT LOG says so, with the lines it could not use, so
      // a reader who pointed at the wrong log sees a count of nothing rather
      // than a silent pass.
      for (const rec of otelTraces) {
        if (rec.form !== 'log') continue;
        process.stderr.write(`Runtime evidence: ${rec.file} was read as an agent log, one export per line: `
          + `${rec.spans} span(s) in it, ${rec.skippedLines} line(s) carried none\n`);
      }
      process.stderr.write(`Runtime evidence: ${rs.files} trace(s), ${rs.spans} span(s) (${rs.unusable} carried nothing this lane reads), `
        + `${rs.observations} observation(s): ${rs.matched.dispatch} dispatch, ${rs.matched.statement} statement and ${rs.matched.endpoint} route observation(s) matched this pack, `
        + `${rs.unmatched.dispatch + rs.unmatched.statement + rs.unmatched.endpoint} matched none\n`);
      process.stderr.write(`Runtime evidence: ${rs.edgesObserved} static edge(s) marked observed `
        + `(${rs.dispatchDirect} a call the source states, ${rs.dispatchThroughInterface} a candidate set the trace narrowed), `
        + `${rs.edgesAdded} RUNTIME_ONLY edge(s) added for a hop no static rule explains, `
        + `${rs.statementsObserved} statement(s) and ${rs.endpointsObserved} route(s) observed`
        + `${rs.window ? `, window ${rs.window.from} to ${rs.window.to}` : ''}\n`);
      process.stderr.write('Runtime evidence: a grade was neither raised nor lowered by any of this. '
        + 'What the trace did not visit is unknown, not absent\n');
      for (const u of rs.unreadable) {
        process.stderr.write(`  [warn] OTEL_UNREADABLE ${u.file}: ${u.reason}\n`);
      }
      for (const u of rs.unmatchedKeys.slice(0, 5)) {
        process.stderr.write(`  [warn] OTEL_NO_MATCH ${u.kind} ${u.key} (${u.count} observation(s)): the trace saw it and nothing in this pack is keyed that way\n`);
      }
    }

    // ---- the OpenAPI bridge's own line (RM29) -----------------------------
    // The drift census, in the two directions that matter: routes a document
    // declares that nothing here serves, and routes this code serves that no
    // document mentions. Both are findings, and neither is visible from one
    // source alone.
    if (openapiStats) {
      process.stderr.write(`OpenAPI lane: ${openapiStats.paths} declared route(s) over ${openapiStats.documents.length} document(s): `
        + `${openapiStats.matchedServed} also served by this code, ${openapiStats.onlyInDocument} declared and not served, `
        + `${openapiStats.onlyInCode} served and not declared\n`);
      for (const id of openapiStats.drift.onlyInDocument.slice(0, 5)) {
        process.stderr.write(`  [warn] OPENAPI_NOT_SERVED ${id.slice('endpoint:'.length)}: a document declares it and nothing in this pack handles it\n`);
      }
      for (const id of openapiStats.drift.onlyInCode.slice(0, 5)) {
        process.stderr.write(`  [warn] OPENAPI_NOT_DECLARED ${id.slice('endpoint:'.length)}: this code serves it and no document read here declares it\n`);
      }
    }

    const axes = declareAxes(
      {
        ddl: ddls.length > 0 || !!snapshot, statements: mappers.length > 0, code: javaSrc.length > 0,
        // The Java bridge's own stats, so a SHIPPED code axis can still declare
        // the one gap in it a reader can act on (RM35 §G: a wildcard import
        // naming a package of this project that no analyzed root holds).
        java: jstats,
        jpa: jpaStats, mybatisPlus: mpStats, web: webStats, openapi: openapiStats, har: harStats,
      },
      { screenAxisRequested: screenGate.enabled, screenAxisReason: screenGate.reason },
    );
    // §6.1: the manifest PIN is advisory in this engine — it analyzes the
    // working tree. When the two disagree, the pack records the commit it
    // ACTUALLY read and says so, rather than pretending the pin was analyzed.
    if (manifest && base) {
      const pinned = manifest.repositories.find((r) => path.resolve(r.absPath) === path.resolve(root))
        ?? manifest.repositories[0];
      if (pinned && pinned.commit !== base.commit) {
        diagnostics.push({
          kind: 'PIN_MOVED', severity: 'warn', key: 'manifest.repositories',
          reason: `manifest pins ${pinned.key} at ${pinned.commit} but HEAD is ${base.commit}. This pack records HEAD, the commit it actually read. Re-run \`cascade init --force\` to move the pin`,
        });
      }
    }
    for (const d of diagnostics) process.stderr.write(`  [${d.severity}] ${d.kind} ${d.key}: ${d.reason}\n`);

    const st = result.stats;
    const builtAt = new Date().toISOString();
    const pack = projectPack(g, {
      project: projectId, builtAt, lanes, base,
      // The FIRST DDL file: `meta.ddl` is what the viewer opens for a CREATE
      // TABLE preview, and it wants one path. The whole set is in `catalog.paths`.
      ...(ddl ? { ddl: path.resolve(ddl) } : {}),
      // WHAT A NAME MEANS IN THIS PACK (SPEC §8.1). The identity rule the
      // lineage worker matched with — the same value the lane summary prints as
      // `identifierCase` — recorded so the QUERY layer can resolve a `table=` /
      // `column=` argument the way the analyzer resolved the same spelling
      // inside a statement, without re-reading the profile. A pack built before
      // this field existed carries none, and the tools then match exactly, as
      // they used to (src/core/name_resolve.mjs).
      identifierCase: sqlArgs.identifierCase,
      // Everything below is METADATA — outside the digest by construction.
      // WHERE THE CATALOG CAME FROM (SPEC §17.2). A certified layer stays
      // deterministic against a live database only if the pack names the exact
      // snapshot it was built from: dialect, server, fetch time, and the hash
      // of the bytes. Refetching changes the sha256, which changes the catalog
      // shard key, which changes the catalog digest inside every lineage shard
      // key — so a refetch invalidates exactly what the schema change touched.
      catalog: snapshot
        ? {
          source: 'snapshot',
          fetchedAt: snapshotProvenance?.fetchedAt ?? null,
          serverIdentity: snapshotProvenance?.serverIdentity ?? null,
          // MEASURED from the bytes this run actually read, never quoted from
          // snapshot.json — a provenance file that has drifted from the file
          // beside it must not be able to make the pack claim a hash of bytes
          // nobody analyzed. The drift itself is a diagnostic (above).
          sha256: snapshotSha256,
        }
        : ddls.length > 0
          ? {
            source: 'file',
            path: path.basename(ddl),
            sha256: sha256File(ddl),
            // Every file, in the order it was applied, each with its own hash:
            // a catalog folded from three files must not be describable by one.
            paths: ddls.map((f) => ({ path: path.basename(f), sha256: sha256File(f) })),
          }
          : { source: 'none' },
      axes,
      laneStats: (webStats || openapiStats || harStats || runtimeStats)
        ? {
          ...(laneStats ?? {}),
          ...(webStats ? { web: webStats } : {}),
          ...(openapiStats ? { openapi: openapiStats } : {}),
          ...(harStats ? { har: harStats } : {}),
          ...(runtimeStats ? { otel: runtimeStats } : {}),
        }
        : laneStats,
      diagnostics,
      profile: profileFile,
      // Filled in below, once the calibration gate has judged this run. It is
      // metadata, so it is outside the digest and can be attached after the
      // pack has been projected (SPEC §14.2).
      calibration: null,
      // What this run recomputed and what it reused (SPEC §11). A reader can
      // tell an incremental pack from a cold one, and see why a cold one was cold.
      incremental: {
        mode: st.mode,
        base: baseCommit,
        reparsedJava: st.reparsedJava,
        reusedJava: st.reusedJava,
        droppedJava: st.droppedJava,
        reparsedWeb: st.reparsedWeb,
        reusedWeb: st.reusedWeb,
        droppedWeb: st.droppedWeb,
        recomputedLineage: st.recomputedLineage,
        reusedLineage: st.reusedLineage,
        statementsReused: st.statementsReused,
        catalogReused: st.catalogReused,
        shardsRecovered: st.tamperedJava + st.tamperedWeb + st.tamperedLineage,
        reason: st.reason,
      },
    });
    // ---- the calibration gate (SPEC §14.2, §14.3, §15 M3) -----------------
    // Everything that DECIDES is pure (src/core/calibration.mjs). This block
    // measures the pack, fingerprints the engine and the analyzed target, asks
    // the gate, and then FAILS CLOSED: a RED run's pack is written to a
    // `-rejected` directory and the previously certified pack is left exactly
    // where it was (§7.2 — a failed run never mixes with the good snapshot).
    // A pack that does NOT land in the project's own `.cascade/` is a one-off
    // build (`--out /somewhere/else`, or a bare `--pack`): the same rule that
    // stops it registering in the home registry stops it here. It is not this
    // project's certified snapshot, so it neither re-seals the baseline nor is
    // judged against it — and it says so instead of quietly passing.
    const calibrated = registrationTarget(resolved, out) !== null;
    const stateDir = stateDirOf(resolved, out);
    const calibrationDir = path.join(stateDir, 'calibration');
    const goldenDir = path.join(stateDir, 'golden');
    const baselineFile = path.join(calibrationDir, 'baseline.json');
    const gateStateFile = path.join(calibrationDir, 'gate-state.json');
    const receiptFile = path.join(stateDir, 'receipt.json');

    const sqlStats = sqlLaneTallies(lineage);
    const metrics = calibrationMetrics(g, { laneStats, sqlStats });
    const profileDigest = profileDigestOf(profile);
    const catalogDigest = catalog.length > 0 ? catalogDigestOf(catalog) : null;
    const optOuts = [
      flags.noDdl ? '--no-ddl' : null,
      flags.noMappers ? '--no-mappers' : null,
      flags.noJava ? '--no-java' : null,
    ].filter(Boolean);
    const pin = pinOf({
      commit: base?.commit ?? null, dirty: base?.dirty === true,
      selection: selectionRel, optOuts, profileDigest, catalogDigest,
    });
    const enginePrintNow = runningEnginePrint();

    let baseline = null;
    if (calibrated && fs.existsSync(baselineFile)) {
      try { baseline = validateBaseline(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))); }
      catch (e) {
        // A baseline that exists but cannot be read is NOT the same as no
        // baseline: silently bootstrapping over it would turn a corrupted (or
        // edited) seal into a clean bill of health.
        die(`the sealed baseline at ${baselineFile} is unusable: ${e.message}\n`
          + '  delete it deliberately to bootstrap a new one, or restore it from version control');
      }
    }
    const gate = gateEvaluate({ baseline, current: { enginePrint: enginePrintNow, pin, profileDigest, catalogDigest, metrics }, profile });

    const acceptBaseline = flag('accept-baseline');
    const overrideOf = gate.verdict === 'RED' && acceptBaseline ? 'RED' : null;
    const verdict = overrideOf ? 'GREEN' : gate.verdict;
    const red = calibrated && verdict === 'RED';

    // The project golden, scored through the SHIPPED tool catalog (SPEC §14.1).
    let goldenSummaryDoc = null;
    const casesFile = path.join(goldenDir, 'cases.jsonl');
    if (fs.existsSync(casesFile)) {
      try {
        const cases = parseCases(fs.readFileSync(casesFile, 'utf8'));
        if (cases.length > 0) {
          const ask = goldenAsk(g, pack, profile);
          goldenSummaryDoc = checkCases(cases, { ask }).summary;
        }
      } catch (e) {
        process.stderr.write(`golden check skipped: ${e.message}\n`);
      }
    }

    if (!calibrated) {
      process.stderr.write(`gate: SKIPPED - this pack is a one-off build at ${out}, outside ${resolved.dotCascade ?? 'any project .cascade/'}. `
        + 'Nothing was compared and nothing was sealed. Run without --out (or with --root/--project) to certify the project\'s pack\n');
    }
    const gateState = gateStateOf({
      evaluatedAt: builtAt,
      gate: { ...gate, verdict },
      baselineSealedAt: gate.baselineSealedAt,
      goldenSummary: goldenSummaryDoc,
      extra: {
        enginePrint: enginePrintNow,
        pin,
        thresholds: gate.thresholds,
        ...(overrideOf ? { acceptedByHuman: true, overrideOf } : {}),
      },
    });
    pack.meta.calibration = {
      mode: gate.mode, verdict, baselineSealedAt: gate.baselineSealedAt,
      firstRun: profile.calibration?.firstRun ?? null,
    };

    // THE TRACES JOIN THE FACT INDEX (I-9). Every other input to a pack is
    // content-addressed, and evidence must be too: the index records the bytes
    // of each trace this run read, so a pack and the trace it was built from can
    // never disagree about which capture is being claimed, and a changed trace
    // is visible as a changed input rather than as a pack that quietly says
    // something new. The trace lane is not sharded (it is folded into the graph
    // at assembly time, cold or incremental alike), so the record is the hash
    // and nothing else.
    if (otelFiles.length > 0) {
      result.index.runtimeEvidence = {
        otel: otelFiles.map((f) => ({ path: relOf(f), sha256: sha256File(f) })),
      };
    }
    const writeDir = red ? `${out}-rejected` : out;
    const writeIndexFile = path.join(writeDir, 'facts-index.json');
    fs.mkdirSync(writeDir, { recursive: true });
    fs.writeFileSync(path.join(writeDir, 'pack.json'), JSON.stringify(pack));
    fs.writeFileSync(writeIndexFile, serializeIndex(result.index));
    // THE ROUTE INDEX (RM44), beside the pack and never inside it. It says what
    // this project SERVES and what it CALLS and does not serve, so a server
    // holding several projects can join one project's outbound call to another
    // project's route without parsing a single pack. It is DERIVED from the
    // graph, so it is not an input to the digest (I-9): it carries the digest
    // of the pack it came from instead, and a server refuses an index that no
    // longer describes the pack beside it.
    const routesIndex = buildRoutesIndex(g, {
      project: pack.meta?.project ?? projectId ?? null,
      buildDigest: pack.digest,
      // THE NAMES THIS DEPLOYABLE ANSWERS TO (RM46): the profile's, which
      // `cascade init` filled in from `spring.application.name`, or this run's
      // own discovery when the profile declares none. A call is matched by its
      // path and method; when two projects serve the same path, the name the
      // caller wrote is the only thing that tells them apart. It is metadata
      // beside the pack, never in it, so neither choice moves a digest.
      serviceNames: serviceNames.names,
    });
    const routesFile = path.join(writeDir, ROUTES_FILE);
    fs.writeFileSync(routesFile, serializeRoutesIndex(routesIndex));
    if (calibrated) {
      fs.mkdirSync(calibrationDir, { recursive: true });
      fs.writeFileSync(gateStateFile, JSON.stringify(gateState, null, 2) + '\n');
    }

    if (calibrated) process.stderr.write(gateLine({ ...gate, verdict })
      + (overrideOf ? ' (accepted by --accept-baseline)' : '') + '\n');
    for (const f of gate.findings.filter((x) => x.severity !== 'info').slice(0, 10)) {
      process.stderr.write(`  [${f.severity}] ${f.metric}: ${f.reason}\n`);
    }
    const infoCount = gate.findings.filter((x) => x.severity === 'info').length;
    if (infoCount > 0) process.stderr.write(`  ${infoCount} improvement/unmeasurable finding(s) in ${gateStateFile}\n`);
    if (goldenSummaryDoc) {
      process.stderr.write(`golden: ${goldenSummaryDoc.status} over ${goldenSummaryDoc.scored} scored case(s)`
        + `${goldenSummaryDoc.unscorable ? ` (${goldenSummaryDoc.unscorable} unscorable)` : ''}: `
        + Object.entries(goldenSummaryDoc.relations).map(([r, v]) => `${r} ${v.status}(n=${v.n})`).join(', ') + '\n');
    }

    // Seal (or re-seal) the baseline: the "previous certified run" moves forward
    // on every run the gate let through, so tomorrow's comparison is against
    // today, not against the first run this project ever did.
    if (calibrated && !red && (gate.reseal || overrideOf)) {
      const sealed = sealBaseline({ sealedAt: builtAt, enginePrint: enginePrintNow, pin, profileDigest, catalogDigest, metrics });
      fs.writeFileSync(baselineFile, JSON.stringify(sealed, null, 2) + '\n');
      process.stderr.write(`baseline ${baseline ? 're-sealed' : 'sealed'} at ${baselineFile} (${Object.keys(metrics.ratios).length} ratios, ${Object.keys(metrics.counts).length} counts)\n`);
    }

    if (red) {
      process.stderr.write(`REJECTED: the pack was written to ${path.join(writeDir, 'pack.json')} and the certified pack at ${path.join(out, 'pack.json')} was NOT touched\n`
        + '  a regression is not a new snapshot: fix it. If this drop is the intended new normal, re-run with `--accept-baseline`,\n'
        + '  which re-seals the baseline from THIS run. That is the only override, and it is a human decision.\n');
      process.exit(3);
    }

    // The receipt (SPEC §14.4): what this certified run produced, hashed.
    if (calibrated) {
    const receipt = buildReceipt({
      builtAt,
      ttlDays: receiptTtlDaysOf(profile),
      enginePrint: enginePrintNow,
      pack: { digest: pack.digest, project: pack.meta?.project ?? null },
      gate: { mode: gateState.mode, verdict: gateState.verdict, evaluatedAt: builtAt },
      files: [
        { name: relToState(stateDir, path.join(writeDir, 'pack.json')), sha256: hashOrNull(path.join(writeDir, 'pack.json')) },
        { name: relToState(stateDir, writeIndexFile), sha256: hashOrNull(writeIndexFile) },
        { name: relToState(stateDir, gateStateFile), sha256: hashOrNull(gateStateFile) },
      ],
    });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    process.stderr.write(`receipt ${receiptFile}: expires ${receipt.expiresAt} (verify with \`cascade verify\`)\n`);
    }

    process.stderr.write(`wrote ${path.join(writeDir, 'pack.json')}: ${pack.counts.nodes} nodes, ${pack.counts.edges} edges, lanes [${lanes.join(',')}], digest ${pack.digest}\n`);
    process.stderr.write(`routes index: ${routesIndex.serves.length} served, ${routesIndex.calls.length} outbound\n`);
    process.stderr.write(`axes: ${Object.entries(axes).map(([k, v]) => `${k}=${v.status}`).join(' ')}\n`);
    // The web lane's own reuse line, in the same words as the Java lane's, so a
    // reader can see which of the two paid for this run.
    const webLine = webSrc.length === 0 ? '' : (st.mode === MODE_COLD
      ? `, read ${st.reparsedWeb} web file(s)`
      : `, reparsed ${st.reparsedWeb} web file(s) (${st.reusedWeb} reused, ${st.droppedWeb} dropped)`);
    process.stderr.write(st.mode === MODE_COLD
      ? `cold (${st.reason}): parsed ${st.reparsedJava} java file(s)${webLine}, ${st.recomputedLineage} lineage shard(s) over ${st.statements} statement(s), pack digest ${pack.digest}\n`
      : `incremental: reparsed ${st.reparsedJava} java files (${st.reusedJava} reused, ${st.droppedJava} dropped)${webLine}, `
        + `lineage recomputed ${st.recomputedLineage} statements (${st.reusedLineage} reused), `
        + `mapper statements ${mappers.length === 0 ? 'not run' : st.statementsReused ? 'reused' : 'recomputed'}, `
        + `catalog ${ddls.length === 0 ? 'not run' : st.catalogReused ? 'reused' : 'recomputed'}, `
        + `pack digest ${pack.digest}\n`);
    for (const n of plan.notes ?? []) process.stderr.write(`  note: ${n}\n`);
    const shardLanes = Object.values(result.index.files);
    process.stderr.write(`facts index ${writeIndexFile}: ${shardLanes.filter((e) => e.lane !== 'web').length} java shard(s), `
      + `${shardLanes.filter((e) => e.lane === 'web').length} web shard(s), `
      + `${Object.keys(result.index.statements).length} lineage shard(s)${projectId ? ` in ${cacheDir(projectId, process.env)}/cas` : ' (IN MEMORY: not reusable, see above)'}\n`);
    if (base?.dirty) {
      process.stderr.write(`base ${base.commit.slice(0, 12)} + ${base.dirtyFiles.length} DIRTY analysis input(s): this pack describes the WORKING TREE, not that commit: `
        + `${base.dirtyFiles.slice(0, 5).join(', ')}${base.dirtyFiles.length > 5 ? `, … ${base.dirtyFiles.length - 5} more` : ''}\n`);
    }
    // Keep the home registry current: this project now has a pack, built at
    // `builtAt`, over these lanes (SPEC §5). Only when the pack landed inside a
    // project's `.cascade/` — a bare --out elsewhere registers nothing.
    const target = registrationTarget(resolved, out);
    if (target) {
      target.dotCascade = realPath(target.dotCascade);
      const manifestFile = path.join(target.dotCascade, 'manifest.json');
      let id = target.projectId;
      if (!id && fs.existsSync(manifestFile)) {
        try { id = loadManifest(manifestFile).project; } catch (e) { process.stderr.write(`registry: ignoring ${manifestFile} (${e.message})\n`); }
      }
      if (!id) id = slugify(opt('project', '') || path.basename(path.dirname(target.dotCascade)));
      const regFile = registryPath(process.env);
      if (!id) {
        process.stderr.write(`registry not updated: no usable project id for ${target.dotCascade}. Run \`cascade init --project <id>\`\n`);
      } else {
        try {
          writeRegistryAtomic(regFile, upsertProject(readRegistry(regFile), {
            id, dotCascadePath: target.dotCascade, source: 'analyze', stack: lanes, lastCertifiedAt: builtAt,
          }));
          process.stderr.write(`registry: ${id} -> ${target.dotCascade} (${regFile})\n`);
        } catch (e) {
          process.stderr.write(`registry not updated: ${e.message}\n`);
        }
      }
    }
  } finally {
    SCRATCH.remove(tmpDir);
  }
  process.exit(0);
}

if (cmd === 'catalog') {
  // SPEC §12 — the DB catalog adapter. THREE subcommands, and the split is the
  // whole security design (§12.3, §17.5):
  //
  //   discover     reads the repository and LISTS where a database might be. It
  //                connects to nothing and it never reads a password value.
  //   fetch        connects — once, read-only, and ONLY after the user has seen
  //                the exact target and confirmed it. The connection info comes
  //                out of the analyzed repository, which is untrusted input: a
  //                malicious checkout must not be able to make this tool dial a
  //                host of the attacker's choosing.
  //   credentials  manages the ONE file that holds a password, in the tool home
  //                at mode 0600, never under a project tree.
  //
  // Nothing writes a credential into the project (§17.3). The password is never
  // an argument; the worker reads it from the environment variable named by
  // --password-env, and it never reaches `.cascade/`, the pack, or a log.
  const sub = argv[1];
  const asJson = flag('json');

  /**
   * The credentials file for this run, refusing the one place it must never be.
   * `CASCADE_HOME` is an override for tests and for a reader who keeps tool
   * state elsewhere; pointed inside an analyzed project it would put the
   * password in the tree, and a tree travels.
   */
  function credentialsFileOrDie() {
    const file = credentialsPath(process.env);
    let projectRoot = null;
    try {
      const r = resolveProject({ project: opt('project'), root: opt('root'), cwd: process.cwd(), env: process.env });
      if (r.dotCascade && fs.existsSync(r.dotCascade)) projectRoot = path.dirname(r.dotCascade);
    } catch { projectRoot = null; }
    if (projectRoot && isInside(file, projectRoot)) {
      die(`the credentials file would be ${file}, which is inside the project at ${projectRoot}.\n`
        + '  A password under an analyzed tree travels with the tree. A zip, a copy to a colleague, a `git add -f`,\n'
        + '  a cloud-drive sync and a container mount all carry it along, and a gitignore stops none of them.\n'
        + '  Point CASCADE_HOME somewhere outside the project (the default, ~/.cascade, already is).');
    }
    return file;
  }

  /**
   * The connection target the flags name: a URL, or the fields spelled out. The
   * SAME parse `fetch` uses, so a target that works there works here, and a
   * password smuggled into a URL is stripped rather than used.
   */
  function targetFromFlags() {
    let t;
    if (opt('url')) {
      const parsed = parseConnectionUrl(opt('url'));
      if (!parsed) die(`--url ${JSON.stringify(opt('url'))} is not a connection URL (jdbc:mysql://…, jdbc:postgresql://…, jdbc:oracle:thin:@…, postgres://…, mysql://…)`);
      for (const note of parsed.notes) process.stderr.write(`note: ${note}\n`);
      t = {
        dialect: opt('dialect', parsed.dialect), host: opt('host', parsed.host),
        port: opt('port') ? Number(opt('port')) : parsed.port,
        database: opt('database', parsed.database),
        user: opt('user', parsed.usernameRef && !/^\$\{/.test(parsed.usernameRef) ? parsed.usernameRef : null),
      };
    } else {
      t = {
        dialect: opt('dialect'), host: opt('host'),
        port: opt('port') ? Number(opt('port')) : null,
        database: opt('database'), user: opt('user'),
      };
    }
    if (t.dialect && !t.port) t.port = DEFAULT_PORTS[t.dialect] ?? null;
    const missing = ['dialect', 'host', 'port', 'database', 'user'].filter((k) => !t[k]);
    if (missing.length > 0) {
      die(`the connection target is incomplete (missing: ${missing.join(', ')}).\n`
        + '  Name it as a URL, or field by field:\n'
        + '  --url jdbc:mysql://host:3306/db --user u\n'
        + '  --dialect mysql --host host --port 3306 --database db --user u');
    }
    if (!CONNECTION_DIALECTS.includes(t.dialect)) {
      die(`--dialect ${t.dialect} is not one of ${CONNECTION_DIALECTS.join('|')}`);
    }
    return t;
  }

  if (sub === 'discover') {
    const root = realPath(path.resolve(opt('root', process.cwd())));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`--root ${root} is not a directory`);
    const discovery = discover(root, DISCOVER_IO);
    const candidates = discovery.connectionCandidates ?? [];
    if (asJson) {
      process.stdout.write(JSON.stringify({
        schema: 'cascade:catalog-candidates:1', root, candidates,
      }, null, 2) + '\n');
      process.exit(0);
    }
    process.stdout.write(`connection-info candidates under ${root}: ${candidates.length}\n`);
    if (candidates.length === 0) {
      process.stdout.write('  none: no application.yml / .properties / .env in this tree names a datasource URL.\n'
        + '  A DDL file works just as well, and needs no connection at all: `cascade analyze --ddl <schema.sql>`.\n');
    }
    candidates.forEach((c, i) => {
      process.stdout.write(`  [${i + 1}] ${c.path}  (${c.kind})\n`
        + `      ${describeCandidate(c)}\n`
        + `      ${c.url}\n`);
    });
    if (candidates.length > 0) {
      process.stdout.write('\nNo password VALUE is read, printed or stored, only whether one is there and where it comes from.\n'
        + 'Nothing above has been connected to. To pin a read-only snapshot of one of them:\n'
        + '  cascade catalog fetch --candidate 1\n'
        + 'It shows the target and asks before it connects, and asks for the password without echoing it.\n'
        + `In a script there is nobody to ask, so pass --yes and put the password in ${DEFAULT_PASSWORD_ENV}.\n`);
    }
    process.exit(0);
  }

  // ---- credentials ------------------------------------------------------
  //
  // WHY A FILE IN THE HOME AND NOT IN THE PROJECT. A gitignore is a convention,
  // not a boundary: a project directory gets force-added, zipped, copied to a
  // colleague, synced to a cloud drive and mounted into a container, and every
  // one of those carries whatever is inside it along. So the password lives in
  // the tool home at mode 0600, keyed by server and user, exactly the way
  // ~/.pgpass and ~/.my.cnf have worked for decades. src/core/credentials.mjs
  // holds the format and the permission rule; this block is the command.
  if (sub === 'credentials') {
    const op = argv[2];
    if (!['list', 'set', 'remove'].includes(op ?? '')) {
      die('usage: cascade catalog credentials list\n'
        + '       cascade catalog credentials set    --url <jdbc url> --user <u> [--password-env NAME]\n'
        + '       cascade catalog credentials remove --url <jdbc url> --user <u>\n'
        + '       (--dialect <d> --host <h> [--port <p>] --database <db> --user <u> names the same target field by field)');
    }
    const file = credentialsFileOrDie();
    if (op === 'list') {
      let held;
      try { held = listCredentials(file); }
      catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${file}: ${e.message}`); }
      if (!modeVerdict(file).exists) {
        process.stdout.write(`no credentials file at ${file} yet.\n`
          + '  `cascade catalog credentials set --url <jdbc url> --user <u>` creates one, at mode 0600.\n');
        process.exit(0);
      }
      process.stdout.write(`credentials in ${file} (${held.length}):\n`);
      for (const e of held) process.stdout.write(`  ${e.server}  as user ${e.user}\n`);
      process.stdout.write('no password is printed here, and none ever will be. This is the whole list of what is stored:\n'
        + 'a server, a user, and a secret only the fetch reads.\n');
      process.exit(0);
    }

    const t = targetFromFlags();
    const server = serverKey(t);
    if (op === 'remove') {
      let result;
      try { result = removeCredential(file, server, t.user); }
      catch (e) { die(e instanceof CredentialsError ? e.message : `cannot rewrite ${file}: ${e.message}`); }
      if (!result.removed) die(`no entry for ${server} as user ${t.user} in ${file}. \`cascade catalog credentials list\` shows what is there`);
      process.stderr.write(`removed ${server} as user ${t.user} from ${file} (${result.remaining} entry(ies) left)\n`);
      process.exit(0);
    }

    // set. The password itself never arrives as an argument, so it comes from
    // the environment (scriptable) or from a hidden prompt (interactive).
    const setEnv = opt('password-env');
    let secret = null;
    if (setEnv) {
      secret = process.env[setEnv];
      if (!secret) die(`the environment variable ${setEnv} is empty. Put the password there (\`export ${setEnv}='…'\`) or drop --password-env and be asked for it`);
    } else if (process.env[DEFAULT_PASSWORD_ENV]) {
      secret = process.env[DEFAULT_PASSWORD_ENV];
    } else if (process.stdin.isTTY) {
      secret = promptHidden(`password for ${server} as user ${t.user} (not echoed): `);
      if (!secret) die('nothing was typed, so nothing was stored');
    } else {
      die(`there is no password to store and no terminal to ask on.\n`
        + `  Set ${DEFAULT_PASSWORD_ENV}, or name another variable with --password-env <NAME>,\n`
        + '  or run this command in a terminal and be asked for it.');
    }
    let result;
    try { result = setCredential(file, { server, user: t.user, password: secret }); }
    catch (e) { die(e instanceof CredentialsError ? e.message : `cannot write ${file}: ${e.message}`); }
    process.stderr.write(`${result.replaced ? 'replaced' : 'stored'} the password for ${server} as user ${t.user} in ${file} (mode 0600)\n`
      + '  It is outside every project tree on purpose, so no copy, zip or push of a repository carries it.\n');
    process.exit(0);
  }

  if (sub !== 'fetch') {
    die('usage: cascade catalog discover [--root <dir>] [--json]\n'
      + '       cascade catalog fetch [--project <id>|--root <dir>]\n'
      + '                             [--candidate <n> | --url <jdbc url> --user <u>\n'
      + '                              | --dialect <d> --host <h> [--port <p>] --database <db> --user <u>]\n'
      + '                             [--password-env NAME] [--schema NAME] [--stamp-schema NAME] [--yes]\n'
      + '       cascade catalog credentials <list|set|remove> [--url <jdbc url> --user <u>]');
  }

  // ---- fetch ------------------------------------------------------------
  const root = realPath(path.resolve(opt('root', process.cwd())));
  const resolved = resolveOrDie({ strictProject: false });
  if (!resolved.dotCascade) {
    die('no project state directory (.cascade/) for this target. Run `cascade init` first, so the snapshot has a home that is already gitignored');
  }
  const passwordEnvOpt = opt('password-env');
  const passwordEnv = passwordEnvOpt ?? DEFAULT_PASSWORD_ENV;

  // Where the target comes from: a discovered candidate, or flags the user typed.
  let target = null;
  let candidatePath = null;
  const candidateOpt = opt('candidate');
  if (candidateOpt !== undefined) {
    const discovery = discover(root, DISCOVER_IO);
    const candidates = discovery.connectionCandidates ?? [];
    const n = Number(candidateOpt);
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
      die(`--candidate ${JSON.stringify(candidateOpt)} is not one of the ${candidates.length} candidate(s) under ${root}. Run \`cascade catalog discover\` to see them`);
    }
    const c = candidates[n - 1];
    candidatePath = c.path;
    target = {
      dialect: c.dialect, host: c.host, port: c.port ?? (c.dialect ? DEFAULT_PORTS[c.dialect] : null),
      database: c.database, user: opt('user', c.usernameRef ?? null),
    };
    if (target.user && /^\$\{/.test(target.user)) {
      die(`candidate ${n} names its user as the unresolved placeholder ${target.user}. Pass --user <name> explicitly`);
    }
  } else if (opt('url')) {
    // The same URL forms `discover` reads, typed by hand. Parsed by the SAME
    // code, so a URL that works in a config file works here — and a password
    // smuggled into it is stripped out rather than used (the password comes
    // from the environment, always).
    const parsed = parseConnectionUrl(opt('url'));
    if (!parsed) die(`--url ${JSON.stringify(opt('url'))} is not a connection URL (jdbc:mysql://…, jdbc:postgresql://…, jdbc:oracle:thin:@…, postgres://…, mysql://…)`);
    for (const note of parsed.notes) process.stderr.write(`note: ${note}\n`);
    target = {
      dialect: opt('dialect', parsed.dialect), host: opt('host', parsed.host),
      port: opt('port') ? Number(opt('port')) : parsed.port,
      database: opt('database', parsed.database),
      user: opt('user', parsed.usernameRef && !/^\$\{/.test(parsed.usernameRef) ? parsed.usernameRef : null),
    };
    if (target.dialect && !target.port) target.port = DEFAULT_PORTS[target.dialect] ?? null;
  } else {
    target = {
      dialect: opt('dialect'), host: opt('host'),
      port: opt('port') ? Number(opt('port')) : null,
      database: opt('database'), user: opt('user'),
    };
    if (target.dialect && !target.port) target.port = DEFAULT_PORTS[target.dialect] ?? null;
  }

  const missing = ['dialect', 'host', 'port', 'database', 'user'].filter((k) => !target[k]);
  if (missing.length > 0) {
    die(`the connection target is incomplete (missing: ${missing.join(', ')}).\n`
      + '  Pass --candidate <n> (see `cascade catalog discover`), or --url with --user, or spell it out:\n'
      + '  cascade catalog fetch --url jdbc:mysql://h:3306/db --user u --password-env VAR --yes\n'
      + '  cascade catalog fetch --dialect mysql --host h --port 3306 --database db --user u --password-env VAR --yes');
  }
  if (!CONNECTION_DIALECTS.includes(target.dialect)) {
    die(`--dialect ${target.dialect} is not one of ${CONNECTION_DIALECTS.join('|')}`);
  }

  // WHERE THE PASSWORD WILL COME FROM, decided before anything is printed and
  // long before anything is typed, so the confirmation below can say it. The
  // order is the order of decreasing explicitness:
  //
  //   1. --password-env NAME     the reader named the variable on this command
  //   2. CASCADE_DB_PASSWORD     the variable this tool has always read
  //   3. the credentials file    $CASCADE_HOME/credentials, mode 0600, keyed by
  //                              server and user
  //   4. a hidden prompt         only with a terminal to ask on, and it offers
  //                              to save what it was told
  //
  // The VALUE is not fetched yet for 3 and 4: the plan is, the secret is read
  // after the target is confirmed. Nothing is read out of the analyzed
  // repository, ever, whatever password that file carries.
  const credFile = credentialsFileOrDie();
  const identity = `${target.host}:${target.port}/${target.database}`;
  const server = serverKey(target);
  let credentialsHolds = false;
  if (!passwordEnvOpt && !process.env[DEFAULT_PASSWORD_ENV]) {
    try { credentialsHolds = findPassword(credFile, server, target.user) !== null; }
    catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${credFile}: ${e.message}`); }
  }
  const passwordFrom = passwordEnvOpt ? 'env-named'
    : process.env[DEFAULT_PASSWORD_ENV] ? 'env-default'
      : credentialsHolds ? 'credentials'
        : process.stdin.isTTY ? 'prompt' : 'nowhere';
  const passwordSourceLine = {
    'env-named': `from the environment variable ${passwordEnv} (never from the command line, never stored)`,
    'env-default': `from the environment variable ${DEFAULT_PASSWORD_ENV} (never from the command line, never stored)`,
    credentials: `from ${credFile} (mode 0600, this server and this user)`,
    prompt: 'asked for here, not echoed, and stored only if you say so',
    nowhere: 'NOT AVAILABLE YET, see below',
  }[passwordFrom];

  // THE CONFIRMATION (SPEC §12.3, §17.5). What is about to happen, in full,
  // before it happens. In a terminal the reader answers it here; outside one,
  // --yes is the answer, because a script cannot be asked.
  process.stderr.write(
    'cascade catalog fetch would open a READ-ONLY connection to:\n'
    + `  ${target.dialect} ${identity}\n`
    + `  as user      ${target.user}\n`
    + `  password     ${passwordSourceLine}\n`
    + `  read from    ${candidatePath ?? 'flags you typed'}\n`
    + `  writes       ${catalogPathsOf(resolved.dotCascade).catalog}\n`
    + `               ${catalogPathsOf(resolved.dotCascade).catalogSnapshot}\n`
    + '  queries      metadata SELECTs only (tables, columns, comments, primary keys)\n');
  if (!flag('yes')) {
    if (process.stdin.isTTY) {
      // The same one-glance confirmation, asked instead of demanded. It stays
      // because the host above came out of the analyzed repository, and a
      // saved credential for that host does not make the host trustworthy.
      if (!confirmYesNo('\nConnect to this target? [y/N] ')) {
        process.stderr.write('nothing was connected to.\n');
        process.exit(2);
      }
    } else {
      process.stderr.write(
        '\nRefusing to connect: pass --yes to confirm this exact target.\n'
        + '  The connection info above came out of the analyzed repository, which this tool treats as\n'
        + '  untrusted input. A checkout must not be able to make it dial a host by itself.\n');
      process.exit(2);
    }
  }

  // NOW the secret, and only now.
  let password = null;
  let offerToSave = false;
  if (passwordFrom === 'env-named') {
    password = process.env[passwordEnv];
    if (!password) die(`the environment variable ${passwordEnv} is empty. Put the password there (\`export ${passwordEnv}='…'\`) or name another one with --password-env`);
  } else if (passwordFrom === 'env-default') {
    password = process.env[DEFAULT_PASSWORD_ENV];
  } else if (passwordFrom === 'credentials') {
    try { password = findPassword(credFile, server, target.user); }
    catch (e) { die(e instanceof CredentialsError ? e.message : `cannot read ${credFile}: ${e.message}`); }
    if (!password) die(`${credFile} no longer holds an entry for ${server} as user ${target.user}`);
  } else if (passwordFrom === 'prompt') {
    password = promptHidden(`password for ${target.user} at ${identity} (not echoed): `);
    if (!password) die('nothing was typed, so nothing was connected to');
    offerToSave = true;
  } else {
    die('there is no password for this connection, and no terminal to ask on. In order, this command reads:\n'
      + '  1. the variable named by --password-env <NAME>\n'
      + `  2. the environment variable ${DEFAULT_PASSWORD_ENV}\n`
      + `  3. an entry in ${credFile} for ${server} as user ${target.user}\n`
      + '     (`cascade catalog credentials set --url <jdbc url> --user <u>` writes one, at mode 0600)\n'
      + '  4. a hidden prompt, when a terminal is attached\n'
      + '  This run has none of the four.');
  }
  if (offerToSave && confirmYesNo(`Save it in ${credFile} for next time? [y/N] `)) {
    try {
      setCredential(credFile, { server, user: target.user, password });
      process.stderr.write(`saved ${server} as user ${target.user} in ${credFile} (mode 0600, outside every project tree)\n`);
    } catch (e) {
      process.stderr.write(`could not save it: ${e.message}\n  The fetch below runs anyway.\n`);
    }
  }
  // The worker takes the password from an environment variable it is told the
  // NAME of, so a password that came from the file or the prompt travels the
  // same way: into the CHILD's environment only, under the default name, never
  // into this process's own and never into argv.
  const workerEnv = { ...process.env };
  const workerPasswordEnv = passwordFrom === 'env-named' ? passwordEnv : DEFAULT_PASSWORD_ENV;
  workerEnv[workerPasswordEnv] = password;

  const paths = ensureProjectDirs(path.dirname(resolved.dotCascade));
  const catalogDir = path.dirname(paths.catalog);
  const partial = path.join(catalogDir, '.columns.jsonl.partial');

  const workerArgs = [
    '--dialect', target.dialect, '--host', target.host, '--port', String(target.port),
    '--database', target.database, '--user', target.user,
    '--password-env', workerPasswordEnv, '--out', partial,
  ];
  if (opt('schema')) workerArgs.push('--schema', opt('schema'));
  if (opt('stamp-schema')) workerArgs.push('--stamp-schema', opt('stamp-schema'));

  // The worker is overridable so the credential-non-leak test can run the whole
  // path end to end without a database (test/catalog_fetch.test.mjs).
  const override = process.env.CASCADE_CATALOG_WORKER;
  let cmdPath;
  let cmdArgs;
  if (override) {
    const isNodeScript = /\.(mjs|cjs|js)$/.test(override);
    cmdPath = isNodeScript ? process.execPath : override;
    cmdArgs = isNodeScript ? [override, ...workerArgs] : workerArgs;
  } else {
    const pyRes = sqlPython();
    if (!pyRes.ok) die(noSqlPython('reading a live catalog', pyRes));
    const py = pyRes.path;
    cmdPath = py;
    cmdArgs = [path.join(ENGINE_ROOT, 'adapters', 'sql', 'catalog_live.py'), ...workerArgs];
  }

  process.stderr.write(`connecting (read-only) to ${target.dialect} ${identity}…\n`);
  try {
    execFileSync(cmdPath, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'], env: workerEnv, maxBuffer: 1 << 28 });
  } catch (e) {
    try { fs.unlinkSync(partial); } catch { /* nothing to clean up */ }
    die(`the catalog worker failed (exit ${e.status ?? '?'}). Nothing was written.\n`
      + '  A missing driver, a refused login and an unreachable host are all reported above as a structured line.');
  }

  let records;
  try { records = jsonl(partial); }
  catch (e) { die(`the catalog worker produced no readable JSONL at ${partial}: ${e.message}`); }
  const header = records[0];
  if (!header || header.kind !== 'header' || header.schema !== 'cascade:catalog-snapshot:1') {
    try { fs.unlinkSync(partial); } catch { /* best effort */ }
    die(`the catalog worker's first record is not a cascade:catalog-snapshot:1 header. Refusing to pin it`);
  }
  const tables = records.filter((r) => r.kind === 'table').length;
  const columns = records.filter((r) => r.kind === 'column').length;
  const commented = records.filter((r) => r.kind === 'column' && r.comment != null).length;

  fs.renameSync(partial, paths.catalog);
  const sha256 = sha256File(paths.catalog);
  const provenance = {
    schema: 'cascade:catalog-provenance:1',
    dialect: header.dialect ?? target.dialect,
    serverVersion: header.serverVersion ?? null,
    // host:port/db. No user, no password — a provenance record is a fact about
    // the SCHEMA, not a way back into the database (§17.3).
    serverIdentity: header.serverIdentity ?? identity,
    fetchedAt: header.fetchedAt ?? null,
    sha256,
    file: path.basename(paths.catalog),
    candidate: candidatePath,
    worker: header.version ?? null,
    rowCounts: { tables, columns, commented },
  };
  fs.writeFileSync(paths.catalogSnapshot, JSON.stringify(provenance, null, 2) + '\n', 'utf8');

  // THE PROFILE, FINISHED. A snapshot nothing reads is not a schema, and asking
  // the reader to hand-edit a JSON key to make the fetch they just confirmed
  // count was a step that only ever produced an empty ERD and a puzzled reader.
  // The write is narrow: `catalog.source` and, when a candidate chose it,
  // `catalog.connectionFrom`. Every other key is left exactly as it was.
  const profileFile = path.join(resolved.dotCascade, 'profile.json');
  let profileNote;
  try {
    const existing = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const before = { ...(existing.catalog ?? {}) };
    existing.catalog = {
      ...before,
      source: 'jdbc',
      ...(candidatePath ? { connectionFrom: candidatePath } : {}),
    };
    validateProfile(normalizeProfile(existing));
    writeStateFile(profileFile, existing);
    profileNote = `wrote "catalog": { "source": "jdbc"${candidatePath ? `, "connectionFrom": "${candidatePath}"` : ''} } into ${profileFile}\n`
      + `  (it was "${before.source ?? 'none'}"). The next \`cascade analyze\` reads the snapshot above.\n`;
  } catch (e) {
    profileNote = `could NOT update ${profileFile} (${e.message}).\n`
      + '  The snapshot is pinned. To analyze against it, set there by hand:\n'
      + '  "catalog": { "source": "jdbc" }\n';
  }

  process.stderr.write(
    `wrote ${paths.catalog}: ${tables} table(s), ${columns} column(s), ${commented} with a comment\n`
    + `wrote ${paths.catalogSnapshot}: sha256 ${sha256.slice(0, 12)}…, fetched ${provenance.fetchedAt}\n`
    + 'both are inside the gitignored catalog/ directory, and no password was written to either.\n'
    + profileNote);
  if (asJson) process.stdout.write(JSON.stringify(provenance, null, 2) + '\n');
  process.exit(0);
}

if (cmd === 'estimate') {
  // The coverage estimate: what this tree WILL support, and — when a pack
  // already exists — what it measurably does. Both halves, always.
  //
  // WHICH TREE. The same rule `analyze` uses, and for the same reason. This
  // used to be `--root` or cwd, so `cascade estimate --project mall` read the
  // registered project's PACK for the measured half and the directory the shell
  // happened to be in for the "before analysis" half: one report about two
  // different projects, with nothing on it saying so.
  const resolved = resolveOrDie({ strictProject: false });
  const rootChoice = analyzeRoot(resolved, opt('root'), process.cwd());
  const root = rootChoice.root;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    die(`the tree to estimate, ${root} (${rootChoice.from}), is not a directory`);
  }
  // The profile describes the TREE, the resolver locates the PACK: an explicit
  // --pack must not cost the estimate its reading convention.
  const { profile, profileNote } = readProfile(resolved.dotCascade ?? path.join(root, '.cascade'));
  const asJson = flag('json');
  if (!asJson) process.stderr.write(profileNote + '\n');

  const discovery = discover(root, DISCOVER_IO);
  let graph = null;
  let packMetaForEstimate = null;
  const packFile = path.join(resolved.packDir, 'pack.json');
  if (fs.existsSync(packFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(packFile, 'utf8'));
      graph = loadPack(p, { verifyDigest: true });
      packMetaForEstimate = { digest: p.digest, builtAt: p.meta?.builtAt ?? null, lanes: p.meta?.lanes ?? null, axes: p.meta?.axes ?? null, laneStats: p.meta?.laneStats ?? null };
    } catch (e) {
      process.stderr.write(`pack at ${packFile} could not be read (${e.message}), so the measured half is left out rather than guessed\n`);
    }
  }

  const est = buildEstimate({
    discovery, profile, graph, pack: packMetaForEstimate,
    root, project: resolved.projectId ?? null,
  });
  if (asJson) {
    process.stdout.write(JSON.stringify(est, null, 2) + '\n');
    process.exit(0);
  }
  // The banner names the tree AND why it is that tree, so a reader can tell a
  // report about the registered project from a report about the shell's cwd.
  process.stdout.write(`estimate for ${root} (${rootChoice.from})${est.project ? `, project ${est.project}` : ''}\n\nBEFORE ANALYSIS. What a run over this tree would ship:\n`);
  for (const a of est.before.axes) {
    process.stdout.write(`  ${a.axis.padEnd(11)} ${a.status.padEnd(12)} ${a.reason}\n`);
  }
  // The web axis's numbers, spelled out rather than left inside its sentence:
  // "how much frontend is there" is the first thing anyone asks of a lane that
  // reads one, and it is the same number the lane line will print.
  const webAxis = est.before.axes.find((a) => a.axis === 'web');
  if (webAxis && (webAxis.counts.webFiles > 0 || webAxis.counts.frontendPackages > 0)) {
    process.stdout.write(`  web files: ${webAxis.counts.webFiles} frontend source file(s) (${webAxis.counts.vueFiles} .vue) `
      + `in ${webAxis.counts.webSourceRoots} source root(s), from ${webAxis.counts.frontendPackages} frontend package(s)\n`);
  }
  // The service name and the gateway routes: not an axis, but the two things
  // that decide whether an answer can cross into another project.
  const id = est.before.identity ?? { serviceNames: [], gatewayRoutes: 0, gatewayRouteFiles: [], declaredServiceNames: [], declaredGatewayRoutes: 0 };
  for (const s of id.serviceNames) {
    process.stdout.write(`  service name: ${s.name} (from ${s.file})`
      + `${id.declaredServiceNames.includes(s.name)
        ? ', declared in the profile'
        : ', and not in the profile yet: cascade init --force writes it'}\n`);
  }
  if (id.gatewayRoutes > 0) {
    process.stdout.write(`  gateway routes: ${id.gatewayRoutes} read from ${id.gatewayRouteFiles.join(', ')}`
      + `; the profile declares ${id.declaredGatewayRoutes}\n`);
  }
  if (est.before.notCovered.length === 0) process.stdout.write('  not covered: nothing found that this engine has no lane for\n');
  for (const n of est.before.notCovered) process.stdout.write(`  not covered: ${n.technology} (${n.files} file(s)): ${n.reason}\n`);

  process.stdout.write('\nMEASURED. What the pack that exists actually answers:\n');
  if (!est.measured) {
    process.stdout.write(`  ${est.measuredNote}\n`);
  } else {
    process.stdout.write(`  pack ${est.measured.pack.digest} built ${est.measured.pack.builtAt} lanes [${(est.measured.pack.lanes ?? []).join(',')}]\n`);
    const j = est.measured.jpa;
    if (j && (j.entities > 0 || j.repositories > 0)) {
      process.stdout.write(`  jpa: ${j.entities} entity table(s), ${j.repositories} repository(ies), ${j.statements} statement(s), `
        + `${j.unresolvedStatements} with an unresolved derived/JPQL part\n`);
    }
    for (const [name, r] of Object.entries(est.measured.ratios)) {
      const pct = r.pct == null ? 'n/a (nothing to measure)' : `${r.pct.toFixed(1)}%`;
      process.stdout.write(`  ${name.padEnd(28)} ${String(r.num).padStart(6)} / ${String(r.den).padEnd(6)} ${pct}${r.note ? `  (${r.note})` : ''}\n`);
    }
  }
  process.exit(0);
}

if (cmd === 'pack') {
  const catalog = opt('catalog'); const lineage = opt('lineage'); const out = opt('out', '.cascade/pack');
  if (!catalog || !lineage) die('usage: cascade pack --catalog <f> --lineage <f> --out <dir> [--project NAME]');
  const g = buildGraphFromSql(jsonl(catalog), jsonl(lineage));
  // The same identity rule `analyze` uses (SPEC §5.1). A pack built next to a
  // project's `.cascade/` belongs to that project whether or not --project was
  // typed; with no manifest to read, the flag is all there is, and with neither
  // the pack says it does not know rather than calling itself "project".
  const packResolved = resolveProject({ cwd: process.cwd(), env: process.env });
  const packProject = projectIdFrom(packResolved.projectId, manifestAt(packResolved.dotCascade)?.project, opt('project'));
  const pack = projectPack(g, { project: packProject, builtAt: new Date().toISOString() });
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'pack.json');
  fs.writeFileSync(file, JSON.stringify(pack));
  process.stderr.write(`wrote ${file}: ${pack.counts.nodes} nodes, ${pack.counts.edges} edges, digest ${pack.digest}\n`);
  process.exit(0);
}

if (cmd === 'verify') {
  // SPEC §14.4. Recompute every digest the receipt claims, from the bytes on
  // disk, and cross-check the receipt against the gate state it hashed. There is
  // no "mostly verified": a file the receipt names and the disk cannot produce
  // is a disagreement, and any disagreement at all is exit 4.
  const resolved = resolveOrDie();
  const stateDir = stateDirOf(resolved, resolved.packDir);
  const asJson = flag('json');
  const receiptFile = path.join(stateDir, 'receipt.json');
  let receipt = null;
  let receiptError = null;
  try { receipt = readJsonOrNull(receiptFile); }
  catch (e) { receiptError = e.message; }

  const files = {};
  const names = new Set([...RECEIPT_FILES, ...((receipt && receipt.files) || []).map((f) => f.name)]);
  for (const name of [...names].sort()) {
    const h = hashOrNull(path.resolve(stateDir, name));
    if (h !== null) files[name] = h;
  }
  let gateState;
  try { gateState = readJsonOrNull(path.join(stateDir, 'calibration', 'gate-state.json')); }
  catch (e) { gateState = { verdict: null, unreadable: e.message }; }

  let packContentDigest;
  const packFile = path.join(resolved.packDir, 'pack.json');
  if (fs.existsSync(packFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(packFile, 'utf8'));
      packContentDigest = digest12({ nodes: p.nodes, edges: p.edges });
    } catch (e) { packContentDigest = null; }
  }

  const now = new Date().toISOString();
  const result = receiptError
    ? { ok: false, checked: 1, expiresAt: null, disagreements: [{ check: 'receipt', expected: 'a readable cascade:receipt:1 document', found: receiptFile, reason: `the receipt could not be read: ${receiptError}` }] }
    : verifyReceipt({ receipt, actual: { files, enginePrint: runningEnginePrint(), gateState, packContentDigest, now } });

  const report = {
    schema: 'cascade:verify-report:1',
    verified: result.ok,
    project: resolved.projectId ?? null,
    stateDir,
    receipt: receiptFile,
    checkedAt: now,
    expiresAt: result.expiresAt,
    checks: result.checked,
    enginePrint: runningEnginePrint(),
    gate: gateState ? { mode: gateState.mode ?? null, verdict: gateState.verdict ?? null } : null,
    disagreements: result.disagreements,
  };
  if (!result.ok) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`NOT VERIFIED: ${result.disagreements.length} disagreement(s): ${result.disagreements.map((d) => d.check).join(', ')}\n`);
    process.exit(4);
  }
  if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(`verified ${stateDir}: ${result.checked} check(s) agreed: pack, fact index and gate state match the receipt, `
      + `the running engine is the one that signed it, and it is valid until ${result.expiresAt}\n`);
    process.stdout.write(`gate ${report.gate?.mode ?? 'unknown'} -> ${report.gate?.verdict ?? 'unknown'}\n`);
  }
  process.exit(0);
}

if (cmd === 'golden') {
  // SPEC §14.1 — the PROJECT golden. The tool proposes; a human approves. This
  // command never crosses that line: `propose` writes candidates and nothing
  // else, and only `approve` (with --ids or an explicit --all) stamps approval.
  const sub = argv[1];
  const SUBS = ['propose', 'approve', 'seal', 'check'];
  if (!SUBS.includes(sub)) {
    die(`usage: cascade golden <${SUBS.join('|')}> [--pack <dir> | --project <id> | --root <dir>]\n`
      + '  propose [--per-relation N]   sample candidates from the CURRENT pack into golden/proposed.jsonl.\n'
      + '                               They are PROPOSALS: built from the engine\'s own answers, so they are\n'
      + '                               right by construction and prove nothing until a human has read them.\n'
      + '                               This tool never approves its own proposals.\n'
      + '  approve --ids <id>... | --all   move proposals into golden/cases.jsonl with approvedAt.\n'
      + '  seal                         hide the labels of the held-out share (~20%, chosen by id hash, not by you).\n'
      + '  check [--json]               score the approved cases through the shipped MCP tools.');
  }
  const resolved = resolveOrDie();
  const stateDir = stateDirOf(resolved, resolved.packDir);
  const goldenDir = path.join(stateDir, 'golden');
  const proposedFile = path.join(goldenDir, 'proposed.jsonl');
  const casesFile = path.join(goldenDir, 'cases.jsonl');
  const readCases = (file) => (fs.existsSync(file) ? parseCases(fs.readFileSync(file, 'utf8')) : []);

  if (sub === 'propose' || sub === 'check') {
    const packFile = path.join(resolved.packDir, 'pack.json');
    if (!fs.existsSync(packFile)) die(`no pack at ${packFile}. Run \`cascade analyze\` first`);
    const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
    const graph = loadPack(pack, { verifyDigest: true });
    const prof = servedProfile(resolved.packDir, pack);
    const ask = goldenAsk(graph, pack, prof);

    if (sub === 'propose') {
      const perRelation = Number(opt('per-relation', String(MIN_CASES)));
      if (!Number.isInteger(perRelation) || perRelation < 1) die('--per-relation must be a positive whole number');
      const { cases, perRelation: stats, notes } = proposeCases({ inventory: inventoryOf(graph), ask, packDigest: pack.digest, perRelation });
      fs.mkdirSync(goldenDir, { recursive: true });
      fs.writeFileSync(proposedFile, serializeCases(cases));
      for (const rel of RELATIONS) {
        const st = stats[rel];
        process.stdout.write(`${rel.padEnd(20)} proposed ${String(st.proposed).padStart(4)} of ${perRelation} `
          + `(${st.candidates} candidate(s) in the pack, ${st.skippedEmpty} answered nothing, ${st.skippedTruncated} truncated)\n`);
      }
      for (const n of notes) process.stdout.write(`note: ${n}\n`);
      process.stdout.write(`wrote ${cases.length} PROPOSAL(s) to ${proposedFile}\n`);
      process.stdout.write('these are candidates, not evidence: they were built from this engine\'s own answers, so they pass by construction.\n'
        + `read them, then approve the ones you agree with: \`cascade golden approve --ids <id> ...\` (or --all, explicitly).\n`);
      process.exit(0);
    }

    const cases = readCases(casesFile);
    if (cases.length === 0) die(`no approved cases at ${casesFile}. Run \`cascade golden propose\` and then \`cascade golden approve\``);
    const { results, summary } = checkCases(cases, { ask });
    if (flag('json')) {
      process.stdout.write(JSON.stringify({ schema: 'cascade:golden-check:1', summary, results }, null, 2) + '\n');
    } else {
      for (const rel of RELATIONS) {
        const r = summary.relations[rel];
        const fmt = (b) => (b.target == null
          ? 'no target is declared for this relation'
          : `${b.lowerBound == null ? 'n/a' : b.lowerBound.toFixed(4)} vs ${b.target}`
            + (b.meets ? '' : ` (a flawless corpus needs n>=${b.nForTarget} to reach it)`));
        process.stdout.write(`${rel.padEnd(20)} ${String(r.status).padEnd(20)} n=${String(r.n).padStart(4)}\n`
          + `  recall    ${r.recallHits}/${r.n} wilson ${fmt(r.recall)}\n`
          + `  precision ${r.precisionHits}/${r.n} wilson ${fmt(r.precision)}\n`);
      }
      const failed = results.filter((r) => r.status === 'FAIL');
      for (const f of failed.slice(0, 10)) process.stdout.write(`  FAIL ${f.id} ${f.relation}: ${f.reason}\n`);
      if (failed.length > 10) process.stdout.write(`  … ${failed.length - 10} more failing case(s)\n`);
      process.stdout.write(`golden ${summary.status}: ${summary.scored} scored, ${summary.unscorable} unscorable, `
        + `${MIN_CASES} cases per relation are the minimum before a relation can PASS\n`);
    }
    process.exit(summary.status === 'FAIL' ? 5 : 0);
  }

  if (sub === 'approve') {
    const proposed = readCases(proposedFile);
    if (proposed.length === 0) die(`nothing to approve: ${proposedFile} is empty or absent. Run \`cascade golden propose\` first`);
    const ids = optAll('ids').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    const all = flag('all');
    if (!all && ids.length === 0) die('cascade golden approve needs --ids <id>[,<id>…] or an explicit --all. This tool never approves its own proposals, because a corpus a tool scored itself against measures nothing');
    let moved;
    try { moved = approveCases(proposed, { ids, all, approvedAt: new Date().toISOString() }); }
    catch (e) { die(e.message); }
    if (moved.unknownIds.length > 0) die(`these ids are not in ${proposedFile}: ${moved.unknownIds.join(', ')}`);
    const existing = readCases(casesFile);
    const byId = new Map(existing.map((c) => [c.id, c]));
    for (const c of moved.approved) byId.set(c.id, c);
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(casesFile, serializeCases([...byId.values()]));
    fs.writeFileSync(proposedFile, serializeCases(moved.remaining));
    process.stdout.write(`approved ${moved.approved.length} case(s) into ${casesFile} (${byId.size} total), `
      + `${moved.remaining.length} proposal(s) left in ${proposedFile}\n`);
    process.exit(0);
  }

  // seal
  const cases = readCases(casesFile);
  if (cases.length === 0) die(`no approved cases at ${casesFile}`);
  const { cases: sealed, sealed: count } = sealCases(cases);
  fs.writeFileSync(casesFile, serializeCases(sealed));
  process.stdout.write(`sealed ${count} of ${cases.length} case(s) in ${casesFile}. The held-out share is decided by sha256(id), never by hand. `
    + 'Their labels are now a hash, so the checker classifies the probe ids without seeing which side they are on\n');
  process.exit(0);
}

// `cascade otel-methods` — the one line the OpenTelemetry Java agent needs
// before the dispatch join can see anything.
//
// The agent instruments HTTP, Spring Data and JDBC on its own, so a first run
// observes routes and statements and reports dispatch 0: no controller and no
// service method has a span, so no method span ever nests inside another. The
// fix is `-Dotel.instrumentation.methods.include=`, and the agent takes EXPLICIT
// method names there. `pkg.Class[*]` matches nothing.
//
// Writing that list by hand means reading the project. The pack has already read
// it, so this prints it: the value on stdout and nothing else, so it can be
// pasted or piped, with the count on stderr where it does not get in the way.
if (cmd === 'otel-methods') {
  const resolved = resolveOrDie();
  const file = path.join(resolved.packDir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run cascade analyze first`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = loadPack(pack, { verifyDigest: true });
  const inc = otelMethodsInclude(g);
  if (flag('json')) {
    process.stdout.write(JSON.stringify(inc.classes, null, 2) + '\n');
  } else if (inc.value !== '') {
    process.stdout.write(inc.value + '\n');
  }
  if (inc.methodCount === 0) {
    process.stderr.write(`${resolved.projectId ?? resolved.packDir}: nothing to instrument. This pack holds no route handler `
      + 'and no method that reaches a statement, so there is no caller for a trace to see\n');
    process.exit(0);
  }
  process.stderr.write(`${inc.methodCount} method(s) in ${inc.classCount} class(es): `
    + `${inc.handlers} route handler(s) and ${inc.statementReachers} method(s) that reach a statement. `
    + 'Pass it to the agent as -Dotel.instrumentation.methods.include=<this line>, quoted, and run once with traffic. '
    + 'See docs/setup/runtime-evidence.md\n');
  process.exit(0);
}

if (cmd === 'mcp') {
  // The MCP server (SPEC §13). It serves ONE OR MANY projects: `--pack`/`--root`
  // pick a single pack, `--project a --project b` picks registry entries, and
  // with no flag at all every registered project is served. Packs are LAZY —
  // nothing is parsed until a tool asks a project a question — and the loaded
  // ones live in an LRU under `--memory-budget` MB (§17.6).
  const host = createProjectHost({
    registry: servedEntries('mcp'),
    loadProject: loadServedProject,
    budgetBytes: memoryBudgetBytes(),
  });
  const served = host.list();
  process.stderr.write(`cascade mcp: serving ${served.length} project(s) [${served.map((p) => p.id).join(', ')}]: `
    + `packs load on first use, budget ${(host.budgetBytes / (1024 * 1024)).toFixed(0)} MB of pack JSON\n`);
  if (served.length > 1) process.stderr.write('more than one project: every tool call must name one (`project`), or it is answered with `ambiguous`. Call `projects` to list them\n');
  serve({ deps: { toolList, callTool: (name, args) => host.callTool(name, args) } })
    .then(() => process.exit(0));
} else if (cmd === 'view') {
  // The web viewer over the SAME tool catalog and the SAME project host (no
  // reimplemented queries, and no second idea of which projects exist). The
  // page itself shows ONE project: it passes `?project=<id>` through to the
  // API, and without it a multi-project server answers `ambiguous` rather than
  // picking one.
  const host = createProjectHost({
    registry: servedEntries('view'),
    loadProject: loadServedProject,
    budgetBytes: memoryBudgetBytes(),
  });
  const served = host.list();
  const contextOf = (project) => {
    const { projectId } = host.resolveProjectArg(project ? { project } : {});
    return { projectId, ctx: host.ctxFor(projectId) };
  };
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  // The mark, read once and answered by name at /cascade-mark.svg (and its
  // dark-ground variant at /cascade-mark-dark.svg). The page inlines the light
  // geometry, so these routes exist for everything OUTSIDE the page that wants
  // the file itself.
  const mark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark.svg'), 'utf8');
  const markDark = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'cascade-mark-dark.svg'), 'utf8');
  const deps = {
    toolList,
    callTool: (name, args) => host.callTool(name, args),
    meta: (project) => {
      const { projectId, ctx } = contextOf(project);
      const pack = ctx.packJson;
      const repoRoot = pack.meta?.base?.repoPath ?? null;
      return {
        project: ctx.basis.project, projectId, digest: pack.digest, lanes: pack.meta?.lanes ?? null,
        builtAt: ctx.basis.builtAt, freshness: ctx.basis.freshness, base: pack.meta?.base ?? null,
        canSource: !!repoRoot, projects: served.map((p) => p.id),
      };
    },
    // The two vendored MIT browser bundles the Graph tab's map renderers load
    // (viewer/vendor — see NOTICE). Served from THIS directory only; nothing
    // else on disk is reachable through /vendor.
    vendorDir: path.join(ENGINE_ROOT, 'viewer', 'vendor'),
    // The translation catalogues (SPEC §17.11). English is compiled into the
    // page; every other language is a JSON file fetched on demand from here,
    // which is why no non-English text lives in the page or in src/.
    i18nDir: path.join(ENGINE_ROOT, 'viewer', 'i18n'),
    // Live source preview, read from the working tree on demand (real-time).
    // A pack that records no repository path has no preview to give, and says
    // so as a structured 404 rather than a blank panel.
    source: (nodeId, project, opts) => {
      const { projectId, ctx } = contextOf(project);
      const repoRoot = ctx.packJson.meta?.base?.repoPath ?? null;
      if (!repoRoot) {
        const e = new Error(`source preview not available for ${projectId} (its pack records no repository path)`);
        e.code = 'unknown-key';
        throw e;
      }
      return readSourceFor(ctx.graph, repoRoot, nodeId, {
        readFile: (f) => fs.readFileSync(f, 'utf8'),
        ddlPath: ctx.packJson.meta?.ddl,
        whole: !!(opts && opts.whole),
      });
    },
  };
  const port = Number(opt('port', '4319'));
  serveHttp({ http, port, deps, html, mark, markDark }).then(({ port: p }) => {
    process.stderr.write(`cascade viewer at http://127.0.0.1:${p}/  serving ${served.length} project(s) [${served.map((x) => x.id).join(', ')}], `
      + `budget ${(host.budgetBytes / (1024 * 1024)).toFixed(0)} MB of pack JSON\n`);
    if (served.length > 1) {
      process.stderr.write(`the page shows ONE project: open http://127.0.0.1:${p}/?project=${served[0].id} (or another id above). `
        + 'Without it the API answers `ambiguous`\n');
    }
  });
} else if (cmd === 'impact') {
  // Local convenience: the working-tree overlay from the shell. By default the
  // dirty files are RE-PARSED (SPEC §10.2) so the answer describes the bytes on
  // disk; `--mode base-only` asks the old question — what those files touched
  // as the pack last saw them — and is labelled as such in the output.
  const resolvedFor = resolveOrDie();
  const dir = resolvedFor.packDir;
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run cascade analyze first`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const filesArg = optAll('file');
  const impactProfile = servedProfile(dir, pack);
  const modeArg = opt('mode', 'conservative');
  const baseOnly = modeArg === 'base-only';
  const verbose = flag('verbose');

  let overlayProvider = null;
  let ov = null;
  if (!baseOnly) {
    overlayProvider = makeOverlayProvider({ packDir: dir, pack, baseGraph: graph, profile: impactProfile });
    try {
      ov = overlayProvider();
    } catch (e) {
      if (e instanceof OverlayStaleError) {
        die(`overlay unavailable [${e.code}]: ${e.message}\n`
          + '  (`cascade impact --mode base-only` still answers from the pack: the PRE-EDIT structure, clearly labelled)');
      }
      throw e;
    }
  }
  const files = filesArg.length ? filesArg : (ov ? ov.dirtyFiles : gitChangedFiles(pack.meta?.base, ownStateOf(pack.meta?.base, dir)));
  if (!files.length) die('no changed files. Pass --file <path> [--file …], or edit the repo the pack was built from');
  const ctx = {
    graph,
    basis: {
      project: pack.meta?.project ?? 'project', buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null, freshness: { verdict: 'unknown' },
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    trust: computeTrust({ ...calibrationStateOf(resolvedFor.dotCascade), knownGaps: trustGapsFor(impactProfile, pack.meta?.axes ?? null) }),
    limits: [], pack: packMeta(pack), profile: impactProfile,
    ...(overlayProvider ? { overlay: overlayProvider } : {}),
  };
  const resp = callTool('changed_impact', { files, mode: baseOnly ? 'conservative' : modeArg }, ctx);
  const a = resp.answer;
  const o = a.overlay ?? null;
  if (baseOnly) {
    process.stdout.write('mode base-only: this is the BASE pack\'s answer: what these files touched as they were LAST ANALYZED, not as they are on disk\n');
  } else if (o && o.applied) {
    const t = o.timingsMs ?? {};
    process.stdout.write(`overlay ${shortSessionId(o.overlaySessionId)} (fresh): re-parsed ${o.parsedFiles.length} java + ${(o.parsedWebFiles ?? []).length} frontend file(s), `
      + `dropped ${o.droppedFiles.length + (o.droppedWebFiles ?? []).length}, `
      + `provisional ${o.provisionalIds.symbols.length + o.provisionalIds.endpoints.length + o.provisionalIds.statements.length} node(s) / ${o.provisionalEdges} edge(s)\n`);
    process.stdout.write(`timings ms: load-base ${t.loadBase} + java ${t.java} + web ${t.web} + sql ${t.sql} + graph ${t.build} = ${t.total}\n`);
    if (verbose) {
      process.stdout.write(`  reused ${ov.reusedShards} cached java shard(s); dirty documents: ${Object.entries(o.docVersions).map(([f, h]) => `${f}@${h ? h.slice(0, 8) : 'absent'}`).join(', ')}\n`);
      process.stdout.write(`  parsed: ${o.parsedFiles.join(', ') || '(none)'}\n`);
      if (o.unmatchedLanes.length) process.stdout.write(`  no lane claims: ${o.unmatchedLanes.join(', ')}\n`);
    }
  } else if (o) {
    process.stdout.write(`overlay NOT applied (${o.state}): ${o.reason}\n`);
  }
  process.stdout.write(`changed files: ${a.changedFiles}  (matched ${a.files.matched.length}, unmatched ${a.files.unmatched.length})\n`);
  process.stdout.write(`touched: ${a.touched.symbols.length} symbols, ${a.touched.statements.length} statements, ${a.touched.endpoints.length} endpoints\n`);
  process.stdout.write(`\nupstream endpoints affected (${resp.truncated.fields[0].total}):\n`);
  for (const e of a.upstreamEndpoints) process.stdout.write(`  ${e.id}  [${e.grade}]${e.provisional ? '  PROVISIONAL (only in the overlay)' : ''}\n`);
  process.stdout.write(`\ndownstream columns affected (${resp.truncated.fields[1].total}):\n`);
  for (const c of a.downstreamColumns) process.stdout.write(`  ${c.id}  [${c.grade}]${c.provisional ? '  PROVISIONAL (only in the overlay)' : ''}\n`);
  if (a.files.unmatched.length) process.stdout.write(`\nchanged but not in graph (impact unknown, not zero):\n${a.files.unmatched.map((f) => '  ' + f).join('\n')}\n`);
  for (const l of resp.limits) process.stdout.write(`\nlimit [${l.scope}]: ${l.reason}\n`);
  process.stdout.write(`\n(${resp.basis.freshness.verdict}) ${a.note}\n`);
  process.exit(0);
} else if (cmd !== 'pack' && cmd !== 'analyze' && cmd !== 'estimate') {
  die('usage: cascade <setup|doctor|init|agent|analyze|otel-methods|estimate|verify|golden|catalog|pack|mcp|impact|view> …\n'
    + '  cascade setup [--force] [--home]\n'
    + '      (build the SQL lane\'s python and install its pinned requirements. --force rebuilds an\n'
    + '       existing one; --home puts it in the tool home even inside a checkout. Nothing else needs it)\n'
    + '  cascade doctor [--json]\n'
    + '      (pre-flight every prerequisite at once: node, git, the SQL lane\'s venv and sqlglot,\n'
    + '       a JDK (naming which candidate won and why the others did not), the optional DB\n'
    + '       drivers, docker, the registry and the cache directory. Exit 0 only when every\n'
    + '       REQUIRED prerequisite is ok; the optional ones are reported, never fatal.)\n'
    + '  cascade init [--root <dir>] [--project <id>] [--force] [--json]\n'
    + '  cascade agent [--client claude-code|cursor|codex|all] [--write] [--project <id>] [--root <dir>]\n'
    + '      (put the MCP server config AND the rule that says when to ask into the project:\n'
    + '       .mcp.json + CLAUDE.md for Claude Code, .cursor/mcp.json + .cursor/rules/cascade.mdc\n'
    + '       for Cursor, AGENTS.md plus a TOML block to paste for Codex. Without --write it prints\n'
    + '       every file it would write instead of writing one. Claude Code holds a project\n'
    + '       .mcp.json at "Pending approval" until you run `claude` there once and approve it.)\n'
    + '  cascade analyze [--root <repo>] [--out <dir>] [--profile <f>] [--cold | --incremental] [--accept-baseline]\n'
    + '                  [--ddl <schema.sql|glob>... | --no-ddl] [--mappers <dir>... | --no-mappers] [--java-src <dir>... | --no-java]\n'
    + '                  [--web-src <dir>... | --no-web] [--openapi <file>... | --no-openapi]\n'
    + '                  [--har <file>...] [--otel <file>...]\n'
    + '      (with no lane flag the inputs come from the project manifest + profile + discovery;\n'
    + '       --no-<lane> switches a lane off even then. An unflagged run reads MAIN java sources\n'
    + '       only. The src/test roots it skipped are printed, and --java-src includes one.)\n'
    + '      (--web-src reads a frontend source root: the web lane traces each HTTP call to the client\n'
    + '       that sends it and attaches it to the route this pack serves, as a graded CALLS_HTTP edge.\n'
    + '       The `web` axis says what had to be guessed. See docs/setup/web-lane.md)\n'
    + '      (--openapi reads an OpenAPI 3 / Swagger 2 document, JSON or YAML: every route it declares\n'
    + '       becomes an endpoint, one the code also serves is corroborated, and the routes the two\n'
    + '       disagree about are reported as drift. Repeatable. See docs/setup/web-lane.md)\n'
    + '      (--har reads a browser recording (HAR 1.2, what DevTools saves): every request in it that\n'
    + '       matches a route this pack serves becomes a screen-to-route edge graded RUNTIME_ONLY, which\n'
    + '       is SHOWN as `observed` and never walked. Repeatable; the profile can name them instead in\n'
    + '       runtimeEvidence.har. Nothing is discovered: a recording is made on purpose.)\n'
    + '      (--otel reads an OpenTelemetry trace export (OTLP/JSON): which implementation really handled\n'
    + '       a request and which statement really ran. A confirmed hop keeps its grade and gains\n'
    + '       `observed`, an unobserved candidate is left exactly as it was, and a hop no static rule\n'
    + '       explains becomes a RUNTIME_ONLY edge that is shown and never walked. Repeatable; the\n'
    + '       profile can name them instead in runtimeEvidence.otel. See docs/setup/runtime-evidence.md)\n'
    + '      (every run is judged against the previous certified run sealed in .cascade/calibration/:\n'
    + '       a regression writes the pack to <packDir>-rejected/ and exits 3, leaving the certified\n'
    + '       pack untouched. --accept-baseline re-seals the baseline FROM THIS RUN: the one override,\n'
    + '       and a human decision.)\n'
    + '  cascade otel-methods [--pack <dir> | --project <id> | --root <dir>] [--json]\n'
    + '      (print the `otel.instrumentation.methods.include` value this pack needs: every route\n'
    + '       handler and every method that reaches a statement, grouped by class as pkg.Class[m1,m2]\n'
    + '       and joined with semicolons. The Java agent takes explicit method names, never a\n'
    + '       wildcard, and without them the dispatch join sees nothing because no controller or\n'
    + '       service method has a span. The value goes to stdout alone, so it can be pasted or\n'
    + '       piped. --json prints the same as {class: [methods]}. See docs/setup/runtime-evidence.md)\n'
    + '  cascade estimate [--root <dir>] [--project <id>] [--json]\n'
    + '  cascade verify [--pack <dir> | --project <id> | --root <dir>] [--json]\n'
    + '      (recompute every digest in .cascade/receipt.json from the files, check the running engine\n'
    + '       against the one that signed it, and refuse an expired receipt. Exit 4 on any disagreement)\n'
    + '  cascade golden <propose|approve|seal|check> [--pack <dir> | --project <id> | --root <dir>]\n'
    + '      (the project golden corpus. propose SUGGESTS cases from the current pack; only\n'
    + '       `approve --ids …` / an explicit `--all` makes one evidence. The tool never approves itself.)\n'
    + '  cascade catalog discover [--root <dir>] [--json]\n'
    + '      (list the datasource connection info this tree carries: host, port, database, dialect,\n'
    + '       and WHETHER a password is there. No password value is read, printed or stored, and\n'
    + '       nothing is connected to.)\n'
    + '  cascade catalog fetch [--project <id>|--root <dir>]\n'
    + '                        [--candidate <n> | --url <jdbc url> --user <u>\n'
    + '                         | --dialect <d> --host <h> [--port <p>] --database <db> --user <u>]\n'
    + '                        [--password-env NAME] [--schema NAME] [--stamp-schema NAME] [--yes]\n'
    + '      (pin a READ-ONLY catalog snapshot into .cascade/catalog/, then write catalog.source: "jdbc"\n'
    + '       into the profile so the next analyze reads it. It prints the exact target first and asks\n'
    + '       y/N in a terminal, or refuses without --yes outside one: the connection info comes from\n'
    + '       the analyzed repository, which is untrusted input. The password is read, in order, from\n'
    + '       --password-env, from CASCADE_DB_PASSWORD, from the credentials file, or from a hidden\n'
    + '       prompt. It is never an argument and never written to the project.)\n'
    + '  cascade catalog credentials list\n'
    + '  cascade catalog credentials set    --url <jdbc url> --user <u> [--password-env NAME]\n'
    + '  cascade catalog credentials remove --url <jdbc url> --user <u>\n'
    + '      (the passwords `catalog fetch` may use, in $CASCADE_HOME/credentials at mode 0600: one\n'
    + '       JSON object per line, keyed by server and user, never under a project tree. A file that\n'
    + '       group or others can read is REFUSED with the chmod to run. `list` prints servers and\n'
    + '       users and never a password. --dialect/--host/--port/--database name the same target\n'
    + '       field by field.)\n'
    + '  cascade pack --catalog <f> --lineage <f> --out <dir>\n'
    + '  cascade mcp [--pack <dir> | --project <id> ... | --root <dir>] [--memory-budget <MB>]\n'
    + '      (with no --pack/--root/--project it serves EVERY registered project, lazily: a pack is\n'
    + '       parsed on the first call that needs it, and the loaded ones are held in an LRU under\n'
    + '       the memory budget: 512 MB of pack JSON by default. Each tool takes a `project`\n'
    + '       argument; on a multi-project server a call without one is answered `ambiguous`.)\n'
    + '  cascade impact [--pack <dir> | --project <id> | --root <dir>] [--file <path>...] [--verbose]\n'
    + '                 [--mode strict|conservative|heuristic|base-only]\n'
    + '      (default: the dirty files are re-parsed and the answer describes the working tree;\n'
    + '       --mode base-only answers from the pack alone: the PRE-EDIT structure, labelled as such)\n'
    + '  cascade view [--pack <dir> | --project <id> ... | --root <dir>] [--port 4319] [--memory-budget <MB>]\n'
    + '      (same project selection as `mcp`; the page shows one project at a time. Open it with\n'
    + '       ?project=<id> when the server serves several)\n'
    + '\n'
    + 'A pack is located by: --pack > --project (~/.cascade/registry.json) > --root/.cascade > ./.cascade');
}
