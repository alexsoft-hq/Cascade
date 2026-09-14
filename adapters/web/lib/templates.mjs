// templates.mjs — a SERVER-RENDERED page, read as text (RM48).
//
// WHAT THIS MODULE OWNS. A template is HTML with another language written
// through it. Three of those languages are read here — Thymeleaf, FreeMarker
// and JSP — plus plain HTML, and every one of them is read for the same four
// things: the inline scripts, the forms, the links and the includes.
//
// Nothing here understands the template language. The directives are
// NEUTRALISED into placeholders so the JavaScript inside a `<script>` still
// parses, and the readers are text rules over the tags. Two things survive that
// neutralisation on purpose: the LINE numbers, because a call record points at a
// line of the template itself, and the application's CONTEXT PATH, because a URL
// written on it is a URL written from the root.
//
// It also owns the two rules that read an HTML template for the components it
// mounts (`customElementTags`, `soleElementTag`), which is what a frontend
// written before modules uses instead of an import.
//
// WHAT IT MUST NEVER KNOW ABOUT: the JavaScript walk, the declaration packs,
// the graph. It is handed text and hands back records.

import path from 'node:path';
import { toPosix } from './ast.mjs';
import { VERBS } from './calls.mjs';

// ---------------------------------------------------------------------------
// HTML templates: custom element tags, and nothing else
// ---------------------------------------------------------------------------

/** 512 KB. Past that a `.html` is a generated page, not a component's template. */
export const MAX_TEMPLATE_BYTES = 512 * 1024;

/**
 * The CUSTOM ELEMENT TAGS a template names, in source order, once each.
 *
 * A hyphen in a tag name is what the HTML specification reserves for elements
 * the page defines itself, so it is the whole rule here. Nothing else about the
 * markup is read: no attributes, no directives, no bindings. A frontend written
 * before modules mounts one component inside another by writing its tag, and
 * that is the one thing this lane needs the markup for.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function customElementTags(html) {
  const out = [];
  const seen = new Set();
  const re = /<([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    const tag = m[1];
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * The ONE element a template string is, when that is all it is.
 *
 * `template: '<owner-list></owner-list>'` names a component by its tag as
 * plainly as `component: 'ownerList'` names it by its name. The hyphen rule
 * above is NOT applied here: a component registered as `visits` is mounted as
 * `<visits>`, with no hyphen anywhere, and a template that is nothing but one
 * element is naming that element whatever it is spelled like. A template with
 * markup around it names no single component, and this answers null for it
 * rather than picking the first tag it sees; a template that is one ORDINARY
 * element (`<div></div>`) answers with that name and resolves to nothing, which
 * is the truth about it.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function soleElementTag(text) {
  const s = String(text ?? '').trim();
  const m = /^<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/>|>\s*<\/\1\s*>|>)$/.exec(s);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Server-rendered pages: templates (RM48)
// ---------------------------------------------------------------------------
//
// A template is HTML with another language written through it. Three of those
// languages are read here — Thymeleaf, FreeMarker and JSP — plus plain HTML,
// and every one of them is read for the same four things: the inline scripts,
// the forms, the links and the includes. Nothing else about the markup matters,
// and nothing here understands the template language: the directives are
// NEUTRALISED into placeholders so the JavaScript inside a `<script>` still
// parses, and the four readers below are text rules over the tags.

/** What a neutralised directive leaves behind: a name the parser accepts. */
const EXPR_MARKER = '__cascade_expr__';
/**
 * ...and the one expression that is not just a hole: the application's CONTEXT
 * PATH. `${request.contextPath}` is where this deployment is mounted, which is
 * the root every path in the page is written from, so a URL built on it is a
 * URL written from the root and the prefix is the empty string.
 */
export const CTX_MARKER = '__cascade_ctx__';

/** An expression that yields the context path: `…contextPath`, however qualified. */
const CONTEXT_PATH_EXPR = /^[\w.$\s]*\bcontextPath\s*$/;

/** Path prefixes that are served files rather than routes. */
const ASSET_PREFIXES = Object.freeze(['/webjars', '/resources', '/static', '/css', '/js', '/images', '/fonts']);

/** File extensions that are served files rather than routes. */
const ASSET_EXTENSIONS = Object.freeze([
  '.css', '.js', '.mjs', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.webp', '.bmp', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.pdf', '.zip',
  '.mp4', '.webm', '.mp3',
]);

/** A `type` a `<script>` can carry and still be JavaScript. */
const SCRIPT_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'text/ecmascript',
  'application/ecmascript', 'module',
]);

/** One tag, with quoted attribute values that may contain `>`. */
const TAG_RE = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/**
 * Replace a matched region with `marker`, keeping every line where it was.
 *
 * Line numbers are the only thing downstream needs from the shape of the text,
 * and they must survive: a `call` record points at a line of the TEMPLATE, not
 * at a line of some rewritten copy of it.
 */
function keepLines(marker, matched) {
  const newlines = (matched.match(/\n/g) ?? []).length;
  return newlines > 0 ? marker + '\n'.repeat(newlines) : marker;
}

/** The same, for a directive that leaves nothing behind at all. */
const blankOut = (matched) => matched.replace(/[^\n]/g, ' ');

/**
 * One `${…}` (or `#{…}`) interpolation, as the placeholder it becomes.
 * A context path becomes its own marker, because the bridge treats it as the
 * app root; everything else is a hole with a name a parser will accept.
 */
function interpolationMarker(expr) {
  return CONTEXT_PATH_EXPR.test(String(expr ?? '')) ? CTX_MARKER : EXPR_MARKER;
}

/**
 * The JSP custom tags that DO something and SAY nothing: control flow, a
 * variable set, a parameter handed to the tag around it. What is left of one in
 * a script is nothing at all.
 */
const JSP_CONTROL_TAGS = new Set([
  'c:if', 'c:foreach', 'c:fortokens', 'c:choose', 'c:when', 'c:otherwise',
  'c:set', 'c:remove', 'c:catch', 'c:param', 'c:import', 'spring:param',
]);

/** The two tags that write an address: `<c:url value>` and `<spring:url value>`. */
const JSP_URL_TAGS = new Set(['c:url', 'spring:url']);

/** One custom tag: `<prefix:name …>`, `<prefix:name …/>` or `</prefix:name>`, quoted values allowed. */
const JSP_TAG_RE = /<(\/?)([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/**
 * A JSP custom tag taken out of a script, lines kept (RM60).
 *
 * THE TAG IS THE JSP'S, NOT THE SCRIPT'S. The page is rendered before the
 * browser sees it, so `var t = "<spring:message code="x"/>";` is a string with
 * text in it by then, and the double quotes inside the tag are the JSP's own
 * attribute syntax. Left in place they end the JavaScript string early, and
 * the whole block fails to parse: measured, that was 348 of the 739 pages of
 * the eGovFrame common components losing every call their scripts make.
 *
 * So a tag becomes what it renders to, as far as a reader of the script can
 * tell. An address tag becomes its address, written from the application root
 * (the context-path marker in front, the way `${pageContext.request.contextPath}`
 * becomes one). A closing tag and a control tag become nothing. Every other tag
 * is a value the server fills in, so it becomes the interpolation marker. None
 * of the three leaves a quote behind.
 */
export function neutralizeJspTags(code) {
  const one = (text, depth) => String(text).replace(JSP_TAG_RE, (m, closing, rawName, attrs) => {
    const name = rawName.toLowerCase();
    if (closing === '/' || JSP_CONTROL_TAGS.has(name)) return blankOut(m);
    if (!JSP_URL_TAGS.has(name)) return keepLines(EXPR_MARKER, m);
    const written = attributesOf(attrs).get('value');
    if (written === undefined) return keepLines(EXPR_MARKER, m);
    const inner = depth > 0 ? one(written, depth - 1) : written;
    // The address the tag writes, from the root: a context path in front of it
    // is the root itself, and any other expression in it is a hole, spelled the
    // way this lane spells one, so `/cop/bbs${prefix}/list.do` stays a path.
    const value = inner.replace(/^\s*[$#]\{[^{}]*\bcontextPath\s*\}/, '')
      .replace(/[$#]\{[^{}]*\}/g, '{*}').split(EXPR_MARKER).join('{*}')
      .replace(/["'\n]/g, '');
    return keepLines(`${CTX_MARKER}${value}`, m);
  });
  return one(code, 2);
}

/**
 * A template's own directives taken out of one `<script>` block, so what is left
 * is JavaScript.
 *
 * It is NOT a template-language parser and does not try to be. A directive is a
 * statement of the other language and leaves nothing behind; an interpolation is
 * a value and leaves a name. A block that still does not parse afterwards is
 * counted (`parseErrors`) and costs that block's calls, never the run.
 *
 * @param {string} code  the text between `<script>` and `</script>`
 * @param {string} engine
 * @returns {string} the same text, same number of lines
 */
export function neutralizeScript(code, engine) {
  let out = String(code ?? '');
  if (engine === 'freemarker') {
    out = out.replace(/<#--[\s\S]*?-->/g, blankOut);
    out = out.replace(/<\/?[#@][\w.]*(?:"[^"]*"|'[^']*'|[^>"'])*\/?>/g, blankOut);
  }
  if (engine === 'jsp') {
    out = out.replace(/<%--[\s\S]*?--%>/g, blankOut);
    out = out.replace(/<%@[\s\S]*?%>/g, blankOut);
    out = out.replace(/<%=([\s\S]*?)%>/g, (m) => keepLines(EXPR_MARKER, m));
    out = out.replace(/<%[\s\S]*?%>/g, blankOut);
    out = neutralizeJspTags(out);
  }
  if (engine === 'thymeleaf' || engine === 'plain-html') {
    // `[[…]]` and `[(…)]` are Thymeleaf's inline expressions. A link expression
    // inside one is a URL the page really uses, so it keeps its path.
    out = out.replace(/\[\(([\s\S]*?)\)\]|\[\[([\s\S]*?)\]\]/g, (m, a, b) => {
      const inner = String(a ?? b ?? '').trim();
      const link = /^@\{\s*'?([^'}]*)'?\s*\}$/.exec(inner);
      if (link) return keepLines(`'${link[1].trim()}'`, m);
      return keepLines(`'${interpolationMarker(inner)}'`, m);
    });
  }
  // Every engine here spells an interpolation `${…}`; JSP and FreeMarker also
  // accept `#{…}`. A JavaScript template literal is spelled the same way, and
  // the template engine would have eaten it before the browser saw it anyway.
  out = out.replace(/[$#]\{([^{}]*)\}/g, (m, expr) => keepLines(interpolationMarker(expr), m));
  return out;
}

/**
 * Every inline `<script>` of a template, as a block the JavaScript reader takes.
 *
 * A block with `src` loads a file that is read as a source file in its own
 * right; a block with a `type` that is not JavaScript is a client-side template
 * or a data island, and parsing it as code would be a parse error per page.
 *
 * @param {string} text  the whole template
 * @param {string} engine
 * @returns {{code:string, lang:string, setup:boolean, lineOffset:number, line:number}[]}
 */
export function templateScriptBlocks(text, engine) {
  const src = String(text ?? '');
  const out = [];
  const re = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = attributesOf(m[1]);
    if (attrs.has('src')) continue;
    if (!SCRIPT_TYPES.has((attrs.get('type') ?? '').trim().toLowerCase())) continue;
    // The body starts right after `<script` + the attributes + `>`.
    const lineOffset = countLines(src.slice(0, m.index + '<script'.length + m[1].length + 1));
    out.push({
      code: neutralizeScript(m[2], engine),
      lang: 'js',
      setup: false,
      lineOffset,
      line: lineOffset + 1,
    });
  }
  return out;
}

/** The attributes of one tag, lower-cased names, first spelling wins. */
export function attributesOf(tagText) {
  const out = new Map();
  const re = /([:@\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(String(tagText ?? ''))) !== null) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** How many lines a piece of text ends after. */
function countLines(text) {
  return (String(text).match(/\n/g) ?? []).length;
}

/**
 * A `href` or an `action` read as a path this application serves, or null.
 *
 * The four ways a template writes "a path from the app root" — Thymeleaf's
 * `@{…}`, an EL context path, JSTL's `<c:url>`, Spring's `<spring:url>` — all
 * mean the same thing and all come out as a path with one leading slash. A
 * static asset is not a route and is left out by prefix and by extension; a
 * query string is not part of a route and is dropped; an address with a host
 * belongs to somebody else.
 *
 * @param {string} raw  the attribute as written
 * @returns {string|null}
 */
export function templateUrlOf(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') return null;
  // `<c:url value="/x"/>` / `<spring:url value="/x"/>` written as the value.
  const tagValue = /^<(?:c|spring):url\b[^>]*\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>?/i.exec(s);
  if (tagValue) s = (tagValue[1] ?? tagValue[2] ?? '').trim();
  // Thymeleaf's link expression, with its `(a=…,b=…)` parameter list dropped.
  if (s.startsWith('@{') && s.endsWith('}')) {
    s = s.slice(2, -1).trim();
    s = dropTrailingParens(s);
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) s = s.slice(1, -1);
  }
  s = s.replace(/[$#]\{([^{}]*)\}/g, (m, expr) => (CONTEXT_PATH_EXPR.test(expr) ? '' : '{*}'));
  s = s.replace(/<%=[\s\S]*?%>/g, '{*}').replace(/<%[\s\S]*?%>/g, '{*}');
  s = s.replace(/\[\[[\s\S]*?\]\]|\[\([\s\S]*?\)\]/g, '{*}');
  s = s.trim();
  if (s === '' || s.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  s = s.split('#')[0].split('?')[0];
  // A Thymeleaf path variable is a hole like any other, spelled the way the
  // rest of this lane spells one.
  s = s.replace(/\{[A-Za-z_$][\w$]*\}/g, '{*}');
  if (!s.startsWith('/')) return null;
  const lower = s.toLowerCase();
  if (ASSET_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`))) return null;
  if (ASSET_EXTENSIONS.some((e) => lower.endsWith(e))) return null;
  return s;
}

/**
 * A STRING LITERAL WRITTEN IN A PAGE'S INLINE SCRIPT, read as a path (RM60).
 *
 * `location.href = "<c:url value='/x.do'/>"` and `<a href="<c:url value='/x.do'/>">`
 * are the same address written in the same file, and until now only the second
 * was read: the first came out as the tag's own text, which names no route. The
 * tag is not markup here, it is the JSP writing a path INTO the script before
 * the browser ever sees it, so it is filled in and the result goes through the
 * same reader an attribute does.
 *
 * A literal with no such directive in it answers null, and the caller keeps the
 * text as written: this rule is about what a template engine put there, not
 * about every string a page's script holds.
 *
 * @param {string} raw  the literal (or the flattened template) as written
 * @returns {string|null} the path from the app root, or null when this is not one
 */
export function templateScriptUrl(raw) {
  const s = String(raw ?? '');
  if (s === '') return null;
  let filled = false;
  const text = s.replace(/<(?:c|spring):url\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/gi, (whole, attrs) => {
    const value = attributesOf(attrs).get('value');
    if (value === undefined) return whole;
    filled = true;
    return value;
  });
  if (!filled && !(s.startsWith('@{') && s.endsWith('}'))) return null;
  // The page's own expressions are already placeholders by the time a script
  // block is parsed, so `<c:url value='/cop/bbs${prefix}/list.do'/>` arrives
  // with the marker in it. It is a hole like any other, and this lane spells
  // one `{*}`. THE CONTEXT PATH IS NOT: it is the app root, taken off the front
  // by the page reader further down, so its marker rides through untouched.
  const ctx = text.startsWith(CTX_MARKER);
  const read = templateUrlOf((ctx ? text.slice(CTX_MARKER.length) : text).split(EXPR_MARKER).join('{*}'));
  if (read === null) return null;
  return ctx ? `${CTX_MARKER}${read}` : read;
}

/**
 * EVERY `<form>` A TEMPLATE DECLARES, with the name a script calls it by and
 * the method it sends (RM60).
 *
 * `templateForms` above answers a different question: which forms are call sites
 * of the page because their `action` is written in the markup. This one is the
 * table a SCRIPT is read against — a form whose action is assigned in JavaScript
 * has no `action` attribute at all — so every form is listed, whether or not it
 * names an address.
 *
 * THE DEFAULT IS THE TAG'S. `<form>` is HTML and sends GET; `<form:form>` is
 * Spring's own tag and sends POST. Neither is a guess: both are written in the
 * specification the page is rendered by.
 *
 * @param {string} text
 * @returns {{tag:string, name:(string|null), id:(string|null), action:(string|null), method:string, line:number}[]}
 */
export function templateFormElements(text) {
  const src = String(text ?? '');
  const out = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag !== 'form' && tag !== 'form:form') continue;
    const attrs = attributesOf(m[2]);
    const spelled = (attrs.get('th:method') ?? attrs.get('method') ?? '').trim().toUpperCase();
    const actionAttr = ['th:action', 'data-th-action', 'action'].find((a) => attrs.has(a)) ?? null;
    out.push({
      tag,
      name: attrs.get('name') ?? null,
      id: attrs.get('id') ?? null,
      action: actionAttr === null ? null : attrs.get(actionAttr),
      method: VERBS.has(spelled) ? spelled : (tag === 'form:form' ? 'POST' : 'GET'),
      line: countLines(src.slice(0, m.index)) + 1,
    });
  }
  return out;
}

/** `'/a/{b}(b=${x})'` -> `'/a/{b}'`: the trailing balanced parenthesis, dropped. */
function dropTrailingParens(s) {
  if (!s.endsWith(')')) return s;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] === ')') depth += 1;
    else if (s[i] === '(') {
      depth -= 1;
      if (depth === 0) return s.slice(0, i).trim();
    }
  }
  return s;
}

/**
 * The forms a template declares: one call site each, the method as written.
 * @param {string} text
 * @returns {{line:number, url:string, method:string, written:string, attr:string}[]}
 */
export function templateForms(text) {
  const src = String(text ?? '');
  const out = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag !== 'form' && tag !== 'form:form') continue;
    const attrs = attributesOf(m[2]);
    const attr = ['th:action', 'data-th-action', 'action'].find((a) => attrs.has(a)) ?? null;
    if (attr === null) continue;
    const written = attrs.get(attr);
    const url = templateUrlOf(written);
    if (url === null) continue;
    const spelled = (attrs.get('th:method') ?? attrs.get('method') ?? 'GET').trim().toUpperCase();
    out.push({
      line: countLines(src.slice(0, m.index)) + 1,
      url,
      method: VERBS.has(spelled) ? spelled : 'GET',
      written,
      attr,
    });
  }
  return out;
}

/**
 * The links a template opens: one GET call site each.
 * @param {string} text
 * @returns {{line:number, url:string, written:string, attr:string}[]}
 */
export function templateLinks(text) {
  const src = String(text ?? '');
  const out = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = attributesOf(m[2]);
    const attr = ['th:href', 'data-th-href', 'href'].find((a) => attrs.has(a)) ?? null;
    if (attr === null) continue;
    const written = attrs.get(attr);
    const url = templateUrlOf(written);
    if (url === null) continue;
    out.push({ line: countLines(src.slice(0, m.index)) + 1, url, written, attr });
  }
  return out;
}

/**
 * The templates one template pulls in, as written.
 *
 * JSP and FreeMarker resolve an include against the INCLUDING FILE's directory
 * (a leading slash means the template root); Thymeleaf resolves a fragment
 * expression against the template root always. That difference is the whole of
 * what `relativeTo` records.
 *
 * @param {string} text
 * @param {string} engine
 * @returns {{written:string, kind:string, relativeTo:('file'|'root')}[]}
 */
export function templateIncludes(text, engine) {
  const src = String(text ?? '');
  const out = [];
  const add = (written, kind, relativeTo) => {
    const w = String(written ?? '').trim();
    if (w === '' || w.includes('${') || w.includes('<%')) return;
    if (!out.some((e) => e.written === w && e.kind === kind)) out.push({ written: w, kind, relativeTo });
  };
  if (engine === 'jsp') {
    for (const m of src.matchAll(/<%@\s*include\s+file\s*=\s*(?:"([^"]*)"|'([^']*)')\s*%>/g)) {
      add(m[1] ?? m[2], 'jsp-directive', 'file');
    }
    for (const m of src.matchAll(/<jsp:include\b[^>]*\bpage\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      add(m[1] ?? m[2], 'jsp-include', 'file');
    }
  }
  if (engine === 'freemarker') {
    for (const m of src.matchAll(/<#(include|import)\s+(?:"([^"]*)"|'([^']*)')/g)) {
      add(m[2] ?? m[3], `freemarker-${m[1]}`, 'file');
    }
  }
  if (engine === 'thymeleaf' || engine === 'plain-html') {
    const re = new RegExp(TAG_RE.source, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const attrs = attributesOf(m[2]);
      for (const name of ['th:replace', 'th:insert', 'th:include', 'data-th-replace', 'data-th-insert', 'data-th-include']) {
        if (!attrs.has(name)) continue;
        const target = thymeleafFragmentTemplate(attrs.get(name));
        if (target !== null) add(target, `thymeleaf-${name.split(':').pop()}`, 'root');
      }
    }
  }
  return out;
}

/** The TEMPLATE half of `~{tpl :: frag(…)}`, or null when the fragment is this file's own. */
export function thymeleafFragmentTemplate(value) {
  let s = String(value ?? '').trim();
  if (s.startsWith('~{') && s.endsWith('}')) s = s.slice(2, -1).trim();
  const cut = s.indexOf('::');
  if (cut >= 0) s = s.slice(0, cut).trim();
  s = dropTrailingParens(s).trim();
  if (s === '' || s.includes('$') || s.includes('{')) return null;
  return s;
}

/**
 * An include written in a template, resolved to a path under the template root.
 *
 * Lexical only: no file is opened and none is stat-ed, so a shard describes the
 * bytes of its own file and nothing else.
 *
 * @param {string} written
 * @param {{fromDir:string, relativeTo:string, suffix:string}} how
 *        `fromDir` is the including template's directory, relative to the root
 * @returns {string|null} the include's name relative to the template root, without the suffix
 */
export function resolveIncludeName(written, how) {
  const w = String(written ?? '').trim();
  if (w === '') return null;
  const base = (how.relativeTo === 'root' || w.startsWith('/')) ? '' : String(how.fromDir ?? '');
  const segments = [];
  for (const seg of `${base}/${w}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (segments.length > 0) segments.pop(); continue; }
    segments.push(seg);
  }
  let name = segments.join('/');
  if (name === '') return null;
  const suffix = String(how.suffix ?? '');
  if (suffix !== '' && name.endsWith(suffix)) name = name.slice(0, name.length - suffix.length);
  return name;
}

/**
 * THE APP ROOT TAKEN OFF THE FRONT of every address a page's scripts wrote.
 *
 * A URL written on the application's context path is a URL written from the
 * root, so the marker the neutraliser left is taken off and the record says the
 * context path was there. A URL built on a NAME the context path was assigned
 * to is stripped the same way when the name is assigned in this file.
 */
function stripContextPath(records, isContextVar) {
  for (const { rec } of records) {
    // A navigation left in a page (an address with no path) is written on the
    // same root, and the marker is no part of where it goes either.
    const url = rec.kind === 'call' ? rec.url : rec.kind === 'navigation' ? rec.to : null;
    if (!url || !Array.isArray(url.resolved)) continue;
    let stripped = false;
    url.resolved = url.resolved.map((r) => {
      if (typeof r.template !== 'string') return r;
      if (r.template.startsWith(CTX_MARKER)) {
        stripped = true;
        return { ...r, template: r.template.slice(CTX_MARKER.length) };
      }
      if (typeof url.base === 'string' && isContextVar.has(url.base) && r.template.startsWith('{*}')) {
        stripped = true;
        return { ...r, template: r.template.slice(3), dynamicParts: Math.max(0, (r.dynamicParts ?? 1) - 1) };
      }
      return r;
    });
    if (stripped) url.contextPath = true;
  }
}

/**
 * Everything one template file says, on top of what its inline scripts said.
 *
 * It also EDITS the calls the scripts produced, in the one way only this file
 * can: a URL written on the application's context path is a URL written from
 * the root, so the marker the neutraliser left is taken off the front and the
 * call says the context path was there. A URL built on a NAME the context path
 * was assigned to is stripped the same way when the name is assigned here; when
 * it is assigned in a template this one includes, only the bridge can see that,
 * and `url.base` is what it reads.
 *
 * @param {{abs:string, relFile:string, text:string, root:string,
 *          tmpl:{root:string, engine:string, suffix:string},
 *          records:{order:number, line:number, rec:object}[]}} a
 * @returns {{order:number, line:number, rec:object}[]}
 */
export function templateRecordsOf(a) {
  const { relFile, text, root, tmpl, records } = a;
  const rootRel = toPosix(path.relative(root, tmpl.root));
  const nameRel = toPosix(path.relative(tmpl.root, a.abs));
  const name = nameRel.endsWith(tmpl.suffix) ? nameRel.slice(0, nameRel.length - tmpl.suffix.length) : nameRel;
  const fromDir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';

  // The names this file binds the context path to.
  const contextVars = [...new Set(records
    .filter((r) => r.rec.kind === 'constant' && r.rec.value === CTX_MARKER)
    .map((r) => r.rec.name))].sort();
  const isContextVar = new Set(contextVars);

  stripContextPath(records, isContextVar);

  const includes = [];
  for (const inc of templateIncludes(text, tmpl.engine)) {
    const target = resolveIncludeName(inc.written, { fromDir, relativeTo: inc.relativeTo, suffix: tmpl.suffix });
    if (target === null) continue;
    includes.push({
      written: inc.written,
      kind: inc.kind,
      name: target,
      file: `${rootRel === '' ? '' : `${rootRel}/`}${target}${tmpl.suffix}`,
    });
  }

  const out = [];
  const forms = templateForms(text);
  const links = templateLinks(text);
  out.push({
    order: -0.5,
    line: 1,
    rec: {
      kind: 'template', file: relFile, line: 1,
      engine: tmpl.engine, root: rootRel, name, suffix: tmpl.suffix,
      includes, contextVars,
      scripts: a.scripts ?? 0, forms: forms.length, links: links.length,
    },
  });

  // A form and a link are call sites of the PAGE ITSELF, so they sit on the
  // page's module symbol beside whatever its scripts do. The order base keeps
  // them apart from a script's calls on the same line without either having to
  // know about the other.
  let ordinal = 1e6;
  const siteOf = (line, url, method, from, rule, attr, written) => {
    const holes = (url.match(/\{\*\}/g) ?? []).length;
    return {
      order: ordinal++,
      line,
      rec: {
        kind: 'call', file: relFile, line,
        enclosing: '(module)',
        callee: { shape: 'template', root: rule, path: [], name: rule },
        binding: null,
        args: [],
        url: {
          arg: { kind: 'string', value: url },
          resolved: [{ template: url, dynamicParts: holes, via: holes > 0 ? 'template' : 'literal' }],
        },
        method: { value: method, from },
        platformSink: null,
        template: { rule, attr, written },
      },
    };
  };
  for (const f of forms) out.push(siteOf(f.line, f.url, f.method, 'template-attribute', 'template-form', f.attr, f.written));
  for (const l of links) out.push(siteOf(l.line, l.url, 'GET', 'template-link', 'template-link', l.attr, l.written));
  return out;
}
