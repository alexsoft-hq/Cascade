// analyze/write.mjs — what a certified run leaves behind.
//
// The pack, the gate that judges it, the fact index, the routes sidecar, the
// receipt and the registry entry. They are together because they all stamp the
// SAME moment and the SAME digest: a receipt that named a different build than
// the pack beside it would verify nothing, and a registry entry that pointed at
// a rejected pack would serve one.
//
// Everything that DECIDES is pure and lives in src/core/{calibration,receipt}.mjs;
// this is the filesystem those decisions are handed.

import fs from 'node:fs';
import path from 'node:path';
import {
  calibrationMetrics, pinOf, profileDigestOf, gateLine, gateStateOf, gateEvaluate, sealBaseline,
  validateBaseline, sqlLaneTallies,
} from '../../../core/calibration.mjs';
import { catalogDigestOf, serializeIndex } from '../../../core/facts_store.mjs';
import { checkCases, parseCases, inventoryOf, relationPopulations } from '../../../core/golden.mjs';
import { slugify } from '../../../core/init.mjs';
import { loadManifest } from '../../../core/manifest.mjs';
import { projectPack } from '../../../core/pack.mjs';
import { registryPath } from '../../../core/paths.mjs';
import { readRegistry, upsertProject, writeRegistryAtomic } from '../../../core/registry.mjs';
import { registrationTarget } from '../../../core/resolve.mjs';
import { buildRoutesIndex, serializeRoutesIndex, ROUTES_FILE } from '../../../mcp/federation.mjs';
import { engineIdentity, realPath } from '../../env.mjs';
import { externalSourcesOf } from '../../external_sources.mjs';
import { keepPreviousPack, pruneHistory, withPackLock, writeAtomic } from '../../pack_history.mjs';
import { workerVersions } from '../../../core/worker_versions.mjs';
import { goldenAsk } from '../../serve.mjs';
import { runningEnginePrint, sha256File, stateDirOf, writeReceipt } from '../../state.mjs';

/**
 * THE PACK, projected out of the graph with everything this run learned about
 * itself attached. `builtAt` is returned beside it because the gate, the
 * receipt and the registry all have to stamp the SAME moment.
 */
export function buildPack(g, { projectId, lanes, base, ddl, ddls, snapshot, snapshotProvenance, snapshotSha256, sqlArgs, axes, laneStats, webStats, openapiStats, harStats, runtimeStats, diagnostics, profileFile, st, baseCommit }) {
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
    return { pack, builtAt };
}

/**
 * THE CALIBRATION GATE (SPEC §14.2, §14.3, §15 M3).
 *
 * Everything that DECIDES is pure (src/core/calibration.mjs). This measures the
 * pack, fingerprints the engine and the analyzed target, asks the gate, and
 * hands back its verdict — the caller FAILS CLOSED on RED by writing the pack
 * to a `-rejected` directory and leaving the certified one where it was.
 *
 * A pack that does NOT land in the project's own `.cascade/` is a one-off build
 * (`--out /somewhere/else`, or a bare `--pack`): the same rule that stops it
 * registering in the home registry stops it here. It is not this project's
 * certified snapshot, so it neither re-seals the baseline nor is judged against
 * it — and it says so instead of quietly passing.
 */
/**
 * WHERE THIS PROJECT'S CERTIFIED STATE LIVES. A pack that does NOT land in the
 * project's own `.cascade/` is a one-off build (`--out /somewhere/else`, or a
 * bare `--pack`): the same rule that stops it registering in the home registry
 * stops it being certified here.
 */
export function stateFiles(resolved, out) {
  const calibrated = registrationTarget(resolved, out) !== null;
  const stateDir = stateDirOf(resolved, out);
  const calibrationDir = path.join(stateDir, 'calibration');
  return {
    calibrated,
    stateDir,
    calibrationDir,
    goldenDir: path.join(stateDir, 'golden'),
    baselineFile: path.join(calibrationDir, 'baseline.json'),
    gateStateFile: path.join(calibrationDir, 'gate-state.json'),
    receiptFile: path.join(stateDir, 'receipt.json'),
  };
}

/**
 * The project golden, scored through the SHIPPED tool catalog (SPEC §14.1) —
 * the same query surface an AI reaches over MCP, never a private walk. A corpus
 * that cannot be read is skipped out loud rather than counted as a pass.
 */
export function goldenSummaryOf({ goldenDir, g, pack, profile }) {
  const casesFile = path.join(goldenDir, 'cases.jsonl');
  if (!fs.existsSync(casesFile)) return null;
  try {
    const cases = parseCases(fs.readFileSync(casesFile, 'utf8'));
    if (cases.length === 0) return null;
    return checkCases(cases, {
      ask: goldenAsk(g, pack, profile),
      // How many inputs each relation HAS in this pack, so a corpus that covers
      // all of one is scored as the census it is rather than as a small sample.
      population: relationPopulations(inventoryOf(g)),
    }).summary;
  } catch (e) {
    process.stderr.write(`golden check skipped: ${e.message}\n`);
    return null;
  }
}

/**
 * THE CALIBRATION GATE (SPEC §14.2, §14.3, §15 M3).
 *
 * Everything that DECIDES is pure (src/core/calibration.mjs). This measures the
 * pack, fingerprints the engine and the analyzed target, asks the gate, and
 * hands back its verdict — the caller FAILS CLOSED on RED by writing the pack to
 * a `-rejected` directory and leaving the certified one where it was (§7.2 — a
 * failed run never mixes with the good snapshot).
 */
export function runGate({ flag, die }, { g, pack, out, resolved, profile, lineage, catalog, laneStats, selectionRel, flags, base, builtAt, evidenceFiles = [] }) {
  const { calibrated, stateDir, calibrationDir, goldenDir, baselineFile, gateStateFile, receiptFile } = stateFiles(resolved, out);

  const sqlStats = sqlLaneTallies(lineage);
  const metrics = calibrationMetrics(g, { laneStats, sqlStats });
  const profileDigest = profileDigestOf(profile);
  const catalogDigest = catalog.length > 0 ? catalogDigestOf(catalog) : null;
  const optOuts = [
    flags.noDdl ? '--no-ddl' : null,
    flags.noMappers ? '--no-mappers' : null,
    flags.noJava ? '--no-java' : null,
  ].filter(Boolean);
  const evidence = evidenceFiles.map(([kind, f]) => `${kind}:${sha256File(f)}`);
  const pin = pinOf({
    commit: base?.commit ?? null, dirty: base?.dirty === true,
    selection: selectionRel, optOuts, profileDigest, catalogDigest, evidence,
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
  const goldenSummaryDoc = goldenSummaryOf({ goldenDir, g, pack, profile });

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
    // The pack this verdict judged: a server counts a passing verdict only for it (src/core/trust.mjs).
    packDigest: pack.digest,
    pin,
    thresholds: gate.thresholds,
    ...(overrideOf ? { acceptedByHuman: true, overrideOf } : {}),
  },
});
pack.meta.calibration = {
  mode: gate.mode, verdict, baselineSealedAt: gate.baselineSealedAt,
  firstRun: profile.calibration?.firstRun ?? null,
};
// WHAT THIS PACK WAS ANALYZED UNDER (src/core/pack_diff.mjs). Two packs differ in
// the code only when these agree, so they are recorded where a later comparison
// can read them: the worker versions, the normalized profile's digest, the engine,
// the opt-out flags and the source roots. Metadata, so outside the digest.
pack.meta.analysis = analysisRecord({
  flags, selectionRel, optOuts, profileDigest, enginePrintNow, evidence, base,
  profileFile: pack.meta.profile, dotCascade: resolved.dotCascade, catalogMeta: pack.meta.catalog,
});

  return {
    calibrated, verdict, red, gate, gateState, goldenSummaryDoc, overrideOf, enginePrintNow, pin, metrics,
    profileDigest, catalogDigest, baseline, stateDir, calibrationDir, baselineFile, gateStateFile, receiptFile,
  };
}

/**
 * Keep the home registry current: this project now has a pack, built at
 * `builtAt`, over these lanes (SPEC §5). Only when the pack landed inside a
 * project's `.cascade/` — a bare --out elsewhere registers nothing.
 */
export function updateRegistry({ opt }, { resolved, out, lanes, builtAt }) {
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
}

/**
 * THE PACK AND ITS SIDECARS, on disk.
 *
 * A RED run's pack goes to a `-rejected` directory (§7.2 — a failed run never
 * mixes with the good snapshot). The ROUTE INDEX (RM44) is beside the pack and
 * never inside it: it says what this project SERVES and what it CALLS and does
 * not serve, so a server holding several projects can join one project's
 * outbound call to another's route without parsing a pack. It is DERIVED from
 * the graph, so it is not an input to the digest (I-9) — it carries the digest
 * of the pack it came from instead, and a server refuses an index that no longer
 * describes the pack beside it.
 *
 * THE TRACES JOIN THE FACT INDEX (I-9) first: every other input to a pack is
 * content-addressed and evidence must be too, so the index records the bytes of
 * each trace this run read. A changed trace is then a changed input rather than
 * a pack that quietly says something new.
 */
export function writePackAndIndex({ g, pack, result, out, red, calibrated, gateState, calibrationDir, gateStateFile, projectId, serviceNames, otelFiles, relOf, afterPack = null, lockDir = out }) {
  if (otelFiles.length > 0) {
    result.index.runtimeEvidence = {
      otel: otelFiles.map((f) => ({ path: relOf(f), sha256: sha256File(f) })),
    };
  }
  const writeDir = red ? `${out}-rejected` : out;
  const writeIndexFile = path.join(writeDir, 'facts-index.json');
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
  // The gate's verdict is written AFTER the pack it judges is published: a pack
  // that failed to publish must not leave its verdict on the pack still served.
  // A server that read the new pack before the verdict landed reads the project
  // again on its next request, because the verdict is part of what it watches.
  const writeVerdict = () => {
    if (!calibrated) return;
    fs.mkdirSync(calibrationDir, { recursive: true });
    writeAtomic(gateStateFile, JSON.stringify(gateState, null, 2) + '\n');
  };
  // One lock for the project's state whether the run is certified or rejected, and
  // whichever `--out` it writes: they share the gate verdict, the baseline, the
  // receipt and the pack history beside the pack directory.
  publishPack(writeDir, {
    pack, index: result.index, routes: serializeRoutesIndex(routesIndex), keep: calibrated && !red, lockDir,
    afterPack: () => { writeVerdict(); afterPack?.({ writeDir, writeIndexFile }); },
  });
  return { writeDir, writeIndexFile, routesIndex };
}

/**
 * A path as a comparison can use it: relative to the project root when it is
 * inside the REPOSITORY (`db/schema.sql`, or `../shared/src` for a folder beside
 * the project), because a checkout of the same repository elsewhere, a base
 * commit's worktree among them, has the same layout; real and absolute outside
 * the repository, where there is only one of it. Without a repository, the
 * project root is the boundary. `from` is what a relative `p` is relative to.
 */
export function portablePath(p, root, { repoTop = null, from = root } = {}) {
  const abs = realPath(path.resolve(from, p));
  const top = realPath(repoTop ?? root);
  const inRepo = abs === top || abs.startsWith(top + path.sep);
  return inRepo ? (path.relative(realPath(root), abs).split(path.sep).join('/') || '.') : abs;
}

/** The repository's top, from the project root and the folder the project sits in; null outside git. */
function repoTopOf(root, projectPath) {
  if (typeof projectPath !== 'string') return null;
  return path.resolve(root, ...projectPath.split('/').filter(Boolean).map(() => '..'));
}

/** Every path string in a selection, made portable; everything else as it is. */
function portableSelection(sel, root, opts) {
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v !== 'string' || NOT_PATHS.has(key)) return v;
    return portablePath(v, root, opts);
  };
  // The checkout's own root is where it sits, not how it was read; a NESTED `root`
  // (a template root) is a path like any other.
  const { root: _root, ...rest } = sel ?? {};
  return walk(rest, null);
}

const NOT_PATHS = new Set(['sqlArgs', 'packagePrefixes', 'engine', 'kind', 'suffix']);
/** Flags whose order the selection does not keep (it sorts them); `--ddl` order is the migration order. */
const UNORDERED_FLAGS = ['mappers', 'javaSrc', 'webSrc', 'openapi', 'har', 'otel'];

/**
 * WHAT THIS PACK WAS ANALYZED UNDER, recorded so two packs can be compared
 * (src/core/pack_diff.mjs) and a base commit can be analyzed the SAME way
 * (src/cli/base_commit.mjs): the workers, the profile's digest, the engine, the
 * opt-out flags, the source roots, the lane flags this run was given, which
 * profile file it read, and the content of every input that changes without a
 * commit (a database snapshot, a recording). Paths are portable: relative to the
 * project root inside it, so a checkout elsewhere records the same thing.
 */
export function analysisRecord({ flags, selectionRel, optOuts, profileDigest, enginePrintNow, evidence, base, profileFile, dotCascade, catalogMeta, cwd = process.cwd() }) {
  const root = base?.repoPath ?? selectionRel.root;
  const repoTop = repoTopOf(root, base?.projectPath);
  // A flag is relative to the shell it was typed in (src/core/lanes.mjs), not to the project.
  const list = (xs) => (xs ?? []).map((p) => portablePath(p, root, { repoTop, from: cwd }));
  const defaultProfile = dotCascade ? realPath(path.join(dotCascade, 'profile.json')) : null;
  // Sorted as the selection sorts them, and NOT de-duplicated, because the
  // selection is not: a replay of `--mappers src --mappers src` must select the same.
  const invocation = { ddl: list(flags.ddl) };
  for (const k of UNORDERED_FLAGS) invocation[k] = list(flags[k]).sort();
  const selection = portableSelection(selectionRel, root, { repoTop });
  return {
    workers: workerVersions(), profileDigest, enginePrint: enginePrintNow, engineVersion: engineIdentity().version,
    optOuts, selection,
    invocation: {
      ...invocation,
      noDdl: !!flags.noDdl, noMappers: !!flags.noMappers, noJava: !!flags.noJava, noWeb: !!flags.noWeb, noOpenapi: !!flags.noOpenapi,
      profile: profileFile && realPath(profileFile) !== defaultProfile ? portablePath(profileFile, root, { repoTop, from: cwd }) : null,
    },
    external: {
      catalogSnapshot: catalogMeta?.source === 'snapshot' ? catalogMeta.sha256 ?? null : null,
      evidence: [...evidence].sort(),
      sources: externalSourcesOf(invocation, selection),
    },
  };
}

/**
 * THE PACK, PUBLISHED. Under the project's write lock (in `lockDir`, the project's
 * pack directory, also for a rejected run written beside it): a certified run
 * keeps a copy of the pack it replaces (pack_history.mjs), then the sidecars are
 * renamed into place whole, and THE PACK LAST: its rename is the moment the new
 * build is published. Each sidecar names the digest of the pack it belongs to
 * (`packDigest`, `buildDigest`), so a sidecar that got ahead of its pack (a run
 * that died between the renames, a reader between them) is refused by its
 * reader instead of being read with the wrong pack. `afterPack` (the verdict, the
 * baseline, the receipt) runs after the pack and still under the lock. The
 * history is pruned after that, even when `afterPack` failed. A failure while
 * keeping or pruning is said and does not stop the publish.
 */
export function publishPack(writeDir, { pack, index, routes, keep, lockDir = writeDir, afterPack = null }) {
  // `lockDir: false` is a caller that already holds the project's lock.
  const locked = (fn) => (lockDir === false ? fn() : withPackLock(lockDir, fn));
  locked(() => {
    const warn = (what, e) => process.stderr.write(`pack history: could not ${what} (${e.message}); the pack is published all the same\n`);
    if (keep) { try { keepPreviousPack(writeDir, pack); } catch (e) { warn('keep the pack this run replaces', e); } }
    fs.mkdirSync(writeDir, { recursive: true });
    writeAtomic(path.join(writeDir, 'facts-index.json'), serializeIndex({ ...index, packDigest: pack.digest }));
    if (routes !== undefined) writeAtomic(path.join(writeDir, ROUTES_FILE), routes);
    writeAtomic(path.join(writeDir, 'pack.json'), JSON.stringify(pack));
    try {
      afterPack?.();
    } finally {
      if (keep) { try { pruneHistory(writeDir); } catch (e) { warn('prune the history', e); } }
    }
  });
}

/** The gate's verdict, its findings, and the golden score beside them. */
export function sayGate({ calibrated, gate, verdict, overrideOf, gateStateFile, goldenSummaryDoc }) {
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
}

/**
 * WHAT LANDS ON DISK once the gate has judged the run, in order: the gate's own
 * lines on stderr, then, under the project's lock, the pack and its sidecars, the
 * verdict, the re-sealed baseline on a run the gate let through, and the receipt.
 * A RED run stops here with exit 3, leaving the previously certified pack exactly
 * where it was.
 */
export function writeArtifacts({ g, pack, result, out, red, calibrated, gate, verdict, gateState, overrideOf, enginePrintNow, pin, metrics, profileDigest, catalogDigest, baseline, profile, stateDir, calibrationDir, baselineFile, gateStateFile, receiptFile, builtAt, goldenSummaryDoc, projectId, serviceNames, otelFiles, relOf, locked = false }) {
  sayGate({ calibrated, gate, verdict, overrideOf, gateStateFile, goldenSummaryDoc });
  const certify = red ? null : ({ writeDir, writeIndexFile }) => {
    // Seal (or re-seal) the baseline: the "previous certified run" moves forward
    // on every run the gate let through, so tomorrow's comparison is against
    // today, not against the first run this project ever did.
    if (calibrated && (gate.reseal || overrideOf)) {
      const sealed = sealBaseline({ sealedAt: builtAt, enginePrint: enginePrintNow, pin, profileDigest, catalogDigest, metrics });
      fs.writeFileSync(baselineFile, JSON.stringify(sealed, null, 2) + '\n');
      process.stderr.write(`baseline ${baseline ? 're-sealed' : 'sealed'} at ${baselineFile} (${Object.keys(metrics.ratios).length} ratios, ${Object.keys(metrics.counts).length} counts)\n`);
    }
    // The receipt (SPEC §14.4): what this certified run produced, hashed.
    if (calibrated) {
      const receipt = writeReceipt({ receiptFile, stateDir, builtAt, profile, print: enginePrintNow, pack, gateState, files: [path.join(writeDir, 'pack.json'), writeIndexFile, gateStateFile] });
      process.stderr.write(`receipt ${receiptFile}: expires ${receipt.expiresAt} (verify with \`cascade verify\`)\n`);
    }
  };
  const { writeDir, writeIndexFile, routesIndex } = writePackAndIndex({
    g, pack, result, out, red, calibrated, gateState, calibrationDir, gateStateFile,
    projectId, serviceNames, otelFiles, relOf, afterPack: certify, lockDir: lockDirFor({ locked, calibrated, stateDir, out }),
  });
  if (red && !locked) rejectRun({ writeDir, out });
  return { writeDir, writeIndexFile, routesIndex, rejected: red };
}

/**
 * Where the publish takes its lock: nowhere when the caller holds the project's
 * lock already, the project's state directory for a certified or rejected run
 * (they share the verdict, the baseline, the receipt and the history), and the
 * output directory of a one-off `--out` build. The analyze command decides the
 * same way when it takes the lock around the gate (index.mjs).
 */
export const lockDirFor = ({ locked = false, calibrated, stateDir, out }) => (locked ? false : calibrated ? stateDir : out);

/** A RED run's last word, and exit 3. Called once the project's lock is released. */
export function rejectRun({ writeDir, out }) {
  process.stderr.write(`REJECTED: the pack was written to ${path.join(writeDir, 'pack.json')} and the certified pack at ${path.join(out, 'pack.json')} was NOT touched\n`
    + '  a regression is not a new snapshot: fix it. If this drop is the intended new normal, re-run with `--accept-baseline`,\n'
    + '  which re-seals the baseline from THIS run. That is the only override, and it is a human decision.\n');
  process.exit(3);
}
