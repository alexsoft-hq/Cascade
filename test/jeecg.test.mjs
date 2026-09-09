// jeecg.test.mjs — the route classifier and the two dropped call rules against a
// REAL microservice-shaped project (SPEC §14, §15; round RM14).
//
// jeecgboot/JeecgBoot is the fixture this round exists for. It is the first one
// in this suite that is not a single deployable: it ships a `local` flavour and
// a `cloud` flavour of the same API, the cloud one as @FeignClient interfaces
// whose methods carry the SAME mapping annotations as the controllers that
// answer them. Before RM14 the engine read those annotations as a second
// DECLARATION of the route, so 107 routes came back with two handlers — one of
// which was the CALLER.
//
// EVERY expectation below was counted BY HAND out of the fixture's source, and
// each one names the file and the grep that produced it. A golden derived from
// this engine's own output would only test that the engine agrees with itself
// (§14), which is exactly the failure this round found in the previous numbers.
//
// The checkout is CLONED to a temp directory and analysed there: the fixture is
// read-only, `cascade init` writes a `.cascade/` into the tree it is given, and
// a fresh clone has no calibration baseline to trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { FLOW_EDGE_TYPES } from '../src/core/graph.mjs';
import { column_impact } from '../src/mcp/tools.mjs';
import { buildOverview } from '../src/core/overview.mjs';
import { handlersOf, multiHandlerRoutes } from '../src/core/walks.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

/**
 * The pinned commit. Every count below describes the SOURCE at this commit, so a
 * different one is a different project and the test refuses it rather than
 * scoring the engine against a fixture that moved underneath it.
 */
const PINNED_COMMIT = '74364054449efd5852e46d0c10325a1d38c1006a';

/** Where the orchestrator/CI puts the clone. */
const FIXTURE = process.env.CASCADE_JEECG
  ?? path.resolve(ENGINE_ROOT, '..', 'target-examples', 'jeecg-boot');

// The Maven reactor is the NESTED `jeecg-boot/` directory; the git repository is
// its parent, and `--root` is the repository (that is what `init` was run on).
const DDL_REL = 'jeecg-boot/db/jeecgboot-mysql-5.7.sql';

function preflight() {
  if (!fs.existsSync(path.join(FIXTURE, DDL_REL))) {
    return `no jeecg-boot checkout at ${FIXTURE} — clone it at ${PINNED_COMMIT} `
      + '(git clone https://github.com/jeecgboot/JeecgBoot) or set CASCADE_JEECG';
  }
  if (!findJdk()) {
    return 'no JDK found: JAVA_HOME is unset and no javac on PATH — the Java lane cannot run (see docs/setup/java-lane.md)';
  }
  if (!fs.existsSync(VENV_PY)) {
    return `no venv python at ${VENV_PY} — the DDL catalog cannot be parsed (see docs/setup/sql-lane.md)`;
  }
  return null;
}

/** Clone the fixture at the pinned commit into `dir`. Never touches the source. */
function cloneFixture(dir) {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', FIXTURE, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', PINNED_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString('utf8').trim(), PINNED_COMMIT);
}

const ownerOf = (symbolId) => symbolId.slice('symbol:'.length).split('#')[0];

// ---------------------------------------------------------------------------
// THE HAND COUNTS. Each is reproducible with the grep in its comment, run from
// the fixture's nested `jeecg-boot/` directory.
// ---------------------------------------------------------------------------

// `grep -rl "@FeignClient" --include="*.java" .` -> 6 files. Three are the
// `cloud` flavour of the shared API (jeecg-system-cloud-api: ISysBaseAPI,
// IAiragBaseApi, IOnlineBaseExtApi) and three are cloud test clients under
// jeecg-server-cloud/.
const FEIGN_INTERFACES = [
  'org.jeecg.common.system.api.ISysBaseAPI',
  'org.jeecg.common.airag.api.IAiragBaseApi',
  'org.jeecg.common.online.api.IOnlineBaseExtApi',
  'org.jeecg.modules.test.feign.client.JeecgTestClient',
  'org.jeecg.modules.test.seata.order.feign.AccountClient',
  'org.jeecg.modules.test.seata.order.feign.ProductClient',
];

// Per file: `grep -cE "^[[:space:]]*@(Get|Post|Put|Delete|Patch|Request)Mapping" <file>`
//   ISysBaseAPI 100, IAiragBaseApi 7, IOnlineBaseExtApi 6, and 1 each for the
//   three cloud test clients. (ISysBaseAPI carries a 101st mapping on line 518
//   that is COMMENTED OUT — `//    @GetMapping("/sys/api/queryDepartsByOrgIds")`
//   — which is why the anchored pattern matters.)
const FEIGN_MAPPED_METHODS = 100 + 7 + 6 + 1 + 1 + 1; // = 116

// The nine calls whose target no controller in THIS repository answers, read off
// the source. Six are IOnlineBaseExtApi's: the `online` module is not part of
// the open-source repository, and `grep -rn 'RequestMapping("/online'` finds no
// controller at all. Three are ISysBaseAPI's, and each is a real mismatch
// between the client's annotation and SystemApiController's:
//   - queryDepartsByOrgcodes: the client says @RequestMapping (no method -> ANY),
//     SystemApiController.java:573 says @GetMapping                       -> GET
//   - queryUsersByUsernames:  the client says @GetMapping,
//     SystemApiController.java:553 says @RequestMapping                   -> ANY
//   - getDepartPathNameByOrgCode: the client's path omits the `/sys/api`
//     prefix (ISysBaseAPI.java:904 `@GetMapping("/getDepartPathNameByOrgCode")`),
//     while the controller's class-level @RequestMapping("/sys/api") gives its
//     own method GET /sys/api/getDepartPathNameByOrgCode.
const HTTP_CALLS_LEAVING_PACK = [
  'ANY /sys/api/queryDepartsByOrgcodes',
  'DELETE /online/api/cgform/cgformDeleteDataByCode',
  'GET /getDepartPathNameByOrgCode',
  'GET /online/api/cgform/queryAllDataByTableName',
  'GET /online/api/cgreportGetData',
  'GET /online/api/cgreportGetDataPackage',
  'GET /sys/api/queryUsersByUsernames',
  'POST /online/api/cgform/crazyForm/{name}',
  'PUT /online/api/cgform/crazyForm/{name}',
];

test('jeecgboot/JeecgBoot: a mapping annotation is classified, not assumed', { timeout: 1800000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jeecg-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  cloneFixture(repo);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  // ---- 1. `init` is quiet on a project full of presentation resources -----
  // Before RM14 this printed 211 diagnostics, 208 of them one per unreadable
  // line of ONE file: jeecg-system-biz/.../static/generic/web/locale/locale.properties,
  // a PDF.js locale bundle that was never a datasource candidate.
  const init = cli(['init', '--root', repo, '--project', 'jeecg']);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(/UNREADABLE_PROPERTY_LINE/.test(init.stderr), false,
    `init must not report per-line noise from presentation resources:\n${init.stderr}`);
  // The frontend package.json used to be an UNSUPPORTED_TECHNOLOGY here. RM26
  // ships the lane that reads it, so it is a lane input now, and the only
  // diagnostics left are the two about which schema this project actually runs.
  assert.match(init.stderr, /diagnostics \(2\): AMBIGUOUS_CATALOG_SOURCE x2/, init.stderr);
  assert.match(init.stderr, /lanes \[sql,java,web\]/, init.stderr);
  // …and the connection candidates are all still found: `find . \( -name "*.yml"
  // -o -name "*.yaml" -o -name "*.properties" \)` outside static/i18n/locale
  // yields 18 files carrying a jdbc URL, which the diagnostic above names.
  assert.match(init.stderr, /18 files carry datasource connection info/, init.stderr);

  // ---- 2. analyze ---------------------------------------------------------
  const analyze = cli(['analyze', '--root', repo, '--ddl', path.join(repo, DDL_REL)]);
  assert.equal(analyze.status, 0, analyze.stderr);
  const pack = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  assert.equal(pack.meta.base.commit, PINNED_COMMIT);
  const graph = loadPack(pack, { verifyDigest: true });
  const stats = pack.meta.laneStats;

  // ---- 3. no route is served by two controllers here ----------------------
  // COUNTED BY HAND: the 107 routes that used to carry two HANDLES edges were,
  // every one of them, one @FeignClient interface method paired with one
  // @RestController method (97 ISysBaseAPI/SystemApiController, 7
  // IAiragBaseApi/AiragBaseApiController, and one each for the three cloud test
  // clients). jeecg-boot has 94 concrete route-holding classes, all annotated
  // @RestController or @Controller, and NO route string is declared by two of
  // them — so the correct count among concrete controllers is ZERO, not 107.
  assert.equal(multiHandlerRoutes(graph).length, 0,
    'no route in jeecg-boot is declared by two CONCRETE controllers');
  const perRoute = new Map();
  let outboundJava = 0;
  let outboundWeb = 0;
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    if (n.outbound === true) {
      // Two kinds of route this pack does NOT serve, and the node says which:
      // one a @FeignClient method calls (the Java lane's) and one the frontend
      // calls (`source:'web'`, RM28). Counting them together would make the
      // Java lane look like it grew a hundred outbound calls it never made.
      if (n.source === 'web') outboundWeb += 1; else outboundJava += 1;
      continue;
    }
    const h = handlersOf(graph, n.id).length;
    perRoute.set(h, (perRoute.get(h) ?? 0) + 1);
  }
  assert.deepEqual([...perRoute.entries()].sort(), [[1, 969]],
    '969 routes this pack serves, every one of them with exactly one handler');
  assert.equal(outboundJava, 9, '9 endpoint nodes exist only as the target of a declarative client call');
  assert.ok(outboundWeb > 0, 'and the frontend names routes this pack does not serve either');
  assert.equal(stats.handles, 969);

  // ---- 4. no @FeignClient method is ever a handler ------------------------
  for (const e of graph.edges) {
    if (e.type !== 'HANDLES') continue;
    assert.equal(FEIGN_INTERFACES.includes(ownerOf(e.to)), false,
      `${e.to} is a declarative HTTP CLIENT method and must never handle ${e.from}`);
  }

  // ---- 5. one CALLS_HTTP per mapped method of the six clients -------------
  // `rule` tells the two producers apart: the Java lane's declarative clients
  // (`http-client`) and the web lane's frontend calls (`web-http-call`).
  const http = graph.edges.filter((e) => e.type === 'CALLS_HTTP' && e.evidence.rule === 'http-client');
  assert.equal(http.length, FEIGN_MAPPED_METHODS, 'one edge per mapped method across the 6 @FeignClient interfaces');
  assert.equal(stats.httpCalls, FEIGN_MAPPED_METHODS);
  // ...and every one of them is DECLARATIVE. jeecg does write imperative calls
  // (`grep -rn "restTemplate.exchange\|RT.exchange" --include="*.java"` finds
  // them in RestUtil and OpenApiController), but each one hands its url to the
  // client as a variable or a `URI.create(...)`, so the worker reduced none of
  // them to a path and this bridge drew no edge for any: RM43 adds edges where
  // a url is really written and nowhere else.
  assert.equal(stats.httpCallsDeclarative, FEIGN_MAPPED_METHODS);
  assert.equal(stats.httpCallsImperative, 0);
  assert.ok(stats.httpCallsUrlUnreadable > 0,
    `the imperative call sites are counted rather than hidden, got ${stats.httpCallsUrlUnreadable}`);
  assert.deepEqual([...new Set(http.map((e) => ownerOf(e.from)))].sort(), [...FEIGN_INTERFACES].sort());
  // 107 of them name a route this pack also serves; 9 leave it. An UNRESOLVED
  // edge is below every mode's floor, so nothing is claimed about where it lands.
  assert.deepEqual(
    [stats.httpCallsResolved, stats.httpCallsUnresolved],
    [FEIGN_MAPPED_METHODS - HTTP_CALLS_LEAVING_PACK.length, HTTP_CALLS_LEAVING_PACK.length],
  );
  assert.deepEqual(
    http.filter((e) => e.grade === 'UNRESOLVED').map((e) => e.to.slice('endpoint:'.length)).sort(),
    [...HTTP_CALLS_LEAVING_PACK].sort(),
  );
  // ISysBaseAPI's 100 mapped methods: 97 answered by SystemApiController, and
  // the 3 mismatches listed above.
  const sysBase = http.filter((e) => ownerOf(e.from) === 'org.jeecg.common.system.api.ISysBaseAPI');
  assert.equal(sysBase.length, 100);
  const answeredBySystemApi = sysBase.filter((e) => handlersOf(graph, e.to)
    .every((h) => ownerOf(h) === 'org.jeecg.modules.api.controller.SystemApiController')
    && handlersOf(graph, e.to).length === 1);
  assert.equal(answeredBySystemApi.length, 97);
  // The evidence carries what the annotation said, and says the service name is
  // a CONSTANT reference the parse-only worker did not resolve.
  const one = sysBase[0];
  assert.equal(one.evidence.rule, 'http-client');
  assert.equal(one.evidence.annotation, 'FeignClient');
  assert.equal(one.evidence.service, 'ServiceNameConstants.SERVICE_SYSTEM');
  assert.equal(one.evidence.serviceLiteral, false);

  // ---- 6. `super.exportXls(...)` resolves, and so does the type parameter --
  // AiragModelController.java:195 and SysCheckRuleController.java:182 both call
  //   `super.exportXls(request, x, X.class, "…")`
  // whose target is JeecgController#exportXls — a method the SUBCLASS does not
  // declare, in a base class whose field is `protected S service` with
  // `class JeecgController<T, S extends IService<T>>`. The call
  // `service.list(queryWrapper)` in that shared body has no callee until a
  // subclass binds S; each of these two binds it to its own service interface.
  for (const [sub, service] of [
    ['org.jeecg.modules.airag.llm.controller.AiragModelController', 'org.jeecg.modules.airag.llm.service.IAiragModelService'],
    ['org.jeecg.modules.system.controller.SysCheckRuleController', 'org.jeecg.modules.system.service.ISysCheckRuleService'],
  ]) {
    const from = `symbol:${sub}#exportXls`;
    const base = 'symbol:org.jeecg.common.system.base.controller.JeecgController#exportXls';
    const up = graph.outEdges(from).find((e) => e.to === base && graph.edgeAt(e.idx).evidence?.rule === 'super-enclosing');
    assert.ok(up, `${sub}#exportXls --super-enclosing--> JeecgController#exportXls is missing`);
    assert.equal(graph.edgeAt(up.idx).evidence.declaredBy, 'org.jeecg.common.system.base.controller.JeecgController');
    // RM37: THE BOUND EDGE LEAVES THE CONTROLLER, NOT THE BASE. The base body
    // runs as THIS controller, so `service.list(…)` there is this controller's
    // service. Attaching it to `JeecgController#exportXls`, which all 30 of them
    // point at, is what made every export endpoint look like it read every
    // sibling module's tables.
    const down = graph.outEdges(from).find((e) => e.to === `symbol:${service}#list`);
    assert.ok(down, `${sub}#exportXls --type-param-binding--> ${service}#list is missing`);
    const ev = graph.edgeAt(down.idx).evidence;
    assert.equal(ev.rule, 'type-param-binding');
    assert.equal(ev.receiver, 'S');
    assert.equal(ev.boundThrough, sub, 'the evidence names the subclass whose extends clause bound S');
    assert.equal(ev.inheritedFrom, 'org.jeecg.common.system.base.controller.JeecgController#exportXls');
    // …and NO sibling's service is reachable from it.
    const siblings = graph.outEdges(from)
      .map((e) => e.to)
      .filter((to) => /Service#(list|count|page|saveBatch)$/.test(to) && to !== `symbol:${service}#list`);
    assert.deepEqual(siblings, [], `${sub}#exportXls reaches a service that is not its own`);
  }
  // THE SHARED BODY CARRIES NOTHING BOUND ANY MORE. What is left on it are the
  // calls that were never through a type parameter: `jeecgBaseConfig.getPath()`
  // and its own overload.
  assert.deepEqual(
    graph.outEdges('symbol:org.jeecg.common.system.base.controller.JeecgController#exportXls')
      .map((e) => graph.edgeAt(e.idx).evidence?.rule).sort(),
    ['field-receiver', 'unqualified-enclosing'],
  );
  // 70 `super.m()` calls resolve and 3 do not — `grep -rcE "super\\.[a-zA-Z_]"`
  // finds 73 in all, and 70 + 3 is still 73.
  //
  // RM35 MOVED 40 OF THEM FROM THE SECOND NUMBER TO THE FIRST. The 43 that used
  // to fail climbed into framework classes (ServiceImpl, HttpServlet,
  // JsonSerializer …) this parse-only lane never sees — but the file's own
  // `import` line NAMES those classes, and `super.list(…)` really does run
  // `ServiceImpl#list`. So the edge is made and lands outside the project,
  // which is where the chain ends at run time too. Only a base the imports do
  // not name at all is still a failure, and jeecg-boot has 3.
  assert.equal(stats.callsByRule['super-enclosing'], 70);
  assert.equal(stats.unresolvedCallsByRule['super-enclosing'], 3);
  assert.equal(stats.unresolvedCallsByRule['type-param-unbound'], 0);
  // 31 TYPE-PARAMETER EDGES, ONE PER `super.` CALL SITE THAT RUNS A GENERIC BODY
  // (RM37; it was 168 when they were pooled on the four base methods). Counted
  // by hand from the 30 classes that `extends JeecgController`:
  //   grep -rl 'super.exportXls('      -> 16 files, one `service.list(…)` each
  //   grep -rl 'super.importExcel('    -> 13 files, one `service.saveBatch(…)` each
  //   grep -rl 'super.exportXlsSheet(' ->  1 file  (JeecgDemoController), whose
  //     body calls `service.count()` AND `service.page(…)`, so it is 2 edges
  // 16 + 13 + 2 = 31. The 19 files that DECLARE `exportXls` and the 18 that
  // declare `importExcel` are more than that on purpose: an override that never
  // calls `super` writes its own import logic against its own service, and the
  // ancestor's call site is not in it.
  assert.equal(stats.callsByRule['type-param-binding'], 31);
  // …and 27 of the 40 land on one base: MyBatis-Plus's `ServiceImpl`, which
  // every jeecg service extends. The edge names it, `isExternalType` marks the
  // symbol external, so no walk follows it and nothing is claimed about what it
  // does — the honest end of the chain rather than a missing one.
  const outside = graph.edges.filter((e) => e.type === 'MAY_CALL'
    && e.evidence?.rule === 'super-enclosing' && e.evidence.outsideRoots === true);
  assert.equal(outside.length, 40);
  assert.equal(
    outside.filter((e) => e.to.startsWith('symbol:com.baomidou.mybatisplus.extension.service.impl.ServiceImpl#')).length,
    27,
  );
  assert.equal(graph.nodes.get('symbol:com.baomidou.mybatisplus.extension.service.impl.ServiceImpl#list').external, true);

  // ---- 6b. a receiver INHERITED from a generic base (RM20 §1) ------------
  //
  // COUNTED BY HAND, from the source at PINNED_COMMIT:
  //   `grep -rl "extends JeecgController<"` -> 30 controllers. `JeecgController<T,
  //   S extends IService<T>>` declares `protected S service;` (line 43) and
  //   nothing else in the project declares a variable called `service`, so a
  //   subclass that writes `service.page(...)` is using the INHERITED field.
  //   Of the 30, exactly five never declare a `service` of their own AND call
  //   through it — OpenApiController (8 call sites), OpenApiAuthController (6),
  //   OpenApiLogController (6), OpenApiPermissionController (2) and
  //   SysLogController (1) — 23 in all. The other 25 hold their collaborator in
  //   an @Autowired field of their own name, which the field rule already
  //   resolved.
  // Reproduce with, from the fixture root:
  //   for f in $(grep -rl "extends JeecgController<" --include='*.java' . | grep -v /src/test/); do
  //     grep -qE '(private|protected|public)[[:space:]]+[A-Za-z0-9_<>,? ]+[[:space:]]+service[[:space:]]*[;=]' "$f" \
  //       || echo "$f $(grep -cE '(^|[^.a-zA-Z0-9_])(this\.)?service\.[a-zA-Z]' "$f")"
  //   done
  assert.equal(stats.callsByRule['inherited-field'], 23);
  // Each is bound IN THE SUBCLASS: `OpenApiController extends
  // JeecgController<OpenApi, OpenApiService>` reaches OpenApiService and no
  // other — never all 30 bindings of `S`.
  const inherited = graph.edges.filter((e) => e.evidence?.rule === 'inherited-field');
  assert.equal(new Set(inherited.map((e) => e.evidence.declaredBy)).size, 1);
  assert.equal(inherited[0].evidence.declaredBy, 'org.jeecg.common.system.base.controller.JeecgController');
  const fromOpenApi = inherited.filter((e) => e.from === 'symbol:org.jeecg.modules.openapi.controller.OpenApiController#queryPageList');
  assert.deepEqual(fromOpenApi.map((e) => e.to), ['symbol:org.jeecg.modules.openapi.service.OpenApiService#page']);
  assert.equal(fromOpenApi[0].evidence.boundThrough, 'org.jeecg.modules.openapi.controller.OpenApiController');

  // ---- 7. what the round bought, and what it did NOT --------------------
  // RM14 raised endpointsReachingAStatement from 214 to 234, and the report
  // said where the remaining 735 went: their chains ended at MyBatis-Plus's
  // `IService`/`ServiceImpl`, whose `list`/`page`/`count` are declared in the
  // framework and so were outside this pack. RM15 is that framework's lane, and
  // the number was then 717 — see `mp-builtin statements` below, which pins what
  // produced the difference.
  //
  // RM20 moved it to 744. The 27 routes it added were read one by one against
  // the RM15 pack and split cleanly in two:
  //   19 reach ONLY statements that did not exist before — the 53 MyBatis
  //      statement ANNOTATIONS (§4), which this fixture carries 53 of exactly
  //      (`grep -rho '@Select(' … | wc -l` -> 41, @Update 6, @Delete 6, @Insert 0);
  //    8 reach statements that were always there, through the 23 inherited-field
  //      edges above (§1) — the /openapi/* controllers and /sys/log/exportXls,
  //      which are precisely the five classes that use JeecgController's field.
  const o = buildOverview(graph, { laneStats: stats, lanes: pack.meta.lanes });
  assert.equal(o.reach.endpoints, 969);
  // 9 routes a @FeignClient method calls, plus the ones the FRONTEND calls and
  // this pack does not serve (RM28). Both are `outbound`, and the gap note
  // below splits them, because they are not the same thing to fix: a Feign call
  // that leaves is another deployable, a frontend call that leaves is as often
  // a prefix nobody declared.
  assert.equal(o.reach.outboundEndpoints, outboundJava + outboundWeb);
  assert.equal(o.reach.endpoints - o.reach.endpointsWithoutStatement, 744);
  // 748 STATEMENTS, WHERE RM20 REACHED 796. The 48 that dropped out are RM37's:
  // every one of them is a MyBatis-Plus built-in (`count`, `list`, `page`,
  // `saveBatch`) on a service whose controller never calls it from a mapped
  // method, reached only because the generic base's `service.list(…)` used to
  // pool all 30 controllers' bindings on one symbol. `OpenApiAuthServiceImpl`
  // is the plainest of them: `OpenApiAuthController` writes `service.page(…)`,
  // `save`, `updateById`, `removeById` and `getById`, and neither `list` nor
  // `count` nor `saveBatch` — so those three had no caller in this repository.
  // The number of ENDPOINTS that reach a statement is unchanged at 744, which
  // is the half of this that says nothing was disconnected.
  assert.equal(o.reach.statementsReached, 748);
  const gap = o.gaps.find((g) => g.kind === 'http-calls-leaving-pack');
  assert.equal(gap.count, outboundJava + outboundWeb);
  // The sentence counts BOTH producers of a CALLS_HTTP edge in this lane
  // (RM43 added the imperative one). jeecg's imperative calls all build their
  // url from a variable, so none of them draws an edge and the number is still
  // the 9 declarative ones.
  assert.match(gap.note, /9 HTTP client call\(s\) in the code name a route no controller here serves/);
  assert.match(gap.note, /target\(s\) are named by the FRONTEND/);

  // ---- 9. the frontend reaches the endpoints (RM28) -----------------------
  // jeecg's client is a CLASS: a verb method forwards to one generic method,
  // which calls the axios instance the constructor put on a field. Nothing in
  // the engine knows any of those three names; the chain on the edge is what
  // the lane followed, hop by hop.
  const web = stats.web;
  assert.equal(web.instances, 1, JSON.stringify(web.prefix));
  assert.ok(web.wrappers.count > 100, `${web.wrappers.count} wrapper(s)`);
  assert.ok(web.wrappers.maxDepth >= 2, `deepest wrapper chain ${web.wrappers.maxDepth}`);
  assert.ok(web.resolved.SOUND_SET > 475,
    `the grep-level floor for this pair is 475 matched calls, this pack has ${web.resolved.SOUND_SET} sound + ${web.resolved.HEURISTIC} heuristic`);
  // Nothing in this frontend's source states the prefix its calls go through,
  // and nothing needs to: the client is built with no baseURL at all, so the
  // path as written IS the path, and the axis is shipped rather than guessed.
  const prefixes = Object.values(web.prefix).flatMap((p) => p.instances.map((i) => i.from));
  assert.deepEqual([...new Set(prefixes)], ['derived'], JSON.stringify(web.prefix));
  assert.equal(pack.meta.axes.web.status, 'shipped', pack.meta.axes.web.reason);

  // The chain really does end at `axios.create`, through the class's own field.
  const webEdge = graph.edges.find((e) => e.type === 'CALLS_HTTP' && e.evidence.rule === 'web-http-call'
    && e.evidence.sink.kind === 'wrapper' && e.evidence.sink.depth === 2);
  assert.ok(webEdge, 'expected a two-hop wrapper chain from a verb method to the generic one');
  assert.equal(webEdge.evidence.sink.module, 'axios');
  assert.equal(webEdge.evidence.sink.chain.length, 2);
  assert.equal(graph.nodes.get(webEdge.from).lane, 'web');
});

// ===========================================================================
// RM15 — the MyBatis-Plus lane.
//
// jeecg-boot is where "the SQL is written down" stops being true. Only 80
// mapper XML files exist for 65 mappers; everything else is generic CRUD
// (`selectList`, `save`, `removeById`) over a condition wrapper built in Java.
// Before this lane the engine saw 244 statements and 234 endpoints that reach
// one; the rest of the project's persistence was invisible, not empty.
//
// EVERY count below was taken BY HAND from the source at PINNED_COMMIT, and
// each names the grep and the reconciliation that produced it. The greps run
// over the 945 `.java` files in the 21 source roots `analyze` reads (main
// sources; `cascade analyze` excludes src/test by default), which is what
//   for r in <the roots>; do find "$r" -name '*.java'; done
// enumerates.
// ---------------------------------------------------------------------------

// `grep -hoE '^[[:space:]]*@TableName'` -> 50, in 50 distinct files. The anchor
// matters: `@TableName` also appears inside javadoc.
const TABLE_NAME_DECLARATIONS = 50;

// `grep -hoE 'extends BaseMapper *<'` -> 65. ONE of them is not an extends
// CLAUSE at all: JeecgServiceImpl.java:17 spells a type-parameter BOUND,
//   class JeecgServiceImpl<M extends BaseMapper<T>, T extends JeecgEntity>
// so the mappers are 64.
// (Recorded for the reader; no assertion below reads it.)
const _MP_MAPPERS = 65 - 1;

// `grep -hoE 'extends ServiceImpl *<'` -> 60 (all real).
// `grep -hoE 'extends IService *<'`    -> 59, of which ONE is again a bound:
//   JeecgController.java  `public class JeecgController<T, S extends IService<T>>`
// so 60 + 58 = 118 declarations name a service's entity.
// (Recorded for the reader; no assertion below reads it.)
const _MP_SERVICES = 60 + (59 - 1);

// `grep -hoE '^[[:space:]]*@TableLogic'` -> 7. Six sit on a class a mapper or
// service names as its entity; the seventh, SysUserSysDepPostModel.java:76, is
// a result-map DTO that no BaseMapper/IService names and that carries no
// @TableName, so it is not an entity here and its flag column is not a table's.
const LOGIC_DELETE_ENTITIES = 7 - 1;

// `grep -hoE 'new +(Lambda)?(Query|Update)Wrapper'` -> 355 sites. Reconciled to
// the 348 the lane records:
//   -2  javadoc examples          QueryGenerator.java:121,122
//   -4  commented-out code        SysCategoryController.java:89,
//                                 SysDepartController.java:470,
//                                 SysRoleController.java:354,
//                                 SysUserServiceImpl.java:1051
//   -2  ASSIGNMENTS to a variable that already exists, not declarations —
//       SysUserServiceImpl.java:788 (`wrapper = new LambdaQueryWrapper<>()`,
//       rebinding a parameter) and SysTenantPackServiceImpl.java:332. The scan
//       reads declarations and chains, not re-assignments; in BOTH cases the
//       variable already has a wrapper record, so the ops still land on it.
//   +1  a site this grep misses and the lane finds: SysDataSourceServiceImpl.java:200
//       writes `new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<…>()`
const WRAPPERS_FROM_NEW = 355 - 2 - 4 - 2 + 1;

// `grep -hoE 'Wrappers\.'` -> 18. Two are not MyBatis-Plus at all — the tail of
// the local variable `mcpToolProviderWrappers` in AIChatHandler.java:459,485 —
// and two are commented out, leaving 14 static-factory wrappers.
const WRAPPERS_FROM_FACTORY = 18 - 2 - 2;

// `.lambdaQuery()` x2 + `.lambdaUpdate()` x2 on a service/mapper receiver.
const WRAPPERS_FROM_FLUENT_STARTER = 4;

// `grep -hoE 'QueryGenerator\.initQueryWrapper'` -> 69. One is javadoc
// (MultiDataSourcePaginationInnerInterceptor.java:80), two are commented-out
// declarations (SysDepartController.java:390, SysRoleController.java:112) and
// two are assignments to an already-declared variable (JoaDemoController.java:190,
// SysPositionController.java:238) — 64 declarations in all. THIS is the number
// that matters for honesty: `initQueryWrapper(object, request.getParameterMap())`
// builds its conditions from the HTTP query string, so no source line names the
// columns and the lane must say so instead of guessing.
const WRAPPERS_BUILT_FROM_REQUEST = 69 - 1 - 2 - 2;

// The wrappers a method does NOT build — every one read off the source:
//  10 method PARAMETERS typed with a wrapper. Eight are QueryGenerator.java's
//     own helpers, `(QueryWrapper<?> queryWrapper, …)` at lines 125, 235, 254,
//     395, 614, 706, 866, 1019; the other two are
//     SysUserServiceImpl.java:149 `queryPageList(…, QueryWrapper<SysUser> queryWrapper, …)`
//     and SysUserServiceImpl.java:786 `queryLogicDeleted(LambdaQueryWrapper<SysUser> wrapper)`.
//   4 local declarations whose initializer is neither a `new` nor a call this
//     lane reads: JoaDemoController.java:184 `= null`, SysLogController.java:170
//     `= (QueryWrapper<SysLog>) queryParams`, SysLogController.java:172 `= null`,
//     SysPositionController.java:225 `= null`.
// All 14 are recorded with `opsComplete:false` — whatever conditions were added
// to them elsewhere are not in this pack, and that is what makes the statements
// they feed `columnsRuntimeOnly`.
const WRAPPERS_ARRIVING_BUILT = 10 + 4;

// SysUser.java declares 42 instance/static fields. `serialVersionUID` is static,
// `orgCodeTxt` is `transient`, and eight carry `@TableField(exist = false)`
// (post, relTenantIds, homePath, postText, izBindThird, otherDepPostId,
// loginOrgCode, belongDepIds) — MyBatis-Plus persists none of those, so 32
// columns. The DDL's `sys_user` has 34: the two the entity does not declare are
// `third_id` and `third_type`, which moved to SysThirdAccount.
const SYS_USER_COLUMNS = 42 - 1 - 1 - 8;

test('jeecgboot/JeecgBoot: the MyBatis-Plus lane maps what nobody wrote down', { timeout: 1800000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-jeecg-mp-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');
  cloneFixture(repo);

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  // ---- 1. discovery declares the pack, without being told ----------------
  const init = cli(['init', '--root', repo, '--project', 'jeecg-mp']);
  assert.equal(init.status, 0, init.stderr);
  const profilePath = path.join(repo, '.cascade', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  assert.ok(profile.frameworkPacks.includes('mybatis-plus'),
    `init must declare the mybatis-plus pack on a project full of BaseMapper/@TableName: ${JSON.stringify(profile.frameworkPacks)}`);
  assert.equal(profile.mybatisPlus.namingStrategy, null,
    'init never invents a naming strategy — the project has to say');

  const analyze = cli(['analyze', '--root', repo, '--ddl', path.join(repo, DDL_REL)]);
  assert.equal(analyze.status, 0, analyze.stderr);
  const pack = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const mp = pack.meta.laneStats.mybatisPlus;

  // ---- 2. the worker's evidence, against the hand counts -----------------
  assert.equal(mp.entitiesTableDeclared, TABLE_NAME_DECLARATIONS);
  assert.equal(mp.wrappers, WRAPPERS_FROM_NEW + WRAPPERS_FROM_FACTORY + WRAPPERS_FROM_FLUENT_STARTER
    + WRAPPERS_BUILT_FROM_REQUEST + WRAPPERS_ARRIVING_BUILT);
  assert.equal(mp.logicDeleteEntities, LOGIC_DELETE_ENTITIES);
  assert.equal(mp.namingStrategyDeclared, false);
  assert.equal(mp.namingStrategy, 'underscore');
  // Every wrapper op this lane met fell into a reading it has. `opsUninterpreted`
  // is the honest escape hatch: an op with no reading would be NAMED here rather
  // than silently contributing nothing.
  assert.deepEqual(mp.opsUninterpreted, {});

  // ---- 3. SysUser -> sys_user, and the grade says it was DERIVED ---------
  // SysUser.java carries no @TableName (`grep -c '@TableName' SysUser.java` -> 0),
  // so `sys_user` comes from MyBatis-Plus's camelCase→under_score default, which
  // the profile does not declare. That is a rule the engine ASSUMED.
  const sysUser = graph.nodes.get('table:sys_user');
  assert.ok(sysUser, 'SysUser maps to sys_user');
  assert.equal(sysUser.mpEntity, 'org.jeecg.modules.system.entity.SysUser');
  assert.equal(sysUser.mpMappingGrade, 'HEURISTIC');
  // …and the DDL really does have that table. Evidence for a human, never a
  // promotion (I-1): the grade above is unchanged by it.
  assert.equal(sysUser.mpCatalogMatch, true);
  assert.equal(sysUser.stub, undefined, 'sys_user is a catalog table, not a stub');

  // SysUserDepart.java:15 DOES declare `@TableName("sys_user_depart")`, so that
  // half is EXACT — the two grades sit side by side in one pack.
  const sud = graph.nodes.get('table:sys_user_depart');
  assert.equal(sud.mpEntity, 'org.jeecg.modules.system.entity.SysUserDepart');
  assert.equal(sud.mpMappingGrade, 'EXACT');

  // ---- 4. the wrapper at SysUserServiceImpl.java:156-160 -----------------
  //   LambdaQueryWrapper<SysUserDepart> query = new LambdaQueryWrapper<>();   :156
  //   query.in(SysUserDepart::getDepId, …)                                    :158
  //   query.eq(SysUserDepart::getDepId, departId)                             :160
  //   List<SysUserDepart> list = sysUserDepartMapper.selectList(query);       :162
  // `depId` carries no @TableField, so `dep_id` is DERIVED -> HEURISTIC, while
  // the TABLE it sits on is EXACT. The DDL's sys_user_depart has exactly
  // (ID, user_id, dep_id), so `dep_id` is a real column and `id` lands on the
  // catalog's `ID` through the pack's fold-lower identity rule rather than
  // becoming a second node for the same column.
  const sel = 'statement:org.jeecg.modules.system.mapper.SysUserDepartMapper.selectList';
  const selNode = graph.nodes.get(sel);
  assert.ok(selNode, `${sel} is missing`);
  assert.equal(selNode.statementType, 'mp-builtin');
  assert.equal(selNode.source, 'mybatis-plus');
  assert.equal(selNode.mpEvidence.entity, 'org.jeecg.modules.system.entity.SysUserDepart');
  assert.equal(selNode.mpEvidence.table, 'sys_user_depart');
  assert.equal(selNode.mpEvidence.access, 'read');
  const depIdEdge = graph.outEdges(sel).map((e) => graph.edgeAt(e.idx))
    .find((e) => e.type === 'READS' && e.to === 'column:sys_user_depart.dep_id');
  assert.ok(depIdEdge, 'the wrapper\'s SysUserDepart::getDepId must reach sys_user_depart.dep_id');
  assert.equal(depIdEdge.grade, 'HEURISTIC', 'depId owns no @TableField, so dep_id is derived');
  assert.ok(depIdEdge.evidence.roles.includes('predicate'));
  assert.ok(depIdEdge.evidence.via.includes('wrapper-op:in'));
  assert.ok(depIdEdge.evidence.via.includes('wrapper-op:eq'));
  // ONE node per column, not two: the entity derives `id` where the DDL writes `ID`.
  assert.equal(graph.nodes.has('column:sys_user_depart.id'), false,
    'the derived `id` must land on the catalog\'s `ID` under the pack\'s identity rule');
  assert.ok(graph.nodes.has('column:sys_user_depart.ID'));

  // ---- 5. @TableLogic turns a delete into a WRITE ------------------------
  // SysUser.java:125-126 `@TableLogic private Integer delFlag;`, and the DDL's
  // sys_user really has `del_flag`. MyBatis-Plus rewrites `removeById` into
  // `UPDATE sys_user SET del_flag = … WHERE id = ?`, so the row is not deleted
  // and the column IS written — calling it a delete would be wrong twice.
  const rm = 'statement:org.jeecg.modules.system.service.impl.SysUserServiceImpl.removeById';
  const rmNode = graph.nodes.get(rm);
  assert.ok(rmNode, `${rm} is missing`);
  assert.equal(rmNode.mpEvidence.logicDelete, true);
  assert.equal(rmNode.mpEvidence.access, 'write');
  const rmEdges = graph.outEdges(rm).map((e) => graph.edgeAt(e.idx));
  const del = rmEdges.find((e) => e.type === 'WRITES' && e.to === 'column:sys_user.del_flag');
  assert.ok(del, 'a @TableLogic delete WRITES the flag column');
  assert.equal(del.evidence.logicDelete, true);
  assert.equal(rmEdges.find((e) => e.type === 'EXECUTES').evidence.access, 'write');
  // …and every SELECT on that entity reads the flag as the filter MP appends.
  const listRead = graph.outEdges('statement:org.jeecg.modules.system.service.impl.SysUserServiceImpl.list')
    .map((e) => graph.edgeAt(e.idx))
    .find((e) => e.type === 'READS' && e.to === 'column:sys_user.del_flag');
  assert.ok(listRead, 'MyBatis-Plus appends `del_flag = <not deleted>` to every query on the entity');
  assert.equal(listRead.evidence.implicitFilter, true);

  // ---- 6. a JeecgController subclass reaches its table, columns unknown --
  // JeecgController.java:54-64 (the base every module's controller extends)
  //   QueryWrapper<T> queryWrapper = QueryGenerator.initQueryWrapper(object, request.getParameterMap());
  //   …
  //   List<T> exportList = service.list(queryWrapper);
  // The conditions come from the HTTP query string. The TABLE is a fact; the
  // COLUMNS are decided at run time, and the statement says so rather than
  // going quiet or inventing a column list.
  const airag = 'statement:org.jeecg.modules.airag.llm.service.impl.AiragModelServiceImpl.list';
  const airagNode = graph.nodes.get(airag);
  assert.ok(airagNode, `${airag} is missing`);
  assert.equal(airagNode.columnsRuntimeOnly, true);
  assert.match(airagNode.columnsRuntimeOnlyReason, /QueryGenerator\.initQueryWrapper/);
  assert.ok(graph.outEdges(airag).some((e) => graph.edgeAt(e.idx).type === 'EXECUTES' && e.to === 'table:airag_model'));
  // …reached from the subclass's own exportXls, across `super.exportXls(...)`
  // (RM14's rule) and the type-parameter binding that says which service `S` is.
  const reach = graph.reach('symbol:org.jeecg.modules.airag.llm.controller.AiragModelController#exportXls',
    { mode: 'conservative', edgeTypes: FLOW_EDGE_TYPES, maxHops: 12 });
  assert.ok(reach.has('table:airag_model'),
    'AiragModelController#exportXls -> super.exportXls -> service.list -> airag_model');

  // ---- 7. the census, and what the round bought --------------------------
  const o = buildOverview(graph, { laneStats: pack.meta.laneStats, lanes: pack.meta.lanes });
  const byType = Object.fromEntries(o.statementTypes.map((r) => [r.type, r.count]));
  // Before the MyBatis-Plus lane: select 187, delete 26, update 23, insert 8 =
  // 244, all of them mapper XML. `mp-builtin` was RM15's addition.
  //
  // RM20 §4 adds the statements written as ANNOTATIONS on mapper methods, which
  // had no statement at all before. COUNTED BY HAND over the main sources:
  //   grep -rho '@Select('  --include='*.java' . | wc -l   -> 41
  //   grep -rho '@Update('  --include='*.java' . | wc -l   ->  6
  //   grep -rho '@Delete('  --include='*.java' . | wc -l   ->  6
  //   grep -rho '@Insert('  --include='*.java' . | wc -l   ->  0
  // in 22 mapper interfaces — and the engine's four verbs move by exactly those
  // four numbers: 187+41=228, 23+6=29, 26+6=32, 8+0=8.
  assert.deepEqual(byType, { 'mp-builtin': 542, select: 228, delete: 32, update: 29, insert: 8 });
  assert.equal(o.mybatisPlus.statements, 542);
  assert.equal(o.mybatisPlus.statementsWithRuntimeOnlyColumns, 82);
  assert.equal(o.mybatisPlus.logicDeleteStatements, 9);
  assert.equal(o.code.mpBuiltinStatements, 542);
  // 969 routes, of which 744 now reach a statement (RM14: 234, RM15: 717).
  assert.equal(o.reach.endpoints, 969);
  assert.equal(o.reach.endpoints - o.reach.endpointsWithoutStatement, 744);
  // ONE more table, and it was read from the source before it was read from the
  // pack: SysDictMapper.java:51 carries
  //   @Select("SELECT db_source FROM onl_cgform_head WHERE table_name = #{tableName} …")
  // and `onl_cgform_head` is named by no other statement in this project.
  assert.equal(o.reach.tablesReached, 73);   // RM14: 40, RM15: 72
  // FIVE more columns, and the same reading gives all five: `db_source` and
  // `table_name` of that table, plus three columns of `sys_gateway_route`
  // (`sys_org_code`, `update_by`, `update_time`) that only
  //   SysGatewayRouteMapper.java:33 @Select("select * from sys_gateway_route where del_flag = 1")
  // expands onto — no other statement in the project names them.
  assert.equal(o.reach.columnsReached, 805); // RM14: 312, RM15: 800
  const gap = o.gaps.find((g) => g.kind === 'mp-columns-runtime-only');
  assert.equal(gap.count, 82);
  assert.match(gap.note, /only what we could read/);
  assert.equal(pack.meta.axes.mybatisPlus.status, 'degraded',
    'the strategy is ASSUMED, so the axis is degraded — not shipped');

  // ---- 8. column_impact says what it cannot see --------------------------
  const ctx = {
    basis: { project: 'jeecg-mp', buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: { trustLevel: 'UNCERTIFIED' },
    limits: [],
    pack: { project: 'jeecg-mp', digest: pack.digest, axes: pack.meta.axes, identifierCase: pack.meta.identifierCase },
  };
  const ci = column_impact(graph, { column: 'sys_user.username', limit: 100 }, ctx);
  const kinds = {};
  for (const it of ci.answer.statements) {
    const k = `${graph.nodes.get(`statement:${it.id}`).statementType}/${it.access}`;
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  // 37 mapper-XML selects read it, the MyBatis-Plus lane adds 9 generic-CRUD
  // reads and 5 generic-CRUD writes beside them, and RM20 §4 adds THREE more
  // selects — every one of them a statement ANNOTATION naming `username`, read
  // from the source before it was read from the pack:
  //   SysUserMapper.java:233     @Select("select id,phone from sys_user where phone = #{phone} and username = #{username}")
  //   SysUserRoleMapper.java:24  @Select("… (select id from sys_user where username=#{username})")
  //   SysUserRoleMapper.java:40  @Select("… (select id from sys_user where username=#{username})")
  assert.deepEqual(kinds, { 'select/read': 40, 'mp-builtin/read': 9, 'mp-builtin/write': 5 });
  const rt = ci.limits.find((l) => l.scope === 'runtime-only-columns:sys_user');
  assert.ok(rt, 'a column of a table some statement touches at run time must say so');
  assert.match(rt.reason, /2 statement\(s\) touch sys_user with columns decided at RUN TIME/);

  // ---- 9. DECLARE the strategy and the same mapping becomes EXACT --------
  // Same source, same wrappers: the only thing that changed is that the project
  // said which rule it uses. petclinic proves the same thing for JPA.
  fs.writeFileSync(profilePath, `${JSON.stringify({ ...profile, mybatisPlus: { ...profile.mybatisPlus, namingStrategy: 'underscore' } }, null, 2)}\n`);
  const again = cli(['analyze', '--root', repo, '--ddl', path.join(repo, DDL_REL), '--accept-baseline']);
  assert.equal(again.status, 0, again.stderr);
  const pack2 = JSON.parse(fs.readFileSync(path.join(repo, '.cascade', 'pack', 'pack.json'), 'utf8'));
  const graph2 = loadPack(pack2, { verifyDigest: true });
  assert.equal(graph2.nodes.get('table:sys_user').mpMappingGrade, 'EXACT');
  assert.equal(pack2.meta.axes.mybatisPlus.status, 'shipped');
  const depIdEdge2 = graph2.outEdges(sel).map((e) => graph2.edgeAt(e.idx))
    .find((e) => e.type === 'READS' && e.to === 'column:sys_user_depart.dep_id');
  assert.equal(depIdEdge2.grade, 'EXACT');
  // The SHAPE does not change — only the confidence. Same statements, same edges.
  assert.equal(pack2.meta.laneStats.mybatisPlus.statements, 542);
  assert.equal(pack2.nodes.length, pack.nodes.length);
  assert.equal(pack2.edges.length, pack.edges.length);
  assert.notEqual(pack2.digest, pack.digest, 'the grades moved, so the digest must too');

  // The mapped column list of SysUser, counted by hand above.
  const sysUserCols = graph2.edges.filter((e) => e.type === 'DECLARES' && e.from === 'table:sys_user').length;
  assert.ok(sysUserCols >= SYS_USER_COLUMNS,
    `sys_user declares ${sysUserCols} columns; the entity maps ${SYS_USER_COLUMNS} of them (the DDL has 34)`);
});
