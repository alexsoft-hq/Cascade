// java_modules.test.mjs — the Java BRIDGE's modules, each imported on its own.
//
// WHY THIS FILE EXISTS BESIDE test/java_bridge.test.mjs. That file drives
// `addJavaFacts` end to end and is the better test of what the lane ANSWERS.
// What it cannot do is say where a rule lives: when a call resolves to the wrong
// type it fails in the same place a route contract resolving to the wrong
// controller fails. RM50 split the bridge into five modules with a paragraph
// each about what they own; this file holds each of them to that paragraph on
// its own.
//
// It is deliberately about the SEAMS: the shape one step hands to the next, and
// the rules that have no other test because the end-to-end path only ever
// exercises one branch of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeRe, gatewayRouteOf, normalizeUrlPath, routeMatches } from '../src/adapters/http_routes.mjs';
import {
  buildHierarchyIndex, buildTypeIndex, classifyRouteHolder, cmp, indexJavaFacts, isProjectPackage,
  looksLikeTypeName, memberToStatementKey, namespaceOfStatementKey, ownerOf, packageOfType,
  symbolId, endpointId, JAVA_LANG_TYPES, LOMBOK_LOGGERS, SUPER_CHAIN_LIMIT, UNKNOWN_PLACE,
} from '../src/adapters/java/types.mjs';
import {
  classifyGeneratedTypes, duplicateFqnCensus, emptyJavaStats, pathGlobMatcher, UNRESOLVED_REASONS,
} from '../src/adapters/java/stats.mjs';
import {
  classifyRoutes, placeEndpointNodes, placeHandlesEdges, servedRouteIndex, ROUTE_RULE_BASIS,
} from '../src/adapters/java/routes.mjs';
import {
  makeBeanNames, makeEmitter, makeGeneratedFields, makeWildcardPlacer, placeCallEdges,
  CALL_RULES, CALL_RULE_BASIS,
} from '../src/adapters/java/calls.mjs';
import {
  bindStatementIds, bindStatements, mapperOwnersOf, markTransactions, registerMethodSymbols,
  sessionTypesOf,
} from '../src/adapters/java/persistence.mjs';
import { Graph, nodeId } from '../src/core/graph.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// http_routes.mjs — the URL vocabulary both lanes are written on
// ---------------------------------------------------------------------------

test('http_routes: a path is spelled one way, whatever it arrived as', () => {
  assert.equal(normalizeUrlPath('a//b/'), '/a/b');
  assert.equal(normalizeUrlPath('/'), '/');
  assert.equal(normalizeUrlPath(null), '/');
  assert.equal(normalizeUrlPath('/x/'), '/x');
});

test('http_routes: a route hole and a call hole are different holes, and both match', () => {
  assert.equal(routeMatches('/owners/{id}', '/owners/{*}'), true);
  assert.equal(routeMatches('/owners/{id}', '/owners/7'), true);
  assert.equal(routeMatches('/owners/{id}/pets', '/owners/7'), false, 'a route with more segments is not this call');
  assert.equal(routeMatches('/static/**', '/static/a/b/c'), true, '`**` is the rest, however long');
  assert.equal(routeMatches('/thing-7.json', '/thing-{*}.json'), true, 'a hole inside a segment');
  assert.equal(routeMatches('/a', '/b'), false);
});

test('http_routes: the two lanes really do read one function', async () => {
  // Not "the same rule": the SAME function object, reached from the web bridge
  // and from the Java bridge. Two copies would drift, and a call and the route
  // it lands on would then be matched by two rules.
  const web = await import('../src/adapters/web_bridge.mjs');
  const java = await import('../src/adapters/java/routes.mjs');
  assert.equal(web.routeMatches, routeMatches);
  assert.equal(web.normalizeUrlPath, normalizeUrlPath);
  assert.ok(typeof java.placeImperativeCalls === 'function');
  // And `gatewayRouteOf` still comes from where the profile is read.
  const core = await import('../src/core/profile.mjs');
  assert.equal(gatewayRouteOf, core.gatewayRouteOf);
  assert.equal(escapeRe('a.b*c'), 'a\\.b\\*c');
});

// ---------------------------------------------------------------------------
// types.mjs — what a name MEANS, with no graph in sight
// ---------------------------------------------------------------------------

const FACTS = [
  { kind: 'header', schema: 'cascade:javafacts:1' },
  {
    kind: 'type', fqn: 'com.x.OwnerController', package: 'com.x', name: 'OwnerController',
    file: 'src/main/java/com/x/OwnerController.java', annotations: ['RestController'], implements: [],
  },
  {
    kind: 'type', fqn: 'com.x.OwnerService', package: 'com.x', name: 'OwnerService',
    file: 'src/main/java/com/x/OwnerService.java', typeKind: 'interface', implements: [],
    declaredMethods: ['find/1'],
  },
  {
    kind: 'type', fqn: 'com.x.OwnerServiceImpl', package: 'com.x', name: 'OwnerServiceImpl',
    file: 'src/main/java/com/x/OwnerServiceImpl.java', implements: ['OwnerService'],
    declaredMethods: ['find/1'],
  },
  { kind: 'method', fqn: 'com.x.OwnerController#list', owner: 'com.x.OwnerController', line: 12, paramCount: 0 },
  { kind: 'method', fqn: 'com.x.OwnerService#find', owner: 'com.x.OwnerService', line: 4, paramCount: 1 },
  { kind: 'method', fqn: 'com.x.OwnerServiceImpl#find', owner: 'com.x.OwnerServiceImpl', line: 9, paramCount: 1 },
  { kind: 'field', owner: 'com.x.OwnerController', name: 'service', typeSimple: 'OwnerService' },
  { kind: 'call', from: 'com.x.OwnerController#list', method: 'find', toTypeSimple: 'OwnerService', receiver: 'service', via: 'field' },
  { kind: 'endpoint', httpMethod: 'GET', path: '/owners', handler: 'com.x.OwnerController#list', handlerType: 'com.x.OwnerController', line: 12, file: 'src/main/java/com/x/OwnerController.java' },
  { kind: 'transactional', method: 'com.x.OwnerServiceImpl#find', scope: 'REQUIRED', line: 9 },
  { kind: 'parse_error', file: 'src/main/java/com/x/Broken.java', line: 3, message: 'no' },
  { kind: 'somethingTheFutureAdds', file: 'src/main/java/com/x/OwnerController.java' },
];

test('types: the fact stream is bucketed in one pass, and a kind it has never heard of is ignored', () => {
  const idx = indexJavaFacts(FACTS);
  assert.equal(idx.methods.length, 3);
  assert.equal(idx.calls.length, 1);
  assert.equal(idx.endpoints.length, 1);
  assert.equal(idx.transactionals.length, 1);
  assert.equal(idx.parseErrors.length, 1);
  // Every record that named a file counts as a parsed file, the unknown kind
  // included: the schema is additive, and a reader one version behind must not
  // report a file as unread because a newer worker described it differently.
  assert.deepEqual([...idx.parsedFiles].sort(), [
    'src/main/java/com/x/Broken.java',
    'src/main/java/com/x/OwnerController.java',
    'src/main/java/com/x/OwnerService.java',
    'src/main/java/com/x/OwnerServiceImpl.java',
  ]);
  assert.equal(idx.lineOfMember.get('com.x.OwnerController#list'), 12);
  assert.deepEqual([...idx.aritiesOfMember.get('com.x.OwnerService#find')], [1]);
  assert.equal(idx.callsFrom.get('com.x.OwnerController#list').length, 1);
  assert.equal(idx.fieldsByOwner.get('com.x.OwnerController').get('service'), 'OwnerService');
});

test('types: a field record repeated keeps the FIRST declaration', () => {
  const idx = indexJavaFacts([
    { kind: 'field', owner: 'com.x.A', name: 'f', typeSimple: 'First' },
    { kind: 'field', owner: 'com.x.A', name: 'f', typeSimple: 'Second' },
  ]);
  assert.equal(idx.fieldsByOwner.get('com.x.A').get('f'), 'First',
    'a stream that repeats a file must not change which type a field is read as');
});

test('types: the index resolves a simple name, and the hierarchy knows who implements what', () => {
  const idx = buildTypeIndex(FACTS);
  assert.equal(idx.resolveType('com.x.OwnerController', 'OwnerService'), 'com.x.OwnerService');
  assert.equal(idx.resolveType('com.x.OwnerController', 'String'), 'java.lang.String',
    '`java.lang` is an on-demand import the language puts in every file');
  assert.equal(idx.resolveType('com.x.OwnerController', 'NoSuchThing'), null,
    'a name nothing places stays unplaced rather than being invented into a package');
  const h = buildHierarchyIndex(idx.types, idx.resolveType);
  assert.deepEqual([...h.implementorsOf.get('com.x.OwnerService')], ['com.x.OwnerServiceImpl']);
  assert.equal(h.declares('com.x.OwnerServiceImpl', 'find', 1), true);
  assert.equal(h.declares('com.x.OwnerServiceImpl', 'find', 3), false, 'arity is part of the question');
});

test('types: what a mapping annotation MEANS is decided from the type that carries it', () => {
  assert.equal(classifyRouteHolder({ annotations: ['RestController'] }), 'handler');
  assert.equal(classifyRouteHolder({ typeKind: 'interface' }), 'contract');
  assert.equal(classifyRouteHolder({ abstract: true }), 'contract');
  assert.equal(classifyRouteHolder({ client: { kind: 'FeignClient' } }), 'client');
  // TOTAL on purpose: a project whose controllers wear a meta-annotation this
  // engine has never seen still gets its routes.
  assert.equal(classifyRouteHolder({}), 'handler');
  assert.equal(classifyRouteHolder(undefined), 'handler');
});

test('types: the identity rules, which two spellings would make two nodes of', () => {
  assert.equal(symbolId('com.x.A#m'), nodeId('symbol', 'com.x.A#m'));
  assert.equal(endpointId('GET', '/a'), nodeId('endpoint', 'GET /a'));
  assert.equal(ownerOf('com.x.A#m'), 'com.x.A');
  assert.equal(ownerOf('com.x.A'), 'com.x.A', 'a name with no member is its own owner');
  assert.equal(memberToStatementKey('com.x.Mapper#select'), 'com.x.Mapper.select');
  assert.equal(namespaceOfStatementKey('com.x.Mapper.select'), 'com.x.Mapper');
  assert.equal(packageOfType('com.x.A'), 'com.x');
  assert.equal(packageOfType('A'), '', 'the default package is empty, not null');
  assert.equal(cmp('a', 'b'), -1);
});

test('types: a package boundary the profile never declared makes nothing external', () => {
  assert.equal(isProjectPackage('com.x', []), true, 'no declared boundary: nothing is outside it');
  assert.equal(isProjectPackage('com.x.deep', ['com.x']), true);
  assert.equal(isProjectPackage('com.xylophone', ['com.x'], 'a prefix is a package, not a string prefix'), false);
  assert.equal(isProjectPackage(null, ['com.x']), false);
});

test('types: the three closed worlds this lane can never read', () => {
  assert.ok(JAVA_LANG_TYPES.includes('String') && JAVA_LANG_TYPES.includes('Integer'));
  assert.equal(LOMBOK_LOGGERS.Slf4j, 'org.slf4j.Logger');
  assert.equal(LOMBOK_LOGGERS.CustomLog, 'lombok.extern.CustomLog',
    '@CustomLog names its logger in lombok.config, which is not source this lane reads');
  assert.equal(looksLikeTypeName('Arrays'), true);
  assert.equal(looksLikeTypeName('ADD_STRING'), false, 'a SHOUTING name is a constant, not a type');
  assert.equal(SUPER_CHAIN_LIMIT, 32);
  assert.deepEqual(UNKNOWN_PLACE, { kind: 'unknown' });
});

// ---------------------------------------------------------------------------
// stats.mjs — the lane's account of its own run
// ---------------------------------------------------------------------------

test('stats: a fresh lane report is all zeroes, and every field is there before any step runs', () => {
  const s = emptyJavaStats({ generatedSources: {}, parseErrors: 2, parsedFiles: 9 });
  assert.equal(s.endpoints, 0);
  assert.equal(s.calls, 0);
  assert.equal(s.parseErrors, 2);
  assert.equal(s.parsedFiles, 9);
  assert.equal(s.generatedDeclared, false, 'a project that declares nothing classifies nothing');
  assert.deepEqual(Object.keys(s.unresolvedCallsByReason).sort(), [...UNRESOLVED_REASONS].sort());
  assert.deepEqual(s.identifierReceivers,
    { total: 0, inheritedField: 0, generatedField: 0, staticReceiver: 0, unresolved: 0 });
  // Two reports do not share a nested object, or one project's counts would
  // land in another's.
  const t = emptyJavaStats({ generatedSources: {}, parseErrors: 0, parsedFiles: 0 });
  t.callsByRule['field-receiver'] = 5;
  assert.equal(s.callsByRule['field-receiver'], 0);
});

test('stats: a declared generatedSources block says so, whichever half declares it', () => {
  assert.equal(emptyJavaStats({ generatedSources: { annotations: ['Generated'] }, parseErrors: 0, parsedFiles: 0 }).generatedDeclared, true);
  assert.equal(emptyJavaStats({ generatedSources: { pathGlobs: ['mbg/**'] }, parseErrors: 0, parsedFiles: 0 }).generatedDeclared, true);
  assert.equal(emptyJavaStats({ generatedSources: { annotations: [], pathGlobs: [] }, parseErrors: 0, parsedFiles: 0 }).generatedDeclared, false);
});

test('stats: a path glob matches within a segment, and `**` across them', () => {
  const m = pathGlobMatcher(['mall-mbg/**', 'gen/*.java']);
  assert.equal(m('mall-mbg/src/main/java/A.java'), true);
  assert.equal(m('gen/A.java'), true);
  assert.equal(m('gen/deep/A.java'), false, 'a single star stays inside one segment');
  assert.equal(m(null), false);
  assert.equal(pathGlobMatcher([])('anything'), false, 'no globs declared: nothing matches');
});

test('stats: nothing is classified generated unless the profile said how', () => {
  const types = new Map([
    ['com.x.AExample', { annotations: ['Generated'], file: 'mbg/A.java' }],
    ['com.x.B', { annotations: [], file: 'src/B.java' }],
  ]);
  assert.equal(classifyGeneratedTypes(types, {}).fqns.size, 0, 'undeclared classifies nothing');
  const byAnn = classifyGeneratedTypes(types, { annotations: ['Generated'] });
  assert.deepEqual([...byAnn.fqns], ['com.x.AExample']);
  assert.equal(byAnn.byAnnotation, 1);
  const byPath = classifyGeneratedTypes(types, { pathGlobs: ['mbg/**'] });
  assert.deepEqual([...byPath.fqns], ['com.x.AExample']);
  assert.equal(byPath.byPath, 1);
});

test('stats: an FQN declared in two files is counted and CLASSIFIED, never resolved', () => {
  const filesByFqn = new Map([
    ['com.x.ISysBaseAPI', new Set(['local/A.java', 'cloud/A.java'])],
    ['com.x.Alone', new Set(['src/Alone.java'])],
  ]);
  const typesByFile = new Map([
    ['com.x.ISysBaseAPI local/A.java', { annotations: [] }],
    ['com.x.ISysBaseAPI cloud/A.java', { annotations: ['FeignClient'] }],
  ]);
  const census = duplicateFqnCensus(filesByFqn, typesByFile, []);
  assert.equal(census.count, 1);
  assert.equal(census.declarations, 2);
  assert.deepEqual(census.byKind, { 'http-client': 1 },
    'the kind is the UNION of every declaration: a plain interface in one module and a client in the other');
  assert.deepEqual(census.types[0].files, ['cloud/A.java', 'local/A.java']);
});

// ---------------------------------------------------------------------------
// routes.mjs — the routes this pack serves, and the routes it calls
// ---------------------------------------------------------------------------

/** The whole context the steps read, built the way `addJavaFacts` builds it. */
function ctxFor(facts, opts = {}) {
  const idx = indexJavaFacts(facts);
  const typeIndex = buildTypeIndex(facts);
  const hierarchy = buildHierarchyIndex(typeIndex.types, typeIndex.resolveType);
  const g = new Graph();
  const stats = emptyJavaStats({
    generatedSources: {}, parseErrors: idx.parseErrors.length, parsedFiles: idx.parsedFiles.size,
  });
  const ensureSymbol = (memberFqn) => {
    const id = symbolId(memberFqn);
    if (!g.nodes.has(id)) {
      g.addNode({ id, symbol: memberFqn, owner: ownerOf(memberFqn), file: null, line: idx.lineOfMember.get(memberFqn) ?? null });
    }
    return id;
  };
  return {
    g,
    stats,
    packagePrefixes: opts.packagePrefixes ?? [],
    gatewayRoutes: opts.gatewayRoutes ?? {},
    ...idx,
    ...typeIndex,
    ...hierarchy,
    typeAt: (fqn, file) => (file ? typeIndex.typesByFile.get(`${fqn} ${file}`) : undefined) ?? typeIndex.types.get(fqn),
    ensureSymbol,
    isExternalType: () => false,
    fileOf: (fqn) => typeIndex.types.get(fqn)?.file ?? null,
    isGeneratedMember: () => false,
  };
}

test('routes: a concrete controller SERVES the route, and the edge is definitional', () => {
  const ctx = ctxFor(FACTS);
  const { routes, clientCalls } = classifyRoutes(ctx);
  assert.equal(clientCalls.length, 0);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].grade, 'EXACT');
  assert.equal(routes[0].evidence, null, 'nothing was resolved, so there is nothing to say');
  const byRoute = placeEndpointNodes(ctx, routes);
  placeHandlesEdges(ctx, routes);
  const node = ctx.g.nodes.get(endpointId('GET', '/owners'));
  assert.equal(node.handler, 'com.x.OwnerController#list');
  assert.equal(node.handlers, undefined, 'a single-handler route says nothing extra');
  assert.equal(byRoute.size, 1);
  assert.equal(ctx.stats.handles, 1);
});

test('routes: two controllers on one route make ONE node with two HANDLES, named by the lowest', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.z.Late', package: 'com.x.z', name: 'Late', file: 'z/Late.java', annotations: ['RestController'], implements: [] },
    { kind: 'type', fqn: 'com.x.a.Early', package: 'com.x.a', name: 'Early', file: 'a/Early.java', annotations: ['RestController'], implements: [] },
    { kind: 'method', fqn: 'com.x.z.Late#list', owner: 'com.x.z.Late', line: 5, paramCount: 0 },
    { kind: 'method', fqn: 'com.x.a.Early#list', owner: 'com.x.a.Early', line: 7, paramCount: 0 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.z.Late#list', handlerType: 'com.x.z.Late', line: 5, file: 'z/Late.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.a.Early#list', handlerType: 'com.x.a.Early', line: 7, file: 'a/Early.java' },
  ];
  const ctx = ctxFor(facts);
  const { routes } = classifyRoutes(ctx);
  placeEndpointNodes(ctx, routes);
  placeHandlesEdges(ctx, routes);
  const node = ctx.g.nodes.get(endpointId('GET', '/order/list'));
  assert.equal(node.handler, 'com.x.a.Early#list', 'the PRIMARY handler is the lowest symbol id, as the walks pick it');
  assert.deepEqual(node.handlers, ['com.x.a.Early#list', 'com.x.z.Late#list'], 'and the node says the route is declared twice');
  assert.equal(ctx.stats.handles, 2, 'one edge per declaration');
});

test('routes: a mapping on an interface is a CONTRACT, served by whoever implements it', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.Api', package: 'com.x', name: 'Api', file: 'Api.java', typeKind: 'interface', implements: [], declaredMethods: ['get/1'] },
    { kind: 'type', fqn: 'com.x.Impl', package: 'com.x', name: 'Impl', file: 'Impl.java', annotations: ['RestController'], implements: ['Api'], declaredMethods: ['get/1'] },
    { kind: 'method', fqn: 'com.x.Api#get', owner: 'com.x.Api', line: 3, paramCount: 1 },
    { kind: 'method', fqn: 'com.x.Impl#get', owner: 'com.x.Impl', line: 8, paramCount: 1 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/api', handler: 'com.x.Api#get', handlerType: 'com.x.Api', line: 3, file: 'Api.java' },
  ];
  const ctx = ctxFor(facts);
  const { routes } = classifyRoutes(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].handler, 'com.x.Impl#get');
  assert.equal(routes[0].grade, 'SOUND_SET', 'a resolution, not a definition');
  assert.equal(routes[0].evidence.rule, 'route-contract-impl');
  assert.equal(routes[0].evidence.match, 'name+arity');
  assert.equal(routes[0].evidence.basis, ROUTE_RULE_BASIS['route-contract-impl']);
  assert.equal(ctx.stats.routeContracts, 1);
  assert.equal(ctx.stats.contractOnlyRoutes, 0);
});

test('routes: a contract nobody implements here is still a route, and SAYS it is', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.Api', package: 'com.x', name: 'Api', file: 'Api.java', typeKind: 'interface', implements: [] },
    { kind: 'method', fqn: 'com.x.Api#get', owner: 'com.x.Api', line: 3, paramCount: 1 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/api', handler: 'com.x.Api#get', handlerType: 'com.x.Api', line: 3, file: 'Api.java' },
  ];
  const ctx = ctxFor(facts);
  const { routes } = classifyRoutes(ctx);
  placeEndpointNodes(ctx, routes);
  assert.equal(routes[0].evidence.rule, 'route-contract-only');
  assert.equal(ctx.g.nodes.get(endpointId('GET', '/api')).contractOnly, true);
  assert.equal(ctx.stats.contractOnlyRoutes, 1);
});

test('routes: the served index answers exactly first, then by template, and honours the verb', () => {
  const ctx = ctxFor(FACTS);
  const { routes } = classifyRoutes(ctx);
  const byRoute = placeEndpointNodes(ctx, routes);
  const { matchServed, servedList } = servedRouteIndex(ctx, byRoute);
  assert.deepEqual(servedList.map((r) => r.path), ['/owners']);
  assert.equal(matchServed('GET', '/owners').how, 'exact');
  assert.equal(matchServed('POST', '/owners').how, null, 'a verb this route does not answer is not this route');
  assert.equal(matchServed(null, '/owners').how, 'exact', 'a call whose verb could not be read is matched on the path');
  assert.equal(matchServed('GET', '/nope').how, null);
});

test('routes: every ROUTE rule has a sentence, and none of them is a label', () => {
  for (const k of ['route-contract-impl', 'route-contract-only', 'http-client', 'http-client-call']) {
    assert.ok(ROUTE_RULE_BASIS[k].length > 80, `${k} needs a sentence`);
  }
});

// ---------------------------------------------------------------------------
// calls.mjs — MAY_CALL, and why one could not be drawn
// ---------------------------------------------------------------------------

test('calls: a field receiver reaches its declared type, and the edge names the rule', () => {
  const ctx = ctxFor(FACTS);
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeBeanNames(ctx));
  cw.queueIfInherited = () => {};
  cw.inheritorsFor = () => new Map();
  cw.bindSuperBody = () => {};
  placeCallEdges(ctx, cw);
  const edges = [...ctx.g.edges].filter((e) => e.type === 'MAY_CALL');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, symbolId('com.x.OwnerController#list'));
  assert.equal(edges[0].to, symbolId('com.x.OwnerService#find'));
  assert.equal(edges[0].grade, 'SOUND_SET', 'no compiler binding was consulted, so never EXACT');
  assert.equal(edges[0].evidence.rule, 'field-receiver');
  assert.equal(edges[0].evidence.basis, CALL_RULE_BASIS['field-receiver']);
  assert.equal(ctx.stats.calls, 1);
  assert.equal(ctx.stats.callsByRule['field-receiver'], 1);
  // The target is an interface, so the dispatch pass has something to do.
  assert.ok(cw.calledIfaceMethods.has('com.x.OwnerService#find'));
});

test('calls: a receiver nothing places is COUNTED by rule and by reason, never dropped', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.A', package: 'com.x', name: 'A', file: 'A.java', implements: [] },
    { kind: 'method', fqn: 'com.x.A#m', owner: 'com.x.A', line: 1, paramCount: 0 },
    { kind: 'call', from: 'com.x.A#m', method: 'go', toTypeSimple: 'Nowhere', receiver: 'thing', via: 'field' },
  ];
  const ctx = ctxFor(facts);
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeBeanNames(ctx));
  cw.queueIfInherited = () => {};
  cw.inheritorsFor = () => new Map();
  cw.bindSuperBody = () => {};
  placeCallEdges(ctx, cw);
  assert.equal([...ctx.g.edges].filter((e) => e.type === 'MAY_CALL').length, 0);
  assert.equal(ctx.stats.unresolvedCalls, 1);
  assert.equal(ctx.stats.unresolvedCallsByRule['field-receiver'], 1);
  assert.equal(ctx.stats.unresolvedCallsByReason.unknown, 1);
});

test('calls: the field Lombok writes is found on the class and on the class that encloses it', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.Outer', package: 'com.x', name: 'Outer', file: 'Outer.java', annotations: ['Slf4j'], implements: [] },
    { kind: 'type', fqn: 'com.x.Outer.Inner', package: 'com.x', name: 'Inner', file: 'Outer.java', implements: [] },
    { kind: 'type', fqn: 'com.x.Own', package: 'com.x', name: 'Own', file: 'Own.java', annotations: ['Slf4j'], implements: [] },
    { kind: 'field', owner: 'com.x.Own', name: 'log', typeSimple: 'Logger' },
  ];
  const ctx = ctxFor(facts);
  const generatedFieldFor = makeGeneratedFields(ctx);
  assert.equal(generatedFieldFor('com.x.Outer', 'log').typeFqn, 'org.slf4j.Logger');
  assert.equal(generatedFieldFor('com.x.Outer.Inner', 'log').declaredBy, 'com.x.Outer',
    'a nested class reads the outer class\'s private static log');
  assert.equal(generatedFieldFor('com.x.Own', 'log'), null,
    'Lombok refuses to generate over a field the source already writes, and so do we');
  assert.equal(generatedFieldFor('com.x.Outer', null), null);
});

test('calls: which wildcard answers a name is decided by an import line, not by category', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.A', package: 'com.x', name: 'A', file: 'A.java', implements: [] },
    { kind: 'import', owner: 'com.x.A', fqn: 'com.x.util', simple: '*' },
    { kind: 'import', owner: 'com.x.A', fqn: 'java.util', simple: '*' },
    // Somewhere else in this project, somebody wrote the single-type import.
    { kind: 'type', fqn: 'com.x.B', package: 'com.x', name: 'B', file: 'B.java', implements: [] },
    { kind: 'import', owner: 'com.x.B', fqn: 'com.x.util.RedisUtil', simple: 'RedisUtil' },
    { kind: 'type', fqn: 'com.x.C', package: 'com.x', name: 'C', file: 'C.java', implements: [] },
    { kind: 'import', owner: 'com.x.C', fqn: 'java.util.Arrays', simple: 'Arrays' },
  ];
  const ctx = ctxFor(facts, { packagePrefixes: ['com.x'] });
  const { placeByWildcard, reasonFor, outsideRoots } = makeWildcardPlacer(ctx);
  assert.deepEqual(placeByWildcard('com.x.A', 'RedisUtil'), { kind: 'outside-roots', package: 'com.x.util' });
  assert.deepEqual(placeByWildcard('com.x.A', 'Arrays'), { kind: 'jdk', fqn: 'java.util.Arrays', packages: ['java.util'] });
  assert.deepEqual(placeByWildcard('com.x.A', 'ADD_STRING'), UNKNOWN_PLACE,
    'a SHOUTING name is a static-imported constant, and java.util.ADD_STRING is a type that does not exist');
  // The one reason a reader can act on is counted by (package, name).
  assert.equal(reasonFor(placeByWildcard('com.x.A', 'RedisUtil'), 'RedisUtil'), 'project-type-outside-roots');
  assert.equal(reasonFor(UNKNOWN_PLACE, 'X'), 'unknown');
  assert.equal(outsideRoots.get('com.x.util RedisUtil').calls, 1);
});

test('calls: every rule the worker can spell has a rule name and a sentence', () => {
  for (const spelling of Object.keys(CALL_RULES)) {
    const rule = CALL_RULES[spelling];
    assert.ok(CALL_RULE_BASIS[rule], `${spelling} -> ${rule} has no sentence`);
  }
  for (const [rule, sentence] of Object.entries(CALL_RULE_BASIS)) {
    assert.ok(sentence.length > 60, `${rule} needs a sentence, not a label`);
  }
  assert.equal(CALL_RULES['this-method'], CALL_RULES.unqualified,
    '`this.m()` is the SAME call as the unqualified `m()`: one spelling, one rule');
});

test('calls: a field injected BY NAME reaches the one class that answers to it', () => {
  // Two implementors of one interface, and a field that names one of them. The
  // dispatch rule alone reaches both; the annotation says which is really there.
  const facts = [
    { kind: 'type', fqn: 'com.x.CmmUseService', package: 'com.x', name: 'CmmUseService', file: 'CmmUseService.java', typeKind: 'interface', implements: [], declaredMethods: ['selectCodes/1'] },
    { kind: 'type', fqn: 'com.x.CmmUseServiceImpl', package: 'com.x', name: 'CmmUseServiceImpl', file: 'CmmUseServiceImpl.java', typeKind: 'class', annotations: ['Service'], beanName: 'EgovCmmUseService', implements: ['CmmUseService'], declaredMethods: ['selectCodes/1'] },
    { kind: 'type', fqn: 'com.x.CmmUseServiceStub', package: 'com.x', name: 'CmmUseServiceStub', file: 'CmmUseServiceStub.java', typeKind: 'class', annotations: ['Service'], beanName: 'stubCmmUseService', implements: ['CmmUseService'], declaredMethods: ['selectCodes/1'] },
    { kind: 'type', fqn: 'com.x.CodeController', package: 'com.x', name: 'CodeController', file: 'CodeController.java', typeKind: 'class', annotations: ['Controller'], implements: [], declaredMethods: ['list/1'] },
    { kind: 'field', owner: 'com.x.CodeController', name: 'cmmUseService', typeSimple: 'CmmUseService', beanName: 'EgovCmmUseService', file: 'CodeController.java' },
    { kind: 'call', from: 'com.x.CodeController#list', receiver: 'cmmUseService', method: 'selectCodes', toTypeSimple: 'CmmUseService', via: 'field', file: 'CodeController.java' },
  ];
  const ctx = ctxFor(facts);
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeBeanNames(ctx));
  cw.queueIfInherited = () => {};
  cw.inheritorsFor = () => new Map();
  cw.bindSuperBody = () => {};
  placeCallEdges(ctx, cw);
  const edges = [...ctx.g.edges].filter((e) => e.type === 'MAY_CALL');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, symbolId('com.x.CmmUseServiceImpl#selectCodes'), 'the named bean, not the interface');
  assert.equal(edges[0].grade, 'SOUND_SET', 'an interface dispatch never becomes EXACT, however well named');
  assert.equal(edges[0].evidence.rule, 'spring-bean-name');
  assert.equal(edges[0].evidence.bean, 'EgovCmmUseService');
  assert.equal(edges[0].evidence.candidateCount, 1);
  assert.equal(edges[0].evidence.iface, 'com.x.CmmUseService');
  assert.equal(ctx.stats.beanNames.sites, 1);
  assert.equal(ctx.stats.beanNames.narrowed, 1);
});

test('calls: a bean name no class answers to changes nothing, and is counted', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.PropertyService', package: 'com.x', name: 'PropertyService', file: 'PropertyService.java', typeKind: 'interface', implements: [], declaredMethods: ['getString/1'] },
    { kind: 'type', fqn: 'com.x.PropertyServiceImpl', package: 'com.x', name: 'PropertyServiceImpl', file: 'PropertyServiceImpl.java', typeKind: 'class', implements: ['PropertyService'], declaredMethods: ['getString/1'] },
    { kind: 'type', fqn: 'com.x.CodeController', package: 'com.x', name: 'CodeController', file: 'CodeController.java', typeKind: 'class', annotations: ['Controller'], implements: [], declaredMethods: ['list/1'] },
    // The bean is declared in an XML this engine does not read.
    { kind: 'field', owner: 'com.x.CodeController', name: 'propertiesService', typeSimple: 'PropertyService', beanName: 'propertiesService', file: 'CodeController.java' },
    { kind: 'call', from: 'com.x.CodeController#list', receiver: 'propertiesService', method: 'getString', toTypeSimple: 'PropertyService', via: 'field', file: 'CodeController.java' },
  ];
  const ctx = ctxFor(facts);
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeBeanNames(ctx));
  cw.queueIfInherited = () => {};
  cw.inheritorsFor = () => new Map();
  cw.bindSuperBody = () => {};
  placeCallEdges(ctx, cw);
  const edges = [...ctx.g.edges].filter((e) => e.type === 'MAY_CALL');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, symbolId('com.x.PropertyService#getString'), 'today\'s dispatch, untouched');
  assert.equal(edges[0].evidence.rule, 'field-receiver');
  assert.equal(ctx.stats.beanNames.narrowed, 0);
  assert.equal(ctx.stats.beanNames.unknownName, 1);
});

test('calls: a transaction boundary declared on the interface keeps its hop', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.OrderService', package: 'com.x', name: 'OrderService', file: 'OrderService.java', typeKind: 'interface', implements: [], declaredMethods: ['place/1'] },
    { kind: 'type', fqn: 'com.x.OrderServiceImpl', package: 'com.x', name: 'OrderServiceImpl', file: 'OrderServiceImpl.java', typeKind: 'class', annotations: ['Service'], beanName: 'orderService', implements: ['OrderService'], declaredMethods: ['place/1'] },
    { kind: 'type', fqn: 'com.x.OrderController', package: 'com.x', name: 'OrderController', file: 'OrderController.java', typeKind: 'class', annotations: ['Controller'], implements: [], declaredMethods: ['post/1'] },
    { kind: 'field', owner: 'com.x.OrderController', name: 'orderService', typeSimple: 'OrderService', beanName: 'orderService', file: 'OrderController.java' },
    { kind: 'call', from: 'com.x.OrderController#post', receiver: 'orderService', method: 'place', toTypeSimple: 'OrderService', via: 'field', file: 'OrderController.java' },
    // The annotation sits on the interface, where there is no body: the engine
    // marks that member and walks FORWARD from it for the footprint.
    { kind: 'transactional', method: 'com.x.OrderService#place', scope: 'method', line: 3 },
  ];
  const ctx = ctxFor(facts);
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeBeanNames(ctx));
  cw.queueIfInherited = () => {};
  cw.inheritorsFor = () => new Map();
  cw.bindSuperBody = () => {};
  placeCallEdges(ctx, cw);
  const edges = [...ctx.g.edges].filter((e) => e.type === 'MAY_CALL');
  assert.equal(edges[0].to, symbolId('com.x.OrderService#place'), 'the boundary stays on the path');
  assert.equal(ctx.stats.beanNames.transactionBoundary, 1);
  assert.equal(ctx.stats.beanNames.narrowed, 0);
});

// ---------------------------------------------------------------------------
// persistence.mjs — where a Java method meets the SQL
// ---------------------------------------------------------------------------

test('persistence: a mapper is witnessed by a statement node OR by @Mapper, and both bind', () => {
  const facts = [
    { kind: 'type', fqn: 'com.x.OrderMapper', package: 'com.x', name: 'OrderMapper', file: 'OrderMapper.java', typeKind: 'interface', annotations: ['Mapper'], implements: [] },
    { kind: 'method', fqn: 'com.x.OrderMapper#selectById', owner: 'com.x.OrderMapper', line: 4, paramCount: 1 },
    { kind: 'method', fqn: 'com.x.OrderMapper#selectMissing', owner: 'com.x.OrderMapper', line: 5, paramCount: 1 },
  ];
  const ctx = ctxFor(facts);
  // The SQL bridge has already put one of the two statements on the graph.
  ctx.g.addNode({ id: nodeId('statement', 'com.x.OrderMapper.selectById'), statement: 'com.x.OrderMapper.selectById' });
  registerMethodSymbols(ctx);
  const owners = mapperOwnersOf(ctx);
  assert.ok(owners.has('com.x.OrderMapper'));
  bindStatements(ctx, owners);
  const bound = [...ctx.g.edges].filter((e) => e.type === 'IMPLEMENTS_STMT');
  assert.equal(bound.length, 1);
  assert.equal(bound[0].grade, 'EXACT', 'a statement id IS the interface fqn plus the method name');
  assert.equal(ctx.stats.mapperMethods, 2);
  assert.equal(ctx.stats.mapperMethodsBound, 1);
  assert.equal(ctx.stats.unboundMapperMethods, 1,
    'the statement this method would run is not in this pack: counted, never invented');
  assert.equal(ctx.g.nodes.get(symbolId('com.x.OrderMapper#selectById')).mapperMethod, true);
});

// A DAO shaped like eGovFrame's: no mapper interface anywhere, a session base
// the run never parsed, and the statement named in the call.
const EGOV_FACTS = [
  { kind: 'type', fqn: 'com.x.SampleDAO', package: 'com.x', name: 'SampleDAO', file: 'SampleDAO.java', typeKind: 'class', annotations: ['Repository'], beanName: 'SampleDAO', implements: [], extends: 'EgovAbstractMapper', declaredMethods: ['selectSampleList/1', 'insertSample/1', 'countSamples/1'] },
  { kind: 'import', owner: 'com.x.SampleDAO', simple: 'EgovAbstractMapper', fqn: 'org.egovframe.rte.psl.dataaccess.EgovAbstractMapper', file: 'SampleDAO.java' },
  { kind: 'call', from: 'com.x.SampleDAO#selectSampleList', receiver: 'this', method: 'selectList', toTypeSimple: 'SampleDAO', via: 'unqualified', stmtId: 'SampleDAO.selectSampleList', stmtIdFrom: 'literal', line: 12, file: 'SampleDAO.java' },
  { kind: 'call', from: 'com.x.SampleDAO#insertSample', receiver: 'this', method: 'insert', toTypeSimple: 'SampleDAO', via: 'unqualified', stmtId: 'SampleDAO.insertNothing', stmtIdFrom: 'literal', line: 20, file: 'SampleDAO.java' },
  { kind: 'call', from: 'com.x.SampleDAO#countSamples', receiver: 'this', method: 'selectOne', toTypeSimple: 'SampleDAO', via: 'unqualified', stmtArg: '"SampleDAO." + suffix', line: 28, file: 'SampleDAO.java' },
  // A call of the same NAME on something that is not a session: no receiver of
  // this shape is a MyBatis session, so the rule must leave it alone.
  { kind: 'type', fqn: 'com.x.Cache', package: 'com.x', name: 'Cache', file: 'Cache.java', typeKind: 'class', implements: [], declaredMethods: ['put/2'] },
  { kind: 'call', from: 'com.x.Cache#put', receiver: 'this', method: 'update', toTypeSimple: 'Cache', via: 'unqualified', stmtId: 'SampleDAO.selectSampleList', stmtIdFrom: 'literal', line: 5, file: 'Cache.java' },
];

test('persistence: a class whose extends chain names a session base is one, even unparsed', () => {
  const ctx = ctxFor(EGOV_FACTS);
  const sessions = sessionTypesOf(ctx);
  assert.ok(sessions.has('com.x.SampleDAO'), 'the extends clause is the whole evidence');
  assert.equal(sessions.has('com.x.Cache'), false);
});

test('persistence: a statement called by its string id binds EXACT, and the misses are named', () => {
  const ctx = ctxFor(EGOV_FACTS);
  ctx.g.addNode({ id: nodeId('statement', 'SampleDAO.selectSampleList'), statement: 'SampleDAO.selectSampleList' });
  bindStatementIds(ctx);
  const bound = [...ctx.g.edges].filter((e) => e.type === 'IMPLEMENTS_STMT');
  assert.equal(bound.length, 1, 'one edge: the call on a non-session receiver is not one of these');
  assert.equal(bound[0].from, symbolId('com.x.SampleDAO#selectSampleList'));
  assert.equal(bound[0].to, nodeId('statement', 'SampleDAO.selectSampleList'));
  assert.equal(bound[0].grade, 'EXACT', 'the literal IS the key MyBatis looks the statement up by');
  assert.equal(bound[0].evidence.rule, 'mybatis-statement-id');
  assert.equal(bound[0].evidence.statement, 'SampleDAO.selectSampleList');

  const c = ctx.stats.statementIds;
  assert.equal(c.sites, 3, 'three session calls; the Cache one is not a session call');
  assert.equal(c.bound, 1);
  assert.equal(c.unknown, 1, 'a literal naming no statement this pack holds gets NO edge');
  assert.deepEqual(c.unknownSamples.map((x) => x.id), ['SampleDAO.insertNothing']);
  assert.equal(c.unknownSamples[0].line, 20, 'the miss is listed with its site');
  assert.equal(c.unreadable, 1);
  assert.equal(c.unreadableSamples[0].wrote, '"SampleDAO." + suffix');
  assert.equal(ctx.stats.implementsStmt, 1);
});

test('persistence: a method that calls one statement twice makes one edge', () => {
  const twice = [
    ...EGOV_FACTS,
    { kind: 'call', from: 'com.x.SampleDAO#selectSampleList', receiver: 'this', method: 'selectOne', toTypeSimple: 'SampleDAO', via: 'unqualified', stmtId: 'SampleDAO.selectSampleList', stmtIdFrom: 'literal', line: 14, file: 'SampleDAO.java' },
  ];
  const ctx = ctxFor(twice);
  ctx.g.addNode({ id: nodeId('statement', 'SampleDAO.selectSampleList'), statement: 'SampleDAO.selectSampleList' });
  bindStatementIds(ctx);
  assert.equal([...ctx.g.edges].filter((e) => e.type === 'IMPLEMENTS_STMT').length, 1);
  assert.equal(ctx.stats.statementIds.repeated, 1);
});

test('persistence: a @Transactional boundary is marked on its own symbol, created if need be', () => {
  const ctx = ctxFor(FACTS);
  markTransactions(ctx);
  const n = ctx.g.nodes.get(symbolId('com.x.OwnerServiceImpl#find'));
  assert.equal(n.transactional, true);
  assert.equal(n.txScope, 'REQUIRED');
  assert.equal(ctx.stats.transactional, 1);
});

// ---------------------------------------------------------------------------
// the layering these modules were split under
// ---------------------------------------------------------------------------

test('no module under src/adapters/java/ imports the bridge back', () => {
  const dir = path.join(ROOT, 'src', 'adapters', 'java');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 5, `expected the split modules, found ${files.length}`);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/from '\.\.\/java_bridge\.mjs'/.test(text), false, `${f} imports the bridge it is part of`);
    // …and none of them reaches into another lane's bridge either.
    assert.equal(/from '\.\.\/(web|jpa|mp|sql|har|runtime|openapi)_bridge\.mjs'/.test(text), false,
      `${f} reaches into another lane`);
  }
});

test('every module says what it owns and what it must never know about', () => {
  const dir = path.join(ROOT, 'src', 'adapters', 'java');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 3000);
    assert.match(head, /WHAT THIS MODULE OWNS/, `${f} does not say what it owns`);
    assert.match(head, /WHAT IT MUST NEVER KNOW ABOUT/, `${f} does not say what it must not know`);
  }
  const shared = fs.readFileSync(path.join(ROOT, 'src', 'adapters', 'http_routes.mjs'), 'utf8').slice(0, 3000);
  assert.match(shared, /WHAT THIS MODULE OWNS/);
  assert.match(shared, /WHAT IT MUST NEVER KNOW ABOUT/);
});

test('nothing under src/core/ imports an adapter or the mcp layer', () => {
  // The layering rule the whole engine rests on, checked here because this round
  // moved a rule OUT of a lane and had to decide where it could live.
  const dir = path.join(ROOT, 'src', 'core');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/from '\.\.\/adapters\//.test(text), false, `src/core/${f} imports an adapter`);
    assert.equal(/from '\.\.\/mcp\//.test(text), false, `src/core/${f} imports the mcp layer`);
  }
});
