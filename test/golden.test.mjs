import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import {
  wilsonLowerBound, caseId, isHeldOut, expectationHash, sealCases, answerFor,
  proposeCases, approveCases, checkCases, goldenSummary, inventoryOf, relationPopulations,
  serializeCases, parseCases, seededOrder,
  RELATIONS, RELATION_TARGETS, RUNTIME_ANCHOR_RELATION, MIN_CASES, WILSON_Z,
  GOLDEN_CASE_SCHEMA, GoldenError,
} from '../src/core/golden.mjs';

// SPEC §14.1. The project golden is the only evidence that says anything about
// THIS repository, so the rules that keep it honest — the tool never approves
// itself, a case carries a negative as well as a positive, and a machine decides
// which cases are held out — are tested here, not documented.

// ---------------------------------------------------------------------------
// A small end-to-end pack: two endpoints -> services -> mapper methods ->
// statements -> tables/columns, so all four relations have real answers.
// ---------------------------------------------------------------------------

function fixture() {
  const catalog = [
    { kind: 'table', schema: null, table: 'shop_order', comment: 'orders' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'id', type: 'INT' },
    { kind: 'column', schema: null, table: 'shop_order', column: 'total', type: 'DECIMAL(10,2)' },
    { kind: 'table', schema: null, table: 'shop_item', comment: 'items' },
    { kind: 'column', schema: null, table: 'shop_item', column: 'id', type: 'INT' },
    { kind: 'column', schema: null, table: 'shop_item', column: 'name', type: 'VARCHAR(80)' },
  ];
  const lineage = [
    {
      kind: 'lineage', namespace: 'com.example.OrderMapper', id: 'selectById', type: 'select',
      tables: [{ table: 'shop_order', access: 'read' }],
      columns: [{ table: 'shop_order', column: 'id', access: 'read' }, { table: 'shop_order', column: 'total', access: 'read' }],
      unresolved: [], file: 'OrderMapper.xml', line: 4,
    },
    {
      kind: 'lineage', namespace: 'com.example.ItemMapper', id: 'selectAll', type: 'select',
      tables: [{ table: 'shop_item', access: 'read' }],
      columns: [{ table: 'shop_item', column: 'id', access: 'read' }, { table: 'shop_item', column: 'name', access: 'read' }],
      unresolved: [], file: 'ItemMapper.xml', line: 6,
    },
  ];
  const g = buildGraphFromSql(catalog, lineage);
  const javaFacts = [
    { kind: 'type', fqn: 'com.example.OrderController', package: 'com.example', typeKind: 'class', file: 'OrderController.java' },
    { kind: 'type', fqn: 'com.example.ItemController', package: 'com.example', typeKind: 'class', file: 'ItemController.java' },
    { kind: 'type', fqn: 'com.example.OrderMapper', package: 'com.example', typeKind: 'interface', annotations: ['Mapper'], file: 'OrderMapper.java' },
    { kind: 'type', fqn: 'com.example.ItemMapper', package: 'com.example', typeKind: 'interface', annotations: ['Mapper'], file: 'ItemMapper.java' },
    { kind: 'method', fqn: 'com.example.OrderController#get', owner: 'com.example.OrderController', line: 10 },
    { kind: 'method', fqn: 'com.example.ItemController#list', owner: 'com.example.ItemController', line: 12 },
    { kind: 'method', fqn: 'com.example.OrderMapper#selectById', owner: 'com.example.OrderMapper', line: 4 },
    { kind: 'method', fqn: 'com.example.ItemMapper#selectAll', owner: 'com.example.ItemMapper', line: 4 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/{id}', handler: 'com.example.OrderController#get', line: 10 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/item/list', handler: 'com.example.ItemController#list', line: 12 },
    { kind: 'call', from: 'com.example.OrderController#get', method: 'selectById', toTypeSimple: 'OrderMapper' },
    { kind: 'call', from: 'com.example.ItemController#list', method: 'selectAll', toTypeSimple: 'ItemMapper' },
  ];
  addJavaFacts(g, javaFacts, { packagePrefixes: ['com.example'] });
  return g;
}

function askOf(graph) {
  const ctx = {
    graph,
    basis: { project: 'fixture', buildDigest: 'digest12', builtAt: '2026-01-01T00:00:00.000Z', freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
  };
  return (name, args) => callTool(name, args, ctx);
}

// ---------------------------------------------------------------------------
// Wilson
// ---------------------------------------------------------------------------

test('wilsonLowerBound against values that can be checked by hand', () => {
  // For k === n the interval collapses to n / (n + z^2) — derived, not copied,
  // so this is an independent check of the implementation. The two decimal
  // constants below are what THAT identity (and the full formula at z = 1.96)
  // produce; they are recomputed here rather than quoted from memory.
  const closed = (n) => n / (n + WILSON_Z * WILSON_Z);
  assert.ok(Math.abs(wilsonLowerBound(30, 30) - closed(30)) < 1e-12);
  assert.ok(Math.abs(wilsonLowerBound(30, 30) - 0.8864829) < 1e-6, `30/30 is ${wilsonLowerBound(30, 30)}`);
  assert.ok(Math.abs(wilsonLowerBound(100, 100) - closed(100)) < 1e-12);
  assert.ok(Math.abs(wilsonLowerBound(28, 30) - 0.7867618) < 1e-6, `28/30 is ${wilsonLowerBound(28, 30)}`);
  assert.ok(Math.abs(wilsonLowerBound(0, 30) - 0) < 1e-12, 'the bound is clamped at 0, never negative');
  assert.equal(wilsonLowerBound(0, 0), null, 'an empty sample has no bound — null, never 0');
  assert.throws(() => wilsonLowerBound(31, 30), (e) => e instanceof GoldenError);
  // The bound is always below the point estimate: that is the whole point of
  // judging on it rather than on k/n.
  for (const [k, n] of [[9, 10], [95, 100], [970, 1000]]) {
    assert.ok(wilsonLowerBound(k, n) < k / n, `${k}/${n}`);
  }
});

test('30 flawless cases cannot demonstrate any §2.2 target — the summary says how many would', () => {
  const results = RELATIONS.flatMap((relation) => Array.from({ length: 30 }, (_, i) => (
    { id: `${relation}-${i}`, relation, status: 'PASS', recallHit: true, precisionHit: true }
  )));
  const s = goldenSummary(results);
  assert.equal(s.status, 'INSUFFICIENT_SAMPLE');
  for (const rel of RELATIONS) {
    assert.equal(s.relations[rel].status, 'INSUFFICIENT_SAMPLE', rel);
    assert.equal(s.relations[rel].recall.perfect, true);
    assert.equal(s.relations[rel].recall.meets, false);
    assert.ok(s.relations[rel].recall.nForTarget > MIN_CASES);
  }
  // The published targets, with the corpus size each one needs.
  assert.equal(s.relations['column->endpoints'].recall.nForTarget, 35); // 0.90
  assert.equal(s.relations['endpoint->tables'].recall.nForTarget, 73); // 0.95
  assert.equal(s.relations['method->statements'].precision.nForTarget, 381); // 0.99
  assert.equal(s.relations['statement->columns'].precision.target, null, 'SPEC §2.2 sets no precision target for this row');
});

test('a corpus that is big enough AND flawless passes', () => {
  const results = RELATIONS.flatMap((relation) => Array.from({ length: 400 }, (_, i) => (
    { id: `${relation}-${i}`, relation, status: 'PASS', recallHit: true, precisionHit: true }
  )));
  const s = goldenSummary(results);
  assert.equal(s.status, 'PASS');
  assert.equal(computeTrust({ gateState: { verdict: 'GREEN' }, golden: { approvedCases: 1600, summary: s } }).trustLevel, 'GOLDEN_PASS');
});

// ---------------------------------------------------------------------------
// Identity and sealing
// ---------------------------------------------------------------------------

test('caseId is content-addressed and stable', () => {
  const a = caseId({ relation: 'column->endpoints', input: { column: 'shop_order.total' } });
  assert.equal(a, caseId({ relation: 'column->endpoints', input: { column: 'shop_order.total' } }));
  assert.notEqual(a, caseId({ relation: 'endpoint->tables', input: { column: 'shop_order.total' } }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.throws(() => caseId({ relation: 'nope', input: {} }), (e) => e instanceof GoldenError);
});

test('sealing is decided by the id hash, is deterministic, and hides the labels', () => {
  const cases = Array.from({ length: 200 }, (_, i) => ({
    schema: GOLDEN_CASE_SCHEMA, id: caseId({ relation: 'column->endpoints', input: { column: `t.c${i}` } }),
    relation: 'column->endpoints', input: { column: `t.c${i}` },
    expect: { present: [`GET /a${i}`], absent: [`GET /b${i}`] }, approvedAt: '2026-01-01T00:00:00.000Z',
  }));
  const one = sealCases(cases);
  const two = sealCases(cases);
  assert.deepEqual(one.cases, two.cases, 'sealing the same corpus twice must produce the same bytes');
  assert.equal(one.sealed, cases.filter((c) => isHeldOut(c.id)).length);
  // ~20% of 200; loose bounds, because the point is that a HASH chose them.
  assert.ok(one.sealed > 20 && one.sealed < 60, `sealed ${one.sealed} of 200`);
  const sealed = one.cases.find((c) => c.sealed === true);
  assert.equal(Object.hasOwn(sealed, 'expect'), false, 'a sealed case must not carry its labels');
  assert.ok(Array.isArray(sealed.probes) && sealed.probes.length === 2, 'the ids in play stay visible; which side they are on does not');
  assert.match(sealed.expectHash, /^[0-9a-f]{64}$/);
  // Sealing again is idempotent.
  assert.deepEqual(sealCases(one.cases).cases, one.cases);
});

test('the held-out share cannot be chosen by hand — it is a function of the id alone', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
  const held = ids.filter(isHeldOut).length;
  assert.ok(held > 150 && held < 250, `${held} of 1000 held out — expected roughly 51/256`);
  for (const id of ids.slice(0, 20)) assert.equal(isHeldOut(id), isHeldOut(id));
});

// ---------------------------------------------------------------------------
// Asking the engine
// ---------------------------------------------------------------------------

test('every relation is answered through the SHIPPED tool catalog', () => {
  const g = fixture();
  const ask = askOf(g);
  assert.deepEqual(answerFor('column->endpoints', { column: 'shop_order.total' }, ask).ids, ['GET /order/{id}']);
  assert.deepEqual(answerFor('endpoint->tables', { endpoint: 'GET /order/{id}' }, ask).ids, ['shop_order']);
  assert.deepEqual(answerFor('statement->columns', { statement: 'com.example.OrderMapper.selectById' }, ask).ids,
    ['shop_order.id', 'shop_order.total']);
  assert.deepEqual(answerFor('method->statements', { symbol: 'com.example.OrderMapper#selectById' }, ask).ids,
    ['com.example.OrderMapper.selectById']);
  assert.throws(() => answerFor('nope', {}, ask), (e) => e instanceof GoldenError);
});

// ---------------------------------------------------------------------------
// Propose / approve
// ---------------------------------------------------------------------------

test('propose builds positive AND negative expectations, and never approves them', () => {
  const g = fixture();
  const { cases, perRelation } = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'abc123', perRelation: 5 });
  assert.ok(cases.length > 0);
  for (const c of cases) {
    assert.equal(c.schema, GOLDEN_CASE_SCHEMA);
    assert.equal(c.proposed, true, 'every proposal must say it is one');
    assert.equal(c.approvedAt, null, 'the tool must not approve its own proposals (SPEC §14.1)');
    assert.ok(c.expect.present.length > 0, 'a case with no positive proves nothing');
    assert.ok(c.expect.absent.length > 0, 'SPEC §14.1 MUST: positive and negative are kept as a pair');
    for (const a of c.expect.absent) assert.equal(c.expect.present.includes(a), false);
  }
  assert.ok(perRelation['method->statements'].proposed > 0);
});

test('proposing twice from the same pack proposes exactly the same cases', () => {
  const g = fixture();
  const a = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'seed-1', perRelation: 4 });
  const b = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'seed-1', perRelation: 4 });
  assert.deepEqual(a.cases, b.cases);
  const other = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'seed-2', perRelation: 4 });
  assert.deepEqual(other.cases.map((c) => c.id).sort(), a.cases.map((c) => c.id).sort(),
    'the fixture is small enough that every candidate is taken; the seed changes the ORDER, not the universe');
  assert.notDeepEqual(seededOrder(['a', 'b', 'c', 'd'], 's1'), seededOrder(['a', 'b', 'c', 'd'], 's2'));
  assert.throws(() => proposeCases({ inventory: inventoryOf(g), ask: askOf(g) }), (e) => /pack digest/.test(e.message));
});

test('approve is the only thing that stamps approvedAt, and it needs a human to name the cases', () => {
  const g = fixture();
  const { cases } = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'abc123', perRelation: 5 });
  assert.throws(() => approveCases(cases, { approvedAt: 'now' }), (e) => /never approves by itself/.test(e.message));
  const one = approveCases(cases, { ids: [cases[0].id], approvedAt: '2026-02-02T00:00:00.000Z' });
  assert.equal(one.approved.length, 1);
  assert.equal(one.approved[0].approvedAt, '2026-02-02T00:00:00.000Z');
  assert.equal(Object.hasOwn(one.approved[0], 'proposed'), false);
  assert.equal(one.remaining.length, cases.length - 1);
  assert.deepEqual(approveCases(cases, { ids: ['nope'], approvedAt: 'x' }).unknownIds, ['nope']);
  assert.equal(approveCases(cases, { all: true, approvedAt: 'x' }).approved.length, cases.length);
});

test('a proposal is refused as evidence until it has been approved', () => {
  const g = fixture();
  const { cases } = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'abc123', perRelation: 5 });
  const { results } = checkCases(cases, { ask: askOf(g) });
  for (const r of results) {
    assert.equal(r.status, 'UNSCORABLE');
    assert.match(r.reason, /A human has to approve it/);
  }
});

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

test('an approved corpus scores itself, and a wrong expectation FAILS the case', () => {
  const g = fixture();
  const ask = askOf(g);
  const { cases } = proposeCases({ inventory: inventoryOf(g), ask, packDigest: 'abc123', perRelation: 5 });
  const approved = approveCases(cases, { all: true, approvedAt: '2026-02-02T00:00:00.000Z' }).approved;
  const clean = checkCases(approved, { ask });
  assert.equal(clean.results.every((r) => r.status === 'PASS'), true, 'the engine agrees with what it itself proposed');

  // A label that says the engine should return something it does not.
  const target = approved.find((c) => c.relation === 'column->endpoints');
  const flipped = approved.map((c) => (c.id === target.id
    ? { ...c, expect: { present: [...c.expect.present, 'GET /never/exists'], absent: c.expect.absent } }
    : c));
  const broken = checkCases(flipped, { ask });
  const row = broken.results.find((r) => r.id === target.id);
  assert.equal(row.status, 'FAIL');
  assert.equal(row.recallHit, false);
  assert.deepEqual(row.missing, ['GET /never/exists']);

  // …and one that forbids something the engine does return: a PRECISION miss.
  const forbid = approved.map((c) => (c.id === target.id
    ? { ...c, expect: { present: c.expect.present, absent: [...c.expect.present] } }
    : c));
  const prec = checkCases(forbid, { ask }).results.find((r) => r.id === target.id);
  assert.equal(prec.precisionHit, false);
  assert.ok(prec.forbidden.length > 0);
});

test('a sealed case is graded on a hash: pass/fail without the labels being visible', () => {
  const g = fixture();
  const ask = askOf(g);
  const input = { column: 'shop_order.total' };
  const id = caseId({ relation: 'column->endpoints', input });
  const expect = { present: ['GET /order/{id}'], absent: ['GET /item/list'] };
  const one = {
    schema: GOLDEN_CASE_SCHEMA, id, relation: 'column->endpoints', input, expect,
    approvedAt: '2026-02-02T00:00:00.000Z',
    // Force the seal regardless of what this id's hash says, so the grading path
    // is tested rather than the sampling.
  };
  const sealed = {
    schema: GOLDEN_CASE_SCHEMA, id, relation: 'column->endpoints', input,
    sealed: true, probes: [...expect.present, ...expect.absent].sort(),
    expectHash: expectationHash(expect), approvedAt: one.approvedAt,
  };
  const ok = checkCases([sealed], { ask }).results[0];
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.sealed, true);

  const wrong = { ...sealed, expectHash: expectationHash({ present: ['GET /item/list'], absent: ['GET /order/{id}'] }) };
  const bad = checkCases([wrong], { ask }).results[0];
  assert.equal(bad.status, 'FAIL');
  assert.match(bad.reason, /labels stay hidden/);
});

test('goldenSummary lists every relation, even one with no cases at all', () => {
  const s = goldenSummary([{ id: 'x', relation: 'column->endpoints', status: 'PASS', recallHit: true, precisionHit: true }]);
  for (const rel of RELATIONS) {
    assert.ok(Object.hasOwn(s.relations, rel), `${rel} must appear even at n=0 — a silently absent relation reads as one that passed`);
    assert.equal(s.relations[rel].specRow, RELATION_TARGETS[rel].specRow);
  }
  assert.equal(s.relations['endpoint->tables'].n, 0);
  assert.equal(s.relations['endpoint->tables'].status, 'INSUFFICIENT_SAMPLE');
  assert.equal(s.status, 'INSUFFICIENT_SAMPLE');
});

// ---------------------------------------------------------------------------
// RM53: the population, and the census that beats the sample floor
// ---------------------------------------------------------------------------

test('relationPopulations counts, per relation, how many inputs the pack HAS', () => {
  const inv = inventoryOf(fixture());
  const pop = relationPopulations(inv);
  assert.deepEqual(pop, {
    'column->endpoints': inv.columns.length,
    'endpoint->tables': inv.endpoints.length,
    'statement->columns': inv.statements.length,
    'method->statements': inv.mapperMethods.length,
  });
  // Every relation is named even when the pack has nothing to ask about, and an
  // inventory that is not one at all counts zero rather than throwing: the
  // population only ever WIDENS what can be scored, so a missing one must
  // degrade to the sample floor instead of failing a check.
  assert.deepEqual(relationPopulations(null), {
    'column->endpoints': 0, 'endpoint->tables': 0, 'statement->columns': 0, 'method->statements': 0,
  });
});

test('a corpus that covers EVERY input of a relation is scored on all of it, below 30', () => {
  const g = fixture();
  const inv = inventoryOf(g);
  const population = relationPopulations(inv);
  // Both endpoints of the fixture, labelled the way a trace labels: positives
  // only, no negatives, `source: 'runtime'`.
  const cases = inv.endpoints.map((endpoint) => ({
    schema: GOLDEN_CASE_SCHEMA,
    id: caseId({ relation: 'endpoint->tables', input: { endpoint } }),
    relation: 'endpoint->tables',
    input: { endpoint },
    expect: { present: answerFor('endpoint->tables', { endpoint }, askOf(g)).ids, absent: [] },
    source: 'runtime',
    approvedAt: '2026-01-01T00:00:00.000Z',
  }));
  const { summary } = checkCases(cases, { ask: askOf(g), population });
  const rel = summary.relations['endpoint->tables'];
  assert.equal(rel.n, 2);
  assert.equal(rel.population, 2);
  assert.equal(rel.exhaustive, true);
  assert.equal(rel.status, 'PASS', 'two of two endpoints, both right: a census, not a sample');
  assert.equal(rel.runtimeCases, 2);
  assert.equal(rel.handCases, 0);
  assert.ok(rel.recall.lowerBound < rel.recall.target, 'and the bound is still short, which is the point');
  // Without the population it is a 2-case sample again.
  assert.equal(checkCases(cases, { ask: askOf(g) }).summary.relations['endpoint->tables'].status, 'INSUFFICIENT_SAMPLE');
  // One case wrong, and a census FAILS: the floor never protected a corpus that
  // measured everything and found something wrong.
  const wrong = cases.map((c, i) => (i === 0
    ? { ...c, expect: { present: [...c.expect.present, 'shop_nowhere'], absent: [] } } : c));
  const broken = checkCases(wrong, { ask: askOf(g), population }).summary.relations['endpoint->tables'];
  assert.equal(broken.exhaustive, true);
  assert.equal(broken.status, 'FAIL');
});

test('the source of every case is carried through to the summary', () => {
  const g = fixture();
  const inv = inventoryOf(g);
  const endpoint = inv.endpoints[0];
  const one = (source) => ({
    schema: GOLDEN_CASE_SCHEMA,
    id: caseId({ relation: 'endpoint->tables', input: { endpoint } }),
    relation: 'endpoint->tables', input: { endpoint },
    expect: { present: answerFor('endpoint->tables', { endpoint }, askOf(g)).ids, absent: [] },
    ...(source ? { source } : {}),
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const runtime = checkCases([one('runtime')], { ask: askOf(g) });
  assert.equal(runtime.results[0].source, 'runtime');
  assert.equal(runtime.summary.relations['endpoint->tables'].runtimeCases, 1);
  // A case with no `source` at all is a hand-sampled one: every corpus written
  // before this round is exactly that, and it must not read as a runtime case.
  const hand = checkCases([one(null)], { ask: askOf(g) });
  assert.equal(hand.results[0].source, 'sample');
  assert.equal(hand.summary.relations['endpoint->tables'].handCases, 1);
  assert.equal(hand.summary.relations['endpoint->tables'].runtimeCases, 0);
});

test('a case that asserts NOTHING passes only where the engine answers nothing too', () => {
  const g = fixture();
  const endpoint = inventoryOf(g).endpoints[0];
  const empty = {
    schema: GOLDEN_CASE_SCHEMA,
    id: caseId({ relation: 'endpoint->tables', input: { endpoint } }),
    relation: 'endpoint->tables', input: { endpoint },
    expect: { present: [], absent: [] },
    source: 'runtime',
    approvedAt: '2026-01-01T00:00:00.000Z',
  };

  // The pack answers tables for this endpoint and the run saw none. That is not
  // a disagreement and it is not an agreement: the request may simply not have
  // taken that branch. UNSCORABLE, and out of `n` entirely.
  const against = checkCases([empty], { ask: askOf(g) });
  assert.equal(against.results[0].status, 'UNSCORABLE');
  assert.equal(against.results[0].empty, true);
  assert.match(against.results[0].reason, /the run saw no statement under this route and the pack answers 1 table\(s\)/);
  assert.match(against.results[0].reason, /nothing to compare/);
  assert.equal(against.summary.relations['endpoint->tables'].n, 0);
  assert.equal(against.summary.relations['endpoint->tables'].unscorable, 1);
  assert.equal(against.summary.relations['endpoint->tables'].emptyCases, 1);

  // The engine answering nothing either IS the agreement, and the only thing an
  // empty label can demonstrate: two independent sources, one reading the code
  // and one running it, both saying this route reads nothing.
  const silent = () => ({ answer: { tables: [] }, truncated: { fields: [] } });
  const agreed = checkCases([empty], { ask: silent });
  assert.equal(agreed.results[0].status, 'PASS');
  assert.equal(agreed.results[0].empty, true);
  assert.equal(agreed.summary.relations['endpoint->tables'].n, 1);
  assert.equal(agreed.summary.relations['endpoint->tables'].emptyCases, 1);
});

test('a relation is exhaustive only when every input of it was SCORED', () => {
  // Two endpoints in this pack. One case agrees on nothing, the other cannot be
  // compared, so the corpus "covers" both inputs and measures one: a census with
  // a hole in it is a sample.
  const g = fixture();
  const population = relationPopulations(inventoryOf(g));
  const results = [
    { id: 'a', relation: 'endpoint->tables', source: 'runtime', empty: true, status: 'PASS', recallHit: true, precisionHit: true },
    { id: 'b', relation: 'endpoint->tables', source: 'runtime', empty: true, status: 'UNSCORABLE', reason: 'nothing to compare' },
  ];
  const rel = goldenSummary(results, { population }).relations['endpoint->tables'];
  assert.equal(rel.population, 2);
  assert.equal(rel.n, 1);
  assert.equal(rel.exhaustive, false);
  assert.equal(rel.status, 'INSUFFICIENT_SAMPLE');
});

test('the method pool is every symbol that BINDS a statement, flagged or not', () => {
  // `mapperMethod` is the MyBatis lane's marker. A Spring Data repository method
  // binds a statement and never carries it, so reading the flag left every JPA
  // project with an empty pool: the relation was never sampled there and its
  // population was zero, on exactly the projects where a runtime trace matters
  // most. The EDGE is the fact; the flag is one lane's way of saying it.
  const g = new Graph();
  g.addNode({ id: 'symbol:com.example.OwnerRepository#findById', kind: 'symbol' });
  g.addNode({ id: 'statement:com.example.OwnerRepository.findById', kind: 'statement' });
  g.addEdge({
    from: 'symbol:com.example.OwnerRepository#findById',
    to: 'statement:com.example.OwnerRepository.findById',
    type: 'IMPLEMENTS_STMT', grade: 'EXACT',
  });
  const inv = inventoryOf(g);
  assert.deepEqual(inv.mapperMethods, ['com.example.OwnerRepository#findById']);
  assert.equal(relationPopulations(inv)['method->statements'], 1);
  // ...and the MyBatis shape still counts, because it has the same edge.
  assert.deepEqual(inventoryOf(fixture()).mapperMethods,
    ['com.example.ItemMapper#selectAll', 'com.example.OrderMapper#selectById']);
});

test('the anchor relation is named once, in the module that owns the relation names', () => {
  assert.equal(RUNTIME_ANCHOR_RELATION, 'endpoint->tables');
  assert.ok(RELATIONS.includes(RUNTIME_ANCHOR_RELATION));
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('cases round-trip through JSONL, and an unknown schema is refused (§17.7)', () => {
  const g = fixture();
  const { cases } = proposeCases({ inventory: inventoryOf(g), ask: askOf(g), packDigest: 'abc123', perRelation: 3 });
  assert.deepEqual(parseCases(serializeCases(cases)), [...cases].sort((a, b) => (a.id < b.id ? -1 : 1)));
  assert.deepEqual(parseCases(''), []);
  const bumped = JSON.stringify({ ...cases[0], schema: 'cascade:golden-case:2' });
  assert.throws(() => parseCases(bumped), (e) => /expected cascade:golden-case:1/.test(e.message));
  assert.throws(() => parseCases('{ not json'), (e) => /is not JSON/.test(e.message));
});

test('inventoryOf reads the candidate pool off the graph, sorted', () => {
  const g = fixture();
  const inv = inventoryOf(g);
  assert.deepEqual(inv.tables, ['shop_item', 'shop_order']);
  assert.deepEqual(inv.endpoints, ['GET /item/list', 'GET /order/{id}']);
  assert.equal(inv.columns.length, 4);
  assert.equal(inv.statements.length, 2);
  assert.equal(inv.mapperMethods.length, 2);
  for (const list of Object.values(inv)) assert.deepEqual(list, [...list].sort());
  assert.throws(() => inventoryOf(null), (e) => e instanceof GoldenError);
  assert.equal(inventoryOf(new Graph()).columns.length, 0);
  assert.ok(nodeId('column', 'x'));
});
