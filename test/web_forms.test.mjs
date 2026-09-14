// web_forms.test.mjs — the last two ways a page asks for a route, and the last
// two ways a single-page app changes screen (RM60).
//
// FOUR RULES, TWO FIXTURES.
//   a form submitted from script  `form.action = "<c:url …/>"; form.submit()` is
//                                 how every eGovFrame page sends what it does
//                                 not send with a link. Five spellings of the
//                                 same form, three sources for the method, and
//                                 an `.action` with no `submit()`, which is the
//                                 markup's business and not a call
//   a page's address bar          `location.href = …` in a JSP is a GET request,
//                                 because a page has no router. In a `.vue` the
//                                 same sink is still a navigation
//   the app's own router module    `import router from '@/router'` followed by
//                                 `router.push('/x')`, which is a navigation
//                                 only when that module really holds a router
//   `<router-link to>`            a navigation written in a component's markup,
//                                 static and bound
//
// The worker is exercised THROUGH its records, the way every other worker test
// here does it: it runs `main` on import, so a fixture holding every shape and
// a record proving what came out is what a reader checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { neutralizeScript } from '../adapters/web/lib/templates.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER = path.join(ENGINE_ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURES = path.join(ENGINE_ROOT, 'test', 'fixtures', 'web-forms');

const lines = (out) => out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

/** The JSP page: one template root, read as a page. */
function readPage() {
  const root = path.join(FIXTURES, 'jsp');
  const templateRoot = path.join(root, 'WEB-INF', 'jsp');
  return lines(execFileSync(process.execPath, [
    WORKER, '--root', root,
    '--template-root', JSON.stringify({ root: templateRoot, engine: 'jsp', suffix: '.jsp' }),
    templateRoot,
  ], { maxBuffer: 1 << 26 }).toString('utf8'));
}

/** The single-file components and the router modules beside them. */
function readSpa() {
  const root = path.join(FIXTURES, 'spa');
  return lines(execFileSync(process.execPath, [
    WORKER, '--root', root, path.join(root, 'src'),
  ], { maxBuffer: 1 << 26 }).toString('utf8'));
}

const MANAGE = 'WEB-INF/jsp/things/Manage.jsp';
const SEARCH = 'WEB-INF/jsp/things/Search.jsp';
const callsOf = (records, file = MANAGE) => records.filter((r) => r.kind === 'call' && r.file === file);
const byLine = (records, file = MANAGE) => new Map(callsOf(records, file).map((c) => [c.line, c]));
const urlOf = (c) => (c.url?.resolved ?? []).map((r) => r.template).join('|');

// ---------------------------------------------------------------------------
// 1. a form submitted from script
// ---------------------------------------------------------------------------

test('every spelling of the form idiom is one call, and the address is the assignment before the submit', () => {
  const at = byLine(readPage());
  // `document.<name>`, `document.forms['name']`, a name bound to
  // `getElementById`, and jQuery's `attr('action', …)` are four ways of writing
  // the same three lines.
  assert.equal(urlOf(at.get(11)), '/things/detail.do');
  assert.equal(at.get(11).formSubmit.form, 'document.listForm');
  assert.equal(urlOf(at.get(25)), '/things/remove.do');
  assert.equal(at.get(25).formSubmit.form, 'document.forms.listForm');
  assert.equal(urlOf(at.get(32)), '/things/plain.do');
  assert.equal(at.get(32).formSubmit.form, 'frm', 'the receiver as written is the key, whatever it holds');
  assert.equal(at.get(32).formSubmit.name, 'plainForm', 'and the NAME is what the variable was bound to');
  assert.equal(urlOf(at.get(38)), '/things/jquery.do');
  assert.equal(at.get(38).formSubmit.form, "$('#listForm')");
  // Every one of them is the same rule, and it is the rule the evidence names.
  for (const line of [11, 19, 25, 32, 38, 49]) {
    assert.equal(at.get(line).callee.root, 'form-submit', `line ${line}`);
  }
});

test('the method is the assignment, then the form element, and then nothing at all', () => {
  const at = byLine(readPage());
  // Assigned between the action and the submit: the page said so itself.
  assert.deepEqual(at.get(19).method, { value: 'GET', from: 'form-assigned' });
  assert.equal(at.get(19).formSubmit.methodFrom, 'assigned');
  // `<form:form>` is Spring's tag and posts; `<form>` is HTML and gets.
  assert.deepEqual(at.get(11).method, { value: 'POST', from: 'form-element' });
  assert.equal(at.get(11).formSubmit.methodFrom, 'form element');
  assert.deepEqual(at.get(32).method, { value: 'GET', from: 'form-element' });
  // A form handed in from outside names nothing this page declares.
  assert.equal(at.get(49).method, null);
  assert.equal(at.get(49).formSubmit.methodFrom, 'not found');
  assert.equal(at.get(49).formSubmit.name, undefined);
});

test('an `.action` with no `submit()` after it is the markup\'s business, not a call', () => {
  const records = readPage();
  assert.equal(records.some((r) => r.kind === 'call' && urlOf(r).includes('/things/never.do')), false);
  // …and the whole page produced exactly the calls above plus the two the
  // address bar makes, so nothing else crept in.
  assert.deepEqual(callsOf(records).map((c) => c.line), [11, 19, 25, 32, 38, 49, 54, 58]);
});

test('a `<c:url>` written inside a string literal is a path, the same as one written in an attribute', () => {
  const at = byLine(readPage());
  // The JSP tag is the page's, not the script's: it is taken out before the
  // script is parsed and leaves the path written from the application root.
  assert.equal(urlOf(at.get(11)), '/things/detail.do');
  assert.equal(at.get(11).url.contextPath, true, 'and the call says the context path was there');
  // A concatenation after the path is a query string, which is not part of a route.
  assert.equal(urlOf(at.get(58)), '/things/detail.do');
});

// ---------------------------------------------------------------------------
// 1b. one scope is all a submit reads, and a JSP tag is not the script's
// ---------------------------------------------------------------------------

test('a submit in a function that assigned no action sends the form element\'s own action, not a neighbour\'s', () => {
  const at = byLine(readPage(), SEARCH);
  // `linkPage` assigns and submits: that pairing is its own.
  assert.equal(urlOf(at.get(17)), '/things/list.do');
  assert.equal(at.get(17).formSubmit.actionFrom, 'assigned');
  // `fnSearch` only submits. The address `linkPage` assigned six lines above is
  // not what it sends: a page reloads on submit, so it sends the markup's action.
  assert.equal(urlOf(at.get(23)), '/things/search.do');
  assert.equal(at.get(23).formSubmit.actionFrom, 'form element');
  assert.equal(at.get(23).formSubmit.actionLine, undefined);
  assert.equal(at.get(23).enclosing, 'fnSearch');
});

test('a submit with no action in scope and no form element is recorded with no address', () => {
  const c = byLine(readPage(), SEARCH).get(28);
  assert.equal(c.url, null);
  assert.equal(c.formSubmit.actionFrom, 'not found');
  assert.equal(c.method, null);
});

test('two functions a page names alike are two scopes, and the module body is one', () => {
  const at = byLine(readPage(), SEARCH);
  assert.equal(at.get(34).enclosing, 'fnDup');
  assert.equal(urlOf(at.get(34)), '/things/dup.do');
  assert.equal(at.get(37).enclosing, 'fnDup~2');
  assert.equal(urlOf(at.get(37)), '/things/search.do', 'the second fnDup assigned nothing of its own');
  assert.equal(at.get(46).enclosing, '(module)');
  assert.equal(urlOf(at.get(46)), '/things/module.do');
  assert.equal(at.get(46).formSubmit.actionFrom, 'assigned');
});

test('a JSP tag inside a JavaScript string no longer breaks the block', () => {
  assert.equal(neutralizeScript('var pagetitle = "<spring:message code="comCmm.unitContent.20"/>";', 'jsp'),
    'var pagetitle = "__cascade_expr__";');
  assert.equal(neutralizeScript("buttonImage: '<c:url value='/images/egovframework/com/cmm/icon/bu_icon_carlendar.gif'/>',", 'jsp'),
    "buttonImage: '__cascade_ctx__/images/egovframework/com/cmm/icon/bu_icon_carlendar.gif',");
  // An expression inside the address is a hole, not a marker glued to a segment.
  assert.equal(neutralizeScript("f.action = \"<c:url value='/cop/bbs${prefix}/list.do'/>\";", 'jsp'),
    'f.action = "__cascade_ctx__/cop/bbs{*}/list.do";');
  // A control tag around a statement leaves the statement and its lines.
  const wrapped = neutralizeScript('<c:if test="${a}">\n  go();\n</c:if>', 'jsp');
  assert.equal(wrapped.split('\n').length, 3);
  assert.equal(wrapped.split('\n')[1], '  go();');
  assert.equal(/[<>"']/.test(wrapped), false, 'nothing the tags brought is left');
  // …and the page that holds all three parses.
  assert.deepEqual(readPage().filter((r) => r.kind === 'parse_error'), []);
});

// ---------------------------------------------------------------------------
// 2. the address bar
// ---------------------------------------------------------------------------

test('in a page `location.href` is a GET request, and an address with no path is not', () => {
  const records = readPage();
  const at = byLine(records);
  assert.equal(at.get(54).template.rule, 'location-request');
  assert.deepEqual(at.get(54).method, { value: 'GET', from: 'location-href' });
  assert.equal(urlOf(at.get(54)), '/things/home.do');
  assert.equal(at.get(58).template.attr, 'location.replace', 'the sink is on the record');
  // `location.href = ""` reloads the page: no path, so no route, so it is left
  // as the navigation it always was.
  const navigations = records.filter((r) => r.kind === 'navigation' && r.file === MANAGE);
  assert.deepEqual(navigations.map((n) => [n.line, n.sink, n.via]), [[63, 'location.href', 'global']]);
});

test('in a single-file component the same sink is still a navigation', () => {
  const records = readSpa();
  const nav = records.filter((r) => r.kind === 'navigation' && r.framework === 'browser');
  assert.deepEqual(nav.map((n) => [n.file, n.sink, n.via]), [['src/views/Panel.vue', 'location.href', 'global']]);
  assert.equal(records.some((r) => r.kind === 'call' && r.template?.rule === 'location-request'), false);
});

// ---------------------------------------------------------------------------
// 3. the app's own router module
// ---------------------------------------------------------------------------

test('a module whose default export is a router says so, in both spellings', () => {
  const records = readSpa();
  assert.deepEqual(
    records.filter((r) => r.kind === 'routerModule').map((r) => [r.file, r.framework]),
    [['src/router/index.js', 'vue-router'], ['src/router/legacy.js', 'vue-router']],
  );
});

test('a call on an imported name is a CANDIDATE, and the specifier rides with it', () => {
  const records = readSpa();
  const candidates = records.filter((r) => r.kind === 'navigationCandidate');
  assert.deepEqual(candidates.map((c) => [c.line, c.sink, c.specifier.source]), [
    [18, 'router.push', '@/router'],
    [21, 'legacy.replace', '@/router/legacy'],
    [24, 'router.push', '@/router'],
    [27, 'rows.push', '@/lib/rows'],
  ]);
  // A named route names a route declaration and not a path, and the record says so.
  assert.equal(candidates.find((c) => c.line === 24).targetKind, 'named');
  assert.equal(candidates.find((c) => c.line === 24).to, null);
});

// ---------------------------------------------------------------------------
// 4. `<router-link>`
// ---------------------------------------------------------------------------

test('a `<router-link>` is read from the markup, kebab or Pascal, static or bound', () => {
  const records = readSpa();
  const links = records.filter((r) => r.kind === 'navigation' && r.via === 'router-link');
  assert.deepEqual(links.map((l) => [l.line, l.sink, (l.to?.resolved ?? []).map((r) => r.template).join('')]), [
    [3, '<router-link to>', '/rows'],
    [4, '<RouterLink to>', '/panel'],
    [5, '<router-link :to>', ''],
  ]);
  assert.equal(links[2].targetKind, 'bound');
  assert.equal(links[2].to, null);
  // The line is the line in the `.vue` file, and an ordinary `<a href>` in the
  // same markup is nobody's navigation.
  assert.equal(links.every((l) => l.file === 'src/views/Panel.vue'), true);
  assert.equal(records.some((r) => r.kind === 'navigation' && String(r.sink).startsWith('<a ')), false);
});

// ---------------------------------------------------------------------------
// 5. the bridge
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

test('a form submit and an address bar become CALLS_HTTP edges of the page, graded like its links', () => {
  const g = backend({
    'POST /things/detail.do': 'com.example.ThingController#detail',
    'GET /things/list.do': 'com.example.ThingController#list',
    'GET /things/home.do': 'com.example.ThingController#home',
  });
  const stats = addWebFacts(g, readPage(), {
    screenAxis: { enabled: true },
    views: [{
      kind: 'view', owner: 'com.example.ThingController', method: 'list', paramCount: 0, unresolved: 0,
      line: 10, file: 'X.java', views: [{ name: 'things/Manage', kind: 'view', from: 'literal' }],
    }],
  });
  assert.equal(stats.calls.formSubmits, 6);
  assert.equal(stats.calls.formSubmitsWithoutAddress, 0, 'the one page nobody renders is not counted at all');
  assert.equal(stats.calls.locationRequests, 2);
  // Nothing rises above SOUND_SET on a call: which handler answers a path is
  // the route table's answer, not the page's.
  const placed = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.grade === 'SOUND_SET');
  const rules = placed.map((e) => e.evidence.rule).sort();
  assert.deepEqual([...new Set(rules)], ['form-submit', 'location-request']);
  const submit = placed.find((e) => e.evidence.rule === 'form-submit');
  assert.equal(submit.evidence.form.methodFrom, 'form element');
  assert.match(submit.evidence.basis, /^the page assigns this address to a form/);
  const bar = placed.find((e) => e.evidence.rule === 'location-request');
  assert.match(bar.evidence.basis, /A server-rendered page has no router/);
  // The screen this page is reaches all of it: the page's own functions are the page.
  const screen = [...g.nodes.values()].find((n) => n.kind === 'screen');
  assert.equal(screen.template, 'WEB-INF/jsp/things/Manage.jsp');
});

test('a candidate becomes a navigation only when the module it names holds a router', () => {
  const g = backend({ 'GET /rows.json': 'com.example.RowController#rows' });
  const stats = addWebFacts(g, readSpa(), { screenAxis: { enabled: true } });
  // Three of the four candidates lead to a router module; `rows.push` leads to
  // an array and is dropped, exactly as it was before this rule existed.
  assert.equal(stats.navigation.bySource['router-module'], 3);
  assert.equal(stats.navigation.bySource['router-link'], 3);
  assert.equal(stats.navigation.bySource.global, 1);
  assert.equal(stats.navigation.navigations, 7);
  // A navigation places no edge and is no call, whatever it is found by.
  assert.equal(stats.calls.withUrl, 0);
  assert.deepEqual(g.edges.filter((e) => e.type === 'CALLS_HTTP'), []);
  // The named route and the bound `:to` are the two this lane cannot follow.
  assert.equal(stats.navigation.unmatchedByKind.named, 1);
  assert.equal(stats.navigation.unmatchedByKind.bound, 1);
});

test('a submit with no address is counted, not placed, and a borrowed address is not placed either', () => {
  const g = backend({
    'POST /things/list.do': 'com.example.ThingController#list',
    'POST /things/search.do': 'com.example.ThingController#search',
    'POST /things/dup.do': 'com.example.ThingController#dup',
    'POST /things/module.do': 'com.example.ThingController#module',
  });
  const stats = addWebFacts(g, readPage(), {
    screenAxis: { enabled: true },
    views: [{
      kind: 'view', owner: 'com.example.ThingController', method: 'search', paramCount: 0, unresolved: 0,
      line: 10, file: 'X.java', views: [{ name: 'things/Search', kind: 'view', from: 'literal' }],
    }],
  });
  assert.equal(stats.calls.formSubmits, 5);
  assert.equal(stats.calls.formSubmitsWithoutAddress, 1);
  // `fnSearch` lands on the route its form element names, and never on the one
  // `linkPage` assigned.
  const fromSearch = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.from.endsWith('Search.jsp#fnSearch'));
  assert.deepEqual(fromSearch.map((e) => [e.to, e.evidence.form.actionFrom]), [['endpoint:POST /things/search.do', 'form element']]);
});
