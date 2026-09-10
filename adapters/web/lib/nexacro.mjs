// nexacro.mjs — a Nexacro client, read as text (RM56).
//
// WHAT THIS MODULE OWNS. Nexacro is the frontend a very large share of Korean
// public sector and enterprise systems is written in, and none of it looks like
// the web this lane already reads. A screen is an `.xfdl` file: XML that
// declares a form and its widgets, with the screen's whole JavaScript inside
// one `<Script type="xscript5.0"><![CDATA[ … ]]></Script>` block. A shared
// library is an `.xjs`, which is JavaScript with an XML wrapper around it. The
// application file is an `.xadl`, and the SERVICE PREFIXES every url is written
// against sit in the typedef XML it names.
//
// So four text rules and nothing more:
//   the form      `<Form id="Pattern_01" titletext="SingleDetail">` — what this
//                 screen is called and what it is named on screen
//   the script    the `<Script>` bodies, handed to the same JavaScript reader a
//                 `.js` goes through, with their line numbers kept
//   the typedef   `<TypeDefinition url="..\default_typedef.xml"/>`, and the
//                 `<Service prefixid="svcurl" url="…/app/"/>` list in it,
//                 which is what turns `svcurl::userSelectVO.do` into a path
//   the includes  `include "Lib::Comm.xjs";` and `<Script … url="…">`, which is
//                 how a form pulls a shared script in
//
// WHAT IT MUST NEVER KNOW ABOUT: the syntax tree, the graph, the packs. It is
// handed text and hands back strings.

import path from 'node:path';
import { toPosix } from './ast.mjs';

/** The extension a Nexacro FORM is written in. One form, one screen, one file. */
export const NEXACRO_FORM_EXT = '.xfdl';

/** …and the extension its shared scripts are written in. */
export const NEXACRO_SCRIPT_EXT = '.xjs';

/**
 * The keys a Nexacro transaction's options object writes its url under.
 *
 * There is no one spelling: the native call takes the url as its second
 * argument, and every wrapper anybody has written since takes an object with a
 * name of its own for the same string. These are the names in circulation, and
 * they are a DECLARATION — a reader whose product uses another one adds it here
 * rather than to a rule.
 */
export const TRANSACTION_URL_KEYS = Object.freeze([
  'sController', 'svcUrl', 'strSvcUrl', 'sSvcUrl', 'sUrl', 'url',
]);

/** The method a Nexacro transaction sends. It posts; the route match accepts any. */
export const TRANSACTION_METHOD = 'ANY';

/** 4 MB. Past that an `.xfdl` is a generated screen, not one somebody wrote. */
export const MAX_FORM_BYTES = 4 * 1024 * 1024;

/** The `include "…";` directive, which is Nexacro's and not JavaScript's. */
const INCLUDE_STATEMENT_RE = /(^|[^\w$.])include\s+["'][^"']+["']\s*;?/g;

/** How many lines a piece of text ends after. */
function countLines(text) {
  return (String(text).match(/\n/g) ?? []).length;
}

/**
 * The `<Script>` bodies of an `.xfdl` or an `.xjs`, each with the LINE OFFSET
 * of its first line of code, so every line number this lane prints is a line of
 * the file itself.
 *
 * The CDATA wrapper is replaced by spaces of the same length rather than cut,
 * for the same reason: a call's line must be the line a reader opens.
 *
 * @param {string} text
 * @returns {{code:string, lang:string, setup:boolean, lineOffset:number, line:number}[]}
 */
export function nexacroScriptBlocks(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /<Script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/Script\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openEnd = m.index + '<Script'.length + m[1].length + 1;
    const lineOffset = countLines(src.slice(0, openEnd));
    let body = m[2];
    // `<![CDATA[` … `]]>` is a wrapper, not code. Blanked, never cut.
    body = body.replace(/<!\[CDATA\[/g, '         ').replace(/\]\]>/g, '   ');
    // `include "Lib::Comm.xjs";` is a Nexacro DIRECTIVE, not JavaScript. The
    // includes are read off the text before this (`nexacroIncludes`), so the
    // statement is blanked to spaces here rather than cut: a line number in a
    // call record has to be the line a reader opens.
    body = body.replace(INCLUDE_STATEMENT_RE, (whole) => whole.replace(/[^\n]/g, ' '));
    // xscript5 is JavaScript with OPTIONAL TYPE ANNOTATIONS on parameters
    // (`function(obj:Form, e:nexacro.ClickEventInfo)`), which is what
    // TypeScript's grammar is for. Read as `ts`, so a form whose handlers are
    // annotated parses instead of failing on its first function.
    out.push({ code: body, lang: 'ts', setup: false, lineOffset, line: lineOffset + 1 });
  }
  return out;
}

/** The attributes of one tag, lower-cased names, first spelling wins. */
function attributesOf(tagText) {
  const out = new Map();
  const re = /([:@\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(String(tagText ?? ''))) !== null) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * What one `.xfdl` says it is: the form's id and the title it shows.
 * @param {string} text
 * @returns {{id:(string|null), title:(string|null)}}
 */
export function nexacroFormOf(text) {
  const m = /<Form\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i.exec(String(text ?? ''));
  if (m === null) return { id: null, title: null };
  const attrs = attributesOf(m[1]);
  const id = attrs.get('id') ?? null;
  const title = attrs.get('titletext') ?? null;
  return { id: id === '' ? null : id, title: title === '' ? null : title };
}

/** The typedef this file names, as written, or null. */
export function nexacroTypedefUrl(text) {
  const m = /<TypeDefinition\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/i.exec(String(text ?? ''));
  if (m === null) return null;
  const url = attributesOf(m[1]).get('url') ?? '';
  return url === '' ? null : url.replace(/\\/g, '/');
}

/**
 * The service prefixes a typedef declares: `prefixid` (lower-cased, because
 * Nexacro matches them without regard to case) -> the PATH part of its url.
 *
 * A `file`, `form` or `js` service points at a directory of the client's own
 * assets and answers no request, so it is not a base for a transaction and is
 * left out; what stays is the services a request can be sent to.
 *
 * @param {string} xml  the typedef document
 * @returns {Map<string,string>}
 */
export function nexacroServices(xml) {
  const out = new Map();
  const re = /<Service\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi;
  let m;
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const attrs = attributesOf(m[1]);
    const id = (attrs.get('prefixid') ?? '').trim();
    const url = (attrs.get('url') ?? '').trim();
    const type = (attrs.get('type') ?? '').trim().toLowerCase();
    if (id === '' || url === '') continue;
    if (type === 'file' || type === 'form' || type === 'js' || type === 'image') continue;
    out.set(id.toLowerCase(), servicePathOf(url));
  }
  return out;
}

/**
 * The PATH part of a service url. A deployment's own address is written in
 * full (`http://localhost:8080/an-app/`), and the only half of it a route lives
 * under is the path (`/an-app`). A relative url is already a path.
 */
export function servicePathOf(url) {
  const s = String(url ?? '').trim();
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(s);
  const p = abs ? (abs[1] ?? '/') : s;
  const cleaned = p.replace(/^\.\//, '/').replace(/\/+$/, '');
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

/**
 * ONE TRANSACTION URL, RESOLVED. `svcurl::userSelectVO.do` is a service prefix
 * and a path; a bare `userSelectVO.do` is the path itself.
 *
 * A prefix no typedef declares is left ON the string rather than dropped: the
 * bridge then matches nothing and says so, which is the truth about it.
 *
 * @param {string} written
 * @param {Map<string,string>} services
 * @returns {{full:string, prefix:(string|null), base:(string|null)}}
 */
export function resolveTransactionUrl(written, services) {
  const s = String(written ?? '').trim();
  const at = s.indexOf('::');
  if (at < 0) return { full: s.startsWith('/') ? s : `/${s}`, prefix: null, base: null };
  const prefix = s.slice(0, at);
  const rest = s.slice(at + 2).replace(/^\/+/, '');
  const base = services.get(prefix.toLowerCase()) ?? null;
  if (base === null) return { full: s, prefix, base: null };
  return { full: `${base}/${rest}`.replace(/\/{2,}/g, '/'), prefix, base };
}

/**
 * The shared scripts one `.xfdl` or `.xjs` pulls in, as written.
 *
 * Two spellings, both of them the same act: `include "Lib::Comm.xjs";` in the
 * script, and `<Script … url="Lib::Comm.xjs">` in the markup. What is recorded
 * is the string; turning it into a file is the caller's job, because only the
 * caller knows where the root is.
 *
 * @param {string} text
 * @returns {string[]} once each, in source order
 */
export function nexacroIncludes(text) {
  const src = String(text ?? '');
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s === '' || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const inc = /(^|[^\w$])include\s+["']([^"']+)["']/g;
  let m;
  while ((m = inc.exec(src)) !== null) add(m[2]);
  const tag = /<Script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  while ((m = tag.exec(src)) !== null) {
    const url = attributesOf(m[1]).get('url');
    if (url) add(url);
  }
  return out;
}

/**
 * The FILE one include names, under a Nexacro root, or null.
 *
 * `Lib::Comm.xjs` is a service prefix and a file under it, and the prefixes
 * that answer here are the `file`/`js`/`form` ones the resolver above leaves
 * out — so the directory list comes in separately. A relative spelling
 * (`./Lib/Comm.xjs`) resolves against the including file's own directory.
 *
 * @param {string} written
 * @param {{fileDir:string, rootDir:string, dirs:Map<string,string>}} where
 * @returns {string|null} an absolute path, or null when nothing here names one
 */
export function resolveIncludeFile(written, { fileDir, rootDir, dirs }) {
  const s = String(written ?? '').trim().replace(/\\/g, '/');
  if (s === '') return null;
  const at = s.indexOf('::');
  if (at < 0) return path.resolve(fileDir, s);
  const prefix = s.slice(0, at).toLowerCase();
  const rest = s.slice(at + 2).replace(/^\/+/, '');
  const dir = dirs.get(prefix);
  if (dir === undefined) return null;
  return path.resolve(rootDir, dir, rest);
}

/**
 * The `file`/`js`/`form` services a typedef declares: prefix (lower-cased) ->
 * the directory, relative to the typedef's own directory. This is the half
 * `nexacroServices` leaves out, and it is what an include is resolved through.
 *
 * @param {string} xml
 * @returns {Map<string,string>}
 */
export function nexacroAssetDirs(xml) {
  const out = new Map();
  const re = /<Service\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi;
  let m;
  while ((m = re.exec(String(xml ?? ''))) !== null) {
    const attrs = attributesOf(m[1]);
    const id = (attrs.get('prefixid') ?? '').trim();
    const url = (attrs.get('url') ?? '').trim();
    const type = (attrs.get('type') ?? '').trim().toLowerCase();
    if (id === '' || url === '') continue;
    if (type !== 'file' && type !== 'js' && type !== 'form') continue;
    out.set(id.toLowerCase(), toPosix(url.replace(/\\/g, '/')));
  }
  return out;
}
