// viewer_lanes.test.mjs — the Flow and Impact lanes a person can read (RM67).
//
// Every lane was 180px wide and cut every name to eight characters, the lines
// crossed in a knot, 88 services were 88 rows, the mode picker called a
// candidate set "likely", and a moved cache listed 866 copies of one diagnostic.
// What this file holds, on the page itself: a lane folds by owner and a row the
// reader picked or found is never folded; the counts over a lane keep drawn,
// fetched and total apart and "fetch more" pages the lane from the tool; a line
// is dashed by the grade of THAT link while a badge is the path's; a picked
// chain stays lit; the arrows walk the picture; the modes say what they admit;
// a flood of one diagnostic is one row; and the list beside the picture can be
// made wider and cuts a name in the middle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage as boot, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { GRADE_DASH } from '../src/viewer/chainlayout.mjs';

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const basis = { project: 'gamma', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } };

/** One service row: `owner#m<i>`, at hop 3, a candidate, called from the handler. */
const svc = (owner, i, extra = {}) => ({ id: `com.big.${owner}#m${i}`, short: `${owner}#m${i}`, owner: `com.big.${owner}`, hops: 3, grade: 'SOUND_SET',
  link: { from: 'symbol:com.big.BigController#get', grade: 'SOUND_SET', type: 'MAY_CALL' }, path: [], ...extra });

/**
 * A down walk from GET /big: 30 services from three owners (the lane folds),
 * one statement under the first, one table. `page` cuts the services lane the
 * way the tool does: `limit` rows from `offset`, of `total`.
 */
function bigFlow({ offset = 0, limit = 40, total = 30 } = {}) {
  const all = Array.from({ length: total }, (_, i) => svc(['OrderServiceImpl', 'CartServiceImpl', 'MemberServiceImpl'][i % 3], i));
  const services = all.slice(offset, offset + limit);
  const statements = [{ id: 'com.big.OrderMapper.select', short: 'OrderMapper.select', statementType: 'select', hops: 4, grade: 'SOUND_SET',
    link: { from: 'symbol:com.big.OrderServiceImpl#m0', grade: 'EXACT', type: 'MAY_CALL' }, tables: [{ table: 'orders', access: 'read' }], path: [] }];
  const tables = [{ table: 'orders', hops: 5, grade: 'SOUND_SET', via: 'com.big.OrderMapper.select', viaShort: 'OrderMapper.select', statements: 1, access: 'read', reads: 2, writes: 0 }];
  const next = offset + services.length < total ? offset + services.length : null;
  return {
    answer: {
      entry: { kind: 'endpoint', id: 'GET /big', httpMethod: 'GET', path: '/big', handler: 'com.big.BigController#get', handlerShort: 'BigController#get', grade: 'EXACT', start: 'symbol:com.big.BigController#get' },
      walk: { mode: 'conservative', direction: 'down', depth: 6, walked: 33, other: 0, byLinkGrade: { EXACT: 1, SOUND_SET: 31 }, cut: { byMode: 0 }, beyond: {}, note: null },
      layers: [], services, statements, tables,
    },
    basis, trust: { trustLevel: 'UNCERTIFIED' }, limits: [],
    truncated: { any: next != null, fields: [
      { field: 'services', shown: services.length, total, order: 'hops asc, grade desc, id asc', nextOffset: next },
      { field: 'statements', shown: 1, total: 1, order: 'hops asc, grade desc, id asc', nextOffset: null },
      { field: 'tables', shown: 1, total: 1, order: 'hops asc, grade desc, table asc', nextOffset: null }] },
  };
}

/** The page over the fixture server, answering `flow` for GET /big itself. */
async function bootBig(t, { total = 30, limit = 40 } = {}) {
  const { html, base } = await startViewer(t, ['gamma']);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && body.name === 'flow' && body.arguments && body.arguments.endpoint === 'GET /big') {
      asked.push(body.arguments);
      return json(bigFlow({ offset: body.arguments.offset || 0, limit: body.arguments.offset ? body.arguments.limit : limit, total }));
    }
    return fetch(base + url, opts);
  };
  const page = await boot({ html, hash: '#p=gamma&tab=trace', storage: {}, origin: base, answer });
  ev(page.ctx, "openTrace({kind:'endpoint', id:'GET /big'}, 'down')");
  await settle(page.ctx, 20);
  return { ...page, asked };
}

const lane = (byId, field) => byId.get('tracewrap').querySelectorAll('.fcol').find((c) => c.dataset.field === field);
const names = (col) => col.querySelectorAll('.frow').map((r) => (r.querySelector('.fname') || {}).textContent);

test('a long lane folds one owner\'s rows into one row, with the true count, and opens it in place', async (t) => {
  const { ctx, byId } = await bootBig(t);
  const col = lane(byId, 'services');
  const folds = col.querySelectorAll('.ffold');
  assert.ok(folds.length >= 3, `the 30 services fold by owner: ${names(col).join(', ')}`);
  assert.ok(names(col).includes('OrderServiceImpl'));
  assert.match(folds[0].textContent, /10 rows/, 'a folded row says how many it holds');
  // The band over them still counts every row in it, folded or not.
  assert.match(col.querySelector('.fdiv').textContent, /candidate set \(30\)/);
  // Three numbers kept apart: drawn, fetched, in all.
  assert.match(col.querySelector('.fcolsub').textContent, /\d+ drawn, 30 fetched, 30 in all/);
  // Opening a group draws its rows where it stood.
  const group = folds.find((f) => /OrderServiceImpl/.test(f.textContent));
  for (const fn of group._listeners.get('click')) fn({});
  await settle(ctx, 4);
  const opened = names(lane(byId, 'services'));
  assert.equal(opened.filter((n) => /^OrderServiceImpl\.m\d+$/.test(n)).length, 10, `the group opened: ${opened.join(', ')}`);
});

test('a row the reader picked is never folded, and a chain through a folded row is opened to be drawn whole', async (t) => {
  const { ctx, byId } = await bootBig(t);
  // The statement hangs off OrderServiceImpl#m0, which sits inside a fold.
  assert.equal(ev(ctx, "TRACEV.proxy.get('symbol:com.big.OrderServiceImpl#m0')") !== 'symbol:com.big.OrderServiceImpl#m0', true);
  ev(ctx, "flowSelect(TRACEV, 'statement:com.big.OrderMapper.select')");
  await settle(ctx, 4);
  assert.equal(ev(ctx, "TRACEV.proxy.get('symbol:com.big.OrderServiceImpl#m0')"), 'symbol:com.big.OrderServiceImpl#m0', 'the chain is drawn whole');
  assert.ok(names(lane(byId, 'services')).includes('OrderServiceImpl.m0'));
  // ...and it stays lit when the pointer leaves: the picked chain, not nothing.
  ev(ctx, 'flowClearHover(TRACEV)');
  const row = (k) => ev(ctx, `TRACEV.rows.get(${JSON.stringify(k)}).els[0].className`);
  assert.match(row('symbol:com.big.OrderServiceImpl#m0'), /\bhot\b/);
  assert.match(row('statement:com.big.OrderMapper.select'), /\bhot\b/);
  assert.match(row('table:orders'), /\bhot\b/);
});

test('the find box finds a row by name, opens whatever folds it, and says how many it found', async (t) => {
  const { ctx, byId } = await bootBig(t);
  ev(ctx, "TRACEV.find='MemberServiceImpl.m5'; laneRerender(TRACEV)");
  await settle(ctx, 4);
  assert.equal(ev(ctx, 'TRACEV.found.size'), 1);
  const col = lane(byId, 'services');
  const hit = col.querySelectorAll('.frow').find((r) => (r.querySelector('.fname') || {}).textContent === 'MemberServiceImpl.m5');
  assert.ok(hit, 'the found row is drawn on its own');
  assert.match(hit.className, /\bfound\b/);
  assert.match(byId.get('tracestrip').textContent, /1 found/);
});

test('"fetch more" asks the tool for the next page of that lane and keeps the rows it had', async (t) => {
  const { ctx, byId, asked } = await bootBig(t, { total: 50, limit: 40 });
  const col = lane(byId, 'services');
  assert.match(col.querySelector('.fcolsub').textContent, /40 fetched, 50 in all/);
  const btn = col.querySelector('.moreb');
  assert.ok(btn, 'a lane the tool cut offers the next page');
  btn.onclick();
  await settle(ctx, 12);
  assert.deepEqual(asked.at(-1).offset, 40, 'the next page starts where the lane stopped');
  assert.equal(ev(ctx, 'TRACEV.resp.answer.services.length'), 50);
  assert.equal(ev(ctx, "TRACEV.resp.truncated.fields.find((f)=>f.field==='services').nextOffset"), null);
  assert.equal(ev(ctx, 'TRACEV.args.limit'), 50, 'the export asks for what is on screen');
  assert.match(lane(byId, 'services').querySelector('.fcolsub').textContent, /50 fetched, 50 in all/);
});

test('a line is dashed by the grade of that one link, from the page\'s one dash table; the badge is the path\'s', async (t) => {
  const { ctx, byId } = await bootBig(t);
  // OrderMapper.select: its link from the service is EXACT, its path SOUND_SET.
  ev(ctx, "flowSelect(TRACEV, 'statement:com.big.OrderMapper.select')");
  await settle(ctx, 4);
  const paths = byId.get('tracewrap').querySelectorAll('path').filter((p) => /\bflink\b/.test(p.className));
  const byId2 = (to) => paths.find((p) => ev(ctx, `TRACEV.paths.find((x)=>x.id===${JSON.stringify(p.getAttribute('id'))}).to`) === to);
  const exact = byId2('statement:com.big.OrderMapper.select');
  assert.ok(exact, 'the link into the statement is drawn');
  assert.equal(exact.getAttribute('stroke-dasharray'), null, 'an EXACT link is solid');
  const stmt = ev(ctx, "TRACEV.rows.get('statement:com.big.OrderMapper.select').els[0].querySelector('.grade').textContent");
  assert.equal(stmt, 'SOUND_SET', 'the row still wears its path\'s grade');
  for (const p of paths) {
    const g = ev(ctx, `TRACEV.linkSpecs.find((l)=>TRACEV.paths.find((x)=>x.id===${JSON.stringify(p.getAttribute('id'))}).to===l.to).grade`);
    assert.equal(p.getAttribute('stroke-dasharray'), GRADE_DASH[g], `a ${g} link`);
  }
});

test('the arrows walk the picture: across to the row a link joins, and down a lane', async (t) => {
  const { ctx, byId } = await bootBig(t);
  let focused = null;
  const rows = byId.get('tracewrap').querySelectorAll('.frow');
  for (const r of rows) r.focus = () => { focused = r; };
  const entry = ev(ctx, "TRACEV.rows.get(TRACEV.model.lanes[0].rows[0].key).els[0]") ;
  const key = (ev2) => { for (const fn of entry._listeners.get('keydown')) fn({ key: ev2, preventDefault() {} }); };
  key('ArrowRight');
  assert.ok(focused, 'right moves into the next lane');
  assert.equal(focused.closest('.fcol').dataset.field, 'services');
  const inServices = focused;
  for (const fn of inServices._listeners.get('keydown')) fn({ key: 'ArrowDown', preventDefault() {} });
  assert.notEqual(focused, inServices, 'down moves within the lane');
  assert.equal(focused.closest('.fcol').dataset.field, 'services');
});

test('the modes say what each one admits, with the grade after it, in both languages', async (t) => {
  const { ctx, byId } = await bootBig(t);
  const opts = () => byId.get('tmode').querySelectorAll('option').map((o) => o.textContent);
  assert.deepEqual(opts(), ['conservative: proven links + candidate sets (SOUND_SET)', 'strict: proven links only (EXACT)',
    'heuristic: proven links + candidate sets + guesses (HEURISTIC)']);
  assert.equal(opts().some((o) => /likely/.test(o)), false, 'a candidate set is a guarantee, not a likelihood');
  byId.get('langseg').children[1].onclick();
  await settle(ctx, 6);
  assert.deepEqual(opts(), ['conservative: 확정 연결 + 후보 집합 (SOUND_SET)', 'strict: 확정 연결만 (EXACT)',
    'heuristic: 확정 연결 + 후보 집합 + 추정 (HEURISTIC)']);
  // The legend beside the picture says the same words as the badges' tooltips.
  const legend = byId.get('traceside').textContent;
  assert.match(legend, /실제 대상을 반드시 포함하는 후보 집합입니다/);
  assert.equal(ev(ctx, "badge('SOUND_SET').title"), '실제 대상을 반드시 포함하는 후보 집합입니다');
});

/** 866 copies of one diagnostic from a moved cache, two ways of failing, and one other. */
const flood = () => [
  ...Array.from({ length: 860 }, (_, i) => ({ kind: 'SHARD_UNUSABLE', severity: 'warn', key: `javafacts-${i}`,
    reason: `shard javafacts-${i}abc is missing from the cache (/tmp/c/cas/javafacts-${i}/facts.jsonl), so javafacts src/F${i}.java is recomputed from source instead of reused` })),
  ...Array.from({ length: 6 }, (_, i) => ({ kind: 'SHARD_UNUSABLE', severity: 'warn', key: `lineage-${i}`,
    reason: `shard lineage-${i} is corrupt: content sha256 ab${i} != recorded cd${i} (/tmp/c/l${i}), so lineage M.s${i} is recomputed from source instead of reused` })),
  { kind: 'TS_PREFIX_UNREAD', severity: 'warn', key: null, reason: 'the global prefix is read from configuration' },
];

test('a flood of one diagnostic is one blind spot with its count, and inside it one line per thing it says', async (t) => {
  const { ctx, body } = await bootBig(t);
  // The lanes' diagnostics are rows of their own on Analysis status (RM67-U2c).
  ev(ctx, `activateTab('status'); OV.resp.answer.diagnostics = ${JSON.stringify(flood())}; renderOverview();`);
  await settle(ctx, 4);
  const items = body.querySelector('#stdiags').querySelectorAll('.stitem');
  const chips = items.map((r) => r.querySelector('.stitemhead .ovdiag'));
  assert.deepEqual(chips.map((c) => c.textContent).sort(), ['SHARD_UNUSABLE', 'TS_PREFIX_UNREAD'], 'one row per kind, not 867');
  const shard = items.find((r) => r.id === 'st-ov-diag-SHARD_UNUSABLE');
  assert.ok(shard, 'the row a link from Start goes to');
  assert.equal(shard.querySelector('.stitemhead .ovnum').textContent, '866', 'with its count');
  const g = JSON.parse(ev(ctx, `JSON.stringify(diagGroups(${JSON.stringify(flood())}).map((x)=>({kind:x.kind,count:x.count,causes:x.causes.map((c)=>c.count)})))`));
  assert.deepEqual(g, [{ kind: 'SHARD_UNUSABLE', count: 866, causes: [860, 6] }, { kind: 'TS_PREFIX_UNREAD', count: 1, causes: [1] }],
    'two ways to fail are two lines, never one cause for all');
  // The limits list: the same grouping, the first few in full, and what to do.
  const rows = ev(ctx, `(()=>{ const lim=${JSON.stringify(flood())}.map((d)=>({scope:'diagnostic:'+d.kind, reason:d.reason})); return limitRows('t.', lim).length; })()`);
  assert.equal(rows, 2);
  const text = ev(ctx, `(()=>{ const g=diagGroups(${JSON.stringify(flood())})[0]; const d=document.createElement('div'); d.append(...diagGroupBody('t', g).filter(Boolean)); return d.textContent; })()`);
  assert.match(text, /860/);
  assert.match(text, /Nothing is lost/);
});

/** What the schema reader said of a SQL Server schema read as MySQL, grouped by the engine: one entry per kind, with its count (RM67-C5). */
const catalogSaid = () => [
  { kind: 'CATALOG_CREATE_TABLE_UNREAD', severity: 'warn', key: 'catalog', count: 49,
    examples: ['s.sql: CREATE TABLE t00 at line 10', 's.sql: CREATE TABLE t01 at line 11', 's.sql: CREATE TABLE t02 at line 12', 's.sql: CREATE TABLE t03 at line 13', 's.sql: CREATE TABLE t04 at line 14'],
    reason: '49 CREATE TABLE statement(s) were read only as part of another statement, so their tables are not in the catalog (t00, t01, t02, and 46 more). The first, as the schema reader said it: s.sql: CREATE TABLE t00 at line 10', remedy: null },
  { kind: 'CATALOG_RULE_ASSUMED', severity: 'warn', key: 'sqlDialects', count: 1, examples: ['s.sql: MODIFY a.c by MySQL\'s rule'],
    reason: '1 conclusion(s) rest on a rule of a database this run assumed, because sqlDialects.main is not declared (a). The first, as the schema reader said it: s.sql: MODIFY a.c by MySQL\'s rule',
    remedy: { action: 'declare', key: 'sqlDialects', example: '{ "main": "postgres" }' } },
];

test('a diagnostic the engine grouped keeps its count and its first sentences, titled in both languages', async (t) => {
  const { ctx, body } = await bootBig(t);
  ev(ctx, `activateTab('status'); OV.resp.answer.diagnostics = ${JSON.stringify(catalogSaid())}; renderOverview();`);
  await settle(ctx, 4);
  const row = body.querySelector('#stdiags').querySelectorAll('.stitem').find((r) => r.id === 'st-ov-diag-CATALOG_CREATE_TABLE_UNREAD');
  assert.ok(row);
  assert.equal(row.querySelector('.stitemhead .ovnum').textContent, '49', 'the count it stands for, not the one entry that carries it');
  assert.equal(row.querySelector('.stitemhead b').textContent, 'CREATE TABLE read only as part of another statement');
  const g = JSON.parse(ev(ctx, `JSON.stringify(diagGroups(${JSON.stringify(catalogSaid())}).map((x)=>[x.kind, x.count, x.causes.map((c)=>c.count)]))`));
  assert.deepEqual(g, [['CATALOG_CREATE_TABLE_UNREAD', 49, [49]], ['CATALOG_RULE_ASSUMED', 1, [1]]]);
  const text = ev(ctx, `(()=>{ const g=diagGroups(${JSON.stringify(catalogSaid())})[0]; const d=document.createElement('div'); d.append(...diagGroupBody('t', g).filter(Boolean)); return d.textContent; })()`);
  assert.match(text, /49/);
  assert.match(text, /the first 5, in full/);
  for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`CREATE TABLE t0${i} at line 1${i}`), 'every first sentence the engine kept');
  assert.match(text, /and 44 more like these/);
  // The remedy the engine gave, beside the one kind that has one.
  const assumed = body.querySelector('#stdiags').querySelectorAll('.stitem').find((r) => r.id === 'st-ov-diag-CATALOG_RULE_ASSUMED');
  assert.match(assumed.textContent, /sqlDialects/);
  assert.match(assumed.textContent, /"main": "postgres"/);
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  const ko = body.querySelector('#stdiags').querySelectorAll('.stitem').find((r) => r.id === 'st-ov-diag-CATALOG_CREATE_TABLE_UNREAD');
  assert.equal(ko.querySelector('.stitemhead b').textContent, '다른 문에 섞여 읽힌 CREATE TABLE');
});

test('the list beside the picture can be made wider, is remembered, and cuts a name in the middle', async (t) => {
  const { ctx, byId, store } = await bootBig(t);
  assert.ok(byId.get('tracerail').querySelector('.railgrab'), 'the list has a grip');
  assert.equal(ev(ctx, 'railWidthSet(9999)'), 640);
  assert.equal(ev(ctx, 'railWidthSet(10)'), 260);
  assert.equal(ev(ctx, "document.documentElement.style.getPropertyValue('--railw')"), '260px');
  const grab = byId.get('tracerail').querySelector('.railgrab');
  for (const fn of grab._listeners.get('dblclick')) fn({});
  assert.equal(store['cascade.viewer.railw'] ?? ev(ctx, "localStorage.getItem('cascade.viewer.railw')"), '320');
  const split = ev(ctx, "nameSplit('pms_product_attribute_value').map((s)=>s.textContent).join('|')");
  assert.equal(split, 'pms_product_attribute_|value', 'the tail that tells two tables apart is the part that stays');
});

test('the Trace place opens on the engine\'s one default depth, and so does a saved file', async (t) => {
  const { DEFAULT_WALK_DEPTH } = await import('../src/core/graph.mjs');
  const { SNAPSHOT_TABS } = await import('../src/viewer/snapshot.mjs');
  const { ctx, byId } = await bootBig(t);
  assert.equal(ev(ctx, 'WALK_DEPTH_DEFAULT'), DEFAULT_WALK_DEPTH, 'the page mirrors the engine');
  for (const kind of ['endpoint', 'screen', 'symbol', 'statement', 'table', 'column']) {
    assert.equal(ev(ctx, `traceAutoDepth('${kind}')`), DEFAULT_WALK_DEPTH, `a ${kind} opens on the default`);
  }
  for (const id of ['tdepth', 'cpdepth', 'gdepth']) {
    const opened = byId.get(id).querySelectorAll('option').find((o) => o.attrs.has('selected'));
    assert.equal(opened.attrs.get('value') === '' ? null : Number(opened.textContent), DEFAULT_WALK_DEPTH, `${id} opens on the default, no cap`);
  }
  for (const tab of Object.values(SNAPSHOT_TABS)) assert.deepEqual([tab.depth, tab.screenDepth], [DEFAULT_WALK_DEPTH, DEFAULT_WALK_DEPTH]);
});
