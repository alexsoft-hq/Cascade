import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { normalizeProfile } from '../src/core/profile.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import {
  calibrationMetrics, sqlLaneTallies, pinOf, sealBaseline, gateEvaluate, gateStateOf,
} from '../src/core/calibration.mjs';
import { buildReceipt, verifyReceipt } from '../src/core/receipt.mjs';
import { computeTrust, TRUST_LEVELS } from '../src/core/trust.mjs';
import {
  caseId, approveCases, checkCases, expectationHash, GOLDEN_CASE_SCHEMA,
} from '../src/core/golden.mjs';

// SPEC §16.1, the "tamper / adversarial" row: does the gate actually go red when
// something is corrupted? A gate that has never been shown to fail is decoration.
// Every test here asserts the SPECIFIC finding it expects — "not green" would
// pass for the wrong reason just as happily.

const PROFILE = normalizeProfile({});
const SELECTION = { ddl: 'schema.sql', mapperDirs: ['src/main/resources/mapper'], javaRoots: ['src/main/java'], sqlArgs: ['--dialect', 'mysql'] };
const PIN = pinOf({ commit: 'c'.repeat(40), dirty: false, selection: SELECTION, profileDigest: 'p', catalogDigest: 'cat' });
const ENGINE_1 = 'e'.repeat(64);
const ENGINE_2 = 'f'.repeat(64);

// ---------------------------------------------------------------------------
// A synthetic pack, built twice through the real bridges
// ---------------------------------------------------------------------------

function catalogRecords() {
  return [
    { kind: 'table', schema: null, table: 'shop_order', comment: 'orders' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'id', type: 'INT' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'total', type: 'DECIMAL(10,2)' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'state', type: 'INT' },
  ];
}

/** Four statements, three of which carry column facts. */
function lineageRecords() {
  const withCols = (id, cols) => ({
    kind: 'lineage', namespace: 'com.example.OrderMapper', id, type: 'select',
    tables: [{ table: 'shop_order', access: 'read' }],
    columns: cols.map((c) => ({ table: 'shop_order', column: c, access: 'read' })),
    unresolved: [], file: 'OrderMapper.xml', line: 10,
  });
  return [
    withCols('selectById', ['id', 'total']),
    withCols('selectByState', ['id', 'state']),
    withCols('selectTotals', ['total']),
    {
      kind: 'lineage', namespace: 'com.example.OrderMapper', id: 'searchDynamic', type: 'select',
      tables: [{ table: 'shop_order', access: 'read' }], columns: [],
      unresolved: [{ reason: 'unqualified_column', detail: 'total' }],
      hasStringSubst: true, file: 'OrderMapper.xml', line: 40,
    },
  ];
}

function packOf(lineage) {
  const catalog = catalogRecords();
  const g = buildGraphFromSql(catalog, lineage);
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.example.OrderMapper', package: 'com.example', typeKind: 'interface', annotations: ['Mapper'] },
    { kind: 'method', fqn: 'com.example.OrderMapper#selectById', owner: 'com.example.OrderMapper', line: 4 },
  ], { packagePrefixes: ['com.example'] });
  const metrics = calibrationMetrics(g, { laneStats: stats, sqlStats: sqlLaneTallies(lineage) });
  const pack = projectPack(g, { project: 'com.example.shop', builtAt: '2026-01-01T00:00:00.000Z' });
  return { graph: g, pack, metrics };
}

// ---------------------------------------------------------------------------
// (a) facts quietly disappear
// ---------------------------------------------------------------------------

test('tamper (a1): half the lineage dropped under an UNCHANGED engine and pin is RED nondeterminism', () => {
  const run1 = packOf(lineageRecords());
  const run2 = packOf(lineageRecords().slice(2)); // two of the four statements vanish
  const baseline = sealBaseline({
    sealedAt: '2026-01-01T00:00:00.000Z', enginePrint: ENGINE_1, pin: PIN,
    profileDigest: 'p', catalogDigest: 'cat', metrics: run1.metrics,
  });

  const gate = gateEvaluate({
    baseline,
    current: { enginePrint: ENGINE_1, pin: PIN, metrics: run2.metrics },
    profile: PROFILE,
  });

  // Same engine, same target: there is no legitimate explanation for a
  // difference, so this is NOT an "engine moved" story.
  assert.equal(gate.mode, 'NO_CHANGE');
  assert.equal(gate.verdict, 'RED');
  assert.equal(gate.reseal, false, 'a RED run must not move the baseline forward');
  const stmt = gate.findings.find((f) => f.metric === 'node:statement');
  assert.ok(stmt, 'the vanished statements must be named');
  assert.equal(stmt.kind, 'nondeterminism');
  assert.equal(stmt.severity, 'error');
  assert.equal(stmt.baseline, 4);
  assert.equal(stmt.current, 2);
  assert.match(stmt.reason, /Identical inputs must produce identical measurements/);
  assert.equal(gate.findings.every((f) => f.kind === 'nondeterminism'), true,
    'under NO_CHANGE every difference is nondeterminism — nothing is filed as an acceptable drop');
});

test('tamper (a2): the same fact loss under a MOVED engine print is a RED regression naming statementsWithColumnFacts', () => {
  const run1 = packOf(lineageRecords());
  const run2 = packOf(lineageRecords().slice(2));
  const baseline = sealBaseline({
    sealedAt: '2026-01-01T00:00:00.000Z', enginePrint: ENGINE_1, pin: PIN,
    profileDigest: 'p', catalogDigest: 'cat', metrics: run1.metrics,
  });
  const gate = gateEvaluate({
    baseline,
    current: { enginePrint: ENGINE_2, pin: PIN, metrics: run2.metrics },
    profile: PROFILE,
  });

  assert.equal(gate.mode, 'ENGINE_MOVED');
  assert.equal(gate.verdict, 'RED');
  const f = gate.findings.find((x) => x.metric === 'statementsWithColumnFacts');
  assert.ok(f, 'statementsWithColumnFacts must be among the findings');
  assert.equal(f.kind, 'regression');
  assert.equal(f.severity, 'error');
  assert.equal(f.baseline.pct, 75); // 3 of 4 statements carried column facts
  assert.equal(f.current.pct, 50); // 1 of the 2 that are left
  assert.ok(f.relativeDrop > 0.05, `relativeDrop ${f.relativeDrop} must exceed the 5% engine budget`);
  assert.match(f.reason, /over the 5% engine-change budget/);
});

// ---------------------------------------------------------------------------
// (b)-(d) the receipt, on disk
// ---------------------------------------------------------------------------

const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** A certified project directory: pack, fact index, gate state, receipt. */
function certifiedProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-tamper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'pack'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'calibration'), { recursive: true });

  const run = packOf(lineageRecords());
  const gate = gateEvaluate({ baseline: null, current: { enginePrint: ENGINE_1, pin: PIN, metrics: run.metrics }, profile: PROFILE });
  const gateState = gateStateOf({ evaluatedAt: '2026-01-01T00:00:00.000Z', gate, baselineSealedAt: null, goldenSummary: null });

  const files = {
    'pack/pack.json': JSON.stringify(run.pack),
    'pack/facts-index.json': JSON.stringify({ schema: 'cascade:facts-index:1', files: {}, statements: {} }),
    'calibration/gate-state.json': JSON.stringify(gateState, null, 2) + '\n',
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

  const receipt = buildReceipt({
    builtAt: new Date().toISOString(), ttlDays: 30, enginePrint: ENGINE_1,
    pack: { digest: run.pack.digest, project: 'com.example.shop' },
    gate: { mode: gateState.mode, verdict: gateState.verdict, evaluatedAt: gateState.evaluatedAt },
    files: Object.keys(files).map((name) => ({ name, sha256: sha256File(path.join(dir, name)) })),
  });
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return { dir, pack: run.pack };
}

/** What `cascade verify` does: recompute everything from the bytes on disk. */
function verifyDir(dir, now = new Date().toISOString()) {
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  const names = ['pack/pack.json', 'pack/facts-index.json', 'calibration/gate-state.json'];
  const files = {};
  for (const name of names) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) files[name] = sha256File(abs);
  }
  const gsPath = path.join(dir, 'calibration', 'gate-state.json');
  const gateState = fs.existsSync(gsPath) ? JSON.parse(fs.readFileSync(gsPath, 'utf8')) : null;
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'pack', 'pack.json'), 'utf8'));
  return verifyReceipt({
    receipt,
    actual: { files, enginePrint: ENGINE_1, gateState, packContentDigest: digest12({ nodes: p.nodes, edges: p.edges }), now },
  });
}

test('a project that was never touched verifies', (t) => {
  const { dir } = certifiedProject(t);
  const r = verifyDir(dir);
  assert.equal(r.ok, true, JSON.stringify(r.disagreements, null, 2));
  assert.ok(r.checked >= 5, 'every claim in the receipt is checked, not a sample');
});

test('tamper (b): editing gate-state.json to say GREEN is caught by its digest', (t) => {
  const { dir } = certifiedProject(t);
  const file = path.join(dir, 'calibration', 'gate-state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.verdict = 'GREEN';
  state.findings = [];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');

  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  const hit = r.disagreements.find((d) => d.check === 'file:calibration/gate-state.json');
  assert.ok(hit, `expected a gate-state digest mismatch, got ${JSON.stringify(r.disagreements)}`);
  assert.match(hit.reason, /has changed since the receipt was written/);
  assert.notEqual(hit.expected, hit.found);
});

test('tamper (b1): an edit that leaves the verdict word alone is caught by the digest ALONE', (t) => {
  const { dir } = certifiedProject(t);
  const file = path.join(dir, 'calibration', 'gate-state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The verdict still reads the same; only the evidence under it is deleted.
  // Nothing but the recorded digest can notice that.
  state.findings = [];
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');

  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.disagreements.find((d) => d.check === 'file:calibration/gate-state.json'));
  assert.equal(r.disagreements.some((d) => d.check === 'gate-verdict'), false,
    'the verdict word is unchanged, so only the digest can catch this — which is the point of recording it');
  assert.equal(r.disagreements.length, 1);
});

test('tamper (b2): editing the PACK is caught by both its byte digest and its content digest', (t) => {
  const { dir } = certifiedProject(t);
  const file = path.join(dir, 'pack', 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  pack.nodes = pack.nodes.filter((n) => n.kind !== 'statement');
  fs.writeFileSync(file, JSON.stringify(pack));

  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.disagreements.find((d) => d.check === 'file:pack/pack.json'));
  const content = r.disagreements.find((d) => d.check === 'pack-content-digest');
  assert.ok(content, 'the pack digest recomputed from its own nodes and edges must disagree too');
  assert.match(content.reason, /recomputed from its own nodes and edges/);
});

test('tamper (c): editing the RECEIPT to a green verdict is caught by the cross-check, not by a digest', (t) => {
  const { dir } = certifiedProject(t);
  // The last run went red; the gate state says so.
  const gsFile = path.join(dir, 'calibration', 'gate-state.json');
  const state = JSON.parse(fs.readFileSync(gsFile, 'utf8'));
  state.verdict = 'RED';
  fs.writeFileSync(gsFile, JSON.stringify(state, null, 2) + '\n');
  // …so the forger rewrites the receipt instead: new verdict, and the gate-state
  // digest updated so the file check passes. Only the CROSS-CHECK is left.
  const rFile = path.join(dir, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(rFile, 'utf8'));
  receipt.gate.verdict = 'GREEN';
  receipt.files = receipt.files.map((f) => (f.name === 'calibration/gate-state.json'
    ? { ...f, sha256: sha256File(gsFile) } : f));
  fs.writeFileSync(rFile, JSON.stringify(receipt, null, 2) + '\n');

  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  assert.equal(r.disagreements.some((d) => d.check.startsWith('file:')), false,
    'every file digest was patched up — the point of this test is that digests alone are not enough');
  const cross = r.disagreements.find((d) => d.check === 'gate-verdict');
  assert.ok(cross, `expected the receipt/gate-state cross-check to disagree, got ${JSON.stringify(r.disagreements)}`);
  assert.equal(cross.expected, 'GREEN');
  assert.equal(cross.found, 'RED');
  const red = r.disagreements.find((d) => d.check === 'gate-red');
  assert.ok(red, 'and the RED run itself is reported, whatever the receipt claims');
});

test('tamper (d): an expired receipt is refused, fail-closed', (t) => {
  const { dir } = certifiedProject(t);
  const rFile = path.join(dir, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(rFile, 'utf8'));
  receipt.expiresAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(rFile, JSON.stringify(receipt, null, 2) + '\n');

  const r = verifyDir(dir, '2026-06-01T00:00:00.000Z');
  assert.equal(r.ok, false);
  const hit = r.disagreements.find((d) => d.check === 'expiry');
  assert.ok(hit, `expected an expiry refusal, got ${JSON.stringify(r.disagreements)}`);
  assert.match(hit.reason, /expired at 2020-01-01/);
});

test('a missing file is a disagreement, never a skipped check', (t) => {
  const { dir } = certifiedProject(t);
  fs.rmSync(path.join(dir, 'pack', 'facts-index.json'));
  const r = verifyDir(dir);
  assert.equal(r.ok, false);
  const hit = r.disagreements.find((d) => d.check === 'file:pack/facts-index.json');
  assert.match(hit.reason, /never "verified" on partial evidence/);
});

test('a receipt written by a different engine build is refused', (t) => {
  const { dir } = certifiedProject(t);
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  const files = {};
  for (const name of ['pack/pack.json', 'pack/facts-index.json', 'calibration/gate-state.json']) {
    files[name] = sha256File(path.join(dir, name));
  }
  const gateState = JSON.parse(fs.readFileSync(path.join(dir, 'calibration', 'gate-state.json'), 'utf8'));
  const r = verifyReceipt({ receipt, actual: { files, enginePrint: ENGINE_2, gateState, now: new Date().toISOString() } });
  assert.equal(r.ok, false);
  const hit = r.disagreements.find((d) => d.check === 'engine-print');
  assert.equal(hit.expected, ENGINE_1);
  assert.equal(hit.found, ENGINE_2);
});

// ---------------------------------------------------------------------------
// (e) a flipped golden label
// ---------------------------------------------------------------------------

/** 40 columns, each read by its own statement, mapper method, handler and route. */
function wideGraph(n = 40) {
  const catalog = [{ kind: 'table', schema: null, table: 'shop_order', comment: null }];
  const lineage = [];
  const javaFacts = [];
  for (let i = 0; i < n; i += 1) {
    catalog.push({ kind: 'column', schema: null, table: 'shop_order', column: `c${i}`, type: 'INT' });
    lineage.push({
      kind: 'lineage', namespace: `com.example.M${i}`, id: 'sel', type: 'select',
      tables: [{ table: 'shop_order', access: 'read' }],
      columns: [{ table: 'shop_order', column: `c${i}`, access: 'read' }],
      unresolved: [], file: `M${i}.xml`, line: 3,
    });
    javaFacts.push(
      { kind: 'type', fqn: `com.example.M${i}`, package: 'com.example', typeKind: 'interface', annotations: ['Mapper'] },
      { kind: 'type', fqn: `com.example.C${i}`, package: 'com.example', typeKind: 'class' },
      { kind: 'method', fqn: `com.example.M${i}#sel`, owner: `com.example.M${i}`, line: 3 },
      { kind: 'method', fqn: `com.example.C${i}#get`, owner: `com.example.C${i}`, line: 9 },
      { kind: 'endpoint', httpMethod: 'GET', path: `/r${i}`, handler: `com.example.C${i}#get`, line: 9 },
      { kind: 'call', from: `com.example.C${i}#get`, method: 'sel', toTypeSimple: `M${i}` },
    );
  }
  const g = buildGraphFromSql(catalog, lineage);
  addJavaFacts(g, javaFacts, { packagePrefixes: ['com.example'] });
  return g;
}

function askOf(graph) {
  const ctx = {
    graph,
    basis: { project: 'wide', buildDigest: 'abcdef123456', builtAt: '2026-01-01T00:00:00.000Z', freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
  };
  return (name, args) => callTool(name, args, ctx);
}

test('tamper (e): one flipped golden expectation fails that case and drops trust to GOLDEN_FAIL', () => {
  // 80 cases: enough that a FLAWLESS corpus clears this relation's §2.2 targets
  // (0.90 recall needs 35, 0.95 precision needs 73), and small enough that one
  // wrong label really does sink the bound. Both halves are asserted.
  const N = 80;
  const g = wideGraph(N);
  const ask = askOf(g);
  const approvedAt = '2026-02-02T00:00:00.000Z';
  const proposals = [];
  for (let i = 0; i < N; i += 1) {
    const input = { column: `shop_order.c${i}` };
    proposals.push({
      schema: GOLDEN_CASE_SCHEMA,
      id: caseId({ relation: 'column->endpoints', input }),
      relation: 'column->endpoints',
      input,
      expect: { present: [`GET /r${i}`], absent: [`GET /r${(i + 1) % N}`] },
      proposed: true,
      approvedAt: null,
    });
  }
  const cases = approveCases(proposals, { all: true, approvedAt }).approved;

  const clean = checkCases(cases, { ask });
  const cleanRel = clean.summary.relations['column->endpoints'];
  assert.equal(cleanRel.n, N);
  assert.equal(cleanRel.recallHits, N);
  assert.equal(cleanRel.precisionHits, N);
  assert.equal(cleanRel.status, 'PASS', `${N} flawless cases clear this relation's §2.2 targets`);
  const cleanTrust = computeTrust({ gateState: { verdict: 'GREEN' }, golden: { approvedCases: N, summary: clean.summary } });
  assert.notEqual(cleanTrust.trustLevel, TRUST_LEVELS[1]);

  // Now somebody edits ONE approved case to forbid an endpoint the engine does
  // return — a label that is simply wrong.
  const flipped = cases.map((c, i) => (i === 7
    ? { ...c, expect: { present: c.expect.present, absent: [...c.expect.present] } }
    : c));
  const broken = checkCases(flipped, { ask });
  const row = broken.results.find((r) => r.id === flipped[7].id);
  assert.equal(row.status, 'FAIL');
  assert.equal(row.precisionHit, false);
  assert.deepEqual(row.forbidden, flipped[7].expect.present);
  const rel = broken.summary.relations['column->endpoints'];
  assert.equal(rel.n, N);
  assert.equal(rel.precisionHits, N - 1);
  assert.equal(rel.status, 'FAIL');
  assert.ok(rel.precision.lowerBound < rel.precision.target,
    `${rel.precision.lowerBound} must sit below the ${rel.precision.target} target`);
  assert.equal(rel.precision.perfect, false, 'this is a real error, not a small-sample shortfall');

  const trust = computeTrust({ gateState: { verdict: 'GREEN' }, golden: { approvedCases: N, summary: broken.summary } });
  assert.equal(trust.trustLevel, TRUST_LEVELS[1], 'GOLDEN_FAIL');
  assert.equal(trust.basis.wilson['column->endpoints'].status, 'FAIL');
  assert.equal(trust.basis.goldenCases, N);
});

test('tamper (e2): a sealed case cannot be passed by trimming its probe list', () => {
  const g = wideGraph(4);
  const ask = askOf(g);
  const input = { column: 'shop_order.c1' };
  const expect = { present: ['GET /r1'], absent: ['GET /r2'] };
  const sealed = {
    schema: GOLDEN_CASE_SCHEMA,
    id: caseId({ relation: 'column->endpoints', input }),
    relation: 'column->endpoints',
    input,
    sealed: true,
    probes: [...expect.present, ...expect.absent].sort(),
    expectHash: expectationHash(expect),
    approvedAt: '2026-02-02T00:00:00.000Z',
  };
  assert.equal(checkCases([sealed], { ask }).results[0].status, 'PASS');

  // The hash was taken over BOTH lists, so dropping the negative from the probe
  // list cannot reproduce it: a sealed case cannot be made easier in place.
  const trimmed = { ...sealed, probes: expect.present.slice() };
  const r = checkCases([trimmed], { ask }).results[0];
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /labels stay hidden/);
});
