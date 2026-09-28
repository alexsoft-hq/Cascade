// java_route_function_review.test.mjs — the functional-route defects a second
// review reproduced (RM67 review 2, items 7 to 10 and one design objection).
//
// The four Java inputs are the reviewer's own, copied verbatim, so each test
// fails on the same bytes that showed the defect:
//
//   Reassign   a prefix local assigned twice was read at its FIRST value, EXACT
//   Override   a handler through a declared class type named only that class's
//              method, never the override the object may really run
//   Operation  `operationId("old").operationId("actual")` was read as "old"
//   Alias      a builder mutated through a second name lost the route, silently
//
// and the design objection: a route placed only because an OpenAPI document
// declares its operation id, verb and path suffix has no mount the source
// states, so its HANDLES is HEURISTIC, not SOUND_SET.

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

/** The reviewer's inputs, byte for byte (review 2a, /tmp/cascade-java-review-IzfGcm). */
const SOURCES = {
  'Alias.java': 'package p; class Alias { @Bean RouterFunction<R> routes(){ var b=RouterFunctions.route(); var alias=b; alias.GET("/x", this::h); return b.build(); } R h(Q q){return null;} }',
  'Reassign.java': 'package p; class Reassign { @Bean RouterFunction<R> routes(){ String prefix="/old"; prefix="/actual"; return RouterFunctions.route().path(prefix, b->b.GET("/x", this::h)).build(); } R h(Q q){return null;} }',
  'Override.java': 'package p; class Base { public R h(Q q){return null;} } class Derived extends Base { public R h(Q q){return null;} } class Override { Base b = new Derived(); @Bean RouterFunction<R> routes(){return RouterFunctions.route().GET("/override", b::h).build();}}',
  'Operation.java': 'package p; class Operation { RouterFunction<R> routes(){return SpringdocRouteBuilder.route().GET("/x", this::h, ops -> ops.operationId("old").operationId("actual")).build();} R h(Q q){return null;} }',
};

/** The document the reviewer handed the bridge: each operation id at its own path. */
const DOCUMENTS = [{ path: 'openapi.json', paths: [
  { method: 'GET', path: '/wrong/x', operationId: 'old' },
  { method: 'GET', path: '/actual/x', operationId: 'actual' },
] }];

let cached;
function facts(t) {
  if (cached !== undefined) return cached;
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-routefn-review-'));
  for (const [name, body] of Object.entries(SOURCES)) fs.writeFileSync(path.join(dir, name), body);
  try { cached = runJavaLane(jdk, dir, [dir], { quiet: true }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return cached;
}

function graphOf(f) {
  const g = new Graph();
  const stats = addJavaFacts(g, f, { openapiDocuments: DOCUMENTS });
  return { g, stats, handles: g.edges.filter((e) => e.type === 'HANDLES') };
}

test('functional_route_reassigned_prefix_is_not_stale_exact', (t) => {
  const f = facts(t);
  if (!f) return;
  const { handles } = graphOf(f);
  const mine = handles.filter((e) => e.to === 'symbol:p.Reassign#h');
  assert.ok(!mine.some((e) => e.from === 'endpoint:GET /old/x'), `the prefix was read at a value it no longer holds: ${JSON.stringify(mine)}`);
  assert.deepEqual(mine.map((e) => [e.from, e.grade]), [['endpoint:GET /actual/x', 'EXACT']],
    'the local holds "/actual" where the nest reads it, and the file states both the path and the method');
});

test('functional_route_handler_sound_set_includes_overrides', (t) => {
  const f = facts(t);
  if (!f) return;
  const { handles } = graphOf(f);
  const set = handles.filter((e) => e.from === 'endpoint:GET /override');
  assert.deepEqual(set.map((e) => [e.to, e.grade]).sort(), [['symbol:p.Base#h', 'SOUND_SET'], ['symbol:p.Derived#h', 'SOUND_SET']],
    'an object of declared type Base runs Base#h or any override of it; the set holds every one');
});

test('functional_route_operation_id_last_assignment_wins', (t) => {
  const f = facts(t);
  if (!f) return;
  const [fn] = readRouteFunctions(f.filter((r) => r.owner === 'p.Operation' || r.kind !== 'routeFunction'), builtinRegistry().ofKind('java.route-function'))
    .filter((m) => m.owner === 'p.Operation');
  assert.equal(fn.routes[0].operationId, 'actual', 'the builder keeps the operation id it was given last');
  const { handles } = graphOf(f);
  const mine = handles.filter((e) => e.to === 'symbol:p.Operation#h');
  assert.ok(!mine.some((e) => e.from === 'endpoint:GET /wrong/x'), `placed at the operation the first call named: ${JSON.stringify(mine)}`);
  assert.deepEqual(mine.map((e) => e.from), ['endpoint:GET /actual/x']);
});

test('functional_route_builder_alias_preserves_mutation', (t) => {
  const f = facts(t);
  if (!f) return;
  const [fn] = readRouteFunctions(f, builtinRegistry().ofKind('java.route-function')).filter((m) => m.owner === 'p.Alias');
  const said = fn.routes.length > 0 || fn.notes.length > 0;
  assert.ok(said, 'a route added through a second name is kept, or the reader says it did not read it; never nothing');
  const { handles } = graphOf(f);
  assert.deepEqual(handles.filter((e) => e.to === 'symbol:p.Alias#h').map((e) => [e.from, e.grade]), [['endpoint:GET /x', 'EXACT']],
    'the alias and the builder are one object, so what one adds the other builds');
});

test('functional_route_placed_by_operation_id_alone_is_heuristic', (t) => {
  const f = facts(t);
  if (!f) return;
  const { handles, stats } = graphOf(f);
  const [edge] = handles.filter((e) => e.to === 'symbol:p.Operation#h');
  assert.equal(edge.evidence.mount, 'operation-id');
  assert.equal(edge.grade, 'HEURISTIC', 'no line of the source mounts this route: the document\'s operation id, verb and path suffix are a convention matched, not a fact');
  assert.equal(stats.functionalRoutes.handles.HEURISTIC, 1);
});

/** The edges of the four fixes, one class each. */
const EDGES = {
  'Branch.java': 'package p; class Branch { boolean c; @Bean RouterFunction<R> routes(){ String p="/a"; if (c) { p="/b"; } return RouterFunctions.route().path(p, b->b.GET("/x", this::h)).build(); } R h(Q q){return null;} }',
  'Top.java': 'package p; class Top { @Bean RouterFunction<R> routes(){ return RouterFunctions.route().GET("/top", this::h).build(); } R h(Q q){return null;} } class Sub extends Top { R h(Q q){return null;} }',
  'Named.java': 'package p; class Named { String dyn; RouterFunction<R> routes(){ return SpringdocRouteBuilder.route().GET("/n", this::h, ops -> ops.operationId("first").operationId(dyn)).build(); } R h(Q q){return null;} }',
  'Snapshot.java': 'package p; class Snapshot { @Bean RouterFunction<R> routes(){ var b=RouterFunctions.route(); b.GET("/early", this::h); var fn=b.build(); b.GET("/late", this::h); return fn; } R h(Q q){return null;} }',
};

let edgeFacts;
function factsOfEdges(t) {
  if (edgeFacts !== undefined) return edgeFacts;
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-routefn-edges-'));
  for (const [name, body] of Object.entries(EDGES)) fs.writeFileSync(path.join(dir, name), body);
  try { edgeFacts = runJavaLane(jdk, dir, [dir], { quiet: true }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return edgeFacts;
}

const readOf = (f, owner) => readRouteFunctions(f, builtinRegistry().ofKind('java.route-function')).find((m) => m.owner === owner);

test('a prefix assigned in a branch is not read at the value it held before: the route is said, not placed', (t) => {
  const f = factsOfEdges(t);
  if (!f) return;
  const rec = f.find((r) => r.kind === 'routeFunction' && r.owner === 'p.Branch');
  assert.deepEqual(rec.body.find((s) => s.s === 'other').a, ['p'], 'javafacts/18 names the local the if assigns');
  const g = new Graph();
  const stats = addJavaFacts(g, f, {}).functionalRoutes;
  assert.ok(![...g.nodes.keys()].some((id) => id.includes('/a/x') || id.includes('/b/x')));
  assert.ok(stats.samples.some((s) => s.function === 'p.Branch#routes' && s.code === 'path-not-literal'), JSON.stringify(stats.samples));
});

test('this::h is EXACT only when nothing in the tree overrides h; with an override it is every method the object may run', (t) => {
  const f = factsOfEdges(t);
  if (!f) return;
  const g = new Graph();
  addJavaFacts(g, f, {});
  const of = (ep) => g.edges.filter((e) => e.type === 'HANDLES' && e.from === ep).map((e) => [e.to, e.grade]).sort();
  assert.deepEqual(of('endpoint:GET /top'), [['symbol:p.Sub#h', 'SOUND_SET'], ['symbol:p.Top#h', 'SOUND_SET']]);
  assert.deepEqual(of('endpoint:GET /early'), [['symbol:p.Snapshot#h', 'EXACT']]);
});

test('an operation id whose last call is not a literal is not known, never the one an earlier call named', (t) => {
  const f = factsOfEdges(t);
  if (!f) return;
  assert.equal(readOf(f, 'p.Named').routes[0].operationId, null);
});

test('build() is what the builder holds then: a route added to the builder after it is not in the router function returned', (t) => {
  const f = factsOfEdges(t);
  if (!f) return;
  assert.deepEqual(readOf(f, 'p.Snapshot').routes.map((r) => r.parts), [['/early']]);
});
