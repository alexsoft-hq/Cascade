// viewer_golden.test.mjs — what the page DRAWS, recorded tab by tab.
//
// WHY THIS EXISTS. Every other viewer test asks a question somebody thought to
// ask: is this chip there, does that button say the right thing. A round that
// MOVES the page's code — RM52 cut one 10 000-line inline script into thirteen
// files — needs the opposite: a check that notices a change nobody thought to
// ask about. So this file boots the page, walks the tabs, and compares the whole
// document body, element by element, with a recording under
// test/fixtures/golden-viewer/.
//
// TWO SOURCES OF ANSWERS, because neither one alone covers the page.
//   the four fixture packs   test/helpers/viewer_fixtures.mjs builds them and
//                            serves them through the REAL viewer server, so
//                            every tool the page can call has a real answer:
//                            browse, search, column_impact, table_usage,
//                            transactions, neighborhood, the lot. This is what
//                            covers Explore, Impact and Transactions.
//   the recorded corpus      test/fixtures/golden/ holds every answer the
//                            server gave over the three fixture TREES (a real
//                            Spring backend with three different frontends) —
//                            far richer data than a hand-built pack, and the
//                            page is fed straight from it, with no server at
//                            all. It carries `overview`, `map`, `erd`,
//                            `coupling`, `flow` down from each endpoint and
//                            screen, and the two impact tools; the tabs it
//                            cannot drive (Explore's detail tools, Impact's
//                            walk UP, the browse rail) are the fixture packs'
//                            half of the job.
//
// WHAT IS RECORDED: the body, serialised as text — every element, its id, its
// classes, its attributes, the properties the page assigns (a button's title, an
// input's value), whether it carries a handler, and the text between the tags.
// Whitespace is collapsed. Nothing is masked: two runs of the same page over the
// same answers are byte-identical, and if that ever stops being true the mask
// belongs here with the reason beside it, not as a habit.
//
// RE-RECORDING. `CASCADE_RECORD_GOLDEN=1 node --test test/viewer_golden.test.mjs`
// rewrites every file. A recording that changes for a good reason is re-recorded
// ON PURPOSE, in the commit that changed it, and that commit says why. A
// recording that changes in a round that claims to change nothing is the round
// being wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_ROOT, El, bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const GOLDEN = path.join(ENGINE_ROOT, 'test', 'fixtures', 'golden-viewer');
const CORPUS = path.join(ENGINE_ROOT, 'test', 'fixtures', 'golden');
const RECORD = process.env.CASCADE_RECORD_GOLDEN === '1';

// ---------------------------------------------------------------------------
// The body, as text
// ---------------------------------------------------------------------------

// Properties the stub keeps for its own bookkeeping. Everything else an element
// carries was put there by the page, and is part of what it drew.
const INTERNAL = new Set([
  'tagName', 'attrs', 'dataset', 'kids', 'parentNode', 'className', 'id', 'text',
  '_style', '_listeners', 'classList', 'clientWidth', 'clientHeight',
]);
const HANDLER = /^on[a-z]+$/;

/** `a="b"` pairs for one element, in a fixed order: id, class, then the rest sorted. */
function attrsOf(node) {
  const seen = new Map();
  for (const [k, v] of node.attrs) seen.set(k, v);
  for (const [k, v] of Object.entries(node.dataset)) {
    seen.set(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
  }
  for (const k of Object.keys(node)) {
    if (INTERNAL.has(k)) continue;
    const v = node[k];
    if (typeof v === 'function') { if (HANDLER.test(k)) seen.set(k, ''); continue; }
    if (v === null || v === undefined || v === '' || v === false) continue;
    if (typeof v === 'object') continue;
    seen.set(k, String(v));
  }
  const style = Object.entries(node._style._s).map(([k, v]) => `${k}: ${v}`).join('; ');
  if (style) seen.set('style', style);
  const out = [];
  if (node.id) out.push(`id="${node.id}"`);
  if (node.className) out.push(`class="${node.className}"`);
  for (const k of [...seen.keys()].sort()) {
    if (k === 'id' || k === 'class') continue;
    out.push(seen.get(k) === '' ? k : `${k}="${seen.get(k)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * One element and everything under it, as one line of text per element.
 *
 * WHAT IS UNDER A HIDDEN ELEMENT IS NOT RECORDED — only that there is
 * something. This page carries every tab's panel in the markup at once and
 * hides the six the reader is not on, so a recording of the whole tree would be
 * six sevenths the same text in every file. A `…` says the subtree is there;
 * what it holds is recorded by the snapshot taken while that tab is open, which
 * is the snapshot where it is what the reader sees.
 */
function serialise(node, depth = 0) {
  const tag = node.tagName.toLowerCase();
  const pad = '  '.repeat(depth);
  if (node._classes().has('hidden')) {
    return `${pad}<${tag}${attrsOf(node)}>${node.hasChildNodes() || node.text ? '…' : ''}</${tag}>`;
  }
  const kids = node.kids.map((k) => (k instanceof El
    ? serialise(k, depth + 1)
    : `${'  '.repeat(depth + 1)}${collapse(k.text)}`)).filter((x) => x.trim() !== '');
  const own = node.kids.length === 0 && node.text ? collapse(node.text) : '';
  if (kids.length === 0) return `${pad}<${tag}${attrsOf(node)}>${own}</${tag}>`;
  return [`${pad}<${tag}${attrsOf(node)}>`, ...kids, `${pad}</${tag}>`].join('\n');
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Compare one snapshot with its recording, or write it. */
function check(name, text) {
  const file = path.join(GOLDEN, `${name}.txt`);
  if (RECORD) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}\n`, 'utf8');
    return;
  }
  assert.ok(fs.existsSync(file), `no recording at ${file}: record one with CASCADE_RECORD_GOLDEN=1`);
  const want = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
  if (want === text) return;
  const a = want.split('\n');
  const b = text.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  assert.fail(`${name} draws something else now (line ${at + 1} of ${b.length}, was ${a.length} lines):\n`
    + `  recorded: ${a[at]}\n  now:      ${b[at]}\n`
    + 'If the change is right, re-record with CASCADE_RECORD_GOLDEN=1 and SAY WHY in the commit');
}

/** Walk the page to one place, let it settle, and record the body. */
async function shot(page, name, drive) {
  if (drive) ev(page.ctx, drive);
  await settle(page.ctx);
  check(name, serialise(page.body));
}

// ---------------------------------------------------------------------------
// Part 1 — the page over the four fixture packs, through the real server
// ---------------------------------------------------------------------------

/** Boot the page against the fixture server, on one project. */
async function bootFixture(t, project, ids) {
  const { html, base } = await startViewer(t, ids);
  return bootPage({
    html,
    origin: base,
    search: `?project=${project}`,
    renderer: true,
    answer: (url, opts) => fetch(base + url, opts),
  });
}

test('the page draws the same thing on every tab of a Java + SQL pack', async (t) => {
  const page = await bootFixture(t, 'gamma', ['gamma', 'delta']);
  await shot(page, 'gamma/overview');
  await shot(page, 'gamma/explore-column', "activateTab('explore'); showColumn('gamma_order.total')");
  await shot(page, 'gamma/explore-table', "showTable('gamma_order')");
  await shot(page, 'gamma/flow-endpoint', "openFlow({endpoint:'GET /order/{id}'})");
  await shot(page, 'gamma/impact-column', "openImpact({column:'gamma_order.total'})");
  await shot(page, 'gamma/coupling', "activateTab('coupling'); drawCoupling()");
  await shot(page, 'gamma/graph', "activateTab('graph')");
  await shot(page, 'gamma/erd', "activateTab('erd')");
  await shot(page, 'gamma/transactions', "activateTab('tx')");
});

test('the page draws the same thing on a pack with the screen axis', async (t) => {
  const page = await bootFixture(t, 'delta', ['gamma', 'delta']);
  await shot(page, 'delta/overview');
  await shot(page, 'delta/flow-screen', "openFlow({screen:'/rows'})");
  await shot(page, 'delta/explore-screen', "activateTab('explore'); showScreen('/rows')");
  await shot(page, 'delta/graph', "activateTab('graph')");
});

// ---------------------------------------------------------------------------
// Part 2 — the page over the recorded corpus, with no server at all
// ---------------------------------------------------------------------------

/** Every answer recorded for one tree, indexed by tool and by the key it was asked with. */
function corpusOf(tree) {
  const byTool = new Map();
  const root = path.join(CORPUS, tree);
  for (const tool of fs.readdirSync(root).sort()) {
    const byKey = new Map();
    for (const file of fs.readdirSync(path.join(root, tool)).sort()) {
      const rec = JSON.parse(fs.readFileSync(path.join(root, tool, file), 'utf8'));
      byKey.set(rec.key, rec.answer);
    }
    byTool.set(tool, byKey);
  }
  return byTool;
}

/**
 * Which recording answers one call. The recorder asked each tool with its
 * DEFAULT arguments, so a page that asks the same tool with a depth or a limit
 * of its own gets the recorded answer all the same: it is a real answer from a
 * real server, which is what the recording is for. A tool with nothing recorded
 * for it answers the way the server answers an unknown key, and the page draws
 * its error panel — which is also worth recording.
 */
function keyFor(name, args) {
  if (['overview', 'map', 'erd', 'coupling'].includes(name)) return 'default';
  if (name === 'flow') {
    if (args.direction === 'up') return null;   // the corpus walks down only
    if (args.endpoint) return `endpoint ${args.endpoint}`;
    if (args.screen) return `screen ${args.screen}`;
    return null;
  }
  if (name === 'endpoint_impact' || name === 'screen_impact') return args.column ?? null;
  return null;
}

/** The page's fetch, answered out of one tree's recordings. */
function answerFrom(tree, corpus) {
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const overview = corpus.get('overview').get('default');
  const pack = overview.answer.pack;
  return async (url, opts) => {
    const at = url.split('?')[0];
    if (at === '/api/projects') return json(200, corpus.get('projects').get('projects'));
    if (at === '/api/meta') {
      return json(200, {
        project: tree, projectId: tree, digest: pack.digest, lanes: pack.lanes,
        builtAt: pack.builtAt, freshness: overview.basis.freshness, base: pack.base,
        canSource: false, projects: [tree],
      });
    }
    if (at.startsWith('/i18n/')) {
      const file = path.join(ENGINE_ROOT, 'viewer', 'i18n', path.basename(at));
      if (!fs.existsSync(file)) return json(404, { error: { code: 'unknown-key', message: 'no catalogue' } });
      return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (at === '/api/call') {
      const body = JSON.parse(opts.body);
      const key = keyFor(body.name, body.arguments || {});
      const rec = key === null ? undefined : corpus.get(body.name)?.get(key);
      if (rec === undefined) {
        return json(404, { error: { code: 'unknown-key', message: `nothing recorded for ${body.name}` } });
      }
      return json(200, rec);
    }
    return json(404, { error: { code: 'unknown-key', message: `no route: ${at}` } });
  };
}

const TREES = [
  { tree: 'fullstack', endpoint: 'GET /things/{id}', screen: '/things/list' },
  { tree: 'angular', endpoint: 'GET /api/shop/things', screen: '/things' },
  { tree: 'templates', endpoint: 'GET /page/things', screen: '/page/things' },
];

for (const { tree, endpoint, screen } of TREES) {
  test(`the page draws the same thing over the recorded answers of the ${tree} tree`, async (t) => {
    void t;
    const corpus = corpusOf(tree);
    const html = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8');
    const page = await bootPage({ html, search: `?project=${tree}`, renderer: true, answer: answerFrom(tree, corpus) });
    await shot(page, `${tree}/overview`);
    await shot(page, `${tree}/flow-endpoint`, `openFlow({endpoint:${JSON.stringify(endpoint)}})`);
    await shot(page, `${tree}/flow-screen`, `openFlow({screen:${JSON.stringify(screen)}})`);
    await shot(page, `${tree}/coupling`, "activateTab('coupling'); drawCoupling()");
    await shot(page, `${tree}/graph`, "activateTab('graph')");
    await shot(page, `${tree}/erd`, "activateTab('erd')");
  });
}

test('the recordings are committed, and cover both sources', () => {
  const files = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(GOLDEN, rel)).sort()) {
      const next = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(GOLDEN, next)).isDirectory()) walk(next);
      else files.push(next);
    }
  };
  walk('');
  assert.ok(files.length >= 20, `expected the viewer recordings under ${GOLDEN}`);
  for (const dir of ['gamma', 'delta', 'fullstack', 'angular', 'templates']) {
    assert.ok(files.some((f) => f.startsWith(`${dir}/`)), `nothing recorded for ${dir}`);
  }
});
