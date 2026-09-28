// web_angular_modern.test.mjs — Angular 2 and later in the web lane (RM67).
//
// Two things were missing. Angular's HttpClient is never imported as a value
// and never built by the file that uses it: a class asks for it by TYPE, and a
// call through it was traced to no sink, so every such edge was HEURISTIC. And
// a `Routes` array was read by nothing that knew it was Angular's: the route
// objects fell to whichever other router pack the tie-break picked, their
// paths written as constants were not read at all, and a list loaded from
// another file (`loadChildren`) composed onto nothing.
//
// The fixture under test/fixtures/web-ng is a small workspace in that shape: a
// root `Routes` list, lazy children in three spellings, a route bound to a
// name and put into a list elsewhere, paths kept in one constant object in a
// library, services that inject HttpClient both ways, and components that
// inject the services. Every name in it is invented.
//
// The worker is SPAWNED, like the other worker tests; the bridge is driven by
// the records it prints, over a graph that holds the routes a backend serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { addWebFacts, webEndpointId, WEB_CALL_BASIS } from '../src/adapters/web_bridge.mjs';
import { routePacksOf } from '../adapters/web/lib/routers.mjs';
import { routerDependencyOf } from '../src/core/discover.mjs';
import { screenAxisOf } from '../src/core/lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'web-ng');

const RAW = execFileSync(process.execPath, [WORKER, '--root', FIXTURE, FIXTURE], { maxBuffer: 1 << 28 }).toString('utf8');
const RECORDS = RAW.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const BODY = RECORDS.slice(1, -1);
const of = (kind, file) => BODY.filter((r) => r.kind === kind && (file === undefined || r.file.endsWith(file)));
const routeAt = (file, line) => {
  const hit = of('route', file).filter((r) => r.line === line);
  assert.equal(hit.length, 1, `expected one route at ${file}:${line}, got ${hit.length}`);
  return hit[0];
};

/** The routes the backend serves, as the Java or TypeScript bridge would have put them. */
const SERVED = [
  ['GET', '/api/orders'], ['POST', '/api/orders'], ['DELETE', '/api/orders/{id}'], ['GET', '/api/items'],
  ['GET', '/api/items/config'], ['GET', '/api/feed'], ['POST', '/api/orders/resend'], ['PUT', '/api/orders/resend'],
];

function bridged(records = RECORDS) {
  const g = new Graph();
  for (const [httpMethod, p] of SERVED) {
    const id = webEndpointId(httpMethod, p);
    g.addNode({ id, path: p, httpMethod, handler: 'com.x.C#m' });
  }
  const stats = addWebFacts(g, records, { screenAxis: { enabled: true } });
  return { g, stats };
}
const BRIDGED = bridged();
const edges = (type) => BRIDGED.g.edges.filter((e) => e.type === type);
const httpFrom = (fn) => edges('CALLS_HTTP').filter((e) => e.from === `symbol:libs/data/src/${fn}`);

// ---------------------------------------------------------------------------
// Which pack reads a route object
// ---------------------------------------------------------------------------

test('a route object in a file that imports @angular/router is read by the Angular pack', () => {
  const routes = of('route', 'app.routes.ts');
  assert.ok(routes.length >= 6, `expected the root list, got ${routes.length}`);
  for (const r of routes) assert.equal(r.pack, 'angular-routes');
});

test('the same object in a file that imports no router is read exactly as before the Angular pack existed', () => {
  // `{path, component}` is spelled the same by three routers. With no import to
  // say whose it is, the choice is the one it always was: the tie-break
  // between the object packs, which the module pack takes no part in.
  const menu = of('route', 'menu.ts');
  assert.deepEqual(menu.map((r) => [r.pack, r.path]), [['react-router', '/menu-home']]);
  assert.equal(menu[0].list, undefined, 'a file that names no router records no list');
});

test('a module pack is a candidate only in a file that imports its module', () => {
  const packs = ['vue-router', 'react-router', 'angular-routes'].map((n) => {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'web', 'packs', `${n}.json`), 'utf8'));
    p.__routesFrom = p.routesFrom === 'module' ? 'module' : 'object';
    return p;
  });
  assert.deepEqual(routePacksOf(packs, new Set(['vue'])).map((p) => p.pack), ['vue-router', 'react-router']);
  assert.deepEqual(routePacksOf(packs, new Set(['@angular/router'])).map((p) => p.pack),
    ['vue-router', 'react-router', 'angular-routes']);
});

test('the Angular pack names none of the keys that tell a Vue route from a React one', () => {
  // The tie-break counts the keys NO OTHER pack names. A key the Angular pack
  // shared with one of them would stop being that pack's, and every Vue or
  // React route that carries it would be scored differently.
  const read = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'web', 'packs', `${n}.json`), 'utf8'));
  const keysOf = (p) => {
    const ro = p.routeObject ?? {};
    return new Set([ro.pathKey, ro.childrenKey, ro.nameKey, ro.metaKey, ro.redirectKey, ro.hiddenKey, ro.indexKey,
      ro.lazyChildrenKey, ...(ro.componentKeys ?? [])].filter(Boolean));
  };
  const vue = keysOf(read('vue-router'));
  const react = keysOf(read('react-router'));
  const ng = keysOf(read('angular-routes'));
  const distinctive = (mine, other) => [...mine].filter((k) => !other.has(k) && !ng.has(k)).sort();
  const before = (mine, other) => [...mine].filter((k) => !other.has(k)).sort();
  assert.deepEqual(distinctive(vue, react), before(vue, react));
  assert.deepEqual(distinctive(react, vue), before(react, vue));
});

// ---------------------------------------------------------------------------
// What a route record says
// ---------------------------------------------------------------------------

test('loadComponent: a bare import is the default export, `.then(m => m.X)` names X', () => {
  const list = routeAt('orders/orders.routes.ts', 6);
  assert.equal(list.componentSource, './list/order-list');
  assert.equal(list.componentExport, 'OrderList');
  const edit = routeAt('orders/orders.routes.ts', 10);
  assert.equal(edit.componentSource, './edit/order-edit');
  assert.equal(edit.componentExport, undefined);
});

test('loadChildren names the module and the export whose list the children are', () => {
  assert.deepEqual(routeAt('app.routes.ts', 9).childrenFrom, { source: './orders/orders.routes', export: 'default' });
  assert.deepEqual(routeAt('app.routes.ts', 13).childrenFrom, { source: './items/items.routes', export: 'ITEM_ROUTES' });
});

test('a route that mounts nothing and holds children is a group, and a named outlet says so', () => {
  assert.equal(routeAt('app.routes.ts', 9).grouping, true);
  assert.equal(routeAt('app.routes.ts', 8).grouping, undefined, 'the home route mounts a component');
  assert.equal(routeAt('app.routes.ts', 18).outlet, 'aside');
  assert.equal(routeAt('app.routes.ts', 8).metaTitle, 'Home', 'the title key sits on the route itself');
});

test('a path written as a constant another module exports is left for the bridge, with its specifier', () => {
  assert.equal(routeAt('app.routes.ts', 9).path, null);
  assert.deepEqual(routeAt('app.routes.ts', 9).pathRef,
    { name: 'appPaths.orders.path', source: '@shop/paths/paths', imported: 'appPaths' });
  // A name destructured out of the constant is spelled out in full.
  assert.equal(routeAt('items/items.routes.ts', 14).pathRef.name, 'appPaths.items.create.path');
});

test('a list says its name, and a name written in a list is a reference', () => {
  assert.equal(routeAt('orders/orders.routes.ts', 6).list, 'orderRoutes');
  assert.equal(routeAt('account/password/password.route.ts', 5).list, 'passwordRoute',
    'a single Route object bound to a name is a route under that name');
  assert.deepEqual(of('routeRef', 'account/account.routes.ts').map((r) => [r.name, r.list, r.spread ?? false]),
    [['passwordRoute', 'accountRoutes', false], ['extraRoutes', 'accountRoutes', true]]);
  const forChild = of('routeRef', 'legacy/legacy.module.ts');
  assert.equal(forChild.length, 1);
  assert.equal(forChild[0].registrar, 'forChild');
  assert.equal(routeAt('legacy/legacy.module.ts', 10).list, forChild[0].name);
});

test('the constant object the paths live in keeps its text below the first level', () => {
  const c = of('constant', 'paths/src/paths.ts');
  assert.equal(c.length, 1, '`{…} satisfies T` is the object it is written around');
  assert.equal(c[0].nested['orders.path'], 'orders');
  assert.equal(c[0].nested['orders.edit.path'], ':id/edit');
});

test('a directory with a tsconfig of its own gets the aliases its extends chain declares', () => {
  const scoped = of('config').filter((r) => r.what === 'alias' && typeof r.scope === 'string');
  assert.deepEqual(scoped.filter((r) => r.scope === 'apps/shop').map((r) => [r.from, r.to]).sort(),
    [['@shop/data', 'libs/data/src'], ['@shop/paths', 'libs/paths/src']]);
});

// ---------------------------------------------------------------------------
// A client known by its type
// ---------------------------------------------------------------------------

test('a field set from inject(T), and a constructor parameter property, say their TYPE', () => {
  const byField = (file) => of('assign', file).map((a) => [a.field, a.init.shape, a.init.via, a.init.binding.source]);
  assert.deepEqual(byField('order.service.ts'), [['http', 'typed', 'injector', '@angular/common/http']]);
  assert.deepEqual(byField('item-list.ts'), [['items', 'typed', 'constructor-parameter', '@shop/data/item.service']]);
  // `@Inject(TOKEN)` hands in whatever the token names, not the type beside it.
  assert.deepEqual(byField('item.service.ts'), [['http', 'typed', 'constructor-parameter', '@angular/common/http']]);
});

test('an HttpClient call is a client call, SOUND_SET, and the evidence says how the type was stated', () => {
  const [list] = httpFrom('order.service.ts#OrderService.list');
  assert.equal(list.to, 'endpoint:GET /api/orders');
  assert.equal(list.grade, 'SOUND_SET');
  assert.equal(list.evidence.sink.kind, 'library');
  assert.equal(list.evidence.sink.module, '@angular/common/http');
  assert.equal(list.evidence.sink.typed, 'injector');
  assert.equal(list.evidence.basis, WEB_CALL_BASIS.typed);
  const [all] = httpFrom('item.service.ts#ItemService.all');
  assert.equal(all.grade, 'SOUND_SET');
  assert.equal(all.evidence.sink.typed, 'constructor-parameter');
});

test('a field handed in through a token is no client: its call stays a guess', () => {
  const [viaConfig] = httpFrom('item.service.ts#ItemService.viaConfig');
  assert.equal(viaConfig.grade, 'HEURISTIC');
  assert.equal(viaConfig.evidence.sink.kind, 'untraced');
});

test('request(method, url) is read by position; a method that is not written out is no method', () => {
  const [save] = httpFrom('order.service.ts#OrderService.save');
  assert.equal(save.to, 'endpoint:POST /api/orders');
  assert.deepEqual(save.evidence.method, { value: 'POST', from: 'positional' });
  assert.equal(save.grade, 'SOUND_SET');
  const resend = httpFrom('order.service.ts#OrderService.resend');
  assert.deepEqual(resend.map((e) => e.to).sort(), ['endpoint:POST /api/orders/resend', 'endpoint:PUT /api/orders/resend']);
  for (const e of resend) {
    assert.equal(e.grade, 'HEURISTIC', 'a call with no method matches by path alone, and says so');
    assert.deepEqual(e.evidence.method, { value: null, from: 'absent' });
  }
});

test('a verb not spelled like one takes its method from the library\'s own table', () => {
  const [feed] = httpFrom('order.service.ts#OrderService.feed');
  assert.deepEqual(feed.evidence.method, { value: 'GET', from: 'library-verb' });
});

test('a component calling a method of the service it injects is a CALLS edge, SOUND_SET, never EXACT', () => {
  const calls = edges('CALLS').filter((e) => e.evidence.rule === 'typed-field');
  const pairs = calls.map((e) => [e.from.split('#')[1], e.to.split('#')[1], e.grade, e.evidence.via]).sort();
  assert.deepEqual(pairs, [
    ['AuditLog.submit', 'OrderService.save', 'SOUND_SET', 'injector'],
    ['AuditShell.reload', 'ItemService.all', 'SOUND_SET', 'injector'],
    ['ItemList.load', 'ItemService.all', 'SOUND_SET', 'constructor-parameter'],
    ['OrderBadge.refresh', 'OrderService.feed', 'SOUND_SET', 'injector'],
    ['OrderEdit.submit', 'OrderService.save', 'SOUND_SET', 'injector'],
    ['OrderList.drop', 'OrderService.remove', 'SOUND_SET', 'injector'],
    ['OrderList.ngOnInit', 'OrderService.list', 'SOUND_SET', 'injector'],
    ['SettingsGeneral.close', 'OrderService.remove', 'SOUND_SET', 'injector'],
    ['SettingsMail.load', 'ItemService.all', 'SOUND_SET', 'injector'],
    ['SettingsShell.ngOnInit', 'OrderService.list', 'SOUND_SET', 'injector'],
    ['TeamList.refresh', 'OrderService.feed', 'SOUND_SET', 'injector'],
  ]);
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const screens = () => [...BRIDGED.g.nodes.values()].filter((n) => String(n.id).startsWith('screen:'));

test('paths compose across files: through a lazy list, a named list, a spread list and a path constant', () => {
  assert.deepEqual(screens().map((n) => n.path).sort(), [
    '/', '/account/password', '/account/profile', '/items', '/items/new', '/menu-home', '/orders', '/orders/:id/edit',
    '/settings', '/settings/audit', '/settings/mail', '/settings/team',
  ]);
  assert.equal(screens().find((n) => n.path === '/orders').pack, 'angular-routes');
});

test('a group, a named outlet and a redirect are not screens, and each is counted', () => {
  const s = BRIDGED.stats.screens;
  assert.equal(s.lists.groupings, 6, 'orders, items, account, settings, settings/team and legacy mount nothing of their own');
  assert.equal(s.lists.outlets, 1);
  assert.equal(screens().some((n) => n.path === '/side' || n.path === '/**' || n.path === '/legacy'), false);
});

test('a path this lane cannot compose is not guessed: it is counted, and the name that failed is listed', () => {
  const l = BRIDGED.stats.screens.lists;
  assert.equal(l.pathRefsUnresolved, 1, 'appPaths.reports is not in the constant');
  assert.equal(l.childListsWithoutParent, 1, 'the NgModule registers its list for a route that names a class');
  assert.equal(l.pathUnknown, 2);
  assert.deepEqual(l.unresolved.map((u) => u.name).sort(), [
    'lazy apps/shop/src/app.routes.ts: ./legacy/legacy.module (LegacyModule)',
    'path apps/shop/src/app.routes.ts: appPaths.reports.path',
  ]);
  assert.equal(screens().some((n) => n.path === '/old'), false, 'a child list is never read as a top-level path');
});

test('a screen renders its component EXACT and a decorated child component as a candidate; a plain module not at all', () => {
  const renders = edges('RENDERS').filter((e) => e.from === 'screen:/orders');
  assert.deepEqual(renders.map((e) => [e.to.split('#')[1], e.grade, e.evidence.rule]).sort(), [
    ['OrderBadge.refresh', 'SOUND_SET', 'component-import'],
    ['OrderList.drop', 'EXACT', 'route-component'],
    ['OrderList.ngOnInit', 'EXACT', 'route-component'],
  ]);
  const node = BRIDGED.g.nodes.get('symbol:apps/shop/src/orders/list/order-list.ts#OrderList.ngOnInit');
  assert.equal(node.component, true, 'a class decorated as a component makes its .ts file a component');
});

// ---------------------------------------------------------------------------
// An EMPTY path renders at its parent's screen
//
// `{path: '', component: Shell, children: [{path: '', component: General}]}`
// is two components on one screen: the router renders the shell and, in its
// outlet, the child whose path is ''. The two compose to the same path, and a
// rule that kept only the first declaration of a path dropped the child, so
// nothing the child does was on the screen at all. A child in another file (a
// lazily loaded list whose first route is '') is the same thing written apart.
// ---------------------------------------------------------------------------

const rendersOf = (screen) => edges('RENDERS').filter((e) => e.from === screen)
  .map((e) => [e.to.split('#')[1], e.grade]).sort();

test('an empty-path child renders at its parent\'s screen, beside the parent, both EXACT', () => {
  assert.deepEqual(rendersOf('screen:/settings'), [
    ['SettingsGeneral.close', 'EXACT'],
    ['SettingsShell.ngOnInit', 'EXACT'],
  ]);
  const node = screens().find((n) => n.path === '/settings');
  assert.equal(node.component, 'apps/shop/src/settings/settings-shell.ts', 'the first declaration is still the screen\'s own');
  assert.deepEqual(node.components, ['apps/shop/src/settings/settings-shell.ts', 'apps/shop/src/settings/settings-general.ts']);
  assert.deepEqual(node.declaredAt.map((d) => d.line), [10, 14]);
});

test('the first route of a lazily loaded list is \'\' and renders inside the route that loads it', () => {
  assert.deepEqual(rendersOf('screen:/settings/audit'), [
    ['AuditLog.submit', 'EXACT'],
    ['AuditShell.reload', 'EXACT'],
  ]);
});

test('an empty-path child of a parent with no component, on the same line, is that path\'s own screen', () => {
  // `{ path: 'team', children: [{ path: '', loadComponent: … }] }` on ONE line:
  // the parent and the child share a line, so a parent known by its line alone
  // was the child itself, and the child composed to `/` instead.
  assert.deepEqual(rendersOf('screen:/settings/team'), [['TeamList.refresh', 'EXACT']]);
  assert.equal(rendersOf('screen:/').some(([fn]) => fn === 'TeamList.refresh'), false);
});

test('a redirect to \'\' is no screen and adds nothing to the screen it lands on', () => {
  assert.equal(screens().some((n) => n.path === '/settings/general'), false);
  assert.equal(rendersOf('screen:/settings').length, 2);
});

test('the screens that reach a route include the one whose empty-path child calls it', () => {
  // The question the viewer asked: which screens call this route. The child's
  // call is on the screen its parent is on.
  const target = 'endpoint:DELETE /api/orders/{id}';
  const callers = new Set(edges('CALLS_HTTP').filter((e) => e.to === target).map((e) => e.from));
  const viaCalls = new Set(edges('CALLS').filter((e) => callers.has(e.to)).map((e) => e.from));
  const onScreens = edges('RENDERS').filter((e) => viaCalls.has(e.to) || callers.has(e.to)).map((e) => e.from);
  assert.ok(onScreens.includes('screen:/settings'), `screens found: ${[...new Set(onScreens)].join(', ')}`);
});

test('the round trip, in one graph: screen to component to service to the route it posts to', () => {
  const screen = 'screen:/orders/:id/edit';
  const hop1 = edges('RENDERS').find((e) => e.from === screen);
  assert.equal(hop1.to, 'symbol:apps/shop/src/orders/edit/order-edit.ts#OrderEdit.submit');
  const hop2 = edges('CALLS').find((e) => e.from === hop1.to);
  assert.equal(hop2.to, 'symbol:libs/data/src/order.service.ts#OrderService.save');
  const hop3 = edges('CALLS_HTTP').find((e) => e.from === hop2.to);
  assert.equal(hop3.to, 'endpoint:POST /api/orders');
});

test('the same facts in reverse order build the same screens and the same edges', () => {
  const body = RECORDS.slice(1, -1).reverse();
  const again = bridged([RECORDS[0], ...body, RECORDS[RECORDS.length - 1]]);
  const key = (g) => JSON.stringify([[...g.nodes.keys()].sort(), g.edges.map((e) => `${e.from} ${e.to} ${e.type} ${e.grade}`).sort()]);
  assert.equal(key(again.g), key(BRIDGED.g));
});

// ---------------------------------------------------------------------------
// The screen axis switch
// ---------------------------------------------------------------------------

test('@angular/router is a router dependency, and the screen axis turns on for it the way it does for vue-router', () => {
  assert.equal(routerDependencyOf({ '@angular/core': '^19', '@angular/router': '^19' }), 'angular-routes');
  assert.equal(routerDependencyOf({ '@angular/core': '^19' }), null, 'an Angular app that does not route has no screens to build');
  // A package that ships both routers keeps the answer it had before.
  assert.equal(routerDependencyOf({ 'angular-ui-router': '1', '@angular/router': '^19' }), 'angular-router');
  const on = screenAxisOf({ screenAxis: { enabled: null }, frameworkPacks: ['web'] }, { webPackages: [{ router: 'angular-routes' }] });
  assert.equal(on.enabled, true);
  assert.equal(on.from, 'read-router');
  const off = screenAxisOf({ screenAxis: { enabled: null }, frameworkPacks: ['web'] }, { webPackages: [{ router: null }] });
  assert.equal(off.enabled, false);
});
