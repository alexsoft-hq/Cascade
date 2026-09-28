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
import { jpaNamingOf, screenAxisOf, sqlLaneArgs } from '../core/lanes.mjs';
import { overlayGraph, classifyDirtyFiles, classifyTsDirtyFiles, ddlFilesOf } from '../core/overlay.mjs';
import { assertOverlayable, runOverlayLanes, runOverlayTsLane, ephemeralIo, OverlayStaleError } from '../core/overlay_lanes.mjs';
import { overlaySession } from '../core/overlay_session.mjs';
import { ownStateDirRel, isOwnStatePath } from '../core/paths.mjs';
import { normalizeProfile } from '../core/profile.mjs';
import { workerVersions } from '../core/worker_versions.mjs';
import {
  ENGINE_ROOT, findJdk, gitText, listMapperXml, parseJsonl, realPath, splitZ, sqlPython, noSqlPython,
} from './env.mjs';
import { LANE_BRIDGES, runJavaLane, runWebLane, webPackagesRead } from './lanes_run.mjs';
import { tsLaneInputFiles, tsLaneOptions, tsLaneRunners } from './ts_inputs.mjs';
import { jpaNamingConfigured } from './commands/analyze/inputs.mjs';
import { catalogLaneInputs, jpaOptions, mybatisPlusOptions, whichJavaLanes } from './lane_options.mjs';
import { annotationStatementsOf, lineageOfStatements, wrapperFragmentLineageOf } from './java_sql.mjs';
import { safeHash, sha256File } from './state.mjs';
import { readOpenApiDocument } from '../adapters/openapi_bridge.mjs';
import { javaLaneOptions, webLaneOptions } from '../core/assemble.mjs';
import { isTestPath } from '../core/discover.mjs';
import { looksLikeSpringConfigFile } from '../core/springconfig.mjs';

/**
 * The OpenAPI documents the base pack read, as they are on disk now (RM67).
 * The overlay hands them where `analyze` does: to the OpenAPI bridge, whose
 * routes and contract links an overlay without them would drop, and through it
 * to the Java bridge, which places a functional route whose prefix is composed
 * elsewhere where a document declares its operation id. A document gone from
 * the tree is not read, as `analyze` would not read it.
 */
export function openApiDocumentsOf(pack, rootAbs) {
  const docs = pack?.meta?.laneStats?.openapi?.documents ?? [];
  return docs.map((d) => d.path).filter((rel) => typeof rel === 'string' && fs.existsSync(path.resolve(rootAbs, rel)))
    .map((rel) => readOpenApiDocument(fs.readFileSync(path.resolve(rootAbs, rel), 'utf8'), { path: rel }));
}

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
 * The web worker leaves the TypeScript backend's root out, as it did for
 * `analyze`: those files are that lane's, and the frontend's package
 * configuration is read over the files the frontend really has.
 */
function laneRunners({ rootAbs, selection, sqlArgs, absOf, templateRootsAbs, stale, jdkBox, mapperAlternatives, catalogIn }) {
  const mapperDirsAbs = (selection.mapperDirs ?? []).map(absOf);
  const skipped = mapperAlternatives ?? [];
  const pyRes = sqlPython();
  const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
  const runpy = (script, args) => execFileSync(pyRes.path, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
  const needPy = (what) => { if (!pyRes.ok) stale(noSqlPython(`the overlay must rerun ${what} and`, pyRes)); };
  const sourceRoots = (selection.webRoots ?? []).map(absOf);
  const excludeRoots = (selection.tsRoots ?? []).map(absOf);
  const run = {
    java: (targets) => {
      if (!jdkBox.jdk) {
        jdkBox.jdk = findJdk();
        if (!jdkBox.jdk) stale('the overlay must re-parse Java but no JDK was found (set JAVA_HOME, or see docs/setup/java-lane.md)');
      }
      return runJavaLane(jdkBox.jdk, rootAbs, targets);
    },
    mybatis: () => {
      needPy('the MyBatis extractor');
      // The same file list the certified run read, alternatives dropped
      // (RM56): an overlay that read the other vendors' copies would report
      // statements the base pack does not hold, and SPEC 16.1 says the overlay
      // is a subset of the full run, never a second opinion.
      if (skipped.length === 0) {
        return parseJsonl(runpy('mybatis_extract.py', ['--root', rootAbs, ...sqlArgs.mybatisArgs, ...mapperDirsAbs]));
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-overlay-mappers-'));
      try {
        const listFile = path.join(tmp, 'mapper-files.txt');
        fs.writeFileSync(listFile, listMapperXml(mapperDirsAbs, skipped).join('\n') + '\n');
        return parseJsonl(runpy('mybatis_extract.py', ['--root', rootAbs, ...sqlArgs.mybatisArgs, '--files-from', listFile]));
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    },
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
    catalog: () => { if (!catalogIn.fromSnapshot) needPy('the DDL catalog'); return catalogIn.read(runpy); },
    web: (targets) => runWebLane(rootAbs, targets, { sourceRoots, templateRoots: templateRootsAbs, excludeRoots }),
    webConfigs: (roots) => runWebLane(rootAbs, roots, { configsOnly: true, sourceRoots, templateRoots: templateRootsAbs, excludeRoots }),
  };
  return { run, runpy, needPy, mapperDirsAbs, skipped };
}

/**
 * The catalog inputs the base pack's run read (src/cli/lane_options.mjs): the
 * DDL files in the order the fact index records them, or the pinned snapshot
 * when the pack says its catalog came from one. Only ever read on a cache miss,
 * since a clean DDL keys the shard the run wrote; an edited one declines first.
 */
export function catalogInputsOf(pack, selection, absOf, sqlArgs) {
  const files = ddlFilesOf(selection).map((rel) => ({ rel, abs: absOf(rel) }));
  const fromSnapshot = pack?.meta?.catalog?.source === 'snapshot';
  return catalogLaneInputs({ ddls: fromSnapshot ? [] : files, snapshot: fromSnapshot ? files[0] ?? null : null, sqlArgs });
}

/**
 * THE TYPESCRIPT LANE OF AN OVERLAY, or null when the base pack read none: the
 * walk `analyze` runs over the shards (src/core/overlay_lanes.mjs
 * runOverlayTsLane), with the runners `analyze` runs it with, and the bridge's
 * options built by the one function `analyze` builds them with
 * (src/cli/ts_inputs.mjs), from the tsconfig, schema.prisma and package.json
 * files on disk now; and which of the changed files the lane claims.
 */
function overlayTsLane({ idx, store, rootAbs, absOf, profile, profileDir, sqlArgs, catalogRecords, changed }) {
  const appRootAbs = (idx.selection?.tsRoots ?? []).map(absOf)[0] ?? null;
  if (!appRootAbs) return null;
  const lane = runOverlayTsLane({
    index: idx, store, rootsAbs: [appRootAbs], run: tsLaneRunners(rootAbs, appRootAbs), hash: sha256File, abs: absOf, changed,
  });
  const options = tsLaneOptions({ rootAbs, appRootAbs, profile, profileDir, sqlArgs, catalogRecords });
  const claims = classifyTsDirtyFiles(changed, {
    read: lane.tsFilesRead, baseRead: Object.keys(idx.tsFiles ?? {}), inputFiles: tsLaneInputFiles(rootAbs, appRootAbs, options.prismaSchemaFile),
  });
  return { ...lane, options, claims };
}

/** Re-parse exactly the dirty files and read the rest back out of the shards. */
export function runLanes({ idx, dirty, sqlArgs, rootAbs, absOf, stale, jdkBox, mapperAlternatives, profile = null, pack = null, profileDir = null, changed = [] }) {
  const selection = idx.selection ?? {};
  const store = createFactsStore({ io: ephemeralIo(nodeFactsIo(fs)), projectId: idx.project, env: process.env });
  const webRootsAbs = (selection.webRoots ?? []).map(absOf);
  // The template roots the certified run used, read back from the fact index so
  // the overlay reads exactly the same set (RM48).
  const templateRootsAbs = (selection.templateRoots ?? [])
    .filter((t) => t && typeof t === 'object' && typeof t.root === 'string')
    .map((t) => ({ root: absOf(t.root), engine: t.engine, suffix: t.suffix }));
  const catalogIn = catalogInputsOf(pack, selection, absOf, sqlArgs);
  const { run, runpy, needPy, mapperDirsAbs, skipped } = laneRunners({
    rootAbs, selection, sqlArgs, absOf, templateRootsAbs, stale, jdkBox, mapperAlternatives, catalogIn,
  });
  const lanes = runOverlayLanes({
    index: idx, store, dirty, run, abs: absOf, hash: sha256File, workers: workerVersions(), webRootsAbs,
    templateRootsAbs,
    inputs: {
      mapperFiles: listMapperXml(mapperDirsAbs, skipped).map((p) => ({ rel: path.relative(rootAbs, p).split(path.sep).join('/'), abs: p })),
      ddlFiles: catalogIn.files,
      dialect: sqlArgs.dialect, identifierCase: sqlArgs.identifierCase,
      defaultSchema: sqlArgs.defaultSchema,
      mybatisArgs: sqlArgs.mybatisArgs, lineageArgs: sqlArgs.lineageArgs,
      catalogArgs: catalogIn.shardArgs,
    },
  });
  const javaLanesOf = overlayJavaLanes({
    profile, sqlArgs, selection, rootAbs, idx, store, run, runpy, needPy,
    catalogRecords: lanes.catalogRecords, statementRecords: lanes.statementRecords,
  });
  const ts = overlayTsLane({ idx, store, rootAbs, absOf, profile, profileDir, sqlArgs, catalogRecords: lanes.catalogRecords, changed });
  return { lanes, webRootsAbs, templateRootsAbs, javaLanesOf, ts };
}

/**
 * What the Java lanes add to an overlay, given its own assembled records: which
 * bridges run and with what, decided the way `cascade analyze` decided them for
 * the base pack (src/cli/lane_options.mjs), and the lineage of the SQL written
 * in Java source (src/cli/java_sql.mjs). That SQL is read back from the fact
 * cache, or analyzed now through a store that writes nothing to disk: an
 * uncommitted edit never becomes a cached fact.
 */
function overlayJavaLanes({ profile, sqlArgs, selection, rootAbs, idx, store, run, runpy, needPy, catalogRecords, statementRecords }) {
  const prof = profile ?? {};
  const javaRootsAbs = (selection.javaRoots ?? []).map((r) => path.resolve(rootAbs, r));
  const lineageCtx = { store, index: idx, catalog: catalogRecords, sqlArgs, runners: run, force: false, diagnostics: [] };
  return (javaFacts) => {
    if (javaRootsAbs.length === 0) return { jpa: null, mybatisPlus: null, lineage: [] };
    const { runJpa, runMp } = whichJavaLanes(prof, javaFacts, javaRootsAbs);
    const jpa = runJpa ? jpaOptions(prof, sqlArgs, jpaNamingOf(prof, jpaNamingConfigured(javaRootsAbs, rootAbs))) : null;
    const statements = annotationStatementsOf({ javaFacts, statementRecords, runpy, requirePython: needPy, mybatisArgs: sqlArgs.mybatisArgs });
    const lineage = lineageOfStatements({ statements, ...lineageCtx }).lineageRecords;
    if (!runMp) return { jpa, mybatisPlus: null, lineage };
    const mpOpts = mybatisPlusOptions(prof, sqlArgs);
    const fragments = wrapperFragmentLineageOf({ javaFacts, mpOpts, ...lineageCtx });
    return { jpa, mybatisPlus: { ...mpOpts, fragmentLineage: fragments.lineageRecords }, lineage };
  };
}

/**
 * WHAT THE BASE PACK'S WEB BRIDGE WAS HANDED FROM DISCOVERY, read back from the
 * record it kept (src/adapters/web_bridge.mjs): the frontend packages and the
 * ports this pack's applications listen on. Discovery walks the whole tree, and
 * an overlay that must answer in a second does not walk it again, so it hands
 * the bridge what the certified run handed it. Without them a frontend package
 * with no config file of its own was filed under another directory, and a call
 * to this machine on another service's port landed on this pack's route.
 *
 * The package paths are relative to the analyzed root, as discovery wrote them,
 * which is the root the web facts' `file` keys are relative to here as well. A
 * package.json gone from the tree is not a package, as `analyze` would not list
 * it. `recorded` is false for a pack built before the list was kept.
 */
export function baseWebInputsOf(pack, rootAbs) {
  const web = pack?.meta?.laneStats?.web ?? null;
  const recorded = Array.isArray(web?.packages);
  const packages = (recorded ? web.packages : [])
    .filter((rel) => typeof rel === 'string' && fs.existsSync(path.resolve(rootAbs, rel)))
    .map((rel) => ({ path: rel }));
  const p = web?.ports && typeof web.ports === 'object' ? web.ports : null;
  const serverPorts = p && {
    known: p.known === true, ports: p.ports ?? [], files: p.files ?? [], defaulted: p.defaulted === true, why: p.why ?? null,
  };
  return { packages, serverPorts, recorded };
}

/**
 * The web bridge's options for an overlay, or null when this run reads no
 * frontend: the list `analyze` builds (src/core/assemble.mjs webLaneOptions),
 * from the LIVE profile for the same reason `generatedSources` is (a gateway
 * route declared since the pack was built takes effect here first), with the
 * packages and ports the base pack recorded. The screen axis gate is resolved
 * the SAME way the certified run resolved it, including the third state:
 * `screenAxisOf` reads the frontend packages this overlay reads, so an
 * out-of-root frontend keeps its screens here too. An overlay whose gate was off
 * would report `touched.screens: []` on a file the base pack does put on a
 * screen, and that would read as "your edit changed which screens exist".
 */
function webOptions(profile, webRootsAbs, templateRootsAbs, inputs) {
  if (webRootsAbs.length === 0 && templateRootsAbs.length === 0) return null;
  return webLaneOptions(profile, {
    packages: inputs?.packages ?? [],
    serverPorts: inputs?.serverPorts ?? null,
    screenAxisEnabled: screenAxisOf(profile, { webPackages: webPackagesRead(webRootsAbs), templateRoots: templateRootsAbs }).enabled,
  });
}

/**
 * WHERE THE BASE PACK'S WEB INPUTS NO LONGER DESCRIBE THE TREE, as limits. The
 * overlay does not decide again which directories are frontend packages, or
 * which ports the applications listen on, so an edit to the files those come
 * from is not seen, and the answer says so. A pack that kept no package list is
 * said once as well.
 *
 * @param {object} pack
 * @param {{path:string, status:string}[]} entries  the dirty files
 * @param {{webConfig?:string[]}} dirty  their lanes (src/core/overlay.mjs classifyDirtyFiles)
 * @param {{recorded:boolean, serverPorts:(object|null)}} inputs  baseWebInputsOf's answer
 */
export function webInputLimits(pack, entries, dirty, inputs) {
  if (!pack?.meta?.laneStats?.web) return [];
  const limit = (reason) => ({ scope: 'overlay', reason });
  const out = [];
  if (!inputs.recorded) {
    out.push(limit('this pack does not record which frontend packages its run read (it was built before that record was kept), so the overlay files each frontend file under the directory of its own .env, proxy or alias file. '
      + 'A frontend package with none of those may read its base URL and name its clients differently here than in the pack. Run `cascade analyze`'));
  }
  const webConfig = new Set(dirty?.webConfig ?? []);
  const manifests = entries.filter((e) => e.status !== 'D' && webConfig.has(e.path) && path.posix.basename(e.path) === 'package.json').map((e) => e.path);
  if (manifests.length > 0) {
    out.push(limit(`${manifests.join(', ')} changed since the pack was built. The overlay takes which directories are frontend packages from the base pack and does not decide it again, so a package that file adds or removes is not seen in this answer`));
  }
  const springConfigs = entries.filter((e) => looksLikeSpringConfigFile(e.path) && !isTestPath(e.path)).map((e) => e.path);
  if (inputs.serverPorts && springConfigs.length > 0) {
    const read = inputs.serverPorts.known ? `port ${inputs.serverPorts.ports.join(', ')}` : 'no port it could state';
    out.push(limit(`${springConfigs.join(', ')} changed since the pack was built. The overlay places a frontend call on this machine by the ports the base pack read (${read}) and does not read them again, so a port that file now sets is not seen in this answer`));
  }
  return out;
}

/**
 * WHAT THE BASE PACK READ THAT THE OVERLAY DOES NOT READ AGAIN, as limits. The
 * table id generators a Spring XML declares (RM62) come from discovery's walk of
 * the whole tree, which an overlay does not repeat: the calls the base pack bound
 * to one reach no generator statement in an overlay graph, and an answer built
 * on it must say so rather than read as "nothing there". The run traces and
 * recordings are not read again either, and are not said: they add only
 * RUNTIME_ONLY marks, which no walk follows, so no overlay answer moves by them.
 */
export function unreadInputLimits(pack) {
  const ig = pack?.meta?.laneStats?.idGenerators ?? null;
  if (!ig || !(ig.declared > 0)) return [];
  return [{
    scope: 'overlay',
    reason: `the base pack bound ${ig.bound ?? 0} call(s) to the ${ig.declared} table id generator bean(s) its Spring XML declares. `
      + 'The overlay does not re-read those XML files, so in this answer those calls reach no generator statement, and what they reach is unknown rather than absent',
  }];
}

/**
 * WHICH APPLICATION THE TYPESCRIPT LANE READS, said when the live profile
 * names another. The overlay reads the root the fact index records, the one
 * the base pack read, because every shard and every import it follows belongs
 * to that application; a profile that has named another since changes what
 * the next `analyze` reads, and this answer does not see it.
 *
 * @param {object} idx  the fact index
 * @param {object|null} profile  the live profile
 * @param {string|null} profileDir  the directory `tsBackend.app` is relative to
 */
export function tsInputLimits(idx, profile, profileDir) {
  const read = idx.selection?.tsRoots?.[0];
  const named = (profile?.frameworkPacks ?? []).includes('nestjs') ? profile?.tsBackend?.app : null;
  if (typeof read !== 'string' || typeof named !== 'string' || !profileDir) return [];
  const namedRel = path.relative(idx.root, path.resolve(profileDir, named)).split(path.sep).join('/');
  if (namedRel === read) return [];
  return [{
    scope: 'overlay',
    reason: `the profile names the TypeScript application ${namedRel}, and this pack read ${read}. The overlay reads ${read}, as the base pack did, so ${namedRel} is not seen in this answer. Run \`cascade analyze\``,
  }];
}

/** Fold the re-parsed facts and the reused shards into one graph, and say what happened. */
export function overlayState({
  lanes, dirty, dirtyFiles, session, baseGraph, profile, selection, sqlArgs, webRootsAbs, templateRootsAbs, javaLanesOf = null,
  openapiDocuments = null, limits = [], webInputs = null, ts = null,
}) {
  const tBuild = Date.now();
  const built = overlayGraph({
    bridges: LANE_BRIDGES,
    baseShards: lanes.baseShards, dirtyFacts: lanes.dirtyFacts, dropFiles: lanes.dropFiles,
    webBaseShards: lanes.webBaseShards, webDirtyFacts: lanes.webDirtyFacts,
    webDropFiles: lanes.webDropFiles, webConfigRecords: lanes.webConfigRecords,
    web: webOptions(profile, webRootsAbs, templateRootsAbs, webInputs),
    catalogRecords: lanes.catalogRecords, lineageRecords: lanes.lineageRecords,
    baseGraph, overlaySessionId: session.overlaySessionId,
    dirtyFiles,
    // The list `analyze` builds (src/core/assemble.mjs), from the LIVE profile:
    // the overlay describes the bytes on disk now, so a gateway prefix, a path
    // prefix or a generated-source declaration edited since the pack was built
    // takes effect here first. The id generators are not re-read (limits).
    java: javaLaneOptions(profile, { packagePrefixes: selection.packagePrefixes ?? [] }),
    openapiDocuments,
    // Same identity rule as the run that built the base pack — the overlay
    // declines above when the SQL arguments (which carry it) have moved.
    identifierCase: sqlArgs.identifierCase,
    javaLanesOf,
    // The TypeScript lane's stream, and the options `analyze` builds (src/cli/ts_inputs.mjs).
    tsFacts: ts?.tsFacts ?? [], ts: ts?.options ?? null,
  });
  const timingsMs = { ...lanes.timingsMs, ts: ts?.ms ?? 0, build: Date.now() - tBuild };
  timingsMs.total = timingsMs.loadBase + timingsMs.java + timingsMs.web + timingsMs.sql + timingsMs.ts + timingsMs.build;
  return {
    applied: true, state: 'fresh', session, graph: built.graph,
    dirtyFiles, parsedFiles: lanes.parsedFiles, droppedFiles: lanes.dropFiles,
    parsedWebFiles: lanes.parsedWebFiles, droppedWebFiles: lanes.webDropFiles,
    webConfigFiles: dirty.webConfig, ...tsReport(ts),
    unmatched: unclaimedByTs(dirty.other, ts), provisional: built.provisional, taggedEdges: built.taggedEdges,
    reusedShards: lanes.reusedShards, javaStats: built.javaStats, webStats: built.webStats, tsStats: built.tsStats,
    timingsMs, limits,
  };
}

/**
 * What an overlay's TypeScript lane read, for the answer to say: the files
 * the worker read again, those the base pack read and this overlay no longer
 * does, and the lane-wide inputs (a tsconfig, schema.prisma, a package.json)
 * it found changed and read again whole.
 */
function tsReport(ts) {
  return { parsedTsFiles: ts?.parsedTsFiles ?? [], droppedTsFiles: ts?.droppedTsFiles ?? [], tsConfigFiles: ts?.claims.tsConfig ?? [] };
}

/** The changed files no lane claimed, less those the TypeScript lane did: that lane claims them after it ran. */
function unclaimedByTs(other, ts) {
  if (!ts) return other;
  const claimed = new Set([...ts.claims.ts, ...ts.claims.tsConfig]);
  return other.filter((f) => !claimed.has(f));
}

/**
 * The mapper XML this project ships for the OTHER database vendors (RM56),
 * absolute. The profile writes them manifest-relative, and the manifest sits
 * beside the pack, so this is the one place the overlay resolves them.
 */
function mapperAlternativesOf(profile, packDir) {
  const alt = (profile && profile.mappers && profile.mappers.alternatives) || {};
  return [...new Set(Object.values(alt)
    .flatMap((files) => (Array.isArray(files) ? files : []))
    .filter((f) => typeof f === 'string' && f !== '')
    .map((f) => path.resolve(packDir, f)))].sort();
}

/**
 * The fact index, and only when it was written for THIS pack: an index written for
 * another build (published ahead of its pack, or left by a run that died between
 * the two) would lay this pack's overlay over other shards. An index from before
 * indexes named their pack is taken as it is.
 */
export function indexOfPack(indexFile, pack, stale) {
  const index = readIndex(indexFile, stale);
  if (index.packDigest && pack.digest && index.packDigest !== pack.digest) {
    stale(`the fact index beside the pack belongs to build ${index.packDigest}, and the pack is build ${pack.digest}`);
  }
  assertOverlayable(index);
  return index;
}

/** An overlay not laid, with the reason as its limit: it has no session to be remembered by. */
function declinedState(reason, { headCommit, baseCommit }) {
  return {
    applied: false, state: 'declined', session: null, dirtyFiles: [], reason,
    limits: [{ scope: 'overlay', reason: `${reason}. Run \`cascade analyze\`` }], baseCommit, headCommit,
  };
}

/**
 * THE OVERLAY OVER ONE DIRTY SET: the reasons not to lay it, the dirty files
 * re-read, and the graph folded, with what the base pack read that the overlay
 * takes from the pack's record rather than from the tree (the OpenAPI documents'
 * paths, the frontend packages, the server ports) and what it cannot take at
 * all, said as limits. `makeOverlayProvider` hands it what the diff says is
 * dirty. Handed NO dirty file it must build the pack's own graph, and
 * test/overlay_equivalence.test.mjs holds it to that.
 *
 * @returns {object} the overlay state; one with `session: null` is a decline
 *          nothing can be remembered by
 */
export function layOverlay({ packDir, pack, baseGraph, profile, idx, session, entries, baseCommit, headCommit, stale, jdkBox = { jdk: null } }) {
  const dirtyFiles = entries.map((e) => e.path);
  const verdict = refuse({ session, dirtyFiles, entries, idx, profile, baseCommit, headCommit });
  if (verdict.declined) return declinedState(verdict.declined, { headCommit, baseCommit });
  if (!verdict.ok) return verdict;
  const rootAbs = idx.root;
  const absOf = (rel) => path.resolve(rootAbs, rel);
  const profileDir = profileDirOf(packDir, pack);
  const { lanes, webRootsAbs, templateRootsAbs, javaLanesOf, ts } = runLanes({
    idx, dirty: verdict.dirty, sqlArgs: verdict.sqlArgs, rootAbs, absOf, stale, jdkBox, profile, pack,
    mapperAlternatives: mapperAlternativesOf(profile, packDir), profileDir, changed: dirtyFiles,
  });
  const webInputs = baseWebInputsOf(pack, rootAbs);
  return overlayState({
    lanes, dirty: verdict.dirty, dirtyFiles, session, baseGraph, profile, openapiDocuments: openApiDocumentsOf(pack, rootAbs),
    limits: [...unreadInputLimits(pack), ...webInputLimits(pack, entries, verdict.dirty, webInputs), ...tsInputLimits(idx, profile, profileDir)], webInputs,
    selection: idx.selection ?? {}, sqlArgs: verdict.sqlArgs, webRootsAbs, templateRootsAbs, javaLanesOf, ts,
  });
}

/**
 * The directory of the profile the overlay is served with: the file the pack
 * recorded, else the one beside the pack (src/cli/serve.mjs servedProfile).
 * `tsBackend.prismaSchema` is relative to it, as `analyze` read it.
 */
function profileDirOf(packDir, pack) {
  const file = [pack?.meta?.profile, path.join(packDir, '..', 'profile.json')].find((f) => typeof f === 'string' && fs.existsSync(f));
  return file ? path.dirname(file) : null;
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
    index = indexOfPack(indexFile, pack, stale);
    return index;
  };

  let cache = null; // single-entry LRU: {id, state}
  const jdkBox = { jdk: null };
  const remember = (session, state) => { cache = { id: session.overlaySessionId, state }; return state; };

  return () => {
    const idx = load();
    const rootAbs = idx.root;
    if (!(pack.meta?.base?.commit ?? idx.base?.commit ?? null)) stale('the pack records no base commit, so there is nothing to diff the working tree against');
    if (!fs.existsSync(rootAbs)) stale(`the analyzed root ${rootAbs} is gone`);

    const diff = dirtyEntries({ idx, pack, packDir, rootAbs, stale });
    const { headCommit, baseCommit, entries } = diff;
    if (diff.declineReason) return declinedState(diff.declineReason, { headCommit, baseCommit });

    const session = overlaySession({
      baseDigest: pack.digest,
      baseCommit,
      headCommit,
      dirtyFiles: entries.map((e) => ({
        path: e.path,
        sha256: e.status === 'D' ? null : safeHash(path.resolve(rootAbs, e.path)),
      })),
    });
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

    const state = layOverlay({ packDir, pack, baseGraph, profile, idx, session, entries, baseCommit, headCommit, stale, jdkBox });
    return state.session ? remember(session, state) : state;
  };
}
