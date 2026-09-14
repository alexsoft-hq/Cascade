// websquare.test.mjs — a WebSquare client, read as the screens and the requests it is.
//
// A WebSquare screen is an XML page: it DECLARES its requests in the model
// (`<xf:submission id action method>`) and SENDS one from script by naming it
// (`$c.sbm.execute(sbm_x)`, `$p.executeSubmission("sbm_x")`, or an options object
// with the address in it). One fixture holds every shape, beside the three things
// under a WebSquare root that are not screens: a COMMON library page, the engine's
// own runtime, and an XML file that is no page at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { loadPack, projectPack } from '../src/core/pack.mjs';
import {
  isWebSquarePage, submissionSinks, websquarePageOf, websquareScriptBlocks, websquareSubmissions,
} from '../adapters/web/lib/websquare.mjs';
import { addWebFacts } from '../src/adapters/web_bridge.mjs';
import { discover } from '../src/core/discover.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { DISCOVER_IO } from '../src/cli/env.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER = path.join(ENGINE_ROOT, 'adapters', 'web', 'webfacts.mjs');
const FIXTURE = path.join(ENGINE_ROOT, 'test', 'fixtures', 'websquare');
const PAGE = 'WebContent/ui/SP/SP001.xml';

const lines = (out) => out.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
const readClient = () => lines(execFileSync(process.execPath, [
  WORKER, '--root', FIXTURE, path.join(FIXTURE, 'WebContent'),
], { maxBuffer: 1 << 26 }).toString('utf8'));

// ---------------------------------------------------------------------------
// the page, read as text
// ---------------------------------------------------------------------------

const TEXT = `<?xml version="1.0"?>
<html xmlns:w2="http://www.inswave.com/websquare" xmlns:xf="http://www.w3.org/2002/xforms">
  <head meta_screenId="SP9" meta_screenName="Orders"><w2:type>COMPONENT</w2:type>
    <xf:model>
      <xf:submission id="sbm_a" action="/orders/list" method="get"/>
      <xf:submission id="sbm_b" action="/orders/save"></xf:submission>
    </xf:model>
    <script type="text/javascript"><![CDATA[
scwin.go = function () { $c.sbm.execute(sbm_a); };
]]></script>
    <script src="/cm/common.js"></script>
  </head>
</html>`;

test('a page is a WebSquare page by the namespace on its root element, and nothing else is', () => {
  assert.equal(isWebSquarePage(TEXT), true);
  assert.equal(isWebSquarePage('<beans xmlns="http://www.springframework.org/schema/beans"/>'), false);
  assert.equal(isWebSquarePage('<mapper namespace="x.Mapper"/>'), false);
});

test('a page names its screen on <head> and says whether it is a library', () => {
  assert.deepEqual(websquarePageOf(TEXT), { id: 'SP9', title: 'Orders', type: 'COMPONENT' });
  assert.equal(websquarePageOf('<head/><w2:type>COMMON</w2:type>').type, 'COMMON');
});

test('every submission is declared by id, and a submission naming no method posts', () => {
  const subs = websquareSubmissions(TEXT);
  assert.deepEqual([...subs.keys()], ['sbm_a', 'sbm_b']);
  assert.deepEqual({ ...subs.get('sbm_a'), line: undefined }, { action: '/orders/list', method: 'GET', line: undefined });
  assert.equal(subs.get('sbm_b').method, 'POST');
  assert.equal(subs.get('sbm_a').line, 5);
});

test('a page\'s script comes out of its CDATA with the page\'s own line numbers, and a src script is not read', () => {
  const blocks = websquareScriptBlocks(TEXT);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].code, /^\nscwin\.go = function/);
  assert.equal(blocks[0].line, 8);
});

test('which calls send a submission is the pack\'s declaration', () => {
  const sinks = submissionSinks([{ submissionSinks: [{ receiver: '$c.sbm', method: 'execute' }, { receiver: '$p', method: 'executeSubmission', argIs: 'id' }] }]);
  assert.deepEqual([...sinks.keys()], ['$c.sbm execute', '$p executeSubmission']);
  assert.equal(sinks.get('$c.sbm execute').argIs, 'submission');
});

// ---------------------------------------------------------------------------
// the worker, over the fixture
// ---------------------------------------------------------------------------

test('under a WebSquare root only its pages are read: not the engine\'s runtime, not a non-page XML', () => {
  const files = readClient().filter((r) => r.kind === 'file').map((r) => [r.file, r.lang]);
  assert.deepEqual(files, [
    ['WebContent/cm/gcc/lib.xml', 'websquare'],
    ['WebContent/ui/SP/SP001.xml', 'websquare'],
    ['WebContent/ui/SP/SP002.xml', 'websquare'],
  ]);
  const engines = readClient().filter((r) => r.kind === 'template').map((r) => [r.name, r.engine, r.formId]);
  assert.deepEqual(engines, [
    ['cm/gcc/lib', 'websquare-library', '$c.lib'],
    ['ui/SP/SP001', 'websquare', 'SP001'],
    ['ui/SP/SP002', 'websquare', 'SP002'],
  ]);
});

test('every way a page sends a submission is one call, with the declaration\'s address and method', () => {
  const calls = readClient().filter((r) => r.kind === 'call' && r.file === PAGE);
  const seen = calls.map((c) => [c.enclosing, c.url?.resolved?.[0]?.template ?? null, c.method?.value ?? null, c.websquare.from]);
  assert.deepEqual(seen, [
    ['scwin.btn_search_onclick', '/sample/search', 'POST', 'declared'],
    // `$p.executeSubmission("id")` names it by a string, and the query is not part of the route.
    ['scwin.btn_detail_onclick', '/sample/detail', 'GET', 'declared'],
    // A submission naming no method posts, as WebSquare does.
    ['scwin.btn_save_onclick', '/sample/save', 'POST', 'declared'],
    // An options object bound to a name carries the address itself.
    ['scwin.loadCodes', '/common/codes', 'POST', 'options'],
    // A submission the page never declared is a request this lane cannot follow.
    ['scwin.btn_missing_onclick', null, null, 'undeclared'],
  ]);
});

test('opening another page is a navigation, and the engine\'s own API is no request at all', () => {
  const records = readClient().filter((r) => r.file === PAGE);
  const navs = records.filter((r) => r.kind === 'navigation');
  assert.deepEqual(navs.map((n) => [n.sink, n.to.resolved[0].template]), [['$c.win.openPopup', '/ui/SP/SP002.xml']]);
  assert.equal(records.some((r) => r.kind === 'call' && r.enclosing === 'scwin.readConfig'), false);
});

// ---------------------------------------------------------------------------
// the bridge, and discovery
// ---------------------------------------------------------------------------

/** A graph serving the fixture's routes, each with its handler. */
function backend(routes) {
  const g = new Graph();
  for (const [key, handler] of Object.entries(routes)) {
    const [httpMethod, p] = key.split(' ');
    const epId = nodeId('endpoint', key);
    const symId = nodeId('symbol', handler);
    g.addNode({ id: epId, path: p, httpMethod, handler, source: 'java' });
    g.addNode({ id: symId, symbol: handler, owner: handler.split('#')[0], file: 'X.java', line: 1 });
    g.addEdge({ from: epId, to: symId, type: 'HANDLES', grade: 'EXACT' });
  }
  return g;
}

test('a page is a screen at the address the application opens it by, and its submissions are its calls', () => {
  const g = backend({
    'ANY /sample/search': 'x.SampleController#search',
    'GET /sample/detail': 'x.SampleController#detail',
    'ANY /common/codes': 'x.CodeController#codes',
  });
  const stats = addWebFacts(g, readClient(), { screenAxis: { enabled: true } });
  const screens = [...g.nodes.values()].filter((n) => n.kind === 'screen').map((n) => [n.id, n.source, n.name, n.title]);
  assert.deepEqual(screens, [
    ['screen:/ui/SP/SP001.xml', 'websquare', 'SP001', 'Sample list'],
    ['screen:/ui/SP/SP002.xml', 'websquare', 'SP002', 'Sample popup'],
  ]);
  assert.equal(stats.screens.byKind.websquare, 2);
  assert.equal(stats.calls.websquare, 4);
  const placed = new Map(g.edges.filter((e) => e.type === 'CALLS_HTTP').map((e) => [`${e.from.split('#')[1]} ${e.to}`, e.grade]));
  assert.equal(placed.get('scwin.btn_search_onclick endpoint:ANY /sample/search'), 'SOUND_SET');
  // The edge names its rule and says in a sentence why it is a request, with the submission it sent.
  const edge = g.edges.find((e) => e.type === 'CALLS_HTTP' && e.to === 'endpoint:ANY /sample/search');
  assert.equal(edge.evidence.rule, 'websquare-submission');
  assert.match(edge.evidence.basis, /declares in its own model/);
  assert.deepEqual(edge.evidence.websquare, { submission: 'sbm_search', from: 'declared' });
  // Every value on the graph survives being written and read back: a pack of this
  // client once failed its own digest, because an edge carried an undefined basis.
  const pack = JSON.parse(JSON.stringify(projectPack(g)));
  assert.doesNotThrow(() => loadPack(pack, { verifyDigest: true }));
  assert.equal(placed.get('scwin.btn_detail_onclick endpoint:GET /sample/detail'), 'SOUND_SET');
  assert.equal(placed.get('scwin.loadCodes endpoint:ANY /common/codes'), 'SOUND_SET');
  // A route this pack does not serve is a call onto nothing here, and says so.
  assert.equal(placed.get('scwin.btn_save_onclick endpoint:POST /sample/save'), 'UNRESOLVED');
  // The popup the first page opens is a screen this pack declares, recorded on the page.
  const first = g.nodes.get('screen:/ui/SP/SP001.xml');
  assert.deepEqual(first.navigatesTo.map((n) => n.to), ['screen:/ui/SP/SP002.xml']);
});

test('a run that built screens from WebSquare pages ships the screen axis, though it declares no route', () => {
  const g = backend({ 'ANY /sample/search': 'x.SampleController#search' });
  const stats = addWebFacts(g, readClient(), { screenAxis: { enabled: true } });
  const axis = declareAxes({ ddl: false, statements: false, code: false, web: stats }).screen;
  assert.notEqual(axis.status, 'not-shipped', axis.reason);
  if (axis.reason !== null) assert.doesNotMatch(axis.reason, /Nexacro/);
});

test('the client root is the deepest directory holding nine pages in ten, not every page\'s common ancestor', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-websquare-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const page = '<html xmlns:w2="http://www.inswave.com/websquare"><head meta_screenId="p"/></html>';
  for (let i = 0; i < 9; i += 1) {
    fs.mkdirSync(path.join(tmp, 'WebContent', 'ui', `M${i}`), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'WebContent', 'ui', `M${i}`, 'page.xml'), page);
  }
  // One page outside the application: a template a tooling folder keeps.
  fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tools', 'template.xml'), page);
  const roots = discover(tmp, DISCOVER_IO).webVendoredRoots.filter((r) => r.kind === 'websquare');
  assert.deepEqual(roots.map((r) => [r.root, r.files]), [['WebContent/ui', 9]]);
});
