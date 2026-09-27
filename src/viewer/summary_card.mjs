// summary_card.mjs — one Flow or Impact answer, summed up as one card a README or a slide can carry.
//
// WHAT THIS MODULE OWNS. The chain picture (chain_svg.mjs) draws every row of an
// answer, which is what a reviewer needs and more than a first look can take in.
// The card says the same answer at a glance: what was asked about at the top, and
// under it, layer by layer, how many statements, service methods, endpoints,
// frontend functions and screens the walk reached, a few of them by name, and how
// sure each layer is. It reads the SAME model the chain picture reads
// (chainModel), so the two pictures cannot disagree about what the answer holds.
//
// WHAT MAY NOT GO MISSING, because a card travels without the page around it:
//   the totals     each layer's count is the answer's whole total, cut or not;
//   the grade      a badge per grade present in a layer, and the rail into the
//                  layer drawn with the dash of its weakest row;
//   the cut        a layer the answer cut says its grades cover only the rows shown,
//                  and "+N more" counts from the whole total;
//   the walk note  when the walk stopped early (depth, mode), its words, in the
//                  warning ink;
//   the worth      the trust level, and every limit word for word.
// test/summary_card.test.mjs holds each of those against the answer.

import { GRADE_RANK } from '../core/graph.mjs';
import { chainModel, drawingPalette, wrapText } from './chain_svg.mjs';
import { dashAttr, escapeXml, gradeBadgeSvg, svgDocument } from './svg_doc.mjs';

const WIDTH = 960;
const PAD = 28;
const RIGHT = WIDTH - PAD;
const RAIL_X = PAD + 12;
const COUNT_X = PAD + 34;
const LABEL_X = PAD + 124;
const ENTRY_DOT_Y = PAD + 66;
const LAYERS_TOP = PAD + 112;
const LAYER_H = 64;
const DOT_OFFSET = 22;
const DOT_R = 5;
/** One IBM Plex Mono character at 12px: 0.6 em. */
const CHAR_W = 7.2;
const CHIP_PAD = 16;
const CHIP_GAP = 8;
const CHIP_H = 22;
const CHIP_MAX_CHARS = 48;
const ENTRY_MAX_CHARS = 70;
/** What "+N more" needs at the end of a line of names. */
const MORE_ROOM = 96;
const BADGE_MIN_W = 84;
const BADGE_GAP = 6;
const NOTE_LINE_H = 15;
const LIMIT_LINE_H = 14;
/** Characters of 11px prose that fit between the margins. */
const WRAP_CHARS = Math.floor((WIDTH - 2 * PAD) / 6.2);

/** The card's own words, per direction, as literal keys the catalogue test can find. */
const HEAD_KEYS = Object.freeze({
  up: Object.freeze({ kicker: 'card.kicker.up', question: 'card.question.up' }),
  down: Object.freeze({ kicker: 'card.kicker.down', question: 'card.question.down' }),
});
const LAYER_KEYS = Object.freeze({
  statements: 'card.lane.statements', services: 'card.lane.services', endpoints: 'card.lane.endpoints',
  webFunctions: 'card.lane.webFunctions', screens: 'card.lane.screens', tables: 'card.lane.tables',
});
/** The grades a walked link can carry, strongest first: the two below them never draw one. */
const LEGEND_GRADES = Object.freeze(['EXACT', 'SOUND_SET', 'HEURISTIC']);
const LEGEND_STEP = 170;

const CARD_STYLE = '.q{font-size:15px}.e{font-size:20px;font-weight:600}.n{font-size:28px;font-weight:600}';

/** The weakest grade among the rows, by the engine's own lattice; null when no row has one. */
export function weakestGrade(rows) {
  let weakest = null;
  for (const r of rows) if (r.grade && (weakest === null || GRADE_RANK[r.grade] < GRADE_RANK[weakest])) weakest = r.grade;
  return weakest;
}

/** How many rows carry each grade, strongest first, as [grade, count] pairs. */
export function gradeCounts(rows) {
  const counts = {};
  for (const r of rows) if (r.grade) counts[r.grade] = (counts[r.grade] ?? 0) + 1;
  return Object.entries(counts).sort(([a], [b]) => GRADE_RANK[b] - GRADE_RANK[a]);
}

/**
 * THE CARD'S MODEL: the entry, and one layer per lane of the chain model, with
 * what each layer holds and how sure it is. The totals are the chain model's,
 * which are the answer's own: nothing is counted a second time here.
 *
 * @param {object} response  the `flow` tool's response
 * @param {'up'|'down'} direction
 */
export function summaryCardModel(response, direction) {
  const [entry, ...lanes] = chainModel(response, direction).lanes;
  const walk = response.answer.walk ?? {};
  return {
    direction,
    entry: entry.rows[0],
    layers: lanes.map((lane) => ({
      field: lane.field, total: lane.total, shown: lane.shown, rows: lane.rows,
      grades: gradeCounts(lane.rows), weakest: weakestGrade(lane.rows),
    })),
    linkGrades: walk.byLinkGrade ?? {},
    note: walk.note ?? null,
    limits: Array.isArray(response.limits) ? response.limits : [],
    trust: response.trust?.trustLevel ?? null,
    cutLists: (response.truncated?.fields ?? []).filter((f) => f.shown < f.total).length,
  };
}

/** A name cut with an ellipsis past `max` characters; the whole name stays in a tooltip. */
const fit = (name, max) => {
  const s = String(name ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const chipWidth = (text) => Math.ceil(text.length * CHAR_W) + CHIP_PAD;
/** The whole name as a tooltip, when the line shows it cut; two long names that start alike still make two cards. */
const tipOf = (shown, full) => (shown === full ? '' : `<title>${escapeXml(full)}</title>`);
const textSvg = (x, y, cls, text, fill) => `<text x="${x}" y="${y}" class="${cls}"${fill ? ` fill="${fill}"` : ''}>${escapeXml(text)}</text>`;

/** The names that fit on one line, in the answer's order, and how many are left for "+N more". */
function namesThatFit(layer) {
  const placed = [];
  let x = LABEL_X;
  for (const r of layer.rows) {
    const text = fit(r.name, CHIP_MAX_CHARS);
    const w = chipWidth(text);
    const leftAfter = layer.total - placed.length - 1;
    if (x + w > (leftAfter > 0 ? RIGHT - MORE_ROOM : RIGHT)) break;
    placed.push({ x, w, text, full: String(r.name ?? '') });
    x += w + CHIP_GAP;
  }
  return { placed, rest: layer.total - placed.length, endX: x };
}

function chipSvg(chip, y, p) {
  return `<g>${tipOf(chip.text, chip.full)}<rect x="${chip.x}" y="${y}" width="${chip.w}" height="${CHIP_H}" rx="4" fill="${p.g0}" stroke="${p.hair}"/>`
    + textSvg(chip.x + CHIP_PAD / 2, y + 15, 'm', chip.text) + '</g>';
}

function namesSvg(layer, top, t, p) {
  if (layer.total === 0) return textSvg(LABEL_X, top + 42, 't s c2', t('card.none'));
  const { placed, rest, endX } = namesThatFit(layer);
  const more = rest > 0 ? textSvg(endX, top + 42, 't s c2', t('card.more', { n: rest })) : '';
  return placed.map((chip) => chipSvg(chip, top + 27, p)).join('') + more;
}

/** One badge per grade the layer holds, strongest first, ending at the right margin. */
function badgesSvg(layer, top, p) {
  const badges = layer.grades.map(([grade, n]) => {
    const label = `${grade} ${n}`;
    return { grade, label, width: Math.max(BADGE_MIN_W, Math.ceil(label.length * CHAR_W) + 14) };
  });
  let x = RIGHT - badges.reduce((sum, b) => sum + b.width + BADGE_GAP, -BADGE_GAP);
  return badges.map((b) => {
    const svg = gradeBadgeSvg({ x, y: top + 4, width: b.width, grade: b.grade, label: b.label, palette: p });
    x += b.width + BADGE_GAP;
    return svg;
  }).join('');
}

function labelSvg(layer, top, t) {
  const shownOnly = layer.shown < layer.total ? `<tspan class="c2 s"> ${escapeXml(t('card.shownOnly', { n: layer.shown }))}</tspan>` : '';
  return `<text x="${LABEL_X}" y="${top + 16}" class="t b">${escapeXml(t(LAYER_KEYS[layer.field]))}${shownOnly}</text>`;
}

/** The rail into a layer, dashed by its weakest row, and the layer's dot. */
function railSvg(layer, fromY, toY, p) {
  const stroke = layer.weakest ? p.t1 : p.hair;
  return `<line x1="${RAIL_X}" y1="${fromY + DOT_R + 1}" x2="${RAIL_X}" y2="${toY - DOT_R - 1}" stroke="${stroke}" stroke-width="1.6"`
    + ` data-grade="${escapeXml(layer.weakest ?? '')}"${dashAttr(layer.weakest)}/>`
    + `<circle cx="${RAIL_X}" cy="${toY}" r="${DOT_R}" fill="${p.g1}" stroke="${p.t1}" stroke-width="1.6"/>`;
}

function layerSvg(layer, index, t, p) {
  const top = LAYERS_TOP + index * LAYER_H;
  const fromY = index === 0 ? ENTRY_DOT_Y : top - LAYER_H + DOT_OFFSET;
  return `<g data-layer="${escapeXml(layer.field)}">${railSvg(layer, fromY, top + DOT_OFFSET, p)}`
    + textSvg(COUNT_X, top + 32, 't n', String(layer.total))
    + labelSvg(layer, top, t) + badgesSvg(layer, top, p) + namesSvg(layer, top, t, p) + '</g>';
}

/** What was asked about, in the card's own words for the direction it was walked. */
function headerSvg(model, t, p) {
  const keys = HEAD_KEYS[model.direction];
  const e = model.entry;
  return textSvg(PAD, PAD + 14, 't s c2', t(keys.kicker))
    + textSvg(PAD, PAD + 40, 't q', t(keys.question))
    + `<circle cx="${RAIL_X}" cy="${ENTRY_DOT_Y}" r="${DOT_R}" fill="${p.t1}"/>`
    + entryNameSvg(e.name)
    + (e.sub ? textSvg(COUNT_X, PAD + 94, 't c2', e.sub) : '');
}

function entryNameSvg(name) {
  const shown = fit(name, ENTRY_MAX_CHARS);
  const text = textSvg(COUNT_X, PAD + 73, 'm e', shown);
  const tip = tipOf(shown, String(name ?? ''));
  return tip ? `<g>${tip}${text}</g>` : text;
}

function legendSvg(model, t, p, y) {
  const items = LEGEND_GRADES.map((g, i) => {
    const x = LABEL_X + i * LEGEND_STEP;
    return `<line x1="${x}" y1="${y - 4}" x2="${x + 28}" y2="${y - 4}" stroke="${p.t1}" stroke-width="1.6"${dashAttr(g)}/>`
      + textSvg(x + 36, y, 'm s', `${g} ${model.linkGrades[g] ?? 0}`);
  });
  return textSvg(PAD, y, 't s b', t('card.links')) + items.join('');
}

/** Which pack answered and how it was asked. The export time is left out, so the card is the same file every time. */
function basisOf(snap) {
  const m = snap.meta ?? {};
  return {
    project: snap.project?.id ?? m.projectId ?? '?', digest: m.digest ?? '?',
    built: String(m.builtAt ?? '?').replace('T', ' ').replace(/\.\d+Z$|Z$/, ''),
    mode: snap.args.mode, depth: snap.args.depth, version: snap.engine?.version ?? '?',
  };
}

/** Small prose wrapped to the margins: its lines as SVG, and the y under the last one. */
function proseSvg(text, y, lineH, cls, fill) {
  const lines = wrapText(text, WRAP_CHARS);
  return { svg: lines.map((line, i) => textSvg(PAD, y + i * lineH, cls, line, fill)).join(''), next: y + lines.length * lineH };
}

/** The link census, which pack answered, and what the answer is worth. */
function worthSvg(model, snap, t, p, y) {
  const warn = model.limits.length > 0 || model.cutLists > 0 ? p.warn : null;
  const worth = t('card.worth', { trust: model.trust ?? '?', limits: model.limits.length, cut: model.cutLists });
  return legendSvg(model, t, p, y)
    + textSvg(PAD, y + 24, 't s c2', t('card.basis', basisOf(snap)))
    + textSvg(PAD, y + 42, 't s', worth, warn);
}

/** Under the layers: the walk's own note, the census and the worth, then every limit word for word. */
function footerSvg(model, snap, t, p, top) {
  const parts = [];
  let y = top;
  if (model.note) {
    const note = proseSvg(model.note, y, NOTE_LINE_H, 't s', p.warn);
    parts.push(note.svg);
    y = note.next;
  }
  parts.push(worthSvg(model, snap, t, p, y + 12));
  y += 72;
  for (const lim of model.limits) {
    const block = proseSvg(`${lim.scope}: ${lim.reason}`, y, LIMIT_LINE_H, 't s c2');
    parts.push(block.svg);
    y = block.next;
  }
  return { svg: parts.join(''), bottom: y + PAD - LIMIT_LINE_H };
}

/**
 * THE CARD for one snapshot's answer.
 *
 * @param {object} snap  the snapshot data (snapshot.mjs buildSnapshot)
 * @param {{t:(key:string, params?:object)=>string, palette?:object, fonts?:{sans?:Buffer, mono?:Buffer}}} opts
 * @returns {string}
 */
export function summaryCardSvg(snap, { t, palette = drawingPalette(''), fonts = {} }) {
  const flow = snap.calls.find((c) => c.name === 'flow').answer;
  const model = summaryCardModel(flow, snap.tab === 'impact' ? 'up' : 'down');
  const layers = model.layers.map((layer, i) => layerSvg(layer, i, t, palette)).join('');
  const foot = footerSvg(model, snap, t, palette, LAYERS_TOP + model.layers.length * LAYER_H + 8);
  const height = foot.bottom;
  const frame = `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${palette.g1}" stroke="${palette.hair}"/>`;
  return svgDocument({ width: WIDTH, height, palette, fonts, style: CARD_STYLE, body: frame + headerSvg(model, t, palette) + layers + foot.svg });
}
