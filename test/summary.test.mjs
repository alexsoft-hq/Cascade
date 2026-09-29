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
import { JOIN_TABLES, OTHERS, buildSummary, descendGroups, familyRule, nameWords } from '../src/core/summary.mjs';
import { readPrismaSchema } from '../src/adapters/ts/prisma_schema.mjs';
import { addPrismaCatalog } from '../src/adapters/ts/prisma_catalog.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { bootPage as boot, ev, settle } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { skipUnlessMall, mallGraph } from './helpers/mall_fixture.mjs';

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

test('table families split by words, and by letters where most names are one word and most start with the same letters', () => {
  const words = familyRule(['table:t_ds_task_a', 'table:t_ds_task_b', 'table:t_ds_process_a', 'table:t_ds_user', 'table:qrtz_jobs']);
  assert.deepEqual(words.rule, { kind: 'name-words', separator: '_', commonPrefix: 't_ds' });
  assert.equal(words.familyOf.get('table:t_ds_task_a'), 'task');
  assert.equal(words.familyOf.get('table:qrtz_jobs'), 'qrtz_jobs');
  const letters = familyRule(['table:COMTNBBS', 'table:COMTNUSER', 'table:COMTNLOG', 'table:COMTNMENU', 'table:COMTHLOG', 'table:COMTCCODE']);
  assert.equal(letters.rule.kind, 'name-letters');
  assert.equal(letters.familyOf.get('table:COMTHLOG'), 'comthlog');
  assert.equal(letters.familyOf.get('table:COMTNUSER'), 'comtn', 'the eGovFrame tables that share COMTN are one family');
});

/** Each table's family, by bare name. */
const familiesOf = (names, opts) => {
  const r = familyRule(names.map((n) => `table:${n}`), opts);
  return { rule: r.rule, of: (n) => r.familyOf.get(`table:${n}`) };
};

test('a name is read as words however it is written: snake, kebab, camel, Pascal and UPPER_SNAKE', () => {
  assert.deepEqual(nameWords('SymbolProfileOverrides'), ['symbol', 'profile', 'overrides']);
  assert.deepEqual(nameWords('assetProfileSplit'), ['asset', 'profile', 'split']);
  assert.deepEqual(nameWords('market-data'), ['market', 'data']);
  assert.deepEqual(nameWords('MARKET_QUOTE'), ['market', 'quote']);
  assert.deepEqual(nameWords('HTTPRequestLog'), ['http', 'request', 'log'], 'a run of capitals is one word, up to the next word\'s capital');
  assert.deepEqual(nameWords('oauth2Client'), ['oauth2', 'client'], 'a digit stays with the word before it');
  assert.deepEqual(nameWords('yudao_demo01_contact'), ['yudao', 'demo01', 'contact']);
  assert.deepEqual(nameWords('_OrderToTag'), ['order', 'to', 'tag'], 'a leading underscore is a marker, not a word');
  assert.deepEqual(nameWords('__subst__'), ['subst']);
  assert.deepEqual(nameWords('COMTNBBS'), ['comtnbbs'], 'capitals with nothing between them are one word');
  // ghostfolio's Prisma models once made the families "a", "s" and "_".
  const f = familiesOf(['Access', 'Account', 'AccountBalance', 'SymbolProfile', 'SymbolProfileOverrides', 'AssetProfileSplit',
    'assetProfileResolution', 'market-data', 'MARKET_QUOTE', 'Order']);
  assert.equal(f.rule.kind, 'name-words');
  assert.deepEqual(['Account', 'AccountBalance', 'SymbolProfile', 'SymbolProfileOverrides', 'AssetProfileSplit', 'assetProfileResolution', 'market-data', 'MARKET_QUOTE', 'Access', 'Order'].map(f.of),
    ['account', 'account', 'symbol', 'symbol', 'asset', 'asset', 'market', 'market', 'access', 'order']);
});

test('names of one word each are words too, unless most of them start with the same letters', () => {
  // nestjs-boilerplate once had a family "s" for session and status, and the
  // petclinic a family "v" for vets, visits and vet_specialties.
  const boiler = familiesOf(['user', 'role', 'status', 'session', 'file']);
  assert.equal(boiler.rule.kind, 'name-words');
  assert.deepEqual(['status', 'session', 'user'].map(boiler.of), ['status', 'session', 'user']);
  const clinic = familiesOf(['owners', 'pets', 'specialties', 'types', 'vet_specialties', 'vets', 'visits']);
  assert.deepEqual(['vets', 'visits', 'vet_specialties'].map(clinic.of), ['vets', 'visits', 'vet']);
});

test('snake_case families stay as they were: mall\'s module prefixes and jeecg-boot\'s', () => {
  const mall = familiesOf(['pms_product', 'pms_brand', 'oms_order', 'oms_order_item', 'sms_coupon', 'cms_subject', 'cms_prefrence_area_product_relation', 'ums_admin', 'ums_role']);
  assert.deepEqual(mall.rule, { kind: 'name-words', separator: '_', commonPrefix: '' });
  assert.deepEqual(['pms_product', 'oms_order_item', 'sms_coupon', 'cms_prefrence_area_product_relation', 'ums_role'].map(mall.of), ['pms', 'oms', 'sms', 'cms', 'ums']);
  const jeecg = familiesOf(['sys_user', 'sys_role', 'sys_user_role', 'onl_cgform_head', 'onl_cgform_field', 'jmreport_big_screen', 'jmreport_data_source', 'p_order', '__subst__', 'demo']);
  assert.deepEqual(['sys_user_role', 'onl_cgform_field', 'jmreport_big_screen', 'p_order', '__subst__', 'demo'].map(jeecg.of), ['sys', 'onl', 'jmreport', 'p', 'subst', 'demo']);
});

test('the pinned mall pack keeps its five families, pms oms sms cms ums, with every table it had', { skip: skipUnlessMall() }, () => {
  const s = buildSummary(mallGraph(), { limit: 30 });
  assert.deepEqual(s.rule.tables, { kind: 'name-words', separator: '_', commonPrefix: '' });
  // The five and their tables; the order is how many routes reach each (RM67-U2d), not what this test is about.
  assert.deepEqual(s.families.map((f) => [f.name, f.tables.length]).sort(), [['cms', 4], ['oms', 8], ['pms', 12], ['sms', 12], ['ums', 13]]);
});

/**
 * A Prisma project's catalog, as the TypeScript lane makes it, with one route
 * reading each table. `_OrderToTag` joins two families, `_UserWatchlist` (a
 * named relation) too, and `_AccountToAccountTag` joins two tables of one.
 */
function prismaPack() {
  const g = new Graph();
  addPrismaCatalog(g, readPrismaSchema([
    'model Account {', '  id String @id', '  tags AccountTag[]', '  balances AccountBalance[]', '  orders Order[]', '}',
    'model AccountBalance {', '  id String @id', '  accountId String', '  account Account @relation(fields: [accountId], references: [id])', '}',
    'model AccountTag {', '  id String @id', '  accounts Account[]', '}',
    'model Order {', '  id String @id', '  tags Tag[]', '  accountId String', '  account Account @relation(fields: [accountId], references: [id])', '}',
    'model Tag {', '  id String @id', '  activities Order[]', '}',
    'model SymbolProfile {', '  id String @id', '  watchedBy User[] @relation("UserWatchlist")', '}',
    'model SymbolProfileOverrides {', '  symbolProfileId String @id', '}',
    'model User {', '  id String @id', '  watchlist SymbolProfile[] @relation("UserWatchlist")', '}',
    'model Audit {', '  id String @id', '  userId String', '  @@map("_audit")', '}',
  ].join('\n')));
  const tables = [...g.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id);
  // The SQL lane's placeholder for a `${}` table: a leading underscore and nothing Prisma made.
  tables.push(nodeId('table', '__subst__'));
  tables.forEach((t, i) => {
    const ep = nodeId('endpoint', `GET /r${i}`);
    const h = nodeId('symbol', `com.acme.web.C${i}#m`);
    const st = nodeId('statement', `ns.s${i}`);
    g.addNode({ id: ep, path: `/r${i}`, httpMethod: 'GET' });
    g.addNode({ id: h, owner: `com.acme.web.C${i}` });
    g.addNode({ id: st });
    g.addEdge({ from: ep, to: h, type: 'HANDLES', grade: 'EXACT' });
    g.addEdge({ from: h, to: st, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    g.addEdge({ from: st, to: t, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  });
  return g;
}

test('a table Prisma makes for a many-to-many goes with the tables it joins, or into a family named for what it is', () => {
  const s = buildSummary(prismaPack(), { limit: 30 });
  const fam = new Map(s.families.flatMap((f) => f.tables.map((t) => [t.slice('table:'.length), f.name])));
  assert.equal(s.rule.tables.kind, 'name-words');
  assert.deepEqual(['Account', 'AccountBalance', 'AccountTag', '_AccountToAccountTag'].map((t) => fam.get(t)), ['account', 'account', 'account', 'account'],
    'both tables it joins are in account');
  assert.deepEqual(['_OrderToTag', '_UserWatchlist'].map((t) => fam.get(t)), [JOIN_TABLES, JOIN_TABLES], 'the tables they join are in two families');
  assert.deepEqual(['SymbolProfile', 'SymbolProfileOverrides', 'Order', 'Tag', 'User'].map((t) => fam.get(t)), ['symbol', 'symbol', 'order', 'tag', 'user']);
  assert.equal(fam.get('_audit'), 'audit', 'a leading underscore alone does not make a join table');
  assert.equal(fam.get('__subst__'), 'subst');
  assert.ok(![...fam.values()].some((f) => f.length === 1 || f === '_'), 'no family is a letter');
  assert.deepEqual(s.rule.tables.joinTables, { rules: ['prisma.relation-tables'], tables: 3 });
  // The convention is the rule pack's: with no rule, the same tables are read by their words.
  const bare = buildSummary(prismaPack(), { limit: 30, joinRules: [] });
  assert.equal(bare.families.find((f) => f.tables.includes('table:_OrderToTag')).name, 'order');
  assert.equal(bare.rule.tables.joinTables, undefined);
});

test('the summary tool says how a name is read into words, and which rule placed the join tables', () => {
  const basis = { project: 'p', buildDigest: 'x', builtAt: null, freshness: { verdict: 'unknown' } };
  const r = callTool('summary', { mode: 'strict' }, { graph: prismaPack(), basis, trust: {}, limits: [] });
  assertContract(r);
  const reason = r.limits.find((l) => l.scope === 'summary:families').reason;
  assert.match(reason, /a word ends at an underscore, a hyphen or a change of case/);
  assert.match(reason, /3 table\(s\) named as a join table by prisma\.relation-tables go with the tables they join where those sit in one family, and into \(join tables\) where they do not/);
  assert.match(reason, /It is a naming pattern, not a schema$/);
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
  assert.ok(side.querySelectorAll('button').some((b) => b.textContent === '↓ What it uses'), side.textContent);
});
