// viewer_places.test.mjs — five places instead of ten tabs, and the map as the way in (RM67-U2c).
//
// The tab bar mixed three sorts of thing on one line: questions (Explore, Flow,
// Impact), drawings (Graph, ERD, Coupling) and the analysis's own state (Rules).
// It is now five places, each a question a reader comes with, and this file
// holds what that promises, on the page itself over the real fixture server:
//   - five places; a place with several views has a second row; Compare is
//     absent while there is nothing to compare;
//   - every link written before the places lands where it did, project, pick
//     and source pane included, and says which place it is in;
//   - Start asks first: one box for any target, and three questions that go to
//     Trace up, Trace down and Analysis status, a question the target cannot
//     answer saying why instead of going grey;
//   - Start says what this analysis can see and which gaps change an answer;
//   - the map is the way in: asked once Start is on screen, a box opens in
//     place and keeps its own lines, a route or a table inside it shows only the
//     paths through it (the summary tool's own `through`), a breadcrumb goes
//     back, and a mode that walks nothing says why and offers the wider one;
//   - Analysis status sets out every blind spot as its cause, what it touches
//     and what to do, the axes with where they were read from, and Rules;
//   - the Graph's 3D and moving dots are one advanced switch, off by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, settle, ev, ENGINE_ROOT } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * The page over the real fixture server, recording every tool call. `rewrite`
 * may change one tool's answer on its way to the page (an overview with axes
 * and diagnostics the fixture packs do not carry).
 */
async function boot(t, { hash = '#p=gamma', projects = ['gamma', 'delta'], storage = {}, renderer = false, rewrite = {}, hold = () => null } = {}) {
  const { html, base } = await startViewer(t, projects);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && body.name) asked.push({ name: body.name, args: body.arguments || {}, project: body.project });
    await (body && hold(body.name));
    const res = await fetch(base + url, opts);
    if (!body || !rewrite[body.name]) return res;
    return json(rewrite[body.name](await res.json()));
  };
  const page = await bootPage({ html, hash, storage, origin: base, answer, renderer });
  await settle(page.ctx, 20);
  return { ...page, asked };
}
const calls = (asked, name) => asked.filter((a) => a.name === name);
/** A value out of the page's own realm, as plain data this realm can compare. */
const val = (ctx, expr) => JSON.parse(ev(ctx, `JSON.stringify(${expr})`) ?? 'null');
const hashOf = (ctx) => Object.fromEntries(new URLSearchParams(ev(ctx, 'location.hash').replace(/^#/, '')));
const places = (body) => body.querySelectorAll('.tab').filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent);
const activePlace = (body) => body.querySelectorAll('.tab').find((b) => b.classList.contains('active')).dataset.place;
const subtabs = (byId) => byId.get('subtabs').querySelectorAll('.subtab').map((b) => b.textContent);
const click = (el) => el.onclick();
const placeButton = (body, place) => body.querySelectorAll('.tab').find((b) => b.dataset.place === place);
const lines = (byId) => byId.get('ovsummary').querySelectorAll('svg').filter((s) => s.getAttribute('class') === 'sumlinks')
  .flatMap((s) => s.querySelectorAll('path')).map((p) => ({ group: p.getAttribute('data-group'), family: p.getAttribute('data-family'), grade: p.getAttribute('data-grade') }));

// ---------------------------------------------------------------------------
// five places
// ---------------------------------------------------------------------------

test('five places on the first row; Structure and Analysis status carry a second row of views', async (t) => {
  const { ctx, body, byId, asked } = await boot(t);
  assert.deepEqual(places(body), ['Start', 'Trace', 'Structure', 'Analysis status'], 'Compare is absent: this project keeps no earlier build');
  // Start and Analysis status draw from the one landing answer, asked once
  // however many of them come on screen while it is in flight.
  assert.equal(calls(asked, 'overview').length, 1);
  assert.equal(ev(ctx, 'STATE.tab'), 'start', 'a page with no tab in its link opens on Start');
  assert.equal(byId.get('subtabs').classList.contains('hidden'), true, 'Start is one view: no second row');
  click(placeButton(body, 'structure'));
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'graph', 'a place opens on its first view');
  assert.deepEqual(subtabs(byId), ['Graph', 'Table links, by SQL joins', 'Coupling', 'Transactions'],
    'the ERD says what it draws: tables linked by the joins SQL makes');
  click(byId.get('subtabs').querySelectorAll('.subtab')[3]);
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'tx');
  assert.equal(hashOf(ctx).tab, 'tx', 'a view is what the URL names, as it always was');
  click(placeButton(body, 'status'));
  await settle(ctx, 6);
  assert.deepEqual(subtabs(byId), ['Scope and gaps', 'Rules']);
  assert.equal(ev(ctx, 'STATE.tab'), 'status');
  // Back to Structure: it opens where the reader left it, not on its first view.
  click(placeButton(body, 'structure'));
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'tx');
  assert.equal(activePlace(body), 'structure');
});

test('clicking the place on screen puts its view back as it opened', async (t) => {
  const { ctx, body } = await boot(t, { hash: '#p=gamma&tab=trace' });
  ev(ctx, "openTrace({kind:'table', id:'gamma_order'}, 'up')");
  await settle(ctx, 12);
  assert.ok(ev(ctx, 'TRACE.target'));
  click(placeButton(body, 'trace'));
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'TRACE.target'), null, 'the place on screen, clicked again, is Show all');
  assert.equal(ev(ctx, 'STATE.tab'), 'trace');
});

/** Every tab a link could name before the places, and where it lands now. */
const OLD_LINKS = [
  ['overview', null, 'start', 'start'],
  ['explore', 'table:gamma_order', 'trace', 'trace'],
  ['flow', 'endpoint:POST /order/save', 'trace', 'trace'],
  ['impact', 'column:gamma_order.total', 'trace', 'trace'],
  ['coupling', null, 'coupling', 'structure'],
  ['graph', null, 'graph', 'structure'],
  ['erd', 'table:gamma_order', 'erd', 'structure'],
  ['tx', null, 'tx', 'structure'],
  ['rules', null, 'rules', 'status'],
  ['structure', null, 'graph', 'structure'],
];

test('every link written before the places lands on the same view, project and source pane, in its place', async (t) => {
  for (const [tab, pick, view, place] of OLD_LINKS) {
    const src = 'statement:com.g.GMapper.selectOrder';
    const hash = `#p=gamma&tab=${tab}${pick ? `&pick=${encodeURIComponent(pick)}` : ''}&src=${encodeURIComponent(src)}`;
    const { ctx, body } = await boot(t, { hash, projects: ['alpha', 'gamma'], renderer: true });
    assert.equal(ev(ctx, 'STATE.tab'), view, `${hash}: the view`);
    assert.equal(activePlace(body), place, `${hash}: the place it is in`);
    const h = hashOf(ctx);
    assert.equal(h.p, 'gamma', `${hash}: the project`);
    assert.equal(h.tab, view, `${hash}: the URL now names the view`);
    if (pick && view === 'trace') assert.equal(h.pick, pick, `${hash}: the pick`);
    assert.equal(ev(ctx, 'SRC.open && SRC.node'), src, `${hash}: the source pane`);
  }
  // ...and through Back and Forward, where the page applies a URL it did not
  // load with: an old name is read the same way there.
  const { ctx } = await boot(t, { hash: '#p=gamma&tab=trace' });
  for (const [tab, , view] of OLD_LINKS.filter(([, pick]) => !pick)) {
    ev(ctx, `location.hash=${JSON.stringify(`#p=gamma&tab=${tab}`)}; applyHash()`);
    await settle(ctx, 6);
    assert.equal(ev(ctx, 'STATE.tab'), view, `back to tab=${tab}`);
    ev(ctx, "location.hash='#p=gamma&tab=trace'; applyHash()");
    await settle(ctx, 4);
  }
});

test('a project with an earlier build shows Compare, and a link to it lands there', async (t) => {
  const { ctx, body } = await boot(t, { hash: '#p=gamma&tab=compare' });
  // The fixture keeps no earlier build: the place is absent, and the link says
  // where the reader is rather than drawing a blank.
  assert.equal(placeButton(body, 'compare').classList.contains('hidden'), true);
  ev(ctx, "STATE.meta = { ...STATE.meta, projectId:'gamma', history:[{ id:'h1', commit:'a'.repeat(40), builtAt:'2026-01-01T00:00:00Z', dirty:false }] }; renderCompareChrome()");
  assert.deepEqual(places(body), ['Start', 'Trace', 'Structure', 'Compare', 'Analysis status']);
  assert.equal(activePlace(body), 'compare');
});

// ---------------------------------------------------------------------------
// Start asks first
// ---------------------------------------------------------------------------

const questions = (byId) => byId.get('sentries').children.map((c) => ({
  title: c.querySelector('.sqtitle').textContent, sub: c.querySelector('.sqsub').textContent, go: c.tagName === 'BUTTON' }));

test('Start: with no target, each question opens the list it starts from, already reading that way', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  const q = questions(byId);
  assert.deepEqual(q.map((x) => x.title), ['What breaks if I change it?', 'How far does it reach?', 'What did the analysis not see?']);
  assert.ok(q.every((x) => x.go), 'with no target every question can still be asked');
  click(byId.get('sentries').children[0]);
  await settle(ctx, 12);
  assert.deepEqual([ev(ctx, 'STATE.tab'), ev(ctx, 'TRACE.dir'), ev(ctx, 'RAIL.trace.kind')], ['trace', 'up', 'table']);
  assert.match(byId.get('tracewrap').textContent, /see where it is used, which is what a change there would touch/,
    'the list says which question is waiting for its target');
  const tableRow = byId.get('tlist').querySelectorAll('.brrow')[0] || byId.get('tlist').querySelectorAll('button')[0];
  assert.ok(tableRow, 'the list is on screen');
  ev(ctx, "activateTab('start')");
  click(byId.get('sentries').children[1]);
  await settle(ctx, 12);
  assert.deepEqual([ev(ctx, 'TRACE.dir'), ev(ctx, 'RAIL.trace.kind')], ['down', 'endpoint']);
  ev(ctx, "activateTab('start')");
  click(byId.get('sentries').children[2]);
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'status', 'the third question is Analysis status');
  assert.equal(calls(asked, 'flow').filter((c) => c.args.direction === 'up' || c.args.table).length, 0, 'no question was asked of a target nobody picked');
});

test('Start: a picked target is asked either way; a way it does not have says why instead of going grey', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "byId('sentry').value='gamma_order'; STARTV.pick={kind:'table', value:'gamma_order'}; chainCommit(STARTV)");
  await settle(ctx, 10);
  assert.deepEqual(val(ctx, 'START.target'), { kind: 'table', id: 'gamma_order' });
  assert.match(byId.get('starget').textContent, /gamma_order/);
  const q = questions(byId);
  assert.equal(q[0].go, true);
  assert.match(q[0].sub, /gamma_order/, 'the question says what it will answer, about which target');
  assert.equal(q[1].go, false, 'a table has no "how far does it reach": not a button');
  assert.match(q[1].sub, /A table is where a chain ends, so it uses nothing/, '...and it says why, in the words Trace uses');
  click(byId.get('sentries').children[0]);
  await settle(ctx, 12);
  const f = calls(asked, 'flow').at(-1);
  assert.deepEqual([ev(ctx, 'STATE.tab'), f.args.direction, f.args.table], ['trace', 'up', 'gamma_order']);
  // A route has both ways, and the box reads it by its shape.
  ev(ctx, "activateTab('start'); byId('sentry').value='POST /order/save'; STARTV.pick=null; chainCommit(STARTV)");
  await settle(ctx, 10);
  assert.deepEqual(val(ctx, 'START.target'), { kind: 'endpoint', id: 'POST /order/save' });
  assert.ok(questions(byId).slice(0, 2).every((x) => x.go));
  click(byId.get('sentries').children[1]);
  await settle(ctx, 12);
  assert.deepEqual(val(ctx, 'TRACE.target'), { kind: 'endpoint', id: 'POST /order/save' });
  assert.equal(ev(ctx, 'TRACE.dir'), 'down');
});

test('Start: / finds a target from anywhere on Start, and the box asks the same typeahead Trace does', async (t) => {
  const { ctx, byId, fireDoc, asked } = await boot(t);
  let focused = false;
  byId.get('sentry').focus = () => { focused = true; };
  fireDoc('keydown', { key: '/', target: byId.get('tab-start') });
  assert.equal(focused, true);
  const before = asked.length;
  ev(ctx, "chainSuggest(STARTV, 'gamma')");
  await settle(ctx, 10);
  const names = asked.slice(before).map((a) => a.name).sort();
  assert.ok(names.includes('search') && names.includes('flow'), `the same kinds as Trace's box: ${names}`);
  assert.ok(byId.get('ssug').querySelectorAll('.sugrow').length > 0);
});

// ---------------------------------------------------------------------------
// what this analysis can see, and the gaps that change an answer
// ---------------------------------------------------------------------------

/** gamma's overview, with the axes and a diagnostic a real pack states. */
function withAxes(r) {
  r.answer.axes = {
    catalog: { status: 'shipped', reason: null, sources: ['schema.prisma'] },
    statements: { status: 'shipped', reason: null },
    column: { status: 'degraded', reason: 'where no mapper SQL names a column, we derived it' },
    code: { status: 'shipped', reason: null },
    web: { status: 'shipped', reason: null, notes: ['3 of 151 frontend call site(s) were traced to no client'] },
    screen: { status: 'not-shipped', reason: 'the pack was analyzed without a frontend' },
    jpa: { status: 'not-shipped', reason: 'the JPA bridge did not run' },
    mybatisPlus: { status: 'degraded', reason: 'the profile declares no mybatisPlus.namingStrategy' },
  };
  r.answer.diagnostics = [
    { kind: 'TS_PREFIX_EXCLUDE_UNREAD', level: 'warn', reason: 'the global prefix exclude list in main.ts is built at run time, so declare tsBackend.globalPrefix' },
  ];
  return r;
}

test('Start says what this analysis can see: the lanes, the mode, and every axis with where it was read from', async (t) => {
  const { byId } = await boot(t, { rewrite: { overview: withAxes } });
  const scope = byId.get('sscope').textContent;
  assert.match(scope, /read by\s*sql \+ java/);
  assert.match(scope, /mode conservative, depth not capped, following EXACT, SOUND_SET links/, "a census walked with no hop cap says so in words");
  const axes = byId.get('sscope').querySelectorAll('.saxis').map((b) => b.textContent);
  assert.ok(axes.includes('database schema collected from schema.prisma'), axes.join(' | '));
  assert.ok(axes.includes('columns only partly read'));
  assert.ok(axes.includes('screens not collected'));
  assert.ok(axes.includes('MyBatis-Plus mappings only partly read'), 'a Java bridge that ran in part changes a grade, so it is listed');
  assert.ok(!axes.some((x) => x.startsWith('JPA')), 'a bridge that did not run on this stack is noise, and is not listed');
});

test('Start lists the gaps that change an answer, each a way to its row on Analysis status', async (t) => {
  const { ctx, byId } = await boot(t, { rewrite: { overview: withAxes } });
  const rows = byId.get('sgaps').querySelectorAll('button.sgap').map((b) => b.textContent);
  // Five of the eight things it could not see change an answer: the screens
  // axis not collected, the calls it could not follow, the columns and the
  // MyBatis-Plus mappings read in part, and the lane's diagnostic.
  assert.equal(byId.get('sgaps').querySelector('h2').textContent, 'Gaps that change an answer (5)');
  // input first (an axis not collected), then what it could not read.
  assert.match(rows[0], /^screens: not collected/);
  assert.ok(rows.some((x) => x.startsWith('calls we could not follow')));
  assert.ok(rows.some((x) => x.startsWith('a lane reported TS_PREFIX_EXCLUDE_UNREAD')), 'a lane diagnostic changes an answer too');
  assert.ok(!rows.some((x) => x.startsWith('tables no endpoint reaches')), 'a table nothing reaches changes no answer: it is Status only');
  const go = byId.get('sgaps').querySelectorAll('button.sgap').find((b) => b.textContent.startsWith('calls we could not follow'));
  click(go);
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'status');
  assert.equal(ev(ctx, "foldIsOpen('ov.gap.unresolved-calls')"), true, 'the row it named is opened to its whole cause');
});

// ---------------------------------------------------------------------------
// the map is the way in
// ---------------------------------------------------------------------------

test('the map is asked once Start is on screen, and never by a page that opened elsewhere', async (t) => {
  const onTrace = await boot(t, { hash: '#p=gamma&tab=trace' });
  assert.equal(calls(onTrace.asked, 'summary').length, 0, 'a link to one route does not wait for a walk of every route');
  ev(onTrace.ctx, "activateTab('start')");
  await settle(onTrace.ctx, 12);
  assert.equal(calls(onTrace.asked, 'summary').length, 1);
  ev(onTrace.ctx, "activateTab('trace'); activateTab('start')");
  await settle(onTrace.ctx, 6);
  assert.equal(calls(onTrace.asked, 'summary').length, 1, 'coming back draws it from memory');
  // While the first answer is still on its way, the page asks nothing more:
  // a language switch and a trip away and back all find it in flight.
  let release;
  const held = new Promise((r) => { release = r; });
  const slow = await boot(t, { hold: (name) => (name === 'summary' ? held : null) });
  ev(slow.ctx, "setLang('ko'); activateTab('trace'); activateTab('start'); setLang('en')");
  await settle(slow.ctx, 6);
  release();
  await settle(slow.ctx, 12);
  assert.equal(calls(slow.asked, 'summary').length, 1, 'one question in flight, answered once');
  assert.ok(ev(slow.ctx, 'SUM.resp'), 'and drawn when it lands');
  // It says what the boxes are grouped by, and a rule with no shared prefix
  // to name is said without one, never "below -". Since RM67-U2d each rule's
  // boxes have their own name (test/viewer_names_and_remedies.test.mjs).
  const rule = onTrace.byId.get('ovsummary').querySelector('.panelsub').textContent;
  assert.match(rule, /^API groups are/);
  const bare = ev(onTrace.ctx, "summaryRuleLine({rule:{groups:{kind:'code-path', commonPrefix:''}, tables:{kind:'name-words', commonPrefix:''}}})");
  assert.equal(bare, 'Code areas are where the handler code sits. They are not modules anyone declared, nor the API groups the header counts by path. Families are tables whose names start with the same word.');
});

test('a box opens in place and keeps only its own lines; a route in it shows only the paths through it; the breadcrumb goes back', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  const all = lines(byId);
  assert.deepEqual(all.map((l) => `${l.group}>${l.family}`).sort(), ['order>item', 'order>order']);
  const head = byId.get('ovsummary').querySelectorAll('.sumhead').find((h) => h.textContent.startsWith('order'));
  click(head);
  await settle(ctx, 6);
  const box = byId.get('ovsummary').querySelectorAll('.sumbox').find((b) => b.classList.contains('open'));
  assert.ok(box, 'the box opened in place');
  assert.deepEqual(box.querySelectorAll('.sumrow').map((r) => r.title.split(':')[0]), ['GET /order/{id}', 'POST /order/save']);
  assert.ok(lines(byId).every((l) => l.group === 'order'), 'only the lines through the open box');
  const admin = byId.get('ovsummary').querySelectorAll('.sumbox').find((b) => b.textContent.startsWith('admin'));
  assert.ok(admin.classList.contains('dim'), 'a box none of its lines reach steps back');
  assert.equal(calls(asked, 'summary').length, 1, 'opening a box asks nothing');
  // A family opens the same way, and keeps only the lines into it.
  ev(ctx, "summarySelect('f:item')");
  await settle(ctx, 4);
  assert.deepEqual(lines(byId).map((l) => `${l.group}>${l.family}`), ['order>item']);
  ev(ctx, "summarySelect('g:order')");
  await settle(ctx, 4);
  // One route: its own paths, from the tool.
  click(box.querySelectorAll('.sumrow').find((r) => r.title.startsWith('GET /order/{id}')));
  await settle(ctx, 12);
  const th = calls(asked, 'summary').at(-1);
  assert.deepEqual([th.args.endpoint, th.args.mode], ['GET /order/{id}', 'conservative']);
  assert.deepEqual(lines(byId).map((l) => `${l.group}>${l.family}`), ['order>order'], 'GET /order/{id} reaches the order family only');
  const crumbs = byId.get('ovsummary').querySelector('.sumcrumbs');
  assert.deepEqual(crumbs.querySelectorAll('.sumcrumb').map((c) => c.textContent), ['Whole map', 'API group order', 'GET /order/{id}']);
  // Every way into Trace from the picked route, beside the picture.
  const side = byId.get('ovsummary').querySelector('.sumdetail');
  assert.deepEqual(side.querySelector('.sumgo').querySelectorAll('button').map((b) => b.textContent), ['What it uses', 'Where it is used', 'Details']);
  // Back one step, then to the whole map.
  click(crumbs.querySelectorAll('button.sumcrumb')[1]);
  await settle(ctx, 4);
  assert.equal(ev(ctx, 'SUM.node'), null);
  assert.equal(lines(byId).length, 2);
  click(byId.get('ovsummary').querySelector('.sumcrumbs').querySelectorAll('button.sumcrumb')[0]);
  await settle(ctx, 4);
  assert.equal(ev(ctx, 'SUM.sel'), null);
  assert.equal(lines(byId).length, all.length);
});

test('a table in an open family shows the groups whose routes reach it; its Trace button asks where it is used', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "summarySelect('f:order'); summaryPickNode('table:gamma_order')");
  await settle(ctx, 12);
  assert.equal(calls(asked, 'summary').at(-1).args.table, 'gamma_order');
  assert.deepEqual(lines(byId).map((l) => `${l.group}>${l.family}`), ['order>order']);
  const row = byId.get('ovsummary').querySelectorAll('.sumrowwrap').find((w) => w.textContent.startsWith('gamma_order'));
  click(row.querySelector('.sumtrace'));
  await settle(ctx, 12);
  assert.deepEqual([ev(ctx, 'STATE.tab'), ev(ctx, 'TRACE.dir')], ['trace', 'up']);
  assert.deepEqual(val(ctx, 'TRACE.target'), { kind: 'table', id: 'gamma_order' });
});

test('a mode that walks nothing says why in its own numbers, and offers the mode that would', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "summarySetMode('strict')");
  await settle(ctx, 12);
  assert.equal(calls(asked, 'summary').at(-1).args.mode, 'strict');
  assert.equal(lines(byId).length, 0);
  const note = byId.get('ovsummary').querySelector('.sumempty');
  assert.ok(note, 'an empty map is said, not left blank');
  assert.match(note.textContent, /No route reaches a table in mode strict\. The walks left \d+ link\(s\) graded SOUND_SET out/);
  click(note.querySelector('button'));
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'SUM.mode'), 'conservative');
  assert.equal(lines(byId).length, 2);
  assert.equal(calls(asked, 'summary').filter((c) => c.args.mode === 'conservative' && !c.args.endpoint && !c.args.table).length, 1,
    'the conservative answer came back from memory');
});

// ---------------------------------------------------------------------------
// Analysis status
// ---------------------------------------------------------------------------

test('Analysis status: every blind spot says its cause, what it touches and what to do', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=status', rewrite: { overview: withAxes } });
  const gaps = byId.get('stgaps').querySelectorAll('.stitem');
  assert.ok(gaps.length >= 3);
  for (const g of gaps) {
    const labels = g.querySelectorAll('.stlbl').map((x) => x.textContent);
    assert.deepEqual(labels, ['cause', 'touches', 'what to do'], g.textContent.slice(0, 60));
    assert.ok(g.querySelectorAll('.stval').every((v) => v.textContent.trim().length > 0), 'no line is left empty');
  }
  const unreached = gaps.find((g) => g.id === 'st-ov-gap-tables-not-reached');
  assert.ok(unreached, 'each row can be linked to by its kind');
  assert.match(unreached.textContent, /gamma_audit/, 'what it touches names the tables, each a way into Trace');
  // The axes: state, where from, and what each one changes.
  const axes = byId.get('staxes').querySelectorAll('tr').filter((r) => r.id);
  const catalog = axes.find((r) => r.id === 'st-ov-axis-catalog').textContent;
  assert.match(catalog, /collected/);
  assert.match(catalog, /schema\.prisma/);
  assert.match(axes.find((r) => r.id === 'st-ov-axis-web').textContent, /traced to no client/, 'a whole axis still says its notes');
  // The lanes' diagnostics, one row per kind, with what to do.
  const diag = byId.get('stdiags').querySelector('#st-ov-diag-TS_PREFIX_EXCLUDE_UNREAD');
  assert.ok(diag);
  assert.match(diag.textContent, /declare tsBackend\.globalPrefix/);
  assert.match(diag.textContent, /what to do/);
  // The three facts on top, and Rules as this place's second view.
  const facts = byId.get('stfacts').querySelectorAll('.panel').map((p) => p.querySelector('h2').textContent);
  assert.deepEqual(facts, ['How fresh', 'Verification', 'How it was counted']);
  click(byId.get('subtabs').querySelectorAll('.subtab')[1]);
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'STATE.tab'), 'rules');
});

test('a language switch redraws Start, the map and Analysis status from memory, and asks nothing', async (t) => {
  const { ctx, byId, asked } = await boot(t, { rewrite: { overview: withAxes } });
  const n = asked.length;
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.equal(asked.length, n, 'nothing asked');
  assert.match(byId.get('sentries').textContent, /바꾸면 어디가 깨지나요\?/);
  assert.match(byId.get('ovsummary').textContent, /전체 지도/);
  assert.match(byId.get('stgaps').textContent, /원인/);
});

// ---------------------------------------------------------------------------
// Structure: the Graph's advanced view
// ---------------------------------------------------------------------------

test('the Graph is flat and still until the advanced view is switched on, and the switch is remembered', async (t) => {
  const { ctx, byId, store } = await boot(t, { hash: '#p=gamma&tab=graph', renderer: true });
  assert.equal(byId.get('gadvbox').classList.contains('hidden'), true, '3D and the dots are not on the toolbar by default');
  // A browser that could draw 3D, with 3D chosen before the switch went off.
  ev(ctx, "mapWebglOk=()=>true; GMAP.rend='3d'; renderMap()");
  assert.equal(ev(ctx, 'GMAP.drawn'), '2d', 'off, a 3D choice left behind draws nothing in 3D');
  ev(ctx, 'mapSetLit(GMAP.links[0] && GMAP.links[0].source && (GMAP.links[0].source.id || GMAP.links[0].source))');
  assert.equal(Number(ev(ctx, 'GMAP.links.length ? mapParticles(GMAP.links[0]) : 0')), 0, 'no dot moves, lit or not');
  click(byId.get('gadv'));
  await settle(ctx, 4);
  assert.equal(store.get('cascade.viewer.graph.advanced'), 'on');
  assert.equal(byId.get('gadvbox').classList.contains('hidden'), false);
  assert.equal(byId.get('gadv').getAttribute('aria-pressed'), 'true');
  ev(ctx, "GMAP.rend='2d'");
  const again = await boot(t, { hash: '#p=gamma&tab=graph', renderer: true, storage: { 'cascade.viewer.graph.advanced': 'on' } });
  assert.equal(again.byId.get('gadvbox').classList.contains('hidden'), false, 'remembered');
});

// ---------------------------------------------------------------------------
// the page's one scope
// ---------------------------------------------------------------------------

test('no two page scripts declare the same name: in one scope, a later function would silently replace an earlier one', () => {
  // This is how the map's `summaryRows` once replaced Compare's, and every
  // Compare report stopped drawing.
  const dir = path.join(ENGINE_ROOT, 'viewer', 'js');
  const seen = new Map();
  const clash = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1] || m[2];
      if (seen.has(name)) clash.push(`${name}: ${seen.get(name)} and ${f}`);
      else seen.set(name, f);
    }
  }
  assert.deepEqual(clash, []);
});
