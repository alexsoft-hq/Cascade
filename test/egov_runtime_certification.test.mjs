// egov_runtime_certification.test.mjs — what a real run of the eGovFrame web
// sample found wrong, one rule per finding (RM62).
//
// The sample was built, run under the OpenTelemetry Java agent and driven through
// every button of its two screens in a headless browser. Four things stood
// between that run and a certificate, and each is pinned here on a graph small
// enough to read:
//
//   a table named in two cases   the mapper writes `UPDATE SAMPLE`, the span
//                                reports `sample`, and the two were compared as
//                                different tables
//   the key generator's table    `POST /addSample.do` touched `IDS` through
//                                `egovIdGnrService.getNextStringId()`, a bean a
//                                Spring XML declares and no mapper mentions
//   the page that sent a form    a form submit opens the next page, so a HAR
//                                files it under the page it opened; the page
//                                that sent it is the one its Referer names
//   a session in the address     `/list.do;jsessionid=…` is `/list.do`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { findIdGenerators, ID_GENERATOR_DEFAULTS, springBeansOf } from '../src/core/springconfig.mjs';
import { idGeneratorStatements, bindIdGenerators, emptyIdGeneratorCensus, ID_GENERATOR_RULE } from '../src/adapters/java/idgnr.mjs';
import {
  addRuntimeFacts, otelGoldenCases, otelMethodsInclude, readOtelTrace, spelledTable, statementOfObservation, tableSpellings,
} from '../src/adapters/runtime_bridge.mjs';
import { addHarFacts, readHar, requestPathOf } from '../src/adapters/har_bridge.mjs';
import { inventoryOf } from '../src/core/golden.mjs';
import { statementKey } from '../src/adapters/sql_bridge.mjs';
import { pinOf } from '../src/core/calibration.mjs';
import { templateImports } from '../adapters/web/lib/templates.mjs';

// ---------------------------------------------------------------------------
// 1. the key generator, as a Spring XML declares it
// ---------------------------------------------------------------------------

const BEANS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
  <bean name="egovIdGnrService" class="org.egovframe.rte.fdl.idgnr.impl.EgovTableIdGnrServiceImpl" destroy-method="destroy">
    <property name="dataSource" ref="dataSource" />
    <property name="table" value="IDS"/>
    <property name="tableName" value="SAMPLE"/>
  </bean>
  <bean id="plainIdGnrService" class="org.egovframe.rte.fdl.idgnr.impl.EgovTableIdGnrServiceImpl"/>
  <!-- <bean name="commentedIdGnrService" class="org.egovframe.rte.fdl.idgnr.impl.EgovTableIdGnrServiceImpl"/> -->
  <bean name="seqIdGnrService" class="org.egovframe.rte.fdl.idgnr.impl.EgovSequenceIdGnrServiceImpl">
    <property name="query" value="SELECT SEQ.NEXTVAL FROM DUAL"/>
  </bean>
</beans>`;

test('a bean is named by `name` as well as by `id`, and the first alias is the name', () => {
  const beans = springBeansOf('<beans><bean name="a, b" class="x.Y"/><bean id="c" class="x.Z"/></beans>');
  assert.deepEqual(beans.map((b) => [b.name, b.id]), [['a', null], [null, 'c']]);
});

test('a table id generator bean names its table and key, and says which names it left to the class', () => {
  const gens = findIdGenerators([{ path: 'context-idgen.xml', text: BEANS_XML }]);
  // The commented-out bean is not a bean, and a sequence generator touches no table.
  assert.deepEqual(gens.map((g) => g.bean), ['egovIdGnrService', 'plainIdGnrService']);
  const [sample, plain] = gens;
  assert.deepEqual([sample.table, sample.key, sample.keyColumn, sample.nextIdColumn], ['IDS', 'SAMPLE', 'table_name', 'next_id']);
  assert.deepEqual(sample.from, { table: 'bean', key: 'bean', keyColumn: 'default', nextIdColumn: 'default' });
  assert.equal(plain.table, ID_GENERATOR_DEFAULTS.table);
  assert.equal(plain.from.table, 'default');
});

test('a generator runs the two statements the class runs, with the bean\'s own names in them', () => {
  const [gen] = findIdGenerators([{ path: 'context-idgen.xml', text: BEANS_XML }]);
  const stmts = idGeneratorStatements([gen, { ...gen, file: 'z.xml' }]);
  // A bean declared twice under one name is one generator.
  assert.deepEqual(stmts.map((s) => [s.namespace, s.id, s.type, s.sql]), [
    ['egov-idgnr.egovIdGnrService', 'allocate', 'select', 'SELECT next_id FROM IDS WHERE table_name = ? FOR UPDATE'],
    ['egov-idgnr.egovIdGnrService', 'advance', 'update', 'UPDATE IDS SET next_id = ? WHERE table_name = ?'],
  ]);
});

/** The Java bridge's context, reduced to what the binding reads. */
function javaCtx(g, { calls, beanNames, superOf = new Map() }) {
  const ensureSymbol = (member) => {
    const id = `symbol:${member}`;
    if (!g.nodes.has(id)) g.addNode({ id, symbol: member });
    return id;
  };
  return {
    g, calls, superOf, ensureSymbol,
    stats: { idGenerators: emptyIdGeneratorCensus() },
    beanNamesByOwner: new Map(Object.entries(beanNames).map(([owner, fields]) => [owner, new Map(Object.entries(fields))])),
  };
}

test('a call on a field injected by a generator\'s name reaches the table the generator advances', () => {
  const [gen] = findIdGenerators([{ path: 'context-idgen.xml', text: BEANS_XML }]);
  const g = new Graph();
  for (const id of ['allocate', 'advance']) g.addNode({ id: `statement:egov-idgnr.egovIdGnrService.${id}` });
  const ctx = javaCtx(g, {
    calls: [
      { from: 'x.SampleServiceImpl#insertSample', receiver: 'egovIdGnrService', method: 'getNextStringId', via: 'field' },
      // The same call twice in one method is one edge.
      { from: 'x.SampleServiceImpl#insertSample', receiver: 'egovIdGnrService', method: 'getNextStringId', via: 'field' },
      // A field inherited from the base class asks for the same bean.
      { from: 'x.OtherServiceImpl#insert', receiver: 'egovIdGnrService', method: 'getNextIntegerId', via: 'field' },
      // A name no generator has, and a method that allocates nothing.
      { from: 'x.SampleServiceImpl#insertSample', receiver: 'unknownIdGnrService', method: 'getNextStringId', via: 'field' },
      { from: 'x.SampleServiceImpl#insertSample', receiver: 'egovIdGnrService', method: 'toString', via: 'field' },
    ],
    beanNames: {
      'x.SampleServiceImpl': { egovIdGnrService: 'egovIdGnrService', unknownIdGnrService: 'unknownIdGnrService' },
      'x.BaseServiceImpl': { egovIdGnrService: 'egovIdGnrService' },
    },
    superOf: new Map([['x.OtherServiceImpl', 'x.BaseServiceImpl']]),
  });
  bindIdGenerators(ctx, [gen]);
  assert.deepEqual(ctx.stats.idGenerators, { declared: 1, sites: 4, bound: 2, notABean: 1, noStatement: 0, repeated: 1 });
  const target = 'symbol:org.egovframe.rte.fdl.idgnr.impl.EgovTableIdGnrServiceImpl@egovIdGnrService#getNextStringId';
  const call = g.edges.find((e) => e.from === 'symbol:x.SampleServiceImpl#insertSample' && e.to === target);
  assert.equal(call.type, 'MAY_CALL');
  assert.equal(call.grade, 'SOUND_SET');
  assert.equal(call.evidence.rule, ID_GENERATOR_RULE);
  assert.deepEqual(g.outEdges(target).map((e) => [e.type, e.to]), [
    ['IMPLEMENTS_STMT', 'statement:egov-idgnr.egovIdGnrService.allocate'],
    ['IMPLEMENTS_STMT', 'statement:egov-idgnr.egovIdGnrService.advance'],
  ]);
  assert.deepEqual(g.nodes.get(target).idGenerator, { bean: 'egovIdGnrService', table: 'IDS', key: 'SAMPLE' });
});

test('a generator whose SQL did not come back binds nothing, and says so', () => {
  const [gen] = findIdGenerators([{ path: 'context-idgen.xml', text: BEANS_XML }]);
  const g = new Graph();
  const ctx = javaCtx(g, {
    calls: [{ from: 'x.S#i', receiver: 'gen', method: 'getNextStringId', via: 'field' }],
    beanNames: { 'x.S': { gen: 'egovIdGnrService' } },
  });
  bindIdGenerators(ctx, [gen]);
  assert.equal(ctx.stats.idGenerators.noStatement, 1);
  assert.equal(g.edges.length, 0);
});

test('a generator\'s symbol is not a mapper method a `method -> statement` case is drawn from', () => {
  const g = new Graph();
  g.addNode({ id: 'symbol:x.M#find', mapperMethod: true });
  g.addNode({ id: 'symbol:G@gen#getNextStringId' });
  g.addNode({ id: 'statement:x.M.find' });
  g.addNode({ id: 'statement:egov-idgnr.gen.allocate' });
  g.addEdge({ from: 'symbol:x.M#find', to: 'statement:x.M.find', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:G@gen#getNextStringId', to: 'statement:egov-idgnr.gen.allocate', type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: ID_GENERATOR_RULE } });
  assert.deepEqual(inventoryOf(g).mapperMethods, ['x.M#find']);
});

// ---------------------------------------------------------------------------
// 2. a table named in two cases
// ---------------------------------------------------------------------------

test('a table read off a span is written the way the pack writes it, and only when one table answers', () => {
  const g = new Graph();
  g.addNode({ id: 'table:SAMPLE' });
  g.addNode({ id: 'table:app.ORDERS' });
  g.addNode({ id: 'table:Dup' });
  g.addNode({ id: 'table:DUP' });
  const sp = tableSpellings(g);
  assert.equal(spelledTable('sample', sp), 'SAMPLE');
  assert.equal(spelledTable('orders', sp), 'app.ORDERS');
  assert.equal(spelledTable('dup', sp), 'dup', 'two tables that differ only in case are not merged by a guess');
  assert.equal(spelledTable('elsewhere', sp), 'elsewhere');
});

/** One OTLP document: a POST to a route, a mapper method under it, and its SQL under that. */
function traceOf(sql) {
  const attr = (key, value) => ({ key, value: { stringValue: value } });
  const span = (spanId, parentSpanId, name, attributes, kind = 'SPAN_KIND_INTERNAL') => ({
    traceId: 'aa', spanId, parentSpanId, name, kind,
    startTimeUnixNano: '1767225600000000000', endTimeUnixNano: '1767225600001000000', attributes,
  });
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [attr('service.name', 'sample')] },
      scopeSpans: [{
        scope: { name: 'io.opentelemetry.tomcat-10.0' },
        spans: [
          span('01', '', 'POST /updateSample.do', [attr('http.request.method', 'POST'), attr('http.route', '/updateSample.do')], 'SPAN_KIND_SERVER'),
          span('02', '01', 'SampleMapper.updateSample', [attr('code.namespace', 'x.SampleMapper'), attr('code.function', 'updateSample')]),
          span('03', '02', 'UPDATE sample', [attr('db.system', 'hsqldb'), attr('db.statement', sql)], 'SPAN_KIND_CLIENT'),
        ],
      }],
    }],
  });
}

/** The pack those spans key into: a route, its handler, the mapper method, its statement and table. */
function certifiedGraph() {
  const g = new Graph();
  g.addNode({ id: 'endpoint:POST /updateSample.do', path: '/updateSample.do', httpMethod: 'POST' });
  g.addNode({ id: 'symbol:x.SampleController#updateSample' });
  g.addNode({ id: 'symbol:x.SampleMapper#updateSample', mapperMethod: true });
  g.addNode({ id: 'statement:x.SampleMapper.updateSample' });
  g.addNode({ id: 'table:SAMPLE' });
  g.addEdge({ from: 'endpoint:POST /updateSample.do', to: 'symbol:x.SampleController#updateSample', type: 'HANDLES', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:x.SampleController#updateSample', to: 'symbol:x.SampleMapper#updateSample', type: 'MAY_CALL', grade: 'SOUND_SET' });
  g.addEdge({ from: 'symbol:x.SampleMapper#updateSample', to: 'statement:x.SampleMapper.updateSample', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:x.SampleMapper.updateSample', to: 'table:SAMPLE', type: 'EXECUTES', grade: 'EXACT' });
  return g;
}

test('a statement the run touched in the other case is the table the source names, not a table only the run saw', () => {
  const g = certifiedGraph();
  const stats = addRuntimeFacts(g, [readOtelTrace(traceOf('UPDATE sample SET name = ? WHERE id = ?'), { file: 't.json' })]);
  assert.equal(stats.tablesOnlyAtRunTime, 0);
  assert.deepEqual(g.nodes.get('statement:x.SampleMapper.updateSample').observedTables, ['SAMPLE']);
});

test('a case the run labels names the table in the pack\'s spelling, so the engine\'s own answer can match it', () => {
  const g = certifiedGraph();
  const { cases } = otelGoldenCases(g, [readOtelTrace(traceOf('UPDATE sample SET name = ?'), { file: 't.json' })], { packDigest: 'd' });
  const route = cases.find((c) => c.relation === 'endpoint->tables');
  assert.deepEqual(route.expect.present, ['SAMPLE']);
});

test('the agent line counts the MyBatis mapper methods, which the agent names only through its MyBatis switch', () => {
  const inc = otelMethodsInclude(certifiedGraph());
  assert.equal(inc.mapperMethods, 1);
  assert.equal(inc.methodCount, 2);
});

// ---------------------------------------------------------------------------
// 3. the page that sent a form, and a session in the address
// ---------------------------------------------------------------------------

test('a path parameter is not part of the route', () => {
  assert.equal(requestPathOf('https://example.com/egovSampleList.do;jsessionid=5691F7?pageIndex=2'), '/egovSampleList.do');
  assert.equal(requestPathOf('/a;v=1/b.do'), '/a/b.do');
});

/** Two server-rendered pages, each reached by the routes that render it. */
function serverPages() {
  const g = new Graph();
  for (const [method, p] of [['GET', '/list.do'], ['POST', '/editView.do'], ['POST', '/addView.do'], ['POST', '/update.do']]) {
    g.addNode({ id: `endpoint:${method} ${p}`, path: p, httpMethod: method });
  }
  g.addNode({ id: 'screen:view:t/list', kind: 'screen', path: '/list.do', paths: ['/list.do'] });
  // The edit form is one screen, whichever route opened it.
  g.addNode({ id: 'screen:view:t/edit', kind: 'screen', path: '/addView.do', paths: ['/addView.do', '/editView.do'] });
  return g;
}

/** A recording of: open the list, open one row, save it, land back on the list. */
function recording() {
  const at = (s) => `2026-09-14T00:00:0${s}.000Z`;
  const entry = (pageref, method, url, status, mime, referer, redirectURL = '', s = 0) => ({
    pageref, startedDateTime: at(s),
    request: { method, url, headers: referer ? [{ name: 'Referer', value: referer }] : [] },
    response: { status, redirectURL, content: { mimeType: mime } },
  });
  return JSON.stringify({
    log: {
      pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
      entries: [
        entry('p1', 'GET', 'https://example.com/list.do', 200, 'text/html', null, '', 1),
        entry('p2', 'POST', 'https://example.com/editView.do', 200, 'text/html', 'https://example.com/list.do;jsessionid=AB', '', 2),
        entry('p3', 'POST', 'https://example.com/update.do', 302, '', 'https://example.com/editView.do', '/list.do?pageIndex=1', 3),
        entry('p3', 'GET', 'https://example.com/list.do?pageIndex=1', 200, 'text/html', 'https://example.com/editView.do', '', 4),
      ],
    },
  });
}

test('a request that opens a page is placed on the page its Referer names, and one a redirect sent on none', () => {
  const g = serverPages();
  const stats = addHarFacts(g, [readHar(recording(), { file: 's.har' })]);
  const pairs = g.edges.filter((e) => e.evidence?.rule === 'har').map((e) => `${e.from} -> ${e.to}`).sort();
  // The list sent the edit form's request, the edit form sent the save, the
  // redirect after the save was the server's, and the first page was typed.
  assert.deepEqual(pairs, [
    'screen:view:t/edit -> endpoint:POST /update.do',
    'screen:view:t/list -> endpoint:POST /editView.do',
  ]);
  assert.equal(stats.pagesWithoutScreen, 0, 'every page is a screen the source declares, by any of its routes');
  assert.equal(stats.sentByReferer, 2);
  assert.equal(stats.followedRedirects, 1);
  assert.equal(stats.openedByAddress, 1);
});

// ---------------------------------------------------------------------------
// 4. what the business template's run added
// ---------------------------------------------------------------------------
//
// The eGovFrame enterprise business template, run the same way over 130 routes:
//   a doubled namespace      `<mapper namespace="loginDAO">` with
//                            `<select id="loginDAO.actionLogin">` is the
//                            statement "loginDAO.actionLogin", as MyBatis keys it
//   a DAO's SQL              a DAO method names its statement by a string, so
//                            the span's SQL joins through the edge the Java lane
//                            already drew, not through the method's own name
//   a page importing a route `<c:import url="/sym/mms/EgovHeader.do"/>` runs the
//                            header route inside the request rendering the page
//   a trace is an input      adding one is a REPIN, not a nondeterminism


test('an id that already starts with its namespace is not prefixed again, as MyBatis keys it', () => {
  assert.equal(statementKey('loginDAO', 'loginDAO.actionLogin'), 'loginDAO.actionLogin');
  assert.equal(statementKey('loginDAO', 'actionLogin'), 'loginDAO.actionLogin');
  // A namespace that is only a PREFIX of the id's first segment is not the namespace.
  assert.equal(statementKey('login', 'loginDAO.actionLogin'), 'login.loginDAO.actionLogin');
  assert.equal(statementKey('', 'bare'), 'bare');
});

test('a DAO method\'s SQL joins the statement the method binds, narrowed by the tables the run read', () => {
  const g = new Graph();
  g.addNode({ id: 'symbol:x.LoginDAO#actionLogin' });
  g.addNode({ id: 'symbol:x.MenuDAO#select' });
  for (const [id, table] of [['statement:loginDAO.actionLogin', 'USERS'], ['statement:menu.head', 'MENU'], ['statement:menu.left', 'PROGRAM']]) {
    g.addNode({ id });
    g.addNode({ id: `table:${table}` });
    g.addEdge({ from: id, to: `table:${table}`, type: 'EXECUTES', grade: 'EXACT' });
  }
  g.addEdge({ from: 'symbol:x.LoginDAO#actionLogin', to: 'statement:loginDAO.actionLogin', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:x.MenuDAO#select', to: 'statement:menu.head', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'symbol:x.MenuDAO#select', to: 'statement:menu.left', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  // One bound statement is that statement.
  assert.equal(statementOfObservation(g, { ownerType: 'x.LoginDAO', method: 'actionLogin', tables: ['users'] }).id, 'statement:loginDAO.actionLogin');
  // Two are narrowed by the tables, compared without regard to case.
  assert.equal(statementOfObservation(g, { ownerType: 'x.MenuDAO', method: 'select', tables: ['program'] }).id, 'statement:menu.left');
  // A run that read no table cannot pick between two, and says how many there were.
  const unsure = statementOfObservation(g, { ownerType: 'x.MenuDAO', method: 'select', tables: [] });
  assert.equal(unsure.id, null);
  assert.match(unsure.key, /2 bound statements, 0 fit/);
});

test('a JSP imports a route with `<c:import>` or a route-naming `<jsp:include>`, and a template is not a route', () => {
  const imports = templateImports(`
    <c:import url="/sym/mms/EgovHeader.do" />
    <c:import url="\${pageContext.request.contextPath}/sym/mms/EgovMenuLeft.do"/>
    <jsp:include page="/WEB-INF/jsp/cmm/footer.jsp"/>
    <jsp:include page="/cop/bbs/selectCommentList.do"/>
    <c:import url="https://example.com/banner.do"/>
    <c:import url="/sym/mms/EgovHeader.do" />`, 'jsp');
  assert.deepEqual(imports.map((i) => [i.kind, i.url]), [
    ['c-import', '/sym/mms/EgovHeader.do'],
    ['c-import', '/sym/mms/EgovMenuLeft.do'],
    ['jsp-include', '/cop/bbs/selectCommentList.do'],
  ]);
  assert.deepEqual(templateImports('<c:import url="/x.do"/>', 'thymeleaf'), []);
});

test('a trace or a recording is part of what was analyzed, and a pack built without one keeps its pin', () => {
  const input = { commit: 'c', dirty: false, selection: { ddl: null, mapperDirs: ['m'], javaRoots: ['j'] }, profileDigest: 'p', catalogDigest: null };
  const without = pinOf(input);
  assert.equal(pinOf({ ...input, evidence: [] }).inputsDigest, without.inputsDigest);
  const withTrace = pinOf({ ...input, evidence: ['otel:aaa'] });
  assert.notEqual(withTrace.inputsDigest, without.inputsDigest);
  assert.equal(pinOf({ ...input, evidence: ['har:bbb', 'otel:aaa'] }).inputsDigest, pinOf({ ...input, evidence: ['otel:aaa', 'har:bbb'] }).inputsDigest);
});
