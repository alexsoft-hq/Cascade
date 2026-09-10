import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId, Graph, FLOW_EDGE_TYPES } from '../src/core/graph.mjs';
import {
  addJavaFacts,
  endpointsAffectingColumn,
  symbolId,
  endpointId,
  JAVAFACTS_SCHEMA,
  JavaBridgeError,
  pathGlobMatcher,
  classifyRouteHolder,
  JAVA_LANG_TYPES,
  LOMBOK_LOGGERS,
  CALL_RULE_BASIS,
} from '../src/adapters/java_bridge.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import { handlersOf, primaryHandlerOf } from '../src/core/walks.mjs';

// ---------------------------------------------------------------------------
// symbolId / endpointId shape
// ---------------------------------------------------------------------------

test('symbolId: wraps a member fqn as a symbol node id', () => {
  assert.equal(symbolId('com.x.Foo#bar'), 'symbol:com.x.Foo#bar');
  assert.equal(symbolId('com.x.Foo#bar'), nodeId('symbol', 'com.x.Foo#bar'));
});

test('endpointId: joins httpMethod and path with a space, position-independent of route params', () => {
  assert.equal(endpointId('GET', '/foo'), 'endpoint:GET /foo');
  assert.equal(endpointId('GET', '/foo'), nodeId('endpoint', 'GET /foo'));
});

test('JAVAFACTS_SCHEMA: names the cascade:javafacts:1 schema', () => {
  assert.equal(JAVAFACTS_SCHEMA, 'cascade:javafacts:1');
});

// ---------------------------------------------------------------------------
// HANDLES: endpoint -> handler
// ---------------------------------------------------------------------------

test('addJavaFacts: an endpoint record creates endpoint + handler symbol nodes and a HANDLES/EXACT edge', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'endpoint', httpMethod: 'GET', path: '/foo', handler: 'com.x.FooController#foo' },
  ]);

  const epId = endpointId('GET', '/foo');
  const hId = symbolId('com.x.FooController#foo');

  const epNode = g.nodes.get(epId);
  assert.ok(epNode, 'expected endpoint node to exist');
  assert.equal(epNode.path, '/foo');
  assert.equal(epNode.httpMethod, 'GET');
  assert.equal(epNode.handler, 'com.x.FooController#foo');

  const hNode = g.nodes.get(hId);
  assert.ok(hNode, 'expected handler symbol node to exist');
  assert.equal(hNode.symbol, 'com.x.FooController#foo');
  assert.equal(hNode.owner, 'com.x.FooController');

  const edge = g.edges.find((e) => e.type === 'HANDLES' && e.from === epId && e.to === hId);
  assert.ok(edge, 'expected HANDLES edge endpoint -> handler');
  assert.equal(edge.grade, 'EXACT');

  assert.equal(stats.endpoints, 1);
  assert.equal(stats.handles, 1);
});

// ---------------------------------------------------------------------------
// A route two controllers declare (RM13)
// ---------------------------------------------------------------------------
//
// mall declares `GET /order/list` twice: OmsOrderController#list (admin) and
// OmsPortalOrderController#list (portal). One node, two HANDLES edges. RM11
// made every WALK start at every handler; the node's own attributes were still
// written once per fact, so the last one ingested won — and ingest order is a
// property of the shard cache, not of the code.

const TWO_CONTROLLERS = {
  admin: [
    { kind: 'type', fqn: 'com.x.admin.OmsOrderController', pkg: 'com.x.admin', name: 'OmsOrderController', file: 'admin/src/main/java/com/x/admin/OmsOrderController.java', implementsSimple: [] },
    { kind: 'method', fqn: 'com.x.admin.OmsOrderController#list', owner: 'com.x.admin.OmsOrderController', line: 41 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.admin.OmsOrderController#list', line: 40, file: 'admin/src/main/java/com/x/admin/OmsOrderController.java' },
  ],
  portal: [
    { kind: 'type', fqn: 'com.x.portal.OmsPortalOrderController', pkg: 'com.x.portal', name: 'OmsPortalOrderController', file: 'portal/src/main/java/com/x/portal/OmsPortalOrderController.java', implementsSimple: [] },
    { kind: 'method', fqn: 'com.x.portal.OmsPortalOrderController#list', owner: 'com.x.portal.OmsPortalOrderController', line: 77 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.portal.OmsPortalOrderController#list', line: 76, file: 'portal/src/main/java/com/x/portal/OmsPortalOrderController.java' },
  ],
};
const EP_TWO = endpointId('GET', '/order/list');

test('addJavaFacts: a route declared by two controllers gets IDENTICAL node attributes in either ingest order', () => {
  const attrsFor = (facts) => {
    const g = new Graph();
    addJavaFacts(g, facts, { packagePrefixes: ['com.x'] });
    return g.nodes.get(EP_TWO);
  };
  const adminFirst = attrsFor([...TWO_CONTROLLERS.admin, ...TWO_CONTROLLERS.portal]);
  const portalFirst = attrsFor([...TWO_CONTROLLERS.portal, ...TWO_CONTROLLERS.admin]);
  assert.deepEqual(adminFirst, portalFirst,
    'the endpoint node must not depend on which controller the analyzer ingested last');

  // …and the attributes name a handler that REALLY handles the route: the
  // primary one, by the same lowest-id rule core/walks.mjs applies to the edges.
  assert.equal(adminFirst.handler, 'com.x.admin.OmsOrderController#list');
  assert.equal(adminFirst.file, 'admin/src/main/java/com/x/admin/OmsOrderController.java');
  assert.equal(adminFirst.line, 40);
  // …and the node SAYS the route is declared twice, where a reader sees it.
  assert.deepEqual(adminFirst.handlers,
    ['com.x.admin.OmsOrderController#list', 'com.x.portal.OmsPortalOrderController#list']);
});

test('addJavaFacts: the node attributes agree with primaryHandlerOf, in either order', () => {
  for (const facts of [[...TWO_CONTROLLERS.admin, ...TWO_CONTROLLERS.portal],
    [...TWO_CONTROLLERS.portal, ...TWO_CONTROLLERS.admin]]) {
    const g = new Graph();
    addJavaFacts(g, facts, { packagePrefixes: ['com.x'] });
    const node = g.nodes.get(EP_TWO);
    assert.equal(symbolId(node.handler), primaryHandlerOf(g, EP_TWO));
    assert.deepEqual(handlersOf(g, EP_TWO).map((id) => id.slice('symbol:'.length)), node.handlers);
    // Both declarations are still edges — nothing was merged away.
    assert.equal(g.edges.filter((e) => e.type === 'HANDLES' && e.from === EP_TWO).length, 2);
  }
});

test('addJavaFacts: a single-handler route carries NO handlers list (the field is the disclosure)', () => {
  const g = new Graph();
  addJavaFacts(g, TWO_CONTROLLERS.admin, { packagePrefixes: ['com.x'] });
  const node = g.nodes.get(EP_TWO);
  assert.equal('handlers' in node, false);
  assert.equal(node.handler, 'com.x.admin.OmsOrderController#list');
});

test('addJavaFacts: two mappings on ONE method take the lowest line, whichever arrived first', () => {
  const facts = (lines) => [
    { kind: 'type', fqn: 'com.x.RootController', pkg: 'com.x', name: 'RootController', file: 'src/main/java/com/x/RootController.java', implementsSimple: [] },
    { kind: 'method', fqn: 'com.x.RootController#home', owner: 'com.x.RootController', line: 20 },
    ...lines.map((line) => ({ kind: 'endpoint', httpMethod: 'GET', path: '/', handler: 'com.x.RootController#home', line })),
  ];
  const lineOf = (ls) => { const g = new Graph(); addJavaFacts(g, facts(ls), { packagePrefixes: ['com.x'] }); return g.nodes.get(endpointId('GET', '/')).line; };
  assert.equal(lineOf([18, 19]), 18);
  assert.equal(lineOf([19, 18]), 18);
});

test('addJavaFacts: an endpoint record with no handler is skipped entirely (no node, no edge, no count)', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [{ kind: 'endpoint', httpMethod: 'GET', path: '/nohandler', handler: null }]);
  assert.equal(g.nodes.size, 0);
  assert.equal(stats.endpoints, 0);
  assert.equal(stats.handles, 0);
});

// ---------------------------------------------------------------------------
// call resolution — all four resolveType paths, each landing on MAY_CALL/SOUND_SET
// ---------------------------------------------------------------------------

test('addJavaFacts: call resolution via explicit import, same package, wildcard import, and globally-unique simple name', () => {
  const g = new Graph();
  const facts = [
    // owner of every call below: com.x.FooController, package com.x
    { kind: 'type', fqn: 'com.x.FooController', typeKind: 'class', package: 'com.x', implements: [] },

    // (a) explicit import
    { kind: 'type', fqn: 'com.y.BarService', typeKind: 'class', package: 'com.y', implements: [] },
    { kind: 'import', owner: 'com.x.FooController', simple: 'BarService', fqn: 'com.y.BarService' },
    { kind: 'call', from: 'com.x.FooController#foo1', method: 'bar', toTypeSimple: 'BarService' },

    // (b) same package (com.x.BazService, no import needed)
    { kind: 'type', fqn: 'com.x.BazService', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'call', from: 'com.x.FooController#foo2', method: 'baz', toTypeSimple: 'BazService' },

    // (c) wildcard (on-demand) import
    { kind: 'type', fqn: 'com.z.QuxService', typeKind: 'class', package: 'com.z', implements: [] },
    { kind: 'import', owner: 'com.x.FooController', simple: '*', fqn: 'com.z' },
    { kind: 'call', from: 'com.x.FooController#foo3', method: 'qux', toTypeSimple: 'QuxService' },

    // (d) globally-unique simple name (no import, different package, not same package)
    { kind: 'type', fqn: 'com.w.UniqueService', typeKind: 'class', package: 'com.w', implements: [] },
    { kind: 'call', from: 'com.x.FooController#foo4', method: 'doIt', toTypeSimple: 'UniqueService' },
  ];

  const stats = addJavaFacts(g, facts);
  assert.equal(stats.calls, 4);
  assert.equal(stats.unresolvedCalls, 0);

  const cases = [
    ['com.x.FooController#foo1', 'com.y.BarService#bar'],
    ['com.x.FooController#foo2', 'com.x.BazService#baz'],
    ['com.x.FooController#foo3', 'com.z.QuxService#qux'],
    ['com.x.FooController#foo4', 'com.w.UniqueService#doIt'],
  ];

  for (const [from, to] of cases) {
    const fromId = symbolId(from);
    const toId = symbolId(to);
    const edge = g.edges.find((e) => e.type === 'MAY_CALL' && e.from === fromId && e.to === toId);
    assert.ok(edge, `expected MAY_CALL edge ${from} -> ${to}`);
    assert.equal(edge.grade, 'SOUND_SET');
    // Honesty invariant: a resolved call is NEVER dressed up as EXACT.
    assert.notEqual(edge.grade, 'EXACT');
  }
});

// ---------------------------------------------------------------------------
// unresolved call
// ---------------------------------------------------------------------------

test('addJavaFacts: a call whose type cannot be resolved (ambiguous simple name) creates no edge and counts unresolvedCalls', () => {
  const g = new Graph();
  const facts = [
    { kind: 'type', fqn: 'com.x.FooController', typeKind: 'class', package: 'com.x', implements: [] },
    // Two app types share the simple name "Ambiguous" in different packages —
    // neither imported, neither same-package as the caller — so the global
    // fallback (step 4) must refuse to guess.
    { kind: 'type', fqn: 'com.a.Ambiguous', typeKind: 'class', package: 'com.a', implements: [] },
    { kind: 'type', fqn: 'com.b.Ambiguous', typeKind: 'class', package: 'com.b', implements: [] },
    { kind: 'call', from: 'com.x.FooController#foo', method: 'go', toTypeSimple: 'Ambiguous' },
  ];

  const stats = addJavaFacts(g, facts);
  assert.equal(stats.calls, 0);
  assert.equal(stats.unresolvedCalls, 1);

  const fromId = symbolId('com.x.FooController#foo');
  const outEdges = g.edges.filter((e) => e.from === fromId);
  assert.equal(outEdges.length, 0, 'expected no MAY_CALL edge for an unresolved call');
});

// ---------------------------------------------------------------------------
// dispatch: interfaceMethod -> implMethod (only for interface targets actually called)
// ---------------------------------------------------------------------------

test('addJavaFacts: dispatch creates interfaceMethod -> implMethod MAY_CALL/SOUND_SET only for a called interface method', () => {
  const g = new Graph();
  const facts = [
    { kind: 'type', fqn: 'com.x.FooController', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'type', fqn: 'com.x.GreeterService', typeKind: 'interface', package: 'com.x', implements: [] },
    { kind: 'type', fqn: 'com.x.GreeterServiceImpl', typeKind: 'class', package: 'com.x', implements: ['GreeterService'] },
    // Register the interface's "other" method as a symbol via a method record,
    // WITHOUT ever calling it — dispatch must not fire for it.
    { kind: 'method', fqn: 'com.x.GreeterService#other', owner: 'com.x.GreeterService' },
    { kind: 'call', from: 'com.x.FooController#foo', method: 'greet', toTypeSimple: 'GreeterService' },
  ];

  const stats = addJavaFacts(g, facts);
  assert.equal(stats.dispatch, 1);

  const ifaceGreet = symbolId('com.x.GreeterService#greet');
  const implGreet = symbolId('com.x.GreeterServiceImpl#greet');
  const dispatchEdge = g.edges.find((e) => e.type === 'MAY_CALL' && e.from === ifaceGreet && e.to === implGreet);
  assert.ok(dispatchEdge, 'expected dispatch edge interfaceMethod -> implMethod for the called method');
  assert.equal(dispatchEdge.grade, 'SOUND_SET');
  assert.notEqual(dispatchEdge.grade, 'EXACT');

  // The interface method that was never called gets no dispatch edge, even
  // though its symbol node exists (registered via the method record above).
  const ifaceOther = symbolId('com.x.GreeterService#other');
  assert.ok(g.nodes.has(ifaceOther), 'sanity: the uncalled method symbol should still exist');
  const otherOutEdges = g.edges.filter((e) => e.from === ifaceOther);
  assert.equal(otherOutEdges.length, 0, 'expected no dispatch edge for an interface method that was never called');
});

// ---------------------------------------------------------------------------
// IMPLEMENTS_STMT: mapperMethod -> statement, only when the statement node pre-exists
// ---------------------------------------------------------------------------

test('addJavaFacts: a method whose member fqn matches an existing statement node gets an IMPLEMENTS_STMT/EXACT edge', () => {
  const g = new Graph();
  // Pre-add the statement node, as sql_bridge would have (owner#method -> owner.method).
  const stmtId = nodeId('statement', 'com.x.FooMapper.selectFoo');
  g.addNode({ id: stmtId, statementType: 'select' });

  const stats = addJavaFacts(g, [
    { kind: 'method', fqn: 'com.x.FooMapper#selectFoo', owner: 'com.x.FooMapper' },
    // No statement node exists for selectBar — must NOT get an edge.
    { kind: 'method', fqn: 'com.x.FooMapper#selectBar', owner: 'com.x.FooMapper' },
  ]);

  const mapperId = symbolId('com.x.FooMapper#selectFoo');
  const edge = g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.from === mapperId && e.to === stmtId);
  assert.ok(edge, 'expected IMPLEMENTS_STMT edge mapperMethod -> statement');
  assert.equal(edge.grade, 'EXACT');
  assert.equal(stats.implementsStmt, 1);

  const noStmtId = symbolId('com.x.FooMapper#selectBar');
  const missingEdge = g.edges.find((e) => e.type === 'IMPLEMENTS_STMT' && e.from === noStmtId);
  assert.equal(missingEdge, undefined, 'expected NO IMPLEMENTS_STMT edge when the statement node is absent');
});

// ---------------------------------------------------------------------------
// end-to-end stitch + weakest link
// ---------------------------------------------------------------------------

test('endpointsAffectingColumn: stitches endpoint -> handler -> (MAY_CALL) -> mapper -> statement -> column and reports weakest-link SOUND_SET', () => {
  const g = new Graph();

  // Pre-existing SQL-lane chain: statement --WRITES(EXACT)--> column.
  const stmtId = nodeId('statement', 'com.x.FooMapper.selectFoo');
  const colId = nodeId('column', 'main.T.C');
  g.addNode({ id: stmtId, statementType: 'update' });
  g.addEdge({ from: stmtId, to: colId, type: 'WRITES', grade: 'EXACT' });

  // Java-lane facts: endpoint -> handler -> (call, same package) -> mapper method.
  const facts = [
    { kind: 'endpoint', httpMethod: 'GET', path: '/foo', handler: 'com.x.FooController#foo' },
    { kind: 'type', fqn: 'com.x.FooController', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'type', fqn: 'com.x.FooMapper', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'call', from: 'com.x.FooController#foo', method: 'selectFoo', toTypeSimple: 'FooMapper' },
    { kind: 'method', fqn: 'com.x.FooMapper#selectFoo', owner: 'com.x.FooMapper' },
  ];
  const stats = addJavaFacts(g, facts);
  assert.equal(stats.handles, 1);
  assert.equal(stats.calls, 1);
  assert.equal(stats.implementsStmt, 1);

  const result = endpointsAffectingColumn(g, colId);
  assert.equal(result.length, 1);
  assert.equal(result[0].endpoint, endpointId('GET', '/foo'));
  assert.equal(result[0].httpMethod, 'GET');
  assert.equal(result[0].path, '/foo');
  // Weakest link on the path is the MAY_CALL(SOUND_SET) hop — never EXACT,
  // even though every other hop on this path is EXACT.
  assert.equal(result[0].pathGrade, 'SOUND_SET');
  assert.notEqual(result[0].pathGrade, 'EXACT');
});

test('endpointsAffectingColumn: a column with no reachable endpoint returns an empty array', () => {
  const g = new Graph();
  const colId = nodeId('column', 'main.T.Lonely');
  g.addNode({ id: colId, name: 'Lonely' });
  const result = endpointsAffectingColumn(g, colId);
  assert.deepEqual(result, []);
});

test('endpointsAffectingColumn: DECLARES and JOINS are schema, not flow — only the column the SQL writes carries the endpoint', () => {
  const g = new Graph();
  // Same stitch as above, with the SCHEMA around it: table main.T declares two
  // columns (the statement writes only C), and main.T is joined to main.U.
  const stmtId = nodeId('statement', 'com.x.FooMapper.selectFoo');
  const tableId = nodeId('table', 'main.T');
  const colId = nodeId('column', 'main.T.C');
  const siblingId = nodeId('column', 'main.T.Other');
  const joinedTable = nodeId('table', 'main.U');
  const joinedCol = nodeId('column', 'main.U.K');
  g.addNode({ id: stmtId, statementType: 'update' });
  g.addEdge({ from: stmtId, to: tableId, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'write' } });
  g.addEdge({ from: stmtId, to: colId, type: 'WRITES', grade: 'EXACT' });
  g.addEdge({ from: tableId, to: colId, type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: tableId, to: siblingId, type: 'DECLARES', grade: 'EXACT' });
  g.addEdge({ from: tableId, to: joinedTable, type: 'JOINS', grade: 'EXACT', evidence: { columns: ['C=K'], count: 1 } });
  g.addEdge({ from: joinedTable, to: joinedCol, type: 'DECLARES', grade: 'EXACT' });
  addJavaFacts(g, [
    { kind: 'endpoint', httpMethod: 'GET', path: '/foo', handler: 'com.x.FooController#foo' },
    { kind: 'type', fqn: 'com.x.FooController', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'type', fqn: 'com.x.FooMapper', typeKind: 'class', package: 'com.x', implements: [] },
    { kind: 'call', from: 'com.x.FooController#foo', method: 'selectFoo', toTypeSimple: 'FooMapper' },
    { kind: 'method', fqn: 'com.x.FooMapper#selectFoo', owner: 'com.x.FooMapper' },
  ]);

  const ep = endpointId('GET', '/foo');
  assert.deepEqual(endpointsAffectingColumn(g, colId).map((e) => e.endpoint), [ep]);
  assert.deepEqual(endpointsAffectingColumn(g, siblingId), [], 'the statement never writes Other');
  assert.deepEqual(endpointsAffectingColumn(g, joinedCol), [], 'no statement here executes main.U at all');
  // The edges really are in the graph — an unfiltered backward walk climbs them
  // and hands both columns an endpoint that never touched them. That is the
  // inflation the flow filter removes, not a gap in this fixture.
  assert.ok(g.impactOf(siblingId, { mode: 'conservative' }).has(ep));
  assert.ok(g.impactOf(joinedCol, { mode: 'conservative' }).has(ep));
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test('addJavaFacts: throws JavaBridgeError when g is not a Graph', () => {
  assert.throws(() => addJavaFacts({}, []), JavaBridgeError);
  assert.throws(() => addJavaFacts(null, []), JavaBridgeError);
});

test('addJavaFacts: throws JavaBridgeError when javaFacts is not an array', () => {
  const g = new Graph();
  assert.throws(() => addJavaFacts(g, null), JavaBridgeError);
  assert.throws(() => addJavaFacts(g, {}), JavaBridgeError);
});

test('addJavaFacts: header records and unknown record kinds are ignored without error', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'header', tool: 'java-facts', version: 1 },
    { kind: 'mystery', foo: 'bar' },
    null,
    'not-an-object',
  ]);
  assert.equal(g.nodes.size, 0);
  assert.deepEqual(stats, {
    endpoints: 0, handles: 0, calls: 0, dispatch: 0, implementsStmt: 0, unresolvedCalls: 0,
    externalCalls: 0, externalSymbols: 0,
    mapperMethods: 0, mapperMethodsBound: 0, unboundMapperMethods: 0, transactional: 0,
    parseErrors: 0, parsedFiles: 0,
    callsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-binding': 0, 'interface-dispatch': 0,
      'inherited-field': 0, 'interface-dispatch-inherited': 0, 'inherited-member-call': 0,
      'generated-field': 0, 'wildcard-jdk': 0, 'spring-model-attribute': 0,
    },
    unresolvedCallsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-unbound': 0, 'inherited-field': 0,
    },
    // RM35: WHY a call stayed unresolved, beside WHICH rule failed.
    unresolvedCallsByReason: {
      'project-type-outside-roots': 0, 'superclass-outside-roots': 0,
      'type-param-unbound': 0, unknown: 0,
    },
    typesOutsideRoots: [],
    identifierReceivers: { total: 0, inheritedField: 0, generatedField: 0, staticReceiver: 0, unresolved: 0 },
    unresolvedIdentifiers: [],
    inheritedMembers: { synthesized: 0, calls: 0, overapproximated: 0 },
    // The calls Spring makes and no line of source writes: nothing here carries
    // @ModelAttribute, so the rule followed nothing and skipped nothing.
    modelAttribute: { methods: 0, edges: 0, onAdvice: 0, onSuperclass: 0, inheritedHandlers: 0 },
    routeContracts: 0, contractOnlyRoutes: 0,
    httpCalls: 0, httpCallsResolved: 0, httpCallsUnresolved: 0,
    // The two producers of the edge, and the imperative calls that produced
    // none because their url was not in the file.
    httpCallsDeclarative: 0, httpCallsImperative: 0, httpCallsUrlUnreadable: 0,
    // Nothing was declared generated, so nothing was classified — and
    // `generatedDeclared:false` says which of the two it is.
    generatedDeclared: false,
    generatedTypes: 0, generatedTypesByAnnotation: 0, generatedTypesByPath: 0, generatedSymbols: 0,
    // No type record at all, so no FQN can be declared twice.
    duplicateFqns: { count: 0, declarations: 0, byKind: {}, types: [] },
  });
});

// ---------------------------------------------------------------------------
// the same FQN declared in two files (SPEC §3.3)
// ---------------------------------------------------------------------------

/**
 * jeecg-boot's shape, in miniature. `api.IBaseApi` is declared TWICE: a plain
 * interface in the local module, and a @FeignClient with a mapping in the cloud
 * module. Two Maven modules that are never on one classpath, so this is a fact
 * about the repository, not a mistake in it.
 */
function twoDeclarations() {
  const local = {
    kind: 'type', fqn: 'api.IBaseApi', typeKind: 'interface', package: 'api',
    annotations: [], implements: [], declaredMethods: ['byId/1'],
    file: 'local-api/src/main/java/api/IBaseApi.java',
  };
  const cloud = {
    kind: 'type', fqn: 'api.IBaseApi', typeKind: 'interface', package: 'api',
    annotations: ['FeignClient'], implements: [], declaredMethods: ['byId/1'],
    client: { kind: 'FeignClient', service: 'base-service', serviceLiteral: true, url: null, path: null },
    file: 'cloud-api/src/main/java/api/IBaseApi.java',
  };
  const rest = [
    { kind: 'type', fqn: 'biz.BaseApiImpl', typeKind: 'class', package: 'biz', annotations: ['Service'], implements: ['IBaseApi'], declaredMethods: ['byId/1'], file: 'biz/BaseApiImpl.java' },
    { kind: 'import', owner: 'biz.BaseApiImpl', simple: 'IBaseApi', fqn: 'api.IBaseApi', file: 'biz/BaseApiImpl.java' },
    { kind: 'type', fqn: 'biz.OrderController', typeKind: 'class', package: 'biz', annotations: ['RestController'], implements: [], declaredMethods: ['detail/1'], file: 'biz/OrderController.java' },
    { kind: 'import', owner: 'biz.OrderController', simple: 'IBaseApi', fqn: 'api.IBaseApi', file: 'biz/OrderController.java' },
    { kind: 'field', owner: 'biz.OrderController', name: 'api', typeSimple: 'IBaseApi', file: 'biz/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/{id}', handler: 'biz.OrderController#detail', handlerType: 'biz.OrderController', line: 11, file: 'biz/OrderController.java' },
    // the @FeignClient declaration's own mapping — a route this pack CALLS
    { kind: 'endpoint', httpMethod: 'GET', path: '/base/{id}', handler: 'api.IBaseApi#byId', handlerType: 'api.IBaseApi', line: 7, file: 'cloud-api/src/main/java/api/IBaseApi.java' },
    { kind: 'call', from: 'biz.OrderController#detail', receiver: 'api', method: 'byId', toTypeSimple: 'IBaseApi', via: 'field', file: 'biz/OrderController.java' },
    { kind: 'method', fqn: 'biz.BaseApiImpl#byId', owner: 'biz.BaseApiImpl', name: 'byId', paramCount: 1, line: 4, file: 'biz/BaseApiImpl.java' },
  ];
  return { local, cloud, rest };
}

const edgeKeys = (g) => g.edges
  .map((e) => `${e.type} ${e.from} -> ${e.to} ${e.grade} ${JSON.stringify(e.evidence ?? null)}`)
  .sort();

test('a duplicated FQN is COUNTED, by kind, and every declaration is included', () => {
  const { local, cloud, rest } = twoDeclarations();
  const g = new Graph();
  const stats = addJavaFacts(g, [local, cloud, ...rest]);
  assert.deepEqual(stats.duplicateFqns, {
    count: 1,
    declarations: 2,
    // The union of both declarations' annotations decides the kind: one of the
    // two IS a @FeignClient, and that is the more specific thing to say.
    byKind: { 'http-client': 1 },
    types: [{
      fqn: 'api.IBaseApi',
      kind: 'http-client',
      files: ['cloud-api/src/main/java/api/IBaseApi.java', 'local-api/src/main/java/api/IBaseApi.java'],
    }],
  });
  // ONE node per member — the census is a disclosure, not a doubling: two
  // declarations of `api.IBaseApi#byId` are one symbol, reached from both modules.
  assert.deepEqual([...g.nodes.keys()].filter((id) => id.includes('api.IBaseApi')),
    ['symbol:api.IBaseApi#byId']);
});

test('ingest order does not decide any edge when one FQN is declared twice', () => {
  const { local, cloud, rest } = twoDeclarations();
  const a = new Graph();
  const b = new Graph();
  // `types` keeps whichever declaration the stream ends with, so feed them both
  // ways round. If any decision leaned on that choice, the edge sets would part.
  addJavaFacts(a, [local, cloud, ...rest]);
  addJavaFacts(b, [cloud, local, ...rest]);
  assert.deepEqual(edgeKeys(a), edgeKeys(b), 'the same records in the other order must build the same edges');
  assert.deepEqual([...a.nodes.keys()].sort(), [...b.nodes.keys()].sort());

  // …and the one decision that DOES depend on which file a fact came from is
  // still right in both: the @FeignClient's mapping is a call this pack makes,
  // never a route it serves, because the endpoint is classified by its FILE
  // (`typeAt(fqn, file)`), not by whichever type record survived.
  for (const g of [a, b]) {
    const route = nodeId('endpoint', 'GET /base/{id}');
    assert.deepEqual(g.outEdges(route).filter((e) => e.type === 'HANDLES'), [],
      'the client mapping serves nothing');
    assert.equal(g.inEdges(route).filter((e) => e.type === 'CALLS_HTTP').length, 1);
  }
});

test('addJavaFacts: symbol and endpoint nodes carry the source line from method/endpoint facts', () => {
  const g = new Graph();
  addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.C', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [] },
    { kind: 'endpoint', httpMethod: 'GET', path: '/p', handler: 'com.x.C#list', handlerType: 'com.x.C', line: 42 },
    { kind: 'method', fqn: 'com.x.C#list', owner: 'com.x.C', name: 'list', paramCount: 0, line: 42 },
  ]);
  assert.equal(g.nodes.get(nodeId('endpoint', 'GET /p')).line, 42);
  assert.equal(g.nodes.get(nodeId('symbol', 'com.x.C#list')).line, 42);
});

// ---------------------------------------------------------------------------
// which RULE made an edge (RM9b)
// ---------------------------------------------------------------------------

test('every MAY_CALL edge names the rule that produced it', () => {
  const g = new Graph();
  const facts = [
    { kind: 'type', fqn: 'com.example.Ctl', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'type', fqn: 'com.example.Svc', typeKind: 'interface', package: 'com.example', annotations: [], implements: [] },
    { kind: 'type', fqn: 'com.example.SvcImpl', typeKind: 'class', package: 'com.example', annotations: [], implements: ['Svc'] },
    { kind: 'field', owner: 'com.example.Ctl', name: 'svc', typeSimple: 'Svc', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Ctl#a', receiver: 'svc', method: 'run', toTypeSimple: 'Svc', via: 'field', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Ctl#b', receiver: 'svc', method: 'run', toTypeSimple: 'Svc', via: 'this-field', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Ctl#c', receiver: 'this', method: 'helper', toTypeSimple: 'Ctl', via: 'unqualified', file: 'Ctl.java' },
  ];
  const stats = addJavaFacts(g, facts);
  const rules = g.edges.filter((e) => e.type === 'MAY_CALL').map((e) => e.evidence.rule).sort();
  assert.deepEqual(rules, ['field-receiver', 'interface-dispatch', 'this-field', 'unqualified-enclosing']);
  for (const e of g.edges.filter((x) => x.type === 'MAY_CALL')) {
    assert.equal(typeof e.evidence.basis, 'string', `${e.evidence.rule} must carry a basis`);
    assert.ok(e.evidence.basis.length > 20);
  }
  assert.deepEqual(stats.callsByRule, {
    'field-receiver': 1, 'this-field': 1, 'unqualified-enclosing': 1, 'interface-dispatch': 1,
    'super-enclosing': 0, 'type-param-binding': 0,
    'inherited-field': 0, 'interface-dispatch-inherited': 0, 'inherited-member-call': 0,
    'generated-field': 0, 'wildcard-jdk': 0, 'spring-model-attribute': 0,
  });
  // The `this.field` spelling resolves through the SAME field, so it must reach
  // the same target as the bare one — only the recorded rule differs.
  const targets = new Set(g.edges.filter((e) => ['field-receiver', 'this-field'].includes(e.evidence?.rule)).map((e) => e.to));
  assert.deepEqual([...targets], ['symbol:com.example.Svc#run']);
});

test('a call record with no `via` is read as a field receiver, not dropped', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.example.Ctl', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'type', fqn: 'com.example.Svc', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'field', owner: 'com.example.Ctl', name: 'svc', typeSimple: 'Svc', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Ctl#a', receiver: 'svc', method: 'run', toTypeSimple: 'Svc', file: 'Ctl.java' },
  ]);
  assert.equal(stats.callsByRule['field-receiver'], 1);
  assert.equal(g.edges.find((e) => e.type === 'MAY_CALL').evidence.rule, 'field-receiver');
});

test('an UNRESOLVED call is counted under the rule that failed', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.example.Ctl', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'field', owner: 'com.example.Ctl', name: 'log', typeSimple: 'Logger', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Ctl#a', receiver: 'log', method: 'info', toTypeSimple: 'Logger', via: 'field', file: 'Ctl.java' },
    { kind: 'call', from: 'com.example.Nope$1#a', receiver: 'this', method: 'x', toTypeSimple: 'Nope$1', via: 'unqualified', file: 'Ctl.java' },
  ]);
  assert.equal(stats.unresolvedCalls, 2);
  assert.deepEqual(stats.unresolvedCallsByRule, {
    'field-receiver': 1, 'this-field': 0, 'unqualified-enclosing': 1,
    'super-enclosing': 0, 'type-param-unbound': 0, 'inherited-field': 0,
  });
});

test('an unqualified call in a NESTED class resolves to that class, not by simple name', () => {
  // mall has 76 generated `…Example.GeneratedCriteria` classes. Resolving such a
  // call by its simple name is ambiguous 76 ways and (correctly) refuses — but
  // the target was never in doubt: it is the type the CALLER is in.
  const g = new Graph();
  const facts = [
    { kind: 'type', fqn: 'com.example.AExample.GeneratedCriteria', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'type', fqn: 'com.example.BExample.GeneratedCriteria', typeKind: 'class', package: 'com.example', annotations: [], implements: [] },
    { kind: 'call', from: 'com.example.AExample.GeneratedCriteria#andIdEqualTo', receiver: 'this', method: 'addCriterion', toTypeSimple: 'GeneratedCriteria', via: 'unqualified', file: 'AExample.java' },
  ];
  const stats = addJavaFacts(g, facts);
  assert.equal(stats.unresolvedCalls, 0, 'the enclosing type needs no name resolution');
  assert.deepEqual(
    g.edges.filter((e) => e.type === 'MAY_CALL').map((e) => [e.from, e.to]),
    [['symbol:com.example.AExample.GeneratedCriteria#andIdEqualTo', 'symbol:com.example.AExample.GeneratedCriteria#addCriterion']],
    'it must bind to the CALLER\'s own class, never to the other one',
  );
});

// ---------------------------------------------------------------------------
// Generated sources (RM11, SPEC §8.4). The engine never decides on its own that
// somebody's code is machine-written: the profile declares an ANNOTATION or a
// PATH, and both are evidence the worker already records.
// ---------------------------------------------------------------------------

function generatedFacts() {
  const type = (fqn, file, anns = []) => ({
    kind: 'type', fqn, typeKind: 'class', package: fqn.slice(0, fqn.lastIndexOf('.')),
    file, annotations: anns, implements: [],
  });
  const method = (fqn) => ({ kind: 'method', fqn, owner: fqn.slice(0, fqn.lastIndexOf('#')), name: fqn.slice(fqn.lastIndexOf('#') + 1), paramCount: 1, line: 1 });
  return [
    // hand-written
    type('com.demo.Svc', 'src/main/java/com/demo/Svc.java'),
    method('com.demo.Svc#run'),
    // machine-written by ANNOTATION (no telltale path)
    type('com.demo.ByAnn', 'src/main/java/com/demo/ByAnn.java', ['Generated']),
    method('com.demo.ByAnn#a'), method('com.demo.ByAnn#b'),
    // machine-written by PATH (no annotation at all — mall's generator leaves none)
    type('com.demo.gen.ByPath', 'mbg/src/main/java/com/demo/gen/ByPath.java'),
    method('com.demo.gen.ByPath#c'),
    // a real chain into the generated code, and the generated interior
    { kind: 'call', from: 'com.demo.Svc#run', receiver: 'g', method: 'a', toTypeSimple: 'ByAnn' },
    { kind: 'field', owner: 'com.demo.Svc', name: 'g', typeSimple: 'ByAnn', file: 'src/main/java/com/demo/Svc.java' },
    { kind: 'call', from: 'com.demo.ByAnn#a', receiver: 'this', method: 'b', toTypeSimple: 'ByAnn' },
    { kind: 'field', owner: 'com.demo.ByAnn', name: 'this', typeSimple: 'ByAnn', file: 'src/main/java/com/demo/ByAnn.java' },
  ];
}

test('addJavaFacts: a profile that declares NOTHING classifies nothing — silence is not a guess', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, generatedFacts());
  assert.equal(stats.generatedDeclared, false);
  assert.equal(stats.generatedTypes, 0);
  assert.equal(stats.generatedSymbols, 0);
  for (const n of g.nodes.values()) assert.equal(n.generated, undefined, `${n.id} was flagged with no declaration`);
});

test('addJavaFacts: generatedSources marks by ANNOTATION and by PATH, and says which found what', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, generatedFacts(), {
    generatedSources: { annotations: ['Generated'], pathGlobs: ['mbg/**'] },
  });
  assert.equal(stats.generatedDeclared, true);
  assert.equal(stats.generatedTypes, 2);
  assert.equal(stats.generatedTypesByAnnotation, 1);
  assert.equal(stats.generatedTypesByPath, 1);
  assert.equal(stats.generatedSymbols, 3, 'every member of a generated type is generated');
  assert.equal(g.nodes.get(nodeId('symbol', 'com.demo.ByAnn#a')).generated, true);
  assert.equal(g.nodes.get(nodeId('symbol', 'com.demo.gen.ByPath#c')).generated, true);
  // The hand-written service is untouched, and the flag is never written false.
  assert.equal(g.nodes.get(nodeId('symbol', 'com.demo.Svc#run')).generated, undefined);
});

test('addJavaFacts: the rule reads the OWNER, never a class NAME — a *Example outside the declared path is not generated', () => {
  const g = new Graph();
  const facts = [
    { kind: 'type', fqn: 'com.demo.PmsBrandExample', typeKind: 'class', package: 'com.demo', file: 'src/main/java/com/demo/PmsBrandExample.java', annotations: [], implements: [] },
    { kind: 'method', fqn: 'com.demo.PmsBrandExample#andIdEqualTo', owner: 'com.demo.PmsBrandExample', name: 'andIdEqualTo', paramCount: 1, line: 1 },
  ];
  const stats = addJavaFacts(g, facts, { generatedSources: { annotations: ['Generated'], pathGlobs: ['mbg/**'] } });
  assert.equal(stats.generatedTypes, 0, 'the name Example proves nothing — only the declaration does');
  assert.equal(g.nodes.get(nodeId('symbol', 'com.demo.PmsBrandExample#andIdEqualTo')).generated, undefined);
});

test('pathGlobMatcher: * stays inside a segment, ** crosses them, and nothing else is a wildcard', () => {
  const m = pathGlobMatcher(['mall-mbg/**', '**/model/generated/*.java', 'src/a+b/*.java']);
  assert.equal(m('mall-mbg/src/x/Y.java'), true);
  assert.equal(m('mall-admin/src/Y.java'), false);
  assert.equal(m('src/main/java/com/x/model/generated/A.java'), true);
  assert.equal(m('src/main/java/com/x/model/generated/deep/A.java'), false, '* must not cross a separator');
  assert.equal(m('src/a+b/A.java'), true, '+ is a literal, not a quantifier');
  assert.equal(m(null), false);
  assert.equal(pathGlobMatcher([])('anything'), false);
});

test('the generated walk rule: a real caller still reaches generated code; the interior below it is not walked', () => {
  const g = new Graph();
  addJavaFacts(g, generatedFacts(), { generatedSources: { annotations: ['Generated'], pathGlobs: ['mbg/**'] } });
  const w = chainWalk(g, { start: nodeId('symbol', 'com.demo.Svc#run'), direction: 'down', mode: 'conservative', maxDepth: 6 });
  const reached = w.services.map((r) => r.id).sort();
  assert.deepEqual(reached, ['com.demo.ByAnn#a'], 'the generated method a real caller reaches IS on the picture');
  assert.equal(w.cut.generated, 1, 'and the one interior step it did not take is counted, not hidden');
  // Turning the rule off walks the interior too — same graph, declared choice.
  const all = chainWalk(g, { start: nodeId('symbol', 'com.demo.Svc#run'), direction: 'down', mode: 'conservative', maxDepth: 6, walkGenerated: true });
  assert.deepEqual(all.services.map((r) => r.id).sort(), ['com.demo.ByAnn#a', 'com.demo.ByAnn#b']);
  assert.equal(all.cut.generated, 0);
});

// ---------------------------------------------------------------------------
// RM14 — what a mapping annotation MEANS, and the two calls the lane used to drop
// ---------------------------------------------------------------------------

test('classifyRouteHolder: the table is TOTAL — controller, client, contract, and the residue', () => {
  assert.equal(classifyRouteHolder({ typeKind: 'class', annotations: ['RestController'] }), 'handler');
  assert.equal(classifyRouteHolder({ typeKind: 'class', annotations: ['Controller'] }), 'handler');
  assert.equal(classifyRouteHolder({ typeKind: 'interface', annotations: ['FeignClient'], client: { kind: 'FeignClient' } }), 'client');
  // A @Controller that ALSO carries a client annotation is a client: the client
  // annotation is the specific claim, and Spring would not map its methods twice.
  assert.equal(classifyRouteHolder({ typeKind: 'class', annotations: ['Controller', 'HttpExchange'], client: { kind: 'HttpExchange' } }), 'client');
  assert.equal(classifyRouteHolder({ typeKind: 'interface', annotations: [] }), 'contract');
  assert.equal(classifyRouteHolder({ typeKind: 'class', abstract: true, annotations: [] }), 'contract');
  // An abstract class that IS annotated a controller keeps its routes.
  assert.equal(classifyRouteHolder({ typeKind: 'class', abstract: true, annotations: ['RestController'] }), 'handler');
  // The residue: a concrete class with a mapping and no controller annotation
  // (a meta-annotated controller this engine does not know) keeps its routes.
  assert.equal(classifyRouteHolder({ typeKind: 'class', annotations: ['MyApiController'] }), 'handler');
  assert.equal(classifyRouteHolder(undefined), 'handler');
});

test('a route contract: HANDLES goes to the implementer, and the grade says it was RESOLVED', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.OrderApi', typeKind: 'interface', package: 'com.x', annotations: [], implements: [], declaredMethods: ['list/1'], file: 'x/OrderApi.java' },
    { kind: 'type', fqn: 'com.x.OrderController', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: ['OrderApi'], declaredMethods: ['list/1'], file: 'x/OrderController.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.OrderApi#list', handlerType: 'com.x.OrderApi', line: 8, file: 'x/OrderApi.java' },
    { kind: 'method', fqn: 'com.x.OrderApi#list', owner: 'com.x.OrderApi', name: 'list', paramCount: 1, line: 8, file: 'x/OrderApi.java' },
  ]);
  const route = nodeId('endpoint', 'GET /order/list');
  const handles = g.outEdges(route).filter((e) => e.type === 'HANDLES');
  assert.equal(handles.length, 1, 'ONE handler — the controller, not the contract as well');
  assert.equal(handles[0].to, nodeId('symbol', 'com.x.OrderController#list'));
  assert.equal(handles[0].grade, 'SOUND_SET', 'matched by name+arity through `implements`, not defined');
  const ev = g.edgeAt(handles[0].idx).evidence;
  assert.equal(ev.rule, 'route-contract-impl');
  assert.equal(ev.contract, 'com.x.OrderApi#list');
  assert.equal(ev.match, 'name+arity');
  assert.equal(g.nodes.get(route).contractOnly, undefined);
  assert.deepEqual([stats.routeContracts, stats.contractOnlyRoutes], [1, 0]);
});

test('a route contract nobody implements HERE is emitted and SAYS SO', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.OrderApi', typeKind: 'interface', package: 'com.x', annotations: [], implements: [], declaredMethods: ['list/1'], file: 'x/OrderApi.java' },
    { kind: 'endpoint', httpMethod: 'GET', path: '/order/list', handler: 'com.x.OrderApi#list', handlerType: 'com.x.OrderApi', line: 8, file: 'x/OrderApi.java' },
    { kind: 'method', fqn: 'com.x.OrderApi#list', owner: 'com.x.OrderApi', name: 'list', paramCount: 1, line: 8, file: 'x/OrderApi.java' },
  ]);
  const route = nodeId('endpoint', 'GET /order/list');
  assert.equal(g.nodes.get(route).contractOnly, true);
  const handles = g.outEdges(route).filter((e) => e.type === 'HANDLES');
  assert.equal(handles[0].to, nodeId('symbol', 'com.x.OrderApi#list'));
  assert.equal(g.edgeAt(handles[0].idx).evidence.contractOnly, true);
  assert.deepEqual([stats.routeContracts, stats.contractOnlyRoutes], [1, 1]);
  // …and it is NOT outbound: nobody calls it over HTTP, it is declared here.
  assert.equal(g.nodes.get(route).outbound, undefined);
});

test('`super.m()` climbs the extends chain to the type that DECLARES m', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.Base', typeKind: 'class', package: 'com.x', annotations: [], implements: [], declaredMethods: ['exportXls/2'], file: 'x/Base.java' },
    // Middle declares NOTHING: a walk that stopped at the immediate superclass
    // would point at `Middle#exportXls`, a method that does not exist.
    { kind: 'type', fqn: 'com.x.Middle', typeKind: 'class', package: 'com.x', annotations: [], implements: [], extends: 'Base', declaredMethods: [], file: 'x/Middle.java' },
    { kind: 'type', fqn: 'com.x.Sub', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [], extends: 'Middle', declaredMethods: ['exportXls/2'], file: 'x/Sub.java' },
    { kind: 'call', from: 'com.x.Sub#exportXls', receiver: 'super', method: 'exportXls', toTypeSimple: 'Middle', via: 'super-method', file: 'x/Sub.java' },
  ]);
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, nodeId('symbol', 'com.x.Base#exportXls'));
  assert.equal(e.evidence.rule, 'super-enclosing');
  assert.equal(e.evidence.declaredBy, 'com.x.Base');
  assert.equal(e.evidence.hops, 1, 'one type was skipped on the way up');
  assert.equal(stats.callsByRule['super-enclosing'], 1);
});

test('`super.m()` into a superclass the lane never parsed is UNRESOLVED under its own rule', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.Sub', typeKind: 'class', package: 'com.x', annotations: [], implements: [], extends: 'HttpServlet', declaredMethods: ['doGet/2'], file: 'x/Sub.java' },
    { kind: 'call', from: 'com.x.Sub#doGet', receiver: 'super', method: 'doGet', toTypeSimple: 'HttpServlet', via: 'super-method', file: 'x/Sub.java' },
  ]);
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0);
  assert.equal(stats.unresolvedCallsByRule['super-enclosing'], 1);
  assert.equal(stats.unresolvedCalls, 1);
});

test('`this.m()` is the same call as the unqualified one — one rule, one target', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.C', typeKind: 'class', package: 'com.x', annotations: [], implements: [], declaredMethods: ['a/0', 'helper/1'], file: 'x/C.java' },
    { kind: 'call', from: 'com.x.C#a', receiver: 'this', method: 'helper', toTypeSimple: 'C', via: 'this-method', file: 'x/C.java' },
  ]);
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, nodeId('symbol', 'com.x.C#helper'));
  assert.equal(e.evidence.rule, 'unqualified-enclosing');
  assert.equal(stats.callsByRule['unqualified-enclosing'], 1);
});

// ---------------------------------------------------------------------------
// A RECEIVER TYPED BY A TYPE PARAMETER (RM37).
//
// One generic base, two subclasses, each binding `S` to its own service. The
// body is written once and runs twice, so the question "who does
// `service.list()` call?" has two answers — and each of them belongs to ONE of
// the two subclasses. Putting both on the base method is what let jeecg-boot's
// 29 export endpoints read as touching each other's tables.
//
// `svc` is spelled as the base's own field, which is what the worker records
// for `service.list(...)` inside the class that declares `service`.
// ---------------------------------------------------------------------------

/**
 * A generic base whose body calls through the type parameter, and one subclass
 * per binding. `overrides` names the subclasses that DECLARE the method (an
 * override calling `super.m()`), which is what jeecg's controllers do; the rest
 * inherit the body outright.
 */
function typeParamFacts(bindings, overrides = []) {
  const facts = [
    {
      kind: 'type', fqn: 'com.x.Base', typeKind: 'class', package: 'com.x',
      annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
      typeParams: ['T', 'S'], typeParamBounds: [null, 'ISvc'],
      declaredMethods: ['m/1'], declaredMethodLines: [40], file: 'x/Base.java',
    },
    { kind: 'field', owner: 'com.x.Base', name: 'svc', typeSimple: 'S', file: 'x/Base.java' },
    { kind: 'call', from: 'com.x.Base#m', receiver: 'svc', method: 'find', toTypeSimple: 'S', via: 'field', file: 'x/Base.java' },
  ];
  for (const [sub, svc] of bindings) {
    const declared = overrides.includes(sub);
    facts.push(
      {
        kind: 'type', fqn: `com.x.${svc}`, typeKind: 'interface', package: 'com.x',
        annotations: [], implements: [], implementsArgs: [],
        declaredMethods: ['find/1'], declaredMethodLines: [5], file: `x/${svc}.java`,
      },
      {
        kind: 'type', fqn: `com.x.${sub}`, typeKind: 'class', package: 'com.x',
        annotations: ['RestController'], implements: [], implementsArgs: [],
        extends: 'Base', extendsArgs: ['Row', svc], typeParams: [], typeParamBounds: [],
        declaredMethods: declared ? ['m/1'] : [], declaredMethodLines: declared ? [12] : [],
        file: `x/${sub}.java`,
      },
    );
    if (declared) {
      facts.push({ kind: 'call', from: `com.x.${sub}#m`, receiver: 'super', method: 'm', toTypeSimple: null, via: 'super-method', file: `x/${sub}.java` });
    }
  }
  return facts;
}

test('a call through a TYPE PARAMETER is resolved in each subclass, and neither reaches the other\'s service', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, typeParamFacts(
    [['A', 'ASvc'], ['B', 'BSvc']],
    ['A', 'B'],
  ));
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();

  // ONE bound edge each, on the subclass's own copy of the method.
  assert.deepEqual(out('com.x.A#m'), [nodeId('symbol', 'com.x.ASvc#find'), nodeId('symbol', 'com.x.Base#m')]);
  assert.deepEqual(out('com.x.B#m'), [nodeId('symbol', 'com.x.BSvc#find'), nodeId('symbol', 'com.x.Base#m')]);

  // …and the base keeps nothing: the union that used to sit here is the whole
  // defect, because every subclass's `super.m()` edge lands on this one symbol.
  assert.deepEqual(out('com.x.Base#m'), []);

  const ev = g.edges.find((e) => e.to === nodeId('symbol', 'com.x.ASvc#find')).evidence;
  assert.equal(ev.rule, 'type-param-binding');
  assert.equal(ev.receiver, 'S');
  assert.equal(ev.binding, 'ASvc');
  assert.equal(ev.boundThrough, 'com.x.A', 'the evidence names WHERE the binding was made');
  assert.equal(ev.inheritedFrom, 'com.x.Base#m', 'and whose body wrote the call site');
  assert.equal(g.edges.find((e) => e.to === nodeId('symbol', 'com.x.ASvc#find')).grade, 'SOUND_SET',
    'still a dispatch through a type parameter, bound to one owner and no more');
  assert.equal(stats.callsByRule['type-param-binding'], 2);
  assert.equal(stats.unresolvedCallsByRule['type-param-unbound'], 0);
});

test('a subclass that only INHERITS the generic body gets the same one bound edge, through its instantiated copy', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, typeParamFacts([['A', 'ASvc'], ['B', 'BSvc']]));
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.x.A#m'), [nodeId('symbol', 'com.x.ASvc#find')]);
  assert.deepEqual(out('com.x.B#m'), [nodeId('symbol', 'com.x.BSvc#find')]);
  assert.deepEqual(out('com.x.Base#m'), []);
  // The member is the one RM20 instantiates, so the node opens the ancestor's
  // code — the body that really runs — and the rule says so.
  const n = g.nodes.get(nodeId('symbol', 'com.x.A#m'));
  assert.equal(n.inherited, true);
  assert.equal(n.inheritedFrom, 'com.x.Base#m');
  assert.equal(n.file, 'x/Base.java');
  assert.equal(n.line, 40);
  assert.equal(g.edges.find((e) => e.to === nodeId('symbol', 'com.x.ASvc#find')).evidence.rule, 'inherited-member-call');
  assert.equal(stats.callsByRule['type-param-binding'], 0, 'the instantiated copy carries it, so it is not written twice');
  assert.equal(stats.unresolvedCallsByRule['type-param-unbound'], 0);
});

test('a subclass that binds the parameter to an INTERFACE still fans out to every implementor', () => {
  // The legitimate over-approximation, untouched: `A` binds `S` to one
  // interface, and two classes implement it, so the call really can run either.
  // Only the CROSS-SUBCLASS union was the defect.
  const g = new Graph();
  addJavaFacts(g, [
    ...typeParamFacts([['A', 'ASvc'], ['B', 'BSvc']], ['A', 'B']),
    { kind: 'type', fqn: 'com.x.ASvcOne', typeKind: 'class', package: 'com.x', annotations: [], implements: ['ASvc'], implementsArgs: [[]], declaredMethods: ['find/1'], declaredMethodLines: [7], file: 'x/ASvcOne.java' },
    { kind: 'type', fqn: 'com.x.ASvcTwo', typeKind: 'class', package: 'com.x', annotations: [], implements: ['ASvc'], implementsArgs: [[]], declaredMethods: ['find/1'], declaredMethodLines: [7], file: 'x/ASvcTwo.java' },
  ]);
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.x.ASvc#find'), [nodeId('symbol', 'com.x.ASvcOne#find'), nodeId('symbol', 'com.x.ASvcTwo#find')]);
  // …and B still reaches only its own, through a service nobody implements here.
  assert.deepEqual(out('com.x.B#m'), [nodeId('symbol', 'com.x.BSvc#find'), nodeId('symbol', 'com.x.Base#m')]);
});

test('an override that calls a DIFFERENT base method binds THAT body, not the one it shares a name with', () => {
  // jeecg-boot's `JeecgDemoController#exportXls` calls `super.exportXlsSheet(…)`.
  // The body that runs is the base's OTHER method, and only the call site says
  // so — a rule that went by the method's name would bind the wrong one.
  const g = new Graph();
  addJavaFacts(g, [
    ...typeParamFacts([['A', 'ASvc']], ['A']).map((r) => (
      r.kind === 'call' && r.from === 'com.x.A#m' ? { ...r, method: 'sheet' } : r)),
    { kind: 'call', from: 'com.x.Base#sheet', receiver: 'svc', method: 'count', toTypeSimple: 'S', via: 'field', file: 'x/Base.java' },
  ].map((r) => (r.kind === 'type' && r.fqn === 'com.x.Base'
    ? { ...r, declaredMethods: ['m/1', 'sheet/1'], declaredMethodLines: [40, 55] } : r)));
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.x.A#m'), [nodeId('symbol', 'com.x.ASvc#count'), nodeId('symbol', 'com.x.Base#sheet')],
    'the body that runs is `sheet`, so `count` is what this endpoint reaches');
  assert.deepEqual(out('com.x.Base#m'), []);
  assert.deepEqual(out('com.x.Base#sheet'), []);
});

test('an override that does NOT call super keeps the ancestor\'s call site out of its own body', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, typeParamFacts([['A', 'ASvc'], ['B', 'BSvc']], ['A', 'B'])
    // A declares `m` and never hands the work back.
    .filter((r) => !(r.kind === 'call' && r.from === 'com.x.A#m')));
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.x.A#m'), [], 'a body that replaces the ancestor\'s does not run it');
  assert.deepEqual(out('com.x.B#m'), [nodeId('symbol', 'com.x.BSvc#find'), nodeId('symbol', 'com.x.Base#m')]);
  assert.equal(stats.callsByRule['type-param-binding'], 1);
  assert.equal(stats.unresolvedCallsByRule['type-param-unbound'], 0, 'the binding resolved, it is the call site that is not there');
});

test('a CONSTRUCTOR body binds in each subclass: nobody inherits or overrides one', () => {
  // `<init>` is never in `declaredMethods`, so neither the "declares it" nor the
  // "only inherits it" branch describes it. Every subclass constructor runs the
  // base's, written or not, so the subclass's own is where that body belongs.
  const g = new Graph();
  addJavaFacts(g, [
    ...typeParamFacts([['A', 'ASvc'], ['B', 'BSvc']]),
    { kind: 'call', from: 'com.x.Base#<init>', receiver: 'svc', method: 'warmUp', toTypeSimple: 'S', via: 'field', file: 'x/Base.java' },
  ]);
  const out = (member) => g.outEdges(nodeId('symbol', member))
    .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.x.A#<init>'), [nodeId('symbol', 'com.x.ASvc#warmUp')]);
  assert.deepEqual(out('com.x.B#<init>'), [nodeId('symbol', 'com.x.BSvc#warmUp')]);
  assert.deepEqual(out('com.x.Base#<init>'), []);
});

test('a base method a subclass inherits THROUGH an intermediate binds through that intermediate', () => {
  // `Leaf extends Mid`, `Mid extends Base<Row, MidSvc>`: the binding is Mid's,
  // and Leaf runs the body, so the edge leaves Leaf and names Mid as where the
  // binding was spelled.
  const g = new Graph();
  addJavaFacts(g, [
    ...typeParamFacts([['Mid', 'MidSvc']]),
    { kind: 'type', fqn: 'com.x.Leaf', typeKind: 'class', package: 'com.x', annotations: ['RestController'], implements: [], implementsArgs: [], extends: 'Mid', extendsArgs: [], typeParams: [], typeParamBounds: [], declaredMethods: ['m/1'], declaredMethodLines: [11], file: 'x/Leaf.java' },
    { kind: 'call', from: 'com.x.Leaf#m', receiver: 'super', method: 'm', toTypeSimple: null, via: 'super-method', file: 'x/Leaf.java' },
  ]);
  const e = g.edges.find((x) => x.from === nodeId('symbol', 'com.x.Leaf#m') && x.to === nodeId('symbol', 'com.x.MidSvc#find'));
  assert.ok(e, 'Leaf#m --type-param-binding--> MidSvc#find is missing');
  assert.equal(e.evidence.boundThrough, 'com.x.Mid');
});

test('a type parameter NO subclass binds is unresolved under `type-param-unbound`, not under the field rule', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    { kind: 'type', fqn: 'com.x.BaseController', typeKind: 'class', package: 'com.x', annotations: [], implements: [], typeParams: ['S'], typeParamBounds: [null], declaredMethods: ['exportXls/1'], file: 'x/BaseController.java' },
    { kind: 'field', owner: 'com.x.BaseController', name: 'service', typeSimple: 'S', file: 'x/BaseController.java' },
    { kind: 'call', from: 'com.x.BaseController#exportXls', receiver: 'service', method: 'list', toTypeSimple: 'S', via: 'field', file: 'x/BaseController.java' },
  ]);
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0);
  assert.equal(stats.unresolvedCallsByRule['type-param-unbound'], 1);
  assert.equal(stats.unresolvedCallsByRule['field-receiver'], 0, 'the failure is named for what actually failed');
});

// ---------------------------------------------------------------------------
// A RECEIVER THAT IS A FIELD INHERITED FROM A SUPERCLASS (RM20 §1).
//
// The shape is a template, not a project: an abstract generic base holds the
// collaborator, and every subclass binds it to its own. The worker cannot see
// past the file it is parsing, so it emits the receiver NAME with no type
// (`via:'identifier'`) and this bridge — which holds every type record — walks
// the `extends` chain.
// ---------------------------------------------------------------------------

/** `class Base<E, M> { protected M mapper; }` + two subclasses binding M. */
function inheritedFieldFacts() {
  return [
    {
      kind: 'type', fqn: 'com.example.Base', typeKind: 'class', package: 'com.example',
      abstract: true, annotations: [], implements: [], implementsArgs: [],
      extends: null, extendsArgs: [], typeParams: ['E', 'M'], typeParamBounds: [null, null],
      declaredMethods: ['insert/1'], file: 'com/example/Base.java',
    },
    { kind: 'field', owner: 'com.example.Base', name: 'mapper', typeSimple: 'M', file: 'com/example/Base.java' },
    {
      kind: 'type', fqn: 'com.example.AaaDaoImpl', typeKind: 'class', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [],
      extends: 'Base', extendsArgs: ['Aaa', 'AaaMapper'], typeParams: [], typeParamBounds: [],
      declaredMethods: ['findAaa/1'], file: 'com/example/AaaDaoImpl.java',
    },
    {
      kind: 'type', fqn: 'com.example.BbbDaoImpl', typeKind: 'class', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [],
      extends: 'Base', extendsArgs: ['Bbb', 'BbbMapper'], typeParams: [], typeParamBounds: [],
      declaredMethods: ['findBbb/1'], file: 'com/example/BbbDaoImpl.java',
    },
    { kind: 'type', fqn: 'com.example.AaaMapper', typeKind: 'interface', package: 'com.example', annotations: ['Mapper'], implements: [], implementsArgs: [], declaredMethods: ['findAaa/1'], file: 'com/example/AaaMapper.java' },
    { kind: 'type', fqn: 'com.example.BbbMapper', typeKind: 'interface', package: 'com.example', annotations: ['Mapper'], implements: [], implementsArgs: [], declaredMethods: ['findBbb/1'], file: 'com/example/BbbMapper.java' },
    { kind: 'call', from: 'com.example.AaaDaoImpl#findAaa', receiver: 'mapper', method: 'findAaa', toTypeSimple: null, via: 'identifier', file: 'com/example/AaaDaoImpl.java' },
    { kind: 'call', from: 'com.example.BbbDaoImpl#findBbb', receiver: 'mapper', method: 'findBbb', toTypeSimple: null, via: 'identifier', file: 'com/example/BbbDaoImpl.java' },
  ];
}

test('a receiver inherited from a generic superclass is bound IN THE SUBCLASS — each reaches only its own', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, inheritedFieldFacts());
  const edges = g.edges
    .filter((e) => e.evidence?.rule === 'inherited-field')
    .map((e) => [e.from, e.to])
    .sort();
  assert.deepEqual(edges, [
    ['symbol:com.example.AaaDaoImpl#findAaa', 'symbol:com.example.AaaMapper#findAaa'],
    ['symbol:com.example.BbbDaoImpl#findBbb', 'symbol:com.example.BbbMapper#findBbb'],
  ], 'the base is shared but each subclass binds M to one mapper — never to both');
  assert.equal(stats.callsByRule['inherited-field'], 2);
  assert.equal(stats.identifierReceivers.inheritedField, 2);
  assert.equal(stats.unresolvedCallsByRule['inherited-field'], 0);
  const ev = g.edges.find((e) => e.evidence?.rule === 'inherited-field').evidence;
  assert.equal(ev.declaredBy, 'com.example.Base');
  assert.equal(ev.boundThrough, 'com.example.AaaDaoImpl');
  assert.equal(ev.hops, 1);
  assert.ok(ev.basis.length > 20);
});

test('two levels of inheritance: the binding is carried through the middle class', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    {
      kind: 'type', fqn: 'com.example.Top', typeKind: 'class', package: 'com.example', abstract: true,
      annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
      typeParams: ['M'], typeParamBounds: [null], declaredMethods: [], file: 'com/example/Top.java',
    },
    { kind: 'field', owner: 'com.example.Top', name: 'mapper', typeSimple: 'M', file: 'com/example/Top.java' },
    {
      kind: 'type', fqn: 'com.example.Mid', typeKind: 'class', package: 'com.example', abstract: true,
      annotations: [], implements: [], implementsArgs: [], extends: 'Top', extendsArgs: ['X'],
      typeParams: ['X'], typeParamBounds: [null], declaredMethods: [], file: 'com/example/Mid.java',
    },
    {
      kind: 'type', fqn: 'com.example.Leaf', typeKind: 'class', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [], extends: 'Mid', extendsArgs: ['LeafMapper'],
      typeParams: [], typeParamBounds: [], declaredMethods: ['run/0'], file: 'com/example/Leaf.java',
    },
    { kind: 'type', fqn: 'com.example.LeafMapper', typeKind: 'interface', package: 'com.example', annotations: ['Mapper'], implements: [], implementsArgs: [], declaredMethods: ['pick/0'], file: 'com/example/LeafMapper.java' },
    { kind: 'call', from: 'com.example.Leaf#run', receiver: 'mapper', method: 'pick', toTypeSimple: null, via: 'identifier', file: 'com/example/Leaf.java' },
  ]);
  const e = g.edges.find((x) => x.evidence?.rule === 'inherited-field');
  assert.equal(e.to, 'symbol:com.example.LeafMapper#pick');
  assert.equal(e.evidence.declaredBy, 'com.example.Top');
  assert.equal(e.evidence.hops, 2, 'the field is two hops up, and the type argument came down two hops');
  assert.equal(stats.callsByRule['inherited-field'], 1);
});

test('a subclass that SHADOWS an inherited field keeps its own — the worker never emits an identifier for it', () => {
  // The rule cannot mis-fire on a shadowing declaration because the worker only
  // emits `via:'identifier'` for a name the FILE never declares. The bridge's
  // half of the promise: a call the worker DID type resolves through that type,
  // and no inherited-field edge is created for it.
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...inheritedFieldFacts().filter((r) => r.kind !== 'call'),
    { kind: 'type', fqn: 'com.example.CccMapper', typeKind: 'interface', package: 'com.example', annotations: ['Mapper'], implements: [], implementsArgs: [], declaredMethods: ['findAaa/1'], file: 'com/example/CccDaoImpl.java' },
    { kind: 'field', owner: 'com.example.AaaDaoImpl', name: 'mapper', typeSimple: 'CccMapper', file: 'com/example/AaaDaoImpl.java' },
    { kind: 'call', from: 'com.example.AaaDaoImpl#findAaa', receiver: 'mapper', method: 'findAaa', toTypeSimple: 'CccMapper', via: 'field', file: 'com/example/AaaDaoImpl.java' },
  ]);
  assert.deepEqual(
    g.edges.filter((e) => e.type === 'MAY_CALL').map((e) => [e.evidence.rule, e.to]),
    [['field-receiver', 'symbol:com.example.CccMapper#findAaa']],
  );
  assert.equal(stats.callsByRule['inherited-field'], 0);
});

test('an identifier that is neither a field nor a type is UNRESOLVED under `inherited-field`, with the chain searched', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...inheritedFieldFacts().filter((r) => r.kind !== 'call'),
    // `tracer` is what a code generator adds after this worker has parsed the
    // file. NOT spelled `log`: RM35 knows Lombok's `log`, and a receiver this
    // test wants left unexplained must not be one the engine can explain.
    { kind: 'call', from: 'com.example.AaaDaoImpl#findAaa', receiver: 'tracer', method: 'info', toTypeSimple: null, via: 'identifier', file: 'com/example/AaaDaoImpl.java' },
  ]);
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0);
  assert.equal(stats.unresolvedCallsByRule['inherited-field'], 1);
  assert.equal(stats.identifierReceivers.unresolved, 1);
  assert.equal(stats.identifierReceivers.staticReceiver, 0);
  // RM35: nothing in the file's imports explains the name, so the reason is
  // `unknown` — the honest answer, and not one of the three a reader can act on.
  assert.equal(stats.unresolvedCallsByReason.unknown, 1);
  assert.deepEqual(stats.unresolvedIdentifiers, [{
    from: 'com.example.AaaDaoImpl#findAaa', receiver: 'tracer', method: 'info', reason: 'unknown',
    chain: ['com.example.AaaDaoImpl', 'com.example.Base'],
  }]);
});

test('an identifier that names a TYPE is a static call — counted apart, never as a failed field lookup', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...inheritedFieldFacts().filter((r) => r.kind !== 'call'),
    { kind: 'import', owner: 'com.example.AaaDaoImpl', simple: 'StringUtils', fqn: 'org.apache.commons.lang3.StringUtils', file: 'com/example/AaaDaoImpl.java' },
    { kind: 'call', from: 'com.example.AaaDaoImpl#findAaa', receiver: 'StringUtils', method: 'isEmpty', toTypeSimple: null, via: 'identifier', file: 'com/example/AaaDaoImpl.java' },
  ]);
  assert.equal(stats.identifierReceivers.staticReceiver, 1);
  assert.equal(stats.identifierReceivers.unresolved, 0);
  assert.equal(stats.unresolvedCallsByRule['inherited-field'], 0);
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0, 'this round does not follow static calls');
});

test('an inherited field is looked for NEAREST ancestor first — the closer declaration wins', () => {
  const g = new Graph();
  addJavaFacts(g, [
    {
      kind: 'type', fqn: 'com.example.Far', typeKind: 'class', package: 'com.example', abstract: true,
      annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
      typeParams: [], typeParamBounds: [], declaredMethods: [], file: 'com/example/Far.java',
    },
    { kind: 'field', owner: 'com.example.Far', name: 'store', typeSimple: 'FarStore', file: 'com/example/Far.java' },
    {
      kind: 'type', fqn: 'com.example.Near', typeKind: 'class', package: 'com.example', abstract: true,
      annotations: [], implements: [], implementsArgs: [], extends: 'Far', extendsArgs: [],
      typeParams: [], typeParamBounds: [], declaredMethods: [], file: 'com/example/Near.java',
    },
    { kind: 'field', owner: 'com.example.Near', name: 'store', typeSimple: 'NearStore', file: 'com/example/Near.java' },
    {
      kind: 'type', fqn: 'com.example.Leaf', typeKind: 'class', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [], extends: 'Near', extendsArgs: [],
      typeParams: [], typeParamBounds: [], declaredMethods: ['run/0'], file: 'com/example/Leaf.java',
    },
    { kind: 'type', fqn: 'com.example.FarStore', typeKind: 'class', package: 'com.example', annotations: [], implements: [], implementsArgs: [], declaredMethods: ['put/1'], file: 'com/example/FarStore.java' },
    { kind: 'type', fqn: 'com.example.NearStore', typeKind: 'class', package: 'com.example', annotations: [], implements: [], implementsArgs: [], declaredMethods: ['put/1'], file: 'com/example/NearStore.java' },
    { kind: 'call', from: 'com.example.Leaf#run', receiver: 'store', method: 'put', toTypeSimple: null, via: 'identifier', file: 'com/example/Leaf.java' },
  ]);
  const e = g.edges.find((x) => x.evidence?.rule === 'inherited-field');
  assert.equal(e.to, 'symbol:com.example.NearStore#put');
  assert.equal(e.evidence.declaredBy, 'com.example.Near');
});

// ---------------------------------------------------------------------------
// DISPATCH TO A METHOD THE IMPLEMENTOR INHERITS AND DOES NOT OVERRIDE (RM20 §2)
//
// `IDao<E>` declares the CRUD; `Base<E,M> implements IDao<E>` writes it once;
// `XDaoImpl extends Base<X, XMapper> implements XDao` declares NOTHING. Dispatch
// used to land on an empty symbol and the chain stopped there.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} names  the concrete DAOs to build, one per binding
 */
function inheritedDispatchFacts(names = ['Aaa', 'Bbb']) {
  const facts = [
    // the root interface: the contract every DAO answers
    {
      kind: 'type', fqn: 'com.example.IDao', typeKind: 'interface', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
      typeParams: ['E'], typeParamBounds: [null],
      declaredMethods: ['deleteById/1', 'insertBatch/1', 'insert/1'],
      declaredMethodLines: [11, 12, 13], file: 'com/example/IDao.java',
    },
    { kind: 'method', fqn: 'com.example.IDao#deleteById', owner: 'com.example.IDao', name: 'deleteById', paramCount: 1, line: 11, file: 'com/example/IDao.java' },
    { kind: 'method', fqn: 'com.example.IDao#insertBatch', owner: 'com.example.IDao', name: 'insertBatch', paramCount: 1, line: 12, file: 'com/example/IDao.java' },
    { kind: 'method', fqn: 'com.example.IDao#insert', owner: 'com.example.IDao', name: 'insert', paramCount: 1, line: 13, file: 'com/example/IDao.java' },
    // the generic base: it declares the members, and holds the collaborator
    {
      kind: 'type', fqn: 'com.example.Base', typeKind: 'class', package: 'com.example', abstract: true,
      annotations: [], implements: ['IDao'], implementsArgs: [['E']], extends: null, extendsArgs: [],
      typeParams: ['E', 'M'], typeParamBounds: [null, null],
      declaredMethods: ['deleteById/1', 'insertBatch/1', 'insert/1'],
      declaredMethodLines: [40, 50, 60], file: 'com/example/Base.java',
    },
    { kind: 'field', owner: 'com.example.Base', name: 'mapper', typeSimple: 'M', file: 'com/example/Base.java' },
    { kind: 'call', from: 'com.example.Base#deleteById', receiver: 'mapper', method: 'deleteById', toTypeSimple: 'M', via: 'field', file: 'com/example/Base.java' },
    { kind: 'call', from: 'com.example.Base#insert', receiver: 'mapper', method: 'insert', toTypeSimple: 'M', via: 'field', file: 'com/example/Base.java' },
    // `insertBatch` calls `insert(model)` unqualified: at run time that is the
    // CONCRETE object's `insert`, not the base's.
    { kind: 'call', from: 'com.example.Base#insertBatch', receiver: 'this', method: 'insert', toTypeSimple: 'Base', via: 'unqualified', file: 'com/example/Base.java' },
    // the caller: a service holding the per-entity interface
    {
      kind: 'type', fqn: 'com.example.Svc', typeKind: 'class', package: 'com.example',
      annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
      typeParams: [], typeParamBounds: [], declaredMethods: ['drop/1'],
      declaredMethodLines: [9], file: 'com/example/Svc.java',
    },
  ];
  for (const n of names) {
    facts.push(
      {
        kind: 'type', fqn: `com.example.${n}Dao`, typeKind: 'interface', package: 'com.example',
        annotations: [], implements: ['IDao'], implementsArgs: [[n]], extends: null, extendsArgs: [],
        typeParams: [], typeParamBounds: [], declaredMethods: [], declaredMethodLines: [],
        file: `com/example/${n}Dao.java`,
      },
      {
        kind: 'type', fqn: `com.example.${n}DaoImpl`, typeKind: 'class', package: 'com.example',
        annotations: [], implements: [`${n}Dao`], implementsArgs: [[]],
        extends: 'Base', extendsArgs: [n, `${n}Mapper`],
        typeParams: [], typeParamBounds: [], declaredMethods: [], declaredMethodLines: [],
        file: `com/example/${n}DaoImpl.java`,
      },
      {
        kind: 'type', fqn: `com.example.${n}Mapper`, typeKind: 'interface', package: 'com.example',
        annotations: ['Mapper'], implements: [], implementsArgs: [],
        declaredMethods: ['deleteById/1', 'insert/1'], declaredMethodLines: [5, 6],
        file: `com/example/${n}Mapper.java`,
      },
      { kind: 'field', owner: 'com.example.Svc', name: `${n.toLowerCase()}Dao`, typeSimple: `${n}Dao`, file: 'com/example/Svc.java' },
      { kind: 'call', from: `com.example.Svc#drop${n}`, receiver: `${n.toLowerCase()}Dao`, method: 'deleteById', toTypeSimple: `${n}Dao`, via: 'field', file: 'com/example/Svc.java' },
    );
  }
  return facts;
}

test('dispatch reaches a method the implementor only INHERITS, and each subclass reaches only its own mapper', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, inheritedDispatchFacts());

  // THE FAN-OUT CHECK. One `AaaDao#deleteById` must reach exactly one mapper.
  const out = (member) => g.outEdges(symbolId(member)).filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(out('com.example.AaaDao#deleteById'), ['symbol:com.example.AaaDaoImpl#deleteById']);
  assert.deepEqual(out('com.example.AaaDaoImpl#deleteById'), ['symbol:com.example.AaaMapper#deleteById']);
  assert.deepEqual(out('com.example.BbbDaoImpl#deleteById'), ['symbol:com.example.BbbMapper#deleteById']);

  // The dispatch edge says the implementor inherits it, and from where.
  const disp = g.edges.find((e) => e.from === symbolId('com.example.AaaDao#deleteById'));
  assert.equal(disp.evidence.rule, 'interface-dispatch-inherited');
  assert.equal(disp.evidence.inheritedFrom, 'com.example.Base#deleteById');
  assert.equal(disp.evidence.hops, 1);

  // The synthesized node carries the ANCESTOR's file and line: a reader who
  // opens `AaaDaoImpl#deleteById` must land on the code that runs.
  const n = g.nodes.get(symbolId('com.example.AaaDaoImpl#deleteById'));
  assert.equal(n.inherited, true);
  assert.equal(n.inheritedFrom, 'com.example.Base#deleteById');
  assert.equal(n.file, 'com/example/Base.java');
  assert.equal(n.line, 40);

  // TWO members per concrete class, not one (RM37). `deleteById` is the one
  // dispatch asked for; `insert` is instantiated because the base's body calls
  // the mapper THROUGH the type parameter, and since RM37 that call is resolved
  // in each subclass rather than pooled on the base. `insertBatch` is not among
  // them: its only call is unqualified, which needs no binding to resolve.
  assert.equal(stats.inheritedMembers.synthesized, 4, 'deleteById and insert, for each of the two classes');
  assert.equal(stats.callsByRule['interface-dispatch-inherited'], 2);
  assert.equal(stats.callsByRule['inherited-member-call'], 4);
  assert.equal(stats.callsByRule['type-param-binding'], 0, 'no subclass DECLARES either one, so every copy carries it');
  // …and `Base` itself carries neither, which is the whole point: both mappers
  // used to hang off the one shared body.
  assert.deepEqual(out('com.example.Base#deleteById'), []);
  assert.deepEqual(out('com.example.Base#insert'), []);
});

test('an OVERRIDE in the subclass wins over the ancestor — nothing is synthesized for it', () => {
  const g = new Graph();
  const facts = inheritedDispatchFacts(['Aaa']).map((r) => (
    r.kind === 'type' && r.fqn === 'com.example.AaaDaoImpl'
      ? { ...r, declaredMethods: ['deleteById/1'], declaredMethodLines: [77] }
      : r));
  facts.push({ kind: 'call', from: 'com.example.AaaDaoImpl#deleteById', receiver: 'mapper', method: 'wipe', toTypeSimple: null, via: 'identifier', file: 'com/example/AaaDaoImpl.java' });
  const stats = addJavaFacts(g, facts);
  const disp = g.edges.find((e) => e.from === symbolId('com.example.AaaDao#deleteById'));
  assert.equal(disp.evidence.rule, 'interface-dispatch', 'the class declares it: the plain rule, not the inherited one');
  // NOTHING is synthesized for `deleteById` — the class wrote its own. The one
  // member that is synthesized is `insert`, which the class does NOT declare and
  // whose base body calls the mapper through the type parameter (RM37).
  assert.equal(stats.inheritedMembers.synthesized, 1);
  const n = g.nodes.get(symbolId('com.example.AaaDaoImpl#deleteById'));
  assert.equal(n.inherited, undefined, 'a declared method is not an inherited one');
  assert.equal(g.nodes.get(symbolId('com.example.AaaDaoImpl#insert')).inherited, true);
  // …and its own body still resolves: the override calls its own mapper.
  assert.deepEqual(
    g.outEdges(symbolId('com.example.AaaDaoImpl#deleteById')).map((e) => e.to),
    ['symbol:com.example.AaaMapper#wipe'],
  );
});

test('an unqualified call inside an inherited body stays in the CONCRETE class, and chains on', () => {
  const g = new Graph();
  const facts = inheritedDispatchFacts(['Aaa']);
  facts.push({ kind: 'call', from: 'com.example.Svc#addAll', receiver: 'aaaDao', method: 'insertBatch', toTypeSimple: 'AaaDao', via: 'field', file: 'com/example/Svc.java' });
  addJavaFacts(g, facts);
  const step = (member) => g.outEdges(symbolId(member)).filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort();
  assert.deepEqual(step('com.example.AaaDao#insertBatch'), ['symbol:com.example.AaaDaoImpl#insertBatch']);
  // `insertBatch` calls `insert(model)`: the CONCRETE class's insert…
  assert.deepEqual(step('com.example.AaaDaoImpl#insertBatch'), ['symbol:com.example.AaaDaoImpl#insert']);
  // …which the class also only inherits, and which reaches its own mapper.
  assert.deepEqual(step('com.example.AaaDaoImpl#insert'), ['symbol:com.example.AaaMapper#insert']);
  assert.equal(g.nodes.get(symbolId('com.example.AaaDaoImpl#insert')).inherited, true);
});

test('an unqualified call in a SUBCLASS to a method only the base declares is instantiated too', () => {
  const g = new Graph();
  const facts = inheritedDispatchFacts(['Aaa']).filter((r) => !(r.kind === 'call' && r.from.startsWith('com.example.Svc')));
  // `XDaoImpl` writes `insert(entity)` in a method of its own.
  facts.push(
    { kind: 'type', fqn: 'com.example.AaaDaoImpl2', typeKind: 'class', package: 'com.example', annotations: [], implements: [], implementsArgs: [], extends: 'Base', extendsArgs: ['Aaa', 'AaaMapper'], typeParams: [], typeParamBounds: [], declaredMethods: ['save/1'], declaredMethodLines: [30], file: 'com/example/AaaDaoImpl2.java' },
    { kind: 'call', from: 'com.example.AaaDaoImpl2#save', receiver: 'this', method: 'insert', toTypeSimple: 'AaaDaoImpl2', via: 'unqualified', file: 'com/example/AaaDaoImpl2.java' },
  );
  const stats = addJavaFacts(g, facts);
  assert.deepEqual(
    g.outEdges(symbolId('com.example.AaaDaoImpl2#insert')).map((e) => e.to),
    ['symbol:com.example.AaaMapper#insert'],
  );
  assert.ok(stats.inheritedMembers.synthesized >= 1);
});

test('a DIAMOND — a default method on a second interface — is reported, not guessed', () => {
  // The class inherits `deleteById` from its `extends` chain AND from an
  // interface default method. Java resolves that by rule; this lane only ever
  // sees `implements`/`extends` names, so it takes the CLASS chain (which Java
  // does too) and SAYS the other candidate exists rather than silently picking.
  const g = new Graph();
  const facts = inheritedDispatchFacts(['Aaa']);
  facts.push({
    kind: 'type', fqn: 'com.example.Soft', typeKind: 'interface', package: 'com.example',
    annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
    typeParams: [], typeParamBounds: [], declaredMethods: ['deleteById/1'], declaredMethodLines: [8],
    file: 'com/example/Soft.java',
  });
  const withSoft = facts.map((r) => (
    r.kind === 'type' && r.fqn === 'com.example.AaaDaoImpl'
      ? { ...r, implements: ['AaaDao', 'Soft'], implementsArgs: [[], []] }
      : r));
  // …and somebody really calls it through the second interface, so both routes
  // into the class exist and neither is invented.
  withSoft.push(
    { kind: 'field', owner: 'com.example.Svc', name: 'soft', typeSimple: 'Soft', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc#wipe', receiver: 'soft', method: 'deleteById', toTypeSimple: 'Soft', via: 'field', file: 'com/example/Svc.java' },
  );
  const stats = addJavaFacts(g, withSoft);
  const n = g.nodes.get(symbolId('com.example.AaaDaoImpl#deleteById'));
  // Java's own rule: a method inherited from a CLASS always beats an interface
  // default. So this is the language's answer, not a preference invented here —
  // and the node says which body it took.
  assert.equal(n.inheritedFrom, 'com.example.Base#deleteById');

  // BOTH interfaces dispatch into that one node, each edge naming the interface
  // it came from. The second candidate is therefore visible to a reader instead
  // of being merged away or silently dropped.
  const into = g.edges
    .filter((e) => e.to === symbolId('com.example.AaaDaoImpl#deleteById') && e.type === 'MAY_CALL')
    .map((e) => [e.evidence.iface, e.evidence.rule, e.evidence.inheritedFrom])
    .sort();
  assert.deepEqual(into, [
    ['com.example.AaaDao', 'interface-dispatch-inherited', 'com.example.Base#deleteById'],
    ['com.example.Soft', 'interface-dispatch-inherited', 'com.example.Base#deleteById'],
  ]);
  // `deleteById` is instantiated ONCE for this class even though two interfaces
  // reach it — one body, one copy. (`insert` is the second: the base calls the
  // mapper through the type parameter there, so RM37 instantiates it too.)
  assert.equal(stats.inheritedMembers.synthesized, 2);
  assert.deepEqual(
    g.outEdges(symbolId('com.example.AaaDaoImpl#deleteById'))
      .filter((e) => e.type === 'MAY_CALL').map((e) => e.to).sort(),
    ['symbol:com.example.AaaMapper#deleteById'],
    'the copy still reaches this class\'s own mapper and no other',
  );
});

// ---------------------------------------------------------------------------
// RM35 — a call that LEAVES the project is external, not unresolved
//
// Five things a parse-only lane used to report as a failure and is not: a
// nested class reading its file's imports, `java.lang`, the field Lombok
// writes, an on-demand import of the JDK, and a `super.m()` into a base class
// the imports name and the tree does not hold. Each is one synthetic fact set,
// because the point is the RULE, not the fixture.
// ---------------------------------------------------------------------------

/** One top-level type in `com.example`, with whatever extra records a test needs. */
function typeRec(fqn, extra = {}) {
  return {
    kind: 'type', fqn, typeKind: 'class', package: 'com.example', abstract: false,
    annotations: [], implements: [], implementsArgs: [], extends: null, extendsArgs: [],
    typeParams: [], typeParamBounds: [], declaredMethods: [], declaredMethodLines: [],
    file: 'com/example/Outer.java', ...extra,
  };
}

test('RM35 A: a NESTED type resolves through its top-level type\'s imports', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Outer'),
    // The nested class: dotted fqn, the OUTER's package. That is all the worker
    // records, and it is enough to rebuild the scope chain.
    typeRec('com.example.Outer.Criteria'),
    // The import belongs to the FILE, so the worker keys it by the top-level type.
    { kind: 'import', owner: 'com.example.Outer', simple: 'List', fqn: 'java.util.List', file: 'com/example/Outer.java' },
    { kind: 'field', owner: 'com.example.Outer.Criteria', name: 'criteria', typeSimple: 'List', file: 'com/example/Outer.java' },
    { kind: 'call', from: 'com.example.Outer.Criteria#add', receiver: 'criteria', method: 'add', toTypeSimple: 'List', via: 'field', file: 'com/example/Outer.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(stats.unresolvedCalls, 0, 'the enclosing file imported it');
  assert.equal(stats.externalCalls, 1, 'java.util is outside com.example, so the call leaves the project');
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, symbolId('java.util.List#add'));
  assert.equal(g.nodes.get(e.to).external, true);
});

test('RM35 A: a nested SIBLING wins over anything the imports or the package offer', () => {
  const g = new Graph();
  addJavaFacts(g, [
    typeRec('com.example.Outer'),
    typeRec('com.example.Outer.Criteria'),
    // A nested enum AND an unrelated top-level type share the simple name.
    typeRec('com.example.Outer.Column', { typeKind: 'enum', declaredMethods: ['values/0'] }),
    typeRec('com.example.Column', { file: 'com/example/Column.java', declaredMethods: ['values/0'] }),
    { kind: 'field', owner: 'com.example.Outer.Criteria', name: 'col', typeSimple: 'Column', file: 'com/example/Outer.java' },
    { kind: 'call', from: 'com.example.Outer.Criteria#f', receiver: 'col', method: 'values', toTypeSimple: 'Column', via: 'field', file: 'com/example/Outer.java' },
  ], { packagePrefixes: ['com.example'] });
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, symbolId('com.example.Outer.Column#values'),
    'Java resolves a member type before it looks at the package');
});

test('RM35 B: `java.lang` is imported by every file whether it says so or not', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Svc', { file: 'com/example/Svc.java' }),
    { kind: 'field', owner: 'com.example.Svc', name: 'code', typeSimple: 'Integer', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'code', method: 'intValue', toTypeSimple: 'Integer', via: 'field', file: 'com/example/Svc.java' },
    // …and the static spelling, which the worker records as an `identifier`
    // receiver because nothing in the file declares the name.
    { kind: 'call', from: 'com.example.Svc#g', receiver: 'System', method: 'currentTimeMillis', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(stats.unresolvedCalls, 0);
  assert.equal(g.edges.find((x) => x.type === 'MAY_CALL').to, symbolId('java.lang.Integer#intValue'));
  assert.equal(stats.identifierReceivers.staticReceiver, 1,
    '`System.currentTimeMillis()` is a static call on a type, resolved and not followed');
});

test('RM35 B: the java.lang list is exported and holds the names every project uses', () => {
  for (const name of ['String', 'System', 'Integer', 'Thread', 'Math', 'Object', 'Long', 'Boolean', 'Class']) {
    assert.ok(JAVA_LANG_TYPES.includes(name), `${name} must be in JAVA_LANG_TYPES`);
  }
  assert.ok(Object.isFrozen(JAVA_LANG_TYPES));
  assert.equal(new Set(JAVA_LANG_TYPES).size, JAVA_LANG_TYPES.length, 'no name twice');
  // It is a LIST and not a prefix test: a name that is not in it stays unplaced
  // rather than being invented into java.lang.
  assert.equal(JAVA_LANG_TYPES.includes('RedisUtil'), false);
});

test('RM35 B: an IMPORT still beats java.lang — the language\'s order, not ours', () => {
  const g = new Graph();
  addJavaFacts(g, [
    typeRec('com.example.Svc', { file: 'com/example/Svc.java' }),
    { kind: 'import', owner: 'com.example.Svc', simple: 'Process', fqn: 'com.other.Process', file: 'com/example/Svc.java' },
    { kind: 'field', owner: 'com.example.Svc', name: 'p', typeSimple: 'Process', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'p', method: 'destroy', toTypeSimple: 'Process', via: 'field', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(g.edges.find((x) => x.type === 'MAY_CALL').to, symbolId('com.other.Process#destroy'));
});

test('RM35 C: a @Slf4j class has a `log` field the source never declares', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Svc', { annotations: ['Slf4j'], file: 'com/example/Svc.java' }),
    // A nested class reads the outer class's `private static log`.
    typeRec('com.example.Svc.Inner', { file: 'com/example/Svc.java' }),
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'log', method: 'info', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc.Inner#g', receiver: 'log', method: 'error', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(stats.unresolvedCalls, 0);
  assert.equal(stats.identifierReceivers.generatedField, 2);
  assert.equal(stats.callsByRule['generated-field'], 2);
  const edges = g.edges.filter((e) => e.type === 'MAY_CALL').map((e) => [e.to, e.evidence.rule, e.evidence.annotation]).sort();
  assert.deepEqual(edges, [
    [symbolId('org.slf4j.Logger#error'), 'generated-field', 'Slf4j'],
    [symbolId('org.slf4j.Logger#info'), 'generated-field', 'Slf4j'],
  ]);
  assert.equal(g.nodes.get(symbolId('org.slf4j.Logger#info')).external, true);
  assert.ok(g.edges.find((e) => e.type === 'MAY_CALL').evidence.basis.includes('Lombok'));
});

test('RM35 C: every Lombok logging annotation names the logger it generates', () => {
  for (const [annotation, logger] of Object.entries(LOMBOK_LOGGERS)) {
    const g = new Graph();
    addJavaFacts(g, [
      typeRec('com.example.Svc', { annotations: [annotation], file: 'com/example/Svc.java' }),
      { kind: 'call', from: 'com.example.Svc#f', receiver: 'log', method: 'info', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
    ], { packagePrefixes: ['com.example'] });
    assert.equal(g.edges.find((e) => e.type === 'MAY_CALL').to, symbolId(`${logger}#info`), annotation);
  }
  // @CustomLog's logger type is declared in lombok.config, which is not source
  // this lane reads: the edge says so instead of passing a guess off as a
  // reading.
  const g = new Graph();
  addJavaFacts(g, [
    typeRec('com.example.Svc', { annotations: ['CustomLog'], file: 'com/example/Svc.java' }),
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'log', method: 'info', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(g.edges.find((e) => e.type === 'MAY_CALL').evidence.loggerTypeDeclaredOutsideSource, true);
});

test('RM35 C: a class that declares its OWN log field keeps it', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Svc', { annotations: ['Slf4j'], file: 'com/example/Svc.java' }),
    typeRec('com.example.MyLogger', { file: 'com/example/MyLogger.java' }),
    { kind: 'field', owner: 'com.example.Svc', name: 'log', typeSimple: 'MyLogger', file: 'com/example/Svc.java' },
    // The worker resolves a field the file DECLARES itself, so this arrives as
    // `field`, not `identifier` — and the generated field must not shadow it.
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'log', method: 'info', toTypeSimple: 'MyLogger', via: 'field', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(g.edges.find((e) => e.type === 'MAY_CALL').to, symbolId('com.example.MyLogger#info'));
  assert.equal(stats.identifierReceivers.generatedField, 0);
});

test('RM35 D: a JDK on-demand import places the type, and the call leaves the project', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Svc', { file: 'com/example/Svc.java' }),
    { kind: 'import', owner: 'com.example.Svc', simple: '*', fqn: 'java.util', file: 'com/example/Svc.java' },
    { kind: 'field', owner: 'com.example.Svc', name: 'ring', typeSimple: 'Map', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'ring', method: 'computeIfAbsent', toTypeSimple: 'Map', via: 'field', file: 'com/example/Svc.java' },
    // …and the static spelling: `Arrays.asList(…)` is a TYPE, so it is a static
    // call, counted apart and followed no further.
    { kind: 'call', from: 'com.example.Svc#g', receiver: 'Arrays', method: 'asList', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
    // A CONSTANT under the same import is not a type and must not be invented
    // into one.
    { kind: 'call', from: 'com.example.Svc#h', receiver: 'ADD_STRING', method: 'equals', toTypeSimple: null, via: 'identifier', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, symbolId('java.util.Map#computeIfAbsent'));
  assert.equal(e.evidence.rule, 'wildcard-jdk');
  assert.equal(stats.externalCalls, 1);
  assert.equal(stats.identifierReceivers.staticReceiver, 1, 'Arrays');
  assert.equal(stats.unresolvedCalls, 1, 'ADD_STRING is a constant, and java.util.ADD_STRING does not exist');
  assert.equal(stats.unresolvedCallsByReason.unknown, 1);
});

test('RM35 D: a wildcard of THIS project that no root holds is named, not invented', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.Svc', { file: 'com/example/Svc.java' }),
    // The file offers two homes for `RedisUtil`, and one of them is a package of
    // this project.
    { kind: 'import', owner: 'com.example.Svc', simple: '*', fqn: 'java.util', file: 'com/example/Svc.java' },
    { kind: 'import', owner: 'com.example.Svc', simple: '*', fqn: 'com.example.util', file: 'com/example/Svc.java' },
    // …and ANOTHER file in this project writes the single-type import, which is
    // the evidence that says which package really holds it.
    typeRec('com.example.Other', { file: 'com/example/Other.java' }),
    { kind: 'import', owner: 'com.example.Other', simple: 'RedisUtil', fqn: 'com.example.util.RedisUtil', file: 'com/example/Other.java' },
    { kind: 'field', owner: 'com.example.Svc', name: 'redis', typeSimple: 'RedisUtil', file: 'com/example/Svc.java' },
    { kind: 'call', from: 'com.example.Svc#f', receiver: 'redis', method: 'set', toTypeSimple: 'RedisUtil', via: 'field', file: 'com/example/Svc.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0,
    'java.util.RedisUtil is a type that does not exist, so no edge is invented');
  assert.equal(stats.unresolvedCalls, 1);
  assert.equal(stats.unresolvedCallsByReason['project-type-outside-roots'], 1);
  assert.deepEqual(stats.typesOutsideRoots, [{ package: 'com.example.util', simple: 'RedisUtil', calls: 1 }]);
});

test('RM35 E: `super.m()` into a base the imports NAME and the tree does not hold', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.SvcImpl', {
      file: 'com/example/SvcImpl.java', extends: 'ServiceImpl', extendsArgs: ['Mapper', 'Ent'],
      declaredMethods: ['list/0'],
    }),
    { kind: 'import', owner: 'com.example.SvcImpl', simple: 'ServiceImpl', fqn: 'com.baomidou.ServiceImpl', file: 'com/example/SvcImpl.java' },
    { kind: 'call', from: 'com.example.SvcImpl#list', receiver: 'super', method: 'list', toTypeSimple: 'ServiceImpl', via: 'super-method', file: 'com/example/SvcImpl.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(stats.unresolvedCalls, 0);
  assert.equal(stats.callsByRule['super-enclosing'], 1);
  const e = g.edges.find((x) => x.type === 'MAY_CALL');
  assert.equal(e.to, symbolId('com.baomidou.ServiceImpl#list'));
  assert.equal(e.evidence.outsideRoots, true);
  assert.equal(g.nodes.get(e.to).external, true);
});

test('RM35 E: a base the imports do NOT name at all stays unresolved, and says why', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.SvcImpl', {
      file: 'com/example/SvcImpl.java', extends: 'Nowhere', declaredMethods: ['list/0'],
    }),
    { kind: 'call', from: 'com.example.SvcImpl#list', receiver: 'super', method: 'list', toTypeSimple: 'Nowhere', via: 'super-method', file: 'com/example/SvcImpl.java' },
  ], { packagePrefixes: ['com.example'] });
  assert.equal(g.edges.filter((e) => e.type === 'MAY_CALL').length, 0);
  assert.equal(stats.unresolvedCalls, 1);
  assert.equal(stats.unresolvedCallsByRule['super-enclosing'], 1);
  assert.equal(stats.unresolvedCallsByReason['superclass-outside-roots'], 1);
});

// ---------------------------------------------------------------------------
// CALLS_HTTP from an IMPERATIVE client call (javafacts/8 `httpCall` facts)
// ---------------------------------------------------------------------------
//
// The same edge the declarative rule above draws, from the other way of writing
// the call. What is under test here is the DECISION, not the parsing: the worker
// hands over a verb and a path, and this bridge decides whether a route in this
// pack answers it, at what grade, and what happens when nothing does.

/** A controller serving one route, as the minimum a call can land on. */
function servedRoute(httpMethod, routePath, member = 'com.example.Api#one') {
  const owner = member.slice(0, member.indexOf('#'));
  return [
    typeRec(owner, { file: 'com/example/Api.java', annotations: ['RestController'], declaredMethods: ['one/1'] }),
    {
      kind: 'endpoint', httpMethod, path: routePath, handler: member, handlerType: owner,
      line: 9, file: 'com/example/Api.java',
    },
  ];
}

/** One `httpCall` fact with the fields the worker always writes. */
function httpCallRec(extra = {}) {
  return {
    kind: 'httpCall', from: 'com.example.Client#fetch', client: 'webclient',
    receiver: 'webClient', receiverType: 'WebClient', httpMethod: 'GET',
    urlKind: 'literal', url: 'http://svc.invalid/a', written: '"http://svc.invalid/a"',
    host: 'svc.invalid', hostLiteral: true, base: null, path: '/a', query: null,
    line: 12, file: 'com/example/Client.java', ...extra,
  };
}

test('an imperative call whose method+path names a route this pack serves is SOUND_SET', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...servedRoute('GET', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec(),
  ], { packagePrefixes: ['com.example'] });

  const edges = g.edges.filter((e) => e.type === 'CALLS_HTTP');
  assert.equal(edges.length, 1);
  const e = edges[0];
  assert.equal(e.from, symbolId('com.example.Client#fetch'));
  assert.equal(e.to, endpointId('GET', '/a'));
  assert.equal(e.grade, 'SOUND_SET', 'which deployable answers is not knowable from source: never above SOUND_SET');
  assert.equal(e.evidence.rule, 'http-client-call');
  assert.equal(e.evidence.client, 'webclient');
  assert.equal(e.evidence.match, 'exact');
  assert.equal(e.evidence.target, 'in-pack');
  // The host is a SERVICE name, and `serviceLiteral` says it was written as one.
  assert.equal(e.evidence.service, 'svc.invalid');
  assert.equal(e.evidence.serviceLiteral, true);
  assert.deepEqual(e.evidence.url, { written: '"http://svc.invalid/a"', template: '/a', kind: 'literal', base: null });
  assert.equal(stats.httpCalls, 1);
  assert.equal(stats.httpCallsImperative, 1);
  assert.equal(stats.httpCallsDeclarative, 0);
  assert.equal(stats.httpCallsResolved, 1);
  assert.equal(stats.httpCallsUrlUnreadable, 0);
  // The route this pack SERVES is not re-marked as one it only calls.
  assert.equal(g.nodes.get(endpointId('GET', '/a')).outbound, undefined);
});

test('a call path with a hole lands on the route template it matches', () => {
  const g = new Graph();
  addJavaFacts(g, [
    ...servedRoute('POST', '/owners/{ownerId}/pets'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    // `base + "/owners/" + id + "/pets"`, as the worker reduces it.
    httpCallRec({
      httpMethod: 'POST', urlKind: 'concat', url: '/owners/{*}/pets', path: '/owners/{*}/pets',
      host: null, hostLiteral: false, base: 'serviceUri()', written: 'serviceUri() + "/owners/" + id + "/pets"',
    }),
  ], { packagePrefixes: ['com.example'] });

  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, endpointId('POST', '/owners/{ownerId}/pets'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.equal(e.evidence.match, 'template');
  // The base was not readable, so the host is not claimed to be anything.
  assert.equal(e.evidence.service, null);
  assert.equal(e.evidence.serviceLiteral, false);
  assert.equal(e.evidence.url.base, 'serviceUri()');
});

test('an imperative call that matches no route here is UNRESOLVED, and no walk follows it', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...servedRoute('GET', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec({ url: 'http://svc.invalid/elsewhere', path: '/elsewhere' }),
  ], { packagePrefixes: ['com.example'] });

  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, endpointId('GET', '/elsewhere'));
  assert.equal(e.grade, 'UNRESOLVED');
  assert.equal(e.evidence.target, 'outside-pack');
  assert.equal(e.evidence.match, null);
  assert.equal(stats.httpCallsUnresolved, 1);
  assert.equal(stats.httpCallsResolved, 0);
  // The target is a real route of a real call, so it is IN the graph and marked
  // as one this pack only calls.
  assert.equal(g.nodes.get(endpointId('GET', '/elsewhere')).outbound, true);
  // ...and below every mode's floor, so no walk crosses it. The SAME walk over
  // a call that did resolve crosses two nodes (the route, then its handler),
  // which is what makes this a floor and not an absence of edges.
  const from = symbolId('com.example.Client#fetch');
  assert.equal(chainWalk(g, { start: from, mode: 'heuristic', edgeTypes: FLOW_EDGE_TYPES }).walked, 0,
    'an UNRESOLVED edge is counted, never walked');

  const served = new Graph();
  addJavaFacts(served, [
    ...servedRoute('GET', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec(),
  ], { packagePrefixes: ['com.example'] });
  assert.equal(chainWalk(served, { start: from, mode: 'conservative', edgeTypes: FLOW_EDGE_TYPES }).walked, 2,
    'a SOUND_SET hop is crossed even under the conservative floor: the route, then the method that answers it');
});

test('a url the worker could not read draws NO edge, invents no route, and is counted', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...servedRoute('GET', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec({
      client: 'resttemplate', receiver: 'restTemplate', receiverType: 'RestTemplate',
      urlKind: 'unresolved', url: null, path: null, host: null, hostLiteral: false, written: 'endpoint',
    }),
  ], { packagePrefixes: ['com.example'] });

  assert.deepEqual(g.edges.filter((e) => e.type === 'CALLS_HTTP'), []);
  assert.deepEqual([...g.nodes.keys()].filter((id) => id.startsWith('endpoint:')), [endpointId('GET', '/a')]);
  assert.equal(stats.httpCallsUrlUnreadable, 1);
  assert.equal(stats.httpCalls, 0);
});

test('gatewayRoutes rewrites an imperative call\'s prefix before it is matched', () => {
  const facts = [
    ...servedRoute('GET', '/sys/user/list'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec({ url: 'http://svc.invalid/api/user/list', path: '/api/user/list' }),
  ];
  // Undeclared, the call names a route nothing here serves.
  const plain = new Graph();
  addJavaFacts(plain, facts, { packagePrefixes: ['com.example'] });
  assert.equal(plain.edges.find((e) => e.type === 'CALLS_HTTP').grade, 'UNRESOLVED');

  // Declared, the same call lands on the route the other service really serves.
  const g = new Graph();
  addJavaFacts(g, facts, { packagePrefixes: ['com.example'], gatewayRoutes: { '/api': '/sys' } });
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, endpointId('GET', '/sys/user/list'));
  assert.equal(e.grade, 'SOUND_SET');
  assert.deepEqual(e.evidence.prefix, { value: '/sys', from: 'declared', written: '/api' });
  assert.equal(e.evidence.url.template, '/sys/user/list', 'the path searched for is the rewritten one');
});

test('a discovered gateway route names the service a call with no host of its own goes to (RM46)', () => {
  // The gateway's own route table, as `cascade init` writes it: the prefix, the
  // prefix the back end sees, and the deployable it is forwarded to.
  const routes = { '/api': { to: '/sys', service: 'user-service', from: 'src/main/resources/application.yml' } };
  const noHost = {
    url: '/api/user/list', written: '"/api/user/list"', host: null, hostLiteral: false, path: '/api/user/list',
  };

  const g = new Graph();
  addJavaFacts(g, [
    ...servedRoute('GET', '/sys/user/list'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec(noHost),
  ], { packagePrefixes: ['com.example'], gatewayRoutes: routes });
  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, endpointId('GET', '/sys/user/list'), 'the object value rewrites the path exactly as a string one does');
  assert.deepEqual(e.evidence.prefix, { value: '/sys', from: 'declared', written: '/api' });
  assert.equal(e.evidence.service, 'user-service');
  assert.equal(e.evidence.serviceLiteral, true, 'the gateway table wrote that name down');

  // A call that carries its OWN host keeps it: the code at the call site
  // outranks a table about somebody else's prefix.
  const own = new Graph();
  addJavaFacts(own, [
    ...servedRoute('GET', '/sys/user/list'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec({ url: 'http://other.invalid/api/user/list', host: 'other.invalid', hostLiteral: true, path: '/api/user/list' }),
  ], { packagePrefixes: ['com.example'], gatewayRoutes: routes });
  assert.equal(own.edges.find((x) => x.type === 'CALLS_HTTP').evidence.service, 'other.invalid');
});

test('two imperative calls from one method to one route are one edge, whatever order they arrive in', () => {
  const twice = [
    ...servedRoute('GET', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    httpCallRec({ line: 12 }),
    httpCallRec({ line: 30 }),
  ];
  const a = new Graph();
  const statsA = addJavaFacts(a, twice, { packagePrefixes: ['com.example'] });
  const b = new Graph();
  addJavaFacts(b, [twice[0], twice[1], twice[2], twice[4], twice[3]], { packagePrefixes: ['com.example'] });
  assert.equal(a.edges.filter((e) => e.type === 'CALLS_HTTP').length, 1);
  assert.equal(statsA.httpCalls, 1);
  assert.deepEqual(edgeKeys(a), edgeKeys(b), 'the same facts in the other order must build the same edges');
});

test('an imperative call whose VERB the worker could not read is matched on the path alone, and says so', () => {
  const g = new Graph();
  addJavaFacts(g, [
    ...servedRoute('POST', '/a'),
    typeRec('com.example.Client', { file: 'com/example/Client.java', declaredMethods: ['fetch/0'] }),
    // `restTemplate.exchange(url, method, …)`: the verb is a variable, so the
    // worker recorded no method at all rather than the variable's name.
    httpCallRec({
      client: 'resttemplate', receiver: 'restTemplate', receiverType: 'RestTemplate',
      httpMethod: null, written: 'restTemplate.exchange',
    }),
  ], { packagePrefixes: ['com.example'] });

  const e = g.edges.find((x) => x.type === 'CALLS_HTTP');
  assert.equal(e.to, endpointId('POST', '/a'), 'the only route with this path, whatever its method');
  assert.equal(e.grade, 'HEURISTIC', 'a path-only match is below the conservative floor');
  assert.equal(e.evidence.method, null);
  assert.equal(chainWalk(g, {
    start: symbolId('com.example.Client#fetch'), mode: 'conservative', edgeTypes: FLOW_EDGE_TYPES,
  }).walked, 0, 'a walk that only trusts checked links does not cross it');
});

// ---------------------------------------------------------------------------
// the calls the FRAMEWORK makes: @ModelAttribute (RM54)
//
// Spring runs a controller's `@ModelAttribute` methods before every handler of
// that controller. No line of source calls them, so until this rule nothing led
// to them: on spring-petclinic, `GET /owners/{ownerId}/edit` answered no table
// while a real agent capture of that request read four.
// ---------------------------------------------------------------------------

/** A controller with model-attribute methods, its handlers, and what they call. */
function controllerWithModelAttributes(extra = {}) {
  return [
    typeRec('com.example.OwnerController', {
      file: 'com/example/OwnerController.java',
      annotations: extra.annotations ?? ['Controller'],
      declaredMethods: ['findOwner/1', 'edit/0', 'save/1'],
      declaredMethodLines: [10, 20, 30],
      modelAttributeMethods: extra.modelAttributeMethods ?? ['findOwner'],
    }),
    {
      kind: 'endpoint', httpMethod: 'GET', path: '/owners/{ownerId}/edit',
      handler: 'com.example.OwnerController#edit', handlerType: 'com.example.OwnerController',
      line: 20, file: 'com/example/OwnerController.java',
    },
    {
      kind: 'endpoint', httpMethod: 'POST', path: '/owners/{ownerId}/edit',
      handler: 'com.example.OwnerController#save', handlerType: 'com.example.OwnerController',
      line: 30, file: 'com/example/OwnerController.java',
    },
  ];
}

test('a @ModelAttribute method is called by EVERY handler of its controller, and the edge is EXACT', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, controllerWithModelAttributes(), { packagePrefixes: ['com.example'] });
  const edges = g.edges.filter((e) => e.type === 'MAY_CALL' && e.evidence?.rule === 'spring-model-attribute');
  assert.deepEqual(edges.map((e) => `${e.from} -> ${e.to}`).sort(), [
    `${symbolId('com.example.OwnerController#edit')} -> ${symbolId('com.example.OwnerController#findOwner')}`,
    `${symbolId('com.example.OwnerController#save')} -> ${symbolId('com.example.OwnerController#findOwner')}`,
  ]);
  // EXACT, and the only rule in this module that is: nothing was resolved here.
  // Spring's own contract says the method runs before each handler.
  assert.deepEqual([...new Set(edges.map((e) => e.grade))], ['EXACT']);
  assert.equal(edges[0].evidence.basis, CALL_RULE_BASIS['spring-model-attribute']);
  assert.equal(edges[0].evidence.attribute, 'findOwner');
  assert.equal(stats.callsByRule['spring-model-attribute'], 2);
  assert.deepEqual(stats.modelAttribute, {
    methods: 1, edges: 2, onAdvice: 0, onSuperclass: 0, inheritedHandlers: 0,
  });
});

test('the same facts in the other order place the same @ModelAttribute edges, once each', () => {
  const facts = controllerWithModelAttributes({ modelAttributeMethods: ['findOwner', 'clock'] });
  const a = new Graph();
  addJavaFacts(a, facts, { packagePrefixes: ['com.example'] });
  const b = new Graph();
  addJavaFacts(b, [facts[2], facts[0], facts[1]], { packagePrefixes: ['com.example'] });
  const keys = (g) => g.edges.filter((e) => e.evidence?.rule === 'spring-model-attribute')
    .map((e) => `${e.from}|${e.to}`).sort();
  assert.equal(keys(a).length, 4, 'two handlers, two model attributes');
  assert.equal(new Set(keys(a)).size, 4, 'and not one edge twice');
  assert.deepEqual(keys(a), keys(b));
});

test('a @ControllerAdvice model attribute is NOT followed, and is counted instead', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    ...controllerWithModelAttributes({ modelAttributeMethods: [] }),
    typeRec('com.example.GlobalAdvice', {
      file: 'com/example/GlobalAdvice.java', annotations: ['ControllerAdvice'],
      declaredMethods: ['currentUser/0'], declaredMethodLines: [5],
      modelAttributeMethods: ['currentUser'],
    }),
  ], { packagePrefixes: ['com.example'] });
  assert.deepEqual(g.edges.filter((e) => e.evidence?.rule === 'spring-model-attribute'), [],
    'which controllers an advice runs for is not a fact about one class');
  assert.equal(stats.modelAttribute.onAdvice, 1);
  assert.equal(stats.modelAttribute.edges, 0);
});

test('a model attribute a controller INHERITS is not followed, and neither is an inherited handler', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    // The base declares the model attribute AND a handler; the subclass declares
    // neither. Spring runs both for the subclass, and this rule stays inside one
    // class rather than guessing at the chain.
    typeRec('com.example.BaseController', {
      file: 'com/example/BaseController.java', annotations: [],
      declaredMethods: ['common/0', 'list/0'], declaredMethodLines: [4, 8],
      modelAttributeMethods: ['common'],
    }),
    {
      kind: 'endpoint', httpMethod: 'GET', path: '/base/list',
      handler: 'com.example.BaseController#list', handlerType: 'com.example.BaseController',
      line: 8, file: 'com/example/BaseController.java',
    },
    typeRec('com.example.ChildController', {
      file: 'com/example/ChildController.java', annotations: ['Controller'], extends: 'BaseController',
      declaredMethods: ['own/0'], declaredMethodLines: [12],
      modelAttributeMethods: ['pageSize'],
    }),
    {
      kind: 'endpoint', httpMethod: 'GET', path: '/child/own',
      handler: 'com.example.ChildController#own', handlerType: 'com.example.ChildController',
      line: 12, file: 'com/example/ChildController.java',
    },
  ], { packagePrefixes: ['com.example'] });
  const edges = g.edges.filter((e) => e.evidence?.rule === 'spring-model-attribute');
  assert.deepEqual(edges.map((e) => `${e.from} -> ${e.to}`), [
    `${symbolId('com.example.ChildController#own')} -> ${symbolId('com.example.ChildController#pageSize')}`,
  ], 'only the handler and the model attribute the SAME class declares');
  assert.equal(stats.modelAttribute.onSuperclass, 1, 'the base class\'s own model attribute');
  assert.equal(stats.modelAttribute.inheritedHandlers, 1, 'and the handler the child only inherits');
});

test('a class that is not a controller at all gets no @ModelAttribute edge', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, [
    typeRec('com.example.PlainBean', {
      declaredMethods: ['thing/0'], declaredMethodLines: [3], modelAttributeMethods: ['thing'],
    }),
  ], { packagePrefixes: ['com.example'] });
  assert.deepEqual(g.edges.filter((e) => e.evidence?.rule === 'spring-model-attribute'), []);
  assert.equal(stats.modelAttribute.onSuperclass, 1);
});
