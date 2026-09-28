// path_prefixes.test.mjs — the path prefix configuration code puts before a controller's routes, declared in the profile and applied by the Java lane.
//
// ruoyi-vue-pro serves every admin controller under /admin-api from
// `RequestMappingHandlerMapping.setPathPrefixes`, with the prefix a property and
// the predicate a lambda over the controller class. No reading of the source
// says either, so the profile's `pathPrefixes` does, and these tests hold how
// it is read: the package pattern as Spring's AntPathMatcher(".") reads it, the
// first entry a class passes wins, a client's route takes no prefix, the
// endpoint says where its prefix came from, and a project that declares none
// gets the graph it always got. The last part holds the other half: a call
// that sets prefixes in code is said when the profile is silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { assembleJavaFacts } from '../src/core/facts_store.mjs';
import { overlayGraph } from '../src/core/overlay.mjs';
import { addJavaFacts, endpointId, symbolId } from '../src/adapters/java_bridge.mjs';
import { apiGroupAfter, prefixedPath } from '../src/adapters/java/path_prefixes.mjs';
import { packagePatternError, packagePatternMatcher } from '../src/core/package_pattern.mjs';
import {
  digestedProfile, normalizeProfile, profileDiagnostics, validateProfile, PROFILE_KEY_CONSUMERS, ProfileError,
} from '../src/core/profile.mjs';
import { profileDigestOf } from '../src/core/calibration.mjs';
import { buildProfile } from '../src/core/init.mjs';
import { codeSettingDiagnostics } from '../src/core/code_settings.mjs';
import { codeSettingsIn } from '../src/core/rules/kinds/java_code_setting.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';
import { prefixNotOnCallsNotes, unusedPrefixNotes } from '../src/cli/commands/analyze/prefix_notes.mjs';

// ---------------------------------------------------------------------------
// the package pattern, as AntPathMatcher(".") reads it
// ---------------------------------------------------------------------------

test('a package pattern: ** is any number of whole segments, none included; * and ? stay inside one', () => {
  const cases = [
    ['**.controller.admin.**', 'cn.iocoder.yudao.module.system.controller.admin.user', true],
    ['**.controller.admin.**', 'cn.iocoder.yudao.module.wms.controller.admin', true, 'a trailing ** matches no segment at all, as in Spring'],
    ['**.controller.admin.**', 'controller.admin', true],
    ['**.controller.admin.**', 'cn.x.controller.app.user', false],
    ['**.controller.admin.**', 'cn.x.controller.administrator', false, 'a segment is matched whole'],
    ['**.controller.admin.**', 'cn.x.controller.app.admin', false, 'controller and admin must be neighbours'],
    ['com.*.web', 'com.a.web', true],
    ['com.*.web', 'com.a.b.web', false, '* never crosses a dot'],
    ['com.a?.web', 'com.ab.web', true],
    ['com.**.x', 'com.x', true],
    ['**', '', true, 'the default package is matched by ** alone'],
    ['com.**', '', false],
  ];
  for (const [pattern, pkg, expected, why] of cases) {
    assert.equal(packagePatternMatcher(pattern)(pkg), expected, `${pattern} on ${JSON.stringify(pkg)}${why ? `: ${why}` : ''}`);
  }
});

test('a package pattern that cannot be read is refused with what is wrong', () => {
  assert.equal(packagePatternError('**.controller.admin.**'), null);
  assert.match(packagePatternError('a..b'), /empty segment/);
  assert.match(packagePatternError('.a'), /empty segment/);
  assert.match(packagePatternError('a.{module}.b'), /the segment "\{module\}"/, 'a capture means nothing in a package');
  assert.match(packagePatternError(''), /non-empty/);
});

test('a prefix and a route path are joined as the worker joins a class and a method mapping', () => {
  assert.equal(prefixedPath('/admin-api', '/system/user/page'), '/admin-api/system/user/page');
  assert.equal(prefixedPath('/admin-api/', '/system'), '/admin-api/system');
  assert.equal(prefixedPath('admin-api', 'system'), '/admin-api/system', 'Spring adds the leading slash a prefix leaves out');
  assert.equal(prefixedPath('/admin-api', '/'), '/admin-api');
  assert.equal(apiGroupAfter('/admin-api', '/admin-api/system/user/page'), 'system');
  assert.equal(apiGroupAfter('/admin-api', '/admin-api'), null, 'no segment after the prefix');
  assert.equal(apiGroupAfter('/admin-api', '/admin-api/{tenant}/x'), null, 'a hole names no group');
});

// ---------------------------------------------------------------------------
// the profile key
// ---------------------------------------------------------------------------

const RUOYI_PREFIXES = [
  { prefix: '/admin-api', packages: '**.controller.admin.**', annotation: 'RestController', from: 'WebProperties.adminApi' },
  { prefix: '/app-api', packages: '**.controller.app.**', annotation: 'RestController' },
];

test('pathPrefixes: an entry the Java lane cannot apply is refused, naming the entry', () => {
  validateProfile(normalizeProfile({ pathPrefixes: RUOYI_PREFIXES }));
  const refused = (pathPrefixes) => assert.throws(() => validateProfile({ pathPrefixes }), ProfileError);
  refused({ prefix: '/a' });
  refused([{ packages: '**' }]);
  refused([{ prefix: '${yudao.web.admin-api.prefix}' }]);
  refused([{ prefix: '/a b' }]);
  refused([{ prefix: '/a', packages: 'a..b' }]);
  refused([{ prefix: '/a', annotation: 'org.springframework.web.bind.annotation.RestController' }]);
  assert.throws(() => validateProfile({ pathPrefixes: [RUOYI_PREFIXES[0], { prefix: '/a', package: '**.x.**' }] }),
    /pathPrefixes\[1\] has the key "package"/, 'a misspelt test would put the prefix on every controller');
});

test('pathPrefixes: consumed by the Java lane, and out of the profile digest until it is set', () => {
  assert.equal(PROFILE_KEY_CONSUMERS.pathPrefixes.status, 'consumed');
  const plain = normalizeProfile({});
  assert.equal(Object.hasOwn(digestedProfile(plain), 'pathPrefixes'), false, 'a project that sets none keeps the digest it had');
  const { pathPrefixes, ...withoutKey } = plain;
  assert.deepEqual(pathPrefixes, []);
  assert.equal(profileDigestOf(plain), profileDigestOf(withoutKey));
  assert.notEqual(profileDigestOf(normalizeProfile({ pathPrefixes: RUOYI_PREFIXES })), profileDigestOf(plain));
});

test('pathPrefixes: no discovery can find one, so `cascade init --force` keeps what the user declared', () => {
  const kept = buildProfile({ counts: {} }, { root: '/p', manifestDir: '/p/.cascade', existing: { pathPrefixes: RUOYI_PREFIXES } });
  assert.deepEqual(kept.profile.pathPrefixes, RUOYI_PREFIXES);
  assert.deepEqual(buildProfile({ counts: {} }, { root: '/p', manifestDir: '/p/.cascade' }).profile.pathPrefixes, []);
});

test('pathPrefixes: declared with no Java lane to read it is said, not ignored', () => {
  const said = profileDiagnostics(normalizeProfile({ pathPrefixes: RUOYI_PREFIXES }));
  assert.ok(said.some((d) => d.kind === 'RECORDED_NOT_ACTED' && d.key === 'pathPrefixes'));
  const quiet = profileDiagnostics(normalizeProfile({ pathPrefixes: RUOYI_PREFIXES, frameworkPacks: ['spring-mvc'] }));
  assert.equal(quiet.some((d) => d.key === 'pathPrefixes'), false);
});

// ---------------------------------------------------------------------------
// the Java lane
// ---------------------------------------------------------------------------

const typeRec = (fqn, over = {}) => ({
  kind: 'type', fqn, typeKind: 'class', package: fqn.slice(0, fqn.lastIndexOf('.')), annotations: ['RestController'],
  implements: [], file: `${fqn.replace(/\./g, '/')}.java`, ...over,
});
const endpointRec = (httpMethod, path, handler, over = {}) => ({
  kind: 'endpoint', httpMethod, path, handler, line: 10, file: `${handler.slice(0, handler.indexOf('#')).replace(/\./g, '/')}.java`, ...over,
});

/** A small ruoyi-vue-pro: admin and app controllers, one elsewhere, a Feign client, and a route contract. */
function ruoyiFacts() {
  return [
    typeRec('cn.y.module.system.controller.admin.user.UserController'),
    endpointRec('GET', '/system/user/page', 'cn.y.module.system.controller.admin.user.UserController#page'),
    typeRec('cn.y.module.member.controller.app.auth.AppAuthController'),
    endpointRec('POST', '/member/auth/login', 'cn.y.module.member.controller.app.auth.AppAuthController#login'),
    typeRec('cn.y.server.controller.DefaultController'),
    endpointRec('GET', '/ping', 'cn.y.server.controller.DefaultController#ping'),
    typeRec('cn.y.module.infra.controller.admin.PageController', { annotations: ['Controller'] }),
    endpointRec('GET', '/infra/page', 'cn.y.module.infra.controller.admin.PageController#page'),
    typeRec('cn.y.module.system.api.AdminUserApi', { typeKind: 'interface', annotations: ['FeignClient'], client: { kind: 'FeignClient', service: 'system-server', serviceLiteral: true } }),
    endpointRec('GET', '/admin-api/system/user/page', 'cn.y.module.system.api.AdminUserApi#page'),
    typeRec('cn.y.module.system.api.DictApi', { typeKind: 'interface', annotations: [] }),
    endpointRec('GET', '/system/dict/get', 'cn.y.module.system.api.DictApi#get'),
    typeRec('cn.y.module.system.controller.admin.dict.DictController', { implements: ['DictApi'], declaredMethods: ['get/0'] }),
    { kind: 'import', owner: 'cn.y.module.system.controller.admin.dict.DictController', simple: 'DictApi', fqn: 'cn.y.module.system.api.DictApi', file: 'cn/y/module/system/controller/admin/dict/DictController.java' },
    { kind: 'method', fqn: 'cn.y.module.system.controller.admin.dict.DictController#get', owner: 'cn.y.module.system.controller.admin.dict.DictController', line: 20, paramCount: 0, file: 'cn/y/module/system/controller/admin/dict/DictController.java' },
  ];
}

const serialized = (g) => JSON.stringify({ nodes: [...g.nodes.values()], edges: g.edges });

test('the admin and app controllers are served behind their declared prefixes, and nothing else moves', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, ruoyiFacts(), { pathPrefixes: RUOYI_PREFIXES });

  const admin = g.nodes.get(endpointId('GET', '/admin-api/system/user/page'));
  assert.ok(admin, 'the admin route is keyed at its real address');
  assert.equal(admin.path, '/admin-api/system/user/page');
  assert.deepEqual(admin.pathPrefix, {
    value: '/admin-api', from: 'declared', declaration: 'pathPrefixes[0]',
    packages: '**.controller.admin.**', annotation: 'RestController', source: 'WebProperties.adminApi',
  });
  assert.equal(admin.apiGroup, 'system', 'the group is the first segment after the prefix, not the prefix');
  assert.equal(g.nodes.has(endpointId('GET', '/system/user/page')), false, 'no route is left at the address without its prefix');
  assert.ok(g.nodes.get(endpointId('POST', '/app-api/member/auth/login')));
  assert.equal(g.nodes.get(endpointId('POST', '/app-api/member/auth/login')).apiGroup, 'member');

  const ping = g.nodes.get(endpointId('GET', '/ping'));
  assert.ok(ping, 'a controller outside every declared package keeps its address');
  assert.equal('pathPrefix' in ping, false);
  assert.equal('apiGroup' in ping, false, 'apiGroup is set only where a prefix was declared');
  assert.ok(g.nodes.get(endpointId('GET', '/infra/page')), 'a @Controller is not the @RestController the entry asks for');

  const handles = g.edges.find((e) => e.type === 'HANDLES' && e.from === endpointId('GET', '/admin-api/system/user/page'));
  assert.equal(handles.grade, 'EXACT', 'a declaration is the project\'s word: the grade is the mapping\'s');
  assert.equal(handles.evidence.rule, 'route-path-prefix');
  assert.equal(handles.evidence.prefix.declaration, 'pathPrefixes[0]');
  assert.equal(g.edges.find((e) => e.type === 'HANDLES' && e.from === endpointId('GET', '/ping')).evidence ?? null, null);

  assert.deepEqual(stats.pathPrefixes.map((p) => [p.prefix, p.routes]), [['/admin-api', 2], ['/app-api', 1]]);
});

test('a client calls the address it writes, and lands on the route now served there', () => {
  const g = new Graph();
  addJavaFacts(g, ruoyiFacts(), { pathPrefixes: RUOYI_PREFIXES });
  const call = g.edges.find((e) => e.type === 'CALLS_HTTP' && e.from === symbolId('cn.y.module.system.api.AdminUserApi#page'));
  assert.equal(call.to, endpointId('GET', '/admin-api/system/user/page'));
  assert.equal(call.grade, 'SOUND_SET', 'the route it calls is served in this pack');
});

test('a route contract is served under the prefix of the class that implements it', () => {
  const g = new Graph();
  addJavaFacts(g, ruoyiFacts(), { pathPrefixes: RUOYI_PREFIXES });
  const route = g.nodes.get(endpointId('GET', '/admin-api/system/dict/get'));
  assert.ok(route, 'the implementer sits in an admin package');
  const handles = g.edges.find((e) => e.type === 'HANDLES' && e.from === route.id);
  assert.equal(handles.evidence.rule, 'route-contract-impl', 'the contract rule still says how the handler was found');
  assert.equal(handles.evidence.prefix.value, '/admin-api');
});

test('the FIRST entry a class passes is the one it is served under, as in Spring', () => {
  const facts = ruoyiFacts();
  const g1 = new Graph();
  addJavaFacts(g1, facts, { pathPrefixes: [{ prefix: '/first', packages: '**.system.**' }, { prefix: '/second', annotation: 'RestController' }] });
  assert.ok(g1.nodes.get(endpointId('GET', '/first/system/user/page')));
  assert.ok(g1.nodes.get(endpointId('GET', '/second/ping')));
  const g2 = new Graph();
  addJavaFacts(g2, facts, { pathPrefixes: [{ prefix: '/second', annotation: 'RestController' }, { prefix: '/first', packages: '**.system.**' }] });
  assert.ok(g2.nodes.get(endpointId('GET', '/second/system/user/page')), 'order is part of the declaration');
});

test('an entry with neither test applies to every controller; one no class passes is counted at zero', () => {
  const g = new Graph();
  const stats = addJavaFacts(g, ruoyiFacts(), { pathPrefixes: [{ prefix: '/api' }, { prefix: '/never', packages: 'org.nowhere.**' }] });
  assert.ok(g.nodes.get(endpointId('GET', '/api/infra/page')));
  assert.deepEqual(stats.pathPrefixes.map((p) => p.routes), [5, 0]);
});

test('a project that declares no prefix gets the graph and the stats it always got', () => {
  const g0 = new Graph();
  const s0 = addJavaFacts(g0, ruoyiFacts());
  const g1 = new Graph();
  const s1 = addJavaFacts(g1, ruoyiFacts(), { pathPrefixes: [] });
  assert.equal(serialized(g1), serialized(g0));
  assert.equal('pathPrefixes' in s0, false);
  assert.equal('pathPrefixes' in s1, false);
  assert.ok(g0.nodes.get(endpointId('GET', '/system/user/page')));
});

// ---------------------------------------------------------------------------
// a prefix set in code, said when the profile is silent
// ---------------------------------------------------------------------------

const invocations = (file, pairs) => ({ kind: 'invocations', names: pairs.map((p) => p[0]), lines: pairs.map((p) => p[1]), file });
const CONFIG_FILE = 'yudao-framework/src/main/java/cn/y/framework/web/config/YudaoWebAutoConfiguration.java';

test('a call to setPathPrefixes with pathPrefixes undeclared is said, with the file, the line and the key', () => {
  const facts = [
    invocations(CONFIG_FILE, [['buildPathPrefixes', 60], ['setPathPrefixes', 53]]),
    invocations('cn/y/Other.java', [['append', 3]]),
  ];
  const said = codeSettingDiagnostics(facts, normalizeProfile({}));
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'SETTING_IN_CODE');
  assert.equal(said[0].key, 'pathPrefixes');
  assert.match(said[0].reason, new RegExp(`${CONFIG_FILE.replace(/[.]/g, '\\.')}:53 calls RequestMappingHandlerMapping\\.setPathPrefixes`));
  assert.match(said[0].reason, /declare it as `pathPrefixes` in the profile \(rule spring-mvc\.path-prefixes\)/);
  assert.doesNotMatch(said[0].reason, /[—·]/, 'no em dash, no middle dot');
});

test('a declared pathPrefixes is the project\'s word, and a project with no such call hears nothing', () => {
  const facts = [invocations(CONFIG_FILE, [['setPathPrefixes', 53]])];
  assert.deepEqual(codeSettingDiagnostics(facts, normalizeProfile({ pathPrefixes: RUOYI_PREFIXES })), []);
  assert.deepEqual(codeSettingDiagnostics([invocations('a/B.java', [['addPrefix', 4]])], normalizeProfile({})), []);
  assert.deepEqual(codeSettingDiagnostics([], normalizeProfile({})), []);
});

test('many call sites are said in one line, the first three by place', () => {
  const facts = ['d', 'c', 'b', 'a'].map((x, i) => invocations(`${x}/Config.java`, [['addPathPrefix', 10 + i]]));
  const found = codeSettingsIn(facts, builtinRegistry().ofKind('java.code-setting'));
  assert.deepEqual(found.map((f) => f.file), ['a/Config.java', 'b/Config.java', 'c/Config.java', 'd/Config.java']);
  const [said] = codeSettingDiagnostics(facts, normalizeProfile({}));
  assert.match(said.reason, /a\/Config\.java:13 calls PathMatchConfigurer\.addPathPrefix; b\/Config\.java:12 .*; c\/Config\.java:11 .* and 1 more:/);
});

// ---------------------------------------------------------------------------
// what `analyze` says once the prefixes are declared
// ---------------------------------------------------------------------------

test('a declared entry no controller class passed is said, with what it tests', () => {
  const notes = unusedPrefixNotes({ pathPrefixes: [
    { prefix: '/admin-api', packages: '**.controller.admin.**', annotation: 'RestController', routes: 3 },
    { prefix: '/app-api', packages: '**.controler.app.**', annotation: 'RestController', routes: 0 },
  ] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'PATH_PREFIX_UNUSED');
  assert.match(notes[0].reason, /^pathPrefixes\[1\] \(\/app-api\) is put before no route: no controller class this run read carries @RestController and sits in a package that \*\*\.controler\.app\.\*\* matches/);
  assert.deepEqual(unusedPrefixNotes({}), [], 'nothing declared, nothing said');
});

/** The admin route served behind /admin-api, and one frontend call that missed it. */
function graphWithAMissedCall(template) {
  const g = new Graph();
  const stats = addJavaFacts(g, ruoyiFacts(), { pathPrefixes: RUOYI_PREFIXES });
  const fn = 'symbol:front/src/api/system/user/index.ts#getUserPage';
  g.addNode({ id: fn, lane: 'web' });
  g.addNode({ id: `endpoint:GET ${template}`, path: template, httpMethod: 'GET', outbound: true, source: 'web' });
  g.addEdge({ from: fn, to: `endpoint:GET ${template}`, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence: {
    rule: 'web-http-call', sink: { kind: 'untraced' }, url: { written: '/system/user/page', template }, target: 'outside-pack',
  } });
  return { g, stats };
}

test('a frontend call that misses only for want of the declared prefix names the gatewayRoutes that settles it', () => {
  const { g, stats } = graphWithAMissedCall('/system/user/page');
  const [note] = prefixNotOnCallsNotes(g, stats);
  assert.equal(note.kind, 'PREFIX_NOT_ON_CALLS');
  assert.equal(note.key, 'gatewayRoutes');
  assert.match(note.reason, /^1 of 1 frontend call\(s\) that name no route here would name one with \/admin-api before them/);
  assert.match(note.reason, /declare gatewayRoutes \{"\*": "\/admin-api"\}/);
  // The call was traced to no client, so no client's base URL could have put
  // the prefix there, however well it was read (R2-B).
  assert.match(note.reason, /1 of them were traced to no client/);
  const settled = graphWithAMissedCall('/admin-api/system/user/nothing');
  assert.deepEqual(prefixNotOnCallsNotes(settled.g, settled.stats), [], 'a call that already carries the prefix and still misses is not this');
  const g0 = new Graph();
  assert.deepEqual(prefixNotOnCallsNotes(g0, addJavaFacts(g0, ruoyiFacts())), [], 'no declaration, no note');
});

test('the working-tree overlay puts the declared prefixes where the certified run put them', () => {
  const fqn = 'cn.y.module.system.controller.admin.user.UserController';
  const file = `${fqn.replace(/\./g, '/')}.java`;
  const shard = [typeRec(fqn), endpointRec('GET', '/system/user/page', `${fqn}#page`)];
  const baseShards = new Map([[file, shard]]);
  const baseGraph = buildGraphFromSql([], []);
  addJavaFacts(baseGraph, assembleJavaFacts(baseShards), { pathPrefixes: RUOYI_PREFIXES });
  const edited = shard.map((r) => (r.kind === 'endpoint' ? { ...r, line: 11 } : r));
  const r = overlayGraph({
    bridges: { buildGraphFromSql, addJavaFacts }, baseShards, dirtyFacts: new Map([[file, edited]]), dirtyFiles: [file],
    baseGraph, overlaySessionId: 'a'.repeat(64), pathPrefixes: RUOYI_PREFIXES,
  });
  assert.ok(r.graph.nodes.has(endpointId('GET', '/admin-api/system/user/page')));
  assert.deepEqual(r.provisional.endpoints, [], 'an edited controller is not a new route because the overlay forgot the prefix');
});
