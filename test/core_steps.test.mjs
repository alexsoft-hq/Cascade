// core_steps.test.mjs — the steps RM50 split out of the chain walk and the
// federator, each imported on its own.
//
// WHY THIS FILE EXISTS BESIDE test/chain.test.mjs AND test/federation.test.mjs.
// Those two drive `chainWalk` and `makeFederator` end to end and are the better
// test of what the engine ANSWERS. What they cannot do is say WHERE a rule
// lives: when the tables lane comes out wrong they fail in the same place a
// wrong depth cut fails. RM50 split both into named steps with a paragraph each
// about what they own; this file holds each of them to that paragraph.
//
// It is deliberately about the SEAMS: the shape one step hands to the next, and
// the direction rule that is written once and works both ways.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDerivedEndpoints, buildLayers, buildTables, collectRows, countDepthBoundary,
  countLinkGrades, countOther, emptyReasonFor, frontendCallsOf, makeNodeFacts, makePathReader,
  nodeLabel, readWalkOptions, runBfs, sortLanes, weakestOf, ChainError,
} from '../src/core/chain_steps.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import {
  buildRoutesIndex, cmp, methodMatch, methodOf, outboundCallsOf, packOutboundCalls,
  pathOf, serversOf, strip, weaker, RANK, ROUTES_SCHEMA,
} from '../src/mcp/federation_routes.mjs';
import { block, limits, saysAnything, siblingBasis } from '../src/mcp/federation_report.mjs';
import { crossDown, crossUp } from '../src/mcp/federation_cross.mjs';
import { Graph, nodeId } from '../src/core/graph.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// a graph small enough to read: one route, one handler, one service, one
// statement, one table.
// ---------------------------------------------------------------------------

function tinyGraph() {
  const g = new Graph();
  g.addNode({ id: nodeId('endpoint', 'GET /owners'), path: '/owners', httpMethod: 'GET', handler: 'com.x.OwnerController#list' });
  g.addNode({ id: nodeId('symbol', 'com.x.OwnerController#list'), symbol: 'com.x.OwnerController#list', owner: 'com.x.OwnerController', file: 'C.java', line: 3 });
  g.addNode({ id: nodeId('symbol', 'com.x.OwnerService#find'), symbol: 'com.x.OwnerService#find', owner: 'com.x.OwnerService', file: 'S.java', line: 4 });
  g.addNode({ id: nodeId('symbol', 'com.x.OwnerMapper#select'), symbol: 'com.x.OwnerMapper#select', owner: 'com.x.OwnerMapper', file: 'M.java', line: 5 });
  g.addNode({ id: nodeId('statement', 'com.x.OwnerMapper.select'), statement: 'com.x.OwnerMapper.select', statementType: 'select' });
  g.addNode({ id: nodeId('table', 'owners'), table: 'owners' });
  g.addNode({ id: nodeId('column', 'owners.id'), column: 'owners.id' });
  g.addEdge({ from: nodeId('endpoint', 'GET /owners'), to: nodeId('symbol', 'com.x.OwnerController#list'), type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: nodeId('symbol', 'com.x.OwnerController#list'), to: nodeId('symbol', 'com.x.OwnerService#find'), type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'field-receiver', basis: 'a field' } });
  g.addEdge({ from: nodeId('symbol', 'com.x.OwnerService#find'), to: nodeId('symbol', 'com.x.OwnerMapper#select'), type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'field-receiver', basis: 'a field' } });
  g.addEdge({ from: nodeId('symbol', 'com.x.OwnerMapper#select'), to: nodeId('statement', 'com.x.OwnerMapper.select'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: nodeId('statement', 'com.x.OwnerMapper.select'), to: nodeId('table', 'owners'), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: nodeId('statement', 'com.x.OwnerMapper.select'), to: nodeId('column', 'owners.id'), type: 'READS', grade: 'EXACT' });
  g.addEdge({ from: nodeId('table', 'owners'), to: nodeId('column', 'owners.id'), type: 'DECLARES', grade: 'EXACT' });
  return g;
}

const START = nodeId('symbol', 'com.x.OwnerController#list');

// ---------------------------------------------------------------------------
// chain_steps.mjs — the options, the walk, and the lanes
// ---------------------------------------------------------------------------

test('chain steps: the direction is spelled out ONCE, and everything below reads it', () => {
  const g = tinyGraph();
  const down = readWalkOptions(g, { start: START });
  assert.equal(down.up, false);
  assert.equal(down.maxDepth, 6);
  assert.equal(down.follow.has('HANDLES'), true, 'walking down, a route is a step of the chain');
  const up = readWalkOptions(g, { start: START, direction: 'up' });
  assert.equal(up.up, true);
  assert.equal(up.follow.has('HANDLES'), false,
    'walking up, an endpoint is a ROUTE and not code: the endpoints lane is DERIVED, never walked onto');
  // The adjacency and the step are the only two things direction changes.
  const e = g.outEdges(START)[0];
  assert.equal(down.stepTo(e), e.to);
  assert.equal(up.stepTo(e), e.from);
  assert.throws(() => readWalkOptions(g, { start: START, direction: 'sideways' }), ChainError);
  assert.throws(() => readWalkOptions(g, { start: START, mode: 'wishful' }), ChainError);
  assert.throws(() => readWalkOptions(g, { start: 'symbol:nobody' }), ChainError);
});

test('chain steps: the BFS carries the WEAKEST link on every record, and its own parent', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START });
  const { best, cut, root } = runBfs(g, w);
  assert.equal(root.hops, 0);
  assert.equal(best.get(nodeId('symbol', 'com.x.OwnerService#find')).pathGrade, 'SOUND_SET',
    'one candidate call on the path makes the whole path a candidate');
  assert.equal(best.get(nodeId('statement', 'com.x.OwnerMapper.select')).pathGrade, 'SOUND_SET',
    'and an EXACT last edge does not restore it');
  assert.equal(best.get(nodeId('statement', 'com.x.OwnerMapper.select')).hops, 3);
  assert.equal(cut.byMode, 0);
  assert.equal(cut.depth, 0);
  // The parent chain is the path, and nothing else is.
  const h = makePathReader(g, w, best);
  const p = h.pathTo(nodeId('statement', 'com.x.OwnerMapper.select'));
  assert.deepEqual(p.map((x) => x.type), ['MAY_CALL', 'MAY_CALL', 'IMPLEMENTS_STMT']);
  assert.equal(weakestOf(p), 'SOUND_SET');
});

test('chain steps: a strict mode does not follow a call it could not prove, and SAYS so', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START, mode: 'strict' });
  const { best, cut } = runBfs(g, w);
  assert.equal(best.size, 0, 'strict reaches nothing here: controller -> service is MAY_CALL');
  assert.ok(cut.byMode > 0, 'and the skipped edges are COUNTED, never reported as an absence');
});

test('chain steps: the depth boundary counts a node that still had somewhere to go', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START, maxDepth: 1 });
  const { best, cut } = runBfs(g, w);
  countDepthBoundary(g, w, best, cut);
  assert.equal(cut.depth, 1, 'the service sits at the cap and its mapper is beyond it');
});

test('chain steps: the four facts a row asks the GRAPH rather than the walk', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START });
  const { best } = runBfs(g, w);
  const facts = makeNodeFacts(g, w, best);
  assert.equal(facts.tableOfColumn(nodeId('column', 'owners.id')), nodeId('table', 'owners'),
    'which table owns a column is the schema\'s answer, not the name\'s');
  assert.equal(facts.mapperAbove(nodeId('statement', 'com.x.OwnerMapper.select')), nodeId('symbol', 'com.x.OwnerMapper#select'));
  assert.equal(facts.httpMark({ http: 0 }), null, 'a row that crossed no hop says nothing about hops');
  assert.deepEqual(facts.httpMark({ http: 2 }), { viaHttp: true, httpHops: 2 });
  assert.equal(facts.webLanes, false, 'this pack has no frontend, so the screen lanes are ABSENT, not empty');
});

test('chain steps: every reached node lands in exactly one lane, and a mapper method is folded', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START });
  const { best } = runBfs(g, w);
  const h = { best, ...makePathReader(g, w, best), ...makeNodeFacts(g, w, best) };
  const rows = collectRows(g, w, h);
  assert.deepEqual(rows.services.map((s) => s.id), ['com.x.OwnerService#find'],
    'the mapper method IS its statement, so it never doubles as a service');
  assert.deepEqual(rows.statements.map((s) => s.id), ['com.x.OwnerMapper.select']);
  assert.equal(rows.statements[0].symbol, 'com.x.OwnerMapper#select', 'and the statement names the mapper it was folded from');
  assert.equal(rows.statements[0].link.from, nodeId('symbol', 'com.x.OwnerService#find'),
    'a folded node is not a drawn row, so the line lands on the service above it');
  assert.equal(rows.reachedStatements.length, 1);
  assert.equal(rows.handlers.length, 0, 'walking down, nothing is a handler row');
});

test('chain steps: the tables lane aggregates the statements, with distinct columns per table', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START });
  const { best } = runBfs(g, w);
  const h = { best, ...makePathReader(g, w, best), ...makeNodeFacts(g, w, best) };
  const rows = collectRows(g, w, h);
  const { tables, agg } = buildTables(g, w, h, rows.reachedStatements);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].table, 'owners');
  assert.equal(tables[0].statements, 1);
  assert.equal(tables[0].access, 'read');
  assert.equal(tables[0].reads, 1);
  assert.equal(tables[0].writes, 0);
  assert.equal(agg.size, 1);
  // Walking UP, the target IS the table side: the lane is absent rather than
  // echoing the thing that was asked about.
  const upW = readWalkOptions(g, { start: nodeId('column', 'owners.id'), direction: 'up' });
  const upBest = runBfs(g, upW);
  const upH = { best: upBest.best, ...makePathReader(g, upW, upBest.best), ...makeNodeFacts(g, upW, upBest.best) };
  assert.deepEqual(buildTables(g, upW, upH, []).tables, []);
});

test('chain steps: walking up, the endpoints lane is DERIVED from the handlers, never walked onto', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: nodeId('column', 'owners.id'), direction: 'up' });
  const { best } = runBfs(g, w);
  const h = { best, ...makePathReader(g, w, best), ...makeNodeFacts(g, w, best) };
  const rows = collectRows(g, w, h);
  assert.deepEqual(rows.handlers.map((x) => strip(x.id)), ['com.x.OwnerController#list']);
  const { derivedEndpoints, epAgg } = buildDerivedEndpoints(g, w, h, rows.handlers);
  assert.equal(derivedEndpoints.length, 1);
  assert.equal(derivedEndpoints[0].path, '/owners');
  assert.equal(derivedEndpoints[0].handler, 'com.x.OwnerController#list');
  assert.equal(derivedEndpoints[0].grade, 'SOUND_SET', 'the weakest link on the way up is the MAY_CALL');
  assert.ok(derivedEndpoints[0].walkedPath.length > 0, 'and the row carries the path that derived it');
  assert.equal(epAgg.size, 1);
});

test('chain steps: the censuses count what the lanes show, and what they do not', () => {
  const g = tinyGraph();
  const w = readWalkOptions(g, { start: START });
  const { best } = runBfs(g, w);
  const h = { best, ...makePathReader(g, w, best), ...makeNodeFacts(g, w, best) };
  const rows = collectRows(g, w, h);
  const { tables, agg } = buildTables(g, w, h, rows.reachedStatements);
  const byLinkGrade = countLinkGrades(g, w, best);
  assert.deepEqual(byLinkGrade, { EXACT: 2, SOUND_SET: 2, HEURISTIC: 0 },
    'a column is not counted, and the start is never its own link');
  const { layers, beyond, endLane } = buildLayers(g, w, h, {
    ...rows, tables, endpoints: rows.walkedEndpoints, agg,
  });
  assert.equal(endLane, 'tables');
  assert.equal(layers.length, 4);
  assert.equal(layers.reduce((n, l) => n + l.byLinkGrade.EXACT + l.byLinkGrade.SOUND_SET, 0), 4,
    'the layers\' grade counts sum to byLinkGrade');
  assert.deepEqual(beyond, { tables: 0 });
  assert.equal(countOther(g, w, h, new Map()), 0, 'every reached node here has a lane');
});

test('chain steps: an empty lane the TARGET sits on the wrong side of is not an absence', () => {
  const g = tinyGraph();
  const up = readWalkOptions(g, { start: nodeId('statement', 'com.x.OwnerMapper.select'), direction: 'up' });
  assert.deepEqual(emptyReasonFor(up), { statements: 'not-in-this-axis' },
    'nothing CALLS a statement, so the caller must say "not in this axis", never "none"');
  const down = readWalkOptions(g, { start: START });
  assert.deepEqual(emptyReasonFor(down), {});
});

test('chain steps: every lane is sorted by one rule, so two answers never differ by order', () => {
  const lanes = {
    services: [{ id: 'b', hops: 2, grade: 'EXACT' }, { id: 'a', hops: 1, grade: 'EXACT' }],
    webFunctions: [], screens: [], statements: [], tables: [], endpoints: [],
  };
  sortLanes(lanes);
  assert.deepEqual(lanes.services.map((s) => s.id), ['a', 'b']);
});

test('chain steps: the display name is one rule the tools, the walk and the page share', () => {
  assert.equal(nodeLabel({ kind: 'symbol', symbol: 'com.x.A#m' }, 'symbol:com.x.A#m'), 'A#m');
  assert.equal(nodeLabel(null, 'statement:a.b.C.select'), 'C.select');
  assert.equal(nodeLabel({ kind: 'endpoint', httpMethod: 'GET', path: '/x' }, 'endpoint:GET /x'), 'GET /x');
  assert.equal(frontendCallsOf(tinyGraph(), nodeId('endpoint', 'GET /owners')), 0);
});

test('chain steps: the steps assemble to exactly what chainWalk answers', () => {
  // The point of the split: chainWalk is now the ORDER these run in, and running
  // them by hand has to reach the same lanes it does.
  const g = tinyGraph();
  const whole = chainWalk(g, { start: START, direction: 'down' });
  const w = readWalkOptions(g, { start: START, direction: 'down' });
  const { best } = runBfs(g, w);
  const h = { best, ...makePathReader(g, w, best), ...makeNodeFacts(g, w, best) };
  const rows = collectRows(g, w, h);
  assert.deepEqual(whole.services.map((s) => s.id), rows.services.map((s) => s.id));
  assert.deepEqual(whole.statements.map((s) => s.id), rows.statements.map((s) => s.id));
  assert.deepEqual(whole.tables.map((t) => t.table), buildTables(g, w, h, rows.reachedStatements).tables.map((t) => t.table));
});

// ---------------------------------------------------------------------------
// federation_routes.mjs — the sidecar, and the match
// ---------------------------------------------------------------------------

test('federation routes: the sidecar says what a project SERVES and what it CALLS', () => {
  const g = tinyGraph();
  g.addNode({ id: nodeId('endpoint', 'GET /vets'), path: '/vets', httpMethod: 'GET', outbound: true });
  g.addEdge({
    from: nodeId('symbol', 'com.x.OwnerService#find'), to: nodeId('endpoint', 'GET /vets'),
    type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence: { service: 'vets-service' },
  });
  const index = buildRoutesIndex(g, { project: 'owners', buildDigest: 'abc' });
  assert.equal(index.schema, ROUTES_SCHEMA);
  assert.deepEqual(index.serves.map((r) => r.path), ['/owners'], 'an outbound route is not something this pack serves');
  assert.deepEqual(index.calls.map((c) => c.path), ['/vets']);
  assert.equal(index.calls[0].service, 'vets-service');
  // …and the same census read off the graph directly.
  const out = packOutboundCalls(g);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].callers, [nodeId('symbol', 'com.x.OwnerService#find')]);
  assert.equal(outboundCallsOf(g, nodeId('symbol', 'com.x.OwnerService#find')).length, 1);
});

test('federation routes: a verb matches ANY, and the primitives are the ones both lanes share', () => {
  // The match is not a boolean: an exact verb is SOUND_SET, a route that
  // answers ANY verb is a weaker claim and says so, and two different verbs are
  // no match at all.
  assert.equal(methodMatch('GET', 'GET'), 'SOUND_SET');
  assert.equal(methodMatch('ANY', 'GET'), 'HEURISTIC');
  assert.equal(methodMatch('GET', 'POST'), null);
  assert.equal(methodOf({ httpMethod: '' }), 'ANY');
  assert.equal(pathOf({ id: 'endpoint:GET /x' }), '/x');
  assert.equal(weaker('EXACT', 'SOUND_SET'), 'SOUND_SET');
  assert.ok(RANK.SOUND_SET > RANK.HEURISTIC);
  assert.equal(strip('symbol:com.x.A#m'), 'com.x.A#m');
  assert.equal(cmp('a', 'b'), -1);
});

test('federation routes: which project answers a call — and the ambiguity is DISCLOSED', () => {
  const call = { method: 'GET', path: '/vets', service: null };
  const entries = [
    { id: 'vets', index: { project: 'vets', serves: [{ id: 'endpoint:GET /vets', method: 'GET', path: '/vets' }], serviceNames: [] } },
    { id: 'copy', index: { project: 'copy', serves: [{ id: 'endpoint:GET /vets', method: 'GET', path: '/vets' }], serviceNames: [] } },
    { id: 'blind', index: null },
  ];
  const r = serversOf(call, entries, { exclude: 'me' });
  assert.equal(r.chosen.length, 2, 'nothing in the call says which of the two it goes to');
  assert.equal(r.ambiguous, true);
  assert.equal(r.chosen[0].grade, 'HEURISTIC', 'so every crossing below it is a candidate');
  assert.equal(r.noIndex, 1, 'and the project that could not be asked is counted, never ignored');
  // A service NAME on the call picks one, and the grade rises with it.
  const named = serversOf({ ...call, service: 'vets' }, entries, { exclude: 'me' });
  assert.equal(named.chosen.length, 1);
  assert.equal(named.chosen[0].project, 'vets');
  assert.equal(named.ambiguous, false);
});

// ---------------------------------------------------------------------------
// federation_report.mjs — the wording, and only the wording
// ---------------------------------------------------------------------------

const emptyF = () => ({
  self: 'me', wanted: true, available: false, entries: [], maxCrossings: 3,
  crossed: [], unmatched: [], hopCapped: [], offPicture: [],
  siblings: new Map(), skippedById: new Map(),
});

test('federation report: a server that serves one project and calls nobody says nothing', () => {
  const f = emptyF();
  assert.equal(saysAnything(f), false,
    'an empty block would be a field that says nothing, in an answer whose shape other tools diff against');
  assert.deepEqual(block(f), { available: false, reason: 'single-project', unmatched: [] });
  assert.equal(siblingBasis(f), null);
  assert.deepEqual(limits(f), []);
  // …and `federate: false` is a different sentence from "there is nobody else".
  assert.deepEqual(block({ ...f, wanted: false }), { available: false, reason: 'turned-off', unmatched: [] });
  assert.deepEqual(limits({ ...f, wanted: false }), []);
});

test('federation report: every sentence ends in something a reader can DO', () => {
  const f = emptyF();
  f.unmatched.push({ from: { project: 'me', symbol: 'A#m' }, route: { method: 'GET', path: '/vets' }, service: null, checked: 0, noIndex: 0 });
  f.hopCapped.push({ from: { project: 'me', symbol: 'B#m' }, route: { method: 'GET', path: '/far' } });
  f.skippedById.set('blind', { project: 'blind', reason: 'no-index' });
  const said = limits(f).map((l) => l.reason);
  assert.equal(said.length, 3);
  for (const s of said) assert.match(s, /cascade (init|analyze)|federationHops/, `no remedy in: ${s}`);
  assert.match(said[0], /where it lands is unknown rather than absent/);
  assert.match(said[1], /a bound on this answer, not an absence/);
  assert.match(said[2], /carries no route index/);
  assert.equal(saysAnything(f), true);
});

test('federation report: a route two projects serve is disclosed as a candidate, not a chain', () => {
  const f = { ...emptyF(), available: true };
  const call = { from: { project: 'me', symbol: 'A#m' }, route: { method: 'GET', path: '/vets' }, service: null, ambiguous: true };
  f.crossed.push({ ...call, to: { project: 'vets', endpoint: 'GET /vets' } });
  f.crossed.push({ ...call, to: { project: 'copy', endpoint: 'GET /vets' } });
  const said = limits(f).map((l) => l.reason);
  assert.equal(said.length, 1);
  assert.match(said[0], /is served by copy, vets/);
  assert.match(said[0], /candidates rather than one measured chain/);
  assert.equal(block(f).crossed.length, 2, 'and BOTH are on the answer');
});

// ---------------------------------------------------------------------------
// federation_cross.mjs — the crossings, on a federator that has no siblings
// ---------------------------------------------------------------------------

test('federation cross: with nobody to cross into, a call that leaves is UNMATCHED, not lost', () => {
  const g = tinyGraph();
  g.addNode({ id: nodeId('endpoint', 'GET /vets'), path: '/vets', httpMethod: 'GET', outbound: true });
  g.addEdge({
    from: nodeId('symbol', 'com.x.OwnerService#find'), to: nodeId('endpoint', 'GET /vets'),
    type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence: { service: null },
  });
  const f = emptyF();
  f.projectCtx = () => null;
  f.routeNode = () => null;
  f.recordCrossing = () => { throw new Error('nothing to cross into'); };
  f.recordUnmatched = (from, call, r) => f.unmatched.push({
    from: { project: from.project, symbol: strip(from.id) },
    route: { method: call.method, path: call.path },
    service: call.service ?? null, checked: r.checked, noIndex: r.noIndex,
  });
  const lanes = crossDown(f, g, [{ id: nodeId('symbol', 'com.x.OwnerService#find'), hops: 1, grade: 'SOUND_SET', http: 0, project: 'me' }], { mode: 'conservative', depth: 6 });
  assert.deepEqual(lanes.services, [], 'no sibling: no row moved');
  assert.equal(f.unmatched.length, 1);
  assert.equal(f.unmatched[0].route.path, '/vets');
  // …and walking up with no caller anywhere adds nothing either.
  const up = crossUp(f, [{ id: nodeId('endpoint', 'GET /owners'), method: 'GET', path: '/owners', hops: 1, grade: 'EXACT' }], { mode: 'conservative', depth: 6 });
  assert.deepEqual(up.services, []);
});

// ---------------------------------------------------------------------------
// the layering these modules were split under
// ---------------------------------------------------------------------------

test('nothing under the split modules imports its own parent back', () => {
  const pairs = [
    ['src/core/chain_steps.mjs', /from '\.\/chain\.mjs'/],
    ['src/mcp/federation_routes.mjs', /from '\.\/federation(_cross|_report)?\.mjs'/],
    ['src/mcp/federation_cross.mjs', /from '\.\/federation\.mjs'/],
    ['src/mcp/federation_report.mjs', /from '\.\/federation(_cross)?\.mjs'/],
  ];
  for (const [rel, bad] of pairs) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(bad.test(text), false, `${rel} imports back into the module it was split out of`);
    assert.match(text.slice(0, 3000), /WHAT THIS MODULE OWNS/, `${rel} does not say what it owns`);
    assert.match(text.slice(0, 3000), /WHAT IT MUST NEVER KNOW ABOUT/, `${rel} does not say what it must not know`);
  }
});
