// websquare.mjs — a WebSquare client, read as text (RM63).
//
// WHAT THIS MODULE OWNS. WebSquare (Inswave) is, with Nexacro, the frontend a
// large share of Korean public sector and financial systems is written in, and
// like Nexacro it looks nothing like the web the rest of this lane reads. A
// screen is an XML file under the application's `ui/` tree:
//
//     <html xmlns:w2="http://www.inswave.com/websquare" xmlns:xf="http://www.w3.org/2002/xforms">
//       <head meta_screenId="SP001M01" meta_screenName="Sample list">
//         <xf:model>
//           <xf:submission id="sbm_searchSample" action="/sample/searchSample" method="post" …/>
//         </xf:model>
//         <script type="text/javascript"><![CDATA[
//           scwin.btn_search_onclick = function () { $c.sbm.execute(sbm_searchSample); };
//         ]]></script>
//
// The request is DECLARED in the model and SENT from the script, by naming the
// declaration. So four text rules and nothing more:
//   the page        `xmlns:w2="http://www.inswave.com/websquare"`, which is what
//                   makes an `.xml` a screen and not a Spring or MyBatis file
//   the screen      `meta_screenId` / `meta_screenName` on `<head>`
//   the submissions every `<xf:submission id action method>`, by id
//   the script      the `<script>` bodies, handed to the same JavaScript reader
//                   a `.js` goes through, with their line numbers kept
//
// Which call SENDS a submission is a declaration (`packs/websquare.json`), not a
// rule here: the engine's own `$p.executeSubmission("id")`, and the common
// library WebSquare's own template ships (`$c.sbm.execute(sbm_x)`).
//
// WHAT IT MUST NEVER KNOW ABOUT: the syntax tree, the graph, the routes. It is
// handed text and hands back strings.

/** The namespace that makes an XML file a WebSquare page. */
export const WEBSQUARE_NS_RE = /xmlns:w2\s*=\s*["']http:\/\/www\.inswave\.com\/websquare/;

/** How far into a file the namespace is looked for: it sits on the root element. */
const HEAD_BYTES = 4096;

/** 4 MB. Past that a page is generated, not written. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/** The method a submission sends when it names none: WebSquare's default is POST. */
export const SUBMISSION_DEFAULT_METHOD = 'POST';

/** The verbs a submission's `method` can name, upper-cased. */
const VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** How many lines a piece of text ends after. */
function countLines(text) {
  return (String(text).match(/\n/g) ?? []).length;
}

/** Whether a file's text is a WebSquare page, read off its root element. */
export function isWebSquarePage(text) {
  return WEBSQUARE_NS_RE.test(String(text ?? '').slice(0, HEAD_BYTES));
}

/** The attributes of one start tag, by name. */
function attrsOf(tagText) {
  const out = new Map();
  for (const m of String(tagText).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2] ?? m[3] ?? '');
  }
  return out;
}

/**
 * The screen a page is: `meta_screenId` and `meta_screenName` on its `<head>`.
 *
 * @returns {{id:(string|null), title:(string|null), type:(string|null)}}
 */
export function websquarePageOf(text) {
  const src = String(text ?? '');
  const head = /<head\b([^>]*)>/i.exec(src);
  const attrs = head ? attrsOf(head[1]) : new Map();
  const pick = (k) => (attrs.get(k) ?? '').trim() || null;
  // `<w2:type>COMMON</w2:type>` is a library of shared functions, not a screen.
  const type = /<w2:type>\s*([A-Z_]+)\s*<\/w2:type>/.exec(src);
  return { id: pick('meta_screenId'), title: pick('meta_screenName'), type: type ? type[1] : null };
}

/**
 * Every `<xf:submission>` of a page, by id: the address it sends to, the method,
 * and the line it is declared on.
 *
 * @returns {Map<string, {action:(string|null), method:string, line:number}>}
 */
export function websquareSubmissions(text) {
  const src = String(text ?? '');
  const out = new Map();
  for (const m of src.matchAll(/<xf:submission\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g)) {
    const a = attrsOf(m[1]);
    const id = (a.get('id') ?? '').trim();
    if (id === '' || out.has(id)) continue;
    const verb = (a.get('method') ?? '').trim().toUpperCase();
    const action = (a.get('action') ?? '').trim();
    out.set(id, {
      action: action === '' ? null : action,
      method: VERBS.has(verb) ? verb : SUBMISSION_DEFAULT_METHOD,
      line: countLines(src.slice(0, m.index)) + 1,
    });
  }
  return out;
}

/**
 * The JavaScript of a page: every `<script>` body without a `src`, CDATA
 * wrapper taken off, with the line its first line of code is on.
 *
 * @returns {{code:string, lang:string, setup:boolean, lineOffset:number, line:number}[]}
 */
export function websquareScriptBlocks(text) {
  const src = String(text ?? '');
  const out = [];
  for (const m of src.matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    let body = m[2];
    let start = m.index + m[0].indexOf('>') + 1;
    const cdata = /^(\s*)<!\[CDATA\[/.exec(body);
    if (cdata) {
      start += cdata[0].length;
      body = body.slice(cdata[0].length);
      const end = body.lastIndexOf(']]>');
      if (end >= 0) body = body.slice(0, end);
    }
    const lineOffset = countLines(src.slice(0, start));
    out.push({ code: body, lang: 'js', setup: false, lineOffset, line: lineOffset + 1 });
  }
  return out;
}

/**
 * The calls that SEND a submission, as the packs declare them, keyed by the
 * receiver as written and the method: `$c.sbm execute`, `$p executeSubmission`.
 *
 * @param {object[]} packs
 * @returns {Map<string, {argIs:string, idKey:string, actionKey:string, methodKey:string}>}
 */
export function submissionSinks(packs) {
  const out = new Map();
  for (const p of packs ?? []) {
    for (const s of p.submissionSinks ?? []) {
      if (typeof s.receiver !== 'string' || typeof s.method !== 'string') continue;
      out.set(`${s.receiver} ${s.method}`, {
        argIs: s.argIs ?? 'submission',
        idKey: s.idKey ?? 'id',
        actionKey: s.actionKey ?? 'action',
        methodKey: s.methodKey ?? 'method',
      });
    }
  }
  return out;
}
