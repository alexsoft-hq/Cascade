// viewer_compare.test.mjs — the Compare tab, run for real: one project against an earlier build of itself, as one report.
//
// The tab once offered every other served project as a base, and on a normal
// registry that set one codebase against another. What is held here: the tab is
// there only when the project on screen has an earlier build kept, its choices
// are those builds and nothing else, it asks `pack_diff` for the one chosen, and
// it reads the conditions before the lists.
//
// And the report it writes from that answer: a changed attribute with its value
// before and after, a changed evidence, a move in the source listed apart, a cut
// list said to be cut, a hostile value kept as text on screen and inside code in
// the Markdown file, a Flow button only for an end the head still has, print and
// save from the answer in memory, an older server's answer said to be what it is,
// and the empty states told apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keepPreviousPack } from '../src/cli/pack_history.mjs';
import { digest12 } from '../src/core/canonical.mjs';
import { bootPage as boot, ev, settle } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

/** The earlier build of the first tests: the pack with one more route. */
const addRetired = (earlier) => {
  earlier.nodes.push({ id: 'endpoint:GET /retired', kind: 'endpoint', path: '/retired', httpMethod: 'GET' });
};

/**
 * Give one fixture project an earlier build: its pack, changed by `mutate`, kept
 * the way a certified analyze keeps the pack it replaces.
 */
function keepEarlierBuild(host, id, mutate = addRetired, commit = 'a'.repeat(40)) {
  const dir = host.ctxFor(id).packDir;
  const file = path.join(dir, 'pack.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const earlier = JSON.parse(JSON.stringify(current));
  earlier.meta.base = { commit, dirty: false };
  mutate(earlier);
  // The history checks a kept pack's body against its digest, so the earlier build carries its real one.
  earlier.digest = digest12({ nodes: earlier.nodes, edges: earlier.edges });
  fs.writeFileSync(file, JSON.stringify(earlier));
  keepPreviousPack(dir, current);
  fs.writeFileSync(file, JSON.stringify(current));
  // The served context was loaded before the pack file was touched; it reads it again.
  host.ctxFor(id);
}

/**
 * The earlier build of gamma the report tests read: a transaction marker the
 * head no longer has, two comments that carry a pipe, backticks, a tag and a
 * line break, a statement one line further down, an evidence the head lacks,
 * and one route that is gone.
 */
const HOSTILE = 'gamma | money `x` <b>y</b>';
const MULTILINE = 'first line\n```\n<b>second</b>';
function gammaEarlier(earlier) {
  const by = (id) => earlier.nodes.find((n) => n.id === id);
  by('symbol:com.g.GServiceImpl#load').transactional = true;
  by('column:gamma_order.total').comment = HOSTILE;
  by('table:gamma_order').comment = MULTILINE;
  by('statement:com.g.GMapper.selectOrder').line = 11;
  addRetired(earlier);
  const e = earlier.edges.find((x) => x.type === 'READS' && x.to === 'column:gamma_order.total');
  e.evidence = { access: 'read' };
}

const isPackDiff = (opts) => {
  const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
  return body && body.name === 'pack_diff' ? body : null;
};

/**
 * Boot the page against the real server. `hold` may return a promise a request
 * waits on before it is answered; `rewrite` may rewrite the `pack_diff` answer
 * the server gave, which is how an older server's answer, and a cut list, are
 * put in front of the page.
 */
async function bootWith(t, { ids = ['alpha', 'beta'], earlier = [], hash = '', hold = () => null, mutate, rewrite } = {}) {
  const { html, base, host } = await startViewer(t, ids);
  // An entry is a project id, or `{id, mutate, commit}` for a second build of one project.
  for (const e of earlier) (typeof e === 'string' ? keepEarlierBuild(host, e, mutate) : keepEarlierBuild(host, e.id, e.mutate, e.commit));
  const answer = async (url, opts) => {
    await hold(url, opts);
    const res = await fetch(base + url, opts);
    if (!rewrite || !isPackDiff(opts)) return res;
    return new Response(JSON.stringify(rewrite(await res.json())), { headers: { 'content-type': 'application/json' } });
  };
  return boot({ html, hash, origin: base, answer });
}

const tabButton = (page) => page.body.querySelectorAll('.tab').find((n) => n.getAttribute('data-tab') === 'compare');
const view = (page) => page.byId.get('cmpview');
const rows = (page) => view(page).querySelectorAll('li.cmprow');
const rowWith = (page, text) => rows(page).find((li) => li.textContent.includes(text));
/** The rows of the panel whose heading starts with `heading`. */
function panelRows(page, heading) {
  const panel = view(page).querySelectorAll('.panel').find((p) => p.querySelector('h2') && p.querySelector('h2').textContent.startsWith(heading));
  assert.ok(panel, `a panel headed ${heading}`);
  return panel.querySelectorAll('li.cmprow');
}
/**
 * Whether a fenced block of the Markdown text is left open: a block opens on a
 * line that is only a fence, and closes only on a line that is a fence at least
 * as long with nothing after it, which is the CommonMark rule. A closing fence
 * with ` -> ...` behind it closes nothing, and the block swallows what follows.
 */
function unclosedFence(md) {
  let open = 0;
  for (const line of md.split('\n')) {
    const m = /^\s*(`{3,})\s*$/.exec(line);
    if (!m) continue;
    if (open === 0) open = m[1].length;
    else if (m[1].length >= open) open = 0;
  }
  return open > 0;
}
async function drawn(page) {
  for (let i = 0; i < 60 && !ev(page.ctx, 'CMP.resp'); i += 1) await settle(page.ctx, 1);
  assert.ok(ev(page.ctx, 'CMP.resp'), `the comparison was drawn; the tab says: ${view(page).textContent.slice(0, 300)}`);
}
/** The report page every report test starts from: gamma against its earlier build. */
const gammaPage = (t, extra = {}) => bootWith(t, { ids: ['gamma'], earlier: ['gamma'], mutate: gammaEarlier, hash: '#p=gamma&tab=compare', ...extra });

// ---------------------------------------------------------------------------
// The tab, its base, and the race
// ---------------------------------------------------------------------------

test('a project with no earlier build has no Compare tab, even on a server with other projects', async (t) => {
  const page = await bootWith(t, { hash: '#p=beta&tab=overview' });
  assert.equal(tabButton(page).classList.contains('hidden'), true);
  assert.equal(page.byId.get('cmpbase').children.length, 0, 'another served project is never offered as a base');
});

test('the Compare tab offers this project\'s earlier builds only, and draws the one chosen, conditions first', async (t) => {
  const page = await bootWith(t, { earlier: ['beta'], hash: '#p=beta&tab=compare' });
  assert.equal(tabButton(page).classList.contains('hidden'), false);
  const options = page.byId.get('cmpbase').children;
  assert.equal(options.length, 1);
  assert.match(options[0].textContent, /^commit aaaaaaaaaaaa, built /);
  await drawn(page);
  const asked = page.calls.filter((c) => c.body && c.body.name === 'pack_diff');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].body.project, 'beta');
  assert.match(asked[0].body.arguments.base_history, /^aaaaaaaaaaaa-[0-9a-f]{12}$/);
  const text = view(page).textContent;
  assert.match(text, /Removed nodes \(1\)/);
  assert.match(text, /endpoint:GET \/retired/);
  // The report reads from the top: the title, then the conditions, before any count.
  const title = text.indexOf('Change report: beta');
  const conditions = text.indexOf('Not every analysis condition is recorded');
  const summary = text.indexOf('Summary');
  assert.ok(title >= 0 && title < conditions && conditions < summary, 'title, then conditions, then the counts');
});

test('switching between two projects that both keep builds asks the new project with its OWN build', async (t) => {
  const page = await bootWith(t, { earlier: ['alpha', 'beta'], hash: '#p=beta&tab=compare' });
  await drawn(page);
  ev(page.ctx, "switchProject('alpha')");
  await drawn(page);
  const asked = page.calls.filter((c) => c.body && c.body.name === 'pack_diff');
  assert.deepEqual(asked.map((c) => c.body.project), ['beta', 'alpha'], 'one request per project, none with the old project\'s build');
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha');
});

test('switching to a project with no earlier build hides the tab and drops the old comparison', async (t) => {
  const page = await bootWith(t, { earlier: ['beta'], hash: '#p=beta&tab=compare' });
  await drawn(page);
  ev(page.ctx, "switchProject('alpha')");
  await settle(page.ctx);
  assert.equal(ev(page.ctx, 'CMP.resp'), null);
  assert.equal(tabButton(page).classList.contains('hidden'), true);
});

test('an answer for the old project that arrives after a switch is not drawn for the new one', async (t) => {
  let release;
  let held = false;
  const gate = new Promise((r) => { release = r; });
  const heldBeta = (_url, opts) => {
    const body = isPackDiff(opts);
    if (!(body && body.project === 'beta')) return null;
    held = true;
    return gate;
  };
  const page = await bootWith(t, { earlier: ['alpha', 'beta'], hash: '#p=beta&tab=compare', hold: heldBeta });
  for (let i = 0; i < 40 && !page.calls.some((c) => c.body && c.body.name === 'pack_diff'); i += 1) await settle(page.ctx, 1);
  assert.equal(held, true, 'the beta answer is on its way when the switch happens');
  ev(page.ctx, "switchProject('alpha')");
  await drawn(page);
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha');
  release();
  await settle(page.ctx, 5);
  assert.equal(ev(page.ctx, 'CMP.resp.basis.project'), 'alpha', 'the late beta answer was dropped');
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test('a changed attribute is shown before and after, a missing value is said to be missing, and a move is listed apart', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const text = view(page).textContent;
  assert.match(text, /Changed attributes \(3\)/);
  const tx = rowWith(page, 'symbol:com.g.GServiceImpl#load');
  assert.ok(tx, 'the symbol whose marker changed is a row');
  assert.match(tx.textContent, /transactional/);
  assert.match(tx.textContent, /true/);
  assert.match(tx.textContent, /\(not recorded\)/, 'a value the head does not record is said so, not printed as null');
  // The evidence the head lacks: the relation is the same, what it rests on is not.
  assert.match(text, /Changed evidence \(\d+\)/);
  const ev1 = rowWith(page, 'evidence.access');
  assert.ok(ev1, 'the edge whose evidence changed is a row');
  assert.match(ev1.textContent, /read/);
  assert.match(ev1.textContent, /records: base 1, head 1/);
  // The statement that only moved is under its own heading, with the line before and after, and not among the changed.
  assert.match(text, /Moved nodes \(1\)/);
  const moved = panelRows(page, 'Moved nodes (1)');
  assert.equal(moved.length, 1);
  assert.match(moved[0].textContent, /^statement:com\.g\.GMapper\.selectOrderline \(source location\)11→10$/, 'a location field is marked as one');
  assert.equal(panelRows(page, 'Changed attributes (3)').some((li) => li.textContent.startsWith('statement:')), false, 'a move is not a change');
  // A string keeps its quotes, so "null" and null, and an empty string, read as what they are.
  assert.match(rowWith(page, 'column:gamma_order.total').textContent, /comment"gamma \| money `x` <b>y<\/b>"→"gamma money"/);
  assert.ok(text.indexOf('Moved nodes (1)') > text.indexOf('Changed attributes (3)'), 'the moves come after the changes');
  assert.match(text, /Only the file, line or declaration position differs/);
  // The summary groups: content, relationships, evidence, source location only.
  assert.match(text, /Content: 0 node\(s\) added, 1 removed, 3 with a changed attribute/);
  assert.match(text, /Source location only: 1 node\(s\) and 0 edge\(s\) moved/);
  assert.match(text, /by kind: .*statement >1/);
  // What to check is drawn from the counts, and claims nothing more.
  assert.match(text, /Read the 3 changed attribute record\(s\) value by value/);
  assert.match(text, /1 record\(s\) moved in the source only/);
  assert.doesNotMatch(text, /risk score|safe to|coverage/i);
});

test('a hostile value is text on screen, and the Markdown file keeps it inside code it cannot break out of', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const col = rowWith(page, 'column:gamma_order.total');
  assert.ok(col.textContent.includes(HOSTILE), 'the comment is shown as it is');
  assert.equal(col.querySelectorAll('b').length, 0, 'and no element was made out of it');
  const tbl = rowWith(page, 'table:gamma_order');
  assert.equal(tbl.querySelectorAll('details').length, 1, 'a value with a line break sits behind a fold');
  assert.ok(tbl.querySelector('pre').textContent.includes(MULTILINE));
  // Save: the file is written from the answer on screen, through the page's own download.
  ev(page.ctx, 'var SAVED=null; snapshotSave=function(name, data, type){ SAVED={name, data, type}; };');
  view(page).querySelector('#cmpsave').onclick();
  const saved = ev(page.ctx, 'SAVED');
  assert.ok(saved, 'a file was handed to the download');
  assert.match(saved.name, /^cascade-compare-gamma-aaaaaaa-nocommit\.md$/);
  assert.equal(saved.type, 'text/markdown;charset=utf-8');
  const md = saved.data;
  assert.match(md, /^# Change report: `gamma`\n/, 'the project is data, so it is code even in the title');
  assert.ok(md.includes('- base: `commit ' + 'a'.repeat(40) + ', built '), 'the base is named with its whole commit');
  assert.match(md, /\n {2}- built at `2026-\S+`, with uncommitted changes `false`\n/, 'the build time as recorded');
  assert.ok(md.includes('- trust level: `UNCERTIFIED`'));
  assert.ok(md.includes('## Not every analysis condition is recorded'), 'the conditions come before the counts');
  assert.ok(md.indexOf('## Not every analysis condition') < md.indexOf('## Read before the counts'));
  assert.ok(md.indexOf('## Read before the counts') < md.indexOf('## Summary'));
  assert.ok(md.includes('- `pack-diff`: `not every analysis condition is recorded'), 'a limit is code, not prose');
  assert.ok(md.includes('``"' + HOSTILE + '"``'), 'a value with one backtick inside sits in a two-backtick span, quoted as the string it is');
  assert.ok(md.includes('  - `comment`:\n    - base: \n      ````\n      "first line\n      ```\n      <b>second</b>"\n      ````\n    - head: `"the orders table"`'),
    'a value with a line break is a fenced block of its own, one backtick longer than any run inside, and the other side is its own item');
  assert.equal(unclosedFence(md), false, 'every fence is closed on a line of its own');
  assert.equal(unclosedFence('    ````\n    x\n    ```` -> `y`\n## next'), true, 'the check itself sees a fence closed on a line that carries more');
  assert.ok(md.includes('- `transactional`: `true` -> (not recorded)'));
  assert.ok(md.includes('- `line` (source location): `11` -> `10`'));
  assert.ok(md.includes('## Rows not shown\n\nEvery row of every list is in this file.'));
  assert.ok(md.includes('`GET /retired` (earlier build only)'));
  assert.ok(md.includes('## What to check\n\n1. '));
  assert.ok(md.endsWith('no verdict on behavior or risk.\n'));
});

test('Flow is offered for an endpoint the head still has, and the one the earlier build alone had opens nothing', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const gone = rowWith(page, 'GET /retired');
  assert.ok(gone, 'the route the earlier build alone had is listed');
  assert.equal(gone.querySelectorAll('button').length, 0, 'and offers no Flow');
  assert.match(gone.textContent, /earlier build only/);
  const here = rows(page).find((li) => li.textContent.startsWith('GET /order/{id}'));
  assert.ok(here, 'the route above the changed symbol is listed');
  const flow = here.querySelector('button');
  assert.equal(flow.textContent, 'Flow');
  flow.onclick();
  await settle(page.ctx, 3);
  assert.equal(ev(page.ctx, 'STATE.tab'), 'flow');
  assert.equal(ev(page.ctx, 'JSON.stringify(FLOWV.pick)'), '{"kind":"endpoint","value":"GET /order/{id}"}');
});

test('print opens every fold and marks the page for the print sheet; the mark goes when printing ends', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  ev(page.ctx, 'var PRINTED=null; window.print=function(){ PRINTED={ marked:document.body.classList.contains("cmpprint"), open:[...document.body.querySelectorAll("details")].every((d)=> d.open===true) }; };');
  assert.ok(view(page).querySelectorAll('details').some((d) => !d.open), 'a fold starts closed');
  view(page).querySelector('#cmpprint').onclick();
  assert.equal(ev(page.ctx, 'JSON.stringify(PRINTED)'), '{"marked":true,"open":true}');
  page.fireWindow('afterprint');
  assert.equal(page.body.classList.contains('cmpprint'), false);
  assert.ok(view(page).querySelectorAll('details').some((d) => !d.open), 'the folds opened for the sheet are closed again');
});

test('print puts every loaded row on the sheet whatever the filter hides, and the filter comes back after', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const input = view(page).querySelector('#cmpfilter');
  input.value = 'retired';
  input.oninput();
  const hiddenNow = () => rows(page).filter((li) => li.classList.contains('hidden')).length;
  const wereHidden = hiddenNow();
  assert.ok(wereHidden > 0, 'the filter hides rows on screen');
  ev(page.ctx, 'var PRINTED=null; window.print=function(){ PRINTED=[...document.body.querySelectorAll("li.cmprow")].filter((li)=> li.classList.contains("hidden")).length; };');
  view(page).querySelector('#cmpprint').onclick();
  assert.equal(ev(page.ctx, 'PRINTED'), 0, 'no row is hidden while the sheet is printed');
  page.fireWindow('afterprint');
  assert.equal(hiddenNow(), wereHidden, 'the filter is back on screen');
});

test('while another base is being compared, a language switch shows the wait and not the old report; a refusal stays a refusal', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let heldId = null;
  const holdSecond = (_url, opts) => {
    const body = isPackDiff(opts);
    if (!body || body.arguments.base_history !== heldId) return null;
    return gate;
  };
  const page = await bootWith(t, {
    ids: ['gamma'], hash: '#p=gamma&tab=compare', hold: holdSecond,
    earlier: [{ id: 'gamma', mutate: gammaEarlier, commit: 'a'.repeat(40) }, { id: 'gamma', mutate: addRetired, commit: 'b'.repeat(40) }],
  });
  await drawn(page);
  const sel = page.byId.get('cmpbase');
  assert.equal(sel.children.length, 2, 'both earlier builds are offered');
  const firstId = page.calls.find((c) => c.body && c.body.name === 'pack_diff').body.arguments.base_history;
  const firstCommit = ev(page.ctx, 'CMP.resp.answer.base.commit');
  heldId = sel.children.find((o) => o.value !== firstId).value;
  sel.value = heldId;
  sel.onchange();
  await settle(page.ctx, 2);
  assert.equal(ev(page.ctx, 'CMP.resp'), null, 'the old base\'s answer went when the new comparison started');
  page.byId.get('langseg').children[1].onclick();   // -> ko, while the answer is on its way
  await settle(page.ctx, 2);
  assert.equal(view(page).textContent, '두 팩을 비교하는 중…', 'the wait, in the new language, and not the old report');
  release();
  await drawn(page);
  assert.notEqual(ev(page.ctx, 'CMP.resp.answer.base.commit'), firstCommit);
  assert.match(view(page).textContent, /변경 보고서: gamma/);
  // A refusal: the server's own sentence, kept through a language switch without asking again.
  const refused = await gammaPage(t, { rewrite: () => ({ error: { code: 'boom-code', message: 'boom message' } }) });
  await settle(refused.ctx, 8);
  assert.match(view(refused).textContent, /The comparison could not be made.*boom-code: boom message/);
  const calls = refused.calls.length;
  refused.byId.get('langseg').children[1].onclick();   // -> ko
  await settle(refused.ctx, 2);
  assert.match(view(refused).textContent, /비교하지 못했습니다.*boom-code: boom message/);
  assert.equal(refused.calls.length, calls, 'nothing was re-asked');
});

test('the filter hides the rows that do not carry the text, and every total stays whole', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const input = view(page).querySelector('#cmpfilter');
  input.value = 'retired';
  input.oninput();
  const all = rows(page);
  const carrying = all.filter((li) => li.textContent.includes('retired'));
  assert.ok(carrying.length >= 2 && carrying.length < all.length, 'some rows carry it, most do not');
  for (const li of all) assert.equal(li.classList.contains('hidden'), !li.textContent.includes('retired'));
  assert.match(view(page).querySelector('#cmpfiltern').textContent, new RegExp(`^${carrying.length} of ${all.length} rows carry the text$`));
  assert.match(view(page).textContent, /Changed attributes \(3\)/, 'the heading still counts every row');
  input.value = '';
  input.oninput();
  assert.equal(rows(page).filter((li) => li.classList.contains('hidden')).length, 0);
});

test('a language switch redraws the report in Korean from the answer in memory, asking the server nothing', async (t) => {
  const page = await gammaPage(t);
  await drawn(page);
  const before = page.calls.length;
  page.byId.get('langseg').children[1].onclick();   // -> ko
  await settle(page.ctx, 2);
  const text = view(page).textContent;
  assert.match(text, /변경 보고서: gamma/);
  assert.match(text, /속성이 바뀐 노드 \(3\)/);
  assert.match(text, /\(기록 없음\)/);
  assert.equal(page.calls.length, before, 'nothing was re-asked');
});

test('an answer from an older server, without attributes or evidence, is said so and never shown as zero', async (t) => {
  const legacy = (j) => {
    const a = j.answer;
    for (const k of ['changed', 'moved', 'changedList', 'movedList']) { delete a.nodes[k]; delete a.edges[k]; }
    delete a.comparisonVersion;
    delete a.endpointsTouched.rows;
    delete a.screensTouched.rows;
    j.truncated.fields = j.truncated.fields.filter((f) => !/\.(changed|moved)$/.test(f.field));
    return j;
  };
  const page = await gammaPage(t, { rewrite: legacy });
  await drawn(page);
  const text = view(page).textContent;
  assert.match(text, /This server compared ids and grades only/);
  assert.match(text, /Content: 0 node\(s\) added, 1 removed, not compared by this server with a changed attribute/);
  assert.match(text, /Source location only: not compared by this server/);
  assert.doesNotMatch(text, /Changed attributes|Moved nodes/);
  assert.match(text, /This server did not compare attributes or evidence/);
  // Without rows, Flow is offered only for an id the shown removed list does not name.
  assert.equal(rowWith(page, 'GET /retired').querySelectorAll('button').length, 0);
  assert.equal(rows(page).find((li) => li.textContent.startsWith('GET /order/{id}')).querySelectorAll('button').length, 1);
  // And when that removed list is cut, nothing is known of any id: no Flow at all, and said so.
  const cutRemoved = (j) => {
    legacy(j);
    j.answer.nodes.removed = j.answer.nodes.removedIds.length + 1;
    Object.assign(j.truncated.fields.find((f) => f.field === 'nodes.removed'), { shown: 1, total: 2, nextOffset: 1 });
    j.truncated.any = true;
    return j;
  };
  const unknown = await gammaPage(t, { rewrite: cutRemoved });
  await drawn(unknown);
  const ends = panelRows(unknown, 'Endpoints above the change');
  assert.ok(ends.length >= 2);
  assert.equal(ends.filter((li) => li.querySelectorAll('button').length).length, 0, 'no Flow button is inferred');
  assert.equal(ends.filter((li) => li.textContent.endsWith('not known to be in this build')).length, ends.length);
  ev(unknown.ctx, 'var SAVED=null; snapshotSave=function(name, data){ SAVED=data; };');
  view(unknown).querySelector('#cmpsave').onclick();
  assert.ok(ev(unknown.ctx, 'SAVED').includes('`GET /order/{id}` (not known to be in this build)'));
});

test('a cut list says how many rows it left out, on screen and in the file, and the totals stay whole', async (t) => {
  const cut = (j) => {
    const a = j.answer;
    a.nodes.changed = 3 + 2;
    a.nodes.changedList = a.nodes.changedList.slice(0, 1);
    const f = j.truncated.fields.find((x) => x.field === 'nodes.changed');
    Object.assign(f, { shown: 1, total: 5, nextOffset: 1 });
    j.truncated.any = true;
    return j;
  };
  const page = await gammaPage(t, { rewrite: cut });
  await drawn(page);
  const text = view(page).textContent;
  assert.match(text, /Read before the counts/);
  assert.match(text, /nodes\.changed: 1 of 5 rows are shown; the total is whole/);
  assert.match(text, /Changed attributes \(5\)/);
  assert.match(text, /4 more row\(s\) here did not fit/);
  assert.match(text, /A list is cut at the limit/);
  ev(page.ctx, 'var SAVED=null; snapshotSave=function(name, data){ SAVED=data; };');
  view(page).querySelector('#cmpsave').onclick();
  const md = ev(page.ctx, 'SAVED');
  assert.ok(md.includes('## Rows not shown\n\n- `nodes.changed`: 1 of 5 shown, in `kind, id asc` order'));
  assert.ok(md.includes('## Changed attributes (5)'));
  assert.ok(md.includes('4 more row(s) here did not fit'));
});

test('an edge whose evidence only points elsewhere in the source is a moved edge, said with its own note; a changed screen offers Flow', async (t) => {
  const deltaEarlier = (earlier) => {
    earlier.nodes.find((n) => n.id === 'screen:/rows').title = 'Old rows';
    earlier.edges.find((e) => e.type === 'CALLS_HTTP').evidence.file = 'old-session.har';
  };
  const page = await bootWith(t, { ids: ['delta'], earlier: ['delta'], mutate: deltaEarlier, hash: '#p=delta&tab=compare' });
  await drawn(page);
  const text = view(page).textContent;
  assert.match(text, /Moved edges \(1\)/);
  const moved = panelRows(page, 'Moved edges (1)');
  assert.equal(moved.length, 1);
  assert.match(moved[0].textContent, /^screen:\/rows → endpoint:GET \/rowsCALLS_HTTP \[har\]evidence\.file \(source location\)"old-session\.har"→"session\.har"records: base 1, head 1/);
  assert.match(text, /Only the source location fields of the evidence differ\. A grade change on the same relation/);
  assert.doesNotMatch(text, /compare\.[a-z.]+/, 'no catalogue key stands in for its text');
  assert.match(text, /Source location only: 0 node\(s\) and 1 edge\(s\) moved/);
  // The screen whose title changed is above its own change, in the head, so it opens on Flow.
  const screen = panelRows(page, 'Screens above the change (1)')[0];
  assert.match(screen.textContent, /^\/rowsFlow$/);
  screen.querySelector('button').onclick();
  await settle(page.ctx, 3);
  assert.equal(ev(page.ctx, 'STATE.tab'), 'flow');
  assert.equal(ev(page.ctx, 'JSON.stringify(FLOWV.pick)'), '{"kind":"screen","value":"/rows"}');
  ev(page.ctx, 'var SAVED=null; snapshotSave=function(name, data){ SAVED=data; };');
  ev(page.ctx, 'downloadCompare()');
  const md = ev(page.ctx, 'SAVED');
  assert.ok(md.includes('## Moved edges (1)\n\nOnly the source location fields of the evidence differ.'));
  assert.ok(md.includes('- `evidence.file` (source location): `"old-session.har"` -> `"session.har"`'));
});

test('the answer\'s basis and trust travel with the report: a fold on screen, open on the sheet, a fenced appendix in the file', async (t) => {
  const GAP = 'gap-marker <b>x</b> | `y`';
  const marker = (j) => { j.trust.knownGaps = [GAP]; j.basis.marker = 'basis-marker'; return j; };
  const page = await gammaPage(t, { rewrite: marker });
  await drawn(page);
  const meta = view(page).querySelector('#cmpmeta');
  assert.ok(meta, 'the metadata fold is there');
  assert.ok(!meta.open, 'closed on screen');
  const pre = meta.querySelector('pre').textContent;
  assert.ok(pre.includes(JSON.stringify(GAP)) && pre.includes('"marker": "basis-marker"'), 'basis and trust, exact');
  assert.ok(pre.includes('"trustLevel": "UNCERTIFIED"'));
  assert.equal(meta.querySelectorAll('b').length, 0, 'text, never markup');
  ev(page.ctx, 'var PRINTED=null; window.print=function(){ PRINTED=document.body.querySelector("#cmpmeta").open===true; };');
  view(page).querySelector('#cmpprint').onclick();
  assert.equal(ev(page.ctx, 'PRINTED'), true, 'open on the sheet');
  page.fireWindow('afterprint');
  ev(page.ctx, 'var SAVED=null; snapshotSave=function(name, data){ SAVED=data; };');
  ev(page.ctx, 'downloadCompare()');
  const md = ev(page.ctx, 'SAVED');
  const appendix = md.indexOf('## Answer metadata: basis and trust, as the engine gave them');
  assert.ok(appendix > md.indexOf('## Rows not shown'), 'an appendix after the rows not shown');
  assert.ok(md.slice(appendix).includes('  "knownGaps": [\n   ' + JSON.stringify(GAP)), 'the marker survives inside the fence');
  assert.ok(md.slice(appendix).includes('"marker": "basis-marker"'));
  assert.equal(unclosedFence(md), false);
});

test('the empty states are told apart: the same pack, and a move in the source only', async (t) => {
  const same = await bootWith(t, { ids: ['beta'], earlier: ['beta'], mutate: () => {}, hash: '#p=beta&tab=compare' });
  await drawn(same);
  assert.match(view(same).textContent, /The base and the head are the same pack/);
  assert.match(view(same).textContent, /Read the conditions above before taking this as no change/);
  assert.equal(rows(same).length, 0);
  const movedOnly = (earlier) => { earlier.nodes.find((n) => n.id === 'statement:betaMapper.selectByPrimaryKey').line = 31; };
  const moved = await bootWith(t, { ids: ['beta'], earlier: ['beta'], mutate: movedOnly, hash: '#p=beta&tab=compare' });
  await drawn(moved);
  const text = view(moved).textContent;
  assert.match(text, /Only source locations differ: 1 node\(s\) and 0 edge\(s\) moved and mean the same/);
  assert.match(text, /Moved nodes \(1\)/);
  assert.doesNotMatch(text, /Changed attributes|Endpoints above/);
});
