// calibration.mjs — the calibration layer, L3 (SPEC §14.2, §14.3, §15 M3).
//
// The problem this file exists for: an absolute quality threshold ("95% of
// statements must carry column facts") is a lie on somebody else's repository.
// It says nothing about whether THIS engine got better or worse; it only says
// whether this project happens to be shaped like the project the number was
// written for. So the gate here does not compare against a constant. It
// compares THIS RUN against THE PREVIOUS CERTIFIED RUN of the same project —
// a baseline sealed under `.cascade/calibration/` — and it first asks WHY the
// two differ, because "the engine changed" and "the analyzed target changed"
// deserve different verdicts (§14.2).
//
// Two fingerprints split those cases:
//
//   enginePrint  — sha256 over the engine's own sources. It moves when the
//                  ANALYZER changed.
//   pin          — {commit, dirty, inputsDigest}. It moves when the ANALYZED
//                  TARGET changed. `inputsDigest` is deliberately more than the
//                  commit: re-running the same commit over a different mapper
//                  set, a different DDL or a different reading convention is a
//                  different target, and calling that "nondeterminism" would
//                  cry wolf on a legitimate re-scope.
//
//   engine same + pin same  -> NO_CHANGE     (any metric difference is a real
//                                             determinism failure — I-9's little
//                                             brother, for free, every run)
//   engine moved, pin same  -> ENGINE_MOVED  (a drop is a REGRESSION: block)
//   engine same, pin moved  -> REPIN         (a drop can be the target shrinking:
//                                             allowed up to a wider threshold,
//                                             and every drop is still named)
//   both moved              -> BOTH_MOVED    (treated as strictly as ENGINE_MOVED:
//                                             two explanations are not an excuse)
//   no baseline             -> NO_SEAL       (bootstrap exemption, or RED)
//
// DIRECTION. "Drop" here means "loss of quality", not "smaller number". Most
// metrics are better when they are higher (statements with column facts), but a
// few are better when they are LOWER (statements whose schema is unknown, the
// lineage unresolved rate). Treating a fall in an unresolved rate as a
// regression would block exactly the improvements this engine is trying to
// make, so every metric declares its direction and the arithmetic follows it.
// The lower-is-better rates are scored in POINTS of the full scale rather than
// relatively — see `dropOf` for why a rate near zero cannot be judged the same
// way as a coverage ratio.
//
// Pure: graph + metadata in, plain objects out. `bin/cascade.mjs` does the
// filesystem work, the printing and the exit code.

import { sha256, canonicalJson } from './canonical.mjs';
import { measurePack, ratio } from './estimate.mjs';
import { NODE_KINDS } from './graph.mjs';

export const BASELINE_SCHEMA = 'cascade:calibration-baseline:1';
export const GATE_STATE_SCHEMA = 'cascade:golden-gate-state:1';
export const METRICS_SCHEMA = 'cascade:calibration-metrics:1';

/** The four moving-parts modes plus "there is nothing to compare with" (§14.2). */
export const GATE_MODES = Object.freeze(['NO_SEAL', 'NO_CHANGE', 'ENGINE_MOVED', 'REPIN', 'BOTH_MOVED']);

/** Verdicts. BOOTSTRAP is a GREEN that also seals the first baseline (§14.3). */
export const GATE_VERDICTS = Object.freeze(['BOOTSTRAP', 'GREEN', 'RED']);

/** Finding kinds, so a reader does not have to parse the reason prose. */
export const FINDING_KINDS = Object.freeze([
  'nondeterminism', 'regression', 'tolerated-drop', 'improvement',
  'unmeasurable', 'new-metric', 'missing-metric', 'no-baseline',
]);

/**
 * Which way is UP for each ratio. Anything not named here is `higher-better`,
 * including every count (a pack that lost nodes lost knowledge).
 */
export const LOWER_IS_BETTER = Object.freeze([
  'statementsWithStringSubst',
  'statementsWithUnknownSchema',
  'lineageUnresolvedColumns',
  'javaParseErrors',
]);

/** True when a smaller value of this metric is the better outcome. */
export function lowerIsBetter(metric) {
  return LOWER_IS_BETTER.includes(metric);
}

// ---------------------------------------------------------------------------
// 1. Metrics
// ---------------------------------------------------------------------------

/**
 * The SQL lane's own tallies, recomputed from the ASSEMBLED lineage records.
 *
 * The Python lane prints these on stderr as a run summary, which an incremental
 * run cannot reproduce (it only reruns the statements that changed). Counting
 * them here, over the records the pack was actually built from, makes the number
 * identical for a cold run and an incremental run of the same tree — which is
 * the whole point, because the gate compares the two.
 *
 * The reason set mirrors `_COLUMN_UNRESOLVED_REASONS` in adapters/sql/lineage.py:
 * a statement-scoped failure (a parse failure) is not a column reference and
 * must not inflate a COLUMN unresolved rate.
 *
 * @param {object[]} lineageRecords  `kind:'lineage'` records (others ignored)
 * @returns {{statements:number, tableFacts:number, columnFacts:number,
 *            unresolvedColumns:number, unresolvedJoins:number, joinFacts:number}}
 */
export function sqlLaneTallies(lineageRecords) {
  const COLUMN_UNRESOLVED = new Set([
    'unqualified_column', 'table_not_in_catalog', 'column_unknown_in_table', 'implicit_insert_columns',
  ]);
  const out = { statements: 0, tableFacts: 0, columnFacts: 0, unresolvedColumns: 0, unresolvedJoins: 0, joinFacts: 0 };
  for (const r of Array.isArray(lineageRecords) ? lineageRecords : []) {
    if (!r || r.kind !== 'lineage') continue;
    out.statements += 1;
    out.tableFacts += (r.tables ?? []).length;
    out.columnFacts += (r.columns ?? []).length;
    out.joinFacts += (r.joins ?? []).length;
    for (const u of r.unresolved ?? []) {
      if (COLUMN_UNRESOLVED.has(u && u.reason)) out.unresolvedColumns += 1;
    }
  }
  return out;
}

/**
 * Everything the gate compares, measured off one pack.
 *
 * Ratios come from `measurePack` (src/core/estimate.mjs) — the same arithmetic
 * `cascade estimate` prints, not a second copy of it — plus the two lane rates
 * the graph cannot carry. Counts are the census: nodes by kind, edges by
 * type/grade. A count is what catches "the run analyzed half the project"; a
 * ratio is what catches "the analyzer got worse at the same project".
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{laneStats?:Object, sqlStats?:Object, mode?:string, depth?:number}} [packMeta]
 * @returns {{schema:string, ratios:Object, counts:Object}}
 */
export function calibrationMetrics(graph, packMeta = {}) {
  if (!graph || !graph.nodes || !Array.isArray(graph.edges)) {
    throw new CalibrationError('calibrationMetrics requires a Graph');
  }
  const meta = packMeta && typeof packMeta === 'object' ? packMeta : {};
  const ratios = { ...measurePack(graph, { laneStats: meta.laneStats ?? null, mode: meta.mode, depth: meta.depth }) };

  // The lineage lane's unresolved COLUMN references, as a share of every column
  // reference it saw. `pct: null` when the pack records no SQL tallies at all —
  // unknown, never 0% (a silent 0 would read as "nothing was unresolved").
  const sql = meta.sqlStats && typeof meta.sqlStats === 'object' ? meta.sqlStats : null;
  ratios.lineageUnresolvedColumns = sql
    ? ratio(sql.unresolvedColumns ?? 0, (sql.columnFacts ?? 0) + (sql.unresolvedColumns ?? 0))
    : ratio(0, 0, 'this pack records no SQL lane tallies, so the lineage unresolved rate is UNKNOWN, not zero');

  // Java parse errors, as a share of the files the lane parsed — MEASURABLE
  // since javafacts/3. The worker emits one `parse_error` RECORD per file that
  // failed, so the count rides in that file's fact shard: an incremental run
  // that re-parsed three files and a cold run over the whole tree assemble the
  // same fact set and therefore report the same ratio, which is what the
  // NO_CHANGE gate needs (a per-invocation stderr tally would have differed and
  // read as nondeterminism). Both numbers come from `addJavaFacts` over the
  // ASSEMBLED facts; `pct: null` still means "this pack ran no Java lane".
  const ls = meta.laneStats && typeof meta.laneStats === 'object' ? meta.laneStats : null;
  ratios.javaParseErrors = ls && Number.isInteger(ls.parseErrors) && Number.isInteger(ls.parsedFiles)
    ? ratio(ls.parseErrors, ls.parsedFiles)
    : ratio(0, 0, 'this pack ran no Java lane, so the parse-error rate is UNKNOWN, not zero');

  const counts = {};
  const byKind = new Map();
  for (const n of graph.nodes.values()) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  for (const kind of NODE_KINDS) {
    if (byKind.has(kind)) counts[`node:${kind}`] = byKind.get(kind);
  }
  const byEdge = new Map();
  for (const e of graph.edges) {
    const key = `edge:${e.type}/${e.grade}`;
    byEdge.set(key, (byEdge.get(key) ?? 0) + 1);
  }
  for (const key of [...byEdge.keys()].sort()) counts[key] = byEdge.get(key);

  return { schema: METRICS_SCHEMA, ratios: sortKeys(ratios), counts: sortKeys(counts) };
}

// ---------------------------------------------------------------------------
// 2. Fingerprints
// ---------------------------------------------------------------------------

/** Which repository-relative files count as "the engine's own source". */
export function isEngineSourcePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  const p = rel.split('\\').join('/');
  if (p.startsWith('src/') && p.endsWith('.mjs')) return true;
  if (p.startsWith('bin/')) return true;
  if (p.startsWith('adapters/') && (p.endsWith('.java') || p.endsWith('.py'))) return true;
  return false;
}

/**
 * sha256 over the engine's own sources — the fingerprint that answers "did the
 * ANALYZER move?" (§14.2). The file listing is INJECTED because reading a
 * directory is impure; the CLI passes the real one, tests pass a fake.
 *
 * Nothing machine-specific enters the digest: only repository-relative paths and
 * content hashes, sorted by path. No absolute path, no mtime, no hostname —
 * otherwise the same engine would print differently on two machines and every
 * CI run would look like an engine change.
 *
 * @param {{files: {path:string, sha256?:string, bytes?:(Uint8Array|string)}[]}} input
 * @returns {string} 64-char hex
 */
export function enginePrint(input) {
  const files = input && Array.isArray(input.files) ? input.files : null;
  if (!files) throw new CalibrationError('enginePrint requires {files: [{path, sha256|bytes}]}');
  const rows = [];
  const seen = new Set();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || f.path.length === 0) {
      throw new CalibrationError('every engine source needs a repository-relative path');
    }
    const p = f.path.split('\\').join('/');
    if (p.startsWith('/') || p.includes('..')) {
      throw new CalibrationError(`engine source paths must be repository-relative, got ${JSON.stringify(f.path)}`);
    }
    if (seen.has(p)) throw new CalibrationError(`engine source listed twice: ${p}`);
    seen.add(p);
    const digest = typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)
      ? f.sha256
      : sha256(typeof f.bytes === 'string' ? f.bytes : Buffer.from(f.bytes ?? []).toString('utf8'));
    rows.push([p, digest]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(canonicalJson({ schema: 'cascade:engine-print:1', files: rows }));
}

/**
 * The pin: WHAT was analyzed, not merely which commit was checked out.
 *
 * A commit alone is not the target. Two runs of the same commit that read a
 * different mapper set, a different DDL, a different set of Java roots, or a
 * different reading convention analyzed different things, and the gate must
 * call that a REPIN rather than accusing the engine of nondeterminism.
 *
 * @param {{commit:(string|null), dirty:boolean,
 *          selection:{ddl:(string|null), mapperDirs:string[], javaRoots:string[], sqlArgs?:string[]},
 *          optOuts?:string[], profileDigest:string, catalogDigest:(string|null)}} input
 * @returns {{commit:(string|null), dirty:boolean, inputsDigest:string}}
 */
export function pinOf(input) {
  if (!input || typeof input !== 'object') throw new CalibrationError('pinOf requires an object');
  const sel = input.selection && typeof input.selection === 'object' ? input.selection : {};
  const inputsDigest = sha256(canonicalJson({
    schema: 'cascade:pin-inputs:1',
    ddl: sel.ddl ?? null,
    mapperDirs: [...(sel.mapperDirs ?? [])].sort(),
    javaRoots: [...(sel.javaRoots ?? [])].sort(),
    sqlArgs: [...(sel.sqlArgs ?? [])],
    optOuts: [...(input.optOuts ?? [])].sort(),
    profileDigest: input.profileDigest ?? null,
    catalogDigest: input.catalogDigest ?? null,
  }));
  return {
    commit: typeof input.commit === 'string' && input.commit.length > 0 ? input.commit : null,
    dirty: input.dirty === true,
    inputsDigest,
  };
}

/** sha256 of a normalized profile — one of the two halves of a target change. */
export function profileDigestOf(profile) {
  return sha256(canonicalJson(profile ?? null));
}

/** Whether two pins name the same analyzed target. */
export function samePin(a, b) {
  if (!a || !b) return false;
  return a.commit === b.commit && a.dirty === b.dirty && a.inputsDigest === b.inputsDigest;
}

// ---------------------------------------------------------------------------
// 3. Baseline / gate-state documents
// ---------------------------------------------------------------------------

/**
 * The document `.cascade/calibration/baseline.json` holds: the previous
 * CERTIFIED run, in full, so the next run can be compared with it without
 * re-analyzing anything.
 */
export function sealBaseline({ sealedAt, enginePrint: print, pin, profileDigest, catalogDigest, metrics }) {
  if (typeof print !== 'string' || print.length === 0) throw new CalibrationError('sealBaseline requires an enginePrint');
  if (!pin || typeof pin.inputsDigest !== 'string') throw new CalibrationError('sealBaseline requires a pin');
  if (!metrics || !metrics.ratios || !metrics.counts) throw new CalibrationError('sealBaseline requires metrics');
  return {
    schema: BASELINE_SCHEMA,
    sealedAt: sealedAt ?? null,
    enginePrint: print,
    pin: { commit: pin.commit ?? null, dirty: pin.dirty === true, inputsDigest: pin.inputsDigest },
    profileDigest: profileDigest ?? null,
    catalogDigest: catalogDigest ?? null,
    metrics: { schema: metrics.schema ?? METRICS_SCHEMA, ratios: sortKeys(metrics.ratios), counts: sortKeys(metrics.counts) },
  };
}

/** The document `.cascade/calibration/gate-state.json`. */
export function gateStateOf({ evaluatedAt, gate, baselineSealedAt, goldenSummary = null, extra = {} }) {
  if (!gate || !GATE_MODES.includes(gate.mode)) throw new CalibrationError('gateStateOf requires a gate result');
  return {
    schema: GATE_STATE_SCHEMA,
    evaluatedAt: evaluatedAt ?? null,
    mode: gate.mode,
    verdict: gate.verdict,
    findings: gate.findings,
    baselineSealedAt: baselineSealedAt ?? null,
    goldenSummary,
    ...extra,
  };
}

/** Validate a baseline read off disk. Fail closed on an unknown schema (§17.7). */
export function validateBaseline(doc) {
  if (!doc || typeof doc !== 'object') throw new CalibrationError('baseline must be an object');
  if (doc.schema !== BASELINE_SCHEMA) {
    throw new CalibrationError(`unknown baseline schema ${JSON.stringify(doc.schema)} (expected ${BASELINE_SCHEMA}). Re-seal with \`cascade analyze --accept-baseline\``);
  }
  if (typeof doc.enginePrint !== 'string' || !doc.pin || typeof doc.pin.inputsDigest !== 'string') {
    throw new CalibrationError('baseline is missing enginePrint or pin.inputsDigest');
  }
  if (!doc.metrics || !doc.metrics.ratios || !doc.metrics.counts) {
    throw new CalibrationError('baseline carries no metrics to compare against');
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 4. The gate
// ---------------------------------------------------------------------------

/**
 * Compare this run with the sealed baseline and return a mode + verdict +
 * findings (§14.2). PURE — no clock, no filesystem.
 *
 * @param {{baseline:(Object|null), current:{enginePrint:string, pin:Object,
 *          profileDigest?:string, catalogDigest?:string, metrics:Object},
 *          profile:Object}} input
 * @returns {{mode:string, verdict:string, findings:Object[], baselineSealedAt:(string|null),
 *            thresholds:{maxRelativeDrop:number, maxRelativeDropOnRepin:number}, reseal:boolean}}
 */
export function gateEvaluate(input = {}) {
  const { baseline = null, current, profile = {} } = input;
  if (!current || !current.metrics) throw new CalibrationError('gateEvaluate requires current.metrics');
  const cal = (profile && profile.calibration) || {};
  const maxRelativeDrop = numberOr(cal.maxRelativeDrop, 0.05);
  const maxRelativeDropOnRepin = numberOr(cal.maxRelativeDropOnRepin, 0.25);
  const thresholds = { maxRelativeDrop, maxRelativeDropOnRepin };

  // ---- mode ---------------------------------------------------------------
  if (!baseline) {
    const bootstrap = cal.firstRun !== 'require-baseline';
    const findings = [{
      kind: 'no-baseline', metric: 'baseline', baseline: null, current: null,
      relativeDrop: null, threshold: null,
      severity: bootstrap ? 'info' : 'error',
      reason: bootstrap
        ? 'no baseline was sealed for this project yet, so there is nothing to compare against. This run is exempt (profile calibration.firstRun is "bootstrap") and its measurements become the baseline'
        : 'no baseline and bootstrap is disabled (profile calibration.firstRun is "require-baseline"). Seal one deliberately with `cascade analyze --accept-baseline`, or set calibration.firstRun to "bootstrap"',
    }];
    return {
      mode: 'NO_SEAL', verdict: bootstrap ? 'BOOTSTRAP' : 'RED',
      findings, baselineSealedAt: null, thresholds, reseal: bootstrap,
    };
  }

  const engineSame = baseline.enginePrint === current.enginePrint;
  const pinSame = samePin(baseline.pin, current.pin);
  const mode = engineSame && pinSame ? 'NO_CHANGE'
    : engineSame ? 'REPIN'
      : pinSame ? 'ENGINE_MOVED' : 'BOTH_MOVED';

  const pairs = metricPairs(baseline.metrics, current.metrics);

  // ---- NO_CHANGE: a determinism check, for free, on every run -------------
  if (mode === 'NO_CHANGE') {
    const findings = [];
    for (const p of pairs) {
      if (p.same) continue;
      findings.push({
        kind: 'nondeterminism', metric: p.metric, baseline: p.baselineRaw, current: p.currentRaw,
        relativeDrop: p.drop, threshold: 0, severity: 'error',
        reason: `same engine and same pin, but ${p.metric} moved from ${describe(p.baselineRaw)} to ${describe(p.currentRaw)}`
          + (baseline.pin.dirty || current.pin.dirty
            ? '. The working tree was DIRTY on at least one of the two runs, so the bytes on disk may have changed under an unchanged pin; commit them and re-run to tell that apart from a real nondeterminism'
            : '. Identical inputs must produce identical measurements'),
      });
    }
    return {
      mode, verdict: findings.length > 0 ? 'RED' : 'GREEN',
      findings: sortFindings(findings), baselineSealedAt: baseline.sealedAt ?? null,
      thresholds, reseal: findings.length === 0,
    };
  }

  // ---- the three moved modes: relative-drop arithmetic --------------------
  const repin = mode === 'REPIN';
  const threshold = repin ? maxRelativeDropOnRepin : maxRelativeDrop;
  const findings = [];
  for (const p of pairs) {
    if (p.unmeasurable) {
      findings.push({
        kind: 'unmeasurable', metric: p.metric, baseline: p.baselineRaw, current: p.currentRaw,
        relativeDrop: null, threshold: null, severity: 'info',
        reason: p.unmeasurable,
      });
      continue;
    }
    if (p.missing) {
      findings.push({
        kind: p.missing, metric: p.metric, baseline: p.baselineRaw, current: p.currentRaw,
        relativeDrop: p.missing === 'missing-metric' ? 1 : null,
        threshold, severity: p.missing === 'missing-metric' ? 'error' : 'info',
        reason: p.missing === 'missing-metric'
          ? `${p.metric} was measured in the baseline (${describe(p.baselineRaw)}) and is absent from this run. A metric that vanished is a total loss, not an unchanged one`
          : `${p.metric} is new in this run (${describe(p.currentRaw)}); the baseline never measured it, so there is nothing to compare`,
      });
      continue;
    }
    if (p.drop == null || p.drop <= 0) {
      if (p.same) continue;
      findings.push({
        kind: 'improvement', metric: p.metric, baseline: p.baselineRaw, current: p.currentRaw,
        relativeDrop: p.drop, threshold, severity: 'info',
        reason: `${p.metric} improved from ${describe(p.baselineRaw)} to ${describe(p.currentRaw)}`,
      });
      continue;
    }
    const over = p.drop > threshold;
    findings.push({
      kind: over ? 'regression' : 'tolerated-drop',
      metric: p.metric, baseline: p.baselineRaw, current: p.currentRaw,
      relativeDrop: round4(p.drop), threshold,
      severity: over ? 'error' : 'warn',
      reason: `${p.metric} dropped ${pctText(p.drop)} (${describe(p.baselineRaw)} -> ${describe(p.currentRaw)})`
        + widerLook(p.baselineRaw, p.currentRaw)
        + (over
          ? `. That is over the ${pctText(threshold)} ${repin ? 'repin' : 'engine-change'} budget`
          : `. That is within the ${pctText(threshold)} ${repin ? 'repin' : 'engine-change'} budget, and it is named because a drop is never silent`),
    });
  }
  const red = findings.some((f) => f.severity === 'error');
  return {
    mode, verdict: red ? 'RED' : 'GREEN',
    findings: sortFindings(findings), baselineSealedAt: baseline.sealedAt ?? null,
    thresholds, reseal: !red,
  };
}

/**
 * One line a human reads on every run:
 *   `gate: ENGINE_MOVED -> RED - statementsWithColumnFacts dropped 12.4% (>5%)`
 */
export function gateLine(gate) {
  // Which single finding leads the line. An EDGE census is a symptom of a node
  // census — "3984 WRITES edges became 52" is what "906 statements became 33"
  // looks like downstream — so the headline names the cause and leaves the
  // symptoms to the findings list, which carries all of them either way.
  const lead = (severity) => {
    const of = gate.findings.filter((f) => f.severity === severity);
    return of.find((f) => !f.metric.startsWith('edge:')) ?? of[0] ?? null;
  };
  const worst = lead('error') ?? lead('warn') ?? null;
  const seal = gate.findings.find((f) => f.kind === 'no-baseline');
  const info = gate.findings.filter((f) => f.severity === 'info').length;
  const head = `gate: ${gate.mode} -> ${gate.verdict}`;
  if (!worst && !seal) {
    return `${head} - no metric dropped`
      + (info > 0 ? ` (${info} improvement/unmeasurable finding(s))` : '. Every metric matched the sealed baseline');
  }
  if (!worst) return sealLine(gate, head);
  if (worst.kind === 'no-baseline') {
    return `${head} - ${gate.verdict === 'RED'
      ? 'no baseline and bootstrap is disabled (calibration.firstRun is "require-baseline")'
      : "no baseline yet, so this run's measurements become it"}`;
  }
  if (worst.relativeDrop != null && worst.relativeDrop > 0 && worst.threshold != null) {
    return `${head} - ${worst.metric} dropped ${pctText(worst.relativeDrop)} (>${pctText(worst.threshold)})`;
  }
  return `${head} - ${worst.reason}`;
}

function sealLine(gate, head) {
  return `${head} - ${gate.verdict === 'RED'
    ? 'no baseline and bootstrap is disabled (calibration.firstRun is "require-baseline")'
    : "no baseline yet, so this run's measurements become it"}`;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Line the two measurement sets up, metric by metric, and work out the quality
 * drop for each. A ratio with `den === 0` on EITHER side is unmeasurable, never
 * 0% — "no statements at all" and "no statement has column facts" are different
 * facts and only one of them is a regression.
 */
function metricPairs(baseMetrics, curMetrics) {
  const out = [];
  const names = new Set([
    ...Object.keys(baseMetrics.ratios ?? {}), ...Object.keys(curMetrics.ratios ?? {}),
  ]);
  for (const metric of [...names].sort()) {
    const b = (baseMetrics.ratios ?? {})[metric];
    const c = (curMetrics.ratios ?? {})[metric];
    if (!b || !c) {
      out.push({ metric, baselineRaw: b ?? null, currentRaw: c ?? null, missing: b ? 'missing-metric' : 'new-metric', same: false, drop: null });
      continue;
    }
    const same = canonicalJson(b) === canonicalJson(c);
    if (b.den === 0 || c.den === 0 || b.pct == null || c.pct == null) {
      out.push({
        metric, baselineRaw: b, currentRaw: c, same,
        unmeasurable: b.den === 0 && c.den === 0
          ? `${metric} has nothing to divide by in either run (${b.num}/${b.den} then ${c.num}/${c.den}). It is skipped, not scored as 0%`
          : `${metric} is measurable in only one of the two runs (${b.num}/${b.den} then ${c.num}/${c.den}). It is skipped, not scored as 0%`,
        drop: null,
      });
      continue;
    }
    out.push({ metric, baselineRaw: b, currentRaw: c, same, drop: dropOf(metric, b.pct, c.pct) });
  }

  const countNames = new Set([
    ...Object.keys(baseMetrics.counts ?? {}), ...Object.keys(curMetrics.counts ?? {}),
  ]);
  for (const metric of [...countNames].sort()) {
    const b = (baseMetrics.counts ?? {})[metric];
    const c = (curMetrics.counts ?? {})[metric];
    if (b == null || c == null) {
      // A census row is absent when the count is zero, so a vanished row IS a
      // drop to zero — not an unmeasurable metric.
      const bv = b ?? 0;
      const cv = c ?? 0;
      out.push({ metric, baselineRaw: bv, currentRaw: cv, same: bv === cv, drop: dropOf(metric, bv, cv) });
      continue;
    }
    out.push({ metric, baselineRaw: b, currentRaw: c, same: b === c, drop: dropOf(metric, b, c) });
  }
  return out;
}

/**
 * The RELATIVE QUALITY DROP. Positive means "this run is worse". For a metric
 * whose smaller value is the better one, a rise is the drop.
 */
function dropOf(metric, baselineValue, currentValue) {
  const b = Number(baselineValue);
  const c = Number(currentValue);
  if (!Number.isFinite(b) || !Number.isFinite(c)) return null;
  if (lowerIsBetter(metric)) {
    // A lower-is-better metric is a RATE that lives near zero, and a relative
    // rise there is not commensurable with a coverage ratio's relative fall: a
    // rise from 0% has no relative size at all, and 1% -> 2% would read as a
    // catastrophic 100% while costing one point of quality. So these are
    // measured against the FULL SCALE — an unresolved rate going 0% -> 7.7% is
    // a 7.7-point rise, reported as 0.077, which still blows the 5% engine
    // budget while a one-point wobble does not.
    return (c - b) / 100;
  }
  if (b === 0) return c === 0 ? 0 : -1; // 0 -> anything is an improvement
  return (b - c) / b;
}

function sortFindings(findings) {
  const rank = { error: 0, warn: 1, info: 2 };
  return findings.slice().sort((a, b) => {
    const r = (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
    if (r !== 0) return r;
    const d = (b.relativeDrop ?? 0) - (a.relativeDrop ?? 0);
    if (d !== 0) return d;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });
}

/**
 * The one sentence a RATIO's drop cannot say for itself.
 *
 * A higher-is-better ratio can fall for two OPPOSITE reasons, and the percentage
 * alone does not distinguish them: the engine resolved fewer things (a real
 * regression), or it LOOKED AT MORE and the denominator grew faster than the
 * numerator (a wider lane — the numerator went UP). Both are drops; only the
 * first is bad news, and a reader deciding whether to `--accept-baseline`
 * deserves to be told which one they are looking at rather than working it out
 * from the four numbers themselves.
 */
function widerLook(before, after) {
  if (!isRatio(before) || !isRatio(after)) return '';
  if (!(after.num > before.num) || !(after.den > before.den)) return '';
  return `. Note: the numerator ROSE (${before.num} -> ${after.num}); the ratio fell only because the denominator grew faster`
    + ` (${before.den} -> ${after.den}), which is what a WIDER lane looks like, not a smaller answer`;
}

function isRatio(v) {
  return v !== null && typeof v === 'object' && Number.isFinite(v.num) && Number.isFinite(v.den);
}

function describe(v) {
  if (v == null) return 'absent';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && 'num' in v) return v.pct == null ? `${v.num}/${v.den} (no denominator)` : `${v.pct}% (${v.num}/${v.den})`;
  return JSON.stringify(v);
}

// Two decimals, trailing zeros trimmed. One decimal would print a 5.01% drop as
// "5%", right next to a "> 5%" budget it just broke — the one place where the
// rounding has to be finer than the eye needs.
function pctText(fraction) {
  return `${Math.round(Number(fraction) * 10000) / 100}%`;
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

function numberOr(v, dflt) {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

export class CalibrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalibrationError';
  }
}
