// java_route_function_review3.test.mjs — functional-route handlers and operation
// ids a third review reproduced as wrong (RM67 review 3, R6 and R7).
//
// The Java inputs are the reviewer's own (review3-repro/r3a-java, fr-variants.mjs
// and dflt-check.mjs), copied verbatim:
//
//   Default   a field of interface type whose default method C inherits and D
//             overrides: the set named D#h and left out Svc#h, which C runs
//   Default2  `impl::h2` where Impl inherits h2 from an interface's default: the
//             edge went to Impl#h2, a method nobody declares, and the default's
//             body (h2 -> helper) was cut off from the route
//   Anon      a field initialised with an anonymous subclass that overrides h:
//             the override was not in the set
//   OpCond    `operationId("first"); if (legacy) operationId("second");` was
//             read as "first", which the condition may replace

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';
import { Graph } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';
import { readRouteFunctions } from '../src/core/rules/kinds/java_route_function.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';

const H = 'R h(Q q){return null;}';
/** The reviewer's inputs, byte for byte. */
const SOURCES = {
  'Default.java': 'package p; interface Svc { default R h(Q q){return null;} } class C implements Svc {} class D implements Svc { public R h(Q q){return null;} } class Default { Svc svc; @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/dflt", svc::h).build(); } }',
  'Default2.java': 'package p; interface Mix { default R h2(Q q){ return helper(); } R helper(); } class Impl implements Mix { public R helper(){return null;} } class Default2 { Impl impl; @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/dflt2", impl::h2).build(); } }',
  'Default3.java': 'package p; interface Mix3 { default R h3(Q q){return null;} } class Default3 implements Mix3 { @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/dflt3", this::h3).build(); } }',
  'Anon.java': 'package p; class Hd { public R h(Q q){return null;} } class Anon { Hd hd = new Hd(){ public R h(Q q){return null;} }; @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/anon", hd::h).build(); } }',
  'OpCond.java': `package p; class OpCond { boolean legacy; RouterFunction<R> routes(){ return SpringdocRouteBuilder.route().GET("/y", this::h, ops -> { ops.operationId("first"); if (legacy) { ops.operationId("second"); } }).build(); } ${H} }`,
  'IExt.java': 'package p; interface I1 { R h(Q q); } interface I2 extends I1 {} class I2Impl implements I2 { public R h(Q q){return null;} } class IExt { I1 svc; @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/iext", svc::h).build(); } }',
};

/** The reviewer's document: each operation id at a path of its own. */
const DOCUMENTS = [{ path: 'openapi.json', paths: [
  { method: 'GET', path: '/api/y', operationId: 'first' },
  { method: 'GET', path: '/api2/y', operationId: 'second' },
] }];

let cached;
function facts(t) {
  if (cached !== undefined) return cached;
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-routefn-review3-'));
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(dir, name), body);
  try { cached = runJavaLane(jdk, dir, [dir], { quiet: true }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return cached;
}

function graphOf(f) {
  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: DOCUMENTS });
  const handles = (ep) => g.edges.filter((e) => e.type === 'HANDLES' && e.from === `endpoint:${ep}`).map((e) => [e.to, e.grade]).sort();
  return { g, stats, handles };
}

test('functional_route_handler_sound_set_includes_interface_default', (t) => {
  const f = facts(t);
  if (!f) return;
  const { handles } = graphOf(f);
  assert.deepEqual(handles('GET /dflt'), [['symbol:p.D#h', 'SOUND_SET'], ['symbol:p.Svc#h', 'SOUND_SET']],
    'C inherits the default, so an object of type Svc may run Svc#h as well as D\'s override');
  assert.deepEqual(handles('GET /dflt3'), [['symbol:p.Mix3#h3', 'SOUND_SET']], 'this::h3 runs the default the class inherits');
  assert.deepEqual(handles('GET /iext'), [['symbol:p.I2Impl#h', 'HEURISTIC']],
    'an abstract interface method has no body to run: only the implementor, through the sub-interface; I1 has one abstract method, so a lambda may be the object too (RM67 review 4)');
});

test('functional_route_handler_through_class_reaches_the_interface_default_it_inherits', (t) => {
  const f = facts(t);
  if (!f) return;
  const { g, handles } = graphOf(f);
  assert.deepEqual(handles('GET /dflt2'), [['symbol:p.Mix#h2', 'SOUND_SET']], 'Impl declares no h2: the body that runs is Mix\'s default');
  assert.ok(!g.nodes.has('symbol:p.Impl#h2'), 'no node for a method nobody declares');
  const fromDefault = g.edges.filter((e) => e.from === 'symbol:p.Mix#h2' && e.type === 'MAY_CALL').map((e) => e.to);
  assert.ok(fromDefault.includes('symbol:p.Mix#helper'), `the route reaches the default's own call: ${JSON.stringify(fromDefault)}`);
});

test('functional_route_handler_sound_set_includes_anonymous_subclass', (t) => {
  const f = facts(t);
  if (!f) return;
  const { g, handles } = graphOf(f);
  const set = handles('GET /anon');
  assert.deepEqual(set.map(([to]) => to), ['symbol:p.Anon$anonymous1#h', 'symbol:p.Hd#h'],
    'the field may hold the anonymous subclass the source writes, whose h overrides Hd#h');
  assert.ok(set.every(([, grade]) => grade === 'SOUND_SET'));
  const anon = g.nodes.get('symbol:p.Anon$anonymous1#h');
  assert.equal(anon.file, 'Anon.java');
  assert.equal(anon.line, 1);
});

test('functional_route_conditional_operation_id_is_unknown', (t) => {
  const f = facts(t);
  if (!f) return;
  const fn = readRouteFunctions(f, builtinRegistry().ofKind('java.route-function')).find((m) => m.owner === 'p.OpCond');
  assert.equal(fn.routes[0].operationId, null, 'an if may call operationId again after "first", so the id is not known');
  const { g } = graphOf(f);
  assert.ok(![...g.nodes.keys()].some((id) => id === 'endpoint:GET /api/y' && g.edges.some((e) => e.from === id && e.type === 'HANDLES')),
    'not placed at the operation the first call names');
});
