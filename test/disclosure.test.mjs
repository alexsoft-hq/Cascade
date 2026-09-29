// disclosure.test.mjs — what a reader needs to see where they need it: how sure a route's own address is, what a mode floor left out and which mode would walk it, what the run could not read, and what kind of gap each one is.
//
// A route whose address rests on something its lane could not read is graded
// HEURISTIC on its HANDLES edge. Every walk starts at the handler, so that grade
// was on no list and no count: 117 of ghostfolio's 118 routes were guesses and
// nothing on the page said so. These are the answers that now carry it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { buildOverview, gapClassOf, unresolvedCallsOf } from '../src/core/overview.mjs';
import { nodeLabel } from '../src/core/chain.mjs';
import { chainWalk } from '../src/core/chain.mjs';

/** Two routes onto one handler, one sure and one a guess, a service, a statement and a table; a web function calls the guessed one. */
function graph() {
  const g = new Graph();
  const ctl = 'symbol:src/a.controller.ts#A.get';
  const svc = 'symbol:src/a.service.ts#AService.load';
  const stmt = 'statement:prisma:src/a.service.ts#AService.load/0';
  g.addNode({ id: 'endpoint:GET /api/a', path: '/api/a', httpMethod: 'GET', handler: ctl, apiGroup: 'a' });
  g.addNode({ id: 'endpoint:GET /api/b', path: '/api/b', httpMethod: 'GET', handler: ctl, apiGroup: 'b' });
  g.addEdge({ from: 'endpoint:GET /api/a', to: ctl, type: 'HANDLES', grade: 'HEURISTIC', evidence: { rule: 'nestjs.routes', basis: 'an exclude this engine cannot read may name this route' } });
  g.addEdge({ from: 'endpoint:GET /api/b', to: ctl, type: 'HANDLES', grade: 'EXACT', evidence: { rule: 'nestjs.routes' } });
  g.addNode({ id: ctl, file: 'src/a.controller.ts', lane: 'ts' });
  g.addNode({ id: svc, file: 'src/a.service.ts', lane: 'ts' });
  g.addEdge({ from: ctl, to: svc, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addNode({ id: stmt, statementType: 'select' });
  g.addEdge({ from: svc, to: stmt, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt, to: 'table:A', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addNode({ id: 'symbol:web/a.ts#loadA', file: 'web/a.ts', lane: 'web' });
  g.addEdge({ from: 'symbol:web/a.ts#loadA', to: 'endpoint:GET /api/a', type: 'CALLS_HTTP', grade: 'HEURISTIC' });
  g.addNode({ id: 'endpoint:GET /api/gone', path: '/api/gone', httpMethod: 'GET', outbound: true });
  g.addEdge({ from: 'symbol:web/a.ts#loadA', to: 'endpoint:GET /api/gone', type: 'CALLS_HTTP', grade: 'UNRESOLVED' });
  return g;
}

const META = {
  project: 'p', digest: 'd', lanes: ['ts'],
  laneStats: { ts: { calls: { resolved: 3, external: 1, unresolved: 7 } }, web: { calls: { withUrl: 2 } } },
  diagnostics: [
    { kind: 'PROFILE_DEFAULT_ASSUMED', severity: 'info', key: 'packagePrefixes', reason: 'packagePrefixes is empty' },
    { kind: 'TS_PREFIX_EXCLUDE_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'Declare the list as tsBackend.globalPrefixExclude in the profile to read it' },
  ],
};
const basis = () => ({ project: 'p', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const ask = (name, args, pack = META) => callTool(name, args, { graph: graph(), basis: basis(), pack, trust: { trustLevel: 'UNCERTIFIED' } });

test('the overview counts the served routes by how sure their own address is, and names the services a walk passes through', () => {
  const o = buildOverview(graph());
  assert.deepEqual(o.reach.routeGrades, { EXACT: 1, HEURISTIC: 1 });
  // A guessed route's handler is below the conservative floor, so the walk stops
  // at the route, and the gap says that is why, not "it touches no database".
  const gap = o.gaps.find((g) => g.kind === 'endpoints-without-statement');
  assert.match(gap.note, /1 of them stop at the route itself: every link from the route to its handler is graded below this mode's floor/);
  const wide = buildOverview(graph(), { mode: 'heuristic' });
  assert.equal(wide.gaps.find((g) => g.kind === 'endpoints-without-statement'), undefined, 'at heuristic the route walks into its handler');
  // the controller method is a route's handler and the Prisma method is the statement's own; neither is a service
  assert.equal(o.code.services, 0);
});

test('every gap says what kind of gap it is, and a kind nobody classified is shown as information rather than lost', () => {
  const o = buildOverview(graph(), { axes: { catalog: { status: 'not-shipped', reason: 'no catalog was read' } } });
  const byKind = Object.fromEntries(o.gaps.map((g) => [g.kind, g.class]));
  assert.equal(byKind['no-catalog'], 'input');
  assert.equal(byKind['mode-floor'], 'query');
  assert.ok(o.gaps.every((g) => ['input', 'unresolved', 'query', 'unreached', 'info'].includes(g.class)));
  assert.equal(gapClassOf('tables-not-reached'), 'unreached');
  assert.equal(gapClassOf('a-gap-from-tomorrow'), 'info');
});

test('the calls a lane could not place are counted from every lane that counts them, and unknown stays unknown', () => {
  assert.equal(unresolvedCallsOf({ unresolvedCalls: 15, web: { calls: { withUrl: 4 } } }), 15);
  assert.equal(unresolvedCallsOf({ ts: { calls: { unresolved: 1777 } } }), 1777);
  assert.equal(unresolvedCallsOf({ unresolvedCalls: 2, ts: { calls: { unresolved: 3 } } }), 5);
  assert.equal(unresolvedCallsOf({ web: { calls: { withUrl: 4 } } }), null, 'no lane counted, so it is not zero');
  assert.equal(unresolvedCallsOf(null), null);
  const gap = ask('overview', {}).answer.gaps.find((g) => g.kind === 'unresolved-calls');
  assert.equal(gap.count, 7, 'the TypeScript lane counted its unresolved calls, so the overview does not call them unknown');
});

test('the overview relays what the run could not read, warn and error only, and each one is a limit too', () => {
  const r = ask('overview', {});
  assert.deepEqual(r.answer.diagnostics, [{ kind: 'TS_PREFIX_EXCLUDE_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'Declare the list as tsBackend.globalPrefixExclude in the profile to read it',
    remedy: { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: '["health", "docs{/*rest}"]' } }]);
  assert.ok(r.limits.some((l) => l.scope === 'diagnostic:TS_PREFIX_EXCLUDE_UNREAD'));
  assert.equal(ask('overview', {}, { ...META, diagnostics: [] }).answer.empty.diagnostics, 'none');
  assert.equal(ask('overview', {}, { ...META, diagnostics: undefined }).answer.empty.diagnostics, 'not-shipped', 'a pack that kept no diagnostics said nothing');
});

test('a route\'s own grade rides on its browse row and on a flow drawn down from it, with its lane\'s reason', () => {
  const rows = ask('browse', { kind: 'endpoint' }).answer.items;
  assert.deepEqual(Object.fromEntries(rows.map((x) => [x.endpoint, x.grade])), { 'GET /api/a': 'HEURISTIC', 'GET /api/b': 'EXACT' });
  assert.deepEqual(rows.map((x) => x.group).sort(), ['a', 'b'], 'and its group is the lane\'s');
  const entry = ask('flow', { endpoint: 'GET /api/a' }).answer.entry;
  assert.equal(entry.grade, 'HEURISTIC');
  assert.equal(entry.gradeBasis, 'an exclude this engine cannot read may name this route');
});

test('a mode floor counts what it kept out by grade, and a wider mode is offered only where it would walk something', () => {
  const w = chainWalk(graph(), { start: 'table:A', direction: 'up', mode: 'conservative', maxDepth: 8 });
  assert.deepEqual(w.cut.byModeGrades, { HEURISTIC: 1 });
  const up = ask('flow', { table: 'A', direction: 'up', mode: 'conservative' });
  assert.ok(up.limits.some((l) => /1 link\(s\) below the grade floor of mode=conservative were not walked \(1 HEURISTIC\).*try mode=heuristic/.test(l.reason)));
  // heuristic walks the route onto the web function, which then has only an UNRESOLVED call left
  const wide = ask('flow', { table: 'A', direction: 'up', mode: 'heuristic' });
  assert.ok(!wide.limits.some((l) => /try mode=/.test(l.reason)), 'no mode walks an UNRESOLVED link, so none is offered');
});

test('a statement keyed by a file reads by the file\'s name, the way a symbol keyed by one does', () => {
  assert.equal(nodeLabel(null, 'statement:prisma:apps/api/src/a/a.service.ts#AService.load/0'), 'a.service.ts#AService.load/0');
  assert.equal(nodeLabel(null, 'symbol:apps/api/src/a/a.service.ts#AService.load'), 'a.service.ts#AService.load');
  assert.equal(nodeLabel(null, 'statement:com.macro.mall.dao.PmsProductDao.getUpdateInfo'), 'PmsProductDao.getUpdateInfo', 'a package-keyed id keeps its two last segments');
  assert.equal(nodeLabel(null, 'symbol:com.acme.Foo#bar'), 'Foo#bar');
});
