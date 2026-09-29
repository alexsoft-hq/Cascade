// viewer_review4.test.mjs — what the fourth UI review asked of the five places (RM67-U2e).
//
// The review walked the three questions and found two walls: the answer sat
// past the right edge of the picture, and a Korean page said its key sentences
// in English. Held here, each against the page over the real fixture server:
//   1. Trace says its answer in one sentence, with the mode and depth it was
//      counted in, and lists the ends a reader came for over the picture;
//   2. no two numbers for one thing without saying why: a count says the mode
//      it was counted in, and nothing offers to go deeper where it says it cannot;
//   3. where the mode stops every walk at the start, the page says so first, once;
//   4. a gap's cause is said in the page's words, the engine's sentence folded;
//   5. the "what this answer rests on" box is said in the page's words, once a place;
//   6. Start puts the map above the cards, and a line says what it carries;
//   7. directions say which way they go, and a list row spells its numbers out;
//   8. the masthead is one line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { Graph } from '../src/core/graph.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { chainLabels, ormCallsOf, CHAIN_FIT } from '../src/viewer/chainlayout.mjs';
import { chainModel } from '../src/viewer/chain_svg.mjs';

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

/** The page over the real fixture server; `rewrite` may change one tool's answer on its way to the page. */
async function boot(t, { hash = '#p=gamma&tab=trace', projects = ['gamma', 'delta'], rewrite = {}, storage = {} } = {}) {
  const { html, base } = await startViewer(t, projects);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && body.name) asked.push({ name: body.name, args: body.arguments || {} });
    const res = await fetch(base + url, opts);
    if (!body || !rewrite[body.name]) return res;
    return json(rewrite[body.name](await res.json(), body.arguments || {}));
  };
  const page = await bootPage({ html, hash, storage, origin: base, answer });
  await settle(page.ctx, 20);
  return { ...page, asked };
}
const head = (byId) => byId.get('tracehead');
/** A row of Analysis status by its id, found inside the place (ids made at run time are not in the page's index). */
const stRow = (byId, id) => byId.get('tab-status').querySelectorAll('.stitem').find((x) => x.id === id);
const say = (byId) => { const s = head(byId).querySelector('.tanswersay'); return s ? s.textContent : null; };

// ---------------------------------------------------------------------------
// 1. the answer in one sentence, and the ends over the picture
// ---------------------------------------------------------------------------

test('Trace says its answer in one sentence, counted in the mode and depth the walk used', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'column', id:'gamma_order.total'}, 'up')");
  await settle(ctx, 12);
  const apis = ev(ctx, "TRACEV.resp.truncated.fields.find((f)=>f.field==='endpoints').total");
  assert.ok(apis > 0, 'the fixture has routes above the column');
  assert.equal(say(byId), `Change this and it reaches ${apis} API${apis === 1 ? '' : 's'}.`);
  assert.equal(head(byId).querySelector('.tanswermode').textContent, 'counted in conservative, depth not capped');
  // The ends are listed over the picture, each a way to its row in it.
  const box = head(byId).querySelector('.tends');
  assert.ok(box, 'the ends a reader came for are over the picture');
  const rows = box.querySelectorAll('button.tendrow');
  assert.equal(rows.length, Math.min(5, apis));
  rows[0].onclick();
  await settle(ctx, 4);
  assert.ok(ev(ctx, 'TRACEV.sel').startsWith('endpoint:'), 'a name in the ends picks that route in the picture');
  // Korean, from the answer in memory.
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.equal(say(byId), `이걸 바꾸면 API ${apis}개에 닿습니다.`);
  assert.equal(head(byId).querySelector('.tanswermode').textContent, 'conservative 모드, 깊이 제한 없음 기준');
});

test('walked down, the sentence counts the SQL and the tables; from a screen, the APIs and the tables', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'endpoint', id:'POST /order/save'}, 'down')");
  await settle(ctx, 12);
  assert.match(say(byId), /^From here it reaches \d+ SQL statements? and \d+ tables?\.$/);
  const d = await boot(t, { hash: '#p=delta&tab=trace' });
  ev(d.ctx, "openTrace({kind:'screen', id:'/rows'}, 'down')");
  await settle(d.ctx, 12);
  assert.match(say(d.byId), /^From here it reaches \d+ APIs? and \d+ tables?\.$/);
});

/** delta walked up in conservative, with its frontend calls graded below the floor, as mall's are once the port is a guess. */
const screensBelowFloor = (r) => {
  const a = r.answer;
  if (a.walk.direction !== 'up' || !Array.isArray(a.screens)) return r;
  a.screens = []; a.webFunctions = [];
  for (const f of r.truncated.fields) if (f.field === 'screens' || f.field === 'webFunctions') Object.assign(f, { shown: 0, total: 0, nextOffset: null });
  a.walk.cut = { ...a.walk.cut, byMode: 4, byModeGrades: { HEURISTIC: 4 } };
  return r;
};

test('an end that reads 0 in this mode says it is this mode\'s count, with the wider mode', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=delta&tab=trace', rewrite: { flow: screensBelowFloor } });
  ev(ctx, "openTrace({kind:'table', id:'delta_rows'}, 'up')");
  await settle(ctx, 12);
  assert.match(say(byId), /^Change this and it reaches \d+ APIs? and 0 screens\.$/);
  const zero = head(byId).querySelectorAll('.tanswercut').find((x) => /0 screens are counted/.test(x.textContent));
  assert.ok(zero, head(byId).textContent);
  assert.match(zero.textContent, /^The 0 screens are counted in conservative, which did not follow 4 links: there may be some past them\./);
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.match(head(byId).textContent, /화면 0개는 conservative 모드 기준입니다\. 이 모드가 따라가지 않은 연결 4개 너머에 더 있을 수 있습니다\./);
  head(byId).querySelectorAll('button.tmodebtn').at(-1).onclick();
  await settle(ctx, 12);
  assert.equal(ev(ctx, "byId('tmode').value"), 'heuristic');
});

test('a depth that cut the walk makes the counts a floor, said beside them with the way to follow it all', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "byId('tdepth').value='1'; TRACE.depthSet=true; openTrace({kind:'column', id:'gamma_order.total'}, 'up')");
  await settle(ctx, 12);
  assert.ok(ev(ctx, 'TRACEV.resp.answer.walk.cut.depth') > 0, 'depth 1 cuts this walk');
  assert.equal(head(byId).querySelector('.tanswercut').textContent, 'The walk stopped at depth 1, so there may be more.');
  const deeper = head(byId).querySelectorAll('button').find((b) => b.textContent === 'Follow it all the way');
  assert.ok(deeper, 'the sentence that says there may be more carries the way to see them');
  deeper.onclick();
  await settle(ctx, 12);
  assert.equal(ev(ctx, 'TRACEV.resp.answer.walk.depth'), null);
  assert.equal(head(byId).querySelector('.tanswercut'), null);
});

// ---------------------------------------------------------------------------
// 3. the mode that stops every walk, said once
// ---------------------------------------------------------------------------

/** gamma's routes, with their own address graded below conservative's floor, as ghostfolio's are. */
const guessedRoute = (r) => {
  const a = r.answer;
  if (a.entry && a.entry.kind === 'endpoint') {
    a.entry.grade = 'HEURISTIC';
    for (const f of ['services', 'statements', 'tables']) if (Array.isArray(a[f])) a[f] = [];
    for (const f of (r.truncated && r.truncated.fields) || []) { f.shown = 0; f.total = 0; f.nextOffset = null; }
    a.walk.cut = { ...a.walk.cut, byMode: 3, byModeGrades: { HEURISTIC: 3 } };
  }
  return r;
};

test('where the mode stops the walk at the route, the answer says so once, with the wider mode as a button', async (t) => {
  const { ctx, byId } = await boot(t, { rewrite: { flow: guessedRoute } });
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /order/{id}'}, 'down')");
  await settle(ctx, 12);
  assert.equal(say(byId), "In conservative this reaches nothing: this route's own address is graded HEURISTIC, and conservative stops at it.");
  assert.equal(head(byId).querySelector('.tends'), null, 'no ends list when nothing was reached');
  // The empty lanes do not each say it again.
  const lanes = byId.get('tracewrap').querySelectorAll('.fcol.fempty');
  assert.ok(lanes.length >= 2);
  for (const l of lanes) assert.equal(/Nothing here at mode/.test(l.textContent), false, 'the lane does not repeat the sentence');
  head(byId).querySelector('button.tmodebtn').onclick();
  await settle(ctx, 12);
  assert.equal(ev(ctx, "byId('tmode').value"), 'heuristic');
});

// ---------------------------------------------------------------------------
// 2. no two numbers for one thing without saying why
// ---------------------------------------------------------------------------

test('the list says the mode its numbers were walked in, beside its count and apart from it', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  await settle(ctx, 6);
  assert.ok(asked.some((a) => a.name === 'browse'));
  assert.equal(byId.get('tcount').textContent, '3 shown of 3', 'the count line is what it was');
  assert.equal(byId.get('tcountmode').textContent, 'counted in conservative');
  assert.equal(ev(ctx, 'RAIL.trace.resp.answer.census.mode'), 'conservative', 'the mode is the answer\'s, not the page\'s');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.equal(byId.get('tcountmode').textContent, 'conservative 모드 기준');
});

test('a walk cut by depth offers to go deeper and never says it cannot, and every count sits in its sentence', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "byId('tdepth').value='1'; TRACE.depthSet=true; openTrace({kind:'column', id:'gamma_order.total'}, 'up')");
  await settle(ctx, 12);
  const panel = byId.get('traceside').querySelector('.tlimits');
  assert.equal(/deepest/.test(panel.textContent), false, 'no "this is the deepest a walk goes" beside "Follow it all the way"');
  assert.match(panel.textContent, /It stopped at depth 1\. Details lists every screen a change here is felt on, with no depth cap\./);
  const first = panel.querySelectorAll('.tlim')[0];
  assert.match(first.textContent, /^\d+ rows stopped at depth 1/);
  assert.equal(first.querySelector('b').textContent, String(ev(ctx, 'TRACEV.resp.answer.walk.cut.depth')), 'the count is bold inside the sentence');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  const ko = byId.get('traceside').querySelector('.tlimits').querySelectorAll('.tlim')[0].textContent;
  assert.match(ko, /^\d+개 행이 깊이 1에서 멈췄습니다/, 'the number and its counter word are one word');
});

test('the legend counts the lines and the row badges apart, so a picture of badges does not contradict it', async (t) => {
  const { ctx, byId } = await boot(t);
  ev(ctx, "openTrace({kind:'column', id:'gamma_order.total'}, 'up')");
  await settle(ctx, 12);
  const legend = byId.get('traceside').querySelectorAll('.panel').find((p) => /how to read the lines/.test(p.textContent));
  const counts = legend.querySelectorAll('.count').map((c) => c.textContent).filter((c) => /^lines/.test(c));
  assert.equal(counts.length, 3);
  for (const c of counts) assert.match(c, /^lines \d+, row badges \d+$/);
  const rows = ev(ctx, 'TRACEV.model.lanes.slice(1).reduce((n,l)=>n+l.rows.length,0)');
  const badges = counts.map((c) => Number(/row badges (\d+)/.exec(c)[1])).reduce((n, x) => n + x, 0);
  assert.ok(badges <= rows && badges > 0, 'the badges counted are the rows drawn');
});

/**
 * gamma's overview as ghostfolio's reads in conservative: every route's own
 * address graded HEURISTIC, so nothing reaches SQL; in any other mode, as it is.
 */
const floored = (r, args) => {
  if (args.mode && args.mode !== 'conservative') return r;
  const rc = r.answer.reach;
  Object.assign(rc, { routeGrades: { HEURISTIC: rc.endpoints }, endpointsWithoutStatement: rc.endpoints,
    statementsReached: 0, tablesReached: 0, columnsReached: 0 });
  r.answer.routeRemedy = { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: '["health"]' };
  r.answer.hubs = { tables: [], endpoints: [] };
  return r;
};

test('where every route stops at itself, Start says so first, once, with the fix and the wider mode', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=start', rewrite: { overview: floored } });
  const lead = byId.get('slead');
  assert.equal(lead.classList.contains('hidden'), false);
  const n = ev(ctx, 'OV.resp.answer.reach.endpoints');
  assert.equal(lead.querySelector('.startleadsay').textContent,
    `${n} of ${n} routes graded HEURISTIC: mode conservative stops at them. Nothing on this page reaches SQL in this mode until their address is sure.`);
  assert.match(lead.querySelector('.remedy').textContent, /tsBackend\.globalPrefixExclude/);
  assert.equal(byId.get('sgaps').querySelectorAll('.sgapguess').length, 0, 'the gaps panel does not say it a second time');
  const start = byId.get('tab-start').children.filter((c) => !c.classList.contains('hint'));
  assert.equal(start[0].id, 'slead', 'the cause comes before the search box and the 0% cards');
});

test('one mode for what Start counts: the map\'s control moves the map, the shares and the table and API rankings, and each says it', async (t) => {
  const { ctx, byId, asked } = await boot(t, { hash: '#p=gamma&tab=start', rewrite: { overview: floored } });
  const mode = () => byId.get('skpimode').textContent;
  assert.equal(mode(), 'The shares and the table and API rankings below are counted in conservative, depth not capped.');
  assert.equal(byId.get('ovcards').querySelectorAll('.kpinum')[0].textContent, '0%');
  byId.get('slead').querySelectorAll('button').at(-1).onclick();
  await settle(ctx, 12);
  assert.ok(asked.some((a) => a.name === 'overview' && a.args.mode === 'heuristic'), 'the overview is asked in that mode');
  assert.equal(ev(ctx, 'SUM.mode'), 'heuristic', 'the map moved with it');
  assert.equal(mode(), 'The shares and the table and API rankings below are counted in heuristic, depth not capped.');
  assert.notEqual(byId.get('ovcards').querySelectorAll('.kpinum')[0].textContent, '0%');
  for (const h of byId.get('shubs').querySelectorAll('.hubmode').slice(0, 2)) assert.equal(h.textContent, 'counted in heuristic');
  assert.match(byId.get('slead').textContent, /counted in heuristic now\. The screens ranking has one mode only, written under its title\. The gaps and Analysis status stay in conservative\./);
  byId.get('slead').querySelector('button').onclick();
  await settle(ctx, 12);
  assert.equal(ev(ctx, 'START.mode'), null);
  assert.equal(ev(ctx, 'SUM.mode'), 'conservative');
  assert.equal(mode(), 'The shares and the table and API rankings below are counted in conservative, depth not capped.');
});

test('the map comes before the shares on Start, and a line says what it carries', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=start' });
  const ids = byId.get('tab-start').children.map((c) => c.id).filter(Boolean);
  assert.ok(ids.indexOf('ovsummary') < ids.indexOf('ovcards'), ids.join(' '));
  const svg = () => byId.get('ovsummary').querySelectorAll('svg').find((s) => s.getAttribute('class') === 'sumlinks');
  const labels = () => svg().querySelectorAll('text').map((x) => x.textContent);
  const links = JSON.parse(ev(ctx, 'JSON.stringify(SUM.resp.answer.links)'));
  assert.ok(links.length > 0 && links.length <= 12, 'a small map');
  assert.deepEqual(labels().sort(), links.map((l) => `${l.endpoints} → ${l.tables} ${l.tables === 1 ? 'table' : 'tables'}`).sort(), 'every line of a small map carries its counts');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  ev(ctx, 'summaryRedraw()');
  assert.deepEqual(labels().sort(), links.map((l) => `API ${l.endpoints} → 테이블 ${l.tables}`).sort());
  // Laid out, a count never covers another: lines that meet at their middles
  // put their counts further along, and one with no free point keeps its count
  // on its title only.
  const spots = JSON.parse(ev(ctx, `(()=>{ const fit=summaryLabelFit({width:600}, []);
    const line=(u)=> [100+1000*u, 100];
    return JSON.stringify([0,1,2,3,4,5].map(()=> fit('1 → 2 tables', line))); })()`));
  assert.deepEqual(spots.slice(0, 5).map((p) => p[0]), [600, 480, 720, 360, 840], 'each on its own curve, at the next free point (RM67-U2f: finer points, a ground as wide as the words)');
  assert.equal(spots[5], null, 'no free point: no label');
});

// ---------------------------------------------------------------------------
// 4. a gap's cause in the page's words, the engine's sentence folded
// ---------------------------------------------------------------------------

/** gamma's overview with a ghostfolio diagnostic, jeecg's outbound calls, and links below the floor. */
const withGaps = (r) => {
  const a = r.answer;
  a.diagnostics = [...(a.diagnostics || []), { kind: 'TS_PREFIX_EXCLUDE_UNREAD', severity: 'warn', key: null,
    reason: 'the profile\'s tsBackend.globalPrefixExclude entry "docs{/*rest}" uses route pattern syntax this engine does not read',
    remedy: { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: '["health"]' } }];
  a.gaps = a.gaps.filter((g) => g.kind !== 'mode-floor' && g.kind !== 'http-calls-leaving-pack');
  a.gaps.push({ kind: 'http-calls-leaving-pack', count: 188, class: 'input', remedy: null,
    note: '188 HTTP call target(s) leave this pack. 213 of those target(s) are named by the FRONTEND, which is as often a prefix nobody declared as a real external service' });
  a.gaps.push({ kind: 'mode-floor', count: 12, class: 'query', remedy: null, note: 'walked at mode=conservative, no depth cap: 12 flow edge(s) sit below this mode\'s grade floor, so we did not follow them' });
  return r;
};

test('a gap says its cause in the reader\'s language, with the engine\'s sentence folded under it', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=status', rewrite: { overview: withGaps } });
  assert.equal(stRow(byId, 'st-ov-gap-http-calls-leaving-pack').querySelector('.stitemhead b').textContent, 'API calls no route here answers',
    'in English too, the title leaves room for a prefix nobody declared');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  const row = stRow(byId, 'st-ov-gap-http-calls-leaving-pack');
  assert.equal(row.querySelector('.stitemhead b').textContent, '이 프로젝트에서 받는 곳을 못 찾은 API 호출',
    'the title no longer settles that every one of them is another service');
  const cause = row.querySelectorAll('.stline')[0];
  assert.match(cause.textContent, /^원인호출 대상 188개를 받는 곳이 이 프로젝트에 없습니다\. 다른 서비스이거나, 선언하지 않은 주소 앞부분\(접두사\) 때문에/);
  assert.equal(/HTTP call target/.test(cause.querySelector('.foldlead').textContent), false, 'the engine\'s sentence is folded, not the lead');
  cause.querySelector('.foldlead').onclick();
  assert.match(cause.textContent, /188 HTTP call target\(s\) leave this pack/, 'one click opens the engine\'s own sentence, word for word');
  // A result row is a way to its cause.
  const unreached = stRow(byId, 'st-ov-gap-tables-not-reached');
  const link = unreached.querySelector('button.stcauselink');
  assert.equal(link.textContent, '원인: conservative 모드가 따라가지 않는 연결 12개');
});

test('a diagnostic kind has a title in the page\'s words on Start, on Analysis status and beside the picture', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=start', rewrite: { overview: withGaps, flow: guessedRoute } });
  const gaps = () => byId.get('sgaps').querySelectorAll('button.sgap').map((b) => b.textContent);
  assert.ok(gaps().some((x) => x.startsWith('unread setting: API prefix exclude list')), gaps().join(' | '));
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.ok(gaps().some((x) => x.startsWith('읽지 못한 설정: API 접두사 제외 목록')), gaps().join(' | '));
  ev(ctx, "activateTab('status')");
  await settle(ctx, 6);
  const diag = stRow(byId, 'st-ov-diag-TS_PREFIX_EXCLUDE_UNREAD');
  assert.equal(diag.querySelector('.stitemhead b').textContent, '읽지 못한 설정: API 접두사 제외 목록');
  assert.equal(diag.querySelector('.ovdiag').textContent, 'TS_PREFIX_EXCLUDE_UNREAD', 'the engine\'s code stays beside it');
  assert.match(diag.querySelector('.engine .foldlead').textContent, /^엔진이 쓴 원문/);
  assert.match(diag.textContent, /할 일프로필에 `?tsBackend\.globalPrefixExclude/);
  // Beside the picture, where the mode stopped the walk, the same title.
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /order/{id}'}, 'down')");
  await settle(ctx, 12);
  assert.match(byId.get('traceside').querySelector('.leftout').textContent, /읽지 못한 설정: API 접두사 제외 목록 TS_PREFIX_EXCLUDE_UNREAD엔진이 쓴 원문/);
});

// ---------------------------------------------------------------------------
// 5. "what this answer rests on": once a place, in the page's words, its count said as whose
// ---------------------------------------------------------------------------

test('Trace\'s details carry one "what this answer rests on", with the screens answer\'s limits in it', async (t) => {
  const { ctx, byId, asked } = await boot(t);
  ev(ctx, "openTrace({kind:'column', id:'gamma_order.total'}, 'detail')");
  await settle(ctx, 12);
  assert.ok(asked.some((a) => a.name === 'screen_impact'), 'the details asked for the screens too');
  const rails = byId.get('view').querySelectorAll('.rail');
  assert.equal(rails.length, 1, 'one box, not one per answer drawn');
  const limits = JSON.parse(ev(ctx, `JSON.stringify((()=>{ const g=PICKMEM.get(TRACEV.lastKey);
    return [...new Set([...g.column.ei.limits, ...g.screens.limits].map((l)=>l.scope+'|'+l.reason))].length; })())`));
  assert.equal(rails[0].querySelector('button.railchip').textContent, `${limits} limits on this answer`, 'every limit of both, once');
  assert.equal(rails[0].querySelector('.railwhole').textContent, `(the project has ${ev(ctx, 'OV.resp.limits.length')})`,
    'and the project\'s count beside it, so the two never read as one number');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  const rail = byId.get('view').querySelector('.rail');
  assert.equal(rail.querySelector('button.railchip').textContent, `이 답의 한계 ${limits}건`);
  assert.equal(/\b(basis|trust|limits|truncated)\b/.test(rail.textContent), false, rail.textContent);
});

// ---------------------------------------------------------------------------
// an ORM statement says what the call does
// ---------------------------------------------------------------------------

/** A NestJS service that sends five Prisma calls from one method, as ghostfolio's UserService.deleteUser does. */
function deleteUserPack() {
  const g = new Graph();
  const ctl = 'symbol:src/user/user.controller.ts#UserController.deleteOwnUser';
  const svc = 'symbol:src/user/user.service.ts#UserService.deleteUser';
  g.addNode({ id: 'endpoint:DELETE /api/v1/user', path: '/api/v1/user', httpMethod: 'DELETE', handler: ctl });
  g.addEdge({ from: 'endpoint:DELETE /api/v1/user', to: ctl, type: 'HANDLES', grade: 'EXACT', evidence: { rule: 'nestjs.routes' } });
  g.addNode({ id: ctl, file: 'src/user/user.controller.ts' });
  g.addNode({ id: svc, file: 'src/user/user.service.ts' });
  g.addEdge({ from: ctl, to: svc, type: 'MAY_CALL', grade: 'SOUND_SET', evidence: { rule: 'ts-injected-field' } });
  const calls = [['Access', 'deleteMany'], ['Account', 'deleteMany'], ['Order', 'deleteMany'], ['User', 'delete'], ['Access', 'deleteMany']];
  calls.forEach(([model, operation], i) => {
    const sid = `statement:prisma:src/user/user.service.ts#UserService.deleteUser/${i}`;
    g.addNode({ id: sid, statementType: 'delete', source: 'prisma', file: 'src/user/user.service.ts', line: 600 + i,
      prismaEvidence: { model, table: model, operation, receiver: `this.prisma.${model.toLowerCase()}.${operation}`, rule: 'prisma.operations', client: 'prisma.client' } });
    g.addEdge({ from: svc, to: sid, type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'prisma.client' } });
  });
  return g;
}
const basis = () => ({ project: 'p', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });

test('a flow statement row made by an ORM names its model and operation, and the chain names the row by it', () => {
  const r = callTool('flow', { endpoint: 'DELETE /api/v1/user' }, { graph: deleteUserPack(), basis: basis() });
  const rows = r.answer.statements;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((x) => x.call), [
    { model: 'Access', operation: 'deleteMany' }, { model: 'Account', operation: 'deleteMany' }, { model: 'Order', operation: 'deleteMany' },
    { model: 'User', operation: 'delete' }, { model: 'Access', operation: 'deleteMany' }]);
  const names = chainLabels(rows.map((x) => `statement:${x.id}`), CHAIN_FIT, ormCallsOf(r.answer));
  const texts = rows.map((x) => names.get(`statement:${x.id}`).text);
  assert.deepEqual(texts.slice(1, 4), ['UserService.deleteUser → Account.deleteMany', 'UserService.deleteUser → Order.deleteMany', 'UserService.deleteUser → User.delete']);
  // Two sites that make the same call grow by the ordinal first.
  assert.deepEqual([texts[0], texts[4]], ['UserService.deleteUser #0 → Access.deleteMany', 'UserService.deleteUser #4 → Access.deleteMany']);
  assert.equal(new Set(texts).size, 5, 'no two rows read the same');
  // The saved SVG names them the same way.
  const svgNames = chainModel(r, 'down').lanes.flatMap((l) => l.rows).filter((x) => x.id.startsWith('statement:')).map((x) => x.label);
  assert.deepEqual(svgNames, texts);
  // A statement read as the target carries the same call.
  const up = callTool('flow', { direction: 'up', statement: rows[3].id }, { graph: deleteUserPack(), basis: basis() });
  assert.deepEqual(up.answer.entry.call, { model: 'User', operation: 'delete' });
  // A statement no ORM made carries none.
  const plain = callTool('flow', { endpoint: 'DELETE /api/v1/user' }, { graph: (() => { const g = deleteUserPack(); for (const n of g.nodes.values()) delete n.prismaEvidence; return g; })(), basis: basis() });
  assert.equal(plain.answer.statements.some((x) => 'call' in x), false);
});

// ---------------------------------------------------------------------------
// 7. which way a direction goes, and the toolbar on one line
// ---------------------------------------------------------------------------

test('the target asked about is brought into view in the list, however it was picked', async (t) => {
  const { ctx, byId } = await boot(t);
  const list = byId.get('tlist');
  const rows = list.querySelectorAll('button.brrow');
  assert.ok(rows.length >= 2);
  // The stub page gives every element one box; put the target below the list.
  list.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
  rows.at(-1).getBoundingClientRect = () => ({ top: 200, bottom: 240, height: 40 });
  list.scrollTop = 0;
  ev(ctx, `openTrace({kind:'table', id:${JSON.stringify(rows.at(-1).title)}}, 'up')`);
  await settle(ctx, 12);
  assert.equal(list.scrollTop, 170, 'the list scrolled the row into its middle');
  assert.equal(rows.at(-1).classList.contains('on'), true);
});

test('a target picked from outside the list goes to the middle of the list, only the list scrolls, and a row already in view does not move it', async (t) => {
  const { ctx, byId } = await boot(t);
  const list = byId.get('tlist');
  const rows = list.querySelectorAll('button.brrow');
  const moved = [];
  for (const r of rows) r.scrollIntoView = () => moved.push(r.title);
  list.getBoundingClientRect = () => ({ top: 100, bottom: 500, height: 400 });
  const last = rows.at(-1), first = rows[0];
  last.getBoundingClientRect = () => ({ top: 520, bottom: 560, height: 40 });
  first.getBoundingClientRect = () => ({ top: 110, bottom: 150, height: 40 });
  list.scrollTop = 0;
  ev(ctx, `openTrace({kind:'table', id:${JSON.stringify(last.title)}}, 'up')`);
  await settle(ctx, 12);
  assert.equal(list.scrollTop, 240, 'out of view: brought to the middle, never to the bottom edge');
  assert.deepEqual(moved, [], 'never scrollIntoView, which would move the page and its toolbar too');
  ev(ctx, `openTrace({kind:'table', id:${JSON.stringify(first.title)}}, 'up')`);
  await settle(ctx, 12);
  assert.equal(list.scrollTop, 240, 'already whole in view: the list stays where the reader has it');
});

test('a direction says which way it goes, in both languages, and the two target-less questions live in Options', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=delta&tab=trace' });
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /rows'}, 'down')");
  await settle(ctx, 12);
  const dirs = () => byId.get('tdir').querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(dirs(), ['↓ What it uses', '↑ Where it is used', 'Details']);
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.deepEqual(dirs(), ['↓ 이게 쓰는 것', '↑ 이걸 쓰는 곳', '상세']);
  const options = byId.get('topts').querySelectorAll('button').map((b) => b.id);
  assert.ok(options.includes('tedits') && options.includes('tshowall'), options.join(' '));
  assert.equal(byId.get('tshowall').textContent, '처음 상태로 (선택 해제)', 'named for what it does');
  assert.equal(byId.get('tedits').textContent, '내 변경이 닿는 곳');
});

// ---------------------------------------------------------------------------
// 8. the masthead is one line
// ---------------------------------------------------------------------------

test('the masthead is one line at rest: the counts sit behind the build control, a wordless chip stands down', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=start' });
  assert.equal(byId.get('crail').classList.contains('hidden'), true, 'the counts are one click away');
  assert.equal(byId.get('mfreshchip').classList.contains('hidden'), true, 'no dot with no word: the verdict is unknown');
  assert.match(byId.get('mfreshchip').title, /freshness unknown/, 'and the engine\'s verdict is still on its title');
  byId.get('mbuildbtn').onclick();
  assert.equal(byId.get('crail').classList.contains('hidden'), false);
  assert.equal(byId.get('mbuild').classList.contains('hidden'), false);
  assert.match(byId.get('mbuildbtn').textContent, /counts and build/);
  // The places and the views inside the one on screen share one row.
  ev(ctx, "activateTab('erd')");
  const row = byId.get('subtabs').parentNode;
  assert.equal(row.classList.contains('tabrow'), true);
  assert.ok(row.querySelector('.tabs'), 'the places and the views are one row');
});

// ---------------------------------------------------------------------------
// Rules open on what applies here, and say so plainly when nothing does
// ---------------------------------------------------------------------------

test('Rules open on what applies here and say plainly when nothing does, instead of another stack\'s rule', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=rules' });
  await settle(ctx, 10);
  assert.equal(ev(ctx, 'RULES.list.answer.totals.here'), 0, 'no rule pack drew anything for gamma');
  assert.equal(ev(ctx, 'RULES.scope'), 'here');
  const view = byId.get('rulesview');
  assert.match(view.querySelector('.rulenone').textContent, /^No rule in the rule packs drew a link or a node in this project\. That is normal/);
  assert.equal(view.querySelectorAll('button.rulerow').length, 0, 'no rule about another stack opens first');
  assert.match(view.textContent, /Pick a rule from the list, or show all of them\./);
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.match(byId.get('rulesview').querySelector('.rulenone').textContent, /^이 프로젝트에서는 규칙 팩의 어떤 규칙도/);
});

// ---------------------------------------------------------------------------
// one walk up (J4): server pages among the screens, and an address the call was matched by
// ---------------------------------------------------------------------------

const UNREAD = 'the global prefix excludes a route pattern this engine cannot read';
/** delta's walks, with what one walk up now carries: a guessed route address on the call it matched. */
const guessedAddress = (r) => {
  const a = r.answer;
  for (const row of [...(a.endpoints || []), ...(a.webFunctions || [])]) {
    const steps = row.walkedPath || row.path;
    const last = Array.isArray(steps) ? steps[steps.length - 1] : null;
    if (last && last.type === 'CALLS_HTTP') last.evidence = { ...(last.evidence || {}), address: UNREAD, url: { ...((last.evidence && last.evidence.url) || {}), guess: 'port-default' }, prefixShift: { dropped: '/api', unsettled: UNREAD } };
  }
  if (a.walk.direction === 'up' && a.entry.kind === 'endpoint') a.entry.grade = 'HEURISTIC';
  return r;
};

test('a call matched by an unsure address says so on the row it lands on, and walked up the answer says why every caller shares it', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=delta&tab=trace', rewrite: { flow: guessedAddress } });
  ev(ctx, "openTrace({kind:'screen', id:'/rows'}, 'down')");
  await settle(ctx, 12);
  const tags = () => byId.get('tracewrap').querySelectorAll('.frow .tag.warn').filter((x) => /address unsure|주소 불확실/.test(x.textContent));
  assert.ok(tags().length > 0, 'the route the call landed on carries the tag');
  assert.equal(tags()[0].title, `This route's own address is a guess: ${UNREAD}. The call goes to this machine on a port no file states; that this project answers it rests on Spring Boot's default port, which whatever starts the app may change. The call was matched only after dropping /api from the front of its address.`);
  ev(ctx, "openTrace({kind:'endpoint', id:'GET /rows'}, 'up')");
  await settle(ctx, 12);
  assert.ok(tags().length > 0, 'walked up, the frontend function that calls it carries it');
  assert.match(head(byId).querySelector('.tanswer').textContent,
    /This route's own address is graded HEURISTIC, so every caller found by that address carries the same grade\./);
  assert.equal(head(byId).querySelector('.tfloor'), null, 'walked up, a guessed route does not stop the walk at itself');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.match(head(byId).querySelector('.tanswer').textContent, /이 API 주소 자체가 HEURISTIC 등급이라, 이 주소로 찾은 호출도 모두 같은 등급입니다\./);
  assert.equal(tags()[0].textContent, '주소 불확실');
});

/** delta walked up, with a page one of the reached handlers renders on the server, as one walk up now lists it. */
const withPage = (r) => {
  const a = r.answer;
  if (a.walk.direction !== 'up' || !Array.isArray(a.screens)) return r;
  const handler = (a.services || []).find((s) => s.handler) || (a.services || [])[0];
  a.screens.push({ id: 'rows-page', short: 'rows-page', title: null, name: null, group: null, component: null,
    template: 'templates/rows.html', engine: 'thymeleaf', hops: handler.hops + 1, grade: 'EXACT',
    link: { from: `symbol:${handler.id}`, type: 'RENDERS_PAGE', grade: 'EXACT', basis: 'the handler returns this view name' } });
  const f = r.truncated.fields.find((x) => x.field === 'screens');
  if (f) { f.total += 1; f.shown += 1; }
  return r;
};

test('a page a route renders on the server is a screen of the answer, marked as a page and named by its template', async (t) => {
  const { ctx, byId } = await boot(t, { hash: '#p=delta&tab=trace', rewrite: { flow: withPage } });
  ev(ctx, "openTrace({kind:'table', id:'delta_rows'}, 'up')");
  await settle(ctx, 12);
  const screens = ev(ctx, "TRACEV.resp.truncated.fields.find((f)=>f.field==='screens').total");
  assert.match(say(byId), new RegExp(`${screens} screens?\\.$`), 'the sentence counts the page among the screens');
  const lane = byId.get('tracewrap').querySelectorAll('.fcol').find((c) => c.dataset.field === 'screens');
  const page = lane.querySelectorAll('.frow').find((r) => /rows-page/.test(r.textContent));
  assert.ok(page, lane.textContent);
  assert.ok(page.querySelectorAll('.tag').some((x) => x.textContent === 'page'), 'marked as a page');
  assert.match(page.textContent, /templates\/rows\.html/);
  assert.ok(ev(ctx, "TRACEV.linkSpecs.some((l)=> l.to.endsWith('rows-page'))"), 'hung from the handler that renders it');
});

// ---------------------------------------------------------------------------
// a name keeps the part that tells it apart, and never widens the page
// ---------------------------------------------------------------------------

test('a ranking name gives way in the middle inside a fixed table, so a long screen URL cannot widen the page', async (t) => {
  const { html } = await startViewer(t, ['gamma']);
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // mall's busiest screens include an absolute URL 60 characters long; an auto
  // table grew to fit it and pushed the page 40px past its right edge at 1440.
  assert.match(css, /\.ovpanels3 table\.ruled \{ table-layout:fixed; width:100%; \}/);
  const { ctx, byId } = await boot(t, { hash: '#p=gamma&tab=start' });
  const name = byId.get('shubs').querySelectorAll('a.psplit')[0];
  assert.ok(name, 'the busiest APIs name their route cut from the middle');
  const id = name.title.split('\n')[0];
  assert.equal(name.textContent, id, 'the whole route is there, head and tail');
  assert.ok(id.endsWith(name.querySelector('.ptail').textContent.split('/').pop()), 'the tail keeps the last segment');
  void ctx;
});
