import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { measurePack } from '../src/core/estimate.mjs';
import { normalizeProfile } from '../src/core/profile.mjs';
import {
  calibrationMetrics, sqlLaneTallies, enginePrint, isEngineSourcePath, pinOf, samePin,
  profileDigestOf, sealBaseline, validateBaseline, gateEvaluate, gateLine, lowerIsBetter,
  BASELINE_SCHEMA, GATE_MODES, METRICS_SCHEMA, CalibrationError,
} from '../src/core/calibration.mjs';

// SPEC §14.2 / §15 M3. The gate compares this run against the PREVIOUS
// CERTIFIED run, and first asks which of the two moving parts moved. These
// tests pin down the arithmetic and the four modes, without a filesystem.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureGraph() {
  const catalog = [
    { kind: 'table', schema: null, table: 'shop_order', comment: null },
    { kind: 'column', schema: null, table: 'shop_order', column: 'id', type: 'INT' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'total', type: 'DECIMAL(10,2)' },
  ];
  const lineage = [
    {
      kind: 'lineage', namespace: 'com.example.OrderMapper', id: 'selectById', type: 'select',
      tables: [{ table: 'shop_order', access: 'read' }],
      columns: [{ table: 'shop_order', column: 'id', access: 'read' }, { table: 'shop_order', column: 'total', access: 'read' }],
      unresolved: [], file: 'OrderMapper.xml', line: 4,
    },
    {
      kind: 'lineage', namespace: 'com.example.OrderMapper', id: 'searchDynamic', type: 'select',
      tables: [{ table: 'shop_order', access: 'read' }], columns: [],
      unresolved: [{ reason: 'unqualified_column', detail: 'total' }, { reason: 'parse_failed', detail: 'x' }],
      hasStringSubst: true, file: 'OrderMapper.xml', line: 20,
    },
  ];
  return { catalog, lineage, graph: buildGraphFromSql(catalog, lineage) };
}

/** A metrics document with the given ratios (as pct) and counts. */
function metricsOf(ratios, counts) {
  const r = {};
  for (const [k, v] of Object.entries(ratios)) {
    r[k] = Array.isArray(v)
      ? { num: v[0], den: v[1], pct: v[1] === 0 ? null : Math.round((v[0] / v[1]) * 1000) / 10 }
      : v;
  }
  return { schema: 'cascade:calibration-metrics:1', ratios: r, counts: { ...counts } };
}

const PIN_A = pinOf({ commit: 'a'.repeat(40), dirty: false, selection: { ddl: 'schema.sql', mapperDirs: ['m'], javaRoots: ['j'] }, profileDigest: 'p', catalogDigest: 'c' });
const PIN_B = pinOf({ commit: 'b'.repeat(40), dirty: false, selection: { ddl: 'schema.sql', mapperDirs: ['m'], javaRoots: ['j'] }, profileDigest: 'p', catalogDigest: 'c' });

function baselineWith(print, pin, metrics) {
  return sealBaseline({ sealedAt: '2026-01-01T00:00:00.000Z', enginePrint: print, pin, profileDigest: 'p', catalogDigest: 'c', metrics });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

test('calibrationMetrics reuses estimate.mjs rather than re-deriving the ratios', () => {
  const { graph } = fixtureGraph();
  const m = calibrationMetrics(graph, {});
  const fromEstimate = measurePack(graph, { laneStats: null });
  for (const [name, r] of Object.entries(fromEstimate)) {
    assert.deepEqual(m.ratios[name], r, `${name} must be the value estimate.mjs computes, not a second copy`);
  }
});

test('calibrationMetrics counts nodes by kind and edges by type/grade', () => {
  const { graph } = fixtureGraph();
  const m = calibrationMetrics(graph, {});
  assert.equal(m.counts['node:table'], 1);
  assert.equal(m.counts['node:column'], 2);
  assert.equal(m.counts['node:statement'], 2);
  assert.equal(m.counts['edge:DECLARES/EXACT'], 2);
  assert.equal(m.counts['edge:READS/EXACT'], 2);
  assert.equal(m.counts['edge:EXECUTES/EXACT'], 2);
  // A kind with nothing in it is simply absent — and the gate reads a missing
  // count as zero, so a census row that vanishes is a drop, not a silence.
  assert.equal(Object.hasOwn(m.counts, 'node:endpoint'), false);
  // Deterministic key order (the baseline is a file that gets diffed).
  assert.deepEqual(Object.keys(m.counts), [...Object.keys(m.counts)].sort());
});

test('sqlLaneTallies counts only COLUMN-scoped unresolved reasons', () => {
  const { lineage } = fixtureGraph();
  const t = sqlLaneTallies(lineage);
  assert.equal(t.statements, 2);
  assert.equal(t.columnFacts, 2);
  // `parse_failed` is statement-scoped and must not inflate a COLUMN rate.
  assert.equal(t.unresolvedColumns, 1);
});

test('the lineage unresolved rate is measured, and UNKNOWN (not 0%) without lane tallies', () => {
  const { graph, lineage } = fixtureGraph();
  const withStats = calibrationMetrics(graph, { sqlStats: sqlLaneTallies(lineage) });
  assert.deepEqual(withStats.ratios.lineageUnresolvedColumns, { num: 1, den: 3, pct: 33.3 });
  const without = calibrationMetrics(graph, {});
  assert.equal(without.ratios.lineageUnresolvedColumns.pct, null);
  assert.match(without.ratios.lineageUnresolvedColumns.note, /UNKNOWN, not zero/);
  // Java parse errors: the worker does not record them per file, so the metric
  // says so instead of reporting a comforting zero.
  assert.equal(without.ratios.javaParseErrors.pct, null);
  assert.match(without.ratios.javaParseErrors.note, /UNKNOWN, not zero/);
  assert.deepEqual(
    calibrationMetrics(graph, { laneStats: { parseErrors: 2, parsedFiles: 50 } }).ratios.javaParseErrors,
    { num: 2, den: 50, pct: 4 },
  );
});

test('calibrationMetrics refuses anything that is not a Graph', () => {
  assert.throws(() => calibrationMetrics(null), (e) => e instanceof CalibrationError);
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

test('enginePrint depends on content and path, never on order, and never on an absolute path', () => {
  const files = [
    { path: 'src/core/graph.mjs', bytes: 'a' },
    { path: 'bin/cascade.mjs', bytes: 'b' },
    { path: 'adapters/sql/lineage.py', bytes: 'c' },
  ];
  const a = enginePrint({ files });
  const b = enginePrint({ files: [files[2], files[0], files[1]] });
  assert.equal(a, b, 'listing order must not change the fingerprint');
  assert.notEqual(a, enginePrint({ files: [{ ...files[0], bytes: 'a2' }, files[1], files[2]] }));
  assert.notEqual(a, enginePrint({ files: [{ path: 'src/core/other.mjs', bytes: 'a' }, files[1], files[2]] }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.throws(() => enginePrint({ files: [{ path: '/abs/src/x.mjs', bytes: 'a' }] }), (e) => e instanceof CalibrationError);
  assert.throws(() => enginePrint({ files: [files[0], files[0]] }), (e) => /listed twice/.test(e.message));
});

test('isEngineSourcePath picks the engine\'s own sources and nothing else', () => {
  for (const p of ['src/core/graph.mjs', 'bin/cascade.mjs', 'adapters/java/JavaFacts.java', 'adapters/sql/lineage.py']) {
    assert.equal(isEngineSourcePath(p), true, p);
  }
  for (const p of ['test/graph.test.mjs', 'viewer/index.html', 'src/core/notes.md', 'adapters/sql/requirements.txt', 'README.md', '']) {
    assert.equal(isEngineSourcePath(p), false, p);
  }
});

test('the pin is the analyzed TARGET, not just the commit', () => {
  const base = { commit: 'a'.repeat(40), dirty: false, profileDigest: 'p', catalogDigest: 'c' };
  const sel = { ddl: 'schema.sql', mapperDirs: ['a/m', 'b/m'], javaRoots: ['a/j'] };
  const p1 = pinOf({ ...base, selection: sel });
  assert.equal(samePin(p1, pinOf({ ...base, selection: { ...sel, mapperDirs: ['b/m', 'a/m'] } })), true,
    'the order the directories were listed in is not part of the target');
  // Same commit, fewer mapper directories: a DIFFERENT target, so REPIN.
  assert.equal(samePin(p1, pinOf({ ...base, selection: { ...sel, mapperDirs: ['a/m'] } })), false);
  assert.equal(samePin(p1, pinOf({ ...base, selection: sel, optOuts: ['--no-java'] })), false);
  assert.equal(samePin(p1, pinOf({ ...base, selection: sel, profileDigest: 'p2' })), false);
  assert.equal(samePin(p1, pinOf({ ...base, selection: sel, catalogDigest: 'c2' })), false);
  assert.equal(samePin(p1, pinOf({ ...base, commit: 'b'.repeat(40), selection: sel })), false);
  assert.equal(samePin(p1, pinOf({ ...base, dirty: true, selection: sel })), false);
});

test('profileDigestOf changes with the reading convention', () => {
  assert.notEqual(profileDigestOf(normalizeProfile({})), profileDigestOf(normalizeProfile({ packagePrefixes: ['com.example'] })));
  assert.equal(profileDigestOf(normalizeProfile({})), profileDigestOf(normalizeProfile({})));
});

test('validateBaseline refuses an unknown schema instead of guessing (§17.7)', () => {
  const good = baselineWith('e', PIN_A, metricsOf({}, { 'node:table': 1 }));
  assert.equal(good.schema, BASELINE_SCHEMA);
  assert.equal(validateBaseline(good), good);
  assert.throws(() => validateBaseline({ ...good, schema: 'cascade:calibration-baseline:2' }), (e) => /unknown baseline schema/.test(e.message));
  assert.throws(() => validateBaseline({ ...good, metrics: null }), (e) => /no metrics/.test(e.message));
});

// ---------------------------------------------------------------------------
// The five modes
// ---------------------------------------------------------------------------

test('NO_SEAL: bootstrap is exempt and seals; require-baseline is RED', () => {
  const current = { enginePrint: 'e1', pin: PIN_A, metrics: metricsOf({}, { 'node:table': 1 }) };
  const boot = gateEvaluate({ baseline: null, current, profile: normalizeProfile({}) });
  assert.equal(boot.mode, 'NO_SEAL');
  assert.equal(boot.verdict, 'BOOTSTRAP');
  assert.equal(boot.reseal, true);
  assert.equal(boot.findings[0].severity, 'info');
  assert.match(gateLine(boot), /NO_SEAL -> BOOTSTRAP/);

  const strict = gateEvaluate({ baseline: null, current, profile: normalizeProfile({ calibration: { firstRun: 'require-baseline' } }) });
  assert.equal(strict.verdict, 'RED');
  assert.equal(strict.reseal, false);
  assert.equal(strict.findings[0].severity, 'error');
  assert.match(strict.findings[0].reason, /no baseline and bootstrap is disabled/);
});

test('NO_CHANGE: identical fingerprints must produce identical metrics, or it is RED nondeterminism', () => {
  const m = metricsOf({ statementsWithColumnFacts: [9, 10] }, { 'node:statement': 10 });
  const baseline = baselineWith('e1', PIN_A, m);
  const same = gateEvaluate({ baseline, current: { enginePrint: 'e1', pin: PIN_A, metrics: m }, profile: normalizeProfile({}) });
  assert.equal(same.mode, 'NO_CHANGE');
  assert.equal(same.verdict, 'GREEN');
  assert.deepEqual(same.findings, []);
  assert.equal(same.reseal, true);

  const moved = metricsOf({ statementsWithColumnFacts: [9, 10] }, { 'node:statement': 11 });
  const drift = gateEvaluate({ baseline, current: { enginePrint: 'e1', pin: PIN_A, metrics: moved }, profile: normalizeProfile({}) });
  assert.equal(drift.mode, 'NO_CHANGE');
  assert.equal(drift.verdict, 'RED');
  assert.equal(drift.reseal, false);
  const f = drift.findings.find((x) => x.metric === 'node:statement');
  assert.equal(f.kind, 'nondeterminism');
  assert.equal(f.severity, 'error');
  assert.match(f.reason, /Identical inputs must produce identical measurements/);
  // A metric moving UP under identical inputs is just as wrong as one moving down.
  assert.ok(f.current > f.baseline);
});

test('NO_CHANGE names a dirty tree as the other explanation instead of only accusing the engine', () => {
  const dirtyPin = pinOf({ commit: 'a'.repeat(40), dirty: true, selection: { ddl: null, mapperDirs: [], javaRoots: [] }, profileDigest: 'p', catalogDigest: null });
  const baseline = baselineWith('e1', dirtyPin, metricsOf({}, { 'node:statement': 10 }));
  const g = gateEvaluate({ baseline, current: { enginePrint: 'e1', pin: dirtyPin, metrics: metricsOf({}, { 'node:statement': 9 }) }, profile: normalizeProfile({}) });
  assert.equal(g.verdict, 'RED');
  assert.match(g.findings[0].reason, /working tree was DIRTY/);
});

test('ENGINE_MOVED / REPIN / BOTH_MOVED are told apart by the two fingerprints', () => {
  const m = metricsOf({}, { 'node:statement': 10 });
  const baseline = baselineWith('e1', PIN_A, m);
  const modeOf = (print, pin) => gateEvaluate({ baseline, current: { enginePrint: print, pin, metrics: m }, profile: normalizeProfile({}) }).mode;
  assert.equal(modeOf('e1', PIN_A), 'NO_CHANGE');
  assert.equal(modeOf('e2', PIN_A), 'ENGINE_MOVED');
  assert.equal(modeOf('e1', PIN_B), 'REPIN');
  assert.equal(modeOf('e2', PIN_B), 'BOTH_MOVED');
  assert.deepEqual([...GATE_MODES].sort(), ['BOTH_MOVED', 'ENGINE_MOVED', 'NO_CHANGE', 'NO_SEAL', 'REPIN']);
});

// ---------------------------------------------------------------------------
// The relative-drop arithmetic
// ---------------------------------------------------------------------------

test('ENGINE_MOVED: exactly 5% passes, 5.01% fails', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({}, { 'node:statement': 10000 }));
  const at = (count) => gateEvaluate({
    baseline,
    current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({}, { 'node:statement': count }) },
    profile: normalizeProfile({}),
  });

  const ok = at(9500);
  assert.equal(ok.verdict, 'GREEN', 'a drop of exactly the budget is not OVER the budget');
  const tolerated = ok.findings.find((f) => f.metric === 'node:statement');
  assert.equal(tolerated.kind, 'tolerated-drop');
  assert.equal(tolerated.severity, 'warn');
  assert.equal(tolerated.relativeDrop, 0.05);
  assert.match(tolerated.reason, /within the 5% engine-change budget, and it is named/);

  const bad = at(9499);
  assert.equal(bad.verdict, 'RED');
  const regression = bad.findings.find((f) => f.metric === 'node:statement');
  assert.equal(regression.kind, 'regression');
  assert.equal(regression.severity, 'error');
  assert.equal(regression.relativeDrop, 0.0501);
  assert.match(gateLine(bad), /^gate: ENGINE_MOVED -> RED - node:statement dropped 5\.01% \(>5%\)$/);
});

test('REPIN gets the wider budget, and every drop under it is still named as a warning', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({}, { 'node:statement': 1000 }));
  const at = (count) => gateEvaluate({
    baseline, current: { enginePrint: 'e1', pin: PIN_B, metrics: metricsOf({}, { 'node:statement': count }) },
    profile: normalizeProfile({}),
  });
  const ok = at(800); // a 20% drop: over the engine budget, inside the repin one
  assert.equal(ok.mode, 'REPIN');
  assert.equal(ok.verdict, 'GREEN');
  assert.equal(ok.findings[0].severity, 'warn');
  assert.match(ok.findings[0].reason, /within the 25% repin budget/);
  assert.equal(at(749).verdict, 'RED');
  assert.equal(at(750).verdict, 'GREEN');
});

test('the thresholds come from the profile, not from a constant in the gate', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({}, { 'node:statement': 100 }));
  const current = { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({}, { 'node:statement': 90 }) };
  assert.equal(gateEvaluate({ baseline, current, profile: normalizeProfile({}) }).verdict, 'RED');
  assert.equal(gateEvaluate({ baseline, current, profile: normalizeProfile({ calibration: { maxRelativeDrop: 0.2 } }) }).verdict, 'GREEN');
});

test('improvements are info findings and never fail a run', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({ statementsWithColumnFacts: [5, 10] }, { 'node:statement': 10 }));
  const g = gateEvaluate({
    baseline,
    current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ statementsWithColumnFacts: [10, 10] }, { 'node:statement': 20 }) },
    profile: normalizeProfile({}),
  });
  assert.equal(g.verdict, 'GREEN');
  for (const f of g.findings) assert.equal(f.severity, 'info');
  assert.equal(g.findings.find((f) => f.metric === 'statementsWithColumnFacts').kind, 'improvement');
  assert.match(gateLine(g), /no metric dropped/);
});

test('a ratio with no denominator is skipped with an info finding, never scored as 0%', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({ mapperMethodsBound: [0, 0], statementsWithColumnFacts: [8, 10] }, {}));
  const g = gateEvaluate({
    baseline,
    current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ mapperMethodsBound: [0, 0], statementsWithColumnFacts: [8, 10] }, {}) },
    profile: normalizeProfile({}),
  });
  assert.equal(g.verdict, 'GREEN');
  const f = g.findings.find((x) => x.metric === 'mapperMethodsBound');
  assert.equal(f.kind, 'unmeasurable');
  assert.equal(f.severity, 'info');
  assert.equal(f.relativeDrop, null);
  assert.match(f.reason, /skipped, not scored as 0%/);

  // Measurable on one side only: still skipped, still not a 100% drop.
  const half = gateEvaluate({
    baseline,
    current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ mapperMethodsBound: [5, 10], statementsWithColumnFacts: [8, 10] }, {}) },
    profile: normalizeProfile({}),
  });
  assert.equal(half.verdict, 'GREEN');
  assert.equal(half.findings.find((x) => x.metric === 'mapperMethodsBound').kind, 'unmeasurable');
});

test('a metric that vanishes is a total loss; a brand-new metric is not a drop', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({ gone: [8, 10] }, {}));
  const g = gateEvaluate({
    baseline, current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ fresh: [1, 10] }, {}) },
    profile: normalizeProfile({}),
  });
  assert.equal(g.verdict, 'RED');
  assert.equal(g.findings.find((f) => f.metric === 'gone').kind, 'missing-metric');
  assert.equal(g.findings.find((f) => f.metric === 'fresh').kind, 'new-metric');
  assert.equal(g.findings.find((f) => f.metric === 'fresh').severity, 'info');
});

test('a lower-is-better rate regresses when it RISES, and is scored in points of the full scale', () => {
  assert.equal(lowerIsBetter('lineageUnresolvedColumns'), true);
  assert.equal(lowerIsBetter('statementsWithColumnFacts'), false);
  const baseline = baselineWith('e1', PIN_A, metricsOf({ lineageUnresolvedColumns: [0, 100] }, {}));
  const worse = gateEvaluate({
    baseline, current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ lineageUnresolvedColumns: [8, 100] }, {}) },
    profile: normalizeProfile({}),
  });
  assert.equal(worse.verdict, 'RED', '0% -> 8% unresolved is 8 points, over the 5% budget');
  assert.equal(worse.findings[0].metric, 'lineageUnresolvedColumns');
  assert.equal(worse.findings[0].relativeDrop, 0.08);

  const better = gateEvaluate({
    baseline: baselineWith('e1', PIN_A, metricsOf({ lineageUnresolvedColumns: [20, 100] }, {})),
    current: { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ lineageUnresolvedColumns: [5, 100] }, {}) },
    profile: normalizeProfile({}),
  });
  assert.equal(better.verdict, 'GREEN', 'fixing unresolved columns must never be reported as a regression');
  assert.equal(better.findings[0].kind, 'improvement');
});

test('gateEvaluate is pure and deterministic', () => {
  const baseline = baselineWith('e1', PIN_A, metricsOf({ a: [1, 2] }, { 'node:statement': 10 }));
  const current = { enginePrint: 'e2', pin: PIN_A, metrics: metricsOf({ a: [1, 4] }, { 'node:statement': 5 }) };
  const one = gateEvaluate({ baseline, current, profile: normalizeProfile({}) });
  const two = gateEvaluate({ baseline, current, profile: normalizeProfile({}) });
  assert.deepEqual(one, two);
  assert.throws(() => gateEvaluate({ baseline, current: {} }), (e) => e instanceof CalibrationError);
});

// ---------------------------------------------------------------------------
// a ratio can fall for two OPPOSITE reasons (RM9b)
// ---------------------------------------------------------------------------

test('a higher-is-better ratio whose NUMERATOR rose says so — a wider lane is not a smaller answer', () => {
  const metrics = (num, den) => ({
    schema: METRICS_SCHEMA,
    ratios: { callsResolved: { num, den, pct: Math.round((num / den) * 1000) / 10 } },
    counts: {},
  });
  const baseline = sealBaseline({
    sealedAt: '2026-08-01T00:00:00.000Z', enginePrint: 'a'.repeat(64),
    pin: { commit: 'x', dirty: false, inputsDigest: 'd' },
    profileDigest: 'p', catalogDigest: 'c', metrics: metrics(684, 1431),
  });
  const gate = gateEvaluate({
    baseline,
    current: {
      enginePrint: 'b'.repeat(64), pin: { commit: 'x', dirty: false, inputsDigest: 'd' },
      profileDigest: 'p', catalogDigest: 'c', metrics: metrics(1129, 10185),
    },
    profile: normalizeProfile({}),
  });
  const f = gate.findings.find((x) => x.metric === 'callsResolved');
  assert.equal(f.kind, 'regression');
  assert.match(f.reason, /the numerator ROSE \(684 -> 1129\)/);
  assert.match(f.reason, /denominator grew faster \(1431 -> 10185\)/);
  assert.match(f.reason, /over the 5% engine-change budget/);
});

test('a ratio whose numerator actually FELL gets no wider-lane excuse', () => {
  const metrics = (num, den) => ({
    schema: METRICS_SCHEMA,
    ratios: { callsResolved: { num, den, pct: Math.round((num / den) * 1000) / 10 } },
    counts: {},
  });
  const baseline = sealBaseline({
    sealedAt: '2026-08-01T00:00:00.000Z', enginePrint: 'a'.repeat(64),
    pin: { commit: 'x', dirty: false, inputsDigest: 'd' },
    profileDigest: 'p', catalogDigest: 'c', metrics: metrics(900, 1000),
  });
  const gate = gateEvaluate({
    baseline,
    current: {
      enginePrint: 'b'.repeat(64), pin: { commit: 'x', dirty: false, inputsDigest: 'd' },
      profileDigest: 'p', catalogDigest: 'c', metrics: metrics(500, 1000),
    },
    profile: normalizeProfile({}),
  });
  const f = gate.findings.find((x) => x.metric === 'callsResolved');
  assert.equal(f.kind, 'regression');
  assert.equal(/numerator ROSE/.test(f.reason), false, 'a real regression must not be dressed up');
});
