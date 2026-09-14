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

test('the Overview opens the summary only when asked, then draws a box per group and lists a group\'s routes with Flow', async (t) => {
  const { html, base } = await startViewer(t, ['gamma']);
  const page = await boot({ html, origin: base, answer: (url, opts) => fetch(base + url, opts) });
  const asked = () => page.calls.filter((c) => c.body && c.body.name === 'summary').length;
  assert.equal(asked(), 0, 'a closed fold asks nothing');
  const lead = page.byId.get('ovsummary').querySelector('.foldlead');
  lead.onclick();
  for (let i = 0; i < 40 && !ev(page.ctx, 'SUM.resp'); i += 1) await settle(page.ctx, 1);
  assert.equal(asked(), 1);
  const boxes = page.byId.get('ovsummary').querySelectorAll('.sumbox');
  assert.ok(boxes.length >= 2, 'a box per group and per family');
  boxes[0].onclick();
  const detail = page.byId.get('ovsummary').textContent;
  assert.match(detail, /Flow/);
  assert.equal(asked(), 1, 'opening a box asks nothing more');
});
