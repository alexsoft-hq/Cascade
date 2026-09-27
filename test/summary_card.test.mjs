// summary_card.test.mjs — the summary card: an answer at a glance, and nothing the answer does not say.
//
// The card sums one Flow or Impact answer up for a README or a slide, which is
// where a picture is read with nothing around it. So what it may not lose is held
// here against the answer itself: every layer's whole total, its grades and the
// dash of its weakest row, a cut said to be a cut, the walk's own note when it
// stopped early, every limit word for word, a name that stays text, and the same
// bytes every time it is exported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GRADE_DASH, escapeXml } from '../src/viewer/svg_doc.mjs';
import { chainModel, drawingPalette } from '../src/viewer/chain_svg.mjs';
import { gradeCounts, summaryCardSvg, weakestGrade } from '../src/viewer/summary_card.mjs';
import { exportSnapshot } from '../src/cli/snapshot_export.mjs';
import { handleApi } from '../src/mcp/http.mjs';
import { VIEWER_STRINGS, makeT } from '../src/viewer/i18n.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const AT = '2026-09-14T00:00:00.000Z';
const WARN = drawingPalette(fs.readFileSync(path.join(ENGINE_ROOT, 'viewer', 'index.html'), 'utf8')).warn;

/** The card for delta's status column, walked up to its screen. */
const deltaCard = (host, args = {}, extra = {}) => exportSnapshot(host, {
  project: 'delta', tab: 'impact', args: { column: 'delta_rows.status', direction: 'up', ...args }, format: 'card', generatedAt: AT, ...extra,
});
const flowOf = (out) => out.snapshot.calls.find((c) => c.name === 'flow').answer;
const lanesOf = (out) => chainModel(flowOf(out), 'up').lanes.slice(1);

/** Each layer's own markup, by field: from its opening to the next layer's, the last one stopping at the legend. */
function layersOf(svg) {
  const body = svg.slice(0, svg.indexOf('>links walked<'));
  return Object.fromEntries(body.split('<g data-layer="').slice(1).map((seg) => [seg.slice(0, seg.indexOf('"')), seg]));
}

/** What a reader sees: the text of the picture with the tags, the tooltips and the whitespace taken out. */
const visible = (svg) => svg.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, '');
const squeezed = (s) => String(s).replace(/\s+/g, '');
const chipCount = (seg) => (seg.match(/<rect [^>]*rx="4"/g) ?? []).length;

test('the weakest grade is read off the engine\'s lattice, and a layer\'s grades are counted strongest first', () => {
  const rows = [{ grade: 'SOUND_SET' }, { grade: 'EXACT' }, { grade: 'HEURISTIC' }, { grade: 'SOUND_SET' }, {}];
  assert.equal(weakestGrade(rows), 'HEURISTIC');
  assert.equal(weakestGrade([]), null);
  assert.deepEqual(gradeCounts(rows), [['EXACT', 1], ['SOUND_SET', 2], ['HEURISTIC', 1]]);
});

test('every layer is drawn with its whole total, its names in the answer\'s order, a badge per grade, and a rail dashed by its weakest row', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = deltaCard(host);
  assert.equal(out.format, 'card');
  assert.equal(out.filename, 'cascade-delta-impact-delta-rows-status.card.svg');
  const lanes = lanesOf(out);
  const layers = layersOf(out.svg);
  assert.deepEqual(Object.keys(layers), lanes.map((l) => l.field), 'one layer per lane, in the lanes\' order');
  for (const lane of lanes) {
    const seg = layers[lane.field];
    assert.ok(seg.includes(`class="t n">${lane.total}</text>`), `${lane.field} shows its total`);
    for (const [grade, n] of gradeCounts(lane.rows)) assert.ok(seg.includes(`>${grade} ${n}</text>`), `${lane.field} carries a ${grade} badge`);
    const weakest = weakestGrade(lane.rows);
    const rail = seg.match(/<line [^>]*>/)[0];
    assert.ok(rail.includes(`data-grade="${weakest}"`), `${lane.field}'s rail is its weakest grade`);
    assert.equal(rail.includes(`stroke-dasharray="${GRADE_DASH[weakest]}"`), GRADE_DASH[weakest] !== null, `${lane.field}'s rail is dashed as ${weakest} is`);
    const at = lane.rows.slice(0, chipCount(seg)).map((r) => seg.indexOf(`>${escapeXml(r.name)}</text>`));
    assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), `${lane.field}'s names keep the answer's order`);
  }
  assert.doesNotMatch(out.svg, /href=|url\((?!data:)/, 'nothing in the card points anywhere else');
});

test('a cut layer counts from the whole total, says its grades cover only the rows shown, and "+N more" counts the rest', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = deltaCard(host, { limit: 1 });
  const flow = flowOf(out);
  const cut = flow.truncated.fields.filter((f) => f.shown < f.total);
  assert.ok(cut.length > 0, 'the fixture cut at least one lane');
  const layers = layersOf(out.svg);
  for (const lane of lanesOf(out).filter((l) => l.shown < l.total)) {
    const seg = layers[lane.field];
    assert.ok(seg.includes(`class="t n">${lane.total}</text>`), `${lane.field} shows ${lane.total}, not the ${lane.shown} shown`);
    assert.ok(seg.includes(`(grades of the ${lane.shown} shown)`), `${lane.field} says its grades are the shown rows'`);
    assert.ok(seg.includes(`>+${lane.total - chipCount(seg)} more</text>`), `${lane.field}'s "+N more" counts from the whole total`);
  }
  assert.ok(out.svg.includes(`fill="${WARN}">trust UNCERTIFIED, ${flow.limits.length} limit(s), ${cut.length} cut list(s)</text>`));
});

test('a walk that stopped early says so in the warning ink, and a layer it never reached reads "none reached"', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = deltaCard(host, { depth: 2 });
  const note = flowOf(out).answer.walk.note;
  assert.ok(note, 'a depth of 2 stops the walk before the screens');
  assert.ok(out.svg.includes(`fill="${WARN}">${escapeXml(note.slice(0, 30))}`), 'the note opens in the warning ink');
  assert.ok(visible(out.svg).includes(squeezed(note)), 'the note is there word for word');
  const empty = lanesOf(out).filter((l) => l.total === 0);
  assert.ok(empty.length > 0);
  for (const lane of empty) {
    const seg = layersOf(out.svg)[lane.field];
    assert.ok(seg.includes('class="t n">0</text>') && seg.includes('>none reached</text>'), `${lane.field} says it was not reached`);
    assert.ok(seg.match(/<line [^>]*>/)[0].includes('data-grade=""'), `${lane.field}'s rail carries no grade`);
  }
});

test('every limit is written out word for word, and the pack and the question are named', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = deltaCard(host);
  const flow = flowOf(out);
  assert.ok(flow.limits.length > 0, 'the fixture answer carries limits');
  for (const lim of flow.limits) assert.ok(visible(out.svg).includes(squeezed(`${lim.scope}: ${lim.reason}`)), `limit ${lim.scope} is written out whole`);
  assert.match(out.svg, /delta, pack [0-9a-f]{12}, built [^,]+, mode conservative, depth 8, Cascade /);
});

test('a name is text and never markup, and a name too long for its chip keeps its whole self in a tooltip', () => {
  const long = `Mapper.<script>x</script>${'a'.repeat(60)}`;
  const snap = {
    tab: 'impact', args: { mode: 'conservative', depth: 8 }, meta: { digest: 'abc', builtAt: AT }, project: { id: 'p' }, engine: { version: 'x' },
    calls: [{ name: 'flow', answer: {
      answer: {
        entry: { kind: 'column', short: 't.<b>c</b>', start: 'column:t.c', comment: '"quoted" & <i>' },
        statements: [{ id: 's', short: long, grade: 'EXACT', link: { from: 'column:t.c' } }],
        walk: { byLinkGrade: { EXACT: 1 } },
      },
      limits: [{ scope: '<s>', reason: 'a & b' }], trust: { trustLevel: 'UNCERTIFIED' }, truncated: { fields: [] },
    } }],
  };
  const svg = summaryCardSvg(snap, { t: makeT(VIEWER_STRINGS, 'en') });
  assert.doesNotMatch(svg, /<script|<b>|<i>|<s>/, 'no name, comment or limit became markup');
  assert.ok(svg.includes('t.&lt;b&gt;c&lt;/b&gt;') && svg.includes('&quot;quoted&quot; &amp; &lt;i&gt;'));
  assert.ok(svg.includes(`<title>${escapeXml(long)}</title>`), 'the whole name is in the tooltip');
  assert.ok(svg.includes('…'), 'the chip shows it cut');
  assert.ok(visible(svg).includes('<s>:a&b'), 'the limit is still there, as text');
});

test('the card is the same file every time: the time it was exported is not in it', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const a = deltaCard(host).svg;
  const b = deltaCard(host, {}, { generatedAt: '2030-01-01T00:00:00.000Z' }).svg;
  assert.equal(a, b);
  assert.ok(!a.includes('2030-01-01') && !a.includes(AT));
});

test('a card exported in Korean is written in Korean, from the same catalogue the page reads', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const out = deltaCard(host, {}, { lang: 'ko' });
  assert.ok(out.svg.includes('변경 영향, 팩에서 읽은 그대로'));
  assert.ok(out.svg.includes('>SQL 문<') && out.svg.includes('>화면<'));
  assert.match(out.svg, /신뢰 UNCERTIFIED, 한계 \d+건, 잘린 목록 0개/);
});

test('POST /api/export writes the card, and cascade export --format card writes a .card.svg', async (t) => {
  const { host } = await startViewer(t, ['delta']);
  const deps = { exportSnapshot: (r) => exportSnapshot(host, { ...r, generatedAt: AT }) };
  const ok = handleApi('POST', '/api/export', { tab: 'flow', arguments: { screen: '/rows' }, format: 'card' }, deps);
  assert.equal(ok.status, 200);
  assert.match(ok.json.answer.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(ok.json.answer.filename, /\.card\.svg$/);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-card-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'export', '--pack', host.ctxFor('delta').packDir,
    '--endpoint', 'GET /rows', '--format', 'card'], { encoding: 'utf8', cwd: work, env: { ...process.env, CASCADE_HOME: work } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /is one picture a document can hold/);
  const written = fs.readdirSync(work).filter((f) => f.endsWith('.card.svg'));
  assert.equal(written.length, 1, 'one card, named for its question');
  assert.match(fs.readFileSync(path.join(work, written[0]), 'utf8'), /^<svg /);
});
