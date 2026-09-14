// chain_svg.test.mjs — the SVG picture of one answer, held against the answer it draws.
//
// A picture is read with nothing around it, so each thing a reader needs to
// judge it is checked against the answer itself: every row is drawn, every link
// whose two ends are drawn is drawn with its grade's dash, a cut lane says how
// much it left out, the band names the question and what the answer is worth,
// and every limit is written out. Nothing in the file points anywhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GRADE_DASH, chainModel, wrapText } from '../src/viewer/chain_svg.mjs';
import { exportSnapshot } from '../src/cli/snapshot_export.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AT = '2026-09-14T00:00:00.000Z';

const count = (s, re) => (s.match(re) ?? []).length;

test('a name wraps at a separator or a capital, the first line stops short of the badge, and no line is one letter', () => {
  assert.deepEqual(wrapText('PmsProductMapper.updateByPrimaryKeySelective', 38, 24), ['PmsProductMapper.', 'updateByPrimaryKeySelective']);
  assert.deepEqual(wrapText('CmsPrefrenceAreaProductRelationMapper.deleteByExample', 38, 24), ['CmsPrefrenceAreaProduct', 'RelationMapper.deleteByExample']);
  assert.deepEqual(wrapText('pms_product_attribute_value', 38, 24), ['pms_product_attribute_', 'value']);
  assert.deepEqual(wrapText('short', 38, 24), ['short']);
  for (const line of wrapText('a'.repeat(100), 38, 24).slice(1)) assert.ok(line.length > 3);
});

test('every row of the answer is drawn, and every link between two drawn rows carries its grade\'s dash', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { screen: '/rows' }, format: 'svg', generatedAt: AT });
  assert.equal(out.format, 'svg');
  assert.equal(out.filename, 'cascade-delta-flow-rows.svg');
  const flow = out.snapshot.calls.find((c) => c.name === 'flow').answer;
  const model = chainModel(flow, 'down');
  const rows = model.lanes.reduce((n, l) => n + l.rows.length, 0);
  assert.equal(count(out.svg, /<g data-key=/g), rows, 'one drawn row per row in the answer');
  assert.ok(model.links.length > 0);
  assert.deepEqual(model.dropped, [], 'in an answer nothing cut, every link finds both its ends');
  assert.equal(count(out.svg, /<path [^>]*data-grade=/g), model.links.length);
  for (const [grade, dash] of Object.entries(GRADE_DASH)) {
    const drawn = [...out.svg.matchAll(new RegExp(`<path [^>]*data-grade="${grade}"[^>]*>`, 'g'))];
    assert.equal(drawn.length, model.links.filter((l) => l.grade === grade).length, grade);
    for (const d of drawn) assert.equal(d[0].includes(`stroke-dasharray="${dash}"`), dash !== null, `${grade} is drawn with its own dash`);
  }
  assert.doesNotMatch(out.svg, /href=|url\((?!data:)/, 'nothing in the picture points anywhere else');
});

test('the band says the question and the worth, every limit is written out, and a cut lane says how much it left out', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'flow', args: { screen: '/rows', limit: 1 }, format: 'svg', generatedAt: AT });
  const flow = out.snapshot.calls.find((c) => c.name === 'flow').answer;
  const cut = flow.truncated.fields.filter((f) => f.shown < f.total);
  assert.ok(cut.length > 0);
  assert.match(out.svg, /Flow from screen \/rows, mode conservative, depth 8, up to 1 rows/);
  assert.match(out.svg, new RegExp(`exported ${AT.replace(/\./g, '\\.')} from pack [0-9a-f]{12}`));
  assert.match(out.svg, new RegExp(`this answer: trust UNCERTIFIED, ${flow.limits.length} limit\\(s\\), ${cut.length} cut list\\(s\\), each one named under the picture`));
  for (const f of cut) assert.match(out.svg, new RegExp(`${f.total - f.shown} more row\\(s\\) here did not fit\\.`));
  for (const lim of flow.limits) assert.ok(out.svg.includes(lim.scope), `limit ${lim.scope} is written out`);
  // A link whose other end was cut is left out, never drawn to the nearest row,
  // and the picture says how many are missing and why.
  const model = chainModel(flow, 'down');
  assert.equal(count(out.svg, /<path [^>]*data-grade=/g), model.links.length);
  assert.ok(model.dropped.length > 0, 'the fixture cut a row some link came from');
  assert.match(out.svg, new RegExp(`${model.dropped.length} link\\(s\\) are not drawn: the row each one comes from is in a list that was cut`));
});

test('a picture exported in Korean is written in Korean, from the same catalogue the page reads', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = exportSnapshot(host, { tab: 'impact', args: { column: 'delta_rows.status', direction: 'up' }, lang: 'ko', format: 'svg', generatedAt: AT });
  assert.match(out.svg, /이 답의 신뢰 UNCERTIFIED/);
  assert.match(out.svg, />대상</, 'the Impact entry lane is the target');
});

test('POST /api/export writes the SVG when asked for it, and refuses a format it has not got', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const deps = { exportSnapshot: (r) => exportSnapshot(host, { ...r, generatedAt: AT }) };
  const ok = handleApi('POST', '/api/export', { tab: 'flow', arguments: { screen: '/rows' }, format: 'svg' }, deps);
  assert.equal(ok.status, 200);
  assert.match(ok.json.answer.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(ok.json.answer.html, undefined);
  const bad = handleApi('POST', '/api/export', { tab: 'flow', arguments: { screen: '/rows' }, format: 'pdf' }, deps);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /format must be html or svg/);
});

test('cascade export --format svg writes the picture beside the page it would have written', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-svg-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const out = path.join(work, 'x.svg');
  const run = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'export', '--pack', host.ctxFor('delta').packDir,
    '--endpoint', 'GET /rows', '--format', 'svg', '--out', out], { encoding: 'utf8', env: { ...process.env, CASCADE_HOME: work } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /is one picture a document can hold/);
  assert.match(fs.readFileSync(out, 'utf8'), /^<svg /);
});
