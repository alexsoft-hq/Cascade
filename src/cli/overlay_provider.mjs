// overlay_provider.mjs — the LIVE working-tree overlay (SPEC §10, RM4/M7).
//
// `gitChangedFiles` answers "which files did you touch" and the base pack
// answers what they touched BEFORE the edit. This builds the other half: the
// dirty files are re-parsed and a new in-memory graph is assembled from the
// cached shards of everything else, so `changed_impact` describes the bytes on
// disk. Nothing is written — not the pack, not the fact cache (§10.1 MUST NOT).
//
// This module is the IMPURE edge only: git, the filesystem and the two worker
// invocations. Every decision — the session id, the stale rule, which lane
// claims a file, what counts as provisional — is in src/core/overlay*.mjs.
//
// It reads in five steps, and they are five functions rather than one closure
// because each answers a different question and only the last of them builds
// anything:
//
//   readIndex      is there a fact cache, and is it this engine's?
//   dirtyEntries   what differs from the base commit, right now?
//   refuse         is there a reason not to lay an overlay at all?
//   runLanes       re-parse exactly the dirty files, reuse the rest
//   overlayState   fold the two into one graph and describe what happened

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildChangeset, changedFiles } from '../core/changeset.mjs';
import { createFactsStore, nodeFactsIo, validateIndex } from '../core/facts_store.mjs';
import { INCREMENTAL_ENGINE_VERSION } from '../core/incremental.mjs';
import { underAny } from '../core/invalidate.mjs';
import { screenAxisOf, sqlLaneArgs } from '../core/lanes.mjs';
import { overlayGraph, classifyDirtyFiles } from '../core/overlay.mjs';
import { runOverlayLanes, ephemeralIo, OverlayStaleError } from '../core/overlay_lanes.mjs';
import { overlaySession } from '../core/overlay_session.mjs';
import { ownStateDirRel, isOwnStatePath } from '../core/paths.mjs';
import { normalizeProfile } from '../core/profile.mjs';
import { workerVersions } from '../core/worker_versions.mjs';
import {
  ENGINE_ROOT, findJdk, gitText, listMapperXml, parseJsonl, realPath, splitZ, sqlPython, noSqlPython,
} from './env.mjs';
import { LANE_BRIDGES, runJavaLane, runWebLane, webPackagesRead } from './lanes_run.mjs';
import { safeHash, sha256File } from './state.mjs';

/**
 * The fact index beside the pack, or a refusal saying why it cannot be used:
 * there is none, it does not parse, or it was written by a different generation
 * of this engine or of one of its workers. An overlay laid over shards from
 * another generation would be a graph nobody built.
 */
export function readIndex(indexFile, stale) {
  if (!fs.existsSync(indexFile)) stale(`no fact index at ${indexFile}: this pack was built before the incremental core, so its shards are not on disk`);
  let index;
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
}

/**
 * A FRONTEND OUTSIDE THE ANALYZED ROOT is scanned WHERE IT IS, and it has to
 * be: `--web-src ../front/src` is the common case, and the diff of the backend's
 * root cannot reach it.
 *
 *  - a file git has never seen is only listed for the directory the command
 *    RUNS IN, so `ls-files --others` at the analyzed root cannot see a new
 *    `.vue` beside it. That is true whether the frontend is a repository of its
 *    own or another directory of this one, so this scan runs for both, from the
 *    web root;
 *  - a TRACKED change in a SEPARATE repository needs its own diff as well: a
 *    diff of the backend's root reports nothing about another repository, and
 *    there is no commit the two share, so that root is diffed against ITS OWN
 *    HEAD. In the same repository the diff above already covered it.
 *
 * Without this an edited or new file over there would be invisible and the
 * overlay would answer from the base shards while calling itself fresh, and the
 * session id would not move when the frontend did.
 */
function addOutOfRootWebChanges(byPath, { rootAbs, gitTop, webRootsRel }) {
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
}

/**
 * WHAT DIFFERS FROM THE BASE COMMIT, RIGHT NOW, as `{path, status}` sorted by
 * path — plus the HEAD this tree is on. `{declineReason}` instead when the diff
 * itself could not be read, which is a different answer from "nothing changed".
 */
export function dirtyEntries({ idx, pack, packDir, rootAbs, stale }) {
  const gitTopRaw = ((gitText(rootAbs, ['rev-parse', '--show-toplevel']) ?? '').trim()) || null;
  if (!gitTopRaw) stale(`${rootAbs} is not inside a git repository, so the working-tree diff cannot be read`);
  const gitTop = realPath(gitTopRaw);
  const headCommit = ((gitText(rootAbs, ['rev-parse', 'HEAD']) ?? '').trim()) || null;
  const baseCommit = pack.meta?.base?.commit ?? idx.base?.commit ?? null;
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
    return { headCommit, baseCommit, declineReason: `the working-tree diff against ${baseCommit.slice(0, 12)} could not be read (${cs.reason}). That commit may no longer be in this repository` };
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
  addOutOfRootWebChanges(byPath, { rootAbs, gitTop, webRootsRel });
  return {
    headCommit,
    baseCommit,
    entries: [...byPath.entries()].map(([p, status]) => ({ path: p, status })).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

/**
 * THE REASONS AN OVERLAY DOES NOT HAPPEN, in order, as a state to hand back —
 * or null when it may go ahead. Every one of them is a sentence a reader can
 * act on, because the alternative is an answer computed over a base that no
 * longer describes the question.
 */
export function refuse({ session, dirtyFiles, entries, idx, profile, baseCommit, headCommit }) {
  if (session.state !== 'fresh') {
    return {
      applied: false, state: session.state, session, dirtyFiles,
      reason: `the pack was built at ${baseCommit.slice(0, 12)} but HEAD is now ${(headCommit ?? 'unknown').slice(0, 12)}, so the overlay is discarded rather than laid onto a base that has moved`,
      limits: [{ scope: 'overlay', reason: `HEAD moved past the pack's base commit; the answer below is the BASE pack's, not the working tree's. Run \`cascade analyze\` (it is incremental) to certify the new commit` }],
    };
  }
  const selection = idx.selection ?? {};
  // A pack built before this project had a frontend cannot answer a frontend
  // question: there are no web shards to lay an edit onto, and an overlay that
  // quietly skipped the lane would report "no impact" for an edited `.vue`.
  if ((selection.webRoots ?? []).length === 0 && (profile?.frameworkPacks ?? []).includes('web')) {
    return { declined: 'this pack was built without a web lane, but the profile now declares the web framework pack, so a frontend edit has no facts to lay over' };
  }
  const dirty = classifyDirtyFiles(entries, selection);
  if (dirty.ddl.length > 0) {
    return {
      applied: false, state: 'declined', session, dirtyFiles,
      reason: `schema file changed (${dirty.ddl.join(', ')}), and catalog changes need a certified re-analysis`,
      limits: [{ scope: 'overlay', reason: `the DDL is dirty (${dirty.ddl.join(', ')}); a moved column changes what EVERY statement resolves to, so the overlay declines instead of answering over a stale catalog. Run \`cascade analyze\`` }],
    };
  }
  // The reading convention is folded into every SQL shard key. If it moved,
  // every statement would be recomputed inside a latency gate meant for one
  // file — decline out loud instead of taking minutes.
  const sqlArgs = sqlLaneArgs(profile ?? normalizeProfile({}));
  const nowArgs = [...sqlArgs.mybatisArgs, ...sqlArgs.lineageArgs];
  if (JSON.stringify(nowArgs) !== JSON.stringify(selection.sqlArgs ?? [])) {
    return {
      applied: false, state: 'declined', session, dirtyFiles,
      reason: `the SQL reading convention changed since this pack was built (${JSON.stringify(selection.sqlArgs ?? [])} -> ${JSON.stringify(nowArgs)})`,
      limits: [{ scope: 'overlay', reason: 'the profile\'s SQL arguments no longer match the ones the pack was built with, so no cached statement applies. Run `cascade analyze`' }],
    };
  }
  return { ok: true, dirty, sqlArgs };
}

/**
 * The four lane invocations an overlay may make, bound to this run's roots and
 * reading convention. `jdk` is looked up at most once, and only if a `.java`
 * really changed: an overlay over an edited `.vue` must not need a compiler.
 */
function laneRunners({ rootAbs, selection, sqlArgs, absOf, templateRootsAbs, stale, jdkBox }) {
  const mapperDirsAbs = (selection.mapperDirs ?? []).map(absOf);
  const ddlRels = selection.ddls ?? (selection.ddl ? [selection.ddl] : []);
  const ddlAbsList = ddlRels.map(absOf);
  const pyRes = sqlPython();
  const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
  const runpy = (script, args) => execFileSync(pyRes.path, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
  const needPy = (what) => { if (!pyRes.ok) stale(noSqlPython(`the overlay must rerun ${what} and`, pyRes)); };
  const sourceRoots = (selection.webRoots ?? []).map(absOf);
  const run = {
    java: (targets) => {
      if (!jdkBox.jdk) {
        jdkBox.jdk = findJdk();
        if (!jdkBox.jdk) stale('the overlay must re-parse Java but no JDK was found (set JAVA_HOME, or see docs/setup/java-lane.md)');
      }
      return runJavaLane(jdkBox.jdk, rootAbs, targets);
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
    web: (targets) => runWebLane(rootAbs, targets, { sourceRoots, templateRoots: templateRootsAbs }),
    webConfigs: (roots) => runWebLane(rootAbs, roots, { configsOnly: true, sourceRoots, templateRoots: templateRootsAbs }),
  };
  return { run, mapperDirsAbs, ddlRels, ddlAbsList };
}

/** Re-parse exactly the dirty files and read the rest back out of the shards. */
export function runLanes({ idx, dirty, sqlArgs, rootAbs, absOf, stale, jdkBox }) {
  const selection = idx.selection ?? {};
  const store = createFactsStore({ io: ephemeralIo(nodeFactsIo(fs)), projectId: idx.project, env: process.env });
  const webRootsAbs = (selection.webRoots ?? []).map(absOf);
  // The template roots the certified run used, read back from the fact index so
  // the overlay reads exactly the same set (RM48).
  const templateRootsAbs = (selection.templateRoots ?? [])
    .filter((t) => t && typeof t === 'object' && typeof t.root === 'string')
    .map((t) => ({ root: absOf(t.root), engine: t.engine, suffix: t.suffix }));
  const { run, mapperDirsAbs, ddlRels, ddlAbsList } = laneRunners({
    rootAbs, selection, sqlArgs, absOf, templateRootsAbs, stale, jdkBox,
  });
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
  return { lanes, webRootsAbs, templateRootsAbs };
}

/**
 * The web bridge's options for an overlay, or null when this run reads no
 * frontend.
 *
 * They come from the LIVE profile for the same reason `generatedSources` does:
 * the overlay describes the bytes on disk, and a gateway route declared since
 * the pack was built takes effect here first. The SAME options the certified run
 * used, screen axis included: an overlay whose gate was off would report
 * `touched.screens: []` on a file the base pack does put on a screen, and the
 * difference would read as "your edit changed which screens exist".
 */
function webOptions(profile, webRootsAbs, templateRootsAbs) {
  if (webRootsAbs.length === 0 && templateRootsAbs.length === 0) return null;
  return {
    gatewayRoutes: profile?.gatewayRoutes ?? {},
    packages: [],
    // The gate is resolved the SAME way the certified run resolved it,
    // including the third state: `screenAxisOf` reads the frontend packages
    // this overlay reads, so an out-of-root frontend keeps its screens here too.
    screenAxis: {
      ...(profile?.screenAxis ?? {}),
      enabled: screenAxisOf(profile, {
        webPackages: webPackagesRead(webRootsAbs),
        templateRoots: templateRootsAbs,
      }).enabled,
    },
    codeLength: profile?.moduleAttribution?.codeLength ?? null,
  };
}

/** Fold the re-parsed facts and the reused shards into one graph, and say what happened. */
export function overlayState({
  lanes, dirty, dirtyFiles, session, baseGraph, profile, selection, sqlArgs, webRootsAbs, templateRootsAbs,
}) {
  const tBuild = Date.now();
  const built = overlayGraph({
    bridges: LANE_BRIDGES,
    baseShards: lanes.baseShards, dirtyFacts: lanes.dirtyFacts, dropFiles: lanes.dropFiles,
    webBaseShards: lanes.webBaseShards, webDirtyFacts: lanes.webDirtyFacts,
    webDropFiles: lanes.webDropFiles, webConfigRecords: lanes.webConfigRecords,
    web: webOptions(profile, webRootsAbs, templateRootsAbs),
    catalogRecords: lanes.catalogRecords, lineageRecords: lanes.lineageRecords,
    baseGraph, overlaySessionId: session.overlaySessionId,
    dirtyFiles, packagePrefixes: selection.packagePrefixes ?? [],
    // From the LIVE profile, for the same reason `generatedSources` below is: a
    // gateway prefix declared since the pack was built takes effect here first.
    gatewayRoutes: profile?.gatewayRoutes ?? {},
    // Same identity rule as the run that built the base pack — the overlay
    // declines above when the SQL arguments (which carry it) have moved.
    identifierCase: sqlArgs.identifierCase,
    // From the LIVE profile, not the index: the fact index does not record a
    // generated-source declaration, and the overlay describes the bytes on disk
    // now. A declaration edited since the pack was built therefore takes effect
    // on the overlaid files first — visible in `limits` as a changed skip count,
    // never silently.
    generatedSources: profile?.generatedSources ?? { annotations: [], pathGlobs: [] },
  });
  const timingsMs = { ...lanes.timingsMs, build: Date.now() - tBuild };
  timingsMs.total = timingsMs.loadBase + timingsMs.java + timingsMs.web + timingsMs.sql + timingsMs.build;
  return {
    applied: true, state: 'fresh', session, graph: built.graph,
    dirtyFiles, parsedFiles: lanes.parsedFiles, droppedFiles: lanes.dropFiles,
    parsedWebFiles: lanes.parsedWebFiles, droppedWebFiles: lanes.webDropFiles,
    webConfigFiles: dirty.webConfig,
    unmatched: dirty.other, provisional: built.provisional, taggedEdges: built.taggedEdges,
    reusedShards: lanes.reusedShards, javaStats: built.javaStats, webStats: built.webStats,
    timingsMs, limits: [],
  };
}

/**
 * A provider `() => overlayState` for the tool context, plus the reason it could
 * not be built. The provider is called ONCE PER REQUEST (the working tree moves
 * between calls) and memoizes on the overlaySessionId: repeated calls with the
 * same dirty bytes cost one git diff and a few hashes.
 */
export function makeOverlayProvider({ packDir, pack, baseGraph, profile }) {
  const indexFile = path.join(packDir, 'facts-index.json');
  const stale = (msg) => { throw new OverlayStaleError(`${msg}. Run \`cascade analyze\` to rebuild the pack and its fact cache`); };

  let index = null;
  const load = () => {
    if (index) return index;
    index = readIndex(indexFile, stale);
    return index;
  };

  let cache = null; // single-entry LRU: {id, state}
  const jdkBox = { jdk: null };
  const remember = (session, state) => { cache = { id: session.overlaySessionId, state }; return state; };
  const declined = (reason, { headCommit, baseCommit }) => ({
    applied: false, state: 'declined', session: null, dirtyFiles: [], reason,
    limits: [{ scope: 'overlay', reason: `${reason}. Run \`cascade analyze\`` }], baseCommit, headCommit,
  });

  return () => {
    const idx = load();
    const rootAbs = idx.root;
    if (!(pack.meta?.base?.commit ?? idx.base?.commit ?? null)) stale('the pack records no base commit, so there is nothing to diff the working tree against');
    if (!fs.existsSync(rootAbs)) stale(`the analyzed root ${rootAbs} is gone`);

    const diff = dirtyEntries({ idx, pack, packDir, rootAbs, stale });
    const { headCommit, baseCommit, entries } = diff;
    if (diff.declineReason) return declined(diff.declineReason, { headCommit, baseCommit });

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

    const verdict = refuse({ session, dirtyFiles, entries, idx, profile, baseCommit, headCommit });
    if (verdict.declined) return declined(verdict.declined, { headCommit, baseCommit });
    if (!verdict.ok) return remember(session, verdict);

    const absOf = (rel) => path.resolve(rootAbs, rel);
    const { lanes, webRootsAbs, templateRootsAbs } = runLanes({
      idx, dirty: verdict.dirty, sqlArgs: verdict.sqlArgs, rootAbs, absOf, stale, jdkBox,
    });
    return remember(session, overlayState({
      lanes, dirty: verdict.dirty, dirtyFiles, session, baseGraph, profile,
      selection: idx.selection ?? {}, sqlArgs: verdict.sqlArgs, webRootsAbs, templateRootsAbs,
    }));
  };
}
