// web_templates.test.mjs — the SERVER-RENDERED PAGE, end to end within the web
// lane (RM48).
//
// Three template languages, one set of rules. A page's inline `<script>` is read
// by the same JavaScript reader every `.js` file goes through, after the
// template's own directives have been neutralised into placeholders; its
// `<form>` and its links are call sites of the page itself; and what it INCLUDES
// is followed, because a layout's script is every page's script.
//
// What this file pins, in the order a reader meets it:
//   1. the worker over a real fixture per engine, records and all: what is a
//      URL a page asks for and what is a static asset, what a fragment
//      expression names, where an include lands;
//   2. the bridge: a view name becomes a screen, a handler RENDERS_PAGE it, a
//      `redirect:` becomes a call, and a template nobody names is counted and
//      left alone rather than turned into a page nobody serves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId, FLOW_EDGE_TYPES } from '../src/core/graph.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';
import { screensAffecting } from '../src/core/walks.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER = path.join(ENGINE_ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURES = path.join(ENGINE_ROOT, 'test', 'fixtures', 'web-templates');

const ENGINES = Object.freeze([
  { engine: 'thymeleaf', dir: 'templates', suffix: '.html' },
  { engine: 'freemarker', dir: 'templates', suffix: '.ftl' },
  { engine: 'jsp', dir: 'WEB-INF/jsp', suffix: '.jsp' },
]);

/** Run the worker over one engine's fixture and return its records. */
function readFixture(engine) {
  const spec = ENGINES.find((e) => e.engine === engine);
  const root = path.join(FIXTURES, engine);
  const templateRoot = path.join(root, ...spec.dir.split('/'));
  const out = execFileSync(process.execPath, [
    WORKER, '--root', root,
    '--template-root', JSON.stringify({ root: templateRoot, engine, suffix: spec.suffix }),
    templateRoot,
  ], { maxBuffer: 1 << 26 }).toString('utf8');
  return out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

const templatesOf = (records) => new Map(records.filter((r) => r.kind === 'template').map((r) => [r.name, r]));
const callsOf = (records) => records.filter((r) => r.kind === 'call');
const urlsOf = (records) => callsOf(records).flatMap((c) => (c.url?.resolved ?? []).map((r) => r.template));

// ---------------------------------------------------------------------------
// 1. the worker, per engine
//
// The text rules are exercised THROUGH the records rather than by importing the
// worker: it runs `main` on import, like every worker here, so a fixture that
// holds every shape and a record that proves what came out is what a reader
// checks. Each fixture is written to hold the shapes the rule refuses as well
// as the ones it takes.
// ---------------------------------------------------------------------------

test('thymeleaf: a page is read for its form, its links, its scripts and what it replaces', () => {
  const records = readFixture('thymeleaf');
  const t = templatesOf(records);
  assert.deepEqual([...t.keys()].sort(), ['fragments/layout', 'things/list', 'things/orphan']);

  const list = t.get('things/list');
  assert.equal(list.engine, 'thymeleaf');
  assert.equal(list.suffix, '.html');
  assert.equal(list.scripts, 1);
  assert.equal(list.forms, 1);
  assert.equal(list.links, 2, 'a static asset, an outside address and an anchor are not routes');
  // `th:replace="~{fragments/layout :: layout (…)}"` names a template relative
  // to the ROOT, and the include record carries the file it resolves to.
  assert.deepEqual(list.includes, [{
    written: 'fragments/layout',
    kind: 'thymeleaf-replace',
    name: 'fragments/layout',
    file: 'templates/fragments/layout.html',
  }]);

  const urls = urlsOf(records.filter((r) => r.file?.endsWith('things/list.html'))).sort();
  assert.deepEqual(urls, ['/things/search', '/things/tags', '/things/totals', '/things/new', '/things/{*}'].sort());

  const byLine = new Map(callsOf(records).filter((c) => c.file.endsWith('list.html')).map((c) => [c.line, c]));
  // The form's method is the attribute's, and the rule says which attribute.
  assert.equal(byLine.get(6).method.value, 'GET');
  assert.equal(byLine.get(6).template.rule, 'template-form');
  assert.equal(byLine.get(6).template.attr, 'th:action');
  // A link is a GET, whatever else the page does.
  assert.equal(byLine.get(11).method.value, 'GET');
  assert.equal(byLine.get(11).template.rule, 'template-link');
  // The inline script goes through the SAME reader a `.js` file does: `fetch`
  // is the platform sink it always was, and jQuery is one now.
  assert.equal(byLine.get(19).platformSink, 'fetch');
  assert.equal(byLine.get(21).platformSink, 'jquery');
  assert.equal(byLine.get(21).method.value, 'GET', '$.getJSON is a GET, and only the pack says so');

  // A Thymeleaf INLINE link expression keeps its path rather than becoming a hole.
  const ping = callsOf(records).find((c) => c.file.endsWith('layout.html') && c.platformSink === 'jquery');
  assert.deepEqual(ping.url.resolved.map((r) => r.template), ['/health/ping']);
  assert.equal(ping.method.value, 'POST');
});

test('freemarker: the directives are neutralised, and the context path is a name the layout binds', () => {
  const records = readFixture('freemarker');
  const t = templatesOf(records);
  assert.deepEqual([...t.keys()].sort(), ['common/macro', 'pages/board']);
  // Not one parse error: `<#list>`, `<#import>`, `<@…/>` and `${…}` all left the
  // JavaScript parseable.
  assert.deepEqual(records.filter((r) => r.kind === 'parse_error'), []);

  // The layout is where the app root is bound, and it is the only file that
  // knows it. The page that imports it does not, and says so by naming the base.
  assert.deepEqual(t.get('common/macro').contextVars, ['base_url']);
  assert.deepEqual(t.get('pages/board').contextVars, []);
  assert.deepEqual(t.get('pages/board').includes.map((i) => i.name), ['common/macro']);

  const calls = callsOf(records).filter((c) => c.file.endsWith('board.ftl'));
  assert.deepEqual(calls.map((c) => c.url.resolved[0].template), ['{*}/board/pageList', '{*}/board/remove']);
  for (const c of calls) {
    assert.equal(c.platformSink, 'jquery');
    assert.equal(c.method.value, 'POST');
    assert.equal(c.url.base, 'base_url', 'the hole has a name, or the bridge could not close it');
  }
  // A `<script src=…>` is a file of its own and is never an inline block.
  assert.equal(t.get('pages/board').scripts, 1);
});

test('jsp: an include is relative to the including file, and the context path is taken off the front', () => {
  const records = readFixture('jsp');
  const t = templatesOf(records);
  assert.deepEqual([...t.keys()].sort(), ['cart/Cart', 'common/Bottom', 'common/Top']);

  // `<%@ include file="../common/Top.jsp"%>` resolves against `cart/`.
  assert.deepEqual(t.get('cart/Cart').includes.map((i) => i.name), ['common/Top', 'common/Bottom']);
  assert.deepEqual(t.get('cart/Cart').includes[0].file, 'WEB-INF/jsp/common/Top.jsp');

  const cart = callsOf(records).filter((c) => c.file.endsWith('cart/Cart.jsp'));
  assert.deepEqual(cart.map((c) => `${c.method.value} ${c.url.resolved[0].template}`), [
    'GET /catalog',
    'POST /cart/update',
    'GET /cart/removeItem',   // the query string is not part of a route
    'GET /order/new',         // <c:url value='/order/new'/>
  ]);
  // An image is not a route, by prefix and by extension.
  assert.equal(cart.some((c) => c.url.resolved[0].template.includes('cart.gif')), false);
});

// ---------------------------------------------------------------------------
// 2. the bridge
// ---------------------------------------------------------------------------

/** A graph with the routes a Spring pack would serve, and their handlers. */
function backend(routes) {
  const g = new Graph();
  for (const [key, handler] of Object.entries(routes)) {
    const [httpMethod, p] = key.split(' ');
    const epId = nodeId('endpoint', key);
    const symId = nodeId('symbol', handler);
    g.addNode({ id: epId, path: p, httpMethod, handler, source: 'java' });
    g.addNode({ id: symId, symbol: handler, owner: handler.split('#')[0], file: 'X.java', line: 1 });
    g.addEdge({ from: epId, to: symId, type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

const VIEW = (owner, method, views, extra = {}) => ({
  kind: 'view', owner, method, paramCount: 0, views, unresolved: 0,
  line: 10, file: 'X.java', ...extra,
});

test('a view name becomes a screen, the handler renders it, and the page keeps its own calls', () => {
  const records = readFixture('thymeleaf');
  const g = backend({
    'GET /things': 'com.example.ThingController#list',
    'GET /things/search': 'com.example.ThingController#search',
    'GET /things/new': 'com.example.ThingController#form',
    'GET /things/{id}': 'com.example.ThingController#detail',
    'POST /health/ping': 'com.example.HealthController#ping',
  });
  const stats = addWebFacts(g, records, {
    screenAxis: { enabled: true },
    views: [VIEW('com.example.ThingController', 'list', [{ name: 'things/list', kind: 'view', from: 'literal' }])],
  });

  // ONE screen: the page a handler named. The layout it replaces is a fragment,
  // and the orphan is a template nobody renders.
  const screens = [...g.nodes.values()].filter((n) => n.kind === 'screen');
  assert.deepEqual(screens.map((n) => n.id), ['screen:view:things/list']);
  const page = screens[0];
  assert.equal(page.source, 'view');
  assert.equal(page.engine, 'thymeleaf');
  assert.equal(page.template, 'templates/things/list.html');
  assert.deepEqual(page.paths, ['/things']);
  assert.equal(page.path, '/things');
  assert.equal(stats.templates.files, 3);
  assert.equal(stats.templates.rendered, 2, 'the page and the layout it pulls in');
  assert.equal(stats.templates.unrendered, 1, 'the orphan, counted rather than read as a page');
  assert.deepEqual(stats.screens.byKind, { router: 0, page: 1, nexacro: 0 });

  // The handler renders the page, EXACTLY: the literal it returned is the
  // resolver's own input.
  const rendersPage = g.edges.filter((e) => e.type === 'RENDERS_PAGE');
  assert.deepEqual(rendersPage.map((e) => [e.from, e.to, e.grade]), [
    ['symbol:com.example.ThingController#list', 'screen:view:things/list', 'EXACT'],
  ]);
  assert.equal(rendersPage[0].evidence.rule, 'view-name');
  assert.equal(rendersPage[0].evidence.template, 'templates/things/list.html');

  // The page's own scripts are the page's; the fragment it includes is a
  // candidate, once as itself and once for each of its functions.
  const renders = g.edges.filter((e) => e.type === 'RENDERS' && e.from === 'screen:view:things/list');
  const byRule = new Map();
  for (const e of renders) byRule.set(`${e.evidence.rule}|${e.to}`, e.grade);
  assert.equal(byRule.get('template-own|symbol:templates/things/list.html#(module)'), 'EXACT');
  assert.equal(byRule.get('template-own|symbol:templates/things/list.html#refreshTotals'), 'EXACT');
  assert.equal(byRule.get('template-include|symbol:templates/fragments/layout.html'), 'SOUND_SET');
  assert.equal(byRule.get('template-include|symbol:templates/fragments/layout.html#ping'), 'SOUND_SET',
    "the layout's own function is this page's too");
  // The include is ONE row per page, whatever else the fragment holds.
  assert.equal(renders.filter((e) => e.to === 'symbol:templates/fragments/layout.html').length, 1);

  // The form and the link are calls onto the routes this pack serves, SOUND_SET
  // and never higher: which handler answers a path is the route table's answer.
  const http = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.includes('list.html'));
  const placed = [...new Set(http.map((e) => `${e.to} ${e.grade} ${e.evidence.rule}`))].sort();
  assert.deepEqual(placed, [
    'endpoint:GET /things/new SOUND_SET template-link',
    // `@{/things/{id}(id=…)}` is a path with a hole in it, and TWO of this
    // pack's routes can answer a one-segment hole. Both are candidates, which
    // is what the lane says about a hole everywhere else too.
    'endpoint:GET /things/search SOUND_SET template-link',
    'endpoint:GET /things/search SOUND_SET template-form',
    'endpoint:GET /things/{id} SOUND_SET template-link',
    // ...and the page's own `fetch`/`$.getJSON`, which land on the same
    // one-hole route: an inline script's call is read by the ordinary rule.
    'endpoint:GET /things/{id} SOUND_SET web-http-call',
  ].sort());
  assert.equal(stats.calls.template, 4, 'the page has three, the fragment one');
  // Nothing from the orphan reached the graph at all.
  assert.equal(g.edges.some((e) => e.from.includes('orphan')), false);
});

test('the app root is a name the LAYOUT binds, and the include graph is what closes the hole', () => {
  const records = readFixture('freemarker');
  const g = backend({
    'POST /board/pageList': 'com.example.BoardController#page',
    'POST /board/remove': 'com.example.BoardController#remove',
  });
  const stats = addWebFacts(g, records, {
    screenAxis: { enabled: true },
    views: [VIEW('com.example.BoardController', 'index', [{ name: 'pages/board', kind: 'view', from: 'literal' }])],
  });
  // `base_url + "/board/pageList"` is `{*}/board/pageList` in the file that
  // writes it; the file that ASSIGNS `base_url` is the one it imports.
  const http = g.edges.filter((e) => e.type === 'CALLS_HTTP').map((e) => [e.to, e.grade]).sort();
  assert.deepEqual(http, [
    ['endpoint:POST /board/pageList', 'SOUND_SET'],
    ['endpoint:POST /board/remove', 'SOUND_SET'],
  ]);
  for (const e of g.edges.filter((x) => x.type === 'CALLS_HTTP')) {
    assert.equal(e.evidence.prefix.from, 'context-path');
    assert.equal(e.evidence.prefix.value, '');
  }
  assert.equal(stats.unresolved.total, 0);
});

test('a redirect is a route, not a page, and an unreadable view name is counted', () => {
  const records = readFixture('jsp');
  const g = backend({
    'GET /catalog': 'com.example.CatalogController#main',
    'POST /cart/update': 'com.example.CartController#update',
    'GET /cart/removeItem': 'com.example.CartController#remove',
    'GET /order/new': 'com.example.OrderController#form',
  });
  const stats = addWebFacts(g, records, {
    screenAxis: { enabled: true },
    views: [
      VIEW('com.example.CartController', 'view', [{ name: 'cart/Cart', kind: 'view', from: 'literal' }]),
      VIEW('com.example.CartController', 'update', [{ name: '/catalog', kind: 'redirect', from: 'literal' }]),
      VIEW('com.example.CartController', 'gone', [], { unresolved: 2 }),
    ],
  });
  // `redirect:/catalog` sends the browser to a route this pack serves: a call,
  // graded by the match like any other.
  const redirect = g.edges.filter((e) => e.evidence?.rule === 'view-redirect');
  assert.deepEqual(redirect.map((e) => [e.from, e.to, e.grade, e.type]), [
    ['symbol:com.example.CartController#update', 'endpoint:GET /catalog', 'SOUND_SET', 'CALLS_HTTP'],
  ]);
  assert.equal(stats.templates.redirects, 1);
  assert.equal(stats.templates.unresolvedViews, 2, 'two returns this engine could not read, said out loud');
  // The two fragments Cart.jsp includes are rendered for it, and the page has
  // their calls as well as its own.
  assert.equal(stats.templates.rendered, 3);
  const from = 'screen:view:cart/Cart';
  const reached = new Set([...g.reach(from, { direction: 'out', mode: 'conservative', edgeTypes: FLOW_EDGE_TYPES })].map(([id]) => id));
  assert.ok(reached.has('endpoint:POST /cart/update'), 'its own form');
  assert.ok(reached.has('endpoint:GET /catalog'), "the header fragment's link, which is this page's too");
});

test('a walk up from a column reaches the page whose handler touches it', () => {
  const records = readFixture('thymeleaf');
  const g = backend({ 'GET /things': 'com.example.ThingController#list' });
  // The handler's own data: a statement it calls, reading a column.
  g.addNode({ id: nodeId('statement', 'ThingMapper.list'), statementType: 'select' });
  g.addNode({ id: nodeId('table', 'things') });
  g.addNode({ id: nodeId('column', 'things.label') });
  g.addEdge({ from: nodeId('symbol', 'com.example.ThingController#list'), to: nodeId('statement', 'ThingMapper.list'), type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: nodeId('statement', 'ThingMapper.list'), to: nodeId('column', 'things.label'), type: 'READS', grade: 'EXACT' });
  addWebFacts(g, records, {
    screenAxis: { enabled: true },
    views: [VIEW('com.example.ThingController', 'list', [{ name: 'things/list', kind: 'view', from: 'literal' }])],
  });
  const screens = screensAffecting(g, nodeId('column', 'things.label'), { mode: 'conservative' });
  assert.deepEqual(screens.map((s) => s.screen), ['screen:view:things/list']);
  assert.equal(screens[0].pathGrade, 'EXACT');
});

test('every fixture template is read by the engine that wrote it, and none of them holds a corpus name', () => {
  // The same discipline as the web-smoke fixture: a fixture written against one
  // real project would make the rules look general and be neither.
  const forbidden = ['defHttp', 'litemall', 'jeecg', 'ruoyi', 'petclinic', 'xxl-job', 'jpetstore'];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
      const text = fs.readFileSync(abs, 'utf8');
      for (const word of forbidden) {
        assert.equal(text.includes(word), false, `${abs} names ${word}`);
      }
    }
  };
  walk(FIXTURES);
});
