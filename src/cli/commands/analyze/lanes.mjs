// analyze/lanes.mjs — running the lanes, and folding what they say into a graph.
//
// The four workers (a Java program, a Node worker, three Python scripts), the
// three kinds of SQL that arrive from somewhere other than a mapper XML — a
// MyBatis annotation, a native `@Query`, a MyBatis-Plus wrapper fragment — the
// OpenAPI documents read beside them, and the ONE core-owned seam where all of
// it becomes a graph.
//
// Every DECISION here is somebody else's: `src/core/incremental.mjs` decides
// what to recompute, `src/core/assemble.mjs` decides in what order the bridges
// run. This is the impure edge those pure rules are handed.

import fs from 'node:fs';
import path from 'node:path';
import { nativeQueryStatements } from '../../../adapters/jpa_bridge.mjs';
import { wrapperFragmentStatements } from '../../../adapters/mp_bridge.mjs';
import { annotationMapperXml, restampToJavaSource } from '../../../adapters/mybatis_annotation.mjs';
import { readOpenApiDocument } from '../../../adapters/openapi_bridge.mjs';
import { readOtelTrace } from '../../../adapters/runtime_bridge.mjs';
import { addWebFacts } from '../../../adapters/web_bridge.mjs';
import { assembleGraph } from '../../../core/assemble.mjs';
import { webFactsSummary, catalogDigestOf as catalogDigestForShards } from '../../../core/facts_store.mjs';
import { runLanesWithShards, runLineageForStatements } from '../../../core/incremental.mjs';
import { MODE_COLD } from '../../../core/invalidate.mjs';
import { CATALOG_LIVE_WORKER_VERSION, workerVersions } from '../../../core/worker_versions.mjs';
import { findJdk, listMapperXml, parseJsonl, jsonl } from '../../env.mjs';
import { LANE_BRIDGES, runJavaLane, runWebLane } from '../../lanes_run.mjs';
import { sha256File } from '../../state.mjs';
import { sayWebWorker } from './census.mjs';

/**
 * THE FOUR WORKER INVOCATIONS, and the sharded run over them.
 *
 * Every DECISION about what to recompute is `src/core/incremental.mjs`'s; these
 * closures are only the impure edge it is handed. The Java lane's JDK is looked
 * up at most once, and only if the lane really runs.
 */
/**
 * THE FOUR WORKER INVOCATIONS, bound to this run's roots and reading convention.
 *
 * These closures are the impure edge `src/core/incremental.mjs` is handed: it
 * decides WHAT to recompute, they do it. The Java lane's JDK is looked up at
 * most once, and only if a source root really has to be re-parsed.
 */
export function laneRunners({ die }, { root, tmpDir, plan, sel, snapshot, ddls, mappers, webSrc, sqlArgs, runpy }) {
  const catFile = path.join(tmpDir, 'catalog.jsonl');
  const stmtFile = path.join(tmpDir, 'statements.jsonl');
  let jdk = null;
  const runners = {
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
  return runners;
}

/**
 * The sharded run over those workers: what to recompute is
 * `src/core/incremental.mjs`'s decision, and this hands it the inputs.
 */
export function runLanes(ctx, { root, tmpDir, plan, prevIndex, store, sel, selectionRel, ddls, snapshot, mappers, javaSrc, webSrc, sqlArgs, runpy, projectId, base, relOf, absOf, diagnostics }) {
  const runners = laneRunners(ctx, { root, tmpDir, plan, sel, snapshot, ddls, mappers, webSrc, sqlArgs, runpy });
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
    run: runners,
    hash: sha256File,
    abs: absOf,
    workers: workerVersions(),
    project: projectId ?? 'nocache',
    base,
    diag: (d) => { shardDiagnostics.push(d); },
  });
  diagnostics.push(...shardDiagnostics);
  return { result, runners };
}

/**
 * MyBatis STATEMENTS WRITTEN AS ANNOTATIONS (RM20 §4).
 *
 * `@Select("select * from t_user")` is a MyBatis statement with no XML
 * anywhere. It goes through the SAME flattener as a mapper XML statement —
 * written out as a synthetic mapper file into this run's scratch directory and
 * read by `mybatis_extract.py` — because the annotation form accepts the same
 * `<script>` dynamic tags, and one reading of `<foreach>` is the only way both
 * spellings can stay in step. What comes back is re-stamped onto the Java file
 * and the annotation's line, so nothing in the pack points at the scratch file.
 *
 * @returns {Object[]} the lineage records those statements produced, if any
 */
export function annotationLineage({ javaSrc, result, store, prevIndex, catalog, sqlArgs, plan, py, runpy, runners, tmpDir, diagnostics }) {
  let annotationStmts = [];
  if (javaSrc.length > 0) {
    const existingKeys = result.statementRecords
      ? result.statementRecords.filter((r) => r && r.kind === 'statement').map((r) => `${r.namespace}.${r.id}`)
      : [];
    const annotationXml = annotationMapperXml(result.javaFacts, existingKeys);
    diagnostics.push(...annotationXml.diagnostics);
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
      run: runners, workerVersion: workerVersions().lineage,
      force: plan.mode === MODE_COLD,
      diag: (d) => { diagnostics.push(d); },
    });
    Object.assign(result.index.statements, ann.statementEntries);
    return ann.lineageRecords;
  }
  return [];
}

/**
 * THE JPA LANE'S NATIVE QUERIES (SPEC §15 M10). `@Query(nativeQuery = true)` is
 * SQL, not JPQL, so it belongs to the SQL analyzer — the same lineage.py, the
 * same content-addressed shards, the same dialect and default schema as a
 * MyBatis statement. Run AFTER the Java lane produced the repository facts and
 * BEFORE the graph is built, so those statements arrive as ordinary lineage.
 */
export function nativeQueryLineage({ javaSrc, result, store, prevIndex, catalog, sqlArgs, plan, py, runners, diagnostics }) {
  const nativeStmts = javaSrc.length > 0 ? nativeQueryStatements(result.javaFacts) : [];
  if (nativeStmts.length === 0) return [];
  if (!fs.existsSync(py)) {
    diagnostics.push({
      kind: 'MISSING_INPUT', severity: 'warn', key: 'frameworkPacks',
      reason: `${nativeStmts.length} @Query(nativeQuery=true) statement(s) were found but there is no venv python at ${py} to analyze their SQL. See docs/setup/sql-lane.md. Those statements carry no table or column fact in this pack`,
    });
    return [];
  }
  process.stderr.write(`JPA lane: ${nativeStmts.length} native @Query statement(s) -> SQL lineage (dialect ${sqlArgs.dialect || 'sqlglot default/ANSI'}, identifiers ${sqlArgs.identifierCase})…\n`);
  const nat = runLineageForStatements({
    store, index: prevIndex, statements: nativeStmts,
    catalogDigest: catalogDigestForShards(catalog), catalogRecords: catalog,
    inputs: {
      dialect: sqlArgs.dialect,
      identifierCase: sqlArgs.identifierCase,
      defaultSchema: sqlArgs.defaultSchema,
    },
    run: runners, workerVersion: workerVersions().lineage,
    force: plan.mode === MODE_COLD,
    diag: (d) => { diagnostics.push(d); },
  });
  Object.assign(result.index.statements, nat.statementEntries);
  return nat.lineageRecords;
}

/**
 * WHICH LANES ASSEMBLE. The Java bridge runs when there were Java source roots;
 * the JPA bridge when the Java lane found entity/repository facts or the profile
 * asks for the pack by name (SPEC §15 M10 wiring); the MyBatis-Plus bridge on
 * the same two witnesses — the profile names the pack, or the Java lane actually
 * saw a `@TableName` / `BaseMapper<T>` / `ServiceImpl<M, T>` in the source. A
 * project that has none of them pays nothing.
 *
 * The decision is made HERE: the core assembler is handed options, never a
 * profile to interpret.
 */
export function whichLanesAssemble(profile, result, javaSrc) {
  const runJava = javaSrc.length > 0;
  const runJpa = runJava && ((profile.frameworkPacks ?? []).includes('jpa')
    || result.javaFacts.some((r) => r && (r.kind === 'entity' || r.kind === 'repository')));
  const runMp = runJava && ((profile.frameworkPacks ?? []).includes('mybatis-plus')
    || result.javaFacts.some((r) => r && (r.kind === 'mpEntity' || r.kind === 'mpMapper' || r.kind === 'mpService')));
  return { runJava, runJpa, runMp };
}

/**
 * THE MyBatis-Plus LANE'S WRAPPER SQL FRAGMENTS (SPEC §18.2).
 *
 * `apply / last / setSql / inSql / notInSql / exists / notExists / having` hand
 * MyBatis-Plus raw SQL. It is SQL, so it belongs to the SQL analyzer — the same
 * lineage.py, the same catalog, dialect and identity rule, the same
 * content-addressed shards as a mapper statement or a native @Query. Run here,
 * after the Java lane produced the wrapper facts and BEFORE the graph is built,
 * so the bridge can attach what came back to the statement the wrapper feeds.
 */
export function wrapperFragmentLineage({ runMp, profile, sqlArgs, result, store, prevIndex, catalog, plan, py, runners, diagnostics }) {
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
        run: runners, workerVersion: workerVersions().lineage,
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
  return { mpOpts, fragmentLineage };
}

/**
 * The OpenAPI documents, read HERE beside the lanes because a document is an
 * input like any other: bytes on disk this run turns into facts. It is NOT
 * sharded and not cached — a document is one file, parsed in milliseconds, and
 * a cache that could hand back a stale contract would be the one thing a drift
 * readout must never do.
 */
export function readOpenApiDocs({ die }, { openapiFiles, root, diagnostics }) {
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
  return openapiDocs;
}

/**
 * THE WEB LANE'S OWN CENSUS (RM26, sharded in RM29). The worker ran inside
 * `runLanesWithShards`, over the roots on a cold run and over the changed files
 * on an incremental one; what arrives here is the assembled stream, in the byte
 * order a cold worker prints.
 *
 * The counts are RECOMPUTED from those records rather than read from a
 * `summary`: an incremental run has no single worker invocation to read one
 * from, and a number derived from the same records the bridge sees cannot
 * describe a different run from the facts beside it.
 */
export function webWorkerStatsOf({ result, webSrc, sel, profile, resolved, root, relOf }) {
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
  }
  if (webWorkerStats) sayWebWorker(webWorkerStats, { webFacts, profile, resolved, root, relOf });
  return { webFacts, webWorkerStats };
}

/**
 * FACTS -> GRAPH, through the ONE core-owned seam the working-tree overlay also
 * goes through (src/core/assemble.mjs), with the bridges injected: the identity
 * rule handed in is the SAME one the lineage worker matched with, so a bridge
 * cannot key a table differently from the worker that resolved it.
 */
export function assembleAll({ result, webFacts, openapiDocs, otelFiles, webWorkerStats, profile, discovery, sqlArgs, screenGate, runJava, runJpa, mpOpts, fragmentLineage, catalog, lineage, relOf }) {
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
  const assembled = assembleGraph({
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
  return { ...assembled, otelTraces, webBridgeMs };
}
