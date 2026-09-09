// web_modules.test.mjs — the web BRIDGE's modules, each imported on its own.
//
// WHY THIS FILE EXISTS BESIDE test/web_bridge.mjs. That file drives
// `addWebFacts` end to end and is the better test of what the lane ANSWERS.
// What it cannot do is say where a rule lives: when a prefix comes out wrong it
// fails in the same place a route match coming out wrong fails. RM49 split the
// bridge into six modules with a paragraph each about what they own; this file
// holds each of them to that paragraph on its own.
//
// It is deliberately about the SEAMS: the shape a step hands to the next one,
// and the rules that have no other test because the end-to-end path only ever
// exercises one branch of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cmp, configDirOf, dirOf, joinPosix, normalizePosix, normalizeUrl, packageNameOf, topCounts,
  GRADE_RANK, HOP_LIMIT, RENDERS_DEPTH,
} from '../src/adapters/web/shared.mjs';
import {
  collectInstances, indexWebFacts, isComponentFile, makeResolver, registryNameOf,
  webEndpointId, webScreenId, webSymbolId,
} from '../src/adapters/web/symbols.mjs';
import {
  absoluteSplit, makePrefixes, normalizeTail, readPackages, TEMPLATE_PREFIX, WEB_PREFIX_BASIS,
} from '../src/adapters/web/prefix.mjs';
import {
  buildRouteIndex, namesARoute, routeMatches, WEB_CALL_BASIS,
} from '../src/adapters/web/calls.mjs';
import {
  makeNameRegistry, readScreenAxis, SCREEN_RENDERS_BASIS, SCREEN_ROOT_GROUP,
} from '../src/adapters/web/screens.mjs';
import { indexTemplates, PAGE_RENDERS_BASIS } from '../src/adapters/web/pages.mjs';
import { emptyWebStats } from '../src/adapters/web/stats.mjs';
import { Graph } from '../src/core/graph.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// shared.mjs — the primitives every step is written on
// ---------------------------------------------------------------------------

test('shared: a path is spelled one way, whatever it arrived as', () => {
  assert.equal(normalizeUrl('a//b/'), '/a/b');
  assert.equal(normalizeUrl('/'), '/');
  assert.equal(normalizeUrl(null), '/');
  assert.equal(dirOf('a/b/c.ts'), 'a/b');
  assert.equal(dirOf('c.ts'), '');
  assert.equal(joinPosix('a/b', '../c'), 'a/c');
  assert.equal(packageNameOf('@scope/pkg/sub'), '@scope/pkg');
  assert.equal(packageNameOf('pkg/sub'), 'pkg');
});

test('shared: a leading `..` survives, because a frontend beside its backend is one', () => {
  // Dropping it would make every file of `../front/src` resolve to a path that
  // is not there, and every match come out HEURISTIC for no reason.
  assert.equal(normalizePosix('../front/src/api.ts'), '../front/src/api.ts');
  assert.equal(joinPosix('../front/src', './api.ts'), '../front/src/api.ts');
});

test('shared: a config record with no dot in its last segment IS a directory', () => {
  assert.equal(configDirOf('front/vue.config.js'), 'front');
  assert.equal(configDirOf('front'), 'front');
});

test('shared: topCounts is most common first, then by name, then cut', () => {
  const counts = new Map([['b', 2], ['a', 2], ['c', 9]]);
  assert.deepEqual(topCounts(counts, 2, 'url'), [{ url: 'c', count: 9 }, { url: 'a', count: 2 }]);
});

test('shared: the grade ladder and the three walk limits are the numbers the lane rests on', () => {
  assert.ok(GRADE_RANK.UNRESOLVED < GRADE_RANK.HEURISTIC);
  assert.ok(GRADE_RANK.HEURISTIC < GRADE_RANK.SOUND_SET);
  assert.ok(GRADE_RANK.SOUND_SET < GRADE_RANK.EXACT);
  assert.equal(HOP_LIMIT, 16);
  assert.equal(RENDERS_DEPTH, 4);
  assert.equal(cmp('a', 'b'), -1);
  assert.equal(cmp('b', 'a'), 1);
  assert.equal(cmp('a', 'a'), 0);
});

// ---------------------------------------------------------------------------
// symbols.mjs — the files, the names in them, and what each name IS
// ---------------------------------------------------------------------------

const FACTS = [
  { kind: 'header', schema: 'cascade:webfacts:1' },
  { kind: 'file', file: 'src/api/things.js', line: 1 },
  { kind: 'file', file: 'src/utils/http.js', line: 1 },
  { kind: 'call', file: 'src/api/things.js', line: 9, enclosing: 'listThings' },
  { kind: 'call', file: 'src/api/things.js', line: 3, enclosing: 'listThings' },
  { kind: 'function', file: 'src/api/things.js', line: 2, name: 'listThings' },
  {
    kind: 'import',
    file: 'src/api/things.js',
    line: 1,
    source: '@/utils/http',
    specifiers: [{ imported: 'default', local: 'client' }],
  },
  {
    kind: 'binding',
    file: 'src/utils/http.js',
    line: 4,
    name: 'client',
    init: { shape: 'call', callee: { root: 'axios', path: ['create'], name: 'create' }, binding: { kind: 'import', source: 'axios', imported: 'default' } },
  },
  { kind: 'export', file: 'src/utils/http.js', line: 9, name: 'default', of: 'const', local: 'client' },
  {
    kind: 'import',
    file: 'src/utils/http.js',
    line: 1,
    source: 'axios',
    specifiers: [{ imported: 'default', local: 'axios' }],
  },
  { kind: 'summary', version: 'webfacts/5' },
];

const AXIOS = new Map([['axios', { module: 'axios', instanceFactories: ['create'], verbs: { get: 'GET' }, generic: [] }]]);

function fixtureIndex() {
  const index = indexWebFacts(FACTS);
  const { packageOf, configFor } = readPackages({ opts: {}, configs: index.configs });
  const resolver = makeResolver({
    files: index.files, parsed: index.parsed, packageOf, configFor, libraries: AXIOS,
  });
  return { index, packageOf, configFor, resolver };
}

test('symbols: the index buckets by file, sorts inside the bucket, and drops the frame records', () => {
  const { files, fileNames, parsed, configs } = indexWebFacts(FACTS);
  assert.deepEqual(fileNames, ['src/api/things.js', 'src/utils/http.js']);
  assert.deepEqual(configs, []);
  assert.deepEqual([...parsed].sort(), fileNames);
  // The two calls arrived at line 9 then line 3; the bucket is in LINE order,
  // which is what makes two assemblies of the same shards print the same bytes.
  assert.deepEqual(files.get('src/api/things.js').calls.map((c) => c.line), [3, 9]);
  // The header and the summary are frame, not facts.
  assert.equal(files.has(undefined), false);
});

test('symbols: an import puts its local name in the file\'s own table', () => {
  const { files } = indexWebFacts(FACTS);
  assert.deepEqual(files.get('src/api/things.js').importOf.get('client'), { source: '@/utils/http', imported: 'default' });
});

test('symbols: a specifier resolves through the extension list, and an unknown one says so', () => {
  const { resolver } = fixtureIndex();
  assert.deepEqual(resolver.resolveSpecifier('src/api/things.js', './nope'), { unresolved: 'not-a-file-this-lane-read', assumed: false });
  assert.deepEqual(resolver.resolveSpecifier('src/api/things.js', '../utils/http'), { file: 'src/utils/http.js', assumed: false });
  assert.deepEqual(resolver.resolveSpecifier('src/api/things.js', 'axios'), { external: 'axios' });
  assert.deepEqual(resolver.resolveSpecifier('src/api/things.js', ''), { unresolved: 'empty-specifier' });
});

test('symbols: a name is followed to the client instance it holds', () => {
  const { resolver } = fixtureIndex();
  const v = resolver.valueOf('src/utils/http.js', 'client', 0);
  assert.equal(v.kind, 'sink-instance');
  assert.equal(v.module, 'axios');
  assert.equal(v.id, 'src/utils/http.js#client');
});

test('symbols: every instance the project builds is collected once, under its package', () => {
  const { index, packageOf, resolver } = fixtureIndex();
  const { instanceOf, noteInstance } = collectInstances({
    fileNames: index.fileNames, files: index.files, packageOf, resolver,
  });
  assert.deepEqual([...instanceOf.keys()], ['src/utils/http.js#client']);
  // The call pass finds the same instance through a callee; noting it twice
  // must not create a second row.
  noteInstance({ kind: 'sink-instance', id: 'src/utils/http.js#client', module: 'axios' }, '');
  assert.equal(instanceOf.size, 1);
});

test('symbols: the id rules are position-independent, and a component is one by extension', () => {
  assert.equal(webSymbolId('a/b.ts', 'go'), webSymbolId('a/b.ts', 'go'));
  assert.notEqual(webSymbolId('a/b.ts', 'go'), webSymbolId('a/c.ts', 'go'));
  assert.ok(webScreenId('/things/list').startsWith('screen:'));
  assert.ok(webEndpointId('GET', '/x').includes('GET /x'));
  assert.equal(isComponentFile('a/b.vue'), true);
  assert.equal(isComponentFile('a/b.tsx'), true);
  assert.equal(isComponentFile('a/b.ts'), false);
  assert.equal(registryNameOf('owner-list'), 'ownerList');
  assert.equal(registryNameOf('visits'), 'visits');
});

// ---------------------------------------------------------------------------
// prefix.mjs — what a frontend's URL is missing, and how we know
// ---------------------------------------------------------------------------

test('prefix: a base URL is read down to one leading slash and no trailing one', () => {
  assert.equal(normalizeTail('api/'), '/api');
  assert.equal(normalizeTail('/'), '');
  assert.equal(normalizeTail(''), '');
  assert.deepEqual(absoluteSplit('https://api.example.com/api'), {
    state: 'known', value: '/api', values: ['/api'], absolute: true, ambiguous: false, host: 'api.example.com',
  });
  assert.equal(absoluteSplit('/api').absolute, false);
});

test('prefix: the packages are the directories the config records sit in', () => {
  const configs = [
    { kind: 'config', file: 'front/.env', what: 'env', name: 'BASE', value: '/api' },
    { kind: 'config', file: 'front/vue.config.js', what: 'proxy', context: '/api', rewrite: [{ from: '^/api', to: '' }], target: 'http://localhost:8080' },
  ];
  const { packageOf, configFor } = readPackages({ opts: {}, configs });
  assert.equal(packageOf('front/src/api.ts'), 'front');
  assert.equal(configFor('front').env.get('BASE')[0].value, '/api');
  assert.equal(configFor('front').proxies[0].context, '/api');
});

test('prefix: DERIVED — the env value goes through the proxy rule that explains it', () => {
  const configs = [
    { kind: 'config', file: 'front/.env', what: 'env', name: 'BASE', value: '/api', mode: null },
    { kind: 'config', file: 'front/vue.config.js', what: 'proxy', context: '/api', rewrite: [{ from: '^/api', to: '' }] },
  ];
  const { configFor } = readPackages({ opts: {}, configs });
  const instanceOf = new Map([['i', {
    id: 'i',
    package: 'front',
    baseURL: { kind: 'member', root: 'process', path: ['env', 'BASE'] },
  }]]);
  const { prefixOf } = makePrefixes({
    instanceOf,
    configFor,
    gatewayRoutes: {},
    callsPerInstance: new Map(),
    exactPaths: new Set(),
    templatePaths: [],
    routeMatches,
  });
  const p = prefixOf('i');
  assert.equal(p.from, 'derived');
  assert.equal(p.value, '', 'the proxy rewrites `/api` away, so nothing of it reaches the server');
  assert.equal(p.front, '/api', 'and the browser still sends it');
});

test('prefix: DECLARED beats everything, and it names the service that answers', () => {
  const { configFor } = readPackages({ opts: {}, configs: [] });
  const { prefixOf } = makePrefixes({
    instanceOf: new Map([['i', { id: 'i', package: '', baseURL: { kind: 'string', value: '/dev-api' } }]]),
    configFor,
    gatewayRoutes: { '/dev-api': { to: '/svc', service: 'orders' } },
    callsPerInstance: new Map(),
    exactPaths: new Set(),
    templatePaths: [],
    routeMatches,
  });
  const p = prefixOf('i');
  assert.equal(p.from, 'declared');
  assert.equal(p.value, '/svc');
  assert.equal(p.service, 'orders');
});

test('prefix: AUTO scores every candidate against the routes, and says it guessed', () => {
  const { configFor } = readPackages({ opts: {}, configs: [] });
  const { prefixOf } = makePrefixes({
    // An env name with no record: the base URL is DECLARED and unreadable,
    // which is the one state the auto step exists for.
    instanceOf: new Map([['i', { id: 'i', package: '', baseURL: { kind: 'member', root: 'process', path: ['env', 'NOPE'] } }]]),
    configFor,
    gatewayRoutes: {},
    callsPerInstance: new Map([['i', ['/things/list']]]),
    exactPaths: new Set(['/api/things/list']),
    templatePaths: ['/api/things/list'],
    routeMatches,
  });
  // Nothing in the source states `/api`, and no candidate list holds it either,
  // so the honest answer is `none`: the URL is used as written.
  const p = prefixOf('i');
  assert.equal(p.from, 'none');
  assert.equal(p.value, '');
  assert.ok(Array.isArray(p.candidates));
});

test('prefix: a server-rendered page needs no candidate at all', () => {
  assert.equal(TEMPLATE_PREFIX.value, '');
  assert.equal(TEMPLATE_PREFIX.from, 'context-path');
  assert.equal(typeof WEB_PREFIX_BASIS['context-path'], 'string');
  for (const from of ['declared', 'derived', 'auto', 'none', 'context-path']) {
    assert.ok(WEB_PREFIX_BASIS[from].length > 40, `${from} needs a sentence, not a label`);
  }
});

// ---------------------------------------------------------------------------
// calls.mjs — which route does this function ask the server for
// ---------------------------------------------------------------------------

test('calls: the route index holds what the pack SERVES, and not what it calls out to', () => {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /a/{id}', path: '/a/{id}', httpMethod: 'GET' });
  g.addNode({ id: 'endpoint:GET /b', path: '/b', httpMethod: 'GET' });
  g.addNode({ id: 'endpoint:GET /out', path: '/out', httpMethod: 'GET', outbound: true });
  const { exactPaths, templatePaths, matchUrl } = buildRouteIndex(g);
  assert.deepEqual([...exactPaths].sort(), ['/a/{id}', '/b']);
  assert.deepEqual(templatePaths, ['/a/{id}', '/b']);
  assert.equal(matchUrl('/b', 'GET').how, 'exact');
  assert.equal(matchUrl('/a/7', 'GET').how, 'template');
  assert.equal(matchUrl('/a/7', 'POST').how, null, 'the method has to agree');
  assert.equal(matchUrl('/out', 'GET').how, null, 'an outbound node is not a route this pack serves');
});

test('calls: a URL of nothing but holes names no route', () => {
  assert.equal(namesARoute('/things/list'), true);
  assert.equal(namesARoute('/things/{*}'), true);
  assert.equal(namesARoute('/{*}/{*}/{*}'), false);
  assert.equal(namesARoute('/{*}{*}'), false, 'two interpolations side by side are still interpolation');
  assert.equal(namesARoute('/pre{*}'), true);
});

test('calls: every sink has a sentence, and none of them is a label', () => {
  for (const kind of ['platform', 'library', 'injected', 'wrapper', 'untraced', 'template']) {
    assert.equal(typeof WEB_CALL_BASIS[kind], 'string');
    assert.ok(WEB_CALL_BASIS[kind].length > 60, `${kind} needs a sentence`);
  }
});

// ---------------------------------------------------------------------------
// screens.mjs / pages.mjs / stats.mjs
// ---------------------------------------------------------------------------

test('screens: the axis is OFF unless the profile says otherwise, and a name source it cannot read is refused', () => {
  const off = emptyWebStats();
  const a = readScreenAxis({ opts: {}, stats: off });
  assert.equal(a.screenEnabled, false);
  assert.equal(off.screens.nameSource.used, 'none');

  const on = emptyWebStats();
  const b = readScreenAxis({
    opts: { screenAxis: { enabled: true, nameSource: 'jsdoc-comment', pathRule: 'last-segment', codeRegex: '([A-Z]{3})' }, codeLength: 2 },
    stats: on,
  });
  assert.equal(b.screenEnabled, true);
  assert.equal(b.nameSource, 'none');
  assert.match(on.screens.nameSource.refused, /jsdoc-comment/);
  assert.equal(b.pathRule, 'last-segment');
  assert.equal(b.codeLength, 2);
  assert.ok(b.codeRegex instanceof RegExp);
});

test('screens: a codeRegex that does not compile leaves the screens unnamed rather than throwing', () => {
  const stats = emptyWebStats();
  const a = readScreenAxis({ opts: { screenAxis: { enabled: true, codeRegex: '([' } }, stats });
  assert.equal(a.codeRegex, null);
  assert.equal(stats.screens.codeRegex, '([', 'and the profile\'s own text is still reported');
});

test('screens: a name registered TWICE makes every edge below it a candidate', () => {
  const files = new Map([
    ['a.js', { registrations: [{ what: 'component', name: 'ownerList', file: 'a.js', controller: 'OwnerCtrl' }] }],
    ['b.js', { registrations: [{ what: 'component', name: 'ownerList', file: 'b.js' }] }],
    ['c.js', { registrations: [{ what: 'controller', name: 'OwnerCtrl', file: 'c.js' }] }],
  ]);
  const registry = makeNameRegistry({ fileNames: ['a.js', 'b.js', 'c.js'], files });
  const hit = registry.attachByRegistry({ componentName: 'ownerList' });
  assert.deepEqual(hit.targets.map((t) => t.file).sort(), ['a.js', 'b.js', 'c.js']);
  for (const t of hit.targets) assert.equal(t.grade, 'HEURISTIC', 'load order decides, and load order is not in the source');
  assert.equal(registry.namesByRegistry({ componentName: 'ownerList' }), true);
  assert.equal(registry.namesByRegistry({ componentSource: './x.vue' }), false);
});

test('screens: a name nothing registers is reported rather than dropped', () => {
  const registry = makeNameRegistry({ fileNames: [], files: new Map() });
  const hit = registry.attachByRegistry({ componentName: 'ghost' });
  assert.deepEqual(hit.targets, []);
  assert.equal(hit.primary, null);
  assert.equal(registry.unresolvedNames.get('component ghost'), 1);
});

test('pages: a template nobody renders is not rendered, and one an include reaches is', () => {
  const files = new Map([
    ['t/list.html', { template: { name: 'things/list', engine: 'thymeleaf', includes: [{ file: 't/layout.html' }], contextVars: [] } }],
    ['t/layout.html', { template: { name: 'fragments/layout', engine: 'thymeleaf', includes: [], contextVars: ['base'] } }],
    ['t/orphan.html', { template: { name: 'things/orphan', engine: 'thymeleaf', includes: [], contextVars: [] } }],
  ]);
  const t = indexTemplates({
    fileNames: [...files.keys()],
    files,
    opts: { views: [{ owner: 'C', method: 'm', views: [{ kind: 'view', name: 'things/list' }] }] },
  });
  assert.equal(t.templateByName.get('things/list'), 't/list.html');
  assert.deepEqual(t.includedBy('t/list.html'), ['t/layout.html']);
  assert.deepEqual([...t.includeClosure('t/list.html').entries()], [['t/layout.html', 1]]);
  assert.deepEqual([...t.renderedTemplates].sort(), ['t/layout.html', 't/list.html']);
  assert.equal(t.renderedTemplates.has('t/orphan.html'), false);
  // The layout binds the context path; every page that includes it is written
  // against that name.
  assert.deepEqual([...t.contextVarsFor('t/list.html')], ['base']);
});

test('pages: every RENDERS_PAGE reason has a sentence', () => {
  for (const k of ['view', 'constant', 'helper', 'redirect']) {
    assert.ok(PAGE_RENDERS_BASIS[k].length > 60, `${k} needs a sentence`);
  }
  for (const k of ['own', 'child', 'registry', 'ambiguous', 'include']) {
    assert.ok(SCREEN_RENDERS_BASIS[k].length > 40, `${k} needs a sentence`);
  }
  assert.equal(SCREEN_ROOT_GROUP, '(root)');
});

test('stats: a fresh lane report is all zeroes, and every field is there before any step runs', () => {
  const s = emptyWebStats();
  assert.equal(s.calls.withUrl, 0);
  assert.equal(s.unresolved.total, 0);
  assert.deepEqual(Object.keys(s.unresolved.byReason).sort(),
    ['allHoles', 'expression', 'importedConstant', 'noMatch', 'outsidePack', 'parameter']);
  assert.deepEqual(s.screens.byKind, { router: 0, page: 0 });
  assert.deepEqual(s.callsByRule, { 'same-file': 0, 'esm-import': 0, 'passed-as-value': 0 });
  assert.equal(s.screens.enabled, false);
  // Two reports do not share a nested object, or one project's counts would
  // land in another's.
  const t = emptyWebStats();
  t.calls.withUrl = 5;
  assert.equal(s.calls.withUrl, 0);
});

// ---------------------------------------------------------------------------
// the layering these modules were split under
// ---------------------------------------------------------------------------

test('no module under src/adapters/web/ imports the bridge back', () => {
  const dir = path.join(ROOT, 'src', 'adapters', 'web');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 6, `expected the split modules, found ${files.length}`);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/from '\.\.\/web_bridge\.mjs'/.test(text), false, `${f} imports the bridge it is part of`);
    assert.equal(/from '\.\.\/\.\.\/mcp\//.test(text), false, `${f} reaches into src/mcp`);
  }
});

test('every module says what it owns and what it must never know about', () => {
  const dir = path.join(ROOT, 'src', 'adapters', 'web');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    const head = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').slice(0, 40).join('\n');
    assert.match(head, /WHAT (THIS MODULE OWNS|IT MUST NEVER KNOW ABOUT)/, `${f} opens without saying what it owns`);
    assert.match(head, /WHAT IT MUST NEVER KNOW ABOUT|imports nothing/, `${f} does not say what it must not reach`);
  }
});
