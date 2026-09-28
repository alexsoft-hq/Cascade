// chain_svg.mjs — one Flow or Impact answer, drawn as one SVG a document can carry.
//
// WHAT THIS MODULE OWNS. The HTML snapshot (snapshot.mjs) is the live page with
// the answer inside, which a browser opens and a slide or a Word document cannot
// hold. An SVG can be: it is one picture, text stays text, and a browser turns it
// into a PNG with nothing installed. So this draws the same answer the chain
// lanes draw, as a static picture: the lanes left to right, one row per node,
// one connector per link, and around them everything the answer says about
// itself.
//
// WHAT MAY NOT GO MISSING, because a picture is read without the page around it:
//   the grade      on every row as a badge (the weakest link on its way from the
//                  start), and on every connector as its dash (that one link's
//                  grade), with the page's own dashes (GRADE_DASH);
//   the cut        a lane that shows fewer rows than it has says how many more;
//   the question   tab, entry, mode, depth, limit, pack, time, engine;
//   the worth      the trust level and every limit, word for word.
// test/chain_svg.test.mjs holds each of those against the answer.
//
// ONE NAME AND ONE ORDER PER NODE (RM67). The names, the order inside each lane
// and the lane widths come from chainlayout.mjs, the file the live lanes read,
// so the saved picture names every node the way the page does. It folds
// nothing: a picture in a document has no pointer to open a fold with.
//
// A SECOND DRAWING OF ONE ANSWER is the risk this module carries, so it reads
// nothing but the answer and draws nothing the answer does not say: no layout
// guess adds a row, and a link whose other end is not on the picture (it was
// cut) is not drawn rather than drawn to the nearest row.

/** The lanes each direction draws, left to right, as the live page orders them. */
export const SVG_LANES = Object.freeze({
  down: Object.freeze(['webFunctions', 'endpoints', 'services', 'statements', 'tables']),
  up: Object.freeze(['statements', 'services', 'endpoints', 'webFunctions', 'screens']),
});

import { GRADE_DASH, dashAttr, escapeXml as esc, gradeBadgeSvg, svgDocument } from './svg_doc.mjs';
import { CHAIN_FIT, chainLabels, emptyLanesLast, fitLines, laneWidth, orderLanes } from './chainlayout.mjs';

/** The live page's dash per grade, spelled once in chainlayout.mjs and read from here by the tests. */
export { GRADE_DASH };

const PAD = 24;
const LINE = 15;
/** The three grades a mode can walk each have a band inside a hop; anything else is one more. */
const BANDS = ['EXACT', 'SOUND_SET', 'HEURISTIC'];

/** The light theme's colours, read out of the viewer's own stylesheet when it is handed over. */
export function drawingPalette(html) {
  const out = { g0: '#F3F5F8', g1: '#FFFFFF', hair: '#E1E6EC', frame: '#C7CFDA', t1: '#1B2A41', t2: '#4A5568', t3: '#7B8794', warn: '#7A6224', edge: '#1B2A41' };
  const block = /\[data-theme="drawing"\]\s*\{([\s\S]*?)\}/.exec(String(html ?? ''));
  if (!block) return out;
  for (const m of block[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
    const k = m[1].replace(/-/g, '');
    if (Object.hasOwn(out, k)) out[k] = m[2];
  }
  return out;
}

/**
 * Text cut into lines at a separator where there is one: at most `first`
 * characters on the first line and `n` on the others. A tail of three characters
 * or fewer stays on the line before, so no line holds one letter.
 */
export function wrapText(text, n, first = n) {
  const out = [];
  let rest = String(text ?? '');
  // The first line sits beside the badge and gets no slack; the others may run three over.
  for (let width = first; rest.length > width + (out.length > 0 ? 3 : 0); width = n) {
    const window = rest.slice(0, width + 1);
    const at = Math.max(window.lastIndexOf(' '), window.lastIndexOf('.'), window.lastIndexOf('#'), window.lastIndexOf('/'), window.lastIndexOf('_'));
    // No separator far enough in: break a camel-cased name before a capital.
    let camel = -1;
    for (let i = width; i > width / 2; i -= 1) if (/[A-Z]/.test(window[i]) && /[a-z]/.test(window[i - 1] ?? '')) { camel = i; break; }
    const cutAt = at > width / 2 ? at + 1 : camel > 0 ? camel : width;
    out.push(rest.slice(0, cutAt).trimEnd());
    rest = rest.slice(cutAt).trimStart();
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

/** The node a lane row stands for, the id the naming rule reads. */
function nodeIdOf(field, x) {
  if (field === 'tables') return `table:${x.table}`;
  if (field === 'statements') return `statement:${x.id}`;
  if (field === 'endpoints') return `endpoint:${x.id}`;
  if (field === 'screens') return `screen:${x.id}`;
  return `symbol:${x.id}`;
}

/**
 * THE GRADE OF THE LINK INTO A ROW, the way the live lanes read it: the step's
 * own grade where the answer names the step, else the last walked edge, else
 * the row's (a table row names no step of its own).
 */
function linkGradeOf(x) {
  if (x.link?.grade) return x.link.grade;
  const wp = Array.isArray(x.walkedPath) && x.walkedPath.length ? x.walkedPath[x.walkedPath.length - 1] : null;
  return wp?.grade ?? x.grade;
}

/**
 * One lane row: the key links arrive at and leave from, its node, the engine's
 * own short name (the summary card prints that one), what it says, and the link
 * into it. The name the lanes draw is `label`, set by chainModel.
 */
function rowOf(field, x) {
  const sub = (s) => (s == null || s === '' ? null : String(s));
  const base = { id: nodeIdOf(field, x), grade: x.grade, hops: x.hops, linkGrade: linkGradeOf(x) };
  switch (field) {
    case 'tables':
      return { ...base, key: `table:${x.table}`, name: x.table, sub: sub([x.access, x.comment].filter(Boolean).join('  ')), from: x.via ? `statement:${x.via}` : null };
    case 'endpoints':
      return { ...base, key: `endpoint:${x.id}`, name: x.id, sub: sub(x.handlerShort), from: x.link?.from ?? (x.handler ? `symbol:${x.handler}` : null) };
    case 'statements':
      return { ...base, key: `statement:${x.id}`, name: x.short ?? x.id, sub: sub(x.statementType), from: x.link?.from ?? null };
    case 'screens':
      return { ...base, key: `screen:${x.id}`, name: x.short ?? x.id, sub: sub(x.title), from: x.link?.from ?? null };
    default:
      return { ...base, key: `symbol:${x.id}`, name: x.short ?? x.id, sub: sub(x.file ? String(x.file).split('/').pop() : x.owner), from: x.link?.from ?? null };
  }
}

/** The entry row: hop 0, keyed by where the walk started, named by what it is (a route by its route). */
function entryRow(entry) {
  const route = `${entry.httpMethod} ${entry.path}`;
  const id = entry.kind === 'endpoint' ? `endpoint:${entry.id ?? route}` : (entry.start ?? `${entry.kind}:${entry.id}`);
  const name = entry.kind === 'endpoint' ? route : (entry.short ?? entry.id);
  const sub = entry.kind === 'endpoint' ? entry.handlerShort : (entry.comment ?? entry.statementType ?? entry.owner ?? entry.kind);
  return { key: entry.start, id, name, sub: sub ?? null, grade: entry.grade ?? null, from: null, hops: 0, group: 'entry' };
}

/** The lanes of one answer, the entry first: each row with the hop-and-grade group the page bands it in. */
function lanesOf(response, direction) {
  const a = response.answer;
  const cutBy = new Map((response.truncated?.fields ?? []).map((f) => [f.field, f]));
  const lanes = [{ field: 'entry', rows: [entryRow(a.entry)], shown: 1, total: 1 }];
  for (const field of SVG_LANES[direction]) {
    if (!Array.isArray(a[field])) continue;
    const t = cutBy.get(field);
    const grouped = field !== (direction === 'up' ? 'endpoints' : 'tables');
    const rows = a[field].map((x) => ({ ...rowOf(field, x), group: grouped ? `${x.hops}|${BANDS.includes(x.grade) ? x.grade : 'other'}` : field }));
    lanes.push({ field, rows, shown: a[field].length, total: t ? t.total : a[field].length });
  }
  // The page's rule: a lane with no rows is drawn after every lane with some.
  return emptyLanesLast(lanes, (l) => l.rows.length);
}

/**
 * THE PICTURE'S MODEL: the lanes this answer has, their rows in the answer's
 * order with one label per node (the page's), and every link whose two ends
 * are both on the picture, graded by that one link.
 */
export function chainModel(response, direction) {
  const lanes = lanesOf(response, direction);
  const names = chainLabels(lanes.flatMap((l) => l.rows.map((r) => r.id)));
  for (const l of lanes) for (const r of l.rows) r.label = names.get(r.id).text;
  const at = new Map();
  lanes.forEach((lane, li) => lane.rows.forEach((r, ri) => { if (!at.has(r.key)) at.set(r.key, [li, ri]); }));
  const links = [];
  const dropped = [];
  lanes.forEach((lane, li) => lane.rows.forEach((r, ri) => {
    if (!r.from) return;
    if (at.has(r.from)) links.push({ from: at.get(r.from), to: [li, ri], grade: r.linkGrade ?? r.grade, fromKey: r.from, toKey: r.key });
    else dropped.push({ to: r.key, from: r.from });
  }));
  return { lanes, links, dropped };
}

/** One lane's rows placed: as wide as its names need, a row as tall as its name's lines. */
function laneBoxes(rows, x, top) {
  const fit = laneWidth(rows.map((r) => r.label));
  let y = top + 34;
  const boxes = rows.map((r) => {
    const lines = fitLines(r.label, fit.perLine, CHAIN_FIT.lines);
    const h = 8 + lines.length * LINE + 22;
    const box = { x, y, w: fit.width, h, lines };
    y += h + 6;
    return box;
  });
  return { width: fit.width, boxes };
}

/**
 * Where each row sits: the lanes in the page's order, the rows inside each lane
 * ordered to cut crossings the page's way (orderLanes), each lane sized to its
 * names. `order[li][k]` is the answer index of the k-th drawn row.
 */
function layoutOf(model, top) {
  const keyed = model.lanes.map((l) => l.rows.map((r, i) => ({ key: r.key, group: r.group, i })));
  const order = orderLanes(keyed, model.links.map((l) => ({ from: l.fromKey, to: l.toKey }))).map((rows) => rows.map((r) => r.i));
  const lanes = [];
  let x = PAD;
  model.lanes.forEach((lane, li) => {
    const placed = laneBoxes(order[li].map((i) => lane.rows[i]), x, top);
    const boxes = [];
    order[li].forEach((i, k) => { boxes[i] = placed.boxes[k]; });
    lanes.push({ x, width: placed.width, boxes });
    x += placed.width + CHAIN_FIT.gap + 24;
  });
  const bottom = Math.max(top + 60, ...lanes.flatMap((l) => l.boxes.map((b) => b.y + b.h))) + 30;
  return { lanes, boxes: lanes.map((l) => l.boxes), bottom, width: x - CHAIN_FIT.gap - 24 + PAD };
}

/** The SVG text of one row: its name on one or two lines, then its hop, its badge and what it says. */
function rowSvg(r, b, p) {
  const name = b.lines.map((l, i) => `<tspan x="${b.x + 10}" dy="${i === 0 ? 0 : LINE}">${esc(l)}</tspan>`).join('');
  const my = b.y + 12 + b.lines.length * LINE;
  const hop = r.hops > 0 ? `<text x="${b.x + 10}" y="${my + 12}" class="m s c2">${r.hops}</text>` : '';
  const badge = r.grade ? gradeBadgeSvg({ x: b.x + 26, y: my, width: 84, grade: r.grade, palette: p }) : '';
  const subX = r.grade ? b.x + 118 : b.x + 26;
  const room = Math.max(4, Math.floor((b.x + b.w - 6 - subX) / 6.2));
  const sub = r.sub ? `<text x="${subX}" y="${my + 12}" class="t s c2">${esc(fitLines(r.sub, room, 1)[0])}</text>` : '';
  return `<g data-key="${esc(r.key)}"><title>${esc(String(r.id).slice(String(r.id).indexOf(':') + 1))}</title><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${p.g1}" stroke="${p.hair}"/>`
    + `<text x="${b.x + 10}" y="${b.y + 18}" class="m">${name}</text>${hop}${badge}${sub}</g>`;
}

/** One connector, right edge to left edge, dashed by the grade of that one link. */
function linkSvg(l, boxes, p) {
  const a = boxes[l.from[0]][l.from[1]];
  const b = boxes[l.to[0]][l.to[1]];
  const same = l.from[0] === l.to[0];
  const x1 = same ? a.x : a.x + a.w;
  const x2 = b.x;
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  // A link that skips a lane runs level behind it and turns in the last gutter, as on the page.
  const gutter = CHAIN_FIT.gap + 24;
  const dx = (x2 - x1) > gutter * 2.5 ? Math.max(26, x2 - x1 - gutter) : Math.max(26, (x2 - x1) / 2);
  const d = same
    ? `M${x1},${y1} C${x1 - 22},${y1} ${x2 - 22},${y2} ${x2},${y2}`
    : `M${x1},${y1} C${x1 + dx},${y1} ${x2 - Math.min(dx, Math.max(26, gutter * 0.6))},${y2} ${x2},${y2}`;
  return `<path d="${d}" fill="none" stroke="${p.edge}" stroke-width="1.3" data-grade="${esc(l.grade)}"${dashAttr(l.grade)}/>`;
}

/** The band over the picture: the question and what the answer is worth. */
function headerLines(snap, t) {
  const flow = snap.calls.find((c) => c.name === 'flow').answer;
  const limits = Array.isArray(flow.limits) ? flow.limits.length : 0;
  const cut = (flow.truncated?.fields ?? []).filter((f) => f.shown < f.total).length;
  const m = snap.meta ?? {};
  return [
    t('snap.question', { dir: t(snap.tab === 'impact' ? 'trace.dir.up' : 'trace.dir.down'), kind: snap.entry.kind, value: snap.entry.value, mode: snap.args.mode, depth: snap.args.depth == null ? t('depth.none') : snap.args.depth, limit: snap.args.limit }),
    t('snap.when', { generated: snap.generatedAt ?? '?', digest: m.digest ?? '?', built: m.builtAt ?? '?', version: snap.engine?.version ?? '?' }),
    t('snap.honesty.picture', { trust: flow.trust?.trustLevel ?? '?', limits, truncated: cut }),
  ];
}

/** How to read a line, in the words every place that explains a grade uses (grade.say.*). */
function legendSvg(flow, t, y, p) {
  const byGrade = flow.answer.walk?.byLinkGrade ?? {};
  const parts = [`<text x="${PAD}" y="${y}" class="t b">${esc(t('chain.legend.title'))}</text>`];
  BANDS.forEach((g, i) => {
    const ly = y + 20 + i * 18;
    parts.push(`<line x1="${PAD}" y1="${ly - 4}" x2="${PAD + 40}" y2="${ly - 4}" stroke="${p.edge}" stroke-width="1.5"${dashAttr(g)}/>`
      + `<text x="${PAD + 52}" y="${ly}" class="m s">${esc(g)}</text><text x="${PAD + 150}" y="${ly}" class="t s">${esc(t(`grade.say.${g}`))} (${byGrade[g] ?? 0})</text>`);
  });
  const ly = y + 20 + BANDS.length * 18;
  parts.push(`<text x="${PAD}" y="${ly}" class="t s c2">${esc(t('chain.legend.path'))}</text>`);
  return { svg: parts.join(''), bottom: ly + 14 };
}

/** Under the picture: how to read a line, the census, and every limit word for word. */
function footerSvg(flow, t, y, width, p, dropped) {
  const parts = [];
  if (dropped > 0) {
    parts.push(`<text x="${PAD}" y="${y - 14}" class="t s" fill="${p.warn}">${esc(t('chain.svg.dropped', { n: dropped }))}</text>`);
    y += 10;
  }
  const legend = legendSvg(flow, t, y, p);
  parts.push(legend.svg);
  let ly = legend.bottom + 14;
  for (const lim of flow.limits ?? []) {
    for (const line of wrapText(`${lim.scope}: ${lim.reason}`, Math.max(60, Math.floor((width - PAD * 2) / 6.4)))) {
      parts.push(`<text x="${PAD}" y="${ly}" class="t s c2">${esc(line)}</text>`);
      ly += 14;
    }
  }
  return { svg: parts.join(''), bottom: ly + 10 };
}

/** A lane's heading, with its count and, when it was cut, how many rows are not here. */
function laneHeadSvg(lane, at, y, t, p, direction) {
  const entryKey = direction === 'up' ? 'chain.lane.target' : 'chain.lane.entry';
  const title = t(lane.field === 'entry' ? entryKey : `chain.lane.${lane.field}`);
  const cut = lane.shown < lane.total ? `<text x="${at.x}" y="${y + 16}" class="t s" fill="${p.warn}">${esc(t('chain.cut', { n: lane.total - lane.shown }).trim())}</text>` : '';
  return `<text x="${at.x}" y="${y}" class="t b">${esc(title)}</text><text x="${at.x + at.width}" y="${y}" text-anchor="end" class="m s c2">${lane.shown} / ${lane.total}</text>${cut}`;
}

/**
 * THE SVG for one snapshot's answer.
 *
 * @param {object} snap  the snapshot data (snapshot.mjs buildSnapshot)
 * @param {{t:(key:string, params?:object)=>string, palette?:object, fonts?:{sans?:Buffer, mono?:Buffer}}} opts
 * @returns {string}
 */
export function chainSvg(snap, { t, palette = drawingPalette(''), fonts = {} }) {
  const flow = snap.calls.find((c) => c.name === 'flow').answer;
  const direction = snap.tab === 'impact' ? 'up' : 'down';
  const model = chainModel(flow, direction);
  const head = headerLines(snap, t);
  const lanesTop = PAD + 26 + head.length * 18 + 18;
  const { lanes, boxes, bottom, width: drawn } = layoutOf(model, lanesTop);
  const width = Math.max(drawn, 720);
  const foot = footerSvg(flow, t, bottom + 10, width, palette, model.dropped.length);
  const headSvg = [`<text x="${PAD}" y="${PAD + 12}" class="t b">${esc(t('snap.title'))}</text>`]
    .concat(head.map((line, i) => `<text x="${PAD}" y="${PAD + 34 + i * 18}" class="t${i === 2 ? '' : ' c2'}"${i === 2 ? ` fill="${palette.warn}"` : ''}>${esc(line)}</text>`));
  const laneSvg = model.lanes.map((lane, li) => laneHeadSvg(lane, lanes[li], lanesTop, t, palette, direction)).join('');
  // Each lane is a ground over the links, so a link that skips it runs behind it.
  const grounds = lanes.map((l) => `<rect x="${l.x - 4}" y="${lanesTop + 26}" width="${l.width + 8}" height="${bottom - lanesTop - 50}" fill="${palette.g0}"/>`).join('');
  const body = headSvg.join('') + laneSvg
    + model.links.map((l) => linkSvg(l, boxes, palette)).join('') + grounds
    + model.lanes.map((lane, li) => lane.rows.map((r, ri) => rowSvg(r, boxes[li][ri], palette)).join('')).join('')
    + foot.svg;
  return svgDocument({ width, height: foot.bottom, palette, fonts, body });
}
