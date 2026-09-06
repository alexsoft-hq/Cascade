// overlay_lanes.mjs — getting the DIRTY files parsed, fast (SPEC §10, §2.3).
//
// The gates are ≤1 s for a single edited file and ≤3 s for the impact answer,
// so the overlay may not re-run the pipeline. It runs exactly four things:
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
//
// The reuse logic is not re-implemented here: `runSqlLanesWithShards` from
// src/core/incremental.mjs is the same function `cascade analyze` runs, handed
// a store whose writes go to memory. That is the point — an uncommitted edit
// MUST NOT become a cached fact (§10.1), and an overlay that recomputed SQL by
// its own route could omit something the certified re-analysis finds.
//
// IMPURE by design (it spawns workers and reads shards), and kept thin: every
// decision it makes is in a pure module (overlay.mjs / overlay_session.mjs /
// invalidate.mjs) and every edge is injected.

import { splitJavaFactsByFile, splitWebFactsByFile, FactsStoreError } from './facts_store.mjs';
import { runSqlLanesWithShards } from './incremental.mjs';

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
    index, store, inputs, dirty, run, hash, abs, workers, webRootsAbs = [],
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
  if (webRootsAbs.length > 0) {
    // The worker's `--configs-only` mode prints the package configuration and the
    // LIST of files this lane reads. Only the configuration is fact content; the
    // list is what `cascade analyze` uses to decide reuse, and the overlay takes
    // its dirty set from git instead.
    webConfigRecords = (run.webConfigs(webRootsAbs) ?? [])
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
 * The overlay cannot be computed from what is on disk (SPEC §17.4
 * `overlay-stale`). The caller turns this into a structured error that names
 * `cascade analyze` as the cure — never into a quiet fallback to the pre-edit
 * answer, which would look like a fresh one.
 */
export class OverlayStaleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OverlayStaleError';
    this.code = 'overlay-stale';
  }
}
