// incremental.mjs — the incremental EXECUTION path (SPEC §11.2, §15 M6).
//
// It takes a plan from src/core/invalidate.mjs, a shard store from
// src/core/facts_store.mjs, and the INJECTED worker runners, and produces the
// same fact streams a cold run produces: catalog records, lineage records, the
// whole-project JavaFacts stream and the whole-project webfacts stream. The
// caller then builds the graph from them exactly as it always did
// (src/core/assemble.mjs).
//
// THE INVARIANT THIS FILE EXISTS TO KEEP (I-9, SPEC §2.1 item 5):
//   an incremental run's pack digest == the same tree's cold run pack digest.
// Two design choices carry it:
//   1. COLD AND INCREMENTAL SHARE THIS CODE. `--cold` does not take a different
//      route through the engine; it takes THIS route with every cache lookup
//      forced to miss. A cold run therefore cannot drift away from an incremental
//      one by accident — there is only one assembly.
//   2. Each assembled stream is put back into ITS WORKER'S OWN ORDER
//      (facts_store.javaRecordSortKey / webRecordSortKey), not merely the same
//      multiset, because the bridges' maps are last-write-wins in a few places.
// The metamorphic oracle in test/incremental.test.mjs is what proves it on real
// trees; this comment is only the argument for why it should hold.
//
// Everything is injected: `run.*` spawn the workers, `hash` reads a file, `diag`
// receives structured diagnostics. So the whole path is testable with fakes, and
// test/incremental_core.test.mjs does exactly that — no JDK, no Python.

import {
  javaShardKey, webShardKey, sqlStmtsShardKey, lineageShardKey, catalogShardKey, catalogDigestOf,
  splitJavaFactsByFile, assembleJavaFacts,
  splitWebFactsByFile, assembleWebFacts,
  emptyIndex, FactsStoreError,
} from './facts_store.mjs';
import { MODE_COLD } from './invalidate.mjs';

/**
 * The identity of THIS assembly. It is recorded in the facts index and any change
 * to it forces a cold run (src/core/invalidate.mjs), because shards produced by a
 * different assembly may mean something different. Bump it when the shard layout,
 * the keys, or the assembly order change.
 */
export const INCREMENTAL_ENGINE_VERSION = 'cascade-incremental/2';

/**
 * Run the lanes, reusing every shard the plan did not invalidate.
 *
 * @param {Object} a
 * @param {Object} a.plan      from `planIncremental`
 * @param {Object|null} a.index  the previous facts index (null on a cold run)
 * @param {Object} a.store     from `createFactsStore`
 * @param {Object} a.selection {root, javaRoots, javaRootsAbs, webRoots, webRootsAbs,
 *                 mapperDirs, ddls, sqlArgs, packagePrefixes}
 *                 — root-relative paths, plus the absolute Java and web roots
 *                   the cold worker invocations walk.
 * @param {Object} a.inputs    {mapperFiles:[{rel,abs}], ddlFiles:[{rel,abs}],
 *                              dialect, identifierCase, defaultSchema, mybatisArgs, lineageArgs, catalogArgs}
 * @param {Object} a.run       {java(targets), web(targets), webConfigs(roots),
 *                              mybatis(), lineage(statements, catalogRecords), catalog()}
 * @param {(absPath:string)=>string} a.hash  sha256 hex of a file's bytes
 * @param {(abs:string)=>boolean} [a.exists]
 * @param {(relPath:string)=>string} a.abs   root-relative path -> absolute path
 * @param {Object} a.workers   worker version strings
 * @param {string} a.project
 * @param {Object|null} a.base {commit, dirty, dirtyFiles}
 * @param {(d:{kind:string,severity:string,key:string,reason:string})=>void} [a.diag]
 * @returns {{catalogRecords:object[], lineageRecords:object[], statementRecords:object[],
 *            javaFacts:object[], webFacts:object[], index:object, stats:Object}}
 */
export function runLanesWithShards(a) {
  const {
    plan, index = null, store, selection, inputs, run, hash, abs,
    workers, project, base = null, diag = () => {},
  } = a;
  const cold = plan.mode === MODE_COLD;
  const force = cold; // `--cold` / a cold fallback ignores every existing shard

  const stats = {
    mode: plan.mode,
    reason: plan.reason ?? null,
    reparsedJava: 0, reusedJava: 0, droppedJava: 0, tamperedJava: 0,
    reparsedWeb: 0, reusedWeb: 0, droppedWeb: 0, tamperedWeb: 0,
    recomputedLineage: 0, reusedLineage: 0, tamperedLineage: 0,
    statements: 0,
    catalogReused: false, statementsReused: false,
  };

  const newIndex = emptyIndex({
    project,
    engineVersion: INCREMENTAL_ENGINE_VERSION,
    workers,
    root: selection.root,
    selection: {
      javaRoots: selection.javaRoots ?? [],
      mapperDirs: selection.mapperDirs ?? [],
      // RECORDED, and it has to be: `normalizeSelection` in
      // src/core/invalidate.mjs compares the previous selection with this one,
      // so a web root missing from the index would read as "the selection
      // changed" on every single run and no project with a frontend could ever
      // be incremental.
      webRoots: selection.webRoots ?? [],
      // …and the template roots, for the same reason (RM48).
      templateRoots: selection.templateRoots ?? [],
      ddls: selection.ddls ?? (selection.ddl ? [selection.ddl] : []),
      sqlArgs: selection.sqlArgs ?? [],
      packagePrefixes: selection.packagePrefixes ?? [],
    },
    base,
  });

  // ---- 1-3. the SQL lanes (catalog, statements, lineage) ------------------
  // Shared with the working-tree overlay (src/core/overlay_lanes.mjs): the
  // overlay reuses exactly this reuse logic over a store that cannot write, so
  // an overlay's statements and lineage can never drift from an analyze's.
  const sql = runSqlLanesWithShards({ store, index, inputs, run, hash, workers, force, diag });
  const { catalogRecords, statementRecords, lineageRecords } = sql;
  if (sql.catalogEntry) newIndex.catalog = sql.catalogEntry;
  if (sql.statementsShardEntry) newIndex.statementsShard = sql.statementsShardEntry;
  Object.assign(newIndex.statements, sql.statementEntries);
  Object.assign(stats, sql.stats);

  // ---- 4. java facts (one shard per source file) --------------------------
  const shardsByFile = new Map();
  const dropped = new Set(plan.dropJava ?? []);
  stats.droppedJava = dropped.size;
  const reparse = new Set(cold ? [] : plan.reparseJava ?? []);

  if (!cold && index) {
    for (const [file, entry] of Object.entries(index.files ?? {})) {
      // One index holds both lanes' shards; each lane reads its own.
      if ((entry?.lane ?? 'java') !== 'java') continue;
      if (dropped.has(file) || reparse.has(file)) continue;
      const hit = tryRead(store, 'javafacts', entry.shardKey, entry, diag, `javafacts ${file}`);
      if (hit) {
        shardsByFile.set(file, hit.records);
        newIndex.files[file] = { lane: 'java', shardKey: entry.shardKey, sha256: hit.sha256, lines: hit.lines };
      } else {
        // Tampered or vanished: recompute this ONE file rather than trust it.
        stats.tamperedJava += 1;
        reparse.add(file);
      }
    }
    stats.reusedJava = shardsByFile.size;
  }

  const targets = cold
    ? (selection.javaRootsAbs ?? [])
    : [...reparse].sort().map((f) => abs(f));
  if (targets.length > 0) {
    const produced = run.java(targets);
    const { byFile } = splitJavaFactsByFile(produced);
    // A reparsed file that produced NO record still gets an (empty) shard, so the
    // next run can tell "analyzed, nothing in it" from "never analyzed".
    if (!cold) for (const f of reparse) if (!byFile.has(f)) byFile.set(f, []);
    for (const [file, records] of byFile) {
      const key = javaShardKey({ path: file, contentSha256: hash(abs(file)), workerVersion: workers.java });
      const w = store.write('javafacts', key, records);
      shardsByFile.set(file, records);
      newIndex.files[file] = { lane: 'java', shardKey: key, sha256: w.sha256, lines: w.lines };
    }
    stats.reparsedJava = byFile.size;
  }
  const javaFacts = assembleJavaFacts(shardsByFile);

  // ---- 5. web facts (one shard per frontend source file) ------------------
  // The Java lane's shape, with one difference: the PACKAGE CONFIGURATION is
  // never cached. A `.env` value, a dev-server proxy rule and a path alias
  // describe the package, not the file they are written in, so there is no file
  // whose shard could hold them honestly. They are cheap (no source file is
  // walked for them), so every run reads them again.
  const webRootsAbs = selection.webRootsAbs ?? [];
  // A SERVER-RENDERED APPLICATION HAS NO FRONTEND ROOT AT ALL (RM48): its pages
  // are template files under a template root, read by the same worker and shard
  // by shard exactly like a `.js` file. So the lane's inputs are both lists.
  const templateRootsAbs = (selection.templateRootsAbs ?? [])
    .map((t) => (t && typeof t === 'object' ? t.root : t))
    .filter((r) => typeof r === 'string' && r !== '');
  const webInputRoots = [...webRootsAbs, ...templateRootsAbs];
  let webFacts = [];
  if (webInputRoots.length > 0) {
    // One worker invocation, no source file parsed, two answers: the package
    // configuration (never cached) and the LIST of files this lane would read.
    const configOut = (run.webConfigs(webInputRoots) ?? [])
      .filter((r) => r && typeof r === 'object' && r.kind !== 'header' && r.kind !== 'summary');
    const listed = configOut.filter((r) => r.kind === 'sourceFile' && typeof r.file === 'string').map((r) => r.file);
    const configRecords = configOut.filter((r) => r.kind !== 'sourceFile');
    const configFiles = new Set(configRecords.map((r) => r.file).filter((f) => typeof f === 'string'));

    const webShards = new Map();
    const droppedWeb = new Set(plan.dropWeb ?? []);
    const reparseWeb = new Set(cold ? [] : plan.reparseWeb ?? []);

    if (!cold && index) {
      // WHY THE WEB LANE VERIFIES BY CONTENT AND THE JAVA LANE DOES NOT.
      //
      // The Java lane's roots are always inside `--root`, so `git diff` over that
      // root sees every change to them and the plan is binding. A frontend is
      // NOT: `--web-src ../front/src` is the common case and the frontend is as
      // often a separate repository, where a diff of the analyzed root reports
      // nothing at all. A run that trusted the changeset there would reuse a
      // shard describing bytes that are no longer on disk, and the incremental
      // pack would disagree with a cold one. (Measured before this was fixed:
      // two of the four front/back pairs, one edited URL literal, two different
      // digests.)
      //
      // So the decision is taken from the bytes: a shard is reused only when the
      // key derived from the file's CURRENT content is the key the index
      // recorded. The walk above says which files exist, so an added file is
      // parsed and a removed one is dropped without git being asked anything.
      const known = new Set();
      for (const [file, entry] of Object.entries(index.files ?? {})) {
        if (entry?.lane !== 'web') continue;
        known.add(file);
        if (droppedWeb.has(file)) continue;
        if (!listed.includes(file)) { droppedWeb.add(file); continue; }
        if (reparseWeb.has(file)) continue;
        let key = null;
        try { key = webShardKey({ path: file, contentSha256: hash(abs(file)), workerVersion: workers.web }); }
        catch { droppedWeb.add(file); continue; }
        if (key !== entry.shardKey) { reparseWeb.add(file); continue; }
        const hit = tryRead(store, 'webfacts', entry.shardKey, entry, diag, `webfacts ${file}`);
        if (hit) {
          webShards.set(file, hit.records);
          newIndex.files[file] = { lane: 'web', shardKey: entry.shardKey, sha256: hit.sha256, lines: hit.lines };
        } else {
          stats.tamperedWeb += 1;
          reparseWeb.add(file);
        }
      }
      for (const file of listed) if (!known.has(file)) reparseWeb.add(file);
      stats.reusedWeb = webShards.size;
    }
    stats.droppedWeb = droppedWeb.size;

    const webTargets = cold ? webInputRoots : [...reparseWeb].sort().map((f) => abs(f));
    if (webTargets.length > 0) {
      const produced = run.web(webTargets);
      const { byFile } = splitWebFactsByFile(produced, { configFiles });
      // Same rule as the Java lane: a file that was re-read and produced nothing
      // still gets an EMPTY shard, so "read, nothing in it" is distinguishable
      // from "never read".
      if (!cold) for (const f of reparseWeb) if (!byFile.has(f)) byFile.set(f, []);
      for (const [file, records] of byFile) {
        const key = webShardKey({ path: file, contentSha256: hash(abs(file)), workerVersion: workers.web });
        const w = store.write('webfacts', key, records);
        webShards.set(file, records);
        newIndex.files[file] = { lane: 'web', shardKey: key, sha256: w.sha256, lines: w.lines };
      }
      stats.reparsedWeb = byFile.size;
    }
    webFacts = assembleWebFacts(webShards, configRecords);
  }

  return { catalogRecords, lineageRecords, statementRecords, javaFacts, webFacts, index: newIndex, stats };
}

/**
 * The three SQL lanes, each reusing whatever the content-addressed store still
 * holds: the catalog (one shard per DDL file), the mapper statement set (ONE
 * shard for all mapper XML, because `<include refid>` resolves globally) and
 * lineage (one shard per statement).
 *
 * Split out of `runLanesWithShards` so the working-tree overlay can run the
 * SAME code over a store whose writes go nowhere. That is not tidiness: an
 * overlay that recomputed lineage by a different route could report a column
 * the certified re-analysis does not, and §16.1's "overlay ⊆ full" would be a
 * test of two implementations agreeing rather than of one being used twice.
 *
 * @param {Object} a
 * @param {Object} a.store    a facts store (`createFactsStore`)
 * @param {Object|null} a.index  the previous facts index, for the recorded
 *                     sha256/line counts that make a shard read VERIFIED
 * @param {Object} a.inputs  {mapperFiles, ddlFiles, dialect, identifierCase, defaultSchema, mybatisArgs, lineageArgs, catalogArgs}
 * @param {Object} a.run     {catalog(), mybatis(), lineage(statements, catalogRecords)}
 * @param {(abs:string)=>string} a.hash
 * @param {Object} a.workers
 * @param {boolean} [a.force]  ignore every existing shard (a cold run)
 * @param {Function} [a.diag]
 * @returns {{catalogRecords:object[], catalogEntry:(object|null),
 *            statementRecords:object[], statementsShardEntry:(object|null),
 *            lineageRecords:object[], statementEntries:Object, stats:Object}}
 */
export function runSqlLanesWithShards({ store, index = null, inputs, run, hash, workers, force = false, diag = () => {} }) {
  const stats = {
    statements: 0, recomputedLineage: 0, reusedLineage: 0, tamperedLineage: 0,
    catalogReused: false, statementsReused: false,
  };

  // ---- 1. catalog --------------------------------------------------------
  let catalogRecords = [];
  let catalogEntry = null;
  const ddlFiles = inputs.ddlFiles ?? (inputs.ddlFile ? [inputs.ddlFile] : []);
  if (ddlFiles.length > 0) {
    const key = catalogShardKey({
      files: ddlFiles.map((f) => ({ path: f.rel, contentSha256: hash(f.abs) })),
      workerVersion: workers.catalog,
      args: inputs.catalogArgs ?? [],
    });
    const hit = !force && store.has('catalog', key)
      ? tryRead(store, 'catalog', key, index?.catalog, diag, 'catalog')
      : null;
    if (hit) {
      catalogRecords = hit.records;
      stats.catalogReused = true;
      catalogEntry = { shardKey: key, sha256: hit.sha256, lines: hit.lines };
    } else {
      catalogRecords = run.catalog();
      const w = store.write('catalog', key, catalogRecords);
      catalogEntry = { shardKey: key, sha256: w.sha256, lines: w.lines };
    }
  }
  const catalogDigest = catalogDigestOf(catalogRecords);

  // ---- 2. mapper statements (one shard for the set) -----------------------
  let statementStream = [];
  let statementsShardEntry = null;
  if ((inputs.mapperFiles ?? []).length > 0) {
    const key = sqlStmtsShardKey({
      files: inputs.mapperFiles.map((f) => ({ path: f.rel, contentSha256: hash(f.abs) })),
      workerVersion: workers.mybatis,
      args: inputs.mybatisArgs ?? [],
    });
    const hit = !force && store.has('sqlstmts', key)
      ? tryRead(store, 'sqlstmts', key, index?.statementsShard, diag, 'sqlstmts')
      : null;
    if (hit) {
      statementStream = hit.records;
      stats.statementsReused = true;
      statementsShardEntry = { shardKey: key, sha256: hit.sha256, lines: hit.lines };
    } else {
      statementStream = run.mybatis();
      const w = store.write('sqlstmts', key, statementStream);
      statementsShardEntry = { shardKey: key, sha256: w.sha256, lines: w.lines };
    }
  }
  const statementRecords = statementStream.filter((r) => r && r.kind === 'statement');
  stats.statements = statementRecords.length;

  // ---- 3. lineage (one shard per statement) -------------------------------
  const lin = runLineageForStatements({
    store, index, statements: statementRecords, catalogDigest, catalogRecords,
    inputs, run, force, diag, workerVersion: workers.lineage,
  });
  const { lineageRecords, statementEntries } = lin;
  Object.assign(stats, lin.stats);

  return { catalogRecords, catalogEntry, statementRecords, statementsShardEntry, lineageRecords, statementEntries, stats };
}

/**
 * Lineage for a LIST of statements, one content-addressed shard each.
 *
 * Split out so the JPA lane's `@Query(nativeQuery = true)` statements go through
 * EXACTLY the same analyzer, the same shard keys and the same reuse rules as the
 * MyBatis ones (SPEC §15 M10). Two routes to a lineage record would eventually
 * disagree about what a statement touches, and the pack would then hold two
 * opinions about one column.
 *
 * @param {Object} a
 * @param {Object} a.store
 * @param {Object|null} a.index  the previous facts index (for the recorded sha256/lines)
 * @param {object[]} a.statements  `kind:'statement'` records (namespace, id, type, sql, file, line)
 * @param {string} a.catalogDigest
 * @param {Object} a.inputs  {dialect, identifierCase, defaultSchema, lineageArgs}
 * @param {Object} a.run     {lineage(statements, catalogRecords)}
 * @param {object[]} [a.catalogRecords]  passed to the worker (defaults to [])
 * @param {string} a.workerVersion
 * @param {boolean} [a.force]
 * @param {Function} [a.diag]
 * @returns {{lineageRecords:object[], statementEntries:Object, stats:Object}}
 */
export function runLineageForStatements({
  store, index = null, statements, catalogDigest, inputs, run, catalogRecords = [],
  workerVersion, force = false, diag = () => {},
}) {
  const stats = { recomputedLineage: 0, reusedLineage: 0, tamperedLineage: 0 };
  const keyOf = (st) => lineageShardKey({
    sql: st.sql ?? '',
    statementType: st.type ?? null,
    catalogDigest,
    dialect: inputs.dialect,
    identifierCase: inputs.identifierCase ?? null,
    defaultSchema: inputs.defaultSchema ?? null,
    workerVersion,
  });
  const stmtKeys = statements.map(keyOf);
  const payloads = new Map();      // shard key -> {payload, sha256, lines}
  const missing = new Map();       // shard key -> a representative statement record
  const prevStatements = index?.statements ?? {};
  for (let i = 0; i < statements.length; i += 1) {
    const st = statements[i];
    const key = stmtKeys[i];
    if (payloads.has(key) || missing.has(key)) continue;
    const recorded = prevStatements[`${st.namespace}.${st.id}`];
    const expect = recorded && recorded.shardKey === key ? recorded : null;
    if (!force && store.has('lineage', key)) {
      const hit = tryRead(store, 'lineage', key, expect, diag, `lineage ${st.namespace}.${st.id}`);
      if (hit) {
        if (hit.records.length !== 1) {
          diag({ kind: 'SHARD_CORRUPT', severity: 'warn', key: `lineage-${key}`, reason: `expected 1 lineage payload, found ${hit.records.length}, so this statement is recomputed` });
        } else {
          payloads.set(key, { payload: hit.records[0], sha256: hit.sha256, lines: hit.lines });
          continue;
        }
      } else {
        stats.tamperedLineage += 1;
      }
    }
    missing.set(key, st);
  }
  if (missing.size > 0) {
    const reps = [...missing.values()];
    const produced = run.lineage(reps, catalogRecords);
    const byId = new Map();
    for (const r of produced) {
      if (r && r.kind === 'lineage') byId.set(stmtKeyOf(r), r);
    }
    for (const [key, st] of missing) {
      const rec = byId.get(stmtKeyOf(st));
      if (!rec) {
        throw new IncrementalError(`the lineage worker returned no record for statement ${st.namespace}.${st.id}. We refuse to ship a pack with a silently missing statement`);
      }
      const payload = analysisOf(rec);
      const w = store.write('lineage', key, [payload]);
      payloads.set(key, { payload, sha256: w.sha256, lines: w.lines });
    }
    stats.recomputedLineage = missing.size;
  }
  stats.reusedLineage = payloads.size - missing.size;

  const lineageRecords = statements.map((st, i) => {
    const entry = payloads.get(stmtKeys[i]);
    // Carried through from the statement record, exactly as lineage.py does —
    // NOT from the shard, because two statements with identical SQL share one.
    return {
      kind: 'lineage',
      namespace: st.namespace,
      id: st.id,
      type: st.type,
      tables: entry.payload.tables ?? [],
      columns: entry.payload.columns ?? [],
      joins: entry.payload.joins ?? [],
      unresolved: entry.payload.unresolved ?? [],
      hasStringSubst: !!st.hasStringSubst,
      schemaUnknown: !!st.schemaUnknown,
      file: st.file ?? null,
      line: st.line ?? null,
    };
  });
  const statementEntries = {};
  for (let i = 0; i < statements.length; i += 1) {
    const st = statements[i];
    const entry = payloads.get(stmtKeys[i]);
    statementEntries[`${st.namespace}.${st.id}`] = { shardKey: stmtKeys[i], sha256: entry.sha256, lines: entry.lines };
  }
  return { lineageRecords, statementEntries, stats };
}

/**
 * The map key that pairs a produced lineage record with the statement it was
 * computed for. JSON, not a joined string: a separator character can occur inside
 * a MyBatis namespace or id, and a control byte must never enter this source file
 * (git would treat it as binary and hide its diffs).
 */
function stmtKeyOf(rec) {
  return JSON.stringify([rec.namespace ?? null, rec.id ?? null]);
}

/** The half of a lineage record the analyzer DERIVED (the rest is carried through). */
function analysisOf(rec) {
  return {
    tables: rec.tables ?? [],
    columns: rec.columns ?? [],
    joins: rec.joins ?? [],
    unresolved: rec.unresolved ?? [],
  };
}

/**
 * Read a shard, turning a corrupt/missing one into null + a diagnostic instead of
 * an exception. A shard that fails its recorded sha256 or line count is NEVER
 * loaded: the caller recomputes that unit (SPEC §3.3 — no silent loss, and no
 * silently loaded garbage either).
 */
function tryRead(store, kind, key, expect, diag, what) {
  try {
    return store.read(kind, key, expect ?? null);
  } catch (e) {
    if (!(e instanceof FactsStoreError)) throw e;
    diag({
      kind: 'SHARD_UNUSABLE', severity: 'warn', key: `${kind}-${key}`,
      reason: `${e.message}, so ${what} is recomputed from source instead of reused`,
    });
    return null;
  }
}

export class IncrementalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncrementalError';
  }
}
