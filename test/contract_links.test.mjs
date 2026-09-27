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
  const facts = [imported('p.web.Billing', 'ext.BillingApi'), type('p.web.Billing', { implements: ['BillingApi'], declaredMethods: ['listOwners/0'] })];
  const { links, unlinked } = deriveContractLinks(facts, operationsOf([doc(OWNERS_DOC)]), rules());
  assert.deepEqual(links, []);
  assert.deepEqual(unlinked.map((u) => [u.reason, u.interface, u.names]), [['interface-name', 'ext.BillingApi', ['OwnersApi']]]);
  const both = [imported('p.web.Both', 'p.api.OwnersApi'), imported('p.web.Both', 'p.api.PetsApi'),
    type('p.web.Both', { implements: ['OwnersApi', 'PetsApi'], declaredMethods: ['listOwners/0'] })];
  const r = deriveContractLinks(both, operationsOf([doc(OWNERS_DOC)]), rules());
  assert.equal(r.links.length, 1);
  assert.deepEqual(r.unlinked, [], 'a method one interface links is not also said to miss the other');
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
  const sym = g.nodes.get('symbol:p.web.OwnerController#listOwners');
  assert.equal(sym.file, 'src/main/java/p/web/OwnerController.java', 'written by the Java lane\'s own symbol writer');
  const node = g.nodes.get('endpoint:GET /petclinic/api/owners');
  assert.equal(node.source, 'openapi', 'the route stays the document\'s');
  assert.deepEqual(stats.contractLinks, {
    links: 2, endpoints: ['endpoint:DELETE /petclinic/api/owners/{ownerId}', 'endpoint:GET /petclinic/api/owners'],
    byRule: { [RULE]: { links: 2, unlinked: 0 } }, unlinked: [],
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

test('a picture of a route with a guessed handler starts at the route and says why', () => {
  const g = guessedGraph();
  const ctx = { graph: g, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } }, trust: { trustLevel: 'UNCERTIFIED' }, limits: [] };
  const low = flow(g, { endpoint: 'GET /owners' }, ctx).answer;
  assert.equal(low.entry.start, 'endpoint:GET /owners');
  assert.equal(low.entry.handler, null, 'no handler the mode admits');
  assert.deepEqual(low.statements, []);
  assert.ok(JSON.stringify(flow(g, { endpoint: 'GET /owners' }, ctx).limits).includes('below the floor of mode=conservative'));
  const high = flow(g, { endpoint: 'GET /owners', mode: 'heuristic' }, ctx).answer;
  assert.equal(high.entry.start, 'endpoint:GET /owners', 'started at the route, so the link is on every path');
  assert.equal(high.entry.handler, 'p.C#list');
  assert.deepEqual(high.statements.map((s) => [s.id, s.grade]), [['p.M.all', 'HEURISTIC']]);
  const plain = flow(g, { endpoint: 'GET /plain' }, ctx).answer;
  assert.equal(plain.entry.start, 'symbol:p.C#plain', 'a route its code declares still starts at its handler');
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
  assert.match(run.stderr, /OpenAPI lane: 1 declared route\(s\) given a handler through an interface the build generates \(openapi-generator\.spring-interface 1\), graded HEURISTIC/);
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
