// svg_doc.mjs — what every standalone picture Cascade writes shares: its escaping, its grade marks and its document frame.
//
// Two pictures are drawn from one answer: the whole chain (chain_svg.mjs) and the
// summary card (summary_card.mjs). A reader who moves between them has to meet one
// visual language: the same dash for the same grade, the same faces, the same
// ground. So those are spelled here, once, and neither picture spells its own.

import { GRADE_DASH } from './chainlayout.mjs';

/** The live page's dash per grade, from the one table the page draws with too: the dash IS the grade. */
export { GRADE_DASH };

/** Text made safe to sit inside SVG markup or inside an attribute. */
export const escapeXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The stroke-dasharray attribute a grade is drawn with; nothing for a solid line. */
export const dashAttr = (grade) => (GRADE_DASH[grade] ? ` stroke-dasharray="${GRADE_DASH[grade]}"` : '');

const fontFace = (family, buf) => (buf ? `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${Buffer.from(buf).toString('base64')}) format("woff2");}` : '');

/** The text classes both pictures write with: sans prose, mono ids, small, bold, the second ink. */
function baseStyle(palette, fonts) {
  return `${fontFace('IBM Plex Sans', fonts.sans)}${fontFace('IBM Plex Mono', fonts.mono)}`
    + `.t{font-family:"IBM Plex Sans","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;font-size:13px;fill:${palette.t1}}`
    + `.m{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-size:12px;fill:${palette.t1}}`
    + `.s{font-size:11px}.b{font-weight:600}.c2{fill:${palette.t2}}`;
}

/**
 * One standalone SVG document: its size, the faces its text needs carried inside
 * it (a picture is opened where nothing is installed), its ground, and its body.
 *
 * @param {{width:number, height:number, palette:object, fonts?:{sans?:Buffer, mono?:Buffer}, style?:string, body:string}} doc
 * @returns {string}
 */
export function svgDocument({ width, height, palette, fonts = {}, style = '', body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<style>${baseStyle(palette, fonts)}${style}</style><rect width="100%" height="100%" fill="${palette.g0}"/>`
    + `${body}</svg>`;
}

/** A grade mark: its label in mono inside a box stroked with the grade's own dash. */
export function gradeBadgeSvg({ x, y, width, grade, label = grade, palette }) {
  return `<g><rect x="${x}" y="${y}" width="${width}" height="16" fill="${palette.g1}" stroke="${palette.t1}" stroke-width="1"${dashAttr(grade)}/>`
    + `<text x="${x + width / 2}" y="${y + 12}" text-anchor="middle" class="m s">${escapeXml(label)}</text></g>`;
}
