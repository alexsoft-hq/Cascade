// viewer_trace.test.mjs — the Trace place: one target, asked about either way (RM67-U2b).
//
// Explore, Flow and Impact were three tabs over one question. Trace asks it in
// one place, and this file holds the five rules that make that honest, each
// against the page itself over the real fixture server:
//   1. a target offers only the directions it has, mirroring the tool's table,
//      and one it does not have is absent with the reason said;
//   2. the START of the question is not the row clicked in the picture: a click
//      shows a card, "Trace from here" moves the start, and switching
//      direction keeps it;
//   3. depth, mode and rows per lane are three settings, and a depth the
//      reader chose survives a direction switch and a new target;
//   4. a remembered answer is keyed by the whole question;
//   5. the URL carries the whole question, and every link written before Trace
//      (tab = overview, explore, flow, impact and the rest) lands where it said,
//      through a reload, Back and Forward.
// Plus the details (read and write on every row, a route's transactions), the
// limits beside the answer, and the masthead's api-group count on every load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { FLOW_DIRECTIONS } from '../src/mcp/tools.mjs';

/** The page over the real fixture server, recording every tool call it makes. */
async function boot(t, { hash = '#p=gamma&tab=trace', projects = ['gamma', 'delta'], storage = {}, renderer = false } = {}) {
  const { html, base } = await startViewer(t, projects);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && body.name) asked.push({ name: body.name, args: body.arguments || {}, project: body.project });
    return fetch(base + url, opts);
  };
  const page = await bootPage({ html, hash, storage, origin: base, answer, renderer });
  await settle(page.ctx, 20);
  return { ...page, asked, base };
}
const flows = (asked) => asked.filter((a) => a.name === 'flow' && (a.args.endpoint || a.args.table || a.args.column || a.args.statement || a.args.symbol || a.args.screen));
const q = (ctx) => JSON.parse(ev(ctx, 'JSON.stringify({ target:TRACE.target, dir:TRACE.dir, depthSet:TRACE.depthSet, mode:byId("tmode").value, depth:byId("tdepth").value, sel:TRACEV.sel })'));
const hashOf = (ctx) => Object.fromEntries(new URLSearchParams(ev(ctx, 'location.hash').replace(/^#/, '')));
const dirButtons = (byId) => byId.get('tdir').querySelectorAll('button').map((b) => b.textContent);
const press = (byId, text) => byId.get('tdir').querySelectorAll('button').find((b) => b.textContent === text).onclick();

// ---------------------------------------------------------------------------
// 1. which directions a target has
// ---------------------------------------------------------------------------

test('the page\'s direction table is the tool\'s, and details is every kind\'s', async (t) => {
  const { ctx } = await boot(t);
  const dirs = JSON.parse(ev(ctx, 'JSON.stringify(TRACE_DIRS)'));
  for (const dir of ['down', 'up']) {
    assert.deepEqual(Object.keys(dirs).filter((k) => dirs[k].includes(dir)).sort(), [...FLOW_DIRECTIONS[dir]].sort(),
      `the ${dir} walks the page offers are exactly the ones the tool answers`);
  }
  for (const k of Object.keys(dirs)) assert.ok(dirs[k].includes('detail'), `${k} has details`);
});

test('a table offers where it is used and details, and says in words why it has no "uses"', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'table', id:'gamma_order'}, 'down')");
  await settle(ctx, 12);
  assert.equal(q(ctx).dir, 'up', 'a direction the target does not have falls back to its own');
  assert.deepEqual(dirButtons(byId), ['Where it is used', 'Details'], 'no disabled "What it uses" button: it is absent');
  assert.match(byId.get('tracehead').textContent, /A table is where a chain ends, so it uses nothing/);
  // A screen has no "where it is used", and says why.
  ev(ctx, "openTrace({kind:'screen', id:'/rows'}, 'up')");
  await settle(ctx, 4);
  assert.deepEqual(dirButtons(byId), ['What it uses', 'Details']);
  assert.match(byId.get('tracehead').textContent, /A screen is the top of the chain, so nothing uses it/);
});

test('a route offers all three, and "where it is used" is the tool\'s own walk up from the route', async (t) => {
  const { ctx, byId, asked } = await boot(t, { hash: '#p=delta&tab=trace' });
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /rows'}, 'down')");
  await settle(ctx, 12);
  assert.deepEqual(dirButtons(byId), ['What it uses', 'Where it is used', 'Details']);
  press(byId, 'Where it is used');
  await settle(ctx, 12);
  const last = flows(asked).at(-1);
  assert.deepEqual([last.args.direction, last.args.endpoint], ['up', 'GET /rows']);
  const fields = byId.get('tracewrap').querySelectorAll('.fcol').map((c) => c.dataset.field);
  assert.ok(fields.includes('screens') && fields.includes('webFunctions'), `the route's callers are drawn: ${fields}`);
  assert.equal(fields.includes('statements'), false, 'what calls a route is never SQL');
  // No code in this pack calls the route over HTTP, so those two lanes are
  // empty, and an empty lane is drawn last: no line runs behind it.
  assert.deepEqual(fields, ['entry', 'webFunctions', 'screens', 'services', 'endpoints']);
});

// ---------------------------------------------------------------------------
// 2. the start is not the clicked row
// ---------------------------------------------------------------------------

test('a click shows a row; "Trace from here" moves the start; switching direction keeps it', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'endpoint', id:'POST /order/save'}, 'down')");
  await settle(ctx, 12);
  const svc = ev(ctx, "[...TRACEV.rows.keys()].find((k)=>k.startsWith('symbol:com.g.GServiceImpl#save'))");
  ev(ctx, `flowSelect(TRACEV, ${JSON.stringify(svc)})`);
  await settle(ctx, 4);
  assert.deepEqual(q(ctx).target, { kind: 'endpoint', id: 'POST /order/save' }, 'a click does not move the start');
  assert.equal(q(ctx).sel, svc);
  const card = byId.get('traceside').querySelector('.fcard');
  const from = card.querySelectorAll('button').find((b) => b.textContent === 'Trace from here');
  assert.ok(from, 'the card offers to start from this row');
  from.onclick();
  await settle(ctx, 12);
  assert.deepEqual(q(ctx).target, { kind: 'symbol', id: 'com.g.GServiceImpl#save' });
  assert.equal(q(ctx).dir, 'down', 'the new start is read the same way');
  press(byId, 'Where it is used');
  await settle(ctx, 12);
  assert.deepEqual(q(ctx).target, { kind: 'symbol', id: 'com.g.GServiceImpl#save' }, 'a direction switch keeps the start');
  assert.equal(q(ctx).dir, 'up');
  assert.equal(ev(ctx, 'TRACEV.resp.answer.entry.id'), 'com.g.GServiceImpl#save');
});

// ---------------------------------------------------------------------------
// 3. three settings with three names
// ---------------------------------------------------------------------------

test('a depth the reader chose survives a direction switch and a new target; the default follows the target', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "openTrace({kind:'endpoint', id:'POST /order/save'}, 'down')");
  await settle(ctx, 12);
  assert.equal(q(ctx).depthSet, false);
  byId.get('tdepth').value = '3';
  byId.get('tdepth').onchange();
  await settle(ctx, 12);
  assert.equal(flows(asked).at(-1).args.depth, 3);
  press(byId, 'Where it is used');
  await settle(ctx, 12);
  assert.equal(flows(asked).at(-1).args.depth, 3, 'a chosen depth survives the switch');
  ev(ctx, "openTrace({kind:'table', id:'gamma_item'}, 'up')");
  await settle(ctx, 12);
  assert.equal(flows(asked).at(-1).args.depth, 3, 'and a new target');
  // Show all forgets the target, not the reader's depth; with no depth chosen,
  // a new target gets the automatic default.
  ev(ctx, "TRACE.depthSet=false; byId('tdepth').value='5'; openTrace({kind:'table', id:'gamma_order'}, 'up')");
  await settle(ctx, 12);
  assert.equal(flows(asked).at(-1).args.depth, ev(ctx, 'WALK_DEPTH_DEFAULT'), 'the automatic default replaces an unchosen depth');
});

test('the three settings have three names on the page', async (t) => {
  const { byId } = await boot(t);
  assert.match(byId.get('tdepth').title, /the most links a walk follows/);
  assert.match(byId.get('tmode').title, /which links the walk follows/);
  assert.match(byId.get('tdir').title, /which way to read the target/);
});

// ---------------------------------------------------------------------------
// 4. the cache key is the whole question
// ---------------------------------------------------------------------------

test('an answer is remembered under project, target, direction, mode, depth and rows per lane', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "openTrace({kind:'table', id:'gamma_order'}, 'up')");
  await settle(ctx, 12);
  const n = flows(asked).length;
  assert.equal(ev(ctx, 'traceKey(traceNow())'), 'gamma|table:gamma_order|up|conservative||40');
  byId.get('tmode').value = 'strict';
  byId.get('tmode').onchange();
  await settle(ctx, 12);
  assert.equal(flows(asked).length, n + 1, 'another mode is another question: asked, not handed back');
  assert.equal(flows(asked).at(-1).args.mode, 'strict');
  byId.get('tmode').value = 'conservative';
  byId.get('tmode').onchange();
  await settle(ctx, 12);
  assert.equal(flows(asked).length, n + 1, 'the conservative answer is drawn from memory, under its own key');
  assert.equal(ev(ctx, 'TRACEV.resp.answer.walk.mode'), 'conservative');
});

// ---------------------------------------------------------------------------
// 5. the URL
// ---------------------------------------------------------------------------

test('a new link carries direction, mode and depth, and a reload asks the same question', async (t) => {
  const { ctx } = await boot(t);
  ev(ctx, "openTrace({kind:'table', id:'gamma_order'}, 'up')");
  await settle(ctx, 12);
  ev(ctx, "byId('tdepth').value='5'; byId('tdepth').onchange()");
  await settle(ctx, 12);
  const h = hashOf(ctx);
  assert.deepEqual([h.tab, h.pick, h.dir, h.mode, h.depth], ['trace', 'table:gamma_order', 'up', 'conservative', '5']);
  const again = await boot(t, { hash: ev(ctx, 'location.hash') });
  assert.deepEqual(q(again.ctx).target, { kind: 'table', id: 'gamma_order' });
  const f = flows(again.asked).at(-1);
  assert.deepEqual([f.args.direction, f.args.table, f.args.mode, f.args.depth], ['up', 'gamma_order', 'conservative', 5]);
});

/** Every tab a link written before Trace could name, with the project, a pick and a source pane. */
const OLD_LINKS = [
  ['overview', null, { tab: 'overview' }],
  ['explore', 'table:gamma_order', { tab: 'trace', dir: 'detail', pick: 'table:gamma_order' }],
  ['explore', 'column:gamma_order.total', { tab: 'trace', dir: 'detail', pick: 'column:gamma_order.total' }],
  ['explore', 'statement:com.g.GMapper.selectOrder', { tab: 'trace', dir: 'detail', pick: 'statement:com.g.GMapper.selectOrder' }],
  ['flow', 'endpoint:POST /order/save', { tab: 'trace', dir: 'down', pick: 'endpoint:POST /order/save' }],
  ['flow', 'symbol:com.g.GServiceImpl#save', { tab: 'trace', dir: 'down', pick: 'symbol:com.g.GServiceImpl#save' }],
  ['impact', 'table:gamma_order', { tab: 'trace', dir: 'up', pick: 'table:gamma_order' }],
  ['impact', 'column:gamma_order.total', { tab: 'trace', dir: 'up', pick: 'column:gamma_order.total' }],
  ['coupling', null, { tab: 'coupling' }],
  ['graph', null, { tab: 'graph' }],
  // The ERD selects its table once its picture is drawn, which this stub cannot
  // do; what it can check is that the table the link names is the one asked for.
  ['erd', 'table:gamma_order', { tab: 'erd', erdTable: 'gamma_order' }],
  ['tx', null, { tab: 'tx' }],
  ['rules', null, { tab: 'rules' }],
  ['compare', null, { tab: 'compare' }],
];

test('every link written before Trace lands on the same project, target and source pane', async (t) => {
  for (const [tab, pick, want] of OLD_LINKS) {
    const src = 'statement:com.g.GMapper.selectOrder';
    const hash = `#p=gamma&tab=${tab}${pick ? `&pick=${encodeURIComponent(pick)}` : ''}&src=${encodeURIComponent(src)}`;
    // The map renderers are stood in for, so the Graph and ERD tabs draw and pick.
    const { ctx } = await boot(t, { hash, projects: ['alpha', 'gamma'], renderer: true });
    await settle(ctx, 10);
    const h = hashOf(ctx);
    assert.equal(h.p, 'gamma', `${hash}: the project`);
    assert.equal(ev(ctx, 'STATE.tab'), want.tab, `${hash}: the tab`);
    if (want.pick) assert.equal(h.pick, want.pick, `${hash}: the pick`);
    if (want.erdTable) assert.equal(ev(ctx, "byId('etable').value"), want.erdTable, `${hash}: the ERD table`);
    if (want.dir) {
      assert.equal(q(ctx).dir, want.dir, `${hash}: read the way that tab read it`);
      assert.equal(h.dir, want.dir);
      const [kind, ...rest] = want.pick.split(':');
      assert.deepEqual(q(ctx).target, { kind, id: rest.join(':') });
    }
    assert.equal(ev(ctx, 'SRC.open && SRC.node'), src, `${hash}: the source pane`);
    assert.equal(h.src, src);
  }
});

test('Back and Forward walk the questions asked, one at a time, and redraw from memory', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  const hashes = [];
  ev(ctx, "openTrace({kind:'table', id:'gamma_order'}, 'up')");
  await settle(ctx, 12); hashes.push(ev(ctx, 'location.hash'));
  press(byId, 'Details');
  await settle(ctx, 12); hashes.push(ev(ctx, 'location.hash'));
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /order/{id}'}, 'down')");
  await settle(ctx, 12); hashes.push(ev(ctx, 'location.hash'));
  assert.equal(new Set(hashes).size, 3, 'each question is its own URL');
  const n = asked.length;
  // Back: the page applies the previous URL.
  for (const h of [hashes[1], hashes[0]]) {
    ev(ctx, `location.hash=${JSON.stringify(h)}; applyHash()`);
    await settle(ctx, 8);
  }
  assert.deepEqual([q(ctx).target, q(ctx).dir], [{ kind: 'table', id: 'gamma_order' }, 'up']);
  // Forward.
  ev(ctx, `location.hash=${JSON.stringify(hashes[1])}; applyHash()`);
  await settle(ctx, 8);
  assert.equal(q(ctx).dir, 'detail');
  assert.ok(view(byId).includes('SQL that touches it'));
  assert.equal(asked.length, n, 'every answer was in memory: nothing asked again');
});
const view = (byId) => byId.get('view').textContent;

// ---------------------------------------------------------------------------
// details, limits and the masthead
// ---------------------------------------------------------------------------

test('a column\'s details say read or write on every row, and the routes use the grade mode on screen', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "byId('tmode').value='strict'; openTrace({kind:'column', id:'gamma_order.total'}, 'detail')");
  await settle(ctx, 12);
  const ci = asked.filter((a) => a.name === 'column_impact').at(-1);
  assert.equal(ci.args.mode, 'both', 'column_impact is asked for both ACCESSES, which is not a grade mode');
  assert.equal(asked.filter((a) => a.name === 'endpoint_impact').at(-1).args.mode, 'strict', 'the routes follow the grade mode on screen');
  const sql = byId.get('view').querySelectorAll('.panel').find((p) => /^SQL that reads or writes it/.test(p.textContent));
  const rows = sql.querySelectorAll('li');
  assert.deepEqual(rows.map((r) => r.querySelector('.tag').textContent).sort(), ['read', 'write']);
  assert.match(byId.get('view').textContent, /SQL that reads or writes it, every grade \(1 read, 1 write\)/);
  assert.match(byId.get('view').textContent, /APIs above that SQL, mode strict/);
});

test('under a column\'s card, the screens a change there is felt on, followed all the way up', async (t) => {
  const { ctx, byId, asked } = await boot(t, { hash: '#p=delta&tab=trace' });
  ev(ctx, "openTrace({kind:'column', id:'delta_rows.status'}, 'detail')");
  await settle(ctx, 12);
  const si = asked.filter((a) => a.name === 'screen_impact').at(-1);
  assert.deepEqual([si.args.column, si.args.mode], ['delta_rows.status', 'conservative'], 'the screens are the tool\'s, in the mode on screen');
  const side = byId.get('view').textContent;
  assert.match(side, /Screens a change here is felt on, mode conservative, with no depth cap/);
  assert.match(side, /\/rows/);
  const into = byId.get('view').querySelectorAll('button').find((b) => b.textContent === 'What it uses');
  into.onclick();
  await settle(ctx, 12);
  assert.deepEqual([q(ctx).target, q(ctx).dir], [{ kind: 'screen', id: '/rows' }, 'down'], 'each screen is a way into Trace, walked down');
});

test('a route\'s details name its handler and the transactions its walk runs through', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'endpoint', id:'POST /order/save'}, 'detail')");
  await settle(ctx, 12);
  const text = byId.get('view').textContent;
  assert.match(text, /API route/);
  assert.match(text, /handler GController\.save/);
  assert.match(text, /Transactions it runs through/);
});

test('beside a walk, the limits that changed THIS answer, with the depth that would follow them', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "byId('tdepth').value='1'; TRACE.depthSet=true; openTrace({kind:'endpoint', id:'POST /order/save'}, 'down')");
  await settle(ctx, 12);
  const panel = byId.get('traceside').querySelector('.tlimits');
  assert.ok(panel, 'the limits panel stands beside the answer');
  assert.match(panel.textContent, /stopped at depth 1/);
  const deeper = panel.querySelectorAll('button').find((b) => b.textContent === 'Follow it all the way');
  deeper.onclick();
  await settle(ctx, 12);
  assert.equal(byId.get('tdepth').value, '', 'back to the one rule every walk has: no cap');
  assert.match(byId.get('traceside').querySelector('.tlimits').textContent, /No cap cut this answer/);
});

test('the masthead counts api groups from the overview, before any map is drawn', async (t) => {
  const { ctx, byId } = await boot(t);
  assert.equal(ev(ctx, 'GMAP.resp'), null, 'no map was asked for on this page');
  const lane = byId.get('crail').querySelectorAll('.crlane').find((x) => /api groups/.test(x.textContent));
  assert.equal(lane.querySelector('b').textContent, String(ev(ctx, 'OV.resp.answer.reach.groups')));
  assert.notEqual(lane.querySelector('b').textContent, '—');
});

test('a CamelCase name in the list gives way at a word, and keeps the last two', async (t) => {
  const { ctx } = await boot(t);
  assert.equal(ev(ctx, "nameSplit('PmsProductAttributeValueDao').map((s)=>s.textContent).join('|')"), 'PmsProductAttribute|ValueDao');
  assert.equal(ev(ctx, "nameSplit('UserService').map((s)=>s.textContent).join('|')"), 'UserService');
});
