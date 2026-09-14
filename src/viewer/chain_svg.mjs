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
//   the grade      on every row as a badge, and on every connector as its dash
//                  (the live page's own dashes: solid EXACT, 5 3 SOUND_SET,
//                  1.5 3 HEURISTIC);
//   the cut        a lane that shows fewer rows than it has says how many more;
//   the question   tab, entry, mode, depth, limit, pack, time, engine;
//   the worth      the trust level and every limit, word for word.
// test/chain_svg.test.mjs holds each of those against the answer.
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

/** The live page's dash per grade: the dash IS the grade. */
export const GRADE_DASH = Object.freeze({ EXACT: null, SOUND_SET: '5 3', HEURISTIC: '1.5 3', RUNTIME_ONLY: '1 4', UNRESOLVED: '1 4' });

const COL_W = 300;
const COL_GAP = 70;
const PAD = 24;
const LINE = 15;
/** A name's first line stops short of the grade badge; the lines under it have the row. */
const NAME_FIRST = 24;
const NAME_REST = 38;

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

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/** One lane row: the key links arrive at and leave from, what it says, and the link into it. */
function rowOf(field, x) {
  const sub = (s) => (s == null || s === '' ? null : String(s));
  switch (field) {
    case 'tables':
      return { key: `table:${x.table}`, name: x.table, sub: sub([x.access, x.comment].filter(Boolean).join('  ')), grade: x.grade, from: x.via ? `statement:${x.via}` : null, hops: x.hops };
    case 'endpoints':
      return { key: `endpoint:${x.id}`, name: x.id, sub: sub(x.handlerShort), grade: x.grade, from: x.link?.from ?? (x.handler ? `symbol:${x.handler}` : null), hops: x.hops };
    case 'statements':
      return { key: `statement:${x.id}`, name: x.short ?? x.id, sub: sub(x.statementType), grade: x.grade, from: x.link?.from ?? null, hops: x.hops };
    case 'screens':
      return { key: `screen:${x.id}`, name: x.short ?? x.id, sub: sub(x.title), grade: x.grade, from: x.link?.from ?? null, hops: x.hops };
    default:
      return { key: `symbol:${x.id}`, name: x.short ?? x.id, sub: sub(x.file ? String(x.file).split('/').pop() : x.owner), grade: x.grade, from: x.link?.from ?? null, hops: x.hops };
  }
}

/** The entry row: hop 0, no grade, keyed by where the walk started. */
function entryRow(entry) {
  const name = entry.kind === 'endpoint' ? `${entry.httpMethod} ${entry.path}` : (entry.short ?? entry.id);
  const sub = entry.kind === 'endpoint' ? entry.handlerShort : (entry.comment ?? entry.statementType ?? entry.owner ?? entry.kind);
  return { key: entry.start, name, sub: sub ?? null, grade: null, from: null, hops: 0 };
}

/**
 * THE PICTURE'S MODEL: the lanes this answer has, their rows, and every link
 * whose two ends are both on the picture.
 */
export function chainModel(response, direction) {
  const a = response.answer;
  const cutBy = new Map((response.truncated?.fields ?? []).map((f) => [f.field, f]));
  const lanes = [{ field: 'entry', rows: [entryRow(a.entry)], shown: 1, total: 1 }];
  for (const field of SVG_LANES[direction]) {
    if (!Array.isArray(a[field])) continue;
    const t = cutBy.get(field);
    lanes.push({ field, rows: a[field].map((x) => rowOf(field, x)), shown: a[field].length, total: t ? t.total : a[field].length });
  }
  const at = new Map();
  lanes.forEach((lane, li) => lane.rows.forEach((r, ri) => { if (!at.has(r.key)) at.set(r.key, [li, ri]); }));
  const links = [];
  const dropped = [];
  lanes.forEach((lane, li) => lane.rows.forEach((r, ri) => {
    if (!r.from) return;
    if (at.has(r.from)) links.push({ from: at.get(r.from), to: [li, ri], grade: r.grade });
    else dropped.push({ to: r.key, from: r.from });
  }));
  return { lanes, links, dropped };
}

/** Where each row sits: lanes are columns, a row is as tall as its wrapped name. */
function layoutOf(model, top) {
  const boxes = model.lanes.map((lane, li) => {
    let y = top + 34;
    return lane.rows.map((r) => {
      const lines = wrapText(r.name, NAME_REST, NAME_FIRST);
      const h = 10 + lines.length * LINE + (r.sub ? LINE : 0) + 8;
      const box = { x: PAD + li * (COL_W + COL_GAP), y, w: COL_W, h, lines };
      y += h + 6;
      return box;
    });
  });
  const bottom = Math.max(top + 60, ...boxes.flat().map((b) => b.y + b.h)) + 30;
  return { boxes, bottom, width: PAD * 2 + model.lanes.length * COL_W + (model.lanes.length - 1) * COL_GAP };
}

/** The SVG text of one row. */
function rowSvg(r, b, p) {
  const badge = r.grade ? `<g><rect x="${b.x + b.w - 92}" y="${b.y + 6}" width="84" height="16" fill="${p.g1}" stroke="${p.t1}" stroke-width="1"${GRADE_DASH[r.grade] ? ` stroke-dasharray="${GRADE_DASH[r.grade]}"` : ''}/><text x="${b.x + b.w - 50}" y="${b.y + 18}" text-anchor="middle" class="m s">${esc(r.grade)}</text></g>` : '';
  const name = b.lines.map((l, i) => `<tspan x="${b.x + 10}" dy="${i === 0 ? 0 : LINE}">${esc(l)}</tspan>`).join('');
  const sub = r.sub ? `<text x="${b.x + 10}" y="${b.y + 20 + b.lines.length * LINE}" class="t s c2">${esc(r.sub)}</text>` : '';
  return `<g data-key="${esc(r.key)}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${p.g1}" stroke="${p.hair}"/>`
    + `<text x="${b.x + 10}" y="${b.y + 18}" class="m">${name}</text>${sub}${badge}</g>`;
}

/** One connector, right edge to left edge, dashed by its grade. */
function linkSvg(l, boxes, p) {
  const a = boxes[l.from[0]][l.from[1]];
  const b = boxes[l.to[0]][l.to[1]];
  const same = l.from[0] === l.to[0];
  const x1 = same ? a.x : a.x + a.w;
  const x2 = b.x;
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  const d = same
    ? `M${x1},${y1} C${x1 - 22},${y1} ${x2 - 22},${y2} ${x2},${y2}`
    : `M${x1},${y1} C${x1 + Math.max(26, (x2 - x1) / 2)},${y1} ${x2 - Math.max(26, (x2 - x1) / 2)},${y2} ${x2},${y2}`;
  const dash = GRADE_DASH[l.grade];
  return `<path d="${d}" fill="none" stroke="${p.edge}" stroke-width="1.3" data-grade="${esc(l.grade)}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

/** The band over the picture: the question and what the answer is worth. */
function headerLines(snap, t) {
  const flow = snap.calls.find((c) => c.name === 'flow').answer;
  const limits = Array.isArray(flow.limits) ? flow.limits.length : 0;
  const cut = (flow.truncated?.fields ?? []).filter((f) => f.shown < f.total).length;
  const m = snap.meta ?? {};
  return [
    t('snap.question', { tab: t(snap.tab === 'impact' ? 'tab.impact' : 'tab.flow'), kind: snap.entry.kind, value: snap.entry.value, mode: snap.args.mode, depth: snap.args.depth, limit: snap.args.limit }),
    t('snap.when', { generated: snap.generatedAt ?? '?', digest: m.digest ?? '?', built: m.builtAt ?? '?', version: snap.engine?.version ?? '?' }),
    t('snap.honesty.picture', { trust: flow.trust?.trustLevel ?? '?', limits, truncated: cut }),
  ];
}

/** Under the picture: how to read a line, the census, and every limit word for word. */
function footerSvg(flow, t, y, width, p, dropped) {
  const parts = [];
  if (dropped > 0) {
    parts.push(`<text x="${PAD}" y="${y - 14}" class="t s" fill="${p.warn}">${esc(t('chain.svg.dropped', { n: dropped }))}</text>`);
    y += 10;
  }
  const byGrade = flow.answer.walk?.byLinkGrade ?? {};
  const legend = [['EXACT', 'chain.legend.exact'], ['SOUND_SET', 'chain.legend.sound'], ['HEURISTIC', 'chain.legend.heuristic']];
  parts.push(`<text x="${PAD}" y="${y}" class="t b">${esc(t('chain.legend.title'))}</text>`);
  legend.forEach(([g, key], i) => {
    const ly = y + 20 + i * 18;
    const dash = GRADE_DASH[g] ? ` stroke-dasharray="${GRADE_DASH[g]}"` : '';
    parts.push(`<line x1="${PAD}" y1="${ly - 4}" x2="${PAD + 40}" y2="${ly - 4}" stroke="${p.edge}" stroke-width="1.5"${dash}/>`
      + `<text x="${PAD + 52}" y="${ly}" class="m s">${esc(g)}</text><text x="${PAD + 150}" y="${ly}" class="t s">${esc(t(key))} (${byGrade[g] ?? 0})</text>`);
  });
  let ly = y + 20 + legend.length * 18 + 14;
  for (const lim of flow.limits ?? []) {
    for (const line of wrapText(`${lim.scope}: ${lim.reason}`, Math.max(60, Math.floor((width - PAD * 2) / 6.4)))) {
      parts.push(`<text x="${PAD}" y="${ly}" class="t s c2">${esc(line)}</text>`);
      ly += 14;
    }
  }
  return { svg: parts.join(''), bottom: ly + 10 };
}

/** A lane's heading, with its count and, when it was cut, how many rows are not here. */
function laneHeadSvg(lane, x, y, t, p, direction) {
  const entryKey = direction === 'up' ? 'chain.lane.target' : 'chain.lane.entry';
  const title = t(lane.field === 'entry' ? entryKey : `chain.lane.${lane.field}`);
  const cut = lane.shown < lane.total ? `<text x="${x}" y="${y + 16}" class="t s" fill="${p.warn}">${esc(t('chain.cut', { n: lane.total - lane.shown }).trim())}</text>` : '';
  return `<text x="${x}" y="${y}" class="t b">${esc(title)}</text><text x="${x + COL_W}" y="${y}" text-anchor="end" class="m s c2">${lane.shown} / ${lane.total}</text>${cut}`;
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
  const { boxes, bottom, width } = layoutOf(model, lanesTop);
  const foot = footerSvg(flow, t, bottom + 10, width, palette, model.dropped.length);
  const height = foot.bottom;
  const face = (name, buf) => (buf ? `@font-face{font-family:"${name}";src:url(data:font/woff2;base64,${Buffer.from(buf).toString('base64')}) format("woff2");}` : '');
  const style = `${face('IBM Plex Sans', fonts.sans)}${face('IBM Plex Mono', fonts.mono)}`
    + `.t{font-family:"IBM Plex Sans","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:13px;fill:${palette.t1}}`
    + `.m{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px;fill:${palette.t1}}`
    + `.s{font-size:11px}.b{font-weight:600}.c2{fill:${palette.t2}}`;
  const headSvg = [`<text x="${PAD}" y="${PAD + 12}" class="t b">${esc(t('snap.title'))}</text>`]
    .concat(head.map((line, i) => `<text x="${PAD}" y="${PAD + 34 + i * 18}" class="t${i === 2 ? '' : ' c2'}"${i === 2 ? ` fill="${palette.warn}"` : ''}>${esc(line)}</text>`));
  const laneSvg = model.lanes.map((lane, li) => laneHeadSvg(lane, PAD + li * (COL_W + COL_GAP), lanesTop, t, palette, direction)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<style>${style}</style><rect width="100%" height="100%" fill="${palette.g0}"/>`
    + headSvg.join('') + laneSvg
    + model.links.map((l) => linkSvg(l, boxes, palette)).join('')
    + model.lanes.map((lane, li) => lane.rows.map((r, ri) => rowSvg(r, boxes[li][ri], palette)).join('')).join('')
    + foot.svg + '</svg>';
}
