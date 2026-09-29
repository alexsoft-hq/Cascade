// contract_links.test.mjs — a document's route joined to the controller method that implements the interface a generator writes from it, graded as the guess it is.
//
// Three things are held here. The rule reads what it says (the generator's
// naming, an interface outside the tree, a method named by the operationId) and
// nothing more: the cases that must not link are as important as the ones that
// must. The link lands on the graph as a HEURISTIC HANDLES edge that names the
// rule, the operationId, the documents and the interface, and a project with no
// such contract gets exactly the pack it got before. And a walk treats the
// route's link to its handler as a link: a conservative census does not reach
// through a guess, and a heuristic one grades what it reaches by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { buildRegistry, builtinRegistry, RuleError } from '../src/core/rules/registry.mjs';
import { rulesCatalog } from '../src/core/rules/catalog.mjs';
import { deriveContractLinks, operationsOf } from '../src/core/rules/kinds/java_contract_link.mjs';
import { readOpenApiDocument, addOpenApiRoutes } from '../src/adapters/openapi_bridge.mjs';
import { walkEndpoints } from '../src/core/walks.mjs';
import { flow, overview } from '../src/mcp/tools.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { assembleGraph } from '../src/core/assemble.mjs';
import { assembleJavaFacts } from '../src/core/facts_store.mjs';
import { overlayGraph } from '../src/core/overlay.mjs';
import { LANE_BRIDGES } from '../src/cli/lanes_run.mjs';
import { overlayState, unreadInputLimits } from '../src/cli/overlay_provider.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const CLI = fileURLToPath(new URL('../bin/cascade.mjs', import.meta.url));
const RULE = 'openapi-generator.spring-interface';
const rules = () => builtinRegistry().ofKind('java.contract-link');
const interfaceNames = (op) => [...builtinRegistry().rules.get(RULE).compiled.interfaceNames({ tags: [], resource: '/x', ...op })].sort();

/** A worker `type` record and an `import` record, the shapes the Java worker writes. */
const type = (fqn, over = {}) => ({
  kind: 'type', fqn, package: fqn.slice(0, fqn.lastIndexOf('.')), typeKind: 'class', abstract: false,
  implements: [], implementsArgs: [], extends: null, extendsArgs: [], typeParams: [], declaredMethods: [],
  file: `src/main/java/${fqn.replace(/\./g, '/')}.java`, ...over,
});
const imported = (owner, fqn) => ({ kind: 'import', owner, simple: fqn.slice(fqn.lastIndexOf('.') + 1), fqn, file: `src/main/java/${owner.replace(/\./g, '/')}.java` });

const OWNERS_DOC = 'openapi: 3.0.1\nservers:\n  - url: http://localhost:9966/petclinic/api\npaths:\n  /owners:\n    get:\n      tags:\n        - owners\n      operationId: listOwners\n  /owners/{ownerId}:\n    delete:\n      tags: [owners]\n      operationId: deleteOwner\n';
const doc = (text, p = 'src/main/resources/openapi.yml') => readOpenApiDocument(text, { path: p });

/** The petclinic-rest shape: a controller implementing a generated OwnersApi. */
const ownerFacts = (over = {}) => [
  imported('p.web.OwnerController', 'p.api.OwnersApi'),
  type('p.web.OwnerController', { annotations: ['RestController'], implements: ['OwnersApi'], implementsArgs: [[]], declaredMethods: ['listOwners/1', 'deleteOwner/1', 'audit/0'], declaredMethodLines: [20, 30, 40], ...over }),
];

// ---------------------------------------------------------------------------
// what the document reader keeps
// ---------------------------------------------------------------------------

test('the reader keeps each operation\'s tags and the path as the document writes it, before the base path', () => {
  const d = doc(OWNERS_DOC);
  const list = d.paths.find((p) => p.operationId === 'listOwners');
  assert.deepEqual([list.path, list.resource, list.tags], ['/petclinic/api/owners', '/owners', ['owners']]);
  assert.deepEqual(d.paths.find((p) => p.operationId === 'deleteOwner').tags, ['owners'], 'a flow sequence of tags too');
});

test('two documents that give one route two operationIds keep both, each as its own document\'s', () => {
  const a = doc('openapi: 3.0.0\npaths:\n  /x:\n    get:\n      operationId: first\n', 'a.yaml');
  const b = doc('openapi: 3.0.0\npaths:\n  /x:\n    get:\n      operationId: second\n', 'b.yaml');
  assert.deepEqual(operationsOf([a, b]).map((o) => [o.document, o.operationId, o.endpoint]),
    [['a.yaml', 'first', 'endpoint:GET /x'], ['b.yaml', 'second', 'endpoint:GET /x']]);
  const g = new Graph();
  addOpenApiRoutes(g, [a, b]);
  assert.equal(g.nodes.get('endpoint:GET /x').operationId, 'first', 'the node still shows one, the first document\'s');
});

// ---------------------------------------------------------------------------
// the generator's naming
// ---------------------------------------------------------------------------

test('an interface is named as openapi-generator names it: from each tag, or from the path\'s first segment', () => {
  assert.deepEqual(interfaceNames({ tags: ['owner-v2'], resource: '/v2/owners' }), ['OwnerV2Api', 'V2Api']);
  assert.deepEqual(interfaceNames({ tags: ['pettypes'], resource: '/pettypes' }), ['PettypesApi']);
  assert.deepEqual(interfaceNames({ tags: ['petTypes'], resource: '/pet-types/{id}' }), ['PetTypesApi']);
  assert.deepEqual(interfaceNames({ tags: ['HTTPServer', 'pet store'], resource: '/pets' }), ['HttpServerApi', 'PetStoreApi', 'PetsApi']);
  assert.deepEqual(interfaceNames({ tags: ['2fa'], resource: '/{id}' }), ['Class2faApi', 'IdApi']);
  assert.deepEqual(interfaceNames({ tags: [], resource: '/' }), ['DefaultApi'], 'no tag is the tag default, and no path segment is default too');
});

test('a contract rule is a guess: graded above HEURISTIC, or silent about the generator it relies on, it is refused', () => {
  const entry = builtinRegistry().rules.get(RULE).rule;
  const refused = (rule) => {
    try { buildRegistry([{ where: 'c.json', pack: { pack: 'openapi-generator', version: 1, description: 'x', rules: [rule] } }]); } catch (e) { if (e instanceof RuleError) return e.problems; throw e; }
    return [];
  };
  assert.deepEqual(refused(entry), []);
  assert.ok(refused({ ...entry, grade: 'SOUND_SET' }).some((p) => /above what a java\.contract-link rule may give \(HEURISTIC\)/.test(p)));
  const { generator, ...rest } = entry.params;
  assert.ok(refused({ ...entry, params: rest }).some((p) => /params\.generator must say which generator/.test(p)), `generator was ${generator.name}`);
  assert.ok(refused({ ...entry, params: { ...entry.params, interfaceName: { from: ['tags'], suffix: 'Api' } } }).some((p) => /params\.interfaceName\.from/.test(p)));
});

// ---------------------------------------------------------------------------
// what the rule links, and what it must not
// ---------------------------------------------------------------------------

test('a controller implementing a generated interface handles the operation its method is named for, and only that', () => {
  const { links, unlinked } = deriveContractLinks(ownerFacts(), operationsOf([doc(OWNERS_DOC)]), rules());
  assert.deepEqual(links.map((l) => [l.endpoint, l.handler, l.grade, l.interface, l.documents]), [
    ['endpoint:DELETE /petclinic/api/owners/{ownerId}', 'p.web.OwnerController#deleteOwner', 'HEURISTIC', 'p.api.OwnersApi', ['src/main/resources/openapi.yml']],
    ['endpoint:GET /petclinic/api/owners', 'p.web.OwnerController#listOwners', 'HEURISTIC', 'p.api.OwnersApi', ['src/main/resources/openapi.yml']],
  ]);
  assert.deepEqual(unlinked, [], 'a method no operation is named for is not a near miss, just a method');
});

test('nothing links through an interface the project declares, an abstract class, or a class that implements none', () => {
  const ops = operationsOf([doc(OWNERS_DOC)]);
  const inTree = [...ownerFacts(), type('p.api.OwnersApi', { typeKind: 'interface' })];
  assert.deepEqual(deriveContractLinks(inTree, ops, rules()).links, [], 'the interface is in the tree: its own mapping is the Java lane\'s to read');
  assert.deepEqual(deriveContractLinks(ownerFacts({ abstract: true }), ops, rules()).links, []);
  assert.deepEqual(deriveContractLinks([type('p.web.Helper', { declaredMethods: ['listOwners/0'] })], ops, rules()), { links: [], unlinked: [] });
});

test('an operationId on two routes of two documents is said, and not settled by picking one; one route in two documents is one link', () => {
  const v1 = doc(OWNERS_DOC.replace('/petclinic/api', '/v1'), 'api/v1.yaml');
  const v2 = doc(OWNERS_DOC.replace('/petclinic/api', '/v2'), 'api/v2.yaml');
  const two = deriveContractLinks(ownerFacts(), operationsOf([v1, v2]), rules());
  assert.deepEqual(two.links, []);
  assert.deepEqual(two.unlinked.map((u) => [u.handler, u.reason, u.operations.map((o) => o.document)]), [
    ['p.web.OwnerController#deleteOwner', 'ambiguous', ['api/v1.yaml', 'api/v2.yaml']],
    ['p.web.OwnerController#listOwners', 'ambiguous', ['api/v1.yaml', 'api/v2.yaml']],
  ]);
  const copy = deriveContractLinks(ownerFacts(), operationsOf([doc(OWNERS_DOC, 'a.yml'), doc(OWNERS_DOC, 'b.yml')]), rules());
  assert.deepEqual(copy.links.map((l) => [l.handler, l.documents]), [
    ['p.web.OwnerController#deleteOwner', ['a.yml', 'b.yml']], ['p.web.OwnerController#listOwners', ['a.yml', 'b.yml']],
  ]);
});

test('a method named like an operationId, on an interface that operation would not be generated into, is said and not linked', () => {
  const facts = [imported('p.web.Billing', 'ext.BillingApi'), type('p.web.Billing', { annotations: ['RestController'], implements: ['BillingApi'], declaredMethods: ['listOwners/0'] })];
  const { links, unlinked } = deriveContractLinks(facts, operationsOf([doc(OWNERS_DOC)]), rules());
  assert.deepEqual(links, []);
  assert.deepEqual(unlinked.map((u) => [u.reason, u.interface, u.names]), [['interface-name', 'ext.BillingApi', ['OwnersApi']]]);
  const both = [imported('p.web.Both', 'p.api.OwnersApi'), imported('p.web.Both', 'p.api.PetsApi'),
    type('p.web.Both', { annotations: ['RestController'], implements: ['OwnersApi', 'PetsApi'], declaredMethods: ['listOwners/0'] })];
  const r = deriveContractLinks(both, operationsOf([doc(OWNERS_DOC)]), rules());
  assert.equal(r.links.length, 1);
  assert.deepEqual(r.unlinked, [], 'a method one interface links is not also said to miss the other');
});

test('a class that implements a generated interface handles its routes only when it carries an annotation of a served class: a client does not', () => {
  const ops = operationsOf([doc(OWNERS_DOC)]);
  const client = (annotations) => [imported('p.client.OwnerClient', 'p.api.OwnersApi'),
    type('p.client.OwnerClient', { annotations, implements: ['OwnersApi'], implementsArgs: [[]], declaredMethods: ['listOwners/1'] })];
  assert.deepEqual(deriveContractLinks(client([]), ops, rules()), { links: [], unlinked: [] }, 'class OwnerClient implements OwnersApi is a client of the API, not its server');
  assert.deepEqual(deriveContractLinks(client(['FeignClient']), ops, rules()), { links: [], unlinked: [] });
  assert.deepEqual(deriveContractLinks(client(['Controller']), ops, rules()).links.map((l) => l.handler), ['p.client.OwnerClient#listOwners'], 'a @Controller is served');
  const entry = builtinRegistry().rules.get(RULE).rule;
  assert.deepEqual(entry.params.serverClass.annotations, ['RestController', 'Controller'], 'which annotations mark a served class is the pack\'s data');
  assert.ok(entry.examples.some((ex) => /class OwnerClient implements OwnersApi/.test(ex.source) && ex.expect.length === 0), 'and the pack holds a client that is not linked');
});

test('a contract rule that does not say which classes are served is refused', () => {
  const entry = builtinRegistry().rules.get(RULE).rule;
  const refused = (params) => {
    try { buildRegistry([{ where: 'c.json', pack: { pack: 'openapi-generator', version: 1, description: 'x', rules: [{ ...entry, params }] } }]); } catch (e) { if (e instanceof RuleError) return e.problems; throw e; }
    return [];
  };
  const { serverClass, ...rest } = entry.params;
  assert.ok(refused(rest).some((p) => /params\.serverClass must say/.test(p)), `serverClass was ${JSON.stringify(serverClass)}`);
  assert.ok(refused({ ...rest, serverClass: { annotations: [] } }).some((p) => /params\.serverClass\.annotations/.test(p)));
  assert.ok(refused({ ...rest, serverClass: { annotations: ['org.x.RestController'] } }).some((p) => /params\.serverClass\.annotations/.test(p)));
});

test('existing_exact_handles_does_not_become_contract_gap: a route the code already maps to that method is not counted as a contract link, and the overview does not call it a guess', () => {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /owners', path: '/owners', httpMethod: 'GET' });
  g.addNode({ id: 'symbol:p.web.OwnerController#listOwners', symbol: 'p.web.OwnerController#listOwners', owner: 'p.web.OwnerController', file: 'C.java' });
  g.addEdge({ from: 'endpoint:GET /owners', to: 'symbol:p.web.OwnerController#listOwners', type: 'HANDLES', grade: 'EXACT' });
  const stats = addOpenApiRoutes(g, [doc('openapi: 3.0.0\npaths:\n  /owners:\n    get:\n      tags: [owners]\n      operationId: listOwners\n')], { java: {}, javaFacts: ownerFacts() });
  assert.deepEqual(g.edges.filter((e) => e.type === 'HANDLES').map((e) => e.grade), ['EXACT'], 'one handler, the one the code maps');
  assert.deepEqual(stats.contractLinks, {
    links: 0, endpoints: [], byRule: { [RULE]: { links: 0, unlinked: 0, alreadyHandled: 1 } }, unlinked: [],
    alreadyHandled: [{ endpoint: 'endpoint:GET /owners', handler: 'p.web.OwnerController#listOwners', rule: RULE }],
    undeclared: 0,
  });
  const ctx = { ...walkCtx(g), pack: { digest: 'd', laneStats: { openapi: stats } } };
  for (const mode of ['conservative', 'heuristic']) {
    assert.equal(overview(g, { mode }, ctx).answer.gaps.find((x) => x.kind === 'contract-links'), undefined, `mode=${mode}`);
  }
});

// ---------------------------------------------------------------------------
// on the graph
// ---------------------------------------------------------------------------

test('the bridge draws a HEURISTIC HANDLES edge naming the rule, the operationId, the documents and the interface', () => {
  const g = new Graph();
  const stats = addOpenApiRoutes(g, [doc(OWNERS_DOC)], { java: {}, javaFacts: ownerFacts() });
  const edge = g.edges.find((e) => e.type === 'HANDLES' && e.to === 'symbol:p.web.OwnerController#listOwners');
  assert.equal(edge.from, 'endpoint:GET /petclinic/api/owners');
  assert.equal(edge.grade, 'HEURISTIC');
  assert.equal(edge.evidence.rule, RULE);
  assert.equal(edge.evidence.operationId, 'listOwners');
  assert.deepEqual(edge.evidence.documents, ['src/main/resources/openapi.yml']);
  assert.equal(edge.evidence.interface, 'p.api.OwnersApi');
  assert.match(edge.evidence.basis, /generator's naming/);
  assert.match(edge.evidence.basis, /not in the source tree/);
  assert.doesNotMatch(edge.evidence.basis, /the build generates/, 'no generator configuration was read, so the evidence does not say one runs');
  const sym = g.nodes.get('symbol:p.web.OwnerController#listOwners');
  assert.equal(sym.file, 'src/main/java/p/web/OwnerController.java', 'written by the Java lane\'s own symbol writer');
  const node = g.nodes.get('endpoint:GET /petclinic/api/owners');
  assert.equal(node.source, 'openapi', 'the route stays the document\'s');
  assert.deepEqual(stats.contractLinks, {
    links: 2, endpoints: ['endpoint:DELETE /petclinic/api/owners/{ownerId}', 'endpoint:GET /petclinic/api/owners'],
    byRule: { [RULE]: { links: 2, unlinked: 0, alreadyHandled: 0 } }, unlinked: [], alreadyHandled: [],
    undeclared: 2,
  });
  assert.equal(stats.onlyInDocument, 2, 'the drift census is the code\'s own mappings, and a guess does not move it');
});

test('a project with no contract written this way gets the census it got before, with nothing added', () => {
  const plain = new Graph();
  const before = addOpenApiRoutes(plain, [doc(OWNERS_DOC)]);
  const g = new Graph();
  const after = addOpenApiRoutes(g, [doc(OWNERS_DOC)], { java: {}, javaFacts: [type('p.web.Other', { declaredMethods: ['run/0'] })] });
  assert.deepEqual(after, before);
  assert.equal('contractLinks' in after, false);
  assert.deepEqual(g.edges, plain.edges);
});

// ---------------------------------------------------------------------------
// in the working-tree overlay
// ---------------------------------------------------------------------------

const handlesTo = (g, to) => g.edges.filter((e) => e.type === 'HANDLES' && e.to === to).map((e) => [e.from, e.grade, e.evidence?.rule ?? null]);

test('contract_handles_survives_java_overlay: an edited controller keeps the link and the document\'s routes the certified run drew', () => {
  const file = 'src/main/java/p/web/OwnerController.java';
  const baseShards = new Map([[file, ownerFacts()]]);
  const documents = [doc(OWNERS_DOC)];
  const base = assembleGraph({ bridges: LANE_BRIDGES, javaFacts: assembleJavaFacts(baseShards), openapiDocuments: documents, java: {}, openapi: {} }).graph;
  const want = [['endpoint:GET /petclinic/api/owners', 'HEURISTIC', RULE]];
  assert.deepEqual(handlesTo(base, 'symbol:p.web.OwnerController#listOwners'), want, 'the certified run links it');
  const edited = ownerFacts().map((r) => (r.kind === 'type' ? { ...r, declaredMethodLines: [21, 31, 41] } : r));
  const r = overlayGraph({
    bridges: LANE_BRIDGES, baseShards, dirtyFacts: new Map([[file, edited]]), dirtyFiles: [file],
    baseGraph: base, overlaySessionId: 'c'.repeat(64), openapiDocuments: documents,
  });
  assert.deepEqual(handlesTo(r.graph, 'symbol:p.web.OwnerController#listOwners'), want, 'the overlay links it the same way');
  assert.ok(r.graph.nodes.has('endpoint:DELETE /petclinic/api/owners/{ownerId}'), 'and a route only the document declares is still a route');
  assert.deepEqual(r.provisional.endpoints, [], 'nothing the base graph had comes back as new');
  assert.deepEqual([...r.graph.nodes.keys()].sort(), [...base.nodes.keys()].sort(), 'no node dropped, none invented');
});

test('what the overlay cannot read again, it says as a limit: the table id generators a Spring XML declares', () => {
  assert.deepEqual(unreadInputLimits({ meta: { laneStats: { idGenerators: { declared: 0, bound: 0 } } } }), []);
  assert.deepEqual(unreadInputLimits({ meta: {} }), []);
  const [said] = unreadInputLimits({ meta: { laneStats: { idGenerators: { declared: 2, sites: 5, bound: 4 } } } });
  assert.equal(said.scope, 'overlay');
  assert.match(said.reason, /^the base pack bound 4 call\(s\) to the 2 table id generator bean\(s\) its Spring XML declares/);
  assert.match(said.reason, /unknown rather than absent/);
  assert.doesNotMatch(said.reason, /[—·]/);
  const state = overlayState({
    lanes: { baseShards: new Map(), dirtyFacts: new Map(), dropFiles: [], webBaseShards: new Map(), webDirtyFacts: new Map(), webDropFiles: [], webConfigRecords: [], catalogRecords: [], lineageRecords: [], timingsMs: { loadBase: 0, java: 0, web: 0, sql: 0 } },
    dirty: { webConfig: [], other: [] }, dirtyFiles: [], session: { overlaySessionId: 'd'.repeat(64) }, baseGraph: new Graph(),
    profile: {}, selection: {}, sqlArgs: { identifierCase: 'exact' }, webRootsAbs: [], templateRootsAbs: [], limits: [said],
  });
  assert.deepEqual(state.limits, [said], 'and the overlay\'s answer carries it');
});

// ---------------------------------------------------------------------------
// what a walk makes of a guessed link
// ---------------------------------------------------------------------------

/** A route, a guessed link to its handler, and a candidate call down to a statement. */
function guessedGraph() {
  const g = new Graph();
  g.addNode({ id: nodeId('endpoint', 'GET /owners'), path: '/owners', httpMethod: 'GET', source: 'openapi', declared: true });
  g.addNode({ id: nodeId('endpoint', 'GET /plain'), path: '/plain', httpMethod: 'GET' });
  g.addNode({ id: 'symbol:p.C#list', symbol: 'p.C#list', owner: 'p.C', file: 'C.java' });
  g.addNode({ id: 'symbol:p.C#plain', symbol: 'p.C#plain', owner: 'p.C', file: 'C.java' });
  g.addNode({ id: 'symbol:p.M#all', symbol: 'p.M#all', owner: 'p.M', file: 'M.java' });
  g.addNode({ id: 'statement:p.M.all', statementType: 'select' });
  g.addEdge({ from: 'endpoint:GET /owners', to: 'symbol:p.C#list', type: 'HANDLES', grade: 'HEURISTIC', evidence: { rule: RULE } });
  g.addEdge({ from: 'endpoint:GET /plain', to: 'symbol:p.C#plain', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:p.C#list', to: 'symbol:p.M#all', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:p.C#plain', to: 'symbol:p.M#all', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:p.M#all', to: 'statement:p.M.all', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  return g;
}

test('a conservative census does not reach through a guessed link, and a heuristic one grades what it reaches by it', () => {
  const g = guessedGraph();
  const at = (mode) => Object.fromEntries(walkEndpoints(g, { mode }).endpoints.map((e) => [e.id, [e.handlers, e.statements]]));
  assert.deepEqual(at('conservative'), {
    'endpoint:GET /owners': [0, []],
    'endpoint:GET /plain': [1, [{ id: 'statement:p.M.all', grade: 'SOUND_SET' }]],
  });
  assert.deepEqual(at('heuristic')['endpoint:GET /owners'], [1, [{ id: 'statement:p.M.all', grade: 'HEURISTIC' }]]);
  assert.equal(walkEndpoints(g, { mode: 'conservative' }).walk.byMode, 1, 'the floor that stopped it is counted');
});

const walkCtx = (g) => ({ graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] });

test('a picture of a route with a guessed handler starts at the handler, grades every row by the link, and says why', () => {
  const g = guessedGraph();
  const ctx = walkCtx(g);
  const low = flow(g, { endpoint: 'GET /owners' }, ctx).answer;
  assert.equal(low.entry.start, 'endpoint:GET /owners');
  assert.equal(low.entry.handler, null, 'no handler the mode admits');
  assert.deepEqual(low.statements, []);
  assert.ok(JSON.stringify(flow(g, { endpoint: 'GET /owners' }, ctx).limits).includes('below the floor of mode=conservative'));
  const r = flow(g, { endpoint: 'GET /owners', mode: 'heuristic' }, ctx);
  const high = r.answer;
  assert.equal(high.entry.start, 'symbol:p.C#list', 'the census starts at the handler, and so does the picture');
  assert.equal(high.entry.handler, 'p.C#list');
  assert.deepEqual(high.entry.link, { type: 'HANDLES', grade: 'HEURISTIC', rule: RULE });
  assert.deepEqual(high.statements.map((s) => [s.id, s.grade, s.hops]), [['p.M.all', 'HEURISTIC', 2]], 'graded by the link, hops counted from the handler');
  assert.match(high.walk.note, /linked to it only by a rule's guess \(HEURISTIC by openapi-generator\.spring-interface\), so every row below is graded by that link/);
  const plain = flow(g, { endpoint: 'GET /plain' }, ctx).answer;
  assert.equal(plain.entry.start, 'symbol:p.C#plain', 'a route its code declares still starts at its handler');
  assert.deepEqual(plain.entry.link, { type: 'HANDLES', grade: 'EXACT', rule: null });
});

/** A route, its handler through `link`, a chain of `calls` EXACT calls, and a statement at the end of it. */
function chainGraph(link, calls) {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /deep', path: '/deep', httpMethod: 'GET' });
  g.addNode({ id: 'table:t', kind: 'table' });
  const syms = Array.from({ length: calls + 1 }, (_, i) => `symbol:p.S${i}#run`);
  for (const id of syms) g.addNode({ id, symbol: id.slice(7), owner: id.slice(7, id.indexOf('#')), file: 'S.java' });
  g.addNode({ id: 'statement:p.M.find', statementType: 'select' });
  g.addEdge({ from: 'endpoint:GET /deep', to: syms[0], type: 'HANDLES', grade: link, evidence: link === 'EXACT' ? {} : { rule: RULE } });
  for (let i = 0; i < calls; i++) g.addEdge({ from: syms[i], to: syms[i + 1], type: 'CALLS', grade: 'EXACT' });
  g.addEdge({ from: syms[calls], to: 'statement:p.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:p.M.find', to: 'table:t', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  return g;
}

test('heuristic_handles_depth_boundary_matches_endpoint_census: at one depth, the census and the picture agree on what a guessed handler reaches', () => {
  // A HEURISTIC HANDLES, five CALLS, then IMPLEMENTS_STMT: the statement is six hops below the handler.
  const g = chainGraph('HEURISTIC', 5);
  const ctx = walkCtx(g);
  for (const depth of [5, 6, 7]) {
    const census = walkEndpoints(g, { mode: 'heuristic', depth }).endpoints[0].statements;
    const picture = flow(g, { endpoint: 'GET /deep', mode: 'heuristic', depth }, ctx).answer.statements;
    assert.deepEqual(picture.map((s) => [`statement:${s.id}`, s.grade]), census.map((s) => [s.id, s.grade]), `depth ${depth}`);
  }
  assert.equal(walkEndpoints(g, { mode: 'heuristic', depth: 6 }).endpoints[0].statements.length, 1, 'reached at depth 6, counted from the handler');
});

test('sound_set_handles_caps_flow_grade: a candidate-set link to the handler caps every row and table of the picture', () => {
  const g = chainGraph('SOUND_SET', 2);
  const ctx = walkCtx(g);
  const census = walkEndpoints(g, { mode: 'conservative', depth: 6 }).endpoints[0].statements;
  assert.deepEqual(census, [{ id: 'statement:p.M.find', grade: 'SOUND_SET' }]);
  const a = flow(g, { endpoint: 'GET /deep', mode: 'conservative' }, ctx).answer;
  assert.equal(a.entry.start, 'symbol:p.S0#run');
  assert.deepEqual(a.statements.map((s) => s.grade), ['SOUND_SET'], 'not EXACT: the route reaches its handler only through a candidate set');
  assert.deepEqual(a.services.map((s) => [s.id, s.grade]), [['p.S1#run', 'SOUND_SET']]);
  assert.deepEqual(a.tables.map((t) => [t.table, t.grade]), [['t', 'SOUND_SET']]);
  assert.deepEqual(a.entry.link, { type: 'HANDLES', grade: 'SOUND_SET', rule: RULE });
  assert.match(a.walk.note, /linked to it by a candidate set \(SOUND_SET by openapi-generator\.spring-interface\), so no row below is graded above SOUND_SET/);
  const exact = flow(chainGraph('EXACT', 2), { endpoint: 'GET /deep' }, walkCtx(chainGraph('EXACT', 2))).answer;
  assert.deepEqual(exact.statements.map((s) => s.grade), ['EXACT'], 'a declared handler caps nothing');
  assert.equal(exact.walk.note, null);
});

test('walking up, a route whose link to its handler is below the floor is not an endpoint of the answer, and the floor is counted', () => {
  const g = guessedGraph();
  const ctx = walkCtx(g);
  const low = flow(g, { statement: 'p.M.all', direction: 'up' }, ctx).answer;
  assert.deepEqual(low.endpoints.map((e) => [e.id, e.grade]), [['GET /plain', 'SOUND_SET']], 'the guessed route is not a conservative answer');
  assert.ok(low.walk.cut.byMode >= 1);
  assert.equal(low.walk.cut.byModeGrades.HEURISTIC, 1, 'counted once, by the grade that kept it out');
  const high = flow(g, { statement: 'p.M.all', direction: 'up', mode: 'heuristic' }, ctx).answer;
  assert.deepEqual(high.endpoints.map((e) => [e.id, e.grade]), [['GET /plain', 'SOUND_SET'], ['GET /owners', 'HEURISTIC']]);
});

// ---------------------------------------------------------------------------
// the whole run
// ---------------------------------------------------------------------------

test('cascade analyze links a contract-first controller, and the census, the gap and the Rules catalog say how', { timeout: 600000 }, (t) => {
  if (!findJdk()) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  if (!fs.existsSync(sqlLaneVenv().python)) { t.skip('no venv python: the SQL lane cannot run (see docs/setup/sql-lane.md)'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-contract-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  const src = path.join(repo, 'src', 'main', 'java', 'p');
  const res = path.join(repo, 'src', 'main', 'resources');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(res, 'mapper'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'db'));
  fs.writeFileSync(path.join(repo, 'db', 'schema.sql'), 'CREATE TABLE owners (id INT PRIMARY KEY, last_name VARCHAR(30));\n');
  fs.writeFileSync(path.join(res, 'openapi.yml'), OWNERS_DOC);
  fs.writeFileSync(path.join(res, 'mapper', 'OwnerMapper.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">\n<mapper namespace="p.OwnerMapper">\n  <select id="findAll" resultType="map">SELECT id, last_name FROM owners</select>\n</mapper>\n');
  fs.writeFileSync(path.join(src, 'OwnerMapper.java'), 'package p;\nimport java.util.List;\nimport org.apache.ibatis.annotations.Mapper;\n@Mapper\npublic interface OwnerMapper { List<Object> findAll(); }\n');
  fs.writeFileSync(path.join(src, 'OwnerController.java'), 'package p;\nimport p.api.OwnersApi;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class OwnerController implements OwnersApi {\n  private final OwnerMapper ownerMapper;\n  public OwnerController(OwnerMapper ownerMapper) { this.ownerMapper = ownerMapper; }\n  public Object listOwners(String lastName) { return this.ownerMapper.findAll(); }\n}\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '-A');
  git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'fixture');
  const env = { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') };
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  assert.equal(cli(['init', '--root', repo, '--project', 'contract']).status, 0);
  const run = cli(['analyze', '--root', repo, '--project', 'contract', '--ddl', path.join(repo, 'db', 'schema.sql'),
    '--java-src', path.join(repo, 'src', 'main', 'java'), '--mappers', path.join(res, 'mapper'), '--openapi', path.join(res, 'openapi.yml')]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /OpenAPI lane: 1 declared route\(s\) given a handler through an interface named for the operation and not in the source tree \(openapi-generator\.spring-interface 1\), graded HEURISTIC/);
  assert.doesNotMatch(run.stderr, /OPENAPI_NOT_SERVED GET \/petclinic\/api\/owners:/, 'a route a rule gave a handler is not said to have none');
  const pack = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.laneStats.openapi.contractLinks.links, 1);
  const graph = loadPack(pack, { verifyDigest: true });
  const catalog = rulesCatalog(builtinRegistry(), graph);
  assert.equal(catalog.packs.flatMap((p) => p.rules).find((r) => r.id === RULE).appliedHere, 1);
  const ctx = { graph, basis: { project: 'contract', buildDigest: pack.digest, builtAt: null, freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack: { ...pack.meta, digest: pack.digest } };
  const reach = (mode) => overview(graph, { mode }, ctx).answer;
  const ep = 'endpoint:GET /petclinic/api/owners';
  const reaches = (o) => !JSON.stringify(o.gaps.find((g) => g.kind === 'endpoints-without-statement') ?? {}).includes(ep.slice('endpoint:'.length));
  const low = reach('conservative');
  const high = reach('heuristic');
  assert.equal(high.reach.endpoints - high.reach.endpointsWithoutStatement, 1, 'the heuristic census reaches the SQL under the guessed link');
  assert.equal(low.reach.endpoints - low.reach.endpointsWithoutStatement, 0, 'and the conservative one does not');
  assert.ok(reaches(high));
  const gap = low.gaps.find((g) => g.kind === 'contract-links');
  assert.match(gap.note, /paired them by a code generator's naming/);
  assert.match(gap.note, /does not follow them/);
});
