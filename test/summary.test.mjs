// summary.test.mjs — the whole pack in a dozen boxes, and the rules that made the boxes.
//
// A summary is only useful if its boxes mean something and only honest if it
// says how they were made. So the rules are checked on the shapes the corpus
// measured (a shared package root, a lopsided root with a few strays beside it,
// one package for every handler, table names with and without underscores), the
// fold of the smaller boxes is checked to lose nothing the walk reached, and the
// tool is checked to say which rule it used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { OTHERS, buildSummary, descendGroups, familyRule } from '../src/core/summary.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { bootPage as boot, ev, settle } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const items = (...keys) => keys.map((k) => ({ key: k, tokens: k.split('.') }));

test('the descent passes every level one branch holds, and a branch left behind is a group named by what it shares', () => {
  const d = descendGroups(items(
    'org.jeecg.modules.system.a', 'org.jeecg.modules.system.b', 'org.jeecg.modules.airag.c', 'org.jeecg.modules.demo.d',
    'org.jeecg.modules.system.e', 'org.jeecg.modules.demo.f', 'org.jeecg.modules.api.g', 'org.jeecg.modules.api.h', 'org.jeecg.modules.api.i',
    'com.xkcoding.x',
  ), { sep: '.', wide: 20 });
  assert.deepEqual(d.prefix, ['org', 'jeecg', 'modules']);
  assert.equal(d.groupOf.get('org.jeecg.modules.system.a'), 'system');
  assert.equal(d.groupOf.get('com.xkcoding.x'), 'com.xkcoding.x', 'the stray is its own group, named in full');
  // Nothing past 80%: the tree splits at the top.
  const flat = descendGroups(items('a.x', 'a.y', 'b.x', 'b.y'), { sep: '.', wide: 20 });
  assert.deepEqual(flat.prefix, []);
  assert.deepEqual([...new Set(flat.groupOf.values())].sort(), ['a', 'b']);
});

test('table families split by words when the names have underscores, by letters when they do not', () => {
  const words = familyRule(['table:t_ds_task_a', 'table:t_ds_task_b', 'table:t_ds_process_a', 'table:t_ds_user', 'table:qrtz_jobs']);
  assert.deepEqual(words.rule, { kind: 'name-words', separator: '_', commonPrefix: 't_ds' });
  assert.equal(words.familyOf.get('table:t_ds_task_a'), 'task');
  assert.equal(words.familyOf.get('table:qrtz_jobs'), 'qrtz_jobs');
  const letters = familyRule(['table:COMTNBBS', 'table:COMTNUSER', 'table:COMTNLOG', 'table:COMTNMENU', 'table:COMTHLOG', 'table:COMTCCODE']);
  assert.equal(letters.rule.kind, 'name-letters');
  assert.equal(letters.familyOf.get('table:COMTHLOG'), 'comthlog');
});

/** A pack of routes under two code areas and one stray, reaching tables of two families. */
function pack({ strays = 1 } = {}) {
  const g = new Graph();
  let n = 0;
  const route = (pkg, table, grade = 'EXACT') => {
    n += 1;
    const ep = nodeId('endpoint', `GET /r${n}`);
    const h = nodeId('symbol', `${pkg}.C${n}#m`);
    const st = nodeId('statement', `ns.s${n}`);
    g.addNode({ id: ep, path: `/r${n}`, httpMethod: 'GET' });
    g.addNode({ id: h, owner: `${pkg}.C${n}` });
    g.addNode({ id: st });
    if (!g.nodes.has(nodeId('table', table))) g.addNode({ id: nodeId('table', table) });
    g.addEdge({ from: ep, to: h, type: 'HANDLES', grade: 'EXACT' });
    g.addEdge({ from: h, to: st, type: 'IMPLEMENTS_STMT', grade });
    g.addEdge({ from: st, to: nodeId('table', table), type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  };
  for (let i = 0; i < 6; i += 1) route('com.acme.shop.order.web', i % 2 ? 'oms_order' : 'oms_item');
  for (let i = 0; i < 4; i += 1) route('com.acme.shop.product.web', 'pms_product', 'SOUND_SET');
  route('com.acme.shop.product.web', 'oms_order', 'SOUND_SET');
  for (let i = 0; i < strays; i += 1) route(`com.acme.shop.x${i}.web`, `z${i}_log`);
  return g;
}

test('routes group by where their code sits, and every link carries its tables, routes and weakest grade', () => {
  const s = buildSummary(pack());
  assert.deepEqual(s.rule.groups, { kind: 'code-path', commonPrefix: 'com.acme.shop' });
  assert.deepEqual(s.groups.map((x) => [x.name, x.endpoints.length, x.tables]), [['order', 6, 2], ['product', 5, 2], ['x0', 1, 1]]);
  const link = s.links.find((l) => l.group === 'product' && l.family === 'oms');
  assert.deepEqual(link, { group: 'product', family: 'oms', tables: 1, endpoints: 1, grade: 'SOUND_SET' });
  assert.equal(s.lopsided, null);
});

test('boxes past the limit fold into one, and their links go to it: nothing the walk reached is dropped', () => {
  const s = buildSummary(pack({ strays: 4 }), { limit: 2 });
  assert.equal(s.groups.length, 2);
  assert.equal(s.otherGroups.groups, 4);
  const reachedBefore = buildSummary(pack({ strays: 4 }), { limit: 30 });
  const count = (x) => x.groups.reduce((n, g) => n + g.endpoints.length, 0) + x.otherGroups.endpoints.length;
  assert.equal(count(s), count(reachedBefore));
  assert.ok(s.links.some((l) => l.group === OTHERS), 'the folded groups keep their links');
});

test('the summary tool says which rule made the boxes, and a declared package depth replaces the guess', () => {
  const basis = { project: 'p', buildDigest: 'x', builtAt: null, freshness: { verdict: 'unknown' } };
  const r = callTool('summary', {}, { graph: pack(), basis, trust: {}, limits: [] });
  assertContract(r);
  assert.match(r.limits.find((l) => l.scope === 'summary:groups').reason, /where the handler code sits, read below the package every handler shares \(com\.acme\.shop\)/);
  assert.match(r.limits.find((l) => l.scope === 'summary:families').reason, /start with the same word/);
  const declared = callTool('summary', {}, { graph: pack(), basis, trust: {}, limits: [], profile: { moduleAttribution: { packageDepth: 4 } } });
  assert.equal(declared.answer.rule.groups.kind, 'declared');
  assert.match(declared.limits.find((l) => l.scope === 'summary:groups').reason, /cut to 4 segment\(s\), as the profile declares/);
  assert.throws(() => callTool('summary', { limit: 99 }, { graph: pack(), basis, trust: {}, limits: [] }), (e) => e.code === 'bad-input');
});

test('the paths through one route: the families it reaches, each with its tables and the weakest grade on the way', () => {
  // The product group's fifth route reaches oms_order through a SOUND_SET link,
  // so its one line runs to the oms family, and no line runs to pms.
  const s = buildSummary(pack(), { through: 'endpoint:GET /r11' });
  assert.deepEqual(s.through, { node: 'endpoint:GET /r11', group: 'product',
    links: [{ family: 'oms', tables: ['table:oms_order'], grade: 'SOUND_SET' }] });
  const order = buildSummary(pack(), { through: 'endpoint:GET /r1' });
  assert.deepEqual(order.through.links, [{ family: 'oms', tables: ['table:oms_item'], grade: 'EXACT' }]);
});

test('the paths through one table: the groups whose routes reach it, each with those routes, folded boxes included', () => {
  const s = buildSummary(pack(), { through: 'table:oms_order' });
  assert.equal(s.through.family, 'oms');
  assert.deepEqual(s.through.links.map((l) => [l.group, l.endpoints.length, l.grade]), [['order', 3, 'EXACT'], ['product', 1, 'SOUND_SET']]);
  // With one box a side, the product group is folded, and its line runs from `(others)`.
  const folded = buildSummary(pack(), { through: 'table:oms_order', limit: 1 });
  assert.deepEqual(folded.through.links.map((l) => l.group), [OTHERS, 'order']);
  // Every line the node has is a line the boxes have: none is drawn that the summary does not carry.
  for (const l of folded.through.links) assert.ok(folded.links.some((x) => x.group === l.group && x.family === folded.through.family));
});

test('a node nothing runs through has no line and no box; a name the pack does not hold is refused', () => {
  const g = pack();
  g.addNode({ id: nodeId('table', 'lonely') });
  assert.deepEqual(buildSummary(g, { through: 'table:lonely' }).through, { node: 'table:lonely', family: null, links: [] });
  const basis = { project: 'p', buildDigest: 'x', builtAt: null, freshness: { verdict: 'unknown' } };
  const ctx = { graph: g, basis, trust: {}, limits: [] };
  const r = callTool('summary', { table: 'oms_order' }, ctx);
  assertContract(r);
  assert.equal(r.answer.through.node, 'table:oms_order');
  assert.equal(callTool('summary', {}, ctx).answer.through, undefined, 'no node named, no paths carried');
  assert.throws(() => callTool('summary', { table: 'nope' }, ctx), (e) => e.code === 'unknown-node');
  assert.throws(() => callTool('summary', { table: 'oms_order', endpoint: 'GET /r1' }, ctx), (e) => e.code === 'bad-input');
});

test('Start asks for the summary once it is on screen, opens a box in place and keeps its lines, and a route in it asks for its own paths', async (t) => {
  // The map on Start (RM67-U2c) is asked for once Start is on screen, which is
  // where a page with no link lands; a page that lands on Trace never asks it.
  const { html, base } = await startViewer(t, ['gamma']);
  const onTrace = await boot({ html, hash: '#p=gamma&tab=trace', origin: base, answer: (url, opts) => fetch(base + url, opts) });
  await settle(onTrace.ctx, 4);
  assert.equal(onTrace.calls.filter((c) => c.body && c.body.name === 'summary').length, 0, 'a page on Trace asks nothing');

  const page = await boot({ html, origin: base, answer: (url, opts) => fetch(base + url, opts) });
  const summaries = () => page.calls.filter((c) => c.body && c.body.name === 'summary');
  const asked = () => summaries().length;
  assert.equal(ev(page.ctx, 'STATE.tab'), 'start');
  for (let i = 0; i < 40 && !ev(page.ctx, 'SUM.resp'); i += 1) await settle(page.ctx, 1);
  assert.equal(asked(), 1, 'Start on screen asks once');
  const host = page.byId.get('ovsummary');
  const heads = host.querySelectorAll('.sumbox button.sumhead');
  assert.ok(heads.length >= 2, 'a box per group and per family');
  await settle(page.ctx, 4);
  const paths = () => host.querySelectorAll('svg.sumlinks path');
  const all = paths().length;

  // In this pack every line leaves the one group, so a family box is what shows
  // the picture dropping the lines that do not run through the open box.
  const fam = host.querySelectorAll('.sumcol')[1].querySelector('button.sumhead');
  const family = fam.querySelector('.sumname').textContent;
  fam.onclick();
  await settle(page.ctx, 4);
  assert.ok(paths().length > 0 && paths().length < all, `${paths().length} of ${all} lines`);
  for (const l of paths()) assert.equal(l.getAttribute('data-family'), family);
  host.querySelectorAll('.sumcol')[1].querySelector('button.sumhead').onclick();
  await settle(page.ctx, 4);
  assert.equal(paths().length, all, 'closed again, every line is back');

  // A box opens IN PLACE, and the picture keeps only the lines through it.
  const name = heads[0].querySelector('.sumname').textContent;
  heads[0].onclick();
  await settle(page.ctx, 4);
  const box = host.querySelectorAll('.sumcol')[0].querySelectorAll('.sumbox').find((b) => b.querySelector('.sumname').textContent === name);
  assert.ok(box.classList.contains('open'), 'the box is open where it stands');
  const rows = box.querySelectorAll('button.sumrow');
  assert.ok(rows.length > 0, 'and lists what it holds');
  const lines = paths();
  assert.ok(lines.length > 0, 'the open box keeps its lines');
  for (const l of lines) assert.equal(l.getAttribute('data-group'), name, 'and only its lines');
  assert.equal(asked(), 1, 'opening a box asks nothing more');

  // A route inside it asks for the paths through that route alone.
  rows[0].onclick();
  for (let i = 0; i < 40 && asked() < 2; i += 1) await settle(page.ctx, 1);
  await settle(page.ctx, 4);
  assert.equal(asked(), 2, 'one more question, for that route');
  assert.equal('endpoint:' + summaries()[1].body.arguments.endpoint, ev(page.ctx, 'SUM.node'), 'naming the route it was asked about');
  // Each route opens on Trace, walked down: the button says what it asks (RM67-U2b).
  const side = host.querySelector('.flowside');
  assert.ok(side.querySelectorAll('button').some((b) => b.textContent === 'What it uses'), side.textContent);
});
