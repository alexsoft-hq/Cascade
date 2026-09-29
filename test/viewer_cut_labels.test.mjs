// viewer_cut_labels.test.mjs — the rail's cut lists and the map's count line in the reader's words (RM67-U2h).
//
// Found on mall at 1440x900, in both languages:
//   1. the evidence rail named every cut list by the engine's field path, so a
//      Korean page read "잘린 목록: hubs.tables 10/49". A chip now says what the
//      list is in the page's language, with its shown and total, and its title
//      keeps the path and the order;
//   2. the map's count line ran its numbers together ("49 / 76 tables touched
//      44 / 54 screens reach a route"). Each count is now its own item;
//   3. two lines said what the code does not do: Start's mode line named every
//      ranking, and the screens ranking does not follow the mode; the rail's
//      API and screen counts said "depth 8", a cap that is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VIEWER_STRINGS } from '../src/viewer/i18n.mjs';
import { bootPage, settle, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KO = JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer', 'i18n', 'ko.json'), 'utf8'));
const EN = VIEWER_STRINGS.en;
const babel = createRequire(import.meta.url)('../adapters/web/vendor/babel-parser.cjs');

// ---------------------------------------------------------------------------
// 1. every field path a tool can cut has a label, read out of the source
// ---------------------------------------------------------------------------

// EVERY FIELD PATH A TOOL CAN EMIT, read out of the engine the way the limit
// scopes are (test/i18n.test.mjs), but through the parser, because most paths do
// not sit beside the word `field`. A truncation entry is an object literal with
// `field`, `shown`, `total` and `nextOffset`. Its `field` is a literal, or a
// parameter of the helper that builds it (`truncField(field, …)`), and a call of
// that helper passes a literal, passes on its own parameter (`nodeCut` to
// `cut`), or walks a list whose names are the keys of an object: the object a
// caller hands `multiListAnswer`, or the table the entry reads its order from
// (`FLOW_ORDER[field]`). Anything else FAILS the scan, so a new way of building
// an entry is taught here instead of being missed.
const SCAN_DIRS = ['src/mcp', 'src/core'];
function engineFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) engineFiles(p, acc);
    else if (e.name.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}
const SKIP = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);
/** Every node under `node`, each with its ancestors, nearest last. */
function walk(node, visit, up = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, up);
  up.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (SKIP.has(k)) continue;
    if (Array.isArray(v)) for (const x of v) walk(x, visit, up);
    else if (v && typeof v.type === 'string') walk(v, visit, up);
  }
  up.pop();
}
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const keyOf = (p) => (p.type === 'ObjectProperty' && !p.computed
  ? (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null) : null);
const paramAt = (fn, name) => fn.params.findIndex((p) => (p.type === 'Identifier' && p.name === name)
  || (p.type === 'AssignmentPattern' && p.left.type === 'Identifier' && p.left.name === name));
/** The function a node sits in, its name, and whether the module exports it. */
function enclosing(up) {
  for (let i = up.length - 1; i >= 0; i -= 1) {
    if (!FN.has(up[i].type)) continue;
    const fn = up[i], parent = up[i - 1];
    const name = fn.id ? fn.id.name : parent && parent.type === 'VariableDeclarator' ? parent.id.name : null;
    const exported = [parent, up[i - 2], up[i - 3]].some((x) => x && x.type === 'ExportNamedDeclaration');
    return { fn, name, exported };
  }
  return null;
}
/** The object literals a module binds to a name at its top: `const T = {…}` or `Object.freeze({…})`. */
function tablesOf(program) {
  const out = new Map();
  for (const st of program.body) {
    const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
    if (!decl || decl.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) {
      let init = d.init;
      if (init && init.type === 'CallExpression' && init.arguments.length === 1) init = init.arguments[0];
      if (d.id.type === 'Identifier' && init && init.type === 'ObjectExpression') out.set(d.id.name, init);
    }
  }
  return out;
}
const isEntries = (x) => x && x.type === 'CallExpression' && x.callee.type === 'MemberExpression'
  && x.callee.object.type === 'Identifier' && x.callee.object.name === 'Object'
  && ['entries', 'keys'].includes(x.callee.property.name) && x.arguments[0] && x.arguments[0].type === 'Identifier';

/** One module: every field path its truncation entries can carry, and every place the scan lost the thread. */
function scanModule(file, program, paths, lost) {
  const tables = tablesOf(program);
  const at = (node) => `${file}:${node.loc.start.line}`;
  const calls = (name) => {
    const out = [];
    walk(program, (node, up) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name) out.push({ node, up: [...up] });
    });
    return out;
  };
  const builders = [];
  const addBuilder = (owner, index, node) => {
    if (!owner.name || owner.exported) { lost.push(`${at(node)}: the field is a parameter of a function called from where this scan does not look`); return; }
    if (!builders.some((b) => b.name === owner.name && b.index === index)) builders.push({ name: owner.name, index });
  };
  // A loop over a list of names: the keys of the table the entry reads by that
  // name (`FLOW_ORDER[field]`), or of the object each caller hands the function
  // whose entries it walks (`Object.entries(lists)`).
  const loopNames = (name, up, node) => {
    for (let i = up.length - 1; i >= 0; i -= 1) {
      const loop = up[i];
      if (loop.type !== 'ForOfStatement') continue;
      const id = loop.left.type === 'VariableDeclaration' ? loop.left.declarations[0].id : loop.left;
      if (id.type === 'Identifier' && id.name === name) {
        const vals = node.type === 'CallExpression' ? node.arguments : node.properties.map((p) => p.value);
        const read = vals.find((v) => v && v.type === 'MemberExpression' && v.computed && v.property.type === 'Identifier'
          && v.property.name === name && v.object.type === 'Identifier' && tables.has(v.object.name));
        return read ? tables.get(read.object.name).properties.map(keyOf) : null;
      }
      if (id.type === 'ArrayPattern' && id.elements[0] && id.elements[0].name === name && isEntries(loop.right)) {
        const owner = enclosing(up.slice(0, i));
        const index = owner ? paramAt(owner.fn, loop.right.arguments[0].name) : -1;
        if (index < 0 || !owner.name || owner.exported) return null;
        return calls(owner.name).flatMap(({ node: c }) => (c.arguments[index] && c.arguments[index].type === 'ObjectExpression'
          ? c.arguments[index].properties.map(keyOf) : [null]));
      }
    }
    return null;
  };
  const follow = (value, up, node) => {
    if (value && value.type === 'StringLiteral') { paths.add(value.value); return; }
    if (!value || value.type !== 'Identifier') { lost.push(`${at(node)}: a field that is neither a literal nor a name`); return; }
    const owner = enclosing(up);
    const index = owner ? paramAt(owner.fn, value.name) : -1;
    if (index >= 0) { addBuilder(owner, index, node); return; }
    const names = loopNames(value.name, up, node);
    if (!names || names.includes(null)) { lost.push(`${at(node)}: the field ${value.name} comes from somewhere this scan cannot follow`); return; }
    for (const n of names) paths.add(n);
  };
  walk(program, (node, up) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = node.properties.map(keyOf);
    if (!['field', 'shown', 'total', 'nextOffset'].every((k) => keys.includes(k))) return;
    follow(node.properties[keys.indexOf('field')].value, up, node);
  });
  for (let i = 0; i < builders.length; i += 1) {
    for (const { node, up } of calls(builders[i].name)) follow(node.arguments[builders[i].index], up, node);
  }
}

function scanFieldPaths() {
  const paths = new Set();
  const lost = [];
  for (const file of engineFiles(path.join(ROOT, 'src'))) {
    const ast = babel.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', errorRecovery: true });
    scanModule(path.relative(ROOT, file), ast.program, paths, lost);
  }
  return { paths: [...paths].sort(), lost };
}
const SCAN = scanFieldPaths();

test('the scan follows every way the engine builds a truncation entry', () => {
  assert.deepEqual(SCAN.lost, [], 'teach the scan the new way, rather than list the path by hand');
  // One of each way: a literal, a helper's literal, a nested path, a flow lane
  // named by FLOW_ORDER, a key handed to multiListAnswer, a wrapper of a wrapper,
  // a helper that is not truncField, and a file that is not tools.mjs.
  for (const p of ['projects', 'endpoints', 'hubs.tables', 'reach.samples.unreachedTables', 'services', 'webFunctions',
    'webSymbols', 'nodes.added', 'edges.regraded', 'edges', 'rules', 'families', 'affected']) {
    assert.ok(SCAN.paths.includes(p), `${p} was not found by the scan: ${SCAN.paths.join(', ')}`);
  }
});

test('every field path a tool can cut has a label in both catalogues, and no label is left over', () => {
  const hangul = /[가-힣]/;
  const missing = [];
  for (const p of SCAN.paths) {
    const k = `rail.cut.${p}`;
    if (typeof EN[k] !== 'string') missing.push(`${k} (en)`);
    if (typeof KO[k] !== 'string' || !hangul.test(KO[k])) missing.push(`${k} (ko)`);
  }
  assert.deepEqual(missing, [], 'a cut list with no label is shown by its field path; give it one in both languages');
  const stale = Object.keys(EN).filter((k) => k.startsWith('rail.cut.')).map((k) => k.slice('rail.cut.'.length))
    .filter((p) => !SCAN.paths.includes(p));
  assert.deepEqual(stale, [], 'a label for a path no tool emits any more');
  // A label is a phrase on a chip: short, no full stop, and never a dotted or
  // camelCase path said again ("tables" is simply the English word).
  for (const p of SCAN.paths) {
    for (const [lang, cat] of [['en', EN], ['ko', KO]]) {
      const v = cat[`rail.cut.${p}`];
      assert.ok(v.length <= 40, `${lang}/rail.cut.${p} is too long for a chip: ${v}`);
      assert.equal(/[.]$/.test(v), false, `${lang}/rail.cut.${p} is a sentence, not a label`);
      if (/[.A-Z]/.test(p)) assert.equal(v.includes(p), false, `${lang}/rail.cut.${p} is the path said again`);
    }
  }
});

test('the scan itself: each way of naming a field is followed, and a way it cannot follow is reported', () => {
  const src = `
    const ORDER = Object.freeze({ lanes: 'a', rows: 'b' });
    function entry(field, n) { return { field, shown: n, total: n, order: 'x', nextOffset: null }; }
    const wrap = (field, n) => entry(field, n);
    function lanes(list) { const out = []; for (const field of list) out.push(entry(field, ORDER[field])); return out; }
    function many(lists) { const out = []; for (const [field, rows] of Object.entries(lists)) out.push(entry(field, rows.length)); return out; }
    export function tool() {
      return [entry('plain', 1), wrap('wrapped', 2), many({ fromObject: [], andThis: [] }), { field: 'literal', shown: 0, total: 0, nextOffset: null }];
    }
    export function lost(name) { return { field: name.toUpperCase(), shown: 0, total: 0, nextOffset: null }; }`;
  const paths = new Set();
  const lost = [];
  scanModule('x.mjs', babel.parse(src, { sourceType: 'module' }).program, paths, lost);
  assert.deepEqual([...paths].sort(), ['andThis', 'fromObject', 'lanes', 'literal', 'plain', 'rows', 'wrapped']);
  assert.equal(lost.length, 1, lost.join('\n'));
  assert.match(lost[0], /^x\.mjs:10: a field that is neither a literal nor a name/);
});

// ---------------------------------------------------------------------------
// the page, over the real fixture server
// ---------------------------------------------------------------------------

const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
/** The page over the fixture server; `rewrite` may change one tool's answer on its way to the page. */
async function boot(t, { project = 'gamma', tab = 'start', rewrite = {}, renderer = false } = {}) {
  const { html, base } = await startViewer(t, ['gamma', 'delta']);
  const answer = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const res = await fetch(base + url, opts);
    if (!body || !rewrite[body.name]) return res;
    return json(rewrite[body.name](await res.json(), body.arguments || {}));
  };
  const page = await bootPage({ html, hash: `#p=${project}&tab=${tab}`, origin: base, renderer, answer });
  await settle(page.ctx, 20);
  return page;
}
const setLang = async (ctx, lang) => { ev(ctx, `setLang('${lang}')`); await settle(ctx, 8); };

// ---------------------------------------------------------------------------
// 1. a cut list in the reader's words, its path and order in the title
// ---------------------------------------------------------------------------

/** gamma's overview with its busiest tables cut, and a list this page has no label for. */
const cutHubs = (r) => {
  const hubs = r.truncated.fields.find((f) => f.field === 'hubs.tables');
  Object.assign(hubs, { shown: 1, total: 3, nextOffset: 1 });
  r.truncated.fields.push({ field: 'some.futureList', shown: 2, total: 5, order: 'id asc', nextOffset: 2 });
  r.truncated.any = true;
  return r;
};

test('a cut list on the rail says what it is in the reader\'s words, with the path and the order in its title', async (t) => {
  const { ctx, byId } = await boot(t, { tab: 'status', rewrite: { overview: cutHubs } });
  const order = ev(ctx, "OV.resp.truncated.fields.find((f)=>f.field==='hubs.tables').order");
  const cut = () => byId.get('ovside').querySelectorAll('span.railchip')
    .filter((c) => / order: /.test(c.title)).map((c) => [c.textContent, c.title]);
  assert.deepEqual(cut(), [
    ['busiest tables 1 of 3', `hubs.tables  order: ${order}`],
    ['some.futureList 2 of 5', 'some.futureList  order: id asc'],
  ], 'one chip per cut list, and none for a list that was not cut');
  assert.match(byId.get('ovside').textContent, /cut short:/);
  await setLang(ctx, 'ko');
  assert.deepEqual(cut(), [
    ['많이 쓰는 테이블 3개 중 1개', `hubs.tables  order: ${order}`],
    ['some.futureList 5개 중 2개', 'some.futureList  order: id asc'],
  ], 'the words follow the language; the path and the order stay the engine\'s');
  assert.match(byId.get('ovside').textContent, /잘린 목록:/);
});

// ---------------------------------------------------------------------------
// 2. the map's count line: one item per count
// ---------------------------------------------------------------------------

/** The count line as rows of items, and whether anything sits between two items. */
const countRows = (byId) => {
  const box = byId.get('gcounts');
  const loose = box.childNodes.filter((k) => !k.className || k.className !== 'gcrow').length
    + box.children.reduce((n, row) => n + row.childNodes.filter((k) => !/\bgci\b/.test(k.className || '')).length, 0);
  return { loose, rows: box.children.map((row) => row.children.map((c) => c.textContent)) };
};

test('the map\'s count line is one item per count, the answer\'s counts in one row and the picture\'s in the next', async (t) => {
  const { ctx, byId } = await boot(t, { project: 'delta', renderer: true });
  ev(ctx, "activateTab('graph')");
  await settle(ctx, 20);
  assert.deepEqual(countRows(byId), { loose: 0, rows: [
    ['1 group', '2 endpoints', '1 of 1 table touched', '1 of 2 screens reaches a route'],
    ['2 endpoints folded into their groups', '2 lines drawn (calls 1, aggregate 1)', 'drawn in 2D'],
  ] });
  await setLang(ctx, 'ko');
  assert.deepEqual(countRows(byId), { loose: 0, rows: [
    ['그룹 1개', '엔드포인트 2개', '건드린 테이블 1개 (전체 1개)', '경로에 닿는 화면 1개 (전체 2개)'],
    ['그룹 안에 접어 둔 엔드포인트 2개', '그린 선 2개 (호출 1, 묶음 1)', '2D로 그렸습니다'],
  ] });
});

// ---------------------------------------------------------------------------
// 3. the lines that said what the code does not do
// ---------------------------------------------------------------------------

test('the screens ranking keeps its own mode when the map\'s control moves, and the line says which lists move', async (t) => {
  const { ctx, byId } = await boot(t, { project: 'delta' });
  const modes = () => byId.get('shubs').querySelectorAll('.hubmode').map((h) => h.textContent);
  ev(ctx, "startSetMode('heuristic')");
  await settle(ctx, 12);
  assert.deepEqual(modes(), ['counted in heuristic', 'counted in heuristic', 'counted in conservative'],
    'tables and APIs follow the control; the screens come from one census and say which');
  assert.equal(byId.get('skpimode').textContent, 'The shares and the table and API rankings below are counted in heuristic, depth not capped.');
  assert.equal(byId.get('slead').querySelector('.startleadsay').textContent,
    'The map, the shares and the table and API rankings are counted in heuristic now. The screens ranking has one mode only, written under its title. The gaps and Analysis status stay in conservative.');
  await setLang(ctx, 'ko');
  assert.deepEqual(modes(), ['heuristic 모드 기준', 'heuristic 모드 기준', 'conservative 모드 기준']);
  assert.equal(byId.get('slead').querySelector('.startleadsay').textContent,
    '지금 지도, 비율, 테이블과 API 순위는 heuristic 모드 기준입니다. 화면 순위는 한 모드로만 세고, 그 모드를 제목 아래에 적어 둡니다. 누락 목록과 분석 상태는 conservative 모드 그대로입니다.');
});

test('the list\'s API and screen counts say the walk they come from: the census the answer names, with no depth cap', async (t) => {
  const { ctx, byId } = await boot(t, { project: 'delta', tab: 'trace' });
  assert.deepEqual(JSON.parse(ev(ctx, 'JSON.stringify(RAIL.trace.resp.answer.census)')), { mode: 'conservative', depth: null },
    'the engine counts these rows in conservative with no depth cap; the titles below say that, so a change here must change them');
  const titles = () => byId.get('tlist').querySelectorAll('.brstat').map((c) => c.title);
  const say = { en: /mode=conservative with no depth cap/, ko: /conservative 모드로 깊이 제한 없이/ };
  for (const lang of ['en', 'ko']) {
    await setLang(ctx, lang);
    const api = titles().filter((x) => /endpoints reach this|엔드포인트 수/.test(x));
    const scr = titles().filter((x) => /screens reach this|화면 수입니다/.test(x) && !/API|테이블/.test(x));
    assert.ok(api.length > 0 && scr.length > 0, `${lang}: the rows carry both counts: ${titles().join(' | ')}`);
    for (const x of [...api, ...scr]) {
      assert.match(x, say[lang]);
      assert.equal(/depth 8|깊이 8/.test(x), false, x);
    }
  }
});
