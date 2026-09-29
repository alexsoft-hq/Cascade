// viewer_rm67.test.mjs — the page, reading what the analysis could not see where a reader needs it.
//
// RM67 audited the viewer on a NestJS + Prisma project whose routes are mostly
// guesses (an exclude list built at run time) and whose schema was never read,
// and on two Java projects. What this file holds: the Rules tab opens on the
// rules that did something for this project and goes from a rule to its links;
// a share is never shown without the limit that bounds it; the blind spots are
// set out by what a reader can do about each; a failed column lookup is not an
// empty table; a screen axis that was not collected says why instead of
// vanishing; the toolbars put the target first; and a long route keeps the part
// that tells it apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage as boot, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';
import { Graph } from '../src/core/graph.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';

/** A NestJS + Prisma pack in miniature: a sure route and a guessed one, one Prisma statement. */
function nestPack() {
  const g = new Graph();
  const ctl = 'symbol:src/users/users.controller.ts#UsersController.list';
  const svc = 'symbol:src/users/users.service.ts#UsersService.all';
  const stmt = 'statement:prisma:src/users/users.service.ts#UsersService.all/0';
  for (const [path, grade] of [['/api/users', 'HEURISTIC'], ['/api/users/{id}', 'EXACT']]) {
    g.addNode({ id: `endpoint:GET ${path}`, path, httpMethod: 'GET', handler: ctl });
    g.addEdge({ from: `endpoint:GET ${path}`, to: ctl, type: 'HANDLES', grade, evidence: { rule: 'nestjs.routes', basis: 'a controller declares this route' } });
  }
  g.addNode({ id: svc, file: 'src/users/users.service.ts' });
  g.addNode({ id: stmt, prismaEvidence: { rule: 'prisma.operations', client: 'prisma.client' } });
  g.addEdge({ from: svc, to: stmt, type: 'IMPLEMENTS_STMT', grade: 'EXACT', evidence: { rule: 'prisma.client' } });
  return g;
}

const basis = () => ({ project: 'gamma', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } });
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

/**
 * The page over the real fixture server, except where a test answers for it:
 * `rules` from the pack above, the example verdicts, and any call `override`
 * names. Everything the page asks goes through `asked`.
 */
async function bootPage(t, { hash = '#p=gamma&tab=start', override = null, examples = true } = {}) {
  const { html, base } = await startViewer(t, ['gamma', 'delta']);
  const asked = [];
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    asked.push({ url, body });
    if (override) { const o = override(url, body); if (o) return o; }
    if (body && body.name === 'rules') return json(callTool('rules', body.arguments, { graph: nestPack(), basis: basis() }));
    if (url === '/api/rules/examples' && examples) {
      const ex = builtinRegistry().rules.get('nestjs.routes').rule.examples;
      return json({ rules: [{ id: 'nestjs.routes', total: ex.length, held: ex.map((_, i) => i !== 1), notRun: null }] });
    }
    return fetch(base + url, opts);
  };
  const page = await boot({ html, hash, storage: {}, origin: base, answer });
  return { ...page, asked };
}

const texts = (nodes) => nodes.map((n) => n.textContent);

// ---------------------------------------------------------------------------
// the Rules tab
// ---------------------------------------------------------------------------

test('the Rules tab opens on the rules that gave something here, biggest first, and counts the nodes a rule made', async (t) => {
  const { ctx, byId, asked } = await bootPage(t, { hash: '#p=gamma&tab=rules' });
  await settle(ctx, 10);
  assert.ok(asked.some((a) => a.body && a.body.name === 'rules'), 'the tab reads the `rules` tool, the answer a model gets too');
  assert.equal(ev(ctx, 'RULES.scope'), 'here');
  const rows = byId.get('rulesview').querySelectorAll('button.rulerow');
  assert.deepEqual(rows.map((r) => r.querySelector('.ruleid').textContent), ['nestjs.routes', 'prisma.client', 'prisma.operations']);
  // The rule that made the statement reads as having made it, not as "0 links".
  assert.equal(rows[2].querySelector('.rulegave').textContent, '1 statement nodes');
  // The grades a rule GAVE, not only its cap: one of the two routes is a guess.
  assert.deepEqual(texts(rows[0].querySelectorAll('.rulegrade')), ['EXACT1', 'HEURISTIC1']);
  const idle = builtinRegistry().rules.size - 3;
  assert.match(byId.get('rulesview').querySelector('.rulemore').textContent, new RegExp(`^${idle} more rules gave nothing here`));
  // All: the idle and the classifying rules are there, each in its group.
  byId.get('rscope').children[1].onclick();
  assert.deepEqual(texts(byId.get('rulesview').querySelectorAll('.rulegrp')).map((x) => x.replace(/ \(\d+\)$/, '')),
    ['Gave something here', 'Gave nothing here', 'Classifies, so nothing to count']);
});

test('the Rules list narrows by the words typed, the kind and the lane, from the rows it holds', async (t) => {
  const { ctx, byId, asked } = await bootPage(t, { hash: '#p=gamma&tab=rules' });
  await settle(ctx, 10);
  byId.get('rscope').children[1].onclick();
  const n = asked.length;
  const ids = () => byId.get('rulesview').querySelectorAll('.ruleid').filter((x) => !x.classList.contains('big')).map((x) => x.textContent);
  ev(ctx, "RULES.q='mpjbasemapper'; drawRules();");
  assert.deepEqual(ids(), ['mybatis-plus-join.mapper'], 'the words typed match the description too, in any case');
  ev(ctx, "RULES.q=''; RULES.lane='ts'; drawRules();");
  const tsRules = [...builtinRegistry().rules.values()].filter((e) => builtinRegistry().kinds[e.kind].lane === 'ts').map((e) => e.id).sort();
  assert.ok(tsRules.includes('typeorm.operations') && tsRules.includes('nestjs.routes'), 'every TypeScript kind says its lane');
  assert.deepEqual(ids().sort(), tsRules);
  ev(ctx, "RULES.lane=''; RULES.kind='sql.dialect-path'; drawRules();");
  assert.deepEqual(ids(), ['sql-dialects.path-names']);
  ev(ctx, "RULES.kind=''; RULES.q='no rule says this'; drawRules();");
  assert.match(byId.get('rulesview').querySelector('.empty').textContent, /No rule matches/);
  assert.equal(asked.length, n, 'filtering asks the server for nothing');
});

test('a rule opens on what it gave here, each link a way to the tab that reads it, and each example with its verdict', async (t) => {
  const { ctx, byId, asked } = await bootPage(t, { hash: '#p=gamma&tab=rules' });
  await settle(ctx, 10);
  const detail = () => byId.get('rulesview').querySelector('.ruledetail');
  assert.ok(asked.some((a) => a.body && a.body.name === 'rules' && a.body.arguments.rule === 'nestjs.routes'),
    'the biggest rule is opened on arrival');
  assert.match(detail().querySelector('.rulecensus').textContent, /2 links/);
  assert.match(detail().querySelector('.rulecensus').textContent, /HEURISTIC 1/);
  const ends = detail().querySelectorAll('button.ruleend');
  assert.equal(ends[0].textContent.trim(), 'GET /api/users');
  // The examples, with the verdict `cascade rules test` gives on this server.
  const ex = detail().querySelector('.ruleex').children;
  assert.equal(ex[0].querySelector('.ruleok').textContent, 'holds');
  assert.equal(ex[1].querySelector('.rulebad').textContent, 'does not hold');
  // A route end opens the route on Trace, walked down.
  ends[0].onclick();
  await settle(ctx, 6);
  assert.equal(ev(ctx, 'STATE.tab'), 'trace');
  assert.equal(ev(ctx, 'JSON.stringify([TRACE.target, TRACE.dir])'), '[{"kind":"endpoint","id":"GET /api/users"},"down"]');
});

test('a web rule is found by its lane, and its examples show each file under its name', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=gamma&tab=rules' });
  await settle(ctx, 10);
  byId.get('rscope').children[1].onclick();
  const ids = () => byId.get('rulesview').querySelectorAll('.ruleid').filter((x) => !x.classList.contains('big')).map((x) => x.textContent);
  assert.ok(texts(byId.get('rlane').children).includes('web'), 'the lane filter offers every lane a kind names');
  ev(ctx, "RULES.lane='web'; drawRules();");
  assert.deepEqual(ids(), ['vben-admin.request']);
  ev(ctx, "rulesPick('vben-admin.request');");
  await settle(ctx, 6);
  const src = byId.get('rulesview').querySelector('.ruledetail .ruleex .rulesrc').textContent;
  assert.match(src, /^\/\/ src\/http\/Axios\.ts\n/);
  assert.match(src, /\n\/\/ src\/api\.ts\n/);
});

test('with no verdicts from the server, the examples say so rather than claim they hold', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=gamma&tab=rules', examples: false });
  await settle(ctx, 10);
  const detail = byId.get('rulesview').querySelector('.ruledetail');
  assert.equal(detail.querySelectorAll('.ruleok').length, 0);
  assert.match(detail.textContent, /Whether they hold was not asked of this server/);
});

// ---------------------------------------------------------------------------
// Start and Analysis status: a share and its limit, and the blind spots by what to do
// ---------------------------------------------------------------------------

test('a share is shown with the limit that bounds it, in its own card, and no ring draws it twice', async (t) => {
  const { ctx, byId } = await bootPage(t);
  assert.equal(byId.get('ovcards').querySelectorAll('svg').length, 0, 'the dial ring is gone');
  assert.equal(byId.get('ovcards').querySelectorAll('.kpilimit').length, 0, 'a pack read whole has no limit to show');
  ev(ctx, `OV.resp.answer.axes.catalog = { status:'not-shipped', reason:'no catalog was read here' };
    OV.resp.answer.reach.routeGrades = { EXACT:1, HEURISTIC:117 };
    renderOverview();`);
  const cards = byId.get('ovcards').querySelectorAll('.kpi');
  // The walk reads a route's link to its handler as the path's first link, so
  // this answer's mode stops at a guessed route, and the card says so.
  assert.equal(cards[0].querySelector('.kpilimit').textContent, '117 of 118 routes graded HEURISTIC: mode conservative stops at them');
  ev(ctx, "OV.resp.answer.mode='heuristic'; renderOverview();");
  assert.equal(byId.get('ovcards').querySelectorAll('.kpi')[0].querySelector('.kpilimit').textContent, '117 of 118 routes graded HEURISTIC',
    'a mode that walks the grade only names it');
  ev(ctx, "OV.resp.answer.mode='conservative'; renderOverview();");
  const tables = byId.get('ovcards').querySelectorAll('.kpi')[2].querySelector('.kpilimit');
  assert.equal(tables.textContent, 'no database schema was read: these are the tables the SQL named');
  assert.equal(tables.title, 'no catalog was read here', 'the engine\'s own reason rides on it');
  // The limit is the way to the blind spot that explains it, opened.
  tables.onclick();
  assert.equal(ev(ctx, "foldIsOpen('ov.axis.catalog')"), true);
  // A catalog a mapping declared names where its tables came from: scope, not a limit.
  ev(ctx, "OV.resp.answer.axes.catalog = { status:'shipped', reason:null, sources:['schema.prisma'] }; renderOverview();");
  const card = byId.get('ovcards').querySelectorAll('.kpi')[2];
  assert.equal(card.querySelector('.kpilimit'), null);
  assert.equal(card.querySelector('.kpinote').textContent, 'tables and columns from schema.prisma');
});

test('Trace says when this mode stopped at the route itself, and how to go further', async (t) => {
  const { ctx } = await bootPage(t, { hash: '#p=gamma&tab=trace' });
  await settle(ctx, 10);
  const answer = { answer: { entry: { kind: 'endpoint', id: 'GET /a', grade: 'HEURISTIC', start: 'endpoint:GET /a' },
    walk: { mode: 'conservative', cut: { byMode: 1, byModeGrades: { HEURISTIC: 1 } } } } };
  const panel = ev(ctx, `chainLeftOut(TRACEV, ${JSON.stringify(answer)}).textContent`);
  assert.match(panel, /This route's own link to its handler is graded HEURISTIC, so mode conservative stops at the route\./);
  // Each grade left out is named, counted and said in the legend's words (RM67).
  assert.match(panel, /did not follow 1 link\(s\) of a grade it does not admit/);
  assert.match(panel, /HEURISTIC\s*1\s*a guess from a convention or an incomplete reading; check it/);
  assert.match(panel, /Switch to heuristic/);
  answer.answer.walk.mode = 'heuristic';
  answer.answer.walk.cut = { byMode: 1, byModeGrades: { UNRESOLVED: 1 } };
  const wide = ev(ctx, `chainLeftOut(TRACEV, ${JSON.stringify(answer)}).textContent`);
  assert.doesNotMatch(wide, /stops at the route/, 'a mode that walks the grade does not stop there');
  assert.match(wide, /No mode walks these/);
});

test('the blind spots are set out by what a reader can do, with the axes not built and the lanes\' diagnostics', async (t) => {
  const { ctx, byId } = await bootPage(t);
  ev(ctx, `OV.resp.answer.axes.screen = { status:'not-shipped', reason:'screenAxis.enabled is undeclared' };
    OV.resp.answer.diagnostics = [{ kind:'TS_PREFIX_EXCLUDE_UNREAD', severity:'warn', key:'tsBackend',
      reason:'Declare the list as tsBackend.globalPrefixExclude in the profile to read it' }];
    renderOverview();`);
  // Since RM67-U2c the blind spots are rows on Analysis status, in a panel of
  // their own, grouped in the order of what a reader can do: inputs first.
  const panel = byId.get('stgaps').querySelector('.panel');
  assert.equal(panel.id, 'ovgaps', 'what we could not see is its own panel on Analysis status');
  const order = JSON.parse(ev(ctx, 'JSON.stringify(OV_GAP_GROUPS.map(([, k]) => t(k)))'));
  assert.equal(order[0], 'Inputs it did not have');
  const heads = texts(panel.querySelectorAll('.ovgaplbl'));
  assert.ok(heads.indexOf('What it could not read') >= 0 && heads.indexOf('Links this mode does not follow') >= 0, heads.join(' | '));
  assert.ok(heads.indexOf('What it could not read') < heads.indexOf('Links this mode does not follow'));
  assert.deepEqual(heads, order.filter((h) => heads.includes(h)), 'the groups keep that order');
  // The axis not built is a row of the axes table, with the engine's reason.
  const axis = byId.get('staxes').querySelector('tr#st-ov-axis-screen');
  assert.ok(axis, 'the screen axis has its row');
  assert.ok(axis.classList.contains('warn'));
  assert.match(axis.textContent, /not collected/);
  // RM67-U2e: the engine's reason is folded under the page's words, one activation away.
  axis.querySelector('.foldlead').onclick();
  assert.match(axis.textContent, /screenAxis\.enabled is undeclared/);
  // A lane diagnostic is a row of its own, by the engine's own code.
  const diag = byId.get('stdiags').querySelector('.stitem#st-ov-diag-TS_PREFIX_EXCLUDE_UNREAD');
  assert.ok(diag, 'a lane diagnostic is a row of its own, by the engine\'s own code');
  assert.equal(diag.querySelector('.ovdiag').textContent, 'TS_PREFIX_EXCLUDE_UNREAD');
  // Start lists the ones that change an answer, the input first, and each is
  // the way to its row: the diagnostic opens on the lane's own remedy.
  const starts = byId.get('sgaps').querySelectorAll('button.sgap');
  assert.ok(starts[0].textContent.includes('screens: not collected'), texts(starts).join(' | '));
  const toDiag = starts.find((c) => c.textContent.includes('unread setting: API prefix exclude list') && c.title === 'TS_PREFIX_EXCLUDE_UNREAD');
  assert.ok(toDiag, 'Start lists the diagnostic in the page\'s words, its code on the tooltip');
  toDiag.onclick();
  assert.equal(ev(ctx, 'STATE.tab'), 'status');
  assert.match(byId.get('stdiags').querySelector('#st-ov-diag-TS_PREFIX_EXCLUDE_UNREAD').textContent, /tsBackend\.globalPrefixExclude/,
    'and it opens on the lane\'s own remedy');
  // Every chip's class is the engine's: the page does not decide what kind a gap is.
  const classes = JSON.parse(ev(ctx, 'JSON.stringify(OV.resp.answer.gaps.map((g)=>g.class))'));
  assert.ok(classes.every((c) => ['input', 'unresolved', 'query', 'unreached', 'info'].includes(c)), classes.join(' '));
});

test('the masthead counts services as services, the methods between a controller and the SQL', async (t) => {
  const { ctx, byId } = await bootPage(t);
  const lane = byId.get('crail').querySelectorAll('.crlane').find((n) => n.textContent.startsWith('services'));
  assert.equal(lane.children[0].textContent, String(ev(ctx, 'OV.resp.answer.code.services')));
  assert.notEqual(ev(ctx, 'OV.resp.answer.code.services'), ev(ctx, 'OV.resp.answer.code.symbols'),
    'not the symbol census, which counts every method read');
});

// ---------------------------------------------------------------------------
// the rails and the toolbars
// ---------------------------------------------------------------------------

test('a column lookup that fails is a failure with its reason and a way to ask again, never an empty table', async (t) => {
  let fail = true;
  const override = (url, body) => (fail && body && body.name === 'browse' && body.arguments.kind === 'column'
    ? json({ error: { code: 'pack-unreadable', message: 'the pack could not be read' } }, 503) : null);
  const { ctx, byId } = await bootPage(t, { hash: '#p=gamma&tab=trace', override });
  await settle(ctx, 10);
  byId.get('tlist').querySelectorAll('.brcaret')[0].click();
  await settle(ctx, 10);
  const child = byId.get('tlist').querySelector('.brchildren');
  assert.match(child.textContent, /The columns could not be read: pack-unreadable: the pack could not be read/);
  assert.doesNotMatch(child.textContent, /Nothing/);
  fail = false;
  child.querySelector('button').onclick();
  await settle(ctx, 10);
  assert.ok(byId.get('tlist').querySelectorAll('.brchild').length > 0, 'asked again, the columns are there');
});

test('a screen axis that was not collected keeps its entry on Trace, and says why and what to set', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=gamma&tab=trace' });
  await settle(ctx, 10);
  const chip = () => byId.get('tkinds').children.find((c) => /^Screens/.test(c.textContent));
  assert.equal(chip(), undefined, 'a pack that declares no screen axis has nothing to say');
  ev(ctx, `OV.resp.answer.axes.screen = { status:'not-shipped', reason:'screenAxis.enabled is undeclared' }; railRenderChips('trace');`);
  assert.equal(chip().querySelector('.brn').textContent, '—', 'a dash, not a zero');
  chip().onclick();
  await settle(ctx, 10);
  assert.match(byId.get('tlist').textContent, /No screen was collected in this analysis\.screenAxis\.enabled is undeclared/);
});

test('a list mostly of guessed routes says so once; a few guessed routes carry their grade on the row', async (t) => {
  const { ctx, byId } = await bootPage(t, { hash: '#p=gamma&tab=trace' });
  await settle(ctx, 10);
  ev(ctx, "railSetKind('trace', 'endpoint')");
  await settle(ctx, 10);
  const row = { grade: 'HEURISTIC', statements: 1, tables: 1, handlers: 1 };
  ev(ctx, "OV.resp.answer.reach.routeGrades = { EXACT:3, HEURISTIC:1 }; railRenderCount('trace');");
  assert.match(byId.get('tcount').textContent, /1 of 4 routes graded HEURISTIC/);
  assert.equal(ev(ctx, `railStats('endpoint', ${JSON.stringify(row)})[0].className`), 'brgrade');
  ev(ctx, "OV.resp.answer.reach.routeGrades = { EXACT:1, HEURISTIC:3 }; railRenderCount('trace');");
  assert.match(byId.get('tcount').textContent, /3 of 4 routes graded HEURISTIC/);
  assert.notEqual(ev(ctx, `railStats('endpoint', ${JSON.stringify(row)})[0].className`), 'brgrade');
});

test('the Trace toolbar puts the target, Trace and the direction first; depth, drawing and motion, and the three saves, are one menu each', async (t) => {
  const { byId } = await bootPage(t);
  for (const x of ['t']) {
    const bar = byId.get(`${x}entry`).parentNode.parentNode;
    const order = bar.children.map((c) => c.id || c.children[0]?.id || c.tagName);
    assert.ok(order.indexOf(`${x}draw`) < order.indexOf(`${x}dir`), order.join(' '));
    assert.ok(order.indexOf(`${x}dir`) < order.indexOf(`${x}mode`), order.join(' '));
    assert.equal(byId.get(`${x}depth`).closest('details').id, `${x}opts`);
    assert.equal(byId.get(`${x}flow`).closest('details').id, `${x}opts`);
    for (const id of ['export', 'svg', 'png']) assert.equal(byId.get(`${x}${id}`).closest('details').id, `${x}exports`);
  }
});

test('a long route is cut from the middle: the head gives way and the part that tells two apart stays', async (t) => {
  const { ctx } = await bootPage(t);
  const parts = (s) => JSON.parse(ev(ctx, `JSON.stringify(pathLabel(${JSON.stringify(s)}).map((x)=>[x.className, x.textContent]))`));
  assert.deepEqual(parts('GET /api/v1/portfolio/holding/{dataSource}/{symbol}/tags'),
    [['phead', 'GET /api/v1/portfolio/holding/{dataSource}'], ['ptail', '/{symbol}/tags']]);
  assert.deepEqual(parts('GET /api/users'), [['ptail', 'GET /api/users']], 'a short one is one piece');
});
