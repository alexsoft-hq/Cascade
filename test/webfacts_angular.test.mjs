// webfacts_angular.test.mjs — a frontend written BEFORE modules (round RM47).
//
// The gateway of spring-petclinic-microservices ships AngularJS 1.x as
// `<script>` tags: no imports, no package.json, one global `angular` object and
// a registry of NAMES. Everything the web lane knew how to read was a module
// system, so on a tree like that it read nine "calls with a URL" of which eight
// were router declarations, and zero of the real `$http` calls.
//
// The fixture under test/fixtures/web-angular is that shape, small: a
// `$stateProvider` chain, a `$routeProvider.when`, components and controllers
// registered by name, templates that mount one component inside another by
// writing its tag, a name registered twice, and a tag registered nowhere.
//
// The worker is SPAWNED, like the other worker tests: the thing under test is a
// program with a JSONL contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-angular');
const SRC = path.join(FIXTURE, 'static', 'scripts');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, SRC], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SUMMARY = RECORDS[RECORDS.length - 1];
const BODY = RECORDS.slice(1, -1);

const routes = BODY.filter((r) => r.kind === 'route');
const registrations = BODY.filter((r) => r.kind === 'registration');
const calls = BODY.filter((r) => r.kind === 'call');
const named = (name) => {
  const hit = routes.filter((r) => r.name === name);
  assert.equal(hit.length, 1, `expected one route named ${name}, got ${hit.length}`);
  return hit[0];
};

// ---------------------------------------------------------------------------
// The chain registrar
// ---------------------------------------------------------------------------

test('every link of a $stateProvider chain is one route, with its own line', () => {
  const chain = routes.filter((r) => r.file.endsWith('app.js'));
  assert.deepEqual(chain.map((r) => r.name), ['shell', 'things', 'shell.ghost', 'twins', 'boxes']);
  // Every `.state(…)` of one chain STARTS where the whole expression starts, so
  // the line has to come from the method name or all five share one.
  assert.equal(new Set(chain.map((r) => r.line)).size, 5);
  for (const r of chain) {
    assert.equal(r.pack, 'angular-router');
    assert.equal(r.via, 'chain');
    assert.equal(r.receiver, '$stateProvider');
  }
});

test('a state says its own url, its parent and whether it is abstract', () => {
  assert.deepEqual(
    [named('shell').path, named('shell').abstract, named('shell').parentName],
    ['', true, undefined],
    'the shell state mounts nothing and has no parent',
  );
  assert.equal(named('things').path, '/things');
  assert.equal(named('things').parentName, 'shell');
  assert.equal(named('things').abstract, undefined);
});

test('a DOTTED state name names its parent, with no parent key written', () => {
  assert.equal(named('shell.ghost').parentName, 'shell');
});

test('a template that is one element names a component by its tag; `component` names it directly', () => {
  assert.equal(named('things').componentTag, 'thing-list');
  assert.equal(named('things').componentName, undefined);
  assert.equal(named('twins').componentName, 'twin');
  assert.equal(named('twins').componentTag, undefined);
});

test('a templateUrl on a route is READ, and the tags in it are the components it mounts', () => {
  const detail = named('thingDetail');
  assert.equal(detail.templateUrl, 'scripts/thing-list/detail.template.html');
  assert.equal(detail.templateFile, 'static/scripts/thing-list/detail.template.html',
    'the url is resolved from the SERVER root (static/), not from the source root');
  assert.deepEqual(detail.templateTags, ['thing-badge']);
});

test('$routeProvider.when is a route too: the path is the first argument', () => {
  const legacy = routes.filter((r) => r.receiver === '$routeProvider');
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].path, '/legacy');
  assert.equal(legacy[0].name, undefined, 'a `when` route has no state name to carry');
  assert.equal(legacy[0].controllerName, 'LegacyController');
  assert.equal(legacy[0].templateFile, 'static/scripts/legacy/legacy.template.html');
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('a component registration records the name, the controller it points at and its template tags', () => {
  const list = registrations.find((r) => r.what === 'component' && r.name === 'thingList');
  assert.equal(list.file, 'static/scripts/thing-list/thing-list.component.js');
  assert.equal(list.framework, 'angular');
  assert.equal(list.controller, 'ThingListController');
  assert.deepEqual(list.templateTags, ['thing-badge'], 'the template mounts another component by writing its tag');
});

test('a chained .component(…).controller(…) registers both', () => {
  const inBadge = registrations.filter((r) => r.file.endsWith('thing-badge/thing-badge.js'));
  assert.deepEqual(inBadge.map((r) => [r.what, r.name]).sort(),
    [['component', 'thingBadge'], ['controller', 'ThingBadgeController']]);
});

test('a DIRECTIVE is a registration only when its object names a controller', () => {
  const dirs = registrations.filter((r) => r.what === 'directive');
  assert.deepEqual(dirs.map((r) => r.name), ['widgetBox'],
    'widgetHighlight returns {restrict:"A"} and mounts nothing, so it is not one');
  assert.equal(dirs[0].controller, 'WidgetController');
});

test('one name registered twice is recorded twice, with the file each one is in', () => {
  const twins = registrations.filter((r) => r.what === 'component' && r.name === 'twin');
  assert.deepEqual(twins.map((r) => [r.file, r.controller]), [
    ['static/scripts/twin/twin-a.js', 'TwinAController'],
    ['static/scripts/twin/twin-b.js', 'TwinBController'],
  ]);
});

// ---------------------------------------------------------------------------
// The client the framework injects
// ---------------------------------------------------------------------------

test('$http is a client because the pack says so and the function sits in a registrar', () => {
  const http = calls.filter((c) => c.injected);
  assert.equal(http.length, 7);
  for (const c of http) {
    assert.deepEqual(c.injected, { client: '$http', framework: 'angularjs' });
    assert.equal(c.binding, null, 'nothing in the file binds $http: it arrives as a parameter');
  }
  assert.deepEqual(http.map((c) => [c.url.resolved[0].template, c.method.value]).sort(), [
    ['/api/shop/badges', 'GET'],
    ['api/shop/legacy/items', 'GET'],
    ['api/shop/things', 'GET'],
    ['api/shop/things', 'POST'],
    ['api/shop/twins/a', 'GET'],
    ['api/shop/twins/b', 'GET'],
    ['api/shop/widgets', 'GET'],
  ]);
});

test('a RELATIVE path is the url on a client verb, and the url of a bare call is still nothing', () => {
  const rel = calls.find((c) => c.injected && c.url && c.url.resolved[0].template === 'api/shop/widgets');
  assert.ok(rel, 'a path with no leading slash is a url when the callee is a known client verb');
  // The fixture's only non-client member call: `demoApp.config([...])`. It goes
  // through a binding, so it is recorded, and it carries no url.
  const config = calls.find((c) => c.callee.root === 'demoApp');
  assert.equal(config.url, null);
  assert.equal(config.injected, undefined);
});

test('a POST inside a callback is still the injected client, one scope down', () => {
  const post = calls.find((c) => c.method && c.method.value === 'POST');
  assert.equal(post.file, 'static/scripts/thing-list/thing-list.controller.js');
  assert.deepEqual(post.injected, { client: '$http', framework: 'angularjs' });
});

// ---------------------------------------------------------------------------
// A route declaration is never a call
// ---------------------------------------------------------------------------

test('not one router declaration is recorded as an HTTP call', () => {
  for (const c of calls) {
    assert.notEqual(c.callee.root, '$stateProvider', `${c.file}:${c.line} records a state declaration as a call`);
    assert.notEqual(c.callee.root, '$urlRouterProvider', `${c.file}:${c.line} records a fallback route as a call`);
    assert.notEqual(c.callee.root, '$routeProvider', `${c.file}:${c.line} records a when() as a call`);
  }
  const urls = calls.filter((c) => c.url).flatMap((c) => c.url.resolved.map((r) => r.template));
  for (const declared of ['/things', '/ghost', '/twins', '/boxes', '/legacy', '/things/:thingId']) {
    assert.ok(!urls.includes(declared), `${declared} is a route this app SHOWS, not one it calls`);
  }
});

// ---------------------------------------------------------------------------
// The stream itself
// ---------------------------------------------------------------------------

test('the summary counts what the records say, and two runs print the same bytes', () => {
  assert.equal(SUMMARY.routes, routes.length);
  assert.equal(SUMMARY.byPack['angular-router'], routes.length);
  assert.deepEqual(SUMMARY.registrations, { component: 4, controller: 6, directive: 1 });
  assert.equal(SUMMARY.injectedCalls, calls.filter((c) => c.injected).length);
  assert.equal(SUMMARY.templatesRead, BODY.filter((r) => typeof r.templateFile === 'string').length);
  const again = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, SRC], { maxBuffer: 1 << 28 }).toString('utf8');
  assert.equal(again, RAW, 'the same tree must print the same bytes');
});

test('the fixture is a frontend with no manifest of its own', () => {
  assert.equal(fs.existsSync(path.join(FIXTURE, 'package.json')), false,
    'the point of this fixture is that nothing declares a framework dependency for it');
});

// ---------------------------------------------------------------------------
// Cold and incremental must read the same bytes the same way
// ---------------------------------------------------------------------------

test('a per-FILE run records exactly what the whole-root run recorded for that file', () => {
  // This is the shape an incremental run takes: the CLI hands the worker the
  // changed files, not the roots. The `templateUrl` search must not move with
  // it, which is what `--web-root` is for.
  const cold = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, '--web-root', SRC, SRC], { maxBuffer: 1 << 28 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.kind !== 'header' && r.kind !== 'summary' && r.what !== 'alias');
  const byFile = new Map();
  for (const r of cold) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(JSON.stringify(r));
  }
  assert.ok(byFile.size >= 9, `expected the fixture's files, got ${byFile.size}`);
  for (const [rel, expected] of [...byFile].sort()) {
    const one = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, '--web-root', SRC, path.join(FIXTURE, rel)], { maxBuffer: 1 << 28 })
      .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.kind !== 'header' && r.kind !== 'summary' && r.what !== 'alias')
      .map((r) => JSON.stringify(r));
    assert.deepEqual(one, expected, `${rel} reads differently on its own`);
  }
});
