// walks_review4.test.mjs — one question, one answer (RM67-J4, review 4 "walk · 집계 · Trace").
//
// "What does a change to this column reach?" is asked by the impact tools
// (endpoint_impact, screen_impact), by Trace walking up, and by the whole-pack
// census (browse's rows, the overview, the map). Review 4 found the three
// answering it differently: Trace up left out the pages the server renders
// (K-1) and the route of a handler that sends its SQL itself (K-2), a census cut
// by the node cap said "none" (K-3), and a route's link to its handler graded
// the callers above it in one direction only (K-4). These tests hold each of
// them, and `walkAgreement` (src/core/walk_agreement.mjs) holds the three to one
// answer on every column and table of a graph: here on hand-built graphs and on
// the real mall pack when the suite has it, and in test/golden_answers.test.mjs
// on the three fixture trees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { flow } from '../src/mcp/tools.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { buildOverview } from '../src/core/overview.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import { walkScreens } from '../src/core/walks.mjs';
import { walkAgreement } from '../src/core/walk_agreement.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { assembleGraph } from '../src/core/assemble.mjs';
import { addWebFacts, webEndpointId, webSymbolId } from '../src/adapters/web_bridge.mjs';
import { browseCensusDiff } from './helpers/browse_census.mjs';

const ctxOf = (g) => ({ graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack: { digest: 'd' } });
const ask = (g, name, args) => { const r = callTool(name, args, ctxOf(g)); assertContract(r); return r; };
const says = (limits, re) => limits.some((l) => re.test(l.reason));

// ---------------------------------------------------------------------------
// K-1: the pages a server renders
//
//   GET /owners/{id} --HANDLES--> show --MAY_CALL--> OwnerMapper#find --IMPLEMENTS_STMT--> find (READS owners.address)
//   show --RENDERS_PAGE--> page owners/details
//   POST /owners/new --HANDLES--> create --MAY_CALL--> OwnerMapper#insert --IMPLEMENTS_STMT--> insert (WRITES owners.address)
//   GET /owners/new --HANDLES--> initForm --RENDERS_PAGE--> page owners/form
//   page owners/form --RENDERS--> its template --CALLS_HTTP--> POST /owners/new   (the page's own form)
// ---------------------------------------------------------------------------

const DETAILS = nodeId('screen', 'view:owners/details');
const FORM = nodeId('screen', 'view:owners/form');
const SHOW = nodeId('symbol', 'p.OwnerController#show');

function ssrGraph() {
  const g = new Graph();
  const sym = (id, file) => g.addNode({ id: nodeId('symbol', id), file, line: 3, owner: id.split('#')[0] });
  const route = (verb, path, handler) => {
    g.addNode({ id: nodeId('endpoint', `${verb} ${path}`), path, httpMethod: verb, handler });
    g.addEdge({ from: nodeId('endpoint', `${verb} ${path}`), to: nodeId('symbol', handler), type: 'HANDLES', grade: 'EXACT' });
  };
  for (const s of ['p.OwnerController#show', 'p.OwnerController#create', 'p.OwnerController#initForm']) sym(s, 'OwnerController.java');
  for (const s of ['p.OwnerMapper#find', 'p.OwnerMapper#insert']) sym(s, 'OwnerMapper.java');
  route('GET', '/owners/{id}', 'p.OwnerController#show');
  route('POST', '/owners/new', 'p.OwnerController#create');
  route('GET', '/owners/new', 'p.OwnerController#initForm');
  g.addNode({ id: nodeId('table', 'owners') });
  g.addNode({ id: nodeId('column', 'owners.address') });
  g.addEdge({ from: nodeId('table', 'owners'), to: nodeId('column', 'owners.address'), type: 'DECLARES', grade: 'EXACT' });
  for (const [m, access, rel] of [['find', 'read', 'READS'], ['insert', 'write', 'WRITES']]) {
    const st = nodeId('statement', `p.OwnerMapper.${m}`);
    g.addNode({ id: st, statementType: access === 'read' ? 'select' : 'insert' });
    g.addEdge({ from: nodeId('symbol', `p.OwnerMapper#${m}`), to: st, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    g.addEdge({ from: st, to: nodeId('table', 'owners'), type: 'EXECUTES', grade: 'EXACT', evidence: { access } });
    g.addEdge({ from: st, to: nodeId('column', 'owners.address'), type: rel, grade: 'EXACT' });
  }
  g.addEdge({ from: SHOW, to: nodeId('symbol', 'p.OwnerMapper#find'), type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: nodeId('symbol', 'p.OwnerController#create'), to: nodeId('symbol', 'p.OwnerMapper#insert'), type: 'MAY_CALL', grade: 'SOUND_SET' });
  const page = (id, name, paths) => g.addNode({ id, path: paths[0], paths, name, label: name, group: 'owners', source: 'view', lane: 'web', template: `templates/${name}.html`, engine: 'thymeleaf', file: `templates/${name}.html`, line: 1 });
  page(DETAILS, 'owners/details', ['/owners/{id}']);
  page(FORM, 'owners/form', ['/owners/new']);
  g.addEdge({ from: SHOW, to: DETAILS, type: 'RENDERS_PAGE', grade: 'EXACT', evidence: { rule: 'view-name', basis: 'the handler returns this view name' } });
  g.addEdge({ from: nodeId('symbol', 'p.OwnerController#initForm'), to: FORM, type: 'RENDERS_PAGE', grade: 'EXACT', evidence: { rule: 'view-name' } });
  const tpl = nodeId('symbol', 'templates/owners/form.html#(module)');
  g.addNode({ id: tpl, file: 'templates/owners/form.html', line: 1, lane: 'web' });
  g.addEdge({ from: FORM, to: tpl, type: 'RENDERS', grade: 'EXACT' });
  g.addEdge({ from: tpl, to: nodeId('endpoint', 'POST /owners/new'), type: 'CALLS_HTTP', grade: 'SOUND_SET' });
  return g;
}

test('trace_up_names_the_server_rendered_pages_screen_impact_names', () => {
  const g = ssrGraph();
  const up = flow(g, { column: 'owners.address', direction: 'up' }, ctxOf(g)).answer;
  const si = ask(g, 'screen_impact', { column: 'owners.address' }).answer.screens;
  // The page whose handler reads the column, and the page whose own form writes it.
  assert.deepEqual(up.screens.map((s) => [s.id, s.grade, s.link.type]).sort(), [
    ['view:owners/details', 'SOUND_SET', 'RENDERS_PAGE'],
    ['view:owners/form', 'SOUND_SET', 'RENDERS'],
  ]);
  assert.deepEqual(si.map((s) => [s.screen, s.grade, s.endpoints]).sort(), [
    ['/owners/new', 'SOUND_SET', ['POST /owners/new']],
    ['/owners/{id}', 'SOUND_SET', ['GET /owners/{id}']],
  ]);
  // The page row hangs off the method that renders it, and its path is that method's plus the one step.
  const details = up.screens.find((s) => s.id === 'view:owners/details');
  assert.equal(details.link.from, SHOW);
  assert.deepEqual(details.walkedPath.map((e) => e.type), ['READS', 'IMPLEMENTS_STMT', 'MAY_CALL', 'RENDERS_PAGE']);
  assert.equal(details.hops, 4);
});

test('a page starts with the request that rendered it: Trace down from it, and the census row, reach what its handler reads', () => {
  const g = ssrGraph();
  const down = flow(g, { screen: 'view:owners/details' }, ctxOf(g)).answer;
  assert.deepEqual(down.statements.map((s) => s.id), ['p.OwnerMapper.find']);
  assert.deepEqual(down.tables.map((t) => t.table), ['owners']);
  assert.equal(down.services.find((s) => s.id === 'p.OwnerController#show').link.from, DETAILS, 'the handler hangs off the page it rendered');
  assert.equal(down.screens, undefined, 'the page is the entry of its own picture, never a row of it');
  const census = walkScreens(g).screens.find((s) => s.id === DETAILS);
  assert.deepEqual(census.tables.map((t) => t.id), ['table:owners']);
  const row = ask(g, 'browse', { kind: 'column', table: 'owners' }).answer.items.find((c) => c.column === 'owners.address');
  assert.equal(row.screens, 2, 'the census counts the page its handler shows, as screen_impact and Trace do');
  // A walk that REACHES a rendering handler still never walks on through the page.
  const fromRoute = flow(g, { endpoint: 'GET /owners/{id}' }, ctxOf(g)).answer;
  assert.deepEqual(fromRoute.screens.map((s) => s.id), ['view:owners/details']);
  assert.deepEqual(walkAgreement(g).disagreements, 0);
});

// ---------------------------------------------------------------------------
// K-2: a handler that sends its SQL itself
// ---------------------------------------------------------------------------

function senderGraph() {
  const g = new Graph();
  const h = 'symbol:src/users.controller.ts#UsersController.list';
  const st = 'statement:prisma:src/users.controller.ts#UsersController.list/0';
  g.addNode({ id: 'endpoint:GET /users', path: '/users', httpMethod: 'GET' });
  g.addNode({ id: h, file: 'src/users.controller.ts', lane: 'ts' });
  g.addNode({ id: st, statementType: 'select' });
  g.addNode({ id: 'table:User' }); g.addNode({ id: 'column:User.email' });
  g.addEdge({ from: 'table:User', to: 'column:User.email', type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: 'endpoint:GET /users', to: h, type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: h, to: st, type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'prisma.client', line: 12 } });
  g.addEdge({ from: st, to: 'table:User', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: st, to: 'column:User.email', type: 'READS', grade: 'EXACT' });
  return g;
}

test('trace_up_names_the_route_of_a_handler_that_sends_its_sql_itself', () => {
  const g = senderGraph();
  const ei = ask(g, 'endpoint_impact', { column: 'User.email' }).answer.endpoints.map((e) => [e.id, e.grade]);
  const up = flow(g, { column: 'User.email', direction: 'up' }, ctxOf(g)).answer;
  assert.deepEqual(ei, [['GET /users', 'EXACT']]);
  assert.deepEqual(up.endpoints.map((e) => [e.id, e.grade]), ei);
  // The handler is folded into the statement it sends, so the line into the
  // route comes from that statement's row.
  assert.equal(up.endpoints[0].link.from, 'statement:prisma:src/users.controller.ts#UsersController.list/0');
  assert.deepEqual(flow(g, { table: 'User', direction: 'up' }, ctxOf(g)).answer.endpoints.map((e) => e.id), ['GET /users']);
  assert.equal(walkAgreement(g).disagreements, 0);
});

// ---------------------------------------------------------------------------
// K-3: the node cap, said wherever it cut a count
// ---------------------------------------------------------------------------

/** GET /wide -> H -> 4100 helpers; the last helper reaches a statement on table t. A screen calls the route. */
function wideGraph(n = 4100) {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /wide', path: '/wide', httpMethod: 'GET' });
  g.addNode({ id: 'symbol:p.H#h', file: 'H.java' });
  g.addEdge({ from: 'endpoint:GET /wide', to: 'symbol:p.H#h', type: 'HANDLES', grade: 'EXACT' });
  for (let i = 0; i < n; i++) { g.addNode({ id: `symbol:p.C${i}#run`, file: 'C.java' }); g.addEdge({ from: 'symbol:p.H#h', to: `symbol:p.C${i}#run`, type: 'CALLS', grade: 'EXACT' }); }
  g.addNode({ id: 'statement:p.M.find', statementType: 'select' });
  g.addNode({ id: 'table:t' }); g.addNode({ id: 'column:t.c' });
  g.addEdge({ from: 'table:t', to: 'column:t.c', type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: `symbol:p.C${n - 1}#run`, to: 'statement:p.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { line: 3 } });
  g.addEdge({ from: 'statement:p.M.find', to: 'table:t', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  g.addEdge({ from: 'statement:p.M.find', to: 'column:t.c', type: 'READS', grade: 'EXACT' });
  g.addNode({ id: 'screen:/wide', path: '/wide' });
  g.addNode({ id: 'symbol:web/W.vue#setup', file: 'web/W.vue', lane: 'web' });
  g.addEdge({ from: 'screen:/wide', to: 'symbol:web/W.vue#setup', type: 'RENDERS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:web/W.vue#setup', to: 'endpoint:GET /wide', type: 'CALLS_HTTP', grade: 'EXACT' });
  return g;
}

test('browse_census_says_node_cap_when_a_row_is_undercounted', () => {
  const g = wideGraph();
  const r = ask(g, 'browse', { kind: 'table' });
  const row = r.answer.items.find((x) => x.table === 't');
  const ei = ask(g, 'endpoint_impact', { column: 't.c' }).answer.endpoints.length;
  assert.equal(ei, 1);
  assert.equal(row.endpoints, 0, 'the census walk from the route stopped before the helper that reaches t');
  assert.ok(says(r.limits, /node cap reached in 1 route walk/), JSON.stringify(r.limits.map((l) => l.reason)));
  const screens = ask(g, 'browse', { kind: 'screen' });
  assert.equal(screens.answer.items[0].tables, 0);
  assert.ok(says(screens.limits, /node cap reached in 1 screen walk/));
});

test('summary_says_node_cap_when_a_family_is_missing', () => {
  const g = wideGraph();
  const r = ask(g, 'summary', {});
  assert.equal(r.answer.families.some((f) => f.tables.includes('table:t')), false);
  assert.ok(says(r.limits, /node cap reached in 1 route walk/));
});

test('overview_screens_says_node_cap', () => {
  const o = buildOverview(wideGraph());
  assert.equal(o.screens.walk.nodeCapStarts, 1);
  const gap = (o.gaps ?? []).find((x) => x.kind === 'node-cap');
  assert.ok(gap && /1 handler walk\(s\) and 1 screen walk\(s\)/.test(gap.note), JSON.stringify(gap));
  assert.equal(gap.count, 2);
});

test('an impact answer cut by the node cap says so, and is still the rows Trace draws', () => {
  // One mapper method a column is read through, called by 4100 handlers of 4100 routes.
  const g = new Graph();
  g.addNode({ id: 'column:t.c' }); g.addNode({ id: 'table:t' });
  g.addEdge({ from: 'table:t', to: 'column:t.c', type: 'DECLARES', grade: 'EXACT' });
  g.addNode({ id: 'statement:p.M.find', statementType: 'select' });
  g.addEdge({ from: 'statement:p.M.find', to: 'column:t.c', type: 'READS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.M#find', to: 'statement:p.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  for (let i = 0; i < 4100; i++) {
    g.addNode({ id: `endpoint:GET /r${i}`, path: `/r${i}`, httpMethod: 'GET' });
    g.addEdge({ from: `endpoint:GET /r${i}`, to: `symbol:p.C${i}#h`, type: 'HANDLES', grade: 'EXACT' });
    g.addEdge({ from: `symbol:p.C${i}#h`, to: 'symbol:p.M#find', type: 'CALLS', grade: 'EXACT' });
  }
  const ei = ask(g, 'endpoint_impact', { column: 't.c', limit: 100 });
  const up = flow(g, { column: 't.c', direction: 'up' }, ctxOf(g)).answer;
  const total = ei.truncated.fields.find((f) => f.field === 'endpoints').total;
  assert.ok(total < 4100, `${total} routes: the walk stopped at the cap`);
  assert.equal(total, flow(g, { column: 't.c', direction: 'up', limit: 200 }, ctxOf(g)).truncated.fields.find((f) => f.field === 'endpoints').total,
    'the same walk, so the same rows');
  assert.ok(says(ei.limits, /node cap reached: the walk up from here recorded 4000 nodes/));
  assert.match(up.walk.note, /node cap reached/);
});

// ---------------------------------------------------------------------------
// K-5, K-6, K-7: one floor and one depth for every count
// ---------------------------------------------------------------------------

test('services_count_only_senders_whose_send_the_mode_admits', () => {
  const g = new Graph();
  for (const id of ['endpoint:GET /x', 'symbol:src/c.ts#C.x', 'symbol:src/a.ts#A.run', 'symbol:src/b.ts#B.run', 'statement:prisma:src/a.ts#A.run/0', 'table:T']) g.addNode({ id, ...(id.startsWith('symbol') ? { file: id.slice(7, id.indexOf('#')), lane: 'ts' } : {}) });
  g.addEdge({ from: 'endpoint:GET /x', to: 'symbol:src/c.ts#C.x', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:src/c.ts#C.x', to: 'symbol:src/a.ts#A.run', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:src/c.ts#C.x', to: 'symbol:src/b.ts#B.run', type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:src/a.ts#A.run', to: 'statement:prisma:src/a.ts#A.run/0', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { line: 3 } });
  g.addEdge({ from: 'symbol:src/b.ts#B.run', to: 'statement:prisma:src/a.ts#A.run/0', type: 'IMPLEMENTS_STMT', grade: 'HEURISTIC', evidence: { line: 9 } });
  g.addEdge({ from: 'statement:prisma:src/a.ts#A.run/0', to: 'table:T', type: 'EXECUTES', grade: 'EXACT' });
  assert.deepEqual(chainWalk(g, { start: 'symbol:src/c.ts#C.x', mode: 'conservative' }).senders, ['symbol:src/a.ts#A.run']);
  assert.deepEqual(chainWalk(g, { start: 'symbol:src/c.ts#C.x', mode: 'heuristic' }).senders, ['symbol:src/a.ts#A.run', 'symbol:src/b.ts#B.run']);
});

test('browse table and column rows count statements in the census mode, as their endpoints', () => {
  const g = new Graph();
  g.addNode({ id: 'table:t' }); g.addNode({ id: 'column:t.a' });
  g.addEdge({ from: 'table:t', to: 'column:t.a', type: 'DECLARES', grade: 'EXACT' });
  for (const [s, grade, access, rel] of [['s1', 'EXACT', 'read', 'READS'], ['s2', 'HEURISTIC', 'write', 'WRITES']]) {
    g.addNode({ id: `statement:${s}`, statementType: 'select' });
    g.addEdge({ from: `statement:${s}`, to: 'table:t', type: 'EXECUTES', grade, evidence: { access } });
    g.addEdge({ from: `statement:${s}`, to: 'column:t.a', type: rel, grade });
  }
  const t = ask(g, 'browse', { kind: 'table' });
  assert.deepEqual([t.answer.items[0].statementsRead, t.answer.items[0].statementsWrite], [1, 0], 'the guessed writer is no statement of a conservative row');
  assert.ok(says(t.limits, /statement counts .* are counted in the same mode/));
  const c = ask(g, 'browse', { kind: 'column', table: 't' }).answer.items[0];
  assert.deepEqual([c.reads, c.writes], [1, 0]);
});

test('summary takes a depth from 1 to 8, as every other walk does', () => {
  const g = ssrGraph();
  assert.throws(() => callTool('summary', { depth: 9 }, ctxOf(g)), (e) => e.code === 'bad-input' && /1 to 8/.test(e.message));
  assert.equal(ask(g, 'summary', { depth: 8 }).answer.depth, 8);
});

// ---------------------------------------------------------------------------
// J-3 and K-4 on the web lane: a catch-all under a prefix nobody declared, and
// a route whose address its lane could not settle
// ---------------------------------------------------------------------------

function routesGraph(routes) {
  const g = new Graph();
  for (const [httpMethod, path, handler, evidence] of routes) {
    const id = webEndpointId(httpMethod, path);
    g.addNode({ id, path, httpMethod, handler });
    g.addEdge({ from: id, to: `symbol:${handler}`, type: 'HANDLES', grade: evidence?.address ? evidence.address.grade : 'EXACT', evidence: evidence ?? null });
  }
  return g;
}

/** A frontend file that calls each URL with fetch, one function per call. */
function fetchCalls(urls) {
  const recs = [{ kind: 'file', file: 'src/api.js', line: 1, lang: 'js', recoveredErrors: 0 }];
  urls.forEach(([method, url], i) => {
    recs.push({ file: 'src/api.js', kind: 'function', line: 10 * i + 1, name: `f${i}`, endLine: 10 * i + 3, exported: 'named', async: false, params: 0, returns: null });
    recs.push({
      file: 'src/api.js', kind: 'call', line: 10 * i + 2, enclosing: `f${i}`, callee: { shape: 'ident', root: 'fetch', path: [], name: 'fetch' },
      binding: { kind: 'global' }, args: [], url: { arg: { kind: 'string', value: url }, resolved: [{ template: url, dynamicParts: 0, via: 'literal' }] },
      method: { value: method, from: 'option' }, platformSink: 'fetch',
    });
  });
  return recs;
}

const CATCH_ALL_ROUTES = [
  ['ANY', '/admin-api/promotion/**', 'p.DefaultController#promotion404'],
  ['ANY', '/admin-api/other/**', 'p.DefaultController#other404'],
  ['POST', '/promotion/article/create', 'p.ArticleController#create'],
];
const CALLS = [['POST', '/admin-api/promotion/article/create'], ['POST', '/admin-api/other/thing']];
const callEdges = (g) => g.edges.filter((e) => e.type === 'CALLS_HTTP').map((e) => [e.to, e.grade, e.evidence.catchAll ? 'catchAll' : e.evidence.prefixShift ? `shift ${e.evidence.prefixShift.dropped}` : '-']).sort();

test('catch_all_route_is_not_the_sole_candidate_when_prefixes_are_set_in_code', () => {
  // With every route's address settled, a catch-all a call alone matches is the one Spring serves.
  const settled = routesGraph(CATCH_ALL_ROUTES);
  addWebFacts(settled, fetchCalls(CALLS));
  assert.deepEqual(callEdges(settled), [
    [webEndpointId('ANY', '/admin-api/other/**'), 'SOUND_SET', '-'],
    [webEndpointId('ANY', '/admin-api/promotion/**'), 'SOUND_SET', '-'],
  ]);
  // A prefix set in code and not read: the more specific route the call reaches
  // with its leading segment taken off is a candidate too, and the set is a guess.
  const shifted = routesGraph(CATCH_ALL_ROUTES);
  addWebFacts(shifted, fetchCalls(CALLS), { unreadRoutePrefix: 'Web.java:53 calls RequestMappingHandlerMapping.setPathPrefixes' });
  assert.deepEqual(callEdges(shifted), [
    [webEndpointId('ANY', '/admin-api/other/**'), 'SOUND_SET', '-'],
    [webEndpointId('ANY', '/admin-api/promotion/**'), 'HEURISTIC', 'catchAll'],
    [webEndpointId('POST', '/promotion/article/create'), 'HEURISTIC', 'shift /admin-api'],
  ], 'no route of the pack is more specific than /admin-api/other/**, prefix or not, so it stays the only candidate');
  const e = shifted.edges.find((x) => x.to === webEndpointId('POST', '/promotion/article/create'));
  assert.equal(e.evidence.match, 'exact-shifted');
  assert.equal(e.evidence.candidates, 2);
  assert.match(e.evidence.prefixShift.unsettled, /setPathPrefixes/);
});

test('a path prefix set in code reaches the web matcher through the assembly, and a declared one settles it', () => {
  const javaFacts = [
    { kind: 'invocations', names: ['setPathPrefixes'], lines: [53], receivers: [[['RequestMappingHandlerMapping', 53]]], file: 'cfg/Web.java' },
    { kind: 'import', owner: 'x.cfg/Web.java', simple: 'RequestMappingHandlerMapping', fqn: 'org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping', file: 'cfg/Web.java' },
  ];
  const run = (pathPrefixes) => assembleGraph({
    bridges: { buildGraphFromSql: () => routesGraph(CATCH_ALL_ROUTES), addJavaFacts: () => ({}), addWebFacts },
    javaFacts, java: { pathPrefixes }, web: {}, webFacts: fetchCalls(CALLS.slice(0, 1)),
  }).graph;
  assert.deepEqual(callEdges(run([])).map((x) => x[1]), ['HEURISTIC', 'HEURISTIC']);
  assert.match(run([]).edges.find((x) => x.evidence?.catchAll).evidence.catchAll.unsettled, /cfg\/Web\.java:53 calls RequestMappingHandlerMapping\.setPathPrefixes/);
  assert.deepEqual(callEdges(run([{ prefix: '/admin-api' }])), [[webEndpointId('ANY', '/admin-api/promotion/**'), 'SOUND_SET', '-']]);
});

test('a call onto a route whose address its lane could not settle carries that doubt on its own link, in every walk', () => {
  const why = 'the global prefix "api" excludes 1 route pattern(s) this engine cannot read';
  const g = routesGraph([['GET', '/api/users', 'src/users.ts#Users.list', { rule: 'nestjs.routes', address: { grade: 'HEURISTIC', why } }]]);
  addWebFacts(g, fetchCalls([['GET', '/api/users']]));
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.deepEqual([e.grade, e.evidence.address], ['HEURISTIC', why]);
  g.addNode({ id: 'screen:/users', path: '/users' });
  g.addEdge({ from: 'screen:/users', to: webSymbolId('src/api.js', 'f0'), type: 'RENDERS', grade: 'EXACT' });
  const up = flow(g, { endpoint: 'GET /api/users', direction: 'up', mode: 'heuristic' }, ctxOf(g)).answer;
  const down = flow(g, { screen: '/users', mode: 'heuristic' }, ctxOf(g)).answer;
  assert.deepEqual([up.screens[0].grade, down.endpoints[0].grade], ['HEURISTIC', 'HEURISTIC']);
  assert.match(up.walk.note, /own address is graded HEURISTIC/);
});

// ---------------------------------------------------------------------------
// the check, on a real pack
// ---------------------------------------------------------------------------

test('walk_agreement: the census the impact tools are held to is the one browse counts its rows on, in every mode (RM67-U2i)', () => {
  for (const mode of ['strict', 'conservative', 'heuristic']) {
    for (const [name, g] of [['ssr', ssrGraph()], ['sender', senderGraph()]]) {
      const d = browseCensusDiff(g, mode);
      assert.ok(d.rows >= 2, `${name}: ${d.rows} rows`);
      assert.deepEqual(d.differences, [], `${name} ${mode}`);
    }
  }
});

test('walk_agreement: the impact tools, Trace and the census give one answer on every column and table of the mall pack', (t) => {
  const file = process.env.CASCADE_MALL_PACK;
  if (!file || !fs.existsSync(file)) { t.skip('no mall pack: set CASCADE_MALL_PACK to run the check on a real pack'); return; }
  const g = loadPack(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const mode of ['strict', 'conservative', 'heuristic']) {
    const r = walkAgreement(g, { mode });
    assert.ok(r.targets > 100, `${r.targets} targets`);
    assert.equal(r.disagreements, 0, `${mode}: ${JSON.stringify(r.examples)}`);
    // …and browse's rows are that census, in the same mode.
    const d = browseCensusDiff(g, mode);
    assert.equal(d.rows, r.targets, 'every table and column is a browse row');
    assert.deepEqual(d.differences.slice(0, 5), [], `${mode}: ${d.differences.length} rows differ`);
  }
});
