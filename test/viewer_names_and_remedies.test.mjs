// viewer_names_and_remedies.test.mjs — one word for one thing, and the fix beside the gap (RM67-U2d).
//
// Two things the U2c screenshots showed.
//
// ONE WORD FOR TWO THINGS. On ghostfolio the header said "api groups 32" and the
// map on Start said "118 routes in 21 groups". The header counts routes by the
// first segment of their path (the unit Structure, Coupling and Trace use); the
// map groups them by where the handler code sits, because that is what a map of
// "which code reaches which tables" is about, and by path a third of mall's
// routes fold into "(others)". Both stay, and each is named for what it is: the
// header says "api groups by path" (or "modules" where the profile declares
// them), and the map names its boxes by the rule the summary answer names: code
// areas, modules, API groups, or path areas. Nowhere on the map is a box a bare
// "group".
//
// THE FIX BESIDE THE GAP. Ghostfolio showed 0% everywhere because 117 of 118
// routes are HEURISTIC; Start said why and not what to do. Every gap row on
// Start, every percentage card's limit line and the map's empty notice now say
// the one thing to do, from the engine's own `remedy` (a profile key with a
// short example, a flag, a command or a mode), or that the engine knows none.
// An answer from a server that carries no remedy gets no line at all: the page
// never writes a fix of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

/** The page over the real fixture server; `rewrite` may change one tool's answer on its way to the page. */
async function boot(t, { hash = '#p=gamma', projects = ['gamma', 'delta'], rewrite = {} } = {}) {
  const { html, base } = await startViewer(t, projects);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (body && body.name) asked.push({ name: body.name, args: body.arguments || {} });
    const res = await fetch(base + url, opts);
    if (!body || !rewrite[body.name]) return res;
    return json(rewrite[body.name](await res.json(), body.arguments || {}));
  };
  const page = await bootPage({ html, hash, origin: base, answer });
  await settle(page.ctx, 20);
  return { ...page, asked };
}
const click = (x) => x.onclick();
const lane = (byId) => byId.get('crail').querySelectorAll('.crlane').find((x) => x.querySelector('b') && /group|modul|그룹|모듈/i.test(x.textContent));
/** Every visible use of the word group on the map that does not say which one (the page's text runs words of two elements together). */
const bareGroups = (text) => [...text.matchAll(/groups?\b/gi)].filter((m) => text.slice(Math.max(0, m.index - 4), m.index) !== 'API ')
  .map((m) => text.slice(Math.max(0, m.index - 12), m.index + m[0].length));

// ---------------------------------------------------------------------------
// one word for one thing
// ---------------------------------------------------------------------------

test('the header counts API groups by path, and says modules where the profile declares them', async (t) => {
  const { ctx, byId } = await boot(t);
  assert.equal(lane(byId).textContent, `api groups by path ${ev(ctx, 'OV.resp.answer.reach.groups')}`);
  assert.match(lane(byId).title, /first segment of a route/);
  assert.match(lane(byId).title, /map on Start says what its own boxes are/, 'the map may group another way, and says so there');
  ev(ctx, "OV.resp.answer.groupRule={kind:'declared', packageDepth:4}; renderCascadeRail()");
  assert.equal(lane(byId).textContent, `modules, as declared ${ev(ctx, 'OV.resp.answer.reach.groups')}`);
  assert.match(lane(byId).title, /cut to 4 segment\(s\)/);
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.match(lane(byId).textContent, /^모듈\(프로필 선언\) \d+$/);
  ev(ctx, "OV.resp.answer.groupRule={kind:'path'}; renderCascadeRail()");
  assert.match(lane(byId).textContent, /^API 그룹\(경로 기준\) \d+$/);
});

test('the map names its boxes by the rule that made them, and never calls one a bare group', async (t) => {
  // gamma's handlers all sit in one package, so its map groups by the first
  // path segment: the header's own API groups, with the header's own count.
  const { ctx, byId } = await boot(t);
  const map = () => byId.get('ovsummary').textContent;
  assert.match(byId.get('ovsummary').querySelector('.panelsub').textContent, /^API groups are the first segment of each route's path, as the header counts them\./);
  assert.match(map(), /3 routes in 2 API groups reach/);
  assert.equal(ev(ctx, 'SUM.resp.answer.totals.groups'), ev(ctx, 'OV.resp.answer.reach.groups'), 'the same rule, the same count');
  ev(ctx, "summarySelect('g:order')");
  await settle(ctx, 4);
  assert.deepEqual(byId.get('ovsummary').querySelector('.sumcrumbs').querySelectorAll('.sumcrumb').map((c) => c.textContent), ['Whole map', 'API group order']);
  assert.match(map(), /The families this API group's routes reach/);
  assert.deepEqual(bareGroups(map()), [], 'every group on the map says which');
  // The four rules, each with its own name.
  const say = (groups) => ev(ctx, `summaryRuleLine({rule:{groups:${JSON.stringify(groups)}, tables:{kind:'name-words', commonPrefix:''}}})`);
  assert.equal(say({ kind: 'code-path', commonPrefix: 'apps/api/src/app', by: 'directory' }),
    'Code areas are where the handler code sits, below apps/api/src/app. They are not modules anyone declared, nor the API groups the header counts by path. Families are tables whose names start with the same word.');
  assert.match(say({ kind: 'code-path', commonPrefix: '' }), /^Code areas are where the handler code sits\. They are not modules/, 'no shared package to name, and still a code area');
  assert.match(say({ kind: 'declared', packageDepth: 4 }), /^Modules are handler packages cut to 4 segment\(s\), as the profile declares\. The header counts the same ones\./);
  assert.match(say({ kind: 'lane' }), /^API groups are the first segment of a route below the prefix the application is deployed under, the same ones the header counts\./);
  assert.match(say({ kind: 'path', commonPath: '/api' }), /^Path areas are route path segments below \/api\. The API groups the header counts stop at the first segment\./);
});

test('a map grouped by where the code sits says code areas everywhere, in both languages', async (t) => {
  const codePath = (r) => { r.answer.rule.groups = { kind: 'code-path', commonPrefix: 'com.gamma' }; return r; };
  const { ctx, byId } = await boot(t, { rewrite: { summary: codePath } });
  const map = () => byId.get('ovsummary').textContent;
  assert.match(map(), /Code areas are where the handler code sits, below com\.gamma\./);
  assert.match(map(), /3 routes in 2 code areas reach 2 tables in 2 families\./);
  ev(ctx, "summarySelect('f:order')");
  await settle(ctx, 4);
  assert.match(map(), /The code areas whose routes reach this family/);
  ev(ctx, "summarySelect('g:order')");
  await settle(ctx, 4);
  assert.match(map(), /The families this code area's routes reach/);
  assert.deepEqual(byId.get('ovsummary').querySelector('.sumcrumbs').querySelectorAll('.sumcrumb').map((c) => c.textContent), ['Whole map', 'code area order']);
  assert.deepEqual(bareGroups(map()), [], 'the only groups the map names are the header\'s, by name');
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  assert.match(map(), /코드 영역은 핸들러 코드가 놓인 위치입니다/);
  assert.match(map(), /코드 영역 order/);
  assert.equal(/묶음/.test(map()), false, 'the old word, which read as the header\'s group, is gone');
  // The folded box says what it folds.
  assert.equal(ev(ctx, "t('summary.others.groups', {n:3, routes:18, nouns:t('summary.nouns.area'), noun:t('summary.noun.area')})"), '경로가 적은 코드 영역 3개, 경로 18개');
});

// ---------------------------------------------------------------------------
// the fix beside the gap
// ---------------------------------------------------------------------------

/** gamma's overview, as ghostfolio's reads: routes that are guesses, a lane's diagnostic, an axis not collected, each with the engine's remedy. */
function ghostLike(r) {
  const a = r.answer;
  a.reach.routeGrades = { EXACT: 1, HEURISTIC: 117 };
  a.routeRemedy = { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: '["health", "docs{/*rest}"]' };
  a.axes = { catalog: { status: 'not-shipped', reason: 'no catalog was read' }, code: { status: 'shipped', reason: null },
    screen: { status: 'not-shipped', reason: 'the screen axis is off' } };
  a.axisRemedies = { catalog: { action: 'run', command: 'cascade catalog fetch --candidate 1' }, screen: null };
  for (const g of a.gaps) if (!Object.hasOwn(g, 'remedy')) g.remedy = null;
  a.gaps.find((g) => g.kind === 'unresolved-calls').remedy = { action: 'flag', flag: '--java-src', example: '--java-src <module>/src/main/java' };
  a.diagnostics = [
    { kind: 'TS_PREFIX_EXCLUDE_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'the global prefix "api" excludes 2 route pattern(s) this engine cannot read',
      remedy: { action: 'declare', key: 'tsBackend.globalPrefixExclude', example: '["health", "docs{/*rest}"]' } },
    { kind: 'TS_MODULE_IMPORT_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'its imports spread a list', remedy: null },
  ];
  return r;
}
const fixOf = (li) => li.querySelector('.remedy');

test('every gap row on Start says the one thing to do, from the engine, or that the engine knows none', async (t) => {
  const { ctx, byId } = await boot(t, { rewrite: { overview: ghostLike } });
  const sgaps = byId.get('sgaps');
  // The guessed routes come first, and carry the fix the diagnostic names.
  const guess = sgaps.querySelector('.sgapguess').parentNode;
  assert.match(guess.textContent, /117 of 118 routes graded HEURISTIC: mode conservative stops at them/);
  assert.equal(fixOf(guess).textContent, 'What to do: Declare tsBackend.globalPrefixExclude in the profile, for example ["health", "docs{/*rest}"].');
  assert.deepEqual(fixOf(guess).querySelectorAll('code').map((c) => c.textContent), ['tsBackend.globalPrefixExclude', '["health", "docs{/*rest}"]'],
    'the key and the example are code a reader copies');
  const rows = sgaps.querySelectorAll('li');
  const row = (start) => rows.find((li) => li.querySelector('button.sgap').textContent.startsWith(start));
  assert.equal(fixOf(row('a lane reported TS_PREFIX_EXCLUDE_UNREAD')).textContent,
    'What to do: Declare tsBackend.globalPrefixExclude in the profile, for example ["health", "docs{/*rest}"].');
  assert.equal(fixOf(row('a lane reported TS_MODULE_IMPORT_UNREAD')).textContent,
    'What to do: No fix the engine knows of. It can only say what it could not read.');
  assert.equal(fixOf(row('calls we could not follow')).textContent, 'What to do: Analyze again with --java-src <module>/src/main/java.');
  assert.equal(fixOf(row('database schema: not collected')).textContent, 'What to do: Run cascade catalog fetch --candidate 1.');
  assert.equal(fixOf(row('screens: not collected')).textContent, 'What to do: No fix the engine knows of. It can only say what it could not read.');
  // Every row has one, and it is the engine's: change the answer, and the page says what it says.
  assert.ok(rows.every((li) => fixOf(li)), 'no gap row without its line');
  ev(ctx, "OV.resp.answer.diagnostics[0].remedy.key='sentinel.fromTheEngine'; renderStart(OV.resp)");
  assert.match(byId.get('sgaps').textContent, /Declare sentinel\.fromTheEngine in the profile/);
  // The row still goes to its place on Analysis status.
  click(byId.get('sgaps').querySelectorAll('button.sgap').find((b) => b.textContent.startsWith('calls we could not follow')));
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'status');
});

test('the fix reads the same in Korean, with the key and the example left as they are', async (t) => {
  const { ctx, byId } = await boot(t, { rewrite: { overview: ghostLike } });
  ev(ctx, "setLang('ko')");
  await settle(ctx, 6);
  const guess = byId.get('sgaps').querySelector('.sgapguess').parentNode;
  assert.equal(fixOf(guess).textContent, '할 일: 프로필에 tsBackend.globalPrefixExclude 키를 적습니다. 예: ["health", "docs{/*rest}"]');
  const texts = byId.get('sgaps').querySelectorAll('.remedy').map((x) => x.textContent);
  assert.ok(texts.includes('할 일: cascade catalog fetch --candidate 1 명령을 실행합니다.'), texts.join(' | '));
  assert.ok(texts.includes('할 일: --java-src <module>/src/main/java 옵션을 붙여 다시 분석합니다.'), texts.join(' | '));
  assert.ok(texts.includes('할 일: 엔진이 아는 해결 방법은 없습니다. 무엇을 못 읽었는지만 말할 수 있습니다.'), texts.join(' | '));
});

test('an answer that carries no remedy gets no line: the page never writes a fix of its own', async (t) => {
  const bare = (r) => { const x = ghostLike(r); delete x.answer.routeRemedy; delete x.answer.axisRemedies;
    for (const g of x.answer.gaps) delete g.remedy; for (const d of x.answer.diagnostics) delete d.remedy; return x; };
  const { byId } = await boot(t, { rewrite: { overview: bare } });
  assert.equal(byId.get('sgaps').querySelectorAll('.remedy').length, 0);
  assert.ok(byId.get('sgaps').querySelectorAll('button.sgap').length >= 4, 'the rows themselves are all still there');
  assert.equal(byId.get('ovcards').querySelectorAll('.remedy').length, 0);
});

test('a percentage card\'s limit line carries its fix: the guessed routes, and an axis not collected', async (t) => {
  const { byId } = await boot(t, { rewrite: { overview: ghostLike } });
  const cards = byId.get('ovcards').querySelectorAll('.kpi');
  const card = (lbl) => cards.find((c) => c.querySelector('.kpilbl').textContent === lbl);
  const routes = card('endpoints that reach SQL');
  assert.match(routes.querySelector('.kpilimit').textContent, /117 of 118 routes graded HEURISTIC/);
  assert.equal(routes.querySelector('.remedy').textContent, 'What to do: Declare tsBackend.globalPrefixExclude in the profile, for example ["health", "docs{/*rest}"].');
  const tables = card('tables reached');
  assert.match(tables.querySelector('.kpilimit').textContent, /no database schema was read/);
  assert.equal(tables.querySelector('.remedy').textContent, 'What to do: Run cascade catalog fetch --candidate 1.');
  // A card with no limit has no fix to say.
  assert.equal(card('SQL statements reached').querySelector('.remedy'), null);
});

test('the map\'s empty notice says why in the routes\' own grade, and carries the same fix', async (t) => {
  const stopped = (r) => { r.answer.links = []; r.answer.walk.byMode = 117; r.answer.walk.byModeGrades = { HEURISTIC: 117 }; return r; };
  const { byId } = await boot(t, { rewrite: { overview: ghostLike, summary: stopped } });
  const note = byId.get('ovsummary').querySelector('.sumempty');
  assert.match(note.textContent, /No route reaches a table in mode conservative\. The walks left 117 link\(s\) graded HEURISTIC out/);
  assert.match(note.textContent, /117 of 118 routes graded HEURISTIC: mode conservative stops at them/);
  assert.equal(note.querySelector('.remedy').textContent, 'What to do: Declare tsBackend.globalPrefixExclude in the profile, for example ["health", "docs{/*rest}"].');
  assert.ok(note.querySelectorAll('button').some((b) => /heuristic/.test(b.textContent)), 'and still offers the mode that looks');
});

test('Analysis status says the same fix in each row\'s what to do', async (t) => {
  const { byId } = await boot(t, { hash: '#p=gamma&tab=status', rewrite: { overview: ghostLike } });
  const todo = (row) => row.querySelectorAll('.stline').find((l) => l.querySelector('.stlbl').textContent === 'what to do').querySelector('.stval').textContent;
  const gap = byId.get('stgaps').querySelector('#st-ov-gap-unresolved-calls');
  assert.equal(todo(gap), 'Analyze again with --java-src <module>/src/main/java.');
  const diag = byId.get('stdiags').querySelector('#st-ov-diag-TS_PREFIX_EXCLUDE_UNREAD');
  assert.equal(todo(diag), 'Declare tsBackend.globalPrefixExclude in the profile, for example ["health", "docs{/*rest}"].');
  // A walk's own bound: the mode that walks further, from the engine.
  const floor = byId.get('stgaps').querySelector('#st-ov-gap-mode-floor');
  assert.equal(todo(floor), 'Ask again in mode heuristic.');
  // A place nothing reaches has no fix to relay, and keeps the page's words on how to look.
  const unreached = byId.get('stgaps').querySelector('#st-ov-gap-tables-not-reached');
  assert.equal(todo(unreached), 'Open one on Trace, Details, to see which SQL touches it.');
});
