// java_routes_review4.test.mjs — mapping annotations and functional-route handlers a
// fourth review reproduced as wrong (RM67 review 4, J-2, J-4, J-7 to J-12).
//
// Each input is the reviewer's own (review4-repro/r4-f3: review4-java.test.mjs,
// const-path.mjs, map-variants.mjs, fr-more.mjs, op-more.mjs) or the shape the
// real project writes (ruoyi-vue-pro's `RpcConstants.RPC_API_PREFIX + "/..."`,
// eladmin's `@AnonymousPostMapping`):
//
//   J-2   a mapping path written as a constant or a concatenation was read as
//         "no path", so the route landed on the class path or `/`, EXACT
//   J-8   a class-level `method = POST` was ignored
//   J-10  `method = {GET, VERBS}` made "VERBS" an HTTP method
//   J-9   a composed mapping annotation of the tree served nothing, silently
//   J-7   two handlers of one route split by `params` were both EXACT
//   J-4   a functional route's handler set left out a local class and did not
//         say that a lambda may implement the interface
//   J-12  a superclass outside the tree was not a candidate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';
import { Graph } from '../src/core/graph.mjs';
import { addJavaFacts } from '../src/adapters/java_bridge.mjs';

const W = 'import org.springframework.web.bind.annotation.*;';

/** Every tree the tests read, built once each: {name: {file: source}}. */
const TREES = {
  // The reviewer's review4-java.test.mjs inputs, and the shapes around them.
  constants: {
    'p/Consts.java': 'package p; public class Consts { public static final String C1="/c1"; public static final String P="/rpc"; public static final String JOINED = P + "/joined"; }',
    'p/B.java': `package p; ${W} @RestController @RequestMapping("/b") class B { @GetMapping(Consts.C1) public String c1(){return null;} @GetMapping({"/lit", Consts.C1}) public String c2(){return null;} static final String LOCAL="/local"; @GetMapping(LOCAL) public String c3(){return null;} @GetMapping("/cat" + "/dog") public String c4(){return null;} @GetMapping(Consts.JOINED) public String c5(){return null;} }`,
    'p/L.java': `package p; ${W} @RestController class L { @PostMapping(Consts.P + "/auth") public String a(){return null;} }`,
    'p/K.java': `package p; ${W} @RestController @RequestMapping(Consts.C1) class K { @GetMapping("/x") public String x(){return null;} }`,
    // ruoyi-vue-pro's shape: a constant of a class in another package, imported.
    'q/common/RpcConstants.java': 'package q.common; public class RpcConstants { public static final String RPC_API_PREFIX = "/rpc-api"; }',
    'q/iot/IoTDeviceApiImpl.java': `package q.iot; import q.common.RpcConstants; ${W} @RestController public class IoTDeviceApiImpl { @PostMapping(RpcConstants.RPC_API_PREFIX + "/iot/device/auth") public String auth(){return null;} }`,
    // An interface's field is a constant with no modifier written.
    'q/iot/Api.java': 'package q.iot; public interface Api { String PREFIX = "/api"; }',
    'q/iot/ApiUser.java': `package q.iot; ${W} @RestController @RequestMapping(Api.PREFIX + "/user") public class ApiUser { @GetMapping("/get") public String get(){return null;} }`,
    // Nothing in the tree says what these are.
    'q/iot/Unread.java': `package q.iot; import org.lib.Lib; ${W} @RestController @RequestMapping("/u") public class Unread { @GetMapping(Lib.P + "/x") public String x(){return null;} @GetMapping({"/ok", Lib.Q}) public String y(){return null;} @GetMapping(Api.MISSING) public String z(){return null;} }`,
  },
  // map-variants.mjs, C: a class-level method, and a name that is no HTTP method.
  methods: {
    'p/C.java': `package p; ${W} import static org.springframework.web.bind.annotation.RequestMethod.*; @RestController @RequestMapping(value="/cm", method=RequestMethod.POST) class C { @RequestMapping("/any") public String any(){return null;} @GetMapping("/get") public String g(){return null;} @RequestMapping(value="/st", method={GET, PUT}) public String st(){return null;} }`,
    'p/V.java': `package p; ${W} @RestController @RequestMapping("/v") class V { @RequestMapping(value="/unk", method={RequestMethod.GET, VERBS}) public String unk(){return null;} @RequestMapping(value="/only", method=VERBS) public String only(){return null;} }`,
  },
  // eladmin's shape, and map-variants.mjs E: a composed mapping annotation of the tree.
  composed: {
    'a/rest/AnonymousPostMapping.java': 'package a.rest; import java.lang.annotation.*; import org.springframework.core.annotation.AliasFor; import org.springframework.web.bind.annotation.RequestMapping; import org.springframework.web.bind.annotation.RequestMethod; @Target(ElementType.METHOD) @Retention(RetentionPolicy.RUNTIME) @RequestMapping(method = RequestMethod.POST) public @interface AnonymousPostMapping { @AliasFor(annotation = RequestMapping.class) String name() default ""; @AliasFor(annotation = RequestMapping.class) String[] value() default {}; @AliasFor(annotation = RequestMapping.class) String[] path() default {}; }',
    'a/rest/AnonymousGetMapping.java': 'package a.rest; import java.lang.annotation.*; import org.springframework.core.annotation.AliasFor; import org.springframework.web.bind.annotation.*; @Retention(RetentionPolicy.RUNTIME) @GetMapping public @interface AnonymousGetMapping { @AliasFor(annotation = GetMapping.class, attribute = "path") String[] value() default {}; }',
    'a/rest/MyGet.java': 'package a.rest; import java.lang.annotation.*; import org.springframework.web.bind.annotation.*; @Retention(RetentionPolicy.RUNTIME) @RequestMapping(method=RequestMethod.GET) public @interface MyGet { String[] value() default {}; }',
    'a/web/AuthController.java': `package a.web; import a.rest.AnonymousPostMapping; import a.rest.AnonymousGetMapping; import a.rest.MyGet; import x.lib.ApiIgnore; import x.lib.Weird; ${W} @RestController @RequestMapping("/auth") public class AuthController { @ApiIgnore @AnonymousPostMapping("/login") public String login(){return null;} @Weird public String weird(){return null;} @AnonymousGetMapping(value = "/code") public String code(){return null;} @MyGet("/meta") public String meta(){return null;} @AnonymousPostMapping public String root(){return null;} }`,
  },
  // map-variants.mjs, the two `params` handlers; and mall's two modules declaring one route.
  params: {
    'p/B.java': `package p; ${W} @RestController @RequestMapping("/b") class B { @GetMapping(value="/params", params="a=1") public String p1(){return null;} @GetMapping(value="/params", params="b=1") public String p2(){return null;} }`,
    'm/admin/OrderController.java': `package m.admin; ${W} @RestController @RequestMapping("/order") public class OrderController { @GetMapping("/list") public String list(){return null;} }`,
    'm/portal/PortalOrderController.java': `package m.portal; ${W} @RestController @RequestMapping("/order") public class PortalOrderController { @GetMapping("/list") public String list(){return null;} }`,
  },
  // The reviewer's review4-java.test.mjs and fr-more.mjs functional-route inputs.
  functional: {
    'p/Svc.java': 'package p; public interface Svc { R h(Q q); }',
    'p/Impl.java': 'package p; public class Impl implements Svc { public R h(Q q){return null;} }',
    'p/LocalMaker.java': 'package p; class LocalMaker { @Bean Svc make(){ class Local implements Svc { public R h(Q q){ return null; } } return new Local(); } }',
    'p/Cfg.java': 'package p; class Cfg { @Bean Svc lam(){ return q -> null; } }',
    'p/Two.java': 'package p; public interface Two { R h(Q q); R other(Q q); } class TwoImpl implements Two { public R h(Q q){return null;} public R other(Q q){return null;} }',
    'p/Dflt.java': 'package p; interface Dflt { default R h(Q q){return null;} } class LibBased extends org.lib.LibBase implements Dflt {}',
    'p/Routes.java': 'package p; class Routes { Svc svc; Two two; LibBased lb; @Bean RouterFunction<R> r(){ return RouterFunctions.route().GET("/svc", svc::h).GET("/two", two::h).GET("/lb", lb::h).build(); } }',
  },
};

const OPENAPI = {};

const built = new Map();
function run(t, name) {
  if (built.has(name)) return built.get(name);
  const jdk = findJdk();
  if (!jdk) { t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH, see docs/setup/java-lane.md'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cascade-review4-${name}-`));
  let facts;
  try {
    for (const [file, body] of Object.entries(TREES[name])) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    }
    facts = runJavaLane(jdk, dir, [dir], { quiet: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const g = new Graph();
  const stats = addJavaFacts(g, facts, { openapiDocuments: OPENAPI[name] ?? [] });
  const handles = g.edges.filter((e) => e.type === 'HANDLES');
  const out = { facts, g, stats, handles, routesOf: (member) => handles.filter((e) => e.to === `symbol:${member}`).map((e) => [e.from.replace('endpoint:', ''), e.grade]).sort() };
  built.set(name, out);
  return out;
}

// ---------------------------------------------------------------------------
// J-2: a path written as a constant
// ---------------------------------------------------------------------------

test('mapping_path_from_constant_is_not_the_class_path', (t) => {
  const r = run(t, 'constants');
  if (!r) return;
  const wrong = r.handles.filter((e) => e.grade === 'EXACT' && ['endpoint:GET /b', 'endpoint:POST /', 'endpoint:GET /x'].includes(e.from));
  assert.deepEqual(wrong.map((e) => e.from), [], 'a path the worker could not read is served at the class path (or at /) as EXACT');
  assert.deepEqual(r.routesOf('p.B#c1'), [['GET /b/c1', 'EXACT']], 'the constant of another class of the tree is read');
  assert.deepEqual(r.routesOf('p.L#a'), [['POST /rpc/auth', 'EXACT']], 'a constant and a literal, joined');
  assert.deepEqual(r.routesOf('p.K#x'), [['GET /c1/x', 'EXACT']], 'a class-level path written as a constant');
});

test('mapping_array_with_constant_element_is_said', (t) => {
  const r = run(t, 'constants');
  if (!r) return;
  assert.deepEqual(r.routesOf('p.B#c2'), [['GET /b/c1', 'EXACT'], ['GET /b/lit', 'EXACT']], 'every element of the array is a route');
});

test('mapping_path_the_file_itself_states_is_read', (t) => {
  const r = run(t, 'constants');
  if (!r) return;
  assert.deepEqual(r.routesOf('p.B#c3'), [['GET /b/local', 'EXACT']], 'a constant of the class itself');
  assert.deepEqual(r.routesOf('p.B#c4'), [['GET /b/cat/dog', 'EXACT']], 'two literals joined');
  assert.deepEqual(r.routesOf('p.B#c5'), [['GET /b/rpc/joined', 'EXACT']], 'a constant another constant of its class builds');
  assert.deepEqual(r.routesOf('q.iot.IoTDeviceApiImpl#auth'), [['POST /rpc-api/iot/device/auth', 'EXACT']],
    'ruoyi-vue-pro: an imported class\'s constant, then a literal');
  assert.deepEqual(r.routesOf('q.iot.ApiUser#get'), [['GET /api/user/get', 'EXACT']], 'an interface field is a constant');
});

test('mapping_path_the_tree_cannot_read_is_said_and_placed_nowhere', (t) => {
  const r = run(t, 'constants');
  if (!r) return;
  assert.deepEqual(r.routesOf('q.iot.Unread#x'), [], 'a constant of a class outside the tree: no address is stated');
  assert.deepEqual(r.routesOf('q.iot.Unread#y'), [['GET /u/ok', 'EXACT']], 'the literal element stands, the unread one is not placed');
  assert.deepEqual(r.routesOf('q.iot.Unread#z'), [], 'a constant the class of the tree does not declare');
  const m = r.stats.mappingAnnotations;
  assert.equal(m.pathsUnread, 3);
  const said = m.samples.filter((s) => s.code === 'path-not-literal').map((s) => `${s.handler} ${s.text}`).sort();
  assert.deepEqual(said, ['q.iot.Unread#x Lib.P + "/x"', 'q.iot.Unread#y Lib.Q', 'q.iot.Unread#z Api.MISSING']);
  assert.ok(m.pathsFromConstants >= 7, `${m.pathsFromConstants} paths read through a constant`);
});

// ---------------------------------------------------------------------------
// J-8, J-10: the methods a mapping names
// ---------------------------------------------------------------------------

test('class_level_request_method_combines_with_the_method_level', (t) => {
  const r = run(t, 'methods');
  if (!r) return;
  assert.deepEqual(r.routesOf('p.C#any'), [['POST /cm/any', 'EXACT']], 'no method below a class-level POST is POST');
  assert.deepEqual(r.routesOf('p.C#g'), [['GET /cm/get', 'EXACT'], ['POST /cm/get', 'EXACT']], 'Spring combines the two by union');
  assert.deepEqual(r.routesOf('p.C#st'), [['GET /cm/st', 'EXACT'], ['POST /cm/st', 'EXACT'], ['PUT /cm/st', 'EXACT']]);
});

test('a_name_that_is_no_http_method_is_not_a_method', (t) => {
  const r = run(t, 'methods');
  if (!r) return;
  assert.ok(!r.handles.some((e) => /VERBS/.test(e.from)), 'VERBS is not an HTTP method');
  assert.deepEqual(r.routesOf('p.V#unk'), [['ANY /v/unk', 'HEURISTIC'], ['GET /v/unk', 'EXACT']],
    'GET is stated; the method VERBS stands for is not, so the route answers some method this lane did not read');
  assert.deepEqual(r.routesOf('p.V#only'), [['ANY /v/only', 'HEURISTIC']]);
  const e = r.handles.find((x) => x.from === 'endpoint:ANY /v/only');
  assert.deepEqual(e.evidence.methodUnread, ['VERBS']);
  assert.equal(r.stats.mappingAnnotations.methodsUnread, 2);
});

// ---------------------------------------------------------------------------
// J-9: a composed mapping annotation of the tree
// ---------------------------------------------------------------------------

test('composed_mapping_annotation_serves_its_route_or_is_said', (t) => {
  const r = run(t, 'composed');
  if (!r) return;
  assert.deepEqual(r.routesOf('a.web.AuthController#login'), [['POST /auth/login', 'EXACT']], 'eladmin: @AnonymousPostMapping("/login")');
  assert.deepEqual(r.routesOf('a.web.AuthController#code'), [['GET /auth/code', 'EXACT']], 'meta-annotated with @GetMapping, value aliased to path');
  assert.deepEqual(r.routesOf('a.web.AuthController#root'), [['POST /auth', 'EXACT']], 'no path given: the class path');
  // `value` without @AliasFor is not RequestMapping's value: Spring would serve
  // the class path, so the route is not placed at /auth/meta, and it is said.
  assert.deepEqual(r.routesOf('a.web.AuthController#meta'), []);
  const said = r.stats.mappingAnnotations.samples.filter((s) => s.handler === 'a.web.AuthController#meta');
  assert.deepEqual(said.map((s) => s.code), ['composed-mapping-attribute-not-aliased']);
  assert.equal(r.stats.mappingAnnotations.composedRoutes, 3);
  // An annotation this run did not read is said only on a method no mapping serves: it may be a composed one.
  assert.equal(r.stats.mappingAnnotations.composedNotRead, 1);
  assert.deepEqual(r.stats.mappingAnnotations.samples.filter((x) => x.code === 'mapping-annotation-not-read').map((x) => `${x.handler} ${x.text}`), ['a.web.AuthController#weird @Weird']);
});

// ---------------------------------------------------------------------------
// J-7: one route, handlers split by a request condition
// ---------------------------------------------------------------------------

test('handlers_split_by_params_are_a_candidate_set', (t) => {
  const r = run(t, 'params');
  if (!r) return;
  assert.deepEqual(r.handles.filter((e) => e.from === 'endpoint:GET /b/params').map((e) => [e.to, e.grade]).sort(),
    [['symbol:p.B#p1', 'SOUND_SET'], ['symbol:p.B#p2', 'SOUND_SET']], 'one of the two runs per request');
  const ev = r.g.edges.find((e) => e.from === 'endpoint:GET /b/params').evidence;
  assert.equal(ev.rule, 'route-condition-split');
  assert.deepEqual(ev.conditions, ['params']);
  assert.deepEqual(r.handles.filter((e) => e.from === 'endpoint:GET /order/list').map((e) => e.grade), ['EXACT', 'EXACT'],
    'two modules declaring one route with no condition keep the rule they had');
});

// ---------------------------------------------------------------------------
// J-4, J-12: the methods a functional route's handler may run
// ---------------------------------------------------------------------------

test('functional_route_handler_set_includes_local_class_and_lambda_bean', (t) => {
  const r = run(t, 'functional');
  if (!r) return;
  const set = r.handles.filter((e) => e.from === 'endpoint:GET /svc');
  assert.deepEqual(set.map((e) => e.to).sort(), ['symbol:p.Impl#h', 'symbol:p.LocalMaker$1Local#h'], 'the class a method body declares implements Svc too');
  assert.ok(set.every((e) => e.grade === 'HEURISTIC'), 'Svc has one abstract method, so a lambda (Cfg#lam returns one) may be what the field holds');
  assert.equal(set[0].evidence.openSet.code, 'functional-interface');
  const local = r.g.nodes.get('symbol:p.LocalMaker$1Local#h');
  assert.equal(local.file, 'p/LocalMaker.java');
});

test('functional_route_handler_set_of_a_type_no_lambda_can_implement_stays_a_candidate_set', (t) => {
  const r = run(t, 'functional');
  if (!r) return;
  assert.deepEqual(r.handles.filter((e) => e.from === 'endpoint:GET /two').map((e) => [e.to, e.grade]),
    [['symbol:p.TwoImpl#h', 'SOUND_SET']], 'two abstract methods: no lambda implements Two, and every implementer is in the tree');
});

test('functional_route_handler_under_a_superclass_outside_the_tree_names_it', (t) => {
  const r = run(t, 'functional');
  if (!r) return;
  const set = r.handles.filter((e) => e.from === 'endpoint:GET /lb');
  assert.deepEqual(set.map((e) => e.to).sort(), ['symbol:org.lib.LibBase#h', 'symbol:p.Dflt#h'],
    'a class method of the superclass wins over the interface default, and this run did not read it');
  assert.ok(set.every((e) => e.grade === 'HEURISTIC'));
  assert.equal(set[0].evidence.openSet.code, 'superclass-not-read');
});
