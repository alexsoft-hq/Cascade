// families_one_rule.test.mjs — one family rule for the map and the ERD, and a fold that keeps what the code touches (RM67-U2d).
//
// The map on Start read table names into families with `familyRule`
// (src/core/summary.mjs); the ERD coloured and listed them by an older rule of
// its own, the name's first token before an underscore, which gave ghostfolio's
// Prisma models (Account, SymbolProfile) no family at all and jeecg's
// `__subst__` none either. Now the engine reads the family of every table in the
// pack once, both answers carry it, and the page draws what they say.
//
// The map kept ten families by size then name, so on ghostfolio, where most
// families hold one table, user and tag fell into "(others)" behind families no
// route reaches more. A family is now kept for how many routes reach it, then its
// size, and the folded box says that is what it folded by.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { buildSummary, tableFamilies } from '../src/core/summary.mjs';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

/**
 * Routes onto handlers in two packages, reaching Prisma-style tables: one route
 * reaches the three Order tables, three routes reach User, three reach Tag, and
 * Account is joined to User but no route reaches it.
 */
function pack() {
  const g = new Graph();
  const route = (verb, path, pkg, tables) => {
    const ep = `endpoint:${verb} ${path}`;
    const h = `symbol:com.acme.${pkg}.web.C#${verb.toLowerCase()}${path.replace(/\W/g, '_')}`;
    g.addNode({ id: ep, path, httpMethod: verb, handler: h });
    g.addNode({ id: h, file: `${pkg}.java` });
    g.addEdge({ from: ep, to: h, type: 'HANDLES', grade: 'EXACT' });
    const st = `statement:${pkg}${path}`;
    g.addNode({ id: st, statementType: 'select' });
    g.addEdge({ from: h, to: st, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
    for (const t of tables) g.addEdge({ from: st, to: `table:${t}`, type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  };
  for (const t of ['Order', 'OrderItem', 'OrderLine', 'User', 'Tag', 'Account']) g.addNode({ id: `table:${t}`, kind: 'table' });
  route('GET', '/order', 'shop', ['Order', 'OrderItem', 'OrderLine']);
  for (const p of ['/user/a', '/user/b', '/user/c']) route('GET', p, 'people', ['User']);
  for (const p of ['/tag/a', '/tag/b', '/tag/c']) route('GET', p, 'shop', ['Tag']);
  g.addEdge({ from: 'table:User', to: 'table:Account', type: 'JOINS', grade: 'EXACT', evidence: { columns: ['id'], count: 1 } });
  return g;
}
const basis = { project: 'p', buildDigest: 'x', builtAt: null, freshness: { verdict: 'unknown' } };
const ask = (name, args = {}) => callTool(name, args, { graph: pack(), basis, trust: {}, limits: [] });

test('the ERD answer carries each table\'s family, by the one rule the map reads, for tables no route reaches too', () => {
  const erd = ask('erd').answer;
  const byTable = Object.fromEntries(erd.tables.map((t) => [t.table, t.family]));
  assert.deepEqual(byTable, { Account: 'account', Order: 'order', OrderItem: 'order', OrderLine: 'order', Tag: 'tag', User: 'user' },
    'a name with no underscore has a family: its first word');
  assert.equal(erd.familyRule.kind, 'name-words');
  const summary = ask('summary', { mode: 'heuristic' }).answer;
  for (const f of [...summary.families]) for (const t of f.tables) assert.equal(byTable[t.slice(6)], f.name, `${t} is in one family on both`);
  // The family of a table is the pack's, not the walk's: a mode that reaches
  // fewer tables does not rename the ones it does reach.
  const fam = tableFamilies(pack());
  assert.equal(fam.familyOf.get('table:Account'), 'account');
});

test('a family is kept for the routes that reach it, then its size, and the fold says so', () => {
  // Order holds three tables and one route reaches it; User and Tag hold one
  // each and three routes reach each. By size, a limit of two kept order.
  const s = buildSummary(pack(), { limit: 2 });
  assert.deepEqual(s.families.map((f) => [f.name, f.routes, f.tables.length]), [['tag', 3, 1], ['user', 3, 1]]);
  assert.deepEqual(s.otherFamilies.names, ['order']);
  const tool = ask('summary', { limit: 2 });
  assert.equal(tool.truncated.fields.find((f) => f.field === 'families').order, 'routes desc, tables desc, name asc');
  assert.match(tool.limits.find((l) => l.scope === 'summary:families').reason, /read over every table of the pack, so a table is in the same family on the ERD and in every mode/);
  // Groups are still kept for the routes they hold.
  assert.deepEqual(s.groups.map((g) => g.name), ['shop', 'people']);
});

// ---------------------------------------------------------------------------
// on the page
// ---------------------------------------------------------------------------

test('the ERD legend lists the families the answer names, not the old name prefix', async (t) => {
  const { html, base } = await startViewer(t, ['gamma', 'delta']);
  const answer = async (url, opts) => fetch(base + url, opts);
  const { ctx, byId } = await bootPage({ html, hash: '#p=gamma&tab=erd', origin: base, answer });
  await settle(ctx, 20);
  // gamma's tables all start with gamma_, so the old prefix made one family of
  // them all; the rule reads below the shared word, as the map does.
  const legend = byId.get('erdleg').textContent;
  assert.match(legend, /table families:/);
  assert.doesNotMatch(legend, /gamma \d/, 'no family named for the prefix every table shares');
  const fams = JSON.parse(ev(ctx, 'JSON.stringify(erdData.tables.map((x)=>[x.table, x.family]))'));
  assert.deepEqual(fams, [['gamma_audit', 'audit'], ['gamma_item', 'item'], ['gamma_order', 'order']]);
  for (const [, f] of fams) assert.match(legend, new RegExp(`${f} 1`));
  assert.equal(ev(ctx, "ERD.familyOf('gamma_item')"), 'item');
  // The same tables on the map are in the same families.
  ev(ctx, "activateTab('start')");
  await settle(ctx, 12);
  const mapFams = JSON.parse(ev(ctx, 'JSON.stringify(SUM.resp.answer.families.map((f)=>[f.name, f.tables]))'));
  for (const [name, tables] of mapFams) for (const tb of tables) assert.equal(ev(ctx, `ERD.familyOf(${JSON.stringify(tb.slice(6))})`), name);
  // An answer from a server that names no family falls back to the prefix, as the ERD always read it.
  assert.equal(ev(ctx, "erdFamilyOf({tables:[{table:'pms_product'}]})('pms_product')"), 'pms');
});

test('the map says what a family box and the folded box are counted by', async (t) => {
  const { html, base } = await startViewer(t, ['gamma', 'delta']);
  const answer = async (url, opts) => fetch(base + url, opts);
  const { ctx, byId } = await bootPage({ html, hash: '#p=gamma', origin: base, answer });
  await settle(ctx, 20);
  const heads = byId.get('ovsummary').querySelectorAll('.sumhead').map((h) => h.textContent);
  assert.ok(heads.includes('order1 table(s), 2 route(s) reach it'), heads.join(' | '));
  assert.equal(ev(ctx, "t('summary.others.families', {n:7, tables:7})"), '7 families fewer routes reach, 7 table(s)');
  assert.equal(ev(ctx, "t('summary.others.groups', {n:11, routes:18, ...summaryNouns()})"), '11 API groups with fewer routes, 18 route(s)');
});
