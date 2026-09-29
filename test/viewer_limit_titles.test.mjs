// viewer_limit_titles.test.mjs — a limit says what it is before it says the engine's sentence,
// and the map's counts can be read (RM67-U2f).
//
// Two things the Korean page still did in English or on top of each other:
//   1. the "what this answer rests on" box listed each limit as its scope and
//      the engine's English sentence ("axis:jpa the jpa axis of this pack is
//      not-shipped: ..."). A limit now shows a title in the reader's language,
//      and the sentence, word for word, is one activation away under it;
//   2. on Start the count on each line ("API 41 → 테이블 12") sat on the dashed
//      lines and under the lines drawn after it. A count now sits on its own
//      ground, above every line, inside the band between the two columns, and
//      never on another count.
// Every title key is held against the engine's source in test/i18n.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, settle, ev, ENGINE_ROOT } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { handleViewerLib } from '../src/mcp/http.mjs';

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

/** The page over the real fixture server; `rewrite` may change one tool's answer on its way to the page. */
async function boot(t, { hash = '#p=gamma&tab=start', projects = ['gamma', 'delta'], rewrite = {}, storage = {} } = {}) {
  const { html, base } = await startViewer(t, projects);
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const res = await fetch(base + url, opts);
    if (!body || !rewrite[body.name]) return res;
    return json(rewrite[body.name](await res.json(), body.arguments || {}));
  };
  const page = await bootPage({ html, hash, storage, origin: base, answer });
  await settle(page.ctx, 20);
  return page;
}

// ---------------------------------------------------------------------------
// 1. a limit's title first, the engine's sentence folded under it
// ---------------------------------------------------------------------------

// One of each way a title is found, and one scope the page has no words for.
const LIMITS = [
  { scope: 'axis:jpa', reason: 'the jpa axis of this pack is not-shipped: the JPA bridge did not run, because there is no @Entity class' },
  { scope: 'axis:web', reason: '3 of 151 frontend call site(s) were traced to no client, so each of their edges is HEURISTIC at best' },
  { scope: 'axis:code', reason: 'one thing the code axis could not see, said by an engine newer than this page' },
  { scope: 'summary:groups', reason: 'a group is where the handler code sits, read below the package every handler shares (com.acme)' },
  { scope: 'flow', reason: 'depth cap 8 reached at 3 call(s), so deeper calls were not walked and what they reach is unknown, not absent' },
  { scope: 'mystery', reason: 'a scope nobody titled. It keeps its own words' },
];
const TITLES = {
  // Lower case first, as every label and title on this page is ("calls we could not follow").
  en: ['JPA mappings: not collected', 'frontend calls traced to no client', 'code: one thing it did not see',
    'how the boxes on the left are made', 'stopped at the depth limit'],
  ko: ['JPA 매핑: 수집 안 함', '클라이언트를 못 찾은 프론트엔드 호출', '코드: 못 본 부분이 있음',
    '왼쪽 상자를 나눈 기준', '깊이 한도에서 멈춤'],
};
const withLimits = (r) => { r.limits = LIMITS.map((l) => ({ ...l })); return r; };

/** The Start map's rail, its limits fold opened, and each limit row as {lead, body, title}. */
function railRows(byId) {
  const rail = byId.get('ovsummary').querySelector('.rail');
  const chip = rail.querySelectorAll('button.railchip').find((b) => b.getAttribute('aria-expanded') !== null);
  if (chip.getAttribute('aria-expanded') !== 'true') chip.onclick();
  return rail.querySelectorAll('.raillim').map((row) => ({
    lead: row.querySelector('.foldtext') ? row.querySelector('.foldtext').textContent : row.textContent,
    body: row.querySelector('.foldbody') ? row.querySelector('.foldbody').textContent : '',
    title: row.title,
    folded: !!row.querySelector('.foldbody'),
  }));
}

test('a limit on the rail says its title first, in the reader\'s language, with the engine\'s sentence folded under it', async (t) => {
  const { ctx, byId } = await boot(t, { rewrite: { summary: withLimits } });
  const rows = railRows(byId);
  assert.equal(rows.length, LIMITS.length);
  TITLES.en.forEach((title, i) => {
    assert.equal(rows[i].lead, title, `${LIMITS[i].scope}: the title, and only the title, stands on the page`);
    assert.ok(rows[i].folded, `${LIMITS[i].scope}: the sentence is under a fold`);
    // Word for word, beside the scope as the engine wrote it, one activation away.
    assert.ok(rows[i].body.includes(LIMITS[i].reason), `${LIMITS[i].scope}: the engine's sentence is under the title`);
    assert.ok(rows[i].body.includes(LIMITS[i].scope), `${LIMITS[i].scope}: the scope is said with it`);
    assert.equal(rows[i].title, LIMITS[i].scope, 'and the row names its scope on hover');
  });
  // A scope the page has no words for keeps the engine's: the scope and the sentence's first words.
  const last = rows[LIMITS.length - 1];
  assert.ok(last.lead.startsWith('mystery'), last.lead);
  assert.ok(last.lead.includes('a scope nobody titled.'), last.lead);

  ev(ctx, "setLang('ko')");
  await settle(ctx, 8);
  const ko = railRows(byId);
  TITLES.ko.forEach((title, i) => assert.equal(ko[i].lead, title, `${LIMITS[i].scope} (ko)`));
  assert.ok(ko[1].body.includes(LIMITS[1].reason), 'the engine\'s sentence is not translated');
  assert.deepEqual(JSON.parse(ev(ctx, 'JSON.stringify([...I18N.t.missing, ...I18N.t.fellBack])')), [], 'no title the page asked for is missing or fell back to English');
});

test('a flood of one diagnostic is one row with the kind\'s title, the code folded with the sentences', async (t) => {
  const { ctx } = await boot(t);
  const lim = [1, 2, 3].map((i) => ({ scope: 'diagnostic:SHARD_UNUSABLE', reason: `cache file ${i}.json is unusable` }));
  const got = JSON.parse(ev(ctx, `(()=>{ const rows=limitRows('t.', ${JSON.stringify(lim)});
    return JSON.stringify(rows.map((r)=> ({ lead:r.querySelector('.foldtext').textContent, body:r.querySelector('.foldbody').textContent }))); })()`));
  assert.equal(got.length, 1);
  assert.ok(got[0].lead.startsWith(ev(ctx, "t('diag.title.SHARD_UNUSABLE')")), got[0].lead);
  assert.equal(got[0].lead.includes('SHARD_UNUSABLE'), false, 'the code is not the title');
  assert.ok(got[0].body.includes('diagnostic:SHARD_UNUSABLE'), 'the code is under the fold');
});

test('the page loads the title rules, served as the module itself', () => {
  const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
  const at = (src) => html.indexOf(`<script src="${src}">`);
  assert.ok(at('/viewer/lib/limit_titles.js') > 0, 'the page does not load /viewer/lib/limit_titles.js');
  assert.ok(at('/viewer/lib/limit_titles.js') < at('/viewer/js/10_dom.js'), 'the rail is drawn by 10_dom.js');
  const out = handleViewerLib('GET', '/viewer/lib/limit_titles.js', { viewerLibDir: path.join(ENGINE_ROOT, 'src', 'viewer') });
  assert.equal(out.status, 200);
  assert.ok(out.body.includes('function limitTitleKeys('));
  assert.equal(/^export /m.test(out.body), false);
});

// ---------------------------------------------------------------------------
// 2. the map's counts: on their own ground, above the lines, never on each other or on a box
// ---------------------------------------------------------------------------

test('a count on the map sits on its own ground, drawn after every line', async (t) => {
  const { byId } = await boot(t);
  const svg = byId.get('ovsummary').querySelectorAll('svg').find((s) => s.getAttribute('class') === 'sumlinks');
  const kids = svg.children;
  const lastPath = kids.map((k) => k.tagName.toLowerCase()).lastIndexOf('path');
  const firstLabel = kids.findIndex((k) => k.tagName.toLowerCase() === 'g');
  assert.ok(firstLabel > 0, 'the small map labels its lines');
  assert.ok(firstLabel > lastPath, 'no line is drawn over a count');
  for (const g of kids.slice(firstLabel)) {
    const [ground, text] = g.children;
    assert.equal(ground.getAttribute('class'), 'sumlblbg', 'a count has a ground under it');
    assert.equal(text.getAttribute('class'), 'sumlbl');
    // The ground is the count's own box: centred on the same point, wider than the words.
    assert.equal(Number(ground.getAttribute('x')) + Number(ground.getAttribute('width')) / 2, Number(text.getAttribute('x')));
    assert.ok(Number(ground.getAttribute('width')) > 0);
  }
});

test('counts are placed inside the band between the columns and never on each other', async (t) => {
  const { ctx } = await boot(t);
  // Five lines that cross in the middle of a 300-wide band, in a 900-wide picture:
  // the boxes stand left of 300 and right of 600.
  const got = JSON.parse(ev(ctx, `(()=>{ const placed=[], fit=summaryLabelFit({width:900, height:400}, placed, { l:300, r:600 });
    const line=(y1, y2)=> (u)=> [300+300*u, y1+(y2-y1)*u];
    const spots=[[0,200],[200,0],[100,100],[0,0],[200,200],[100,100],[100,100],[100,100],[100,100],[100,100]].map(([a,b])=> fit('API 41 → 테이블 12', line(a+20,b+20)));
    return JSON.stringify({ spots, placed }); })()`));
  const boxes = got.placed;
  assert.deepEqual(got.spots[0], [450, 120], 'the first line (the heaviest, in the page) takes the middle');
  // The flat line through the crossing has no free point left once the two diagonals
  // took the middle; the four others each find one.
  assert.equal(boxes.length, got.spots.filter(Boolean).length);
  assert.ok(boxes.length >= 4, `the crossing lines each find a free point, got ${boxes.length}`);
  for (const b of boxes) {
    assert.ok(b.l >= 300 && b.r <= 600, `a count stays in the band, off the boxes: ${JSON.stringify(b)}`);
    assert.ok(b.t >= 0 && b.b <= 400, 'and inside the picture');
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `two counts overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
  }
  assert.ok(got.spots.includes(null), 'a line with no free point keeps its count on its title only');
  // A line with no point in the band, or none inside the picture, keeps its count on its title only.
  const edge = JSON.parse(ev(ctx, `(()=>{ const fit=summaryLabelFit({width:900, height:400}, [], { l:300, r:600 });
    return JSON.stringify([fit('41 → 12 tables', (u)=> [100*u, 50]), fit('41 → 12 tables', (u)=> [450, 2])]); })()`));
  assert.deepEqual(edge, [null, null], 'a count never stands over a box or past the picture\'s edge');
  // The band is the gap cell between the two columns, measured from the page, in the picture's own coordinates.
  const lane = JSON.parse(ev(ctx, `JSON.stringify(summaryLane({ querySelector:(s)=> s==='.sumgap'
    ? { getBoundingClientRect:()=> ({ left:350, right:650, width:300 }) } : null }, { left:50 }))`));
  assert.deepEqual(lane, { l: 300, r: 600 });
  // A Hangul letter is about twice as wide as a Latin one, so a Korean count takes more room than its length says.
  const w = JSON.parse(ev(ctx, "JSON.stringify([summaryLabelWidth('테이블 12'), summaryLabelWidth('tbl 12')])"));
  assert.ok(w[0] - w[1] > 3 * 3, `three Hangul letters take more room than three Latin ones: ${w}`);
});
