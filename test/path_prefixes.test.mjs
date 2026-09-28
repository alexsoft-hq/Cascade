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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findJdk } from '../src/cli/env.mjs';
import { runJavaLane } from '../src/cli/lanes_run.mjs';
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
import { builtinRegistry, buildRegistry, RuleError } from '../src/core/rules/registry.mjs';
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

/** An invocations record as the worker writes it: each name's first line, and its receivers as `[declared type, line]` (the type given, or `?`). */
const invocations = (file, pairs, receiver = '?') => ({
  kind: 'invocations', names: pairs.map((p) => p[0]), lines: pairs.map((p) => p[1]),
  receivers: pairs.map((p) => [[p[2] ?? receiver, p[1]]]), file,
});
/** The import record the Java worker writes for a file's top-level type (`simple` "*" for a whole package). */
const importOf = (file, fqn, simple = fqn.slice(fqn.lastIndexOf('.') + 1)) => ({ kind: 'import', owner: `x.${file}`, simple, fqn, file });
const MVC_MAPPING = 'org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping';
const MVC_CONFIGURER = 'org.springframework.web.servlet.config.annotation.PathMatchConfigurer';
const CONFIG_FILE = 'yudao-framework/src/main/java/cn/y/framework/web/config/YudaoWebAutoConfiguration.java';

test('a call to setPathPrefixes with pathPrefixes undeclared is said, with the file, the line and the key', () => {
  const facts = [
    invocations(CONFIG_FILE, [['buildPathPrefixes', 60], ['setPathPrefixes', 53, 'RequestMappingHandlerMapping']]),
    importOf(CONFIG_FILE, MVC_MAPPING),
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
  const facts = [invocations(CONFIG_FILE, [['setPathPrefixes', 53]]), importOf(CONFIG_FILE, MVC_MAPPING)];
  assert.deepEqual(codeSettingDiagnostics(facts, normalizeProfile({ pathPrefixes: RUOYI_PREFIXES })), []);
  assert.deepEqual(codeSettingDiagnostics([invocations('a/B.java', [['addPrefix', 4]])], normalizeProfile({})), []);
  assert.deepEqual(codeSettingDiagnostics([], normalizeProfile({})), []);
});

test('many call sites are said in one line, the first three by place', () => {
  const facts = ['d', 'c', 'b', 'a'].flatMap((x, i) => [invocations(`${x}/Config.java`, [['addPathPrefix', 10 + i]], 'PathMatchConfigurer'), importOf(`${x}/Config.java`, MVC_CONFIGURER)]);
  const found = codeSettingsIn(facts, builtinRegistry().ofKind('java.code-setting'));
  assert.deepEqual(found.map((f) => f.file), ['a/Config.java', 'b/Config.java', 'c/Config.java', 'd/Config.java']);
  const [said] = codeSettingDiagnostics(facts, normalizeProfile({}));
  assert.match(said.reason, /a\/Config\.java:13 calls PathMatchConfigurer\.addPathPrefix; b\/Config\.java:12 .*; c\/Config\.java:11 .* and 1 more:/);
});

test('code_setting_does_not_assert_receiver_from_bare_method_name: a call is the setting only where its file can name the type that declares it', () => {
  const rules = builtinRegistry().ofKind('java.code-setting');
  // class Storage { void addPathPrefix(String d){} void save(){ addPathPrefix("/backup"); } }
  const storage = [invocations('p/Storage.java', [['addPathPrefix', 1]]), { kind: 'type', fqn: 'p.Storage', package: 'p', file: 'p/Storage.java' }];
  assert.deepEqual(codeSettingsIn(storage, rules), [], 'a method of its own with the name is not PathMatchConfigurer.addPathPrefix');
  assert.deepEqual(codeSettingDiagnostics(storage, normalizeProfile({})), [], 'and nothing asks for pathPrefixes because of it');
  const other = [invocations('p/Other.java', [['addPathPrefix', 4]]), importOf('p/Other.java', 'com.acme.paths.PathMatchConfigurer')];
  assert.deepEqual(codeSettingsIn(other, rules), [], 'a type of that simple name from another package is not the one the rule names');
  const byImport = [invocations('p/Web.java', [['addPathPrefix', 7]]), importOf('p/Web.java', MVC_CONFIGURER)];
  assert.deepEqual(codeSettingsIn(byImport, rules).map((f) => [f.on, f.line]), [['PathMatchConfigurer', 7]]);
  const byPackage = [invocations('p/Web.java', [['addPathPrefix', 7]]), importOf('p/Web.java', 'org.springframework.web.servlet.config.annotation', '*')];
  assert.deepEqual(codeSettingsIn(byPackage, rules).map((f) => f.method), ['addPathPrefix'], 'a package imported whole names the type too');
  const flux = [invocations('p/Flux.java', [['addPathPrefix', 5]]), importOf('p/Flux.java', 'org.springframework.web.reactive.config.PathMatchConfigurer')];
  assert.deepEqual(codeSettingsIn(flux, rules).map((f) => f.method), ['addPathPrefix'], 'WebFlux declares the same method on its own type');
});

/** The worker's records for a few Java files, read once; null without a JDK. */
const workerFactsCache = new Map();
function workerFacts(sources) {
  const key = JSON.stringify(sources);
  if (workerFactsCache.has(key)) return workerFactsCache.get(key);
  const jdk = findJdk();
  if (!jdk) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-setting-'));
  fs.mkdirSync(path.join(dir, 'p'));
  for (const [name, body] of Object.entries(sources)) fs.writeFileSync(path.join(dir, 'p', name), body);
  try { workerFactsCache.set(key, runJavaLane(jdk, dir, [dir], { quiet: true })); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return workerFactsCache.get(key);
}

/** Astra's second review, and the shapes around it. */
const RECEIVER_SOURCES = {
  'FullyQualified.java': 'package p; class FullyQualified { void config(org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping mapping){ mapping.setPathPrefixes(null); } }',
  'UnrelatedSetting.java': 'package p; import org.springframework.web.servlet.config.annotation.PathMatchConfigurer; class UnrelatedSetting { void config(PathMatchConfigurer ignored, Storage storage){storage.addPathPrefix("/backup");} }',
  'Imported.java': 'package p; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class Imported { void config(RequestMappingHandlerMapping mapping){ mapping.setPathPrefixes(null); } }',
  'Created.java': 'package p; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class Created { Object m(){ return new RequestMappingHandlerMapping() { { setPathPrefixes(null); } }; } void n(){ new RequestMappingHandlerMapping().setPathPrefixes(null); } }',
  'OwnMapping.java': 'package p; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class OwnMapping extends RequestMappingHandlerMapping { OwnMapping(){ setPathPrefixes(null); } }',
  'Chained.java': 'package p; import org.springframework.web.servlet.config.annotation.*; class Chained implements WebMvcConfigurer { public void configurePathMatch(PathMatchConfigurer c){ c.setUseTrailingSlashMatch(false).addPathPrefix("/api", t -> true); } }',
  'Shadow.java': 'package p; import org.springframework.web.servlet.config.annotation.PathMatchConfigurer; class Shadow { PathMatchConfigurer configurer; void save(Storage configurer){ configurer.addPathPrefix("/backup"); } }',
};

test('javafacts/19: each name a file calls carries the type its receiver is declared with, where the file writes one', (t) => {
  const f = workerFacts(RECEIVER_SOURCES);
  if (!f) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  const rec = (file) => f.find((r) => r.kind === 'invocations' && r.file?.endsWith(file));
  const receiversOf = (file, name) => { const r = rec(file); return r.receivers[r.names.indexOf(name)]; };
  assert.deepEqual(receiversOf('FullyQualified.java', 'setPathPrefixes'), [['org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping', 1]]);
  assert.deepEqual(receiversOf('UnrelatedSetting.java', 'addPathPrefix'), [['Storage', 1]]);
  assert.deepEqual(receiversOf('OwnMapping.java', 'setPathPrefixes'), [['this:p.OwnMapping', 1]]);
  assert.deepEqual(receiversOf('Created.java', 'setPathPrefixes'), [['?', 1], ['RequestMappingHandlerMapping', 1]], 'new X() states its type; an anonymous class\'s own call does not name one');
  assert.deepEqual(receiversOf('Chained.java', 'addPathPrefix'), [['?', 1]], 'a chain\'s type is the return of the call before it, which is not read');
  assert.deepEqual(receiversOf('Shadow.java', 'addPathPrefix'), [['Storage', 1]], 'a parameter hides the field of the same name');
});

test('code_setting_fully_qualified_receiver_is_diagnosed and code_setting_import_does_not_prove_unrelated_receiver: the receiver\'s declared type decides', (t) => {
  const f = workerFacts(RECEIVER_SOURCES);
  if (!f) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  const found = codeSettingsIn(f, builtinRegistry().ofKind('java.code-setting'));
  const by = Object.fromEntries(['FullyQualified', 'UnrelatedSetting', 'Imported', 'Created', 'OwnMapping', 'Chained', 'Shadow']
    .map((n) => [n, found.filter((x) => x.file.endsWith(`${n}.java`)).map((x) => x.proof)]));
  assert.deepEqual(by, {
    FullyQualified: ['receiver'], UnrelatedSetting: [], Imported: ['receiver'], Created: ['receiver'],
    OwnMapping: ['receiver'], Chained: ['import'], Shadow: [],
  });
  const [said] = codeSettingDiagnostics(f.filter((r) => r.file?.endsWith('Chained.java')), normalizeProfile({}));
  assert.equal(said.severity, 'info', 'a receiver nobody proved is a lower note');
  assert.match(said.reason, /calls addPathPrefix on a receiver whose type is not read, in a file that imports PathMatchConfigurer/);
  assert.match(said.reason, /none of these receivers is proven to be the type the rule names/);
});

/** The worker's records for files laid out by package path; null without a JDK. */
const treeFactsCache = new Map();
function treeFacts(files) {
  const key = JSON.stringify(files);
  if (treeFactsCache.has(key)) return treeFactsCache.get(key);
  const jdk = findJdk();
  if (!jdk) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-setting-tree-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  try { treeFactsCache.set(key, runJavaLane(jdk, dir, [dir], { quiet: true })); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return treeFactsCache.get(key);
}

/** Astra's third review: a name another type shadows, and receivers a tree states without the rule's type written at the call. */
const SHADOW_SOURCES = {
  'com/x/A.java': 'package com.x; import org.springframework.web.servlet.config.annotation.*; import com.x.util.PathMatchConfigurer; class A implements WebMvcConfigurer { void cfg(PathMatchConfigurer c){ c.addPathPrefix("/backup", null); } }',
  'com/x/util/PathMatchConfigurer.java': 'package com.x.util; public class PathMatchConfigurer { public void addPathPrefix(String p, Object o){} }',
  'com/y/B.java': 'package com.y; import org.springframework.web.servlet.config.annotation.*; class B { void cfg(PathMatchConfigurer c){ c.addPathPrefix("/b", null); } }',
  'com/y/PathMatchConfigurer.java': 'package com.y; class PathMatchConfigurer { void addPathPrefix(String p, Object o){} }',
  'com/z/MyMapping.java': 'package com.z; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; public class MyMapping extends RequestMappingHandlerMapping {}',
  'com/z/C.java': 'package com.z; class C { void cfg(){ MyMapping m = new MyMapping(); m.setPathPrefixes(null); } }',
  'com/w/D.java': 'package com.w; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class D { void cfg(){ var m = new RequestMappingHandlerMapping(); m.setPathPrefixes(null); } }',
  'com/v/E.java': 'package com.v; class E { void cfg(){ var m = new org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping(); m.setPathPrefixes(null); } }',
  'com/u/Base.java': 'package com.u; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class Base { protected RequestMappingHandlerMapping mapping; }',
  'com/u/F.java': 'package com.u; class F extends Base { void cfg(){ mapping.setPathPrefixes(null); } }',
  'com/t/G.java': 'package com.t; import com.z.MyMapping; class G extends MyMapping { void cfg(){ setPathPrefixes(null); } }',
  'com/s/H.java': 'package com.s; import org.springframework.web.servlet.config.annotation.*; class H { void cfg(PathMatchConfigurer c){ c.addPathPrefix("/h", null); } }',
  'com/r/I.java': 'package com.r; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class I { RequestMappingHandlerMapping mapping; class Inner { void cfg(){ mapping.setPathPrefixes(null); } } }',
  'com/r/K.java': 'package com.r; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; import static com.r.Holder.MAPPING; class K { void cfg(){ MAPPING.setPathPrefixes(null); } }',
  'com/r/Holder.java': 'package com.r; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class Holder { static RequestMappingHandlerMapping MAPPING; }',
  'com/q/OwnMapping.java': 'package com.q; class OwnMapping { void setPathPrefixes(Object o){} }',
  'com/q/BaseJ.java': 'package com.q; class BaseJ { protected OwnMapping mapping; }',
  'com/q/J.java': 'package com.q; import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping; class J extends BaseJ { void cfg(){ mapping.setPathPrefixes(null); } }',
};

test('code_setting_single_type_import_shadows_wildcard, code_setting_same_package_type_shadows_wildcard, code_setting_receiver_subclass_in_tree_is_diagnosed, code_setting_var_new_receiver_is_diagnosed: a name is read as Java reads it, and a receiver the tree states is followed', (t) => {
  const f = treeFacts(SHADOW_SOURCES);
  if (!f) { t.skip('no JDK found: see docs/setup/java-lane.md'); return; }
  const found = codeSettingsIn(f, builtinRegistry().ofKind('java.code-setting'));
  const by = (cls) => found.filter((x) => x.file?.endsWith(`/${cls}.java`)).map((x) => x.proof);
  assert.deepEqual(by('A'), [], 'a single-type import of the project\'s own PathMatchConfigurer shadows the wildcard');
  assert.deepEqual(by('B'), [], 'a type of the file\'s own package shadows the wildcard');
  assert.deepEqual(by('H'), ['receiver'], 'with nothing shadowing it, the wildcard names Spring\'s');
  assert.deepEqual(by('C'), ['receiver'], 'a project subclass of the mapping is the mapping');
  assert.deepEqual(by('D'), ['receiver'], '`var m = new X()` declares m as X');
  assert.deepEqual(by('E'), ['receiver'], 'and with X written in full');
  assert.deepEqual(by('F'), ['receiver'], 'a field the superclass declares');
  assert.deepEqual(by('G'), ['receiver'], 'a call on this, two classes below the mapping');
  assert.deepEqual(by('I'), ['receiver'], 'an outer class field, from an inner class');
  assert.deepEqual(by('K'), ['import'], 'a name no class in the tree declares for it stays unstated: a lower note where the file names the type');
  assert.deepEqual(by('J'), [], 'a superclass field declared as another type is not the setting, whatever the file imports');
});

test('a code-setting call names the types that declare it, in full, or the rule is refused', () => {
  const entry = builtinRegistry().rules.get('spring-mvc.path-prefixes').rule;
  const refused = (calls) => {
    try { buildRegistry([{ where: 'c.json', pack: { pack: 'spring-mvc', version: 1, description: 'x', rules: [{ ...entry, params: { ...entry.params, calls } }] } }]); } catch (e) { if (e instanceof RuleError) return e.problems; throw e; }
    return [];
  };
  assert.deepEqual(refused(entry.params.calls), []);
  const [first] = entry.params.calls;
  assert.ok(refused([{ on: first.on, method: first.method }]).some((p) => /params\.calls\[0\]\.types/.test(p)), 'no types, no rule');
  assert.ok(refused([{ ...first, types: ['org.x.SomethingElse'] }]).some((p) => /params\.calls\[0\]\.types/.test(p)), 'a type whose simple name is not `on`');
  assert.ok(refused([{ ...first, types: [first.on] }]).some((p) => /params\.calls\[0\]\.types/.test(p)), 'a simple name is not a full one');
  assert.ok(entry.examples.some((ex) => /class Storage/.test(ex.source) && ex.expect.length === 0), 'the pack holds the example that must not be read as the setting');
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

/**
 * The admin route served behind /admin-api, and one frontend call that missed
 * it, sent with `method` (null: the web lane could not read one, and keys the
 * call ANY).
 */
function graphWithAMissedCall(template, method = 'GET') {
  const g = new Graph();
  const stats = addJavaFacts(g, ruoyiFacts(), { pathPrefixes: RUOYI_PREFIXES });
  const fn = 'symbol:front/src/api/system/user/index.ts#getUserPage';
  const keyed = method ?? 'ANY';
  g.addNode({ id: fn, lane: 'web' });
  g.addNode({ id: `endpoint:${keyed} ${template}`, path: template, httpMethod: keyed, outbound: true, source: 'web' });
  g.addEdge({ from: fn, to: `endpoint:${keyed} ${template}`, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence: {
    rule: 'web-http-call', sink: { kind: 'untraced' }, url: { written: '/system/user/page', template }, method: { value: method }, target: 'outside-pack',
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

test('prefix_hint_requires_same_http_method: a call is counted only when the prefixed route serves its method', () => {
  const post = graphWithAMissedCall('/system/user/page', 'POST');
  assert.deepEqual(prefixNotOnCallsNotes(post.g, post.stats), [], 'POST /system/user/page, and only GET /admin-api/system/user/page is served: the prefix would not link it');
  const unknown = graphWithAMissedCall('/system/user/page', null);
  assert.equal(prefixNotOnCallsNotes(unknown.g, unknown.stats).length, 1, 'a call whose method was not read matches any, as the web lane matches it');
  const any = graphWithAMissedCall('/system/any', 'POST');
  any.g.addNode({ id: 'endpoint:ANY /admin-api/system/any', path: '/admin-api/system/any', httpMethod: 'ANY' });
  assert.equal(prefixNotOnCallsNotes(any.g, any.stats).length, 1, 'a route declared for any method serves a POST');
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
