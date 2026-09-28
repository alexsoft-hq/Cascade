// overlay_lanes.mjs — getting the DIRTY files parsed, fast (SPEC §10, §2.3).
//
// The gates are ≤1 s for a single edited file and ≤3 s for the impact answer,
// so the overlay may not re-run the pipeline. It runs exactly five things:
//
//   web      the webfacts worker over the dirty frontend files ONLY, plus the
//            package configuration (`.env*`, the dev proxy, the aliases), which
//            is read on EVERY overlay because it is never cached: those values
//            reshape every URL the frontend sends, so answering from a cached
//            copy would describe a base URL that is no longer on disk. Reading
//            them walks no source file.
//   java     JavaFacts over the dirty .java files ONLY. Safe because JavaFacts
//            is file-local (see src/core/invalidate.mjs for the argument and
//            test/incremental.test.mjs for the measurement): every cross-file
//            resolution happens afterwards, in the bridge, over the whole
//            assembled fact set — which the overlay rebuilds in full.
//   mybatis  only when a mapper XML is dirty. The extractor resolves
//            `<include refid>` through a GLOBAL fragment index, so it reruns
//            over ALL mapper files; that is one shard key, and when no mapper
//            moved the key still matches and nothing runs at all.
//   lineage  only for statements whose shard is not already in the cache. The
//            per-statement shards RM3 wrote make a mapper edit cost the
//            statements that actually moved, not the project's SQL.
//   ts       the tsfacts worker over the TypeScript files whose bytes no longer
//            key their shard, and over any file an import reaches for the first
//            time (`runOverlayTsLane`). Which files the lane reads follows
//            their imports, so the lane is walked again over the shards; it
//            costs a hash per file and a directory listing.
//
// The reuse logic is not re-implemented here: `runSqlLanesWithShards` and
// `runTsLaneWithShards` from src/core/incremental.mjs are the functions
// `cascade analyze` runs, handed a store whose writes go to memory. That is
// the point — an uncommitted edit MUST NOT become a cached fact (§10.1), and an
// overlay that recomputed SQL by its own route could omit something the
// certified re-analysis finds.
//
// IMPURE by design (it spawns workers and reads shards), and kept thin: every
// decision it makes is in a pure module (overlay.mjs / overlay_session.mjs /
// invalidate.mjs) and every edge is injected.

import { splitJavaFactsByFile, splitWebFactsByFile, FactsStoreError } from './facts_store.mjs';
import { runSqlLanesWithShards, runTsLaneWithShards } from './incremental.mjs';

/**
 * A store io that READS the real cache and swallows every write.
 *
 * The overlay reuses the incremental executor, which writes a shard whenever it
 * recomputes one. Those shards describe bytes that exist only in an editor
 * buffer, so they must not land in the content-addressed cache where the next
 * `analyze` would find them. They go into a Map that dies with the call.
 *
 * @param {{readFile:Function, exists:Function}} io  the real (read) io
 * @returns {{readFile:Function, writeFile:Function, exists:Function, mkdir:Function, scratch:Map<string,string>}}
 */
export function ephemeralIo(io) {
  const scratch = new Map();
  return {
    scratch,
    readFile: (p) => (scratch.has(p) ? scratch.get(p) : io.readFile(p)),
    writeFile: (p, s) => { scratch.set(p, s); },
    exists: (p) => scratch.has(p) || io.exists(p),
    mkdir: () => {},
  };
}

/**
 * Parse what is dirty and reassemble everything else from the cache.
 *
 * @param {Object} a
 * @param {Object} a.index    the pack's `facts-index.json` (already validated)
 * @param {Object} a.store    a facts store over `ephemeralIo`
 * @param {Object} a.inputs   as `runSqlLanesWithShards` takes them
 * @param {{java:string[], javaDeleted:string[], web:string[], webDeleted:string[],
 *          webConfig:string[], xml:string[], ddl:string[], other:string[]}} a.dirty
 *        from `classifyDirtyFiles`
 * @param {Object} a.run      {java(absPaths), web(absPaths), webConfigs(roots),
 *                             mybatis(), lineage(...), catalog()}
 * @param {(abs:string)=>string} a.hash
 * @param {(rel:string)=>string} a.abs
 * @param {Object} a.workers
 * @param {string[]} [a.webRootsAbs]  the frontend source roots, absolute. Empty
 *        (or absent) means this pack has no web lane and none is run.
 * @param {()=>number} [a.clock]  monotonic-ish milliseconds, injected for tests
 * @param {Function} [a.diag]
 * @returns {{baseShards:Map<string,object[]>, dirtyFacts:Map<string,object[]>, dropFiles:string[],
 *            webBaseShards:Map<string,object[]>, webDirtyFacts:Map<string,object[]>,
 *            webDropFiles:string[], webConfigRecords:object[], parsedWebFiles:string[],
 *            catalogRecords:object[], lineageRecords:object[],
 *            statementRecords:object[], parsedFiles:string[], reusedShards:number,
 *            timingsMs:Object, stats:Object}}
 */
export function runOverlayLanes(a) {
  const {
    index, store, inputs, dirty, run, hash, abs, workers, webRootsAbs = [], templateRootsAbs = [],
    clock = () => Date.now(), diag = () => {},
  } = a ?? {};
  if (!index || typeof index !== 'object') throw new OverlayStaleError('there is no facts index beside the pack');
  if (!store) throw new OverlayStaleError('the overlay needs a fact shard store');

  const reparse = new Set(dirty.java ?? []);
  const dropFiles = [...(dirty.javaDeleted ?? [])];
  const dropped = new Set(dropFiles);
  const reparseWeb = new Set(dirty.web ?? []);
  const webDropFiles = [...(dirty.webDeleted ?? [])];
  const droppedWeb = new Set(webDropFiles);

  // ---- 1. the base shards -------------------------------------------------
  // Only the files the overlay is NOT about to replace or drop are read: a
  // dirty file's cached facts describe the previous bytes and would be spliced
  // out immediately. Both lanes' shards live in one index, each tagged with the
  // lane that produced it.
  const t0 = clock();
  const baseShards = new Map();
  const webBaseShards = new Map();
  for (const [file, entry] of Object.entries(index.files ?? {})) {
    const web = entry?.lane === 'web';
    if (web ? (reparseWeb.has(file) || droppedWeb.has(file)) : (reparse.has(file) || dropped.has(file))) continue;
    try {
      const records = store.read(web ? 'webfacts' : 'javafacts', entry.shardKey, entry).records;
      (web ? webBaseShards : baseShards).set(file, records);
    } catch (e) {
      if (!(e instanceof FactsStoreError)) throw e;
      // A missing or corrupt shard cannot be recomputed here without re-parsing
      // a file the user did not touch — which would blow the latency gate and
      // still be a guess. The overlay declines and names the cure.
      throw new OverlayStaleError(`${e.message}. The fact cache no longer matches this pack`);
    }
  }
  const t1 = clock();

  // ---- 2. java: the dirty files, and only those --------------------------
  const dirtyFacts = new Map();
  const parsedFiles = [...reparse].sort();
  if (parsedFiles.length > 0) {
    const produced = run.java(parsedFiles.map((f) => abs(f)));
    const { byFile } = splitJavaFactsByFile(produced);
    for (const [file, records] of byFile) dirtyFacts.set(file, records);
    // A file the worker returned nothing for still gets an EMPTY fact list, not
    // its old shard: "this file now carries no facts" is an answer, and falling
    // back to the cached version would resurrect deleted methods.
    for (const f of parsedFiles) if (!dirtyFacts.has(f)) dirtyFacts.set(f, []);
  }
  const t2 = clock();

  // ---- 3. web: the dirty frontend files, and the package configuration ----
  // The configuration is read WHATEVER changed, because it is never cached: a
  // `.env` value or a proxy rule reshapes every URL the frontend sends, and the
  // overlay describes the bytes on disk right now. It walks no source file, so
  // it costs one process start.
  const webDirtyFacts = new Map();
  const parsedWebFiles = [...reparseWeb].sort();
  let webConfigRecords = [];
  // The web lane also reads the TEMPLATE roots (RM48); a server-rendered
  // application has those and no frontend source root at all.
  const webInputRoots = [...webRootsAbs, ...templateRootsAbs.map((t) => (t && typeof t === 'object' ? t.root : t))];
  if (webInputRoots.length > 0) {
    // The worker's `--configs-only` mode prints the package configuration and the
    // LIST of files this lane reads. Only the configuration is fact content; the
    // list is what `cascade analyze` uses to decide reuse, and the overlay takes
    // its dirty set from git instead.
    webConfigRecords = (run.webConfigs(webInputRoots) ?? [])
      .filter((r) => r && typeof r === 'object'
        && r.kind !== 'header' && r.kind !== 'summary' && r.kind !== 'sourceFile');
    const configFiles = new Set(webConfigRecords.map((r) => r.file).filter((f) => typeof f === 'string'));
    if (parsedWebFiles.length > 0) {
      const produced = run.web(parsedWebFiles.map((f) => abs(f)));
      const { byFile } = splitWebFactsByFile(produced, { configFiles });
      for (const [file, records] of byFile) webDirtyFacts.set(file, records);
      // Same rule as the Java lane: a file that came back with nothing gets an
      // EMPTY list, never its old shard, or a call the user just deleted would
      // come back to life.
      for (const f of parsedWebFiles) if (!webDirtyFacts.has(f)) webDirtyFacts.set(f, []);
    }
  }
  const t3 = clock();

  // ---- 4. the SQL lanes (the same executor `analyze` runs) ---------------
  const sql = runSqlLanesWithShards({ store, index, inputs, run, hash, workers, force: false, diag });
  const t4 = clock();

  return {
    baseShards,
    dirtyFacts,
    dropFiles,
    webBaseShards,
    webDirtyFacts,
    webDropFiles,
    webConfigRecords,
    parsedWebFiles,
    catalogRecords: sql.catalogRecords,
    lineageRecords: sql.lineageRecords,
    statementRecords: sql.statementRecords,
    parsedFiles,
    reusedShards: baseShards.size + webBaseShards.size,
    timingsMs: { loadBase: t1 - t0, java: t2 - t1, web: t3 - t2, sql: t4 - t3 },
    stats: sql.stats,
  };
}

/**
 * THE TYPESCRIPT LANE, walked the way `analyze` walks it
 * (src/core/incremental.mjs runTsLaneWithShards) over a store whose writes go
 * nowhere. That is what makes an overlay over no edit the analyzed graph: the
 * same files listed under the application's root, the same shards reused, the
 * same imports followed. An edited file's bytes no longer key its shard, so the
 * worker reads it again; a file an edited import now reaches is read for the
 * first time, and one no import reaches any more is left out, as the next
 * `analyze` would. Nothing crosses files here: the bridge decides that over the
 * whole stream (src/core/assemble.mjs).
 *
 * THE STALE RULE. The worker reads again only what the working tree changed,
 * or what the base pack never read. A file the base pack read, that git does
 * not list as changed, and whose shard still does not apply means the fact
 * cache no longer describes this pack: the TypeScript worker changed (its
 * version is in every shard's key), the shard is gone, or the file changed
 * where git does not look. Reading all of it again would blow the latency gate
 * and describe a pack nobody built, so the overlay declines and names the cure.
 *
 * @param {Object} a
 * @param {Object} a.index  the pack's fact index; its `tsFiles` are what the base read
 * @param {Object} a.store  a facts store over `ephemeralIo`
 * @param {string[]} a.rootsAbs  the application's root, as the index records it; empty runs nothing
 * @param {{tsList:Function, ts:Function, tsResolver:Function}} a.run  src/cli/ts_inputs.mjs tsLaneRunners
 * @param {(abs:string)=>string} a.hash
 * @param {(rel:string)=>string} a.abs
 * @param {string[]} a.changed  every path the working tree changed, root-relative
 * @returns {{tsFacts:object[], parsedTsFiles:string[], droppedTsFiles:string[], tsFilesRead:string[], ms:number}}
 */
export function runOverlayTsLane({ index, store, rootsAbs = [], run, hash, abs, changed = [], clock = () => Date.now() }) {
  const t0 = clock();
  if (rootsAbs.length === 0) return { tsFacts: [], parsedTsFiles: [], droppedTsFiles: [], tsFilesRead: [], ms: 0 };
  const dirty = new Set(changed);
  const relOf = new Map();
  const absOf = (rel) => { const a = abs(rel); relOf.set(a, rel); return a; };
  const ts = runTsLaneWithShards({
    index, store, roots: rootsAbs, hash, abs: absOf, force: false,
    run: { ...run, ts: (targets) => { assertTsShardsApply(index, targets.map((t) => relOf.get(t) ?? t), dirty); return run.ts(targets); } },
  });
  const read = Object.keys(ts.tsFiles).sort();
  const now = new Set(read);
  return {
    tsFacts: ts.tsFacts, parsedTsFiles: ts.reparsed,
    droppedTsFiles: Object.keys(index.tsFiles ?? {}).filter((f) => !now.has(f)).sort(),
    tsFilesRead: read, ms: clock() - t0,
  };
}

/** The stale rule of `runOverlayTsLane`: a file about to be read again that the base read and the working tree did not change. */
function assertTsShardsApply(index, files, dirty) {
  const unseen = files.filter((f) => index.tsFiles?.[f] && !dirty.has(f));
  if (unseen.length === 0) return;
  throw new OverlayStaleError(`the cached TypeScript facts of ${unseen.length} file(s) the working tree did not change no longer apply `
    + `(${unseen.slice(0, 3).join(', ')}${unseen.length > 3 ? ', and more' : ''}): the TypeScript worker changed since the pack was built, `
    + 'a shard is gone from the fact cache, or a file changed where git does not look. Run `cascade analyze` to read them again');
}

/**
 * The overlay cannot be computed from what is on disk (SPEC §17.4
 * `overlay-stale`). The caller turns this into a structured error that names
 * `cascade analyze` as the cure — never into a quiet fallback to the pre-edit
 * answer, which would look like a fresh one.
 */
/**
 * Whether the overlay can re-read what a pack's fact index holds. The
 * TypeScript lane's entries sit in the index's own `tsFiles`, which is how the
 * overlay knows which files that lane read. An index written before they did
 * kept them among the other lanes' in `files`; the overlay cannot tell there
 * which files the lane read, so it declines, and base-only still answers.
 */
export function assertOverlayable(index) {
  if (Object.values(index.files ?? {}).some((e) => e?.lane === 'ts')) {
    throw new OverlayStaleError('this pack\'s fact index keeps its TypeScript shards among the other lanes\' (an older engine wrote it), '
      + 'so the working-tree overlay cannot tell which files the TypeScript lane read. Run `cascade analyze` to write the index again', 'ts-not-overlaid');
  }
}

export class OverlayStaleError extends Error {
  constructor(message, code = 'overlay-stale') {
    super(message);
    this.name = 'OverlayStaleError';
    this.code = code;
  }
}
