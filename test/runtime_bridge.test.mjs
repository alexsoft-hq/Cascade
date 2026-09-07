import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Graph, GRADE_SETS } from '../src/core/graph.mjs';
import {
  readOtelTrace, addRuntimeFacts, attrValue, attributesOf, spanFacets, tablesInSql, spanTimeIso,
} from '../src/adapters/runtime_bridge.mjs';
import { chainWalk } from '../src/core/chain.mjs';
import { mallGraph, skipUnlessMall } from './helpers/mall_fixture.mjs';

// The runtime evidence lane, driven by ONE hand-written OTLP/JSON trace.
//
// The trace names classes and methods a real corpus project really has, because
// that is the whole difficulty of this lane: an observation joins the static
// graph only when it keys a symbol, a statement and a route exactly the way the
// static lanes key them. The fixture therefore runs against the pinned pack, and
// the honesty rules are checked BOTH there (where the shapes are real) and on
// small graphs built here (where a shape the corpus does not happen to have, a
// four-implementor candidate set, can still be tested).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACE = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'otel', 'storefront-trace.json'), 'utf8');
const readFixture = () => readOtelTrace(TRACE, { file: 'storefront-trace.json' });

// The chain the fixture walks, by node id.
const ASPECT = 'symbol:com.macro.mall.common.log.WebLogAspect#doAround';
const CONTROLLER = 'symbol:com.macro.mall.controller.PmsBrandController#getList';
const IFACE = 'symbol:com.macro.mall.service.PmsBrandService#listBrand';
const IMPL = 'symbol:com.macro.mall.service.impl.PmsBrandServiceImpl#listBrand';
const MAPPER = 'symbol:com.macro.mall.mapper.PmsBrandMapper#selectByExample';
const STATEMENT = 'statement:com.macro.mall.mapper.PmsBrandMapper.selectByExample';
const ENDPOINT = 'endpoint:GET /brand/list';
// The sibling the trace never visited: the SAME interface, another method.
const SIBLING_IFACE = 'symbol:com.macro.mall.service.PmsBrandService#listAllBrand';
const SIBLING_IMPL = 'symbol:com.macro.mall.service.impl.PmsBrandServiceImpl#listAllBrand';

const edgeOf = (g, from, to) => g.edges.find((e) => e.from === from && e.to === to) ?? null;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('an OTLP attribute list becomes a map, and only the scalar shapes are read', () => {
  assert.equal(attrValue({ stringValue: 'x' }), 'x');
  assert.equal(attrValue({ intValue: '200' }), '200');
  assert.equal(attrValue({ doubleValue: 1.5 }), '1.5');
  assert.equal(attrValue({ boolValue: false }), 'false');
  // An array or a key-value list is not an identifier this lane can key by.
  assert.equal(attrValue({ arrayValue: { values: [] } }), null);
  assert.equal(attrValue(null), null);

  const m = attributesOf([
    { key: 'code.namespace', value: { stringValue: 'com.example.A' } },
    { key: 'http.response.status_code', value: { intValue: '200' } },
    { key: 'broken' },
  ]);
  assert.equal(m.get('code.namespace'), 'com.example.A');
  assert.equal(m.get('http.response.status_code'), '200');
  assert.equal(m.has('broken'), false);
});

test('both the old and the new spelling of every attribute are read', () => {
  const span = (attrs) => spanFacets({ attributes: attrs.map(([key, v]) => ({ key, value: { stringValue: v } })) });
  assert.deepEqual(span([['code.namespace', 'com.example.A'], ['code.function', 'run']]).method, { type: 'com.example.A', name: 'run' });
  assert.deepEqual(span([['code.namespace', 'com.example.A'], ['code.function.name', 'run']]).method, { type: 'com.example.A', name: 'run' });
  assert.equal(span([['db.statement', 'select 1']]).sql, 'select 1');
  assert.equal(span([['db.query.text', 'select 1']]).sql, 'select 1');
  assert.deepEqual(span([['http.method', 'get'], ['http.route', '/a']]).route, { httpMethod: 'GET', path: '/a' });
  assert.deepEqual(span([['http.request.method', 'POST'], ['http.route', '/a/']]).route, { httpMethod: 'POST', path: '/a' });
  // `http.target` carries a query string; a route is a path.
  assert.deepEqual(span([['http.method', 'GET'], ['http.target', '/a/1?x=2']]).route, { httpMethod: 'GET', path: '/a/1' });
  // A route with no method is not addressable: half a key is no key.
  assert.equal(span([['http.route', '/a']]).route, null);
  // A span with nothing this lane reads says so rather than being guessed at.
  assert.deepEqual(span([['thread.name', 'http-nio-1']]), { method: null, sql: null, route: null });
});

test('SQL is read for the TABLES it names and for nothing else', () => {
  assert.deepEqual(tablesInSql('select a from Orders o join order_line l on l.id = o.id'), ['order_line', 'orders']);
  assert.deepEqual(tablesInSql('insert into audit_log (a) values (?)'), ['audit_log']);
  assert.deepEqual(tablesInSql('update stock set n = ? where id = ?'), ['stock']);
  assert.deepEqual(tablesInSql('delete from cart where id = ?'), ['cart']);
  assert.deepEqual(tablesInSql('select shard.orders.id from shard.orders'), ['shard.orders']);
  // Neither of these names a table of this schema.
  assert.deepEqual(tablesInSql('select 1 from dual'), []);
  assert.deepEqual(tablesInSql(''), []);
});

test('a span time is read as UTC, and an unparsable one is left null', () => {
  assert.equal(spanTimeIso('1767225600000000000'), '2026-01-01T00:00:00.000Z');
  assert.equal(spanTimeIso(null), null);
  assert.equal(spanTimeIso('not-a-number'), null);
});

test('a file that is not a trace is REFUSED by name, and contributes nothing', () => {
  const notJson = readOtelTrace('<html>', { file: 'a.json' });
  assert.match(notJson.unreadable, /not JSON/);
  assert.deepEqual(notJson.observations, []);

  const noSpans = readOtelTrace('{"data": []}', { file: 'b.json' });
  assert.match(noSpans.unreadable, /no resourceSpans/);

  const truncated = readOtelTrace('{"resourceSpans": [', { file: 'c.json' });
  assert.match(truncated.unreadable, /not JSON/);

  // ...and none of them throws, or stops the bridge.
  const g = new Graph();
  g.addNode({ id: CONTROLLER, file: 'C.java' });
  const stats = addRuntimeFacts(g, [notJson, noSpans, truncated]);
  assert.deepEqual(stats.unreadable.map((u) => u.file), ['a.json', 'b.json', 'c.json']);
  assert.equal(stats.observations, 0);
  assert.equal(g.edges.length, 0);
});

test('the fixture reads into the normalised observations, folded and sorted', () => {
  const rec = readFixture();
  assert.equal(rec.unreadable, null);
  assert.equal(rec.spans, 10);
  assert.equal(rec.usableSpans, 9);
  // One span carries no attribute this lane reads. Counted, never guessed at.
  assert.equal(rec.unusable, 1);
  assert.deepEqual(rec.services, ['storefront-api']);
  assert.deepEqual(rec.window, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.004Z' });

  assert.deepEqual(rec.observations, [
    {
      kind: 'dispatch',
      callerType: 'com.macro.mall.common.log.WebLogAspect', callerMethod: 'doAround',
      calleeType: 'com.macro.mall.controller.PmsBrandController', calleeMethod: 'getList',
      direct: true, count: 1,
    },
    {
      kind: 'dispatch',
      callerType: 'com.macro.mall.controller.PmsBrandController', callerMethod: 'getList',
      calleeType: 'com.macro.mall.service.impl.PmsBrandServiceImpl', calleeMethod: 'listBrand',
      direct: true, count: 1,
    },
    {
      kind: 'dispatch',
      callerType: 'com.macro.mall.portal.controller.PmsPortalBrandController', callerMethod: 'detail',
      calleeType: 'io.lettuce.core.RedisClient', calleeMethod: 'connect',
      direct: true, count: 1,
    },
    {
      kind: 'dispatch',
      callerType: 'com.macro.mall.service.impl.PmsBrandServiceImpl', callerMethod: 'listBrand',
      calleeType: 'com.macro.mall.mapper.PmsBrandMapper', calleeMethod: 'selectByExample',
      direct: true, count: 1,
    },
    { kind: 'endpoint', httpMethod: 'GET', path: '/brand/detail/12', count: 1 },
    { kind: 'endpoint', httpMethod: 'GET', path: '/brand/list', count: 1 },
    {
      kind: 'statement',
      ownerType: 'com.macro.mall.mapper.PmsBrandMapper', method: 'selectByExample',
      sql: 'select id, name, first_letter, sort, factory_status, show_status, product_count, '
        + 'product_comment_count, logo, big_pic from pms_brand WHERE ( show_status = ? ) order by sort desc',
      tables: ['pms_brand'], count: 1,
    },
  ]);
});

test('the same chain seen twice is ONE observation with the count on it', () => {
  const doubled = JSON.parse(TRACE);
  const scope = doubled.resourceSpans[0].scopeSpans[0];
  // The same five spans again, under new span ids, exactly as a second request
  // through the same chain would arrive.
  scope.spans = [...scope.spans, ...scope.spans.map((s) => ({
    ...s,
    spanId: s.spanId.replace(/0(\d)$/, '1$1'),
    parentSpanId: s.parentSpanId === '' ? '' : s.parentSpanId.replace(/0(\d)$/, '1$1'),
  }))];
  const rec = readOtelTrace(JSON.stringify(doubled), { file: 'twice.json' });
  const d = rec.observations.find((o) => o.kind === 'dispatch' && o.calleeMethod === 'listBrand');
  assert.equal(d.count, 2);
  const s = rec.observations.find((o) => o.kind === 'statement');
  assert.equal(s.count, 2);
});

// ---------------------------------------------------------------------------
// The joins, on the real graph
// ---------------------------------------------------------------------------

test('the dispatch a trace saw is marked observed, and its GRADE IS UNCHANGED', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const before = { ...edgeOf(g, IFACE, IMPL) };
  assert.equal(before.grade, 'SOUND_SET');
  assert.equal(before.evidence.observed, undefined, 'the static pack carries no observation of its own');

  addRuntimeFacts(g, [readFixture()]);

  const after = edgeOf(g, IFACE, IMPL);
  // THE RULE: the grade string is identical before and after.
  assert.equal(after.grade, before.grade);
  assert.equal(after.grade, 'SOUND_SET');
  // ...and the rule that produced it is untouched too.
  assert.equal(after.evidence.rule, before.evidence.rule);
  assert.equal(after.evidence.iface, before.evidence.iface);
  // What is added is a marker beside the grade, with the count and the source.
  assert.equal(after.evidence.observed, true);
  assert.equal(after.evidence.observedCount, 1);
  assert.deepEqual(after.evidence.observedBy, ['storefront-trace.json']);

  // The call INTO the interface is marked as well: the request really went
  // through it, and the two hops are one dispatch.
  assert.equal(edgeOf(g, CONTROLLER, IFACE).evidence.observed, true);
  assert.equal(edgeOf(g, CONTROLLER, IFACE).grade, 'SOUND_SET');
  // ...and so is the direct call the source states, below it.
  assert.equal(edgeOf(g, IMPL, MAPPER).evidence.observed, true);
  assert.equal(edgeOf(g, IMPL, MAPPER).grade, 'SOUND_SET');
});

test('an unobserved sibling candidate is still there, and NOT marked', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  addRuntimeFacts(g, [readFixture()]);

  // The controller's other call, and the dispatch below it. The trace never
  // visited either, and absence of observation is not absence of the path.
  const otherCall = edgeOf(g, CONTROLLER, SIBLING_IFACE);
  assert.ok(otherCall, 'the call the trace did not see was removed');
  assert.equal(otherCall.grade, 'SOUND_SET');
  assert.equal(otherCall.evidence.observed, undefined);

  const otherDispatch = edgeOf(g, SIBLING_IFACE, SIBLING_IMPL);
  assert.ok(otherDispatch, 'the dispatch the trace did not see was removed');
  assert.equal(otherDispatch.grade, 'SOUND_SET');
  assert.equal(otherDispatch.evidence.observed, undefined);
  assert.equal(g.nodes.get(SIBLING_IMPL).observed, undefined);
});

test('a statement the trace named is observed, with the tables its SQL really touched', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const staticTables = g.outEdges(STATEMENT).filter((e) => e.type === 'EXECUTES').map((e) => e.to).sort();
  addRuntimeFacts(g, [readFixture()]);

  const n = g.nodes.get(STATEMENT);
  assert.equal(n.observed, true);
  assert.equal(n.observedCount, 1);
  assert.deepEqual(n.observedTables, ['pms_brand']);
  // Beside the statically derived tables, never instead of them.
  assert.deepEqual(g.outEdges(STATEMENT).filter((e) => e.type === 'EXECUTES').map((e) => e.to).sort(), staticTables);
  // The binding the code side reads is marked too.
  assert.equal(edgeOf(g, MAPPER, STATEMENT).evidence.observed, true);
  assert.equal(edgeOf(g, MAPPER, STATEMENT).grade, 'EXACT');
});

test('a route is matched exactly, and through its TEMPLATE', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  addRuntimeFacts(g, [readFixture()]);
  assert.equal(g.nodes.get(ENDPOINT).observed, true);
  // `/brand/detail/12` is a concrete path; the route is `/brand/detail/{brandId}`.
  assert.equal(g.nodes.get('endpoint:GET /brand/detail/{brandId}').observed, true);
});

test('an observation that matches nothing is COUNTED, with the key it could not place', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const stats = addRuntimeFacts(g, [readFixture()]);
  assert.deepEqual({
    files: stats.files, spans: stats.spans, unusable: stats.unusable, observations: stats.observations,
    matched: stats.matched, unmatched: stats.unmatched,
    dispatchDirect: stats.dispatchDirect, dispatchThroughInterface: stats.dispatchThroughInterface,
    edgesObserved: stats.edgesObserved, edgesAdded: stats.edgesAdded,
    statementsObserved: stats.statementsObserved, endpointsObserved: stats.endpointsObserved,
  }, {
    files: 1, spans: 10, unusable: 1, observations: 7,
    matched: { dispatch: 3, statement: 1, endpoint: 2 },
    unmatched: { dispatch: 1, statement: 0, endpoint: 0 },
    dispatchDirect: 1, dispatchThroughInterface: 1,
    edgesObserved: 4, edgesAdded: 1,
    statementsObserved: 1, endpointsObserved: 2,
  });
  // The driver class no analysis of this source could have seen: named, not dropped.
  assert.deepEqual(stats.unmatchedKeys, [{
    kind: 'dispatch',
    key: 'com.macro.mall.portal.controller.PmsPortalBrandController#detail -> io.lettuce.core.RedisClient#connect',
    count: 1,
  }]);
  assert.deepEqual(stats.services, ['storefront-api']);
  assert.deepEqual(stats.sources, ['storefront-trace.json']);
  assert.deepEqual(stats.window, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.004Z' });
});

// ---------------------------------------------------------------------------
// The four honesty rules, explicitly
// ---------------------------------------------------------------------------

test('HONESTY 1: not one edge grade changes across addRuntimeFacts', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const before = g.edges.map((e) => `${e.from}|${e.to}|${e.type}|${e.grade}`);
  addRuntimeFacts(g, [readFixture()]);
  const after = g.edges.slice(0, before.length).map((e) => `${e.from}|${e.to}|${e.type}|${e.grade}`);
  const moved = before.filter((s, i) => s !== after[i]);
  assert.deepEqual(moved, [], `${moved.length} edge(s) changed grade or endpoint`);
});

test('HONESTY 2: no node and no edge is removed', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const nodesBefore = [...g.nodes.keys()].sort();
  const edgesBefore = g.edges.map((e) => `${e.from}|${e.to}|${e.type}`);
  addRuntimeFacts(g, [readFixture()]);
  const nodesAfter = new Set(g.nodes.keys());
  const missingNodes = nodesBefore.filter((id) => !nodesAfter.has(id));
  assert.deepEqual(missingNodes, [], `${missingNodes.length} node(s) disappeared`);
  const edgesAfter = g.edges.map((e) => `${e.from}|${e.to}|${e.type}`);
  const missingEdges = edgesBefore.filter((s, i) => s !== edgesAfter[i]);
  assert.deepEqual(missingEdges, [], `${missingEdges.length} edge(s) disappeared or moved`);
  // Growth is allowed, shrinking is not.
  assert.ok(g.nodes.size >= nodesBefore.length);
  assert.ok(g.edges.length >= edgesBefore.length);
});

test('HONESTY 3: every edge this lane ADDS is RUNTIME_ONLY, and no mode walks one', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const n = g.edges.length;
  addRuntimeFacts(g, [readFixture()]);
  const added = g.edges.slice(n);
  assert.equal(added.length, 1);
  assert.deepEqual(added.map((e) => e.grade), ['RUNTIME_ONLY']);
  // The aspect Spring calls around the controller: real at run time, in no
  // parse tree, and so in no static edge.
  assert.equal(added[0].from, ASPECT);
  assert.equal(added[0].to, CONTROLLER);
  assert.equal(added[0].type, 'MAY_CALL');
  assert.equal(added[0].evidence.rule, 'otel-runtime-only');

  // RUNTIME_ONLY is below the floor of every mode there is...
  for (const mode of Object.keys(GRADE_SETS)) {
    assert.equal(GRADE_SETS[mode].has('RUNTIME_ONLY'), false, `mode=${mode} would walk a trace`);
  }
  // ...so no walk from the aspect reaches the controller through it.
  for (const mode of ['strict', 'conservative', 'heuristic']) {
    const w = chainWalk(g, { start: ASPECT, direction: 'down', mode, maxDepth: 8 });
    assert.equal(w.services.some((r) => `symbol:${r.id}` === CONTROLLER), false,
      `mode=${mode} walked the RUNTIME_ONLY edge onto the controller`);
  }
});

test('HONESTY 4: a four-implementor candidate set keeps all four, and only the seen one is marked', () => {
  // A shape the corpus does not happen to have, built here so the rule is
  // tested where it bites hardest: many candidates, one observation.
  const g = new Graph();
  const caller = 'symbol:com.example.pay.CheckoutController#pay';
  const iface = 'symbol:com.example.pay.PaymentService#pay';
  const impls = ['Card', 'Bank', 'Voucher', 'Wallet']
    .map((k) => `symbol:com.example.pay.impl.${k}PaymentServiceImpl#pay`);
  g.addNode({ id: caller, file: 'CheckoutController.java' });
  g.addNode({ id: iface, file: 'PaymentService.java' });
  g.addEdge({ from: caller, to: iface, type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'field-receiver' } });
  for (const id of impls) {
    g.addNode({ id, file: `${id}.java` });
    g.addEdge({ from: iface, to: id, type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'interface-dispatch' } });
  }

  const trace = {
    file: 'pay.json',
    spans: 2,
    usableSpans: 2,
    unusable: 0,
    services: [],
    window: null,
    unreadable: null,
    observations: [{
      kind: 'dispatch',
      callerType: 'com.example.pay.CheckoutController', callerMethod: 'pay',
      calleeType: 'com.example.pay.impl.CardPaymentServiceImpl', calleeMethod: 'pay',
      direct: true, count: 7,
    }],
  };
  const stats = addRuntimeFacts(g, [trace]);
  assert.equal(stats.dispatchThroughInterface, 1);
  assert.equal(stats.edgesAdded, 0, 'the static graph already had the path, so nothing is invented');

  // All four are still candidates, all four still SOUND_SET.
  for (const id of impls) {
    const e = edgeOf(g, iface, id);
    assert.ok(e, `${id} was removed from the candidate set`);
    assert.equal(e.grade, 'SOUND_SET', `${id} changed grade`);
  }
  // ...and exactly one of them is marked observed.
  const marked = impls.filter((id) => edgeOf(g, iface, id).evidence.observed === true);
  assert.deepEqual(marked, [impls[0]]);
  assert.equal(edgeOf(g, iface, impls[0]).evidence.observedCount, 7);
  for (const id of impls.slice(1)) {
    assert.equal(edgeOf(g, iface, id).evidence.observed, undefined, `${id} was marked as seen and was not`);
    assert.equal(g.nodes.get(id).observed, undefined);
  }
});

// ---------------------------------------------------------------------------
// The narrower rules the join rests on
// ---------------------------------------------------------------------------

test('a hop only NESTED, not directly nested, is counted rather than drawn', () => {
  const g = new Graph();
  g.addNode({ id: 'symbol:com.example.A#run', file: 'A.java' });
  g.addNode({ id: 'symbol:com.example.C#run', file: 'C.java' });
  const obs = (direct) => ({
    file: 't.json', spans: 2, usableSpans: 2, unusable: 0, services: [], window: null, unreadable: null,
    observations: [{
      kind: 'dispatch',
      callerType: 'com.example.A', callerMethod: 'run',
      calleeType: 'com.example.C', calleeMethod: 'run',
      direct, count: 1,
    }],
  });
  const indirect = addRuntimeFacts(g, [obs(false)]);
  assert.equal(indirect.edgesAdded, 0);
  assert.equal(indirect.unmatched.dispatch, 1);
  assert.equal(g.edges.length, 0);

  const direct = addRuntimeFacts(g, [obs(true)]);
  assert.equal(direct.edgesAdded, 1);
  assert.equal(g.edges[0].grade, 'RUNTIME_ONLY');
});

test('a symbol this pack never read is never invented, only counted', () => {
  const g = new Graph();
  g.addNode({ id: 'symbol:com.example.A#run', file: 'A.java' });
  const stats = addRuntimeFacts(g, [{
    file: 't.json', spans: 2, usableSpans: 2, unusable: 0, services: [], window: null, unreadable: null,
    observations: [{
      kind: 'dispatch',
      callerType: 'com.example.A', callerMethod: 'run',
      calleeType: 'org.framework.Never', calleeMethod: 'seen',
      direct: true, count: 1,
    }],
  }]);
  assert.equal(stats.edgesAdded, 0);
  assert.equal(stats.unmatched.dispatch, 1);
  assert.equal(g.nodes.size, 1, 'a class the lanes never saw must not become a node');
  assert.deepEqual(stats.unmatchedKeys, [{ kind: 'dispatch', key: 'com.example.A#run -> org.framework.Never#seen', count: 1 }]);
});

test('SQL with no mapper method above it is recorded as unattached, never force-fit', () => {
  const g = new Graph();
  g.addNode({ id: 'statement:com.example.OrderMapper.selectById', statementType: 'select' });
  const rec = readOtelTrace(JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [] },
      scopeSpans: [{
        spans: [{
          spanId: '01', parentSpanId: '', name: 'SELECT orders',
          attributes: [{ key: 'db.statement', value: { stringValue: 'select * from orders where id = ?' } }],
        }],
      }],
    }],
  }), { file: 'bare.json' });
  assert.deepEqual(rec.observations, [{
    kind: 'statement', ownerType: null, method: null,
    sql: 'select * from orders where id = ?', tables: ['orders'], count: 1,
  }]);
  const stats = addRuntimeFacts(g, [rec]);
  assert.equal(stats.matched.statement, 0);
  assert.equal(stats.unmatched.statement, 1);
  assert.deepEqual(stats.unmatchedKeys, [{ kind: 'statement', key: '(no mapper method) orders', count: 1 }]);
  assert.equal(g.nodes.get('statement:com.example.OrderMapper.selectById').observed, undefined);
});

test('a table the RUN chose and the source did not is shown beside the static ones', () => {
  const g = new Graph();
  const stmt = 'statement:com.example.OrderMapper.selectById';
  g.addNode({ id: stmt, statementType: 'select' });
  g.addNode({ id: 'table:orders' });
  g.addEdge({ from: stmt, to: 'table:orders', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  const stats = addRuntimeFacts(g, [{
    file: 't.json', spans: 1, usableSpans: 1, unusable: 0, services: [], window: null, unreadable: null,
    observations: [{
      kind: 'statement', ownerType: 'com.example.OrderMapper', method: 'selectById',
      sql: 'select * from orders_2026 where id = ?', tables: ['orders_2026'], count: 3,
    }],
  }]);
  assert.equal(stats.tablesOnlyAtRunTime, 1);
  const n = g.nodes.get(stmt);
  assert.deepEqual(n.observedTables, ['orders_2026']);
  // The statically derived table is untouched: a finding to show, not a correction.
  assert.deepEqual(g.outEdges(stmt).filter((e) => e.type === 'EXECUTES').map((e) => e.to), ['table:orders']);
});

test('two traces of the same chain are one mark with both counts on it', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  addRuntimeFacts(g, [
    readOtelTrace(TRACE, { file: 'monday.json' }),
    readOtelTrace(TRACE, { file: 'tuesday.json' }),
  ]);
  const e = edgeOf(g, IFACE, IMPL);
  assert.equal(e.evidence.observedCount, 2);
  assert.deepEqual(e.evidence.observedBy, ['monday.json', 'tuesday.json']);
  assert.equal(e.grade, 'SOUND_SET');
});

// ---------------------------------------------------------------------------
// What the answers say
// ---------------------------------------------------------------------------

test('a chain row and the step that reached it say `observed`', { skip: skipUnlessMall() }, () => {
  const g = mallGraph();
  const before = chainWalk(g, { start: CONTROLLER, direction: 'down', mode: 'conservative', maxDepth: 6 });
  assert.equal(before.services.some((r) => r.observed === true), false, 'a pack with no trace marks nothing');

  addRuntimeFacts(g, [readFixture()]);
  const w = chainWalk(g, { start: CONTROLLER, direction: 'down', mode: 'conservative', maxDepth: 6 });

  const seen = w.services.find((r) => `symbol:${r.id}` === IMPL);
  assert.ok(seen, 'the implementation the trace saw is not on the chain');
  assert.equal(seen.observed, true);
  assert.equal(seen.grade, 'SOUND_SET', 'the row grade is the weakest link, and a mark is not a grade');
  assert.equal(seen.link.observed, true);
  assert.equal(seen.link.observedCount, 1);
  assert.equal(seen.link.grade, 'SOUND_SET');

  // The sibling the trace never visited is still a row, and says nothing.
  const unseen = w.services.find((r) => `symbol:${r.id}` === SIBLING_IMPL);
  assert.ok(unseen, 'the unobserved candidate was dropped from the chain');
  assert.equal(unseen.observed, undefined);
  assert.equal(unseen.link.observed, undefined);
  assert.equal(unseen.grade, 'SOUND_SET');

  const stmt = w.statements.find((r) => `statement:${r.id}` === STATEMENT);
  assert.equal(stmt.observed, true);
  assert.deepEqual(stmt.observedTables, ['pms_brand']);
});
