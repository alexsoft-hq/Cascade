// federation.test.mjs — one answer across several packs (RM44).
//
// Everything here runs on SYNTHETIC packs, built by the real pack builder and
// read by the real loader, served by the real project host through the real
// tool catalog. Nothing is stubbed but the clock: the point of the round is
// that a query-time join between two packs is as honest as a walk inside one,
// and a fake tool would prove nothing about that.
//
// The shape, three services, is the shape the round was measured on:
//
//   gateway   GET /api/x  -> Ctl#get -> Client#fetch --CALLS_HTTP--> GET /things/{id}
//   things    GET /things/{thingId} -> Ctl#get -> Svc#load -> stmt -> table things
//   other     GET /things/{thingId} as well, for the ambiguity case
//
// The gateway pack alone stops at "leaves the pack": the CALLS_HTTP edge onto
// an outbound route is UNRESOLVED, which is below every mode's floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Graph } from '../src/core/graph.mjs';
import { projectPack, loadPack } from '../src/core/pack.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { createProjectHost } from '../src/mcp/projects.mjs';
import { assertContract, makeResponse } from '../src/mcp/contract.mjs';
import { NO_STATE_TRUST_LEVEL } from '../src/core/trust.mjs';
import {
  buildRoutesIndex, serializeRoutesIndex, readRoutesIndex, ROUTES_FILE, ROUTES_SCHEMA,
  methodMatch, serversOf, outboundCallsOf, packOutboundCalls,
} from '../src/mcp/federation.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** A caller: one route, its handler, and a client method that calls out. */
function callerGraph({ route = '/api/x', callPath = '/things/{*}', method = 'GET', service = 'thingsvc', pkg = 'gw' } = {}) {
  const g = new Graph();
  const ep = `endpoint:GET ${route}`;
  const ctl = `symbol:com.${pkg}.Ctl#get`;
  const client = `symbol:com.${pkg}.Client#fetch`;
  const outbound = `endpoint:${method} ${callPath}`;
  g.addNode({ id: ep, kind: 'endpoint', httpMethod: 'GET', path: route, handler: ctl, file: `${pkg}/Ctl.java`, line: 10 });
  g.addNode({ id: ctl, kind: 'symbol', owner: `com.${pkg}.Ctl`, file: `${pkg}/Ctl.java`, line: 12 });
  g.addNode({ id: client, kind: 'symbol', owner: `com.${pkg}.Client`, file: `${pkg}/Client.java`, line: 30 });
  g.addNode({ id: outbound, kind: 'endpoint', httpMethod: method, path: callPath, outbound: true });
  g.addEdge({ from: ep, to: ctl, type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: ctl, to: client, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({
    from: client, to: outbound, type: 'CALLS_HTTP', grade: 'UNRESOLVED',
    evidence: { rule: 'http-client-call', service, serviceLiteral: !!service, url: { template: callPath }, target: 'outside-pack' },
  });
  return g;
}

/** A caller with TWO outbound calls, so one walk crosses into two projects. */
function twoCallGraph() {
  const g = callerGraph();
  const client = 'symbol:com.gw.Client#fetch';
  const outbound = 'endpoint:GET /others/{*}';
  g.addNode({ id: outbound, kind: 'endpoint', httpMethod: 'GET', path: '/others/{*}', outbound: true });
  g.addEdge({
    from: client, to: outbound, type: 'CALLS_HTTP', grade: 'UNRESOLVED',
    evidence: { rule: 'http-client-call', service: null, serviceLiteral: false, url: { template: '/others/{*}' }, target: 'outside-pack' },
  });
  return g;
}

/** A server: one route, its handler, a service, a statement, a table, a column. */
function serverGraph({ route = '/things/{thingId}', pkg = 'th', table = 'things', column = 'name' } = {}) {
  const g = new Graph();
  const ep = `endpoint:GET ${route}`;
  const ctl = `symbol:com.${pkg}.Ctl#get`;
  const svc = `symbol:com.${pkg}.Svc#load`;
  const mapper = `symbol:com.${pkg}.Mapper#select`;
  const stmt = `statement:com.${pkg}.Mapper.select`;
  g.addNode({ id: ep, kind: 'endpoint', httpMethod: 'GET', path: route, handler: ctl, file: `${pkg}/Ctl.java`, line: 8 });
  g.addNode({ id: ctl, kind: 'symbol', owner: `com.${pkg}.Ctl`, file: `${pkg}/Ctl.java`, line: 9 });
  g.addNode({ id: svc, kind: 'symbol', owner: `com.${pkg}.Svc`, file: `${pkg}/Svc.java`, line: 20 });
  g.addNode({ id: mapper, kind: 'symbol', owner: `com.${pkg}.Mapper`, file: `${pkg}/Mapper.java`, line: 5 });
  g.addNode({ id: stmt, kind: 'statement', statementType: 'select', file: `${pkg}/Mapper.xml`, line: 30 });
  g.addNode({ id: `table:${table}`, kind: 'table', comment: null });
  g.addNode({ id: `column:${table}.${column}`, kind: 'column', type: 'VARCHAR' });
  g.addEdge({ from: ep, to: ctl, type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: ctl, to: svc, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: svc, to: mapper, type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: mapper, to: stmt, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: stmt, to: `table:${table}`, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: stmt, to: `column:${table}.${column}`, type: 'READS', grade: 'EXACT' });
  g.addEdge({ from: `table:${table}`, to: `column:${table}.${column}`, type: 'DECLARES', grade: 'EXACT' });
  return g;
}

/**
 * Write one project to disk: its pack, and (unless told not to) its sidecar.
 * @returns {{id:string, dotCascadePath:string, packDir:string, digest:string}}
 */
function writeProject(root, id, graph, opts = {}) {
  const dot = path.join(root, id, '.cascade');
  const packDir = path.join(dot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const pack = projectPack(graph, { project: opts.packProject ?? id, builtAt: '2026-09-08T00:00:00.000Z', lanes: ['sql', 'java'] });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(pack));
  if (opts.index !== 'none') {
    const index = buildRoutesIndex(graph, {
      project: opts.packProject ?? id,
      buildDigest: opts.index === 'stale' ? 'not-this-pack' : pack.digest,
      serviceNames: opts.serviceNames ?? [],
    });
    fs.writeFileSync(path.join(packDir, ROUTES_FILE), serializeRoutesIndex(index));
  }
  return { id, dotCascadePath: dot, packDir, digest: pack.digest, source: 'analyze', stack: ['sql', 'java'], lastCertifiedAt: '2026-09-08T00:00:00.000Z' };
}

/** The loader the CLI builds, in miniature. */
function loadProject(entry) {
  const file = path.join(entry.packDir ?? path.join(entry.dotCascadePath, 'pack'), 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return {
    graph,
    basis: {
      project: entry.id, buildDigest: pack.digest, builtAt: pack.meta.builtAt,
      freshness: { verdict: 'unknown' },
    },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
      lanes: pack.meta.lanes, base: null, ddl: null, axes: null, laneStats: null,
    },
  };
}

/** A workspace of named projects, and the host that serves them. */
function workspace(t, specs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-fed-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const registry = specs.map((s) => writeProject(work, s.id, s.graph, s));
  const host = createProjectHost({ registry, loadProject, log: () => {} });
  return { work, host, registry };
}

const DEFAULTS = () => [
  { id: 'gateway', graph: callerGraph() },
  { id: 'things', graph: serverGraph() },
];

// ---------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------

test('routes.json: what this pack serves, what it calls, sorted and derived', () => {
  const index = buildRoutesIndex(callerGraph(), { project: 'gateway', buildDigest: 'abc' });
  assert.equal(index.schema, ROUTES_SCHEMA);
  assert.deepEqual(index.serves, [{ id: 'endpoint:GET /api/x', method: 'GET', path: '/api/x' }]);
  assert.deepEqual(index.calls, [{ id: 'endpoint:GET /things/{*}', method: 'GET', path: '/things/{*}', service: 'thingsvc' }]);
  assert.deepEqual(index.serviceNames, []);
  // The server's own index is the mirror image: it serves and calls nothing.
  const server = buildRoutesIndex(serverGraph(), { project: 'things', buildDigest: 'def' });
  assert.deepEqual(server.serves.map((r) => r.path), ['/things/{thingId}']);
  assert.deepEqual(server.calls, []);
});

test('routes.json is DERIVED, so it is not an input to the pack digest', () => {
  const g = callerGraph();
  const a = projectPack(g, { project: 'gateway', builtAt: '2026-09-08T00:00:00.000Z', lanes: ['java'] });
  buildRoutesIndex(g, { project: 'gateway', buildDigest: a.digest });
  const b = projectPack(g, { project: 'gateway', builtAt: '2026-09-08T00:00:00.000Z', lanes: ['java'] });
  assert.equal(a.digest, b.digest, 'writing the index must not change the pack it was derived from');
});

test('a sidecar that is missing, unparsable or of another schema is refused by name', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-fed-idx-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  assert.deepEqual(readRoutesIndex(work).reason, 'no-index');
  fs.writeFileSync(path.join(work, ROUTES_FILE), '{not json');
  assert.equal(readRoutesIndex(work).reason, 'unreadable');
  fs.writeFileSync(path.join(work, ROUTES_FILE), JSON.stringify({ schema: 'something-else' }));
  assert.equal(readRoutesIndex(work).reason, 'unreadable');
  fs.writeFileSync(path.join(work, ROUTES_FILE), JSON.stringify({ schema: ROUTES_SCHEMA, serves: [], calls: [] }));
  assert.equal(readRoutesIndex(work).ok, true);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('the method rule: equal is SOUND_SET, ANY on either side is HEURISTIC, different is no match', () => {
  assert.equal(methodMatch('GET', 'GET'), 'SOUND_SET');
  assert.equal(methodMatch('GET', 'POST'), null);
  assert.equal(methodMatch('ANY', 'GET'), 'HEURISTIC');
  assert.equal(methodMatch('GET', 'ANY'), 'HEURISTIC');
  assert.equal(methodMatch('GET', null), 'HEURISTIC');
});

test('one candidate crosses, none is unmatched, and the check counts what it asked', () => {
  const entries = [
    { id: 'things', index: buildRoutesIndex(serverGraph(), { project: 'things', buildDigest: 'x' }) },
    { id: 'blank', index: null },
  ];
  const hit = serversOf({ method: 'GET', path: '/things/{*}', service: null }, entries);
  assert.deepEqual(hit.chosen.map((c) => [c.project, c.grade]), [['things', 'SOUND_SET']]);
  assert.equal(hit.ambiguous, false);
  assert.equal(hit.checked, 2);
  assert.equal(hit.noIndex, 1, 'a project with no sidecar was asked and could not answer');
  const miss = serversOf({ method: 'GET', path: '/nowhere', service: null }, entries);
  assert.deepEqual(miss.chosen, []);
});

test('two projects serve the route: both are crossed at HEURISTIC unless the service name picks one', () => {
  const entries = [
    { id: 'things', index: buildRoutesIndex(serverGraph(), { project: 'things', buildDigest: 'x' }) },
    { id: 'other', index: buildRoutesIndex(serverGraph({ pkg: 'ot' }), { project: 'other', buildDigest: 'y' }) },
  ];
  const blind = serversOf({ method: 'GET', path: '/things/{*}', service: null }, entries);
  assert.deepEqual(blind.chosen.map((c) => [c.project, c.grade]), [['other', 'HEURISTIC'], ['things', 'HEURISTIC']]);
  assert.equal(blind.ambiguous, true);
  const named = serversOf({ method: 'GET', path: '/things/{*}', service: 'things' }, entries);
  assert.deepEqual(named.chosen.map((c) => [c.project, c.grade]), [['things', 'SOUND_SET']]);
  assert.equal(named.ambiguous, false);
  // A service name that matches NOBODY leaves the answer ambiguous rather than
  // quietly picking the first project.
  const stranger = serversOf({ method: 'GET', path: '/things/{*}', service: 'someone-else' }, entries);
  assert.equal(stranger.ambiguous, true);
  assert.equal(stranger.chosen.length, 2);
});

test('the calls that leave a pack are read off the graph, per symbol and per pack', () => {
  const g = callerGraph();
  assert.deepEqual(outboundCallsOf(g, 'symbol:com.gw.Client#fetch'), [
    { endpoint: 'endpoint:GET /things/{*}', method: 'GET', path: '/things/{*}', service: 'thingsvc' },
  ]);
  assert.deepEqual(outboundCallsOf(g, 'symbol:com.gw.Ctl#get'), []);
  assert.deepEqual(packOutboundCalls(g).map((c) => [c.path, c.service, c.callers.length]), [['/things/{*}', 'thingsvc', 1]]);
  assert.deepEqual(packOutboundCalls(serverGraph()), [], 'a pack that calls nobody has nothing to federate');
});

// ---------------------------------------------------------------------------
// flow, walking down
// ---------------------------------------------------------------------------

test('flow down: the chain keeps going in the project that serves the route', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assertContract(r);
  const a = r.answer;
  // The table lives in the OTHER pack, and the row says so.
  assert.deepEqual(a.tables.map((x) => [x.table, x.project, x.grade, x.viaHttp === true]),
    [['things', 'things', 'SOUND_SET', true]]);
  // The client method is ours; the handler and the service below it are theirs.
  assert.deepEqual(a.services.map((s) => [s.short, s.project ?? 'gateway', s.hops]), [
    ['Client#fetch', 'gateway', 1],
    ['Ctl#get', 'things', 3],
    ['Svc#load', 'things', 4],
  ]);
  // The crossing itself, and the pack it walked into.
  assert.deepEqual(a.federation.crossed, [{
    from: { project: 'gateway', symbol: 'com.gw.Client#fetch' },
    route: { method: 'GET', path: '/things/{*}' },
    service: 'thingsvc',
    to: { project: 'things', endpoint: 'GET /things/{thingId}' },
    grade: 'SOUND_SET',
    ambiguous: false,
  }]);
  assert.deepEqual(a.federation.unmatched, []);
  assert.deepEqual(a.federation.skipped, []);
  assert.deepEqual(r.basis.siblings, [{
    project: 'things', buildDigest: r.basis.siblings[0].buildDigest,
    builtAt: '2026-09-08T00:00:00.000Z', freshness: { verdict: 'unknown' },
  }]);
  assert.ok(r.basis.siblings[0].buildDigest, 'the sibling pack is anchored to its own snapshot');
  // The walk census still describes THIS project only, and says so.
  assert.match(a.walk.note, /come from another project/);
});

test('flow down: the first federated row hangs off the caller, not off the other walk\'s start', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const a = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' }).answer;
  const handler = a.services.find((s) => s.project === 'things' && s.short === 'Ctl#get');
  assert.equal(handler.link.from, 'symbol:com.gw.Client#fetch');
  assert.equal(handler.link.fromProject, 'gateway');
  assert.equal(handler.link.type, 'CALLS_HTTP');
  assert.equal(handler.link.grade, 'SOUND_SET');
  // A row deeper inside the other project hangs off that project's own rows.
  const svc = a.services.find((s) => s.short === 'Svc#load');
  assert.equal(svc.link.fromProject, 'things');
});

test('federate=false answers from this pack alone, and says the calls are still out there', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const a = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', federate: false }).answer;
  assert.deepEqual(a.tables, []);
  assert.deepEqual(a.federation, { available: false, reason: 'turned-off', unmatched: [] });
  assert.deepEqual(a.services.map((s) => s.short), ['Client#fetch']);
});

test('a single-project server still LISTS the call that leaves the pack, with the remedy', (t) => {
  const { host } = workspace(t, [{ id: 'gateway', graph: callerGraph() }]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assertContract(r);
  assert.equal(r.answer.federation.available, false);
  assert.equal(r.answer.federation.reason, 'single-project');
  assert.deepEqual(r.answer.federation.unmatched, [{
    from: { project: 'gateway', symbol: 'com.gw.Client#fetch' },
    route: { method: 'GET', path: '/things/{*}' },
    service: 'thingsvc',
    checked: 0,
    noIndex: 0,
  }]);
  const said = r.limits.filter((l) => l.scope === 'federation');
  assert.equal(said.length, 1);
  assert.match(said[0].reason, /Register the project that serves it/);
  assert.equal(r.basis.siblings, undefined, 'nothing was walked, so nothing is claimed');
});

test('a call nobody serves is listed as unmatched with what was checked', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph({ callPath: '/elsewhere/{*}' }) },
    { id: 'things', graph: serverGraph() },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assert.deepEqual(r.answer.federation.crossed, []);
  assert.deepEqual(r.answer.federation.unmatched.map((u) => [u.route.path, u.checked, u.noIndex]),
    [['/elsewhere/{*}', 1, 0]]);
  assert.match(r.limits.find((l) => l.scope === 'federation').reason, /none of the 1 other registered project\(s\) serves it/);
});

test('two projects serve it: the answer crosses to both, at HEURISTIC, and names them', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph({ service: null }) },
    { id: 'things', graph: serverGraph() },
    { id: 'other', graph: serverGraph({ pkg: 'ot', table: 'others' }) },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assertContract(r);
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.to.project, c.grade, c.ambiguous]),
    [['other', 'HEURISTIC', true], ['things', 'HEURISTIC', true]]);
  assert.deepEqual(r.answer.tables.map((x) => [x.table, x.project, x.grade]),
    [['others', 'other', 'HEURISTIC'], ['things', 'things', 'HEURISTIC']]);
  const said = r.limits.find((l) => l.scope === 'federation');
  assert.match(said.reason, /is served by other, things, and nothing in the call says which/);
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['other', 'things']);
});

test('...and with the service name in the evidence, exactly one of them, at SOUND_SET', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph({ service: 'things' }) },
    { id: 'things', graph: serverGraph() },
    { id: 'other', graph: serverGraph({ pkg: 'ot', table: 'others' }) },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.to.project, c.grade, c.ambiguous]),
    [['things', 'SOUND_SET', false]]);
  assert.deepEqual(r.answer.tables.map((x) => [x.table, x.grade]), [['things', 'SOUND_SET']]);
  assert.deepEqual(r.limits.filter((l) => l.scope === 'federation'), []);
});

/**
 * A GATEWAY'S OWN FRONTEND, through the real web lane (RM46).
 *
 * The call is written with the gateway prefix in the path and no base URL,
 * which is what a gateway-served frontend looks like. `gatewayRoutes` is the
 * table `cascade init` reads out of `spring.cloud.gateway`: the prefix the back
 * end sees, and the service it is forwarded to. Nothing here is hand-written
 * evidence: the service name on the edge is the one the route table stated.
 */
function webCallerGraph({ service = 'thing-service' } = {}) {
  const g = new Graph();
  addWebFacts(g, [
    { kind: 'file', file: 'src/http.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'import', file: 'src/http.js', line: 1, source: 'axios', specifiers: [{ imported: 'default', local: 'axios' }], dynamic: false },
    { kind: 'binding',
      file: 'src/http.js',
      line: 2,
      name: 'client',
      exported: true,
      init: {
        shape: 'call',
        callee: { shape: 'member', root: 'axios', path: ['create'], name: 'create' },
        binding: { kind: 'import', source: 'axios', imported: 'default' },
      } },
    { kind: 'export', file: 'src/http.js', line: 3, name: 'default', of: 'expression', local: 'client' },
    { kind: 'file', file: 'src/api/thing.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'import', file: 'src/api/thing.js', line: 1, source: '../http', specifiers: [{ imported: 'default', local: 'client' }], dynamic: false },
    { kind: 'function', file: 'src/api/thing.js', line: 2, name: 'loadThing', endLine: 4, exported: 'named', async: false, params: 1, returns: null },
    { kind: 'call',
      file: 'src/api/thing.js',
      line: 3,
      enclosing: 'loadThing',
      callee: { shape: 'member', root: 'client', path: ['get'], name: 'get' },
      binding: { kind: 'import', source: '../http', imported: 'default' },
      args: [],
      url: { arg: { kind: 'string', value: '/api/thing/things/7' }, resolved: [{ template: '/api/thing/things/7', dynamicParts: 0, via: 'literal' }] },
      method: { value: 'GET', from: 'callee-name' },
      platformSink: null },
  ], {
    gatewayRoutes: {
      '/api/thing': { to: '', service, from: 'src/main/resources/application.yml' },
    },
  });
  return g;
}

test('a route table read out of the tree puts the service name on a FRONTEND call', () => {
  const g = webCallerGraph();
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, 'endpoint:GET /things/7', 'the declared route rewrote the path the call was written with');
  assert.equal(e.grade, 'UNRESOLVED', 'nothing in this pack serves it, which is what federation is for');
  assert.equal(e.evidence.service, 'thing-service');
  assert.equal(e.evidence.serviceLiteral, true);
  // ...and that is what reaches the sidecar, which is all a sibling ever reads.
  const index = buildRoutesIndex(g, { project: 'web-gateway', buildDigest: 'x' });
  assert.deepEqual(index.calls, [{ id: 'endpoint:GET /things/7', method: 'GET', path: '/things/7', service: 'thing-service' }]);
});

/**
 * THE SAME GATEWAY, WITH SCREENS (RM47). The frontend has no package.json and
 * no imports: a `$stateProvider` chain declares the route, the framework's own
 * registry resolves `<thing-list>` to a component and that component to a
 * controller, and the controller is handed `$http`.
 */
function webScreenGraph({ service = 'thing-service' } = {}) {
  const g = new Graph();
  const f = (name, ...recs) => [
    { kind: 'file', file: name, line: 1, lang: 'js', recoveredErrors: 0 },
    ...recs.map((r) => ({ file: name, ...r })),
  ];
  addWebFacts(g, [
    ...f('static/scripts/app.js', {
      kind: 'route', line: 4, pack: 'angular-router', via: 'chain', receiver: '$stateProvider',
      name: 'things', path: '/things', componentTag: 'thing-list', parent: null, children: 0,
    }),
    ...f('static/scripts/thing.component.js', {
      kind: 'registration', line: 3, framework: 'angular', what: 'component',
      name: 'thingList', controller: 'ThingListCtrl',
    }),
    ...f('static/scripts/thing.controller.js', {
      kind: 'registration', line: 3, framework: 'angular', what: 'controller', name: 'ThingListCtrl',
    }, {
      kind: 'call',
      line: 5,
      enclosing: '(module)',
      callee: { shape: 'member', root: '$http', path: ['get'], name: 'get' },
      binding: null,
      args: [],
      url: { arg: { kind: 'string', value: 'api/thing/things/7' }, resolved: [{ template: 'api/thing/things/7', dynamicParts: 0, via: 'literal' }] },
      method: { value: 'GET', from: 'callee-name' },
      platformSink: null,
      injected: { client: '$http', framework: 'angularjs' },
    }),
  ], {
    gatewayRoutes: { '/api/thing': { to: '', service, from: 'src/main/resources/application.yml' } },
    screenAxis: { enabled: true },
  });
  return g;
}

test('the route a request ENTERED is a row in the endpoint lane, with its project', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assertContract(r);
  // Walking down from a ROUTE there is no endpoint lane of this project's own —
  // a route is where that walk starts. The crossing puts one there: the request
  // left this pack and entered `GET /things/{thingId}` over in `things`, and
  // before RM47 that route appeared in no lane at all.
  assert.deepEqual(r.answer.endpoints.map((e) => [e.id, e.project, e.grade, e.hops, e.federated, e.viaHttp]),
    [['GET /things/{thingId}', 'things', 'SOUND_SET', 2, true, true]]);
  assert.equal(r.answer.endpoints[0].link.type, 'CALLS_HTTP');
  assert.equal(r.answer.endpoints[0].link.from, 'symbol:com.gw.Client#fetch');
  assert.equal(r.answer.endpoints[0].link.fromProject, 'gateway');
  // It is NOT counted in this project's own census: `layers` and `walk`
  // describe this project's walk, exactly as they do for the tables. Every row
  // in the lane carries a project, so nothing here is this pack's own.
  assert.equal(r.answer.endpoints.every((e) => e.project && e.federated === true), true);
  assert.equal(r.answer.layers.reduce((n, l) => n + (l.endpoints ?? 0), 0), 0);
  assert.equal(r.answer.walk.walked, host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', federate: false }).answer.walk.walked,
    'the crossing adds rows, never steps of this project\'s walk');
  assert.match(r.answer.walk.note, /row\(s\) below come from another project/);
  // ...and with federation off the lane is not drawn at all.
  const alone = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', federate: false });
  assert.equal(alone.answer.endpoints, undefined);
});

test('two crossings are two federated endpoint rows, one per route entered', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: twoCallGraph() },
    { id: 'things', graph: serverGraph() },
    { id: 'others', graph: serverGraph({ route: '/others/{otherId}', pkg: 'ot', table: 'others' }) },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assert.deepEqual(r.answer.endpoints.map((e) => [e.id, e.project]), [
    ['GET /others/{otherId}', 'others'],
    ['GET /things/{thingId}', 'things'],
  ]);
});

test('overview says the second number: what reaches a table in a CONNECTED project', (t) => {
  const { host } = workspace(t, [
    { id: 'web-gateway', graph: webScreenGraph() },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-service'] },
  ]);
  const r = host.callTool('overview', { project: 'web-gateway' });
  assertContract(r);
  // This project's own share is unchanged and still 0: none of its screens
  // reaches a table IT owns, because it owns none.
  assert.equal(r.answer.screens.screens, 1);
  assert.equal(r.answer.screens.reachingATable, 0);
  // ...and the second number says where they really end.
  assert.deepEqual(r.answer.reach.viaFederation, { screens: 1, endpoints: 0 });

  // The project that ANSWERS crosses nowhere, so it carries no such block: an
  // absent one is "nothing crosses", never "we did not look".
  const server = host.callTool('overview', { project: 'things' });
  assert.equal(server.answer.reach.viaFederation, undefined);
});

test('overview: a route of this project that ends in another one is counted too', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('overview', { project: 'gateway' });
  assert.equal(r.answer.reach.endpoints, 1);
  assert.equal(r.answer.reach.endpointsWithoutStatement, 1, 'nothing in this pack answers it');
  assert.deepEqual(r.answer.reach.viaFederation, { screens: 0, endpoints: 1 });
  // With federation off, and on a server holding one project, there is no
  // second number to say.
  assert.equal(host.callTool('overview', { project: 'gateway', federate: false }).answer.reach.viaFederation, undefined);
  const alone = workspace(t, [{ id: 'things', graph: serverGraph() }]);
  assert.equal(alone.host.callTool('overview', { project: 'things' }).answer.reach.viaFederation, undefined);
});

test('screen_impact crosses the other way: a column here, the screens that show it over there', (t) => {
  const { host } = workspace(t, [
    { id: 'web-gateway', graph: webScreenGraph() },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-service'] },
  ]);
  // The gateway's own answer first, so the fixture is not doing the work: it
  // has a screen, and the screen reaches a route it does not serve.
  const own = host.callTool('flow', { project: 'web-gateway', screen: '/things' });
  assertContract(own);
  assert.deepEqual(own.answer.tables.map((x) => [x.table, x.project]), [['things', 'things']]);

  // ...and now the same chain read from the far end, out of a project that has
  // no screen axis at all.
  const r = host.callTool('screen_impact', { project: 'things', column: 'things.name' });
  assertContract(r);
  assert.deepEqual(r.answer.screens, [{
    screen: '/things',
    label: '/things',
    grade: 'SOUND_SET',
    endpoints: ['GET /things/{thingId}'],
    project: 'web-gateway',
    viaHttp: true,
    httpHops: 1,
    federated: true,
  }]);
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.from.project, c.from.symbol, c.service]),
    [['web-gateway', 'static/scripts/thing.controller.js#(module)', 'thing-service']]);
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['web-gateway']);
});

test('screen_impact with federation off stops where this pack stops', (t) => {
  const { host } = workspace(t, [
    { id: 'web-gateway', graph: webScreenGraph() },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-service'] },
  ]);
  const r = host.callTool('screen_impact', { project: 'things', column: 'things.name', federate: false });
  assert.deepEqual(r.answer.screens, []);
  assert.equal(r.answer.empty.screens, 'not-shipped', 'this pack has no screen axis of its own');
});

test('two projects serve the path: the DISCOVERED route name picks one, and without it neither is picked', (t) => {
  const named = workspace(t, [
    { id: 'web-gateway', graph: webCallerGraph() },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-service'] },
    { id: 'other', graph: serverGraph({ pkg: 'ot', table: 'others' }) },
  ]);
  const a = named.host.callTool('endpoint_impact', { project: 'things', column: 'things.name' });
  assertContract(a);
  assert.deepEqual(a.answer.federation.crossed.map((c) => [c.from.project, c.to.project, c.grade]),
    [['web-gateway', 'things', 'SOUND_SET']]);
  // The caller is the FRONTEND FUNCTION that makes the call, named as such, and
  // the crossing carries the name the route table gave it.
  assert.deepEqual(a.answer.federation.crossed.map((c) => [c.from.symbol, c.service, c.to.endpoint]),
    [['src/api/thing.js#loadThing', 'thing-service', 'GET /things/{thingId}']]);

  // The same two siblings, with the gateway route naming nobody: the call
  // matches both, so it is crossed to both at HEURISTIC and said to be
  // ambiguous. The NAME is the whole difference.
  const blind = workspace(t, [
    { id: 'web-gateway', graph: webCallerGraph({ service: null }) },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-service'] },
    { id: 'other', graph: serverGraph({ pkg: 'ot', table: 'others' }) },
  ]);
  const b = blind.host.callTool('endpoint_impact', { project: 'things', column: 'things.name' });
  assert.deepEqual(b.answer.federation.crossed.map((c) => [c.from.project, c.to.project, c.grade, c.ambiguous]),
    [['web-gateway', 'things', 'HEURISTIC', true]]);
});

test('a service name declared in the sidecar picks the project just as the id does', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph({ service: 'thing-svc' }) },
    { id: 'things', graph: serverGraph(), serviceNames: ['thing-svc'] },
    { id: 'other', graph: serverGraph({ pkg: 'ot', table: 'others' }) },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.to.project, c.grade]), [['things', 'SOUND_SET']]);
});

// ---------------------------------------------------------------------------
// No index, a stale index, an unreadable pack
// ---------------------------------------------------------------------------

test('a project with no route index is not federated, and every answer says so', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph() },
    { id: 'things', graph: serverGraph(), index: 'none' },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assert.deepEqual(r.answer.tables, []);
  assert.deepEqual(r.answer.federation.skipped, [{ project: 'things', reason: 'no-index' }]);
  assert.deepEqual(r.answer.federation.unmatched.map((u) => [u.checked, u.noIndex]), [[1, 1]]);
  const said = r.limits.filter((l) => l.scope === 'federation').map((l) => l.reason);
  assert.equal(said.length, 2, 'the call that went nowhere, and the project that could not be asked');
  assert.match(said.find((s) => s.startsWith('things is registered')), /Re-run `cascade analyze` for things/);
  // ...and the listing says it too, from the sidecar alone.
  const listed = host.callTool('projects', {}).answer.projects;
  assert.deepEqual(listed.map((p) => [p.id, p.federation.index]), [['gateway', 'present'], ['things', 'absent']]);
});

test('a route index built from another pack is stale: reported, never crossed', (t) => {
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph() },
    { id: 'things', graph: serverGraph(), index: 'stale' },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x' });
  assertContract(r);
  assert.deepEqual(r.answer.tables, []);
  assert.deepEqual(r.answer.federation.skipped, [{ project: 'things', reason: 'stale-index' }]);
  assert.deepEqual(r.answer.federation.crossed, [], 'the crossing was found and then refused');
  assert.match(r.limits.find((l) => /different pack/.test(l.reason)).reason, /Re-run `cascade analyze` for things/);
  assert.equal(r.basis.siblings, undefined, 'a pack that was refused is not a pack this answer walked');
});

test('the `projects` listing counts the sidecar, and loads no pack to do it', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('projects', {});
  assertContract(r);
  assert.deepEqual(r.answer.projects.map((p) => [p.id, p.federation]), [
    ['gateway', { index: 'present', serves: 1, calls: 1 }],
    ['things', { index: 'present', serves: 1, calls: 0 }],
  ]);
  assert.equal(r.answer.cache.loaded, 0, 'listing federation state parses no pack');
});

// ---------------------------------------------------------------------------
// Walking up
// ---------------------------------------------------------------------------

test('endpoint_impact: a column here reaches the route in the project that calls us', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('endpoint_impact', { project: 'things', column: 'things.name' });
  assertContract(r);
  // Same grade, so the order is the id: the two rows differ by `project`.
  assert.deepEqual(r.answer.endpoints.map((e) => [e.id, e.project ?? 'things', e.grade]), [
    ['GET /api/x', 'gateway', 'SOUND_SET'],
    ['GET /things/{thingId}', 'things', 'SOUND_SET'],
  ]);
  assert.equal(r.answer.endpoints.find((e) => e.project === 'gateway').viaHttp, true);
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.from.project, c.from.symbol, c.to.project]),
    [['gateway', 'com.gw.Client#fetch', 'things']]);
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['gateway']);
});

test('flow up: the chain climbs out of this project into the one that calls it', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('flow', { project: 'things', direction: 'up', column: 'things.name' });
  assertContract(r);
  const a = r.answer;
  // hops keep counting through the crossing: statement 1, mapper 2, service 3,
  // controller 4, this project's route 5, then the caller on the other side.
  assert.deepEqual(a.endpoints.map((e) => [e.id, e.project ?? 'things', e.hops]), [
    ['GET /things/{thingId}', 'things', 5],
    ['GET /api/x', 'gateway', 8],
  ]);
  // The method that MAKES the call is a row of its own: without it the chain
  // would jump from this route to the controller above it.
  assert.deepEqual(a.services.filter((s) => s.project).map((s) => [s.short, s.project, s.hops]), [
    ['Client#fetch', 'gateway', 6],
    ['Ctl#get', 'gateway', 7],
  ]);
  assert.equal(a.services.find((s) => s.short === 'Client#fetch').link.fromProject, 'things');
});

test('walking up, federate=false stops at this project\'s own routes', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const a = host.callTool('flow', { project: 'things', direction: 'up', column: 'things.name', federate: false }).answer;
  assert.deepEqual(a.endpoints.map((e) => e.id), ['GET /things/{thingId}']);
  assert.equal(a.federation.reason, 'turned-off');
});

test('federationHops=0 crosses nothing at all', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const a = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', federationHops: 0 }).answer;
  assert.deepEqual(a.tables, []);
  assert.deepEqual(a.federation.crossed, []);
});

test('a chain of crossings: A calls B, B calls C, and one answer walks all three', (t) => {
  // B both serves the route A calls and calls a route C serves.
  const b = serverGraph({ pkg: 'th' });
  b.addNode({ id: 'symbol:com.th.Far#fetch', kind: 'symbol', owner: 'com.th.Far', file: 'th/Far.java', line: 4 });
  b.addNode({ id: 'endpoint:GET /far/{*}', kind: 'endpoint', httpMethod: 'GET', path: '/far/{*}', outbound: true });
  b.addEdge({ from: 'symbol:com.th.Svc#load', to: 'symbol:com.th.Far#fetch', type: 'MAY_CALL', grade: 'SOUND_SET' });
  b.addEdge({
    from: 'symbol:com.th.Far#fetch', to: 'endpoint:GET /far/{*}', type: 'CALLS_HTTP', grade: 'UNRESOLVED',
    evidence: { rule: 'http-client-call', service: 'far', serviceLiteral: true, url: { template: '/far/{*}' } },
  });
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph() },
    { id: 'things', graph: b },
    { id: 'far', graph: serverGraph({ route: '/far/{farId}', pkg: 'fr', table: 'far_rows' }) },
  ]);
  const r = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', depth: 8 });
  assertContract(r);
  assert.deepEqual(r.answer.federation.crossed.map((c) => [c.from.project, c.to.project]),
    [['gateway', 'things'], ['things', 'far']]);
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['far', 'things']);
  // The far project's own code is on this answer, at the hops the two crossings
  // put it at. Its TABLE is not: the second crossing lands at hop 6 and the
  // depth cap of 8 leaves two hops, which reaches its controller and service
  // and stops above the mapper. That is the cap, and `walk.note` says so.
  assert.deepEqual(r.answer.services.filter((s) => s.project === 'far').map((s) => [s.short, s.hops]),
    [['Ctl#get', 7], ['Svc#load', 8]]);
  assert.deepEqual(r.answer.tables.map((x) => [x.table, x.project]), [['things', 'things']]);
  // ...and one crossing of budget stops at the first.
  const one = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', depth: 8, federationHops: 1 }).answer;
  assert.deepEqual(one.federation.crossed.map((c) => c.to.project), ['things']);
  assert.deepEqual(one.services.filter((s) => s.project === 'far'), []);
});

test('the depth cap stops a crossing, and the crossing says it was cut there', (t) => {
  const { host } = workspace(t, DEFAULTS());
  // hop 1 is the client method, so a cap of 1 leaves no budget past the call.
  const a = host.callTool('flow', { project: 'gateway', endpoint: 'GET /api/x', depth: 1 }).answer;
  assert.deepEqual(a.tables, []);
  assert.deepEqual(a.federation.crossed.map((c) => [c.to.project, c.depthCut === true]), [['things', true]]);
});

// ---------------------------------------------------------------------------
// The overview's one sentence
// ---------------------------------------------------------------------------

test('overview counts the calls that leave this project and how many are answered', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const gw = host.callTool('overview', { project: 'gateway' }).answer;
  assert.deepEqual(gw.federation, {
    calls: 1, answered: 1, unmatched: 0, projects: ['things'],
    // RM45: the same census broken down, so the page can list the projects and
    // the routes instead of re-deriving them. `sites` counts the METHODS that
    // make the call, and no field named `calls` ever carries that unit.
    byProject: [{ project: 'things', sites: 1, routes: [{ method: 'GET', path: '/things/{*}', sites: 1 }] }],
    unmatchedRoutes: [],
  });
  const th = host.callTool('overview', { project: 'things' }).answer;
  assert.deepEqual(th.federation, { calls: 0, answered: 0, unmatched: 0, projects: [], byProject: [], unmatchedRoutes: [] });
});

test('overview on a single-project server says the call leaves and nobody answers it', (t) => {
  const { host } = workspace(t, [{ id: 'gateway', graph: callerGraph() }]);
  const a = host.callTool('overview', {}).answer;
  assert.deepEqual(a.federation, {
    calls: 1, answered: 0, unmatched: 1, projects: [], byProject: [],
    // The remedy needs the route, not just the count: this is what the page
    // puts in the "nobody serves this" row.
    // The remedy needs the SERVICE, too: the caller said which deployable it
    // meant, and that is the project a reader has to register.
    unmatchedRoutes: [{ method: 'GET', path: '/things/{*}', sites: 1, service: 'thingsvc' }],
  });

  // A caller that named nobody says so, rather than leaving the field out.
  const blind = workspace(t, [{ id: 'gateway', graph: callerGraph({ service: null }) }]);
  assert.deepEqual(blind.host.callTool('overview', {}).answer.federation.unmatchedRoutes,
    [{ method: 'GET', path: '/things/{*}', sites: 1, service: null }]);
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

test('basis.siblings is held to the same rule as basis: a digest and a freshness verdict', () => {
  // `makeResponse` validates as it builds, so a bad sibling throws at
  // construction. That IS the check the transports run again before the wire.
  const build = (siblings) => makeResponse({
    answer: { things: ['a'] },
    basis: { project: 'p', buildDigest: 'd', freshness: { verdict: 'unknown' }, ...(siblings === undefined ? {} : { siblings }) },
    trust: { trustLevel: NO_STATE_TRUST_LEVEL, axes: ['flow'], gatesNotShown: [], knownGaps: [] },
    limits: [],
    truncated: { any: false, fields: [] },
  });
  assertContract(build(undefined));
  assertContract(build([{ project: 'q', buildDigest: 'e', builtAt: null, freshness: { verdict: 'unknown' } }]));
  assert.throws(() => build([{ project: 'q', buildDigest: null, freshness: { verdict: 'unknown' } }]), /no buildDigest/);
  assert.throws(() => build([{ project: 'q', buildDigest: 'e', freshness: { verdict: 'maybe' } }]), /needs a freshness verdict/);
  assert.throws(() => build([{ buildDigest: 'e', freshness: { verdict: 'unknown' } }]), /needs the project it names/);
  assert.throws(() => build('nope'), /must be an array/);
});

// ---------------------------------------------------------------------------
// The whole-pack pictures (RM45)
// ---------------------------------------------------------------------------

test('map: the sibling\'s route is the portal, and its own picture hangs off it', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('map', { project: 'gateway' });
  assertContract(r);
  const a = r.answer;
  // The sibling's endpoint node IS the portal, namespaced, stamped and marked.
  const portal = a.nodes.find((n) => n.id === 'things|endpoint:GET /things/{thingId}');
  assert.ok(portal, a.nodes.map((n) => n.id).join(' | '));
  assert.equal(portal.kind, 'endpoint');
  assert.equal(portal.project, 'things');
  assert.equal(portal.portal, true);
  // …with that route's own picture under it, and the skeleton it hangs off.
  assert.ok(a.nodes.some((n) => n.id === 'things|table:things' && n.project === 'things'));
  const skeleton = a.nodes.find((n) => n.kind === 'project');
  assert.deepEqual([skeleton.id, skeleton.label, skeleton.endpoints], ['project:things', 'things', 1]);
  // A GROUP DOES NOT TRAVEL: it is one pack's naming convention.
  assert.deepEqual(a.nodes.filter((n) => n.kind === 'group' && n.project).map((n) => n.id), []);

  // One crossing line, from the endpoint that made the call, at the crossing's
  // own grade, and marked as the crossing it is.
  const cross = a.links.filter((l) => l.federated);
  assert.deepEqual(cross.map((l) => [l.source, l.target, l.kind, l.grade, l.ambiguous]),
    [['endpoint:GET /api/x', 'things|endpoint:GET /things/{thingId}', 'calls', 'SOUND_SET', false]]);
  assert.equal(cross[0].project, 'things');
  // The skeleton's member link, and the sibling's own touch, both stamped.
  assert.ok(a.links.some((l) => l.source === 'project:things' && l.target === portal.id && l.kind === 'member'));
  assert.ok(a.links.some((l) => l.source === portal.id && l.target === 'things|table:things' && l.kind === 'touches'));

  assert.deepEqual(a.summary.federated, { projects: ['things'], nodes: 2, links: 3 });
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['things']);
  assert.deepEqual(a.federation.crossed.map((c) => [c.from.project, c.to.project]), [['gateway', 'things']]);
});

test('map: federate=false is the answer this tool gave before federation existed', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const off = host.callTool('map', { project: 'gateway', federate: false });
  assert.equal(off.answer.federation, undefined, 'an empty block is a field that says nothing');
  assert.equal(off.answer.summary.federated, undefined);
  assert.equal(off.basis.siblings, undefined);
  assert.deepEqual(off.answer.nodes.filter((n) => n.project), []);
});

test('map: the node cap takes the connected project first, and names it', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const full = host.callTool('map', { project: 'gateway' }).answer;
  const own = full.nodes.filter((n) => !n.project).length;
  const cut = host.callTool('map', { project: 'gateway', limit: own }).answer;
  // Every one of this project's own nodes survived; the cluster went whole,
  // because a table with no line to it says nothing.
  assert.deepEqual(cut.nodes.filter((n) => n.project), []);
  assert.equal(cut.nodes.length, own);
  assert.deepEqual(cut.summary.federated, { projects: [], nodes: 0, links: 0 });
  const said = host.callTool('map', { project: 'gateway', limit: own })
    .limits.find((l) => /came from another project/.test(l.reason));
  assert.ok(said, 'the cut is not disclosed');
  assert.match(said.reason, /things \(the whole cluster/);
});

test('map: federationHops=0 says the cap, not "nobody serves it"', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('map', { project: 'gateway', federationHops: 0 });
  assert.deepEqual(r.answer.nodes.filter((n) => n.project), []);
  assert.deepEqual(r.answer.federation.crossed, []);
  // The call is NOT unmatched: nobody looked, so "no registered project serves
  // it" is a claim this answer cannot make.
  assert.deepEqual(r.answer.federation.unmatched, []);
  const said = r.limits.find((l) => l.scope === 'federation');
  assert.match(said.reason, /crossing cap \(federationHops 0\) was already spent/);
  assert.match(said.reason, /Raise federationHops and ask again/);
});

test('map: a chain of crossings draws A, B and C, and federationHops bounds it', (t) => {
  const b = serverGraph({ pkg: 'th' });
  b.addNode({ id: 'symbol:com.th.Far#fetch', kind: 'symbol', owner: 'com.th.Far', file: 'th/Far.java', line: 4 });
  b.addNode({ id: 'endpoint:GET /far/{*}', kind: 'endpoint', httpMethod: 'GET', path: '/far/{*}', outbound: true });
  b.addEdge({ from: 'symbol:com.th.Svc#load', to: 'symbol:com.th.Far#fetch', type: 'MAY_CALL', grade: 'SOUND_SET' });
  b.addEdge({
    from: 'symbol:com.th.Far#fetch', to: 'endpoint:GET /far/{*}', type: 'CALLS_HTTP', grade: 'UNRESOLVED',
    evidence: { rule: 'http-client-call', service: 'far', serviceLiteral: true, url: { template: '/far/{*}' } },
  });
  const { host } = workspace(t, [
    { id: 'gateway', graph: callerGraph() },
    { id: 'things', graph: b },
    { id: 'far', graph: serverGraph({ route: '/far/{farId}', pkg: 'fr', table: 'far_rows' }) },
  ]);
  const a = host.callTool('map', { project: 'gateway' }).answer;
  assert.deepEqual(a.nodes.filter((n) => n.kind === 'project').map((n) => n.id),
    ['project:far', 'project:things']);
  assert.ok(a.nodes.some((n) => n.id === 'far|table:far_rows'));
  // The SECOND crossing leaves the first sibling's own route, not this project's.
  const chained = a.links.find((l) => l.federated && l.project === 'far');
  assert.deepEqual([chained.source, chained.target],
    ['things|endpoint:GET /things/{thingId}', 'far|endpoint:GET /far/{farId}']);
  assert.deepEqual(a.summary.federated.projects, ['far', 'things']);

  // …and one crossing of budget stops at the first.
  const one = host.callTool('map', { project: 'gateway', federationHops: 1 }).answer;
  assert.deepEqual(one.summary.federated.projects, ['things']);
  assert.deepEqual(one.nodes.filter((n) => n.project === 'far'), []);
});

test('erd: one cluster per connected project, and no relationship across two', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const r = host.callTool('erd', { project: 'gateway' });
  assertContract(r);
  const a = r.answer;
  // The own answer is untouched: this pack has no schema.
  assert.deepEqual(a.tables, []);
  assert.deepEqual(a.relationships, []);
  assert.equal(a.empty.tables, 'none');
  assert.equal(a.federated.length, 1);
  const c = a.federated[0];
  assert.equal(c.project, 'things');
  assert.deepEqual(c.tables.map((x) => x.table), ['things']);
  // One cluster, one table, so it has no join of its own to show.
  assert.deepEqual(c.relationships, []);
  // `via` is the ONLY thing joining two clusters, and it is an HTTP call.
  assert.deepEqual(c.via, [{
    route: { method: 'GET', path: '/things/{*}' },
    fromEndpoint: 'endpoint:GET /api/x',
    grade: 'SOUND_SET', ambiguous: false, tables: ['things'],
  }]);
  assert.deepEqual(r.basis.siblings.map((s) => s.project), ['things']);
  // Both disclosures are made, in the answer's own words.
  assert.ok(r.limits.some((l) => /No relationship on this answer joins two projects/.test(l.reason)),
    'the answer does not say that no relationship crosses two projects');
  assert.ok(r.limits.some((l) => /mode=conservative, depth 8/.test(l.reason)),
    'the answer does not say which walk built the cluster');
});

test('erd: federate=false, and a focused table, answer from this pack alone', (t) => {
  const { host } = workspace(t, DEFAULTS());
  const off = host.callTool('erd', { project: 'gateway', federate: false }).answer;
  assert.equal(off.federated, undefined);
  assert.equal(off.federation, undefined);
  // `erd table=` is one table's neighbourhood IN THIS PACK: a sibling's table
  // is that project's own question, asked of that project.
  const focus = host.callTool('erd', { project: 'things', table: 'things' }).answer;
  assert.equal(focus.federated, undefined);
  assert.deepEqual(focus.tables.map((x) => x.table), ['things']);
});
