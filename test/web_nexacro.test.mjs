import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';

// The two frontends this round taught the web lane to read (RM56), each driven
// the way the CLI drives it: the worker is SPAWNED and its JSONL is the
// contract, and the bridge is then handed the same records.
//
//   a Nexacro client   `.xfdl` forms whose screens are files, whose scripts sit
//                      inside `<Script><![CDATA[…]]></Script>`, and whose calls
//                      to the backend all go through `transaction(…)`
//   a Next.js frontend which declares no routes at all: the FILE TREE is the
//                      route table, and `pages/api/**` is not part of it
//
// Every line number is computed from the fixture text, never written down.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'adapters', 'web', 'webfacts.mjs');
const NEXACRO = path.join(ROOT, 'test', 'fixtures', 'nexacro-smoke');
const NEXT = path.join(ROOT, 'test', 'fixtures', 'next-smoke');

function run(root, ...roots) {
  const out = execFileSync(process.execPath, [WORKER, '--root', root, ...roots], { maxBuffer: 1 << 28 }).toString('utf8');
  return { raw: out, records: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const NX = run(NEXACRO, path.join(NEXACRO, 'app'));
const NEXT_RUN = run(NEXT, path.join(NEXT, 'src'));

const FORM = 'app/Pattern/UserList.xfdl';
const LIB = 'app/Lib/Comm.xjs';

/** The 1-based line a fixture file's first line matching `re` sits on. */
function lineOf(base, relFile, re) {
  const lines = fs.readFileSync(path.join(base, relFile), 'utf8').split('\n');
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0, `${relFile} has no line matching ${re}`);
  return i + 1;
}

const nxOf = (file, kind) => NX.records.filter((r) => r.file === file && r.kind === kind);

// ---------------------------------------------------------------------------
// A Nexacro client
// ---------------------------------------------------------------------------

test('an .xfdl is one screen: the form id, the title it shows, and its path under the client', () => {
  const t = nxOf(FORM, 'template');
  assert.equal(t.length, 1);
  assert.equal(t[0].engine, 'nexacro');
  assert.equal(t[0].formId, 'UserList');
  assert.equal(t[0].title, 'User list');
  assert.equal(t[0].root, 'app');
  assert.equal(t[0].name, 'Pattern/UserList', 'the screen path is the file\'s path under the client root');
  assert.equal(t[0].suffix, '.xfdl');
});

test('the form pulls in the shared script it includes, resolved through the typedef', () => {
  const t = nxOf(FORM, 'template')[0];
  assert.deepEqual(t.includes, [{
    written: 'Lib::Comm.xjs', kind: 'nexacro-include', name: 'Lib::Comm.xjs', file: LIB,
  }]);
});

test('a form\'s handlers are functions, not one anonymous module body', () => {
  const names = nxOf(FORM, 'function').map((r) => r.name).sort();
  assert.deepEqual(names, ['fn_native', 'fn_save', 'fn_search', 'fn_unreadable', 'form_onload']);
});

test('both transaction forms are read: the options object, and the native second argument', () => {
  const calls = nxOf(FORM, 'call');
  const byLine = new Map(calls.map((c) => [c.line, c]));

  const search = byLine.get(lineOf(NEXACRO, FORM, /Iject\.transaction\(this, oDatas, function\(\)\{\}\);/));
  assert.equal(search.enclosing, 'fn_search');
  assert.equal(search.nexacro.from, 'sController');
  assert.equal(search.nexacro.written, 'userSelectVO.do');
  assert.deepEqual(search.url.resolved, [{ template: '/userSelectVO.do' }]);
  assert.deepEqual(search.method, { value: 'ANY', from: 'nexacro-transaction' });

  const native = byLine.get(lineOf(NEXACRO, FORM, /svcurl::selectCodeList\.do/));
  assert.equal(native.enclosing, 'fn_native');
  assert.equal(native.nexacro.from, 'argument');
  assert.equal(native.nexacro.prefix, 'svcurl');
  assert.equal(native.nexacro.base, '/demo-app');
  assert.deepEqual(native.url.resolved, [{ template: '/demo-app/selectCodeList.do' }],
    'the service prefix resolves through the typedef, and the url\'s PATH part is the base');
});

test('two options objects of the same name in two handlers are two different urls', () => {
  const calls = nxOf(FORM, 'call');
  const urls = calls.filter((c) => c.url).map((c) => c.nexacro.written).sort();
  assert.deepEqual(urls, ['svcurl::selectCodeList.do', 'userModifyVO.do', 'userSelectVO.do'],
    'the options object is looked up in the handler that holds it, not once for the file');
});

test('a transaction whose url this lane cannot read is recorded and counted, not dropped', () => {
  const unreadable = nxOf(FORM, 'call').filter((c) => c.url === null);
  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0].enclosing, 'fn_unreadable');
  assert.deepEqual(unreadable[0].nexacro, { from: 'unreadable' });
});

test('an .xjs is a script of the same client: read, and its transaction read with it', () => {
  const calls = nxOf(LIB, 'call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].enclosing, 'commonSearch');
  assert.deepEqual(calls[0].url.resolved, [{ template: '/commonSelect.do' }]);
  const t = nxOf(LIB, 'template');
  assert.equal(t.length, 1, 'a shared script is a template record, so a form can render what it includes');
  assert.equal(t[0].engine, 'nexacro-script', 'and its engine says it is NOT a screen');
});

test('the Nexacro run is deterministic: the same tree prints the same bytes', () => {
  assert.equal(run(NEXACRO, path.join(NEXACRO, 'app')).raw, NX.raw);
});

test('the client\'s forms become screens, and each renders its own script and its include', () => {
  const g = new Graph();
  const stats = addWebFacts(g, NX.records.filter((r) => r.kind !== 'header' && r.kind !== 'summary'), {
    screenAxis: { enabled: true },
  });
  const screen = nodeId('screen', '/Pattern/UserList');
  const node = g.nodes.get(screen);
  assert.ok(node, 'the form is a screen node keyed by its path under the client');
  assert.equal(node.source, 'nexacro');
  assert.equal(node.name, 'UserList');
  assert.equal(node.title, 'User list');
  assert.equal(node.path, '/Pattern/UserList');
  assert.equal(stats.screens.byKind.nexacro, 1);

  const renders = g.edges.filter((e) => e.type === 'RENDERS' && e.from === screen);
  const own = renders.filter((e) => e.evidence.rule === 'template-own');
  const included = renders.filter((e) => e.evidence.rule === 'template-include');
  assert.ok(own.length > 0, 'the screen renders its own script');
  assert.ok(own.every((e) => e.grade === 'EXACT'));
  assert.ok(included.length > 0, 'and the script it includes, one hop out');
  assert.ok(included.every((e) => e.grade === 'SOUND_SET' && e.evidence.depth === 1));
  assert.equal(stats.calls.nexacro, 4);
  assert.equal(stats.calls.nexacroUnreadable, 1);
});

test('a transaction is graded by the route match, under its own rule', () => {
  const g = new Graph();
  g.addNode({ id: nodeId('endpoint', 'ANY /userSelectVO.do'), kind: 'endpoint', path: '/userSelectVO.do', httpMethod: 'ANY' });
  const stats = addWebFacts(g, NX.records.filter((r) => r.kind !== 'header' && r.kind !== 'summary'), {
    screenAxis: { enabled: true },
  });
  const hit = g.edges.filter((e) => e.type === 'CALLS_HTTP' && e.evidence.url.template === '/userSelectVO.do');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].grade, 'SOUND_SET');
  assert.equal(hit[0].evidence.rule, 'nexacro-transaction');
  assert.equal(hit[0].evidence.match, 'exact');
  assert.equal(hit[0].evidence.target, 'in-pack');
  assert.equal(hit[0].evidence.sink.kind, 'nexacro');
  assert.equal(hit[0].evidence.nexacro.from, 'sController');
  assert.equal(stats.resolved.SOUND_SET, 1);
});

// ---------------------------------------------------------------------------
// A Next.js frontend: the file tree IS the route table
// ---------------------------------------------------------------------------

const nextRoutes = () => NEXT_RUN.records.filter((r) => r.kind === 'route');

test('a page is a page because of where it sits, and the parameter spellings are read', () => {
  const paths = nextRoutes().map((r) => r.path).sort();
  assert.deepEqual(paths, ['/', '/board/{skin}/{id}', '/docs/{slug}/**', '/privacy']);
  for (const r of nextRoutes()) {
    assert.equal(r.pack, 'next-pages');
    assert.equal(r.componentSelf, true, 'a file-tree page IS its own component');
    assert.equal(r.from, 'filesystem');
    assert.equal(r.line, 1);
  }
});

test('the framework\'s own files are not pages, and `pages/api` is a server handler', () => {
  const files = nextRoutes().map((r) => r.file);
  assert.ok(!files.some((f) => f.includes('_app')), '_app is the framework\'s, not a page');
  assert.ok(!files.some((f) => f.includes('/api/')), 'pages/api is a handler this frontend serves');
  const summary = NEXT_RUN.records[NEXT_RUN.records.length - 1];
  assert.equal(summary.apiFiles, 1, 'and it is COUNTED, not silently dropped');
  assert.equal(summary.routes, 4);
  assert.deepEqual(summary.byPack, { 'next-pages': 4 });
});

test('a file-tree page becomes a screen whose component is the page file', () => {
  const g = new Graph();
  const stats = addWebFacts(g, NEXT_RUN.records.filter((r) => r.kind !== 'header' && r.kind !== 'summary'), {
    screenAxis: { enabled: true },
  });
  const screen = g.nodes.get(nodeId('screen', '/board/{skin}/{id}'));
  assert.ok(screen);
  assert.equal(screen.component, 'src/pages/board/[skin]/[id].tsx');
  assert.equal(screen.pack, 'next-pages');
  assert.equal(screen.params, true, 'a `{id}` in the path is a parameter like a `:id` is');
  assert.equal(stats.screens.componentUnresolved, 0, 'nothing had to be resolved, so nothing failed to');
  const renders = g.edges.filter((e) => e.type === 'RENDERS' && e.from === screen.id);
  assert.ok(renders.some((e) => e.evidence.rule === 'route-component' && e.grade === 'EXACT'));
});

test('a package that does not depend on the framework gets no file-tree routes', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'test', 'fixtures', '.tmp-next-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"plain","dependencies":{"react":"17.0.2"}}\n');
    fs.writeFileSync(path.join(dir, 'src', 'pages', 'index.tsx'), 'export default function Home() { return null }\n');
    const out = run(dir, path.join(dir, 'src'));
    assert.deepEqual(out.records.filter((r) => r.kind === 'route'), [],
      'the convention belongs to a framework, and this package does not declare it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
