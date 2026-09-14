// snapshot.test.mjs — one Flow or Impact answer, exported as one HTML file.
//
// What an exported file has to be, checked the way a reader would find it wrong:
// it must ask for nothing (no server path left in it, no fetch when it boots),
// it must carry the tool's answer unchanged (grades, limits and cut lists are
// read from that answer), it must draw the picture through the same code the
// live page draws with, and a question it does not hold must be SAID, never
// guessed. The live page's Export button and `cascade export` must write the
// same file for the same question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SNAPSHOT_SCHEMA, SnapshotError, snapshotFilename, snapshotHtml, snapshotQuery, snapshotQueryFromArgs,
} from '../src/viewer/snapshot.mjs';
import { exportSnapshot } from '../src/cli/snapshot_export.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { bootPage as boot, ev } from './helpers/viewer_page.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AT = '2026-09-14T00:00:00.000Z';

/** The snapshot data a file carries, read back out of it the way the page reads it. */
function carried(html) {
  const m = /<script>window\.CASCADE_SNAPSHOT=([\s\S]*?);<\/script>/.exec(html);
  assert.ok(m, 'the file carries its snapshot');
  return JSON.parse(m[1]);
}

/** Boot a file with NO server behind it: every fetch fails the test. */
async function bootFile(html) {
  return boot({ html, answer: (url) => { throw new Error(`an exported file asked the network for ${url}`); } });
}

// ---------------------------------------------------------------------------
// the question
// ---------------------------------------------------------------------------

test('a question is built the way the page asks it: entry, mode, depth, limit, and up for Impact', () => {
  assert.deepEqual(snapshotQuery('flow', { kind: 'endpoint', value: 'GET /rows' }).args,
    { endpoint: 'GET /rows', mode: 'conservative', depth: 6, limit: 40 });
  assert.deepEqual(snapshotQuery('impact', { kind: 'column', value: 'delta_rows.status', mode: 'strict', depth: 3, limit: 10 }).args,
    { direction: 'up', column: 'delta_rows.status', mode: 'strict', depth: 3, limit: 10 });
  // A screen opens deeper, and the page raises the control from its route default
  // to the screen's, so the file asks what the page would have asked.
  assert.equal(snapshotQuery('flow', { kind: 'screen', value: '/rows' }).args.depth, 8);
  assert.equal(snapshotQuery('flow', { kind: 'screen', value: '/rows', depth: 6 }).args.depth, 8);
  assert.equal(snapshotQuery('flow', { kind: 'screen', value: '/rows', depth: 3 }).args.depth, 3);
  // The page's own arguments come back to the same question.
  const q = snapshotQuery('impact', { kind: 'table', value: 'delta_rows' });
  assert.deepEqual(snapshotQueryFromArgs('impact', q.args), q);
});

test('a question the tabs cannot ask is refused with the reason, before any tool runs', () => {
  const refused = (fn, re) => assert.throws(fn, (e) => e instanceof SnapshotError && e.code === 'bad-input' && re.test(e.message));
  refused(() => snapshotQuery('graph', { kind: 'endpoint', value: 'x' }), /flow or the impact tab/);
  refused(() => snapshotQuery('flow', { kind: 'column', value: 'a.b' }), /starts from endpoint, screen, symbol/);
  refused(() => snapshotQuery('flow', { kind: 'endpoint', value: '  ' }), /name the endpoint/);
  refused(() => snapshotQuery('flow', { kind: 'endpoint', value: 'x', mode: 'loose' }), /mode must be/);
  refused(() => snapshotQuery('flow', { kind: 'endpoint', value: 'x', depth: 9 }), /depth must be a whole number from 1 to 8/);
  refused(() => snapshotQuery('flow', { kind: 'endpoint', value: 'x', limit: 0 }), /limit must be/);
});

test('the file name says the project, the tab and the entry, and nothing a file system chokes on', () => {
  const q = snapshotQuery('flow', { kind: 'endpoint', value: 'POST /product/update/{id}' });
  assert.equal(snapshotFilename('mall', q), 'cascade-mall-flow-post-product-update-id.html');
});

test('a page that loads an asset the generator does not know is refused, not written half-offline', () => {
  const html = '<html lang="en" data-theme="signal"><head><title>x</title></head><body><script src="/somewhere/else.js"></script></body></html>';
  assert.throws(() => snapshotHtml({ html, snapshot: { lang: 'en' }, title: 't', readScript: () => '', readLib: () => '', readFont: () => Buffer.alloc(0) }),
    (e) => e.code === 'contract-violation' && /\/somewhere\/else\.js/.test(e.message));
  const stray = '<html lang="en" data-theme="signal"><head><title>x</title></head><body><img src="/logo.png"></body></html>';
  assert.throws(() => snapshotHtml({ html: stray, snapshot: { lang: 'en' }, title: 't', readScript: () => '', readLib: () => '', readFont: () => Buffer.alloc(0) }),
    (e) => e.code === 'contract-violation' && /still points at the server/.test(e.message));
});

// ---------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------

test('the file points at no server and carries the tool answer exactly as the tool gave it', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { screen: '/rows' }, generatedAt: AT });
  assert.equal(out.filename, 'cascade-delta-flow-rows.html');
  assert.equal(out.bytes, Buffer.byteLength(out.html, 'utf8'));
  assert.doesNotMatch(out.html, /(?:src|href)="\/(?!\/)|url\("\/(?!\/)/, 'no path is left pointing at a server');
  const bundle = fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'vendor', 'force-graph.min.js'), 'utf8').slice(0, 200);
  assert.equal(out.html.includes(bundle), false, 'the Graph tab renderers are not carried');
  assert.match(out.html, /<html lang="en" data-theme="drawing">/, 'a report opens in the light theme');
  const snap = carried(out.html);
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  assert.equal(snap.generatedAt, AT);
  assert.deepEqual(snap.args, { screen: '/rows', mode: 'conservative', depth: 8, limit: 40 });
  const flow = snap.calls.find((c) => c.name === 'flow');
  assert.deepEqual(flow.answer, host.callTool('flow', { ...snap.args, project: 'delta' }),
    'the answer in the file is the answer the tool gives: basis, trust, limits and cut lists with it');
  assert.ok(flow.answer.basis && flow.answer.trust, 'and it is an answer with its basis and its trust');
});

test('the file boots with no network, draws the chain, and says in its band what it is', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { screen: '/rows' }, generatedAt: AT });
  const page = await bootFile(out.html);
  assert.deepEqual(page.calls, [], 'it asked the network for nothing');
  assert.equal(ev(page.ctx, 'JSON.stringify(SNAP_MISSES)'), '[]', 'and every question it asked was one it holds');
  assert.equal(ev(page.ctx, 'STATE.tab'), 'flow');
  assert.ok(ev(page.ctx, 'FLOWV.rows.size') > 0, 'the chain is drawn');
  assert.equal(ev(page.ctx, 'document.body.classList.contains("snapshot")'), true);
  assert.equal(page.byId.get('fdepth').disabled, true, 'the controls that would ask another question are off');
  const band = page.byId.get('snapbar');
  assert.equal(band.classList.contains('hidden'), false);
  const text = band.textContent;
  assert.match(text, /Flow from screen \/rows, mode conservative, depth 8, up to 40 rows/);
  assert.match(text, new RegExp(`exported ${AT.replace(/\./g, '\\.')} from pack [0-9a-f]{12}`));
  const flow = carried(out.html).calls.find((c) => c.name === 'flow').answer;
  assert.match(text, new RegExp(`this answer: trust UNCERTIFIED, ${flow.limits.length} limit\\(s\\), 0 cut list\\(s\\)`),
    'a list shown whole is not counted as cut');
});

test('a list the answer really cut is counted as cut, in the band and on the command line', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { screen: '/rows', limit: 1 }, generatedAt: AT });
  const flow = out.snapshot.calls.find((c) => c.name === 'flow').answer;
  const cut = flow.truncated.fields.filter((f) => f.shown < f.total);
  assert.ok(cut.length > 0, `the fixture has a lane longer than one row: ${JSON.stringify(flow.truncated.fields)}`);
  const page = await bootFile(out.html);
  assert.match(page.byId.get('snapbar').textContent, new RegExp(`${cut.length} cut list\\(s\\)`));
});

test('a question the file does not hold is answered with a sentence, not a guess', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'impact', args: { column: 'delta_rows.status', direction: 'up' }, generatedAt: AT });
  const page = await bootFile(out.html);
  assert.deepEqual(page.calls, []);
  assert.equal(ev(page.ctx, 'STATE.tab'), 'impact');
  assert.ok(ev(page.ctx, 'IMPACTV.rows.size') > 0);
  const miss = await ev(page.ctx, "api('flow',{endpoint:'GET /rows',mode:'strict',depth:1,limit:1}).then(()=>null,(e)=>[e.code,e.message])");
  assert.equal(miss[0], 'not-in-snapshot');
  assert.match(miss[1], /holds only the answer it was exported with/);
  const src = await ev(page.ctx, "fetchSource('table:delta_rows').then(()=>null,(e)=>e.code)");
  assert.equal(src, 'not-in-snapshot', 'the source pane says the file has no working tree');
});

test('a file exported in Korean carries that catalogue and boots in it', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { endpoint: 'GET /rows' }, lang: 'ko', generatedAt: AT });
  const snap = carried(out.html);
  assert.deepEqual(Object.keys(snap.catalogs), ['ko']);
  assert.match(out.html, /<html lang="ko" data-theme="drawing">/);
  const page = await bootFile(out.html);
  assert.equal(ev(page.ctx, 'I18N.lang'), 'ko');
  assert.match(page.byId.get('snapbar').textContent, /이 답의 신뢰/);
});

// ---------------------------------------------------------------------------
// the two doors
// ---------------------------------------------------------------------------

test('POST /api/export returns the file, and a bad question is a 400 with the reason', () => {
  const deps = { exportSnapshot: (r) => ({ filename: `f-${r.tab}.html`, bytes: 3, html: '<p>' }) };
  const ok = handleApi('POST', '/api/export', { tab: 'flow', arguments: { endpoint: 'GET /x' } }, deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.answer, { filename: 'f-flow.html', bytes: 3, html: '<p>' });
  assert.equal(handleApi('GET', '/api/export', null, deps).status, 405);
  assert.equal(handleApi('POST', '/api/export', { tab: 'flow' }, {}).status, 404);
  const refused = handleApi('POST', '/api/export', { tab: 'graph', arguments: {} },
    { exportSnapshot: (r) => snapshotQueryFromArgs(r.tab, r.args) });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'bad-input');
});

test('the Export button is off until a chain is drawn, then posts the question that chain answered', async (t) => {
  const { html, base } = await startViewer(t, ['delta']);
  const page = await boot({ html, hash: '#p=delta&tab=flow', origin: base, answer: (url, opts) => fetch(base + url, opts) });
  assert.equal(page.byId.get('fexport').disabled, true);
  await ev(page.ctx, "openFlow({screen:'/rows'})");
  for (let i = 0; i < 20 && !ev(page.ctx, 'FLOWV.resp'); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(page.byId.get('fexport').disabled, false);
  // The browser's download is not here; what the page SENT is what is checked.
  page.sandbox.URL.createObjectURL = () => 'blob:x';
  page.sandbox.URL.revokeObjectURL = () => {};
  page.sandbox.Blob = class { constructor(parts) { this.parts = parts; } };
  await ev(page.ctx, 'exportChain(FLOWV)');
  const sent = page.calls.find((c) => c.url === '/api/export');
  assert.ok(sent, 'the page asked the server for the file');
  assert.equal(JSON.stringify(sent.body.arguments), ev(page.ctx, 'JSON.stringify(FLOWV.args)'));
  assert.deepEqual({ ...sent.body, arguments: null }, { tab: 'flow', arguments: null, lang: 'en', format: 'html', project: 'delta' });
  assert.deepEqual(sent.body.arguments, { screen: '/rows', mode: 'conservative', depth: 8, limit: 40 });
});

test('cascade export writes the same file the Export button gets, from a pack on disk', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const packDir = host.ctxFor('delta').packDir;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-export-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const cli = (args) => spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'export', '--pack', packDir, ...args],
    { encoding: 'utf8', env: { ...process.env, CASCADE_HOME: work } });
  const out = path.join(work, 'x.html');
  const run = cli(['--endpoint', 'GET /rows', '--out', out]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrote .*x\.html \(\d+ bytes\): flow from endpoint GET \/rows, mode conservative, depth 6, limit 40/);
  assert.match(run.stdout, /trust \w+, \d+ limit\(s\), 0 cut list\(s\)/);
  const fromCli = carried(fs.readFileSync(out, 'utf8'));
  // The button's file for the same question carries the same answers; only the
  // moment it was written, and the project id a bare pack is served under, differ.
  const fromButton = exportSnapshot(host, { tab: 'flow', args: { endpoint: 'GET /rows' }, generatedAt: AT }).snapshot;
  const answers = (snap) => JSON.stringify(snap.calls.map((c) => [c.name, c.args, c.answer.answer]));
  assert.equal(answers(fromCli), answers(fromButton));
  const bad = cli(['--tab', 'impact', '--endpoint', 'GET /x']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /the impact tab does not start from --endpoint/);
  const two = cli(['--endpoint', 'GET /rows', '--screen', '/rows']);
  assert.notEqual(two.status, 0);
  assert.match(two.stderr, /name exactly one place the flow picture starts from/);
});
