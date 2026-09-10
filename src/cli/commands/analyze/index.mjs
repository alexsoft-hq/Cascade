// analyze/index.mjs — `cascade analyze`: run the lanes end to end and write a
// pack into the project's `.cascade/`.
//
// Every lane input is OPTIONAL: what a flag does not name comes from the
// project's manifest + profile + discovery, and a lane with no input is
// DECLARED missing rather than fatal (SPEC §10.4 MUST — a partial pack, never a
// die()). Where the pack goes is decided by the project resolver (SPEC §15 M1),
// not by joining a literal onto cwd: --pack > --project (registry) > --root > cwd.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addHarFacts, readHar } from '../../../adapters/har_bridge.mjs';
import { sqlLaneArgs, declareAxes, screenAxisOf, serviceNamesOf } from '../../../core/lanes.mjs';
import { ENGINE_ROOT, SCRATCH, listMapperXml, noSqlPython, sqlPython } from '../../env.mjs';
import { webPackagesRead } from '../../lanes_run.mjs';
import {
  sayDdlChoice, sayHarLane, sayIdentity, sayJavaLanes, sayLaneLine, sayMapperCensus,
  sayNoSchemaFetched, sayOpenApiLane, sayResult, sayRuntimeEvidence, sayScreenAxisAndTemplates,
  sayVendoredWebRoots, sayWebBridge,
} from './census.mjs';
import {
  annotationLineage, assembleAll, nativeQueryLineage, readOpenApiDocs, runLanes,
  webWorkerStatsOf, whichLanesAssemble, wrapperFragmentLineage,
} from './lanes.mjs';
import { buildPack, runGate, updateRegistry, writeArtifacts } from './write.mjs';
import { analyzeTarget, incrementalPlan, laneSelection } from './inputs.mjs';

/**
 * EVERYTHING THIS RUN DECIDES BEFORE A WORKER STARTS, and the census that says
 * so. The order is the order a reader needs it in: which project, which tree,
 * which convention, which lanes, over what, and by what identity rule.
 */
function prepare(ctx) {
  const { die } = ctx;
  // Run the lanes end to end -> pack, one command. Every lane input is OPTIONAL:
  // what a flag does not name comes from the project's manifest + profile +
  // discovery, and a lane with no input is DECLARED missing rather than fatal
  // (SPEC §10.4 MUST — a partial pack, never a die()).
  // Where the pack goes is decided by the project resolver (SPEC §15 M1), not by
  // joining a literal onto cwd: --pack > --project (registry) > --root > cwd.
  const {
    resolved, out, root, profile, profileFile, diagnostics: profileFindings, manifest,
  } = analyzeTarget(ctx);
  const {
    flags, discovery, sel, ddls, ddl, snapshot, snapshotProvenance, snapshotSha256,
    mappers, javaSrc, webSrc, openapiFiles, harFiles, otelFiles, diagnostics: selected,
  } = laneSelection(ctx, { root, profile, resolved, diagnostics: profileFindings });
  const diagnostics = selected;

  sayNoSchemaFetched(profile, { ddls, snapshot, resolved, root });

  sayLaneLine({ sel, snapshot, snapshotProvenance, ddls, mappers, javaSrc, webSrc, openapiFiles, harFiles, otelFiles, root });
  sayMapperCensus({ sel, mappers, mapperFiles: listMapperXml(mappers, sel.mapperAlternatives ?? []) });

  sayVendoredWebRoots(profile, { sel, webSrc, resolved, root });

  // WHO THIS PACK IS, AND WHERE ITS CALLS GO. The two answers this run uses,
  // said on the run that uses them: the names go into the routes sidecar beside
  // the pack, and the routes rewrite a call's prefix before it is matched. The
  // name is the profile's when it declares one and THIS RUN's discovery
  // otherwise, and the line says which, because a name nobody recorded is one
  // that goes away the next time discovery reads a different tree.
  const serviceNames = serviceNamesOf(profile, discovery);
  const gatewayKeys = profile.gatewayRoutes && typeof profile.gatewayRoutes === 'object'
    ? Object.keys(profile.gatewayRoutes).sort() : [];
  sayIdentity(serviceNames, gatewayKeys);

  // THE SCREEN AXIS SWITCH, resolved once, here, and read nowhere else (I-5).
  // The third state needs the frontend packages this run will really read, which
  // is a filesystem question and so cannot live in the pure decision.
  const screenGate = screenAxisOf(profile, {
    webPackages: webPackagesRead(webSrc),
    templateRoots: sel.templateRoots,
  });
  sayScreenAxisAndTemplates(screenGate, { sel, webSrc, root });

  sayDdlChoice(sel);

  const pyRes = sqlPython();
  const py = pyRes.path;
  const A = path.join(ENGINE_ROOT, 'adapters', 'sql');
  const needPython = ddls.length > 0 || mappers.length > 0;
  if (needPython && !pyRes.ok) die(noSqlPython('this run reads SQL, so it', pyRes));
  const runpy = (script, args) => execFileSync(py, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
  const sqlArgs = sqlLaneArgs(profile);

  const { selectionRel, prevIndex, base, baseCommit, projectId, plan, store, relOf, absOf } = incrementalPlan(
    ctx, { root, out, profile, manifest, resolved, sel, ddls, snapshot, mappers, javaSrc, webSrc, sqlArgs },
  );
  return {
    resolved, out, root, profile, profileFile, manifest, diagnostics, flags, discovery, sel,
    ddls, ddl, snapshot, snapshotProvenance, snapshotSha256, mappers, javaSrc, webSrc,
    openapiFiles, harFiles, otelFiles, serviceNames, screenGate, py, runpy, sqlArgs,
    selectionRel, prevIndex, base, baseCommit, projectId, plan, store, relOf, absOf,
  };
}

/**
 * THE LANES, AND THE GRAPH THEY BECOME. Every worker this run invokes, the
 * three kinds of SQL that arrive from somewhere other than a mapper XML, the
 * documents read beside them, and the one seam where all of it is assembled.
 */
function factsOf(ctx, prepared, tmpDir) {
  const {
    root, profile, sel, ddls, snapshot, mappers, javaSrc, webSrc, py, runpy, sqlArgs,
    selectionRel, prevIndex, base, projectId, plan, store, relOf, absOf, diagnostics,
  } = prepared;
  const { result, runners } = runLanes(ctx, {
    root, tmpDir, plan, prevIndex, store, sel, selectionRel, ddls, snapshot, mappers, javaSrc, webSrc,
    sqlArgs, runpy, projectId, base, relOf, absOf, diagnostics,
  });
  const catalog = result.catalogRecords;
  let lineage = result.lineageRecords;
  const lanes = sel.lanes.slice();

  const annotationRecords = annotationLineage({
    javaSrc, result, store, prevIndex, catalog, sqlArgs, plan, py, runpy, runners, tmpDir, diagnostics,
  });
  if (annotationRecords.length > 0) {
    lineage = [...lineage, ...annotationRecords];
    if (!lanes.includes('sql')) lanes.push('sql');
  }
  lineage = [...lineage, ...nativeQueryLineage({
    javaSrc, result, store, prevIndex, catalog, sqlArgs, plan, py, runners, diagnostics,
  })];
  const { runJava, runJpa, runMp } = whichLanesAssemble(profile, result, javaSrc);
  const { mpOpts, fragmentLineage } = wrapperFragmentLineage({
    runMp, profile, sqlArgs, result, store, prevIndex, catalog, plan, py, runners, diagnostics,
  });
  return graphOf(ctx, prepared, {
    result, catalog, lineage, lanes, runJava, runJpa, runMp, mpOpts, fragmentLineage,
  });
}

/**
 * WHAT THE LANES SAID, TURNED INTO A GRAPH — and the census of every one of
 * them, in the order they ran. The axes are declared last, from the same
 * numbers the census printed.
 */
function graphOf(ctx, prepared, { result, catalog, lineage, lanes, runJava, runJpa, runMp, mpOpts, fragmentLineage }) {
  const {
    root, profile, discovery, sel, ddls, snapshot, mappers, javaSrc, webSrc,
    openapiFiles, harFiles, otelFiles, screenGate, sqlArgs, resolved, base, relOf, diagnostics, manifest,
  } = prepared;
  const openapiDocs = readOpenApiDocs(ctx, { openapiFiles, root, diagnostics });
  const { webFacts, webWorkerStats } = webWorkerStatsOf({ result, webSrc, sel, profile, resolved, root, relOf });
  const {
    graph: g, javaStats: jstats, jpaStats, mpStats, openapiStats, webStats: webBridgeStats,
    runtimeStats, otelTraces, webBridgeMs,
  } = assembleAll({
    result, webFacts, openapiDocs, otelFiles, webWorkerStats, profile, discovery, sqlArgs,
    screenGate, runJava, runJpa, mpOpts, fragmentLineage, catalog, lineage, relOf,
  });
  let laneStats = null;
  if (runJava) {
    laneStats = sayJavaLanes({ jstats, jpaStats, mpStats, runJpa, runMp });
  }
  // ---- the web BRIDGE's own line (RM28) ---------------------------------
  // What the frontend's calls turned into: how many reached a route this pack
  // serves, at which grade, how many did not and why, and the prefix each
  // client instance was read (or guessed) to have. The prefix is the number a
  // reader acts on: a wrong one turns every call in a package into a miss.
  let webStats = webWorkerStats;
  if (webWorkerStats && webBridgeStats) {
    webStats = { ...webWorkerStats, ...webBridgeStats };
    sayWebBridge(webBridgeStats, webBridgeMs);
  }

  // ---- the RECORDINGS (RM30 §E) ----------------------------------------
  // Read AFTER the web bridge, because a recorded path carries the FRONTEND
  // prefix and the prefix decisions are the web bridge's. Every edge it adds
  // is RUNTIME_ONLY: shown, never walked.
  let harStats = null;
  if (harFiles.length > 0) {
    const recordings = harFiles.map((f) => readHar(fs.readFileSync(f, 'utf8'), { file: relOf(f) }));
    harStats = addHarFacts(g, recordings, { prefix: webBridgeStats ? webBridgeStats.prefix : {} });
    sayHarLane(harStats);
  }

  sayRuntimeEvidence(runtimeStats, otelTraces);

  sayOpenApiLane(openapiStats);

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

  return {
    g, result, catalog, lineage, lanes, axes, laneStats, webStats, openapiStats, harStats, runtimeStats,
  };
}

/**
 * THE PACK, THE GATE THAT JUDGES IT, AND WHAT THAT LEAVES ON DISK. The gate
 * exits 3 from inside `writeArtifacts` on a regression, which is why this runs
 * inside the scratch directory's `try`.
 */
function certify(ctx, prepared, facts) {
  const {
    resolved, out, profile, profileFile, flags, ddl, ddls, snapshot, snapshotProvenance, snapshotSha256,
    mappers, webSrc, otelFiles, serviceNames, sqlArgs, selectionRel, base, baseCommit, projectId, plan,
    diagnostics, relOf,
  } = prepared;
  const { g, result, catalog, lineage, lanes, axes, laneStats, webStats, openapiStats, harStats, runtimeStats } = facts;
  const st = result.stats;
  const { pack, builtAt } = buildPack(g, {
    projectId, lanes, base, ddl, ddls, snapshot, snapshotProvenance, snapshotSha256, sqlArgs, axes,
    laneStats, webStats, openapiStats, harStats, runtimeStats, diagnostics, profileFile, st, baseCommit,
  });
  const {
    calibrated, verdict, red, gate, gateState, goldenSummaryDoc, overrideOf, enginePrintNow, pin, metrics,
    profileDigest, catalogDigest, baseline, stateDir, calibrationDir, baselineFile, gateStateFile, receiptFile,
  } = runGate(ctx, { g, pack, out, resolved, profile, lineage, catalog, laneStats, selectionRel, flags, base, builtAt });
  const { writeDir, writeIndexFile, routesIndex } = writeArtifacts({
    g, pack, result, out, red, calibrated, gate, verdict, gateState, overrideOf, enginePrintNow, pin, metrics,
    profileDigest, catalogDigest, baseline, profile, stateDir, calibrationDir, baselineFile, gateStateFile,
    receiptFile, builtAt, goldenSummaryDoc, projectId, serviceNames, otelFiles, relOf,
  });
  sayResult({ writeDir, writeIndexFile, pack, routesIndex, axes, lanes, st, plan, result, projectId, base, webSrc, mappers, ddls });
  updateRegistry(ctx, { resolved, out, lanes, builtAt });
}

export function run(ctx) {
  const prepared = prepare(ctx);
  // The scratch directory is registered with the exit sweeper BEFORE the work
  // starts: the calibration gate's RED path calls process.exit(3) from inside
  // this try, and process.exit does not run `finally`. The eager remove in the
  // finally keeps the normal path tidy; the handler catches every other exit.
  const tmpDir = SCRATCH.create(path.join(ENGINE_ROOT, '.analyze-'));
  try {
    certify(ctx, prepared, factsOf(ctx, prepared, tmpDir));
  } finally {
    SCRATCH.remove(tmpDir);
  }
  process.exit(0);
}
