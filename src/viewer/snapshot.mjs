// snapshot.mjs — one answer of the viewer, written into one HTML file that opens anywhere.
//
// WHAT THIS MODULE OWNS. A Flow or an Impact picture is read on a screen that a
// running `cascade view` draws, and a report, a design review or a message to a
// colleague has no server behind it. So a SNAPSHOT is the page itself with the
// answer inside: the viewer's own markup, stylesheet and scripts, the fonts as
// data, the chosen language's catalogue, and the tool answers the picture was
// drawn from, exactly as the server returned them. The page, finding the answers
// in the file, reads them instead of asking; a question it does not hold (a
// deeper walk, another route, the source pane) is answered with a sentence that
// says so, never with a guess.
//
// WHY THE SAME PAGE AND NOT A SECOND RENDERER. The grades, the limits, the
// truncation notes and the evidence rail are drawn by the code a reader already
// trusts on the live screen. A second renderer written for export would be a
// second reading of the same answer, and the first place a HEURISTIC edge or a
// `truncated` note could quietly go missing is the one nobody looks at twice.
//
// ONE GENERATOR, TWO DOORS. The viewer's Export button and `cascade export` both
// hand this module a tab and its tool arguments; it asks the same tools and
// writes the same file. Nothing here reads a disk or a clock: the caller hands
// over the assets, the tool dispatcher and the time.

import { classicSource } from '../mcp/http.mjs';

/** The schema id a snapshot carries, so a page can tell one from anything else. */
export const SNAPSHOT_SCHEMA = 'cascade:snapshot:1';

/**
 * The tabs a snapshot can be of, and what each one's `flow` question looks like.
 * `depth` is the value each tab's control opens on; `screenDepth` is the one a
 * screen entry needs (the page raises the control to it, and a snapshot asks
 * what the page would have asked).
 */
export const SNAPSHOT_TABS = Object.freeze({
  flow: Object.freeze({ direction: 'down', kinds: Object.freeze(['endpoint', 'screen', 'symbol']), depth: 6, screenDepth: 8 }),
  impact: Object.freeze({ direction: 'up', kinds: Object.freeze(['table', 'column', 'statement', 'symbol']), depth: 8, screenDepth: 8 }),
});

/** The modes both tabs offer, and the one they open on. */
export const SNAPSHOT_MODES = Object.freeze(['strict', 'conservative', 'heuristic']);
const DEFAULT_MODE = 'conservative';

/** The depth control's range on both tabs. */
const DEPTH_MIN = 1;
const DEPTH_MAX = 8;

/** The row limit a chain opens on, and the most one snapshot may ask for. */
const DEFAULT_LIMIT = 40;
const LIMIT_MAX = 1000;

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

const bad = (message) => new SnapshotError('bad-input', message);

/** An integer in a range, or the default when absent. */
function intIn(raw, name, { min, max, dflt }) {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * THE QUESTION ONE SNAPSHOT ANSWERS, in the exact shape the page sends it.
 *
 * The page matches a question to a stored answer by its arguments, so the
 * arguments are built here the way `drawChain` builds them: the entry under its
 * kind, then mode, depth and limit, and `direction: 'up'` on the Impact tab.
 *
 * @param {string} tab  'flow' | 'impact'
 * @param {{kind:string, value:string, mode?:string, depth?:number, limit?:number}} raw
 * @returns {{tab:string, entry:{kind:string, value:string}, args:object}}
 */
export function snapshotQuery(tab, raw = {}) {
  const def = SNAPSHOT_TABS[tab];
  if (!def) throw bad(`a snapshot is of the ${Object.keys(SNAPSHOT_TABS).join(' or the ')} tab, got ${JSON.stringify(tab)}`);
  const kind = raw.kind;
  if (!def.kinds.includes(kind)) throw bad(`the ${tab} tab starts from ${def.kinds.join(', ')}, got ${JSON.stringify(kind)}`);
  const value = typeof raw.value === 'string' ? raw.value.trim() : '';
  if (value === '') throw bad(`name the ${kind} the ${tab} picture starts from`);
  const mode = raw.mode ?? DEFAULT_MODE;
  if (!SNAPSHOT_MODES.includes(mode)) throw bad(`mode must be ${SNAPSHOT_MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  // A screen is further out than a route, and the page raises its opening depth
  // to the screen default for the same reason; a depth somebody chose stays.
  const opening = kind === 'screen' ? def.screenDepth : def.depth;
  let depth = intIn(raw.depth, 'depth', { min: DEPTH_MIN, max: DEPTH_MAX, dflt: opening });
  if (kind === 'screen' && depth === def.depth) depth = def.screenDepth;
  const limit = intIn(raw.limit, 'limit', { min: 1, max: LIMIT_MAX, dflt: DEFAULT_LIMIT });
  const args = def.direction === 'up' ? { direction: 'up', [kind]: value } : { [kind]: value };
  Object.assign(args, { mode, depth, limit });
  return { tab, entry: { kind, value }, args };
}

/**
 * The same question read back out of the arguments a page sent, so the Export
 * button and the command line are checked by one rule.
 */
export function snapshotQueryFromArgs(tab, args = {}) {
  const def = SNAPSHOT_TABS[tab];
  if (!def) return snapshotQuery(tab, {});
  const kind = def.kinds.find((k) => typeof args[k] === 'string');
  return snapshotQuery(tab, { kind, value: kind ? args[kind] : '', mode: args.mode, depth: args.depth, limit: args.limit });
}

/** A file name a reader can recognise: project, tab and entry, nothing else. */
export function snapshotFilename(projectId, query) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
  return `cascade-${slug(projectId)}-${query.tab}-${slug(query.entry.value)}.html`;
}

/**
 * THE SNAPSHOT'S DATA: everything the page will read instead of the server.
 *
 * `callTool` is the dispatcher bound to ONE project, so the answers are the
 * ones `/api/call` would have returned for it, basis, trust, limits and
 * truncation included. A tool that refuses (an unknown route) throws, and no
 * file is written for a question with no answer.
 *
 * @param {{query:object, project:object, meta:object, callTool:(name:string, args:object)=>object,
 *          lang?:string, catalogs?:object, generatedAt:string, engine:{name:string, version:string}}} input
 */
export function buildSnapshot({ query, project, meta, callTool, lang = 'en', catalogs = {}, generatedAt, engine }) {
  const calls = [
    // The masthead and the trust line read the Overview on every tab.
    { name: 'overview', args: {} },
    { name: 'flow', args: query.args },
  ].map((c) => ({ ...c, answer: callTool(c.name, c.args) }));
  const chosen = lang !== 'en' && catalogs[lang] ? { [lang]: catalogs[lang] } : {};
  return {
    schema: SNAPSHOT_SCHEMA,
    tab: query.tab,
    entry: query.entry,
    args: query.args,
    project,
    meta,
    calls,
    lang: Object.keys(chosen).length > 0 ? lang : 'en',
    catalogs: chosen,
    generatedAt,
    engine,
  };
}

/** JSON that can sit inside a <script> element without ending it. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Script text that cannot close its own element early. */
const inlineScript = (code) => `<script>${String(code).replace(/<\/script/gi, '<\\/script')}</script>`;

/** The head script that reads a remembered theme: a snapshot opens in its own. */
const THEME_HEAD_RE = /<script>try\{var _th=localStorage\.getItem\('cascade\.viewer\.theme'\)[^<]*<\/script>\n?/;

/** The font files the stylesheet names, by their path under /vendor/fonts/. */
const FONT_URL_RE = /url\("\/vendor\/fonts\/([A-Za-z0-9._-]+\.woff2)"\)/g;

/**
 * THE FILE. The viewer's page with every server path replaced by what it points
 * at, and the snapshot data placed before the first script, so the page's own
 * scripts find it when they load.
 *
 * @param {{html:string, snapshot:object, readScript:(name:string)=>string,
 *          readLib:(name:string)=>string, readFont:(name:string)=>Buffer, title:string}} input
 * @returns {string}
 */
export function snapshotHtml({ html, snapshot, readScript, readLib, readFont, title }) {
  let page = String(html)
    .replace(THEME_HEAD_RE, '')
    .replace(/<html lang="[^"]*" data-theme="[^"]*">/, `<html lang="${snapshot.lang === 'ko' ? 'ko' : 'en'}" data-theme="drawing">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(FONT_URL_RE, (_m, name) => `url("data:font/woff2;base64,${Buffer.from(readFont(name)).toString('base64')}")`);
  let first = true;
  page = page.replace(/<script src="([^"]+)"><\/script>/g, (_m, src) => {
    const lead = first ? inlineScript(`window.CASCADE_SNAPSHOT=${scriptJson(snapshot)};`) : '';
    first = false;
    // The map renderers draw the Graph tab, which a snapshot does not carry.
    if (src.startsWith('/vendor/')) return lead;
    if (src.startsWith('/viewer/lib/')) return lead + inlineScript(classicSource(readLib(src.slice('/viewer/lib/'.length).replace(/\.js$/, ''))));
    if (src.startsWith('/viewer/js/')) return lead + inlineScript(readScript(src.slice('/viewer/js/'.length)));
    throw new SnapshotError('contract-violation', `the viewer page loads ${src}, which a snapshot does not know how to carry`);
  });
  // A path left pointing at the server is a file that breaks the moment it is
  // opened somewhere else, so it is refused here rather than found there.
  const left = /(?:src|href)="\/(?!\/)|url\("\/(?!\/)/.exec(page);
  if (left) throw new SnapshotError('contract-violation', `the snapshot still points at the server near ${JSON.stringify(page.slice(left.index, left.index + 60))}`);
  return page;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
