// source.mjs — live source preview, read straight from the working tree.
//
// Because `cascade view` runs locally on the repo the pack was built from, the
// viewer does not need SQL text baked into the pack (the old server did). It
// reads the CURRENT file from disk on demand — so a statement preview reflects
// what is on disk right now, not a snapshot. That is the real-time behavior and
// it is more honest: no stale embedded copy to drift from source.
//
// WHAT AN ANSWER CARRIES (RM27b). The page draws a real source pane: a line
// number gutter, the lines the answer is about marked, and an "open in editor"
// control. None of that can be derived in the browser, so every one of its
// inputs is answered here:
//   `file`       the path relative to the repo, as the graph records it
//   `abs`        the same path, absolute (this server is local by design)
//   `from`/`to`  the 1-based line range the extractor cut, inside the file
//   `fileLines`  how many lines that file has
//   `snippet`    the cut itself, or `text` when the caller asked for the whole
//                file (`io.whole`), capped so a generated file cannot flood a
//                page that has to hold it in one string.
//   `mark`       one line INSIDE the range to land on, when the cut is a whole
//                file and the answer is about a point in it (a screen's
//                component: the file IS the preview, and the line its script
//                starts on is what the router reached). Absent everywhere else.
// The RANGE IS THE SAME in both modes: the whole-file view is the snippet's own
// lines with the rest of the file around them, never a different answer.
//
// Pure except for an injected `readFile(absPath)->string`; path access is
// confined to `repoRoot` (a resolved-path prefix check defeats `..` escapes).

import path from 'node:path';

// How much of a whole file one answer may carry. A minified bundle or a
// generated mapper runs to megabytes, and the page holds the answer in one
// string: past this the answer is cut and SAYS it was cut, rather than being
// silently complete-looking.
export const WHOLE_FILE_CAP = 1024 * 1024;

/**
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {string} repoRoot  absolute path of the repo the pack was built from
 * @param {string} nodeId
 * @param {{readFile:(abs:string)=>string, ddlPath?:string, whole?:boolean}} io
 * @returns {{kind:string, ok:boolean, file:string|null, abs:string|null, lang:string,
 *            snippet?:string, text?:string, from:number|null, to:number|null,
 *            fileLines:number|null, mark?:number, note?:string}}
 */
export function readSourceFor(graph, repoRoot, nodeId, io) {
  const node = graph.nodes.get(nodeId);
  if (!node) return miss('unknown', 'node not in pack: ' + nodeId);
  let lastAbs = null;
  const read = (rel) => {
    lastAbs = null;
    if (!rel) return null;
    const abs = path.resolve(repoRoot, rel);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + path.sep)) return null; // no escape
    try { const text = io.readFile(abs); lastAbs = abs; return text; } catch { return null; }
  };

  if (node.kind === 'statement') {
    const text = read(node.file);
    if (text == null) return miss('statement', node.file ? 'cannot read ' + node.file : 'no source file recorded for this statement', node.file, 'xml');
    const id = lastSeg(idKey(nodeId));
    const cut = extractXmlStatement(text, id);
    if (cut == null) {
      // The id is not in the file the graph named. Show the head of the file
      // and say so, rather than an empty pane.
      const head = text.length > 4000 ? text.slice(0, 4000) + '\n…' : text;
      return body('statement', node.file, lastAbs, 'xml', text, { snippet: head, from: 1, to: lineCount(head) },
        io, `could not locate id="${id}": showing the file`);
    }
    return body('statement', node.file, lastAbs, 'xml', text, cut, io);
  }

  // THE FRONTEND SIDE (RM31). A web function is not a Java method: it lives in
  // a .js/.ts module or inside the `<script>` block of a single-file component,
  // its extent is brace balance rather than a signature, and the language it is
  // painted in comes off the extension (a .vue file says its own in the script
  // tag). It is read here rather than in the Java branch because the Java one
  // resolves an OWNER type and a `Class#method` name, and a web symbol has
  // neither: its key IS `path/to/file.ext#function`.
  if (node.kind === 'symbol' && node.lane === 'web') {
    const file = node.file || idKey(nodeId).split('#')[0];
    const text = read(file);
    const lang = webLang(file, text);
    if (text == null) return miss('symbol', file ? 'cannot read ' + file : 'no source file recorded', file, lang);
    const cut = extractWebFunction(text, node.line, scriptEnd(text, file));
    return body('symbol', file, lastAbs, lang, text, cut, io, cut.note);
  }

  // A SCREEN IS A FILE, NOT A FUNCTION. What a route declares is the component
  // it mounts, so the preview is that whole file, with the line its script
  // starts on marked: the template above it is what the screen SHOWS, and
  // cutting it away would leave the reader with the half a router never named.
  if (node.kind === 'screen') {
    const file = node.component || null;
    if (!file) {
      return miss('screen', node.source === 'har'
        ? 'this screen was seen in a recording and declared in no source we read, so there is no component file to show'
        : 'the route declaration named no component this lane could resolve to a file, so there is nothing to show');
    }
    const text = read(file);
    const lang = webLang(file, text);
    if (text == null) return miss('screen', 'cannot read ' + file, file, lang);
    return body('screen', file, lastAbs, lang, text, wholeFileCut(text, file), io);
  }

  if (node.kind === 'symbol' || node.kind === 'endpoint') {
    // an endpoint previews its handler method
    const memberFqn = node.kind === 'endpoint' ? node.handler : idKey(nodeId);
    const owner = ownerOf(memberFqn);
    const method = memberFqn.includes('#') ? memberFqn.slice(memberFqn.lastIndexOf('#') + 1) : null;
    const file = node.file || fileOfOwner(graph, owner);
    const text = read(file);
    if (text == null) return miss(node.kind, file ? 'cannot read ' + file : 'no source file recorded', file, 'java');
    const cut = extractJavaMethod(text, method, node.line);
    return body(node.kind, file, lastAbs, 'java', text, cut, io, cut.note);
  }

  if ((node.kind === 'table' || node.kind === 'column') && io.ddlPath) {
    const abs = path.resolve(io.ddlPath);
    let text = null; try { text = io.readFile(abs); } catch { /* */ }
    if (text != null) {
      const table = node.kind === 'table' ? idKey(nodeId) : idKey(nodeId).split('.').slice(0, -1).join('.');
      const bare = table.includes('.') ? table.split('.').pop() : table;
      const cut = extractCreateTable(text, bare);
      if (cut) return body(node.kind, path.relative(repoRoot, abs) || io.ddlPath, abs, 'sql', text, cut, io);
    }
    return miss(node.kind, 'no CREATE TABLE found in the DDL', io.ddlPath, 'sql');
  }

  return miss(node.kind, `no source preview for a ${node.kind} node`);
}

/**
 * One found preview, in whichever of the two shapes the caller asked for. The
 * range is the extractor's either way: `whole` changes what TEXT comes back,
 * never which lines the answer is about.
 */
function body(kind, file, abs, lang, fileText, cut, io, note) {
  const out = { kind, ok: true, file: file ?? null, abs: abs ?? null, lang,
    from: cut.from, to: cut.to, fileLines: lineCount(fileText) };
  // ONE LINE INSIDE THE RANGE, when the cut is a whole file and the answer is
  // about a point in it (a screen's component: the file is the preview, the
  // script's first line is what the router actually reached). The range still
  // says what this preview COVERS; `mark` says where to look inside it.
  if (cut.mark != null) out.mark = cut.mark;
  if (note) out.note = note;
  if (!io.whole) { out.snippet = cut.snippet; return out; }
  if (fileText.length > WHOLE_FILE_CAP) {
    out.text = fileText.slice(0, WHOLE_FILE_CAP);
    out.note = `this file is ${fileText.length} bytes: showing the first ${WHOLE_FILE_CAP}`;
  } else out.text = fileText;
  return out;
}

function miss(kind, note, file = null, lang = 'text') {
  return { kind, ok: false, file, abs: null, lang, snippet: '', from: null, to: null, fileLines: null, note };
}
function lineCount(text) { return String(text).split('\n').length; }
/** The 1-based line a character offset sits on. */
function lineAt(text, at) { return lineCount(text.slice(0, at)); }
function idKey(id) { return id.slice(id.indexOf(':') + 1); }
function lastSeg(k) { const i = k.lastIndexOf('.'); return i < 0 ? k : k.slice(i + 1); }
function ownerOf(m) { const i = m.lastIndexOf('#'); return i < 0 ? m : m.slice(0, i); }
function fileOfOwner(graph, ownerFqn) {
  // symbol nodes carry file; find one for this owner
  for (const n of graph.nodes.values()) if (n.kind === 'symbol' && n.owner === ownerFqn && n.file) return n.file;
  return null;
}

// Extract a MyBatis statement element by its id attribute (statements do not
// nest inside a same-named element, so first matching close tag is correct).
// Returns the cut AND the 1-based line range it came from, because the page
// draws a gutter of real file lines beside it.
export function extractXmlStatement(text, id) {
  let at = text.indexOf(`id="${id}"`);
  if (at < 0) at = text.indexOf(`id='${id}'`);
  if (at < 0) return null;
  const start = text.lastIndexOf('<', at);
  if (start < 0) return null;
  const m = /^<\s*([\w:.-]+)/.exec(text.slice(start));
  if (!m) return null;
  const tag = m[1];
  const closeTok = `</${tag}>`;
  const close = text.indexOf(closeTok, at);
  if (close < 0) return null;
  const snippet = text.slice(start, close + closeTok.length);
  const from = lineAt(text, start);
  return { snippet, from, to: from + lineCount(snippet) - 1 };
}

// A method body from `line` (1-based) if given, else by finding `name(`; the end
// is found by brace balance from the first '{' (or a ';' for an abstract/iface
// method). Returns a bounded window so a giant method cannot flood the page,
// with the 1-based line range that window covers.
export function extractJavaMethod(text, name, line) {
  const lines = text.split('\n');
  let startLine;
  if (Number.isInteger(line) && line >= 1 && line <= lines.length) startLine = line - 1;
  else if (name) {
    const re = new RegExp('(^|[^\\w.])' + escapeRe(name) + '\\s*\\(');
    startLine = lines.findIndex((l) => re.test(l));
    if (startLine < 0) return head(lines, `could not locate ${name}(): showing the file head`);
  } else return head(lines);

  // scan forward for the method end (brace balance) within a window
  let depth = 0, seenBrace = false, endLine = startLine;
  const maxLine = Math.min(lines.length, startLine + 120);
  for (let i = startLine; i < maxLine; i++) {
    for (const ch of lines[i]) { if (ch === '{') { depth++; seenBrace = true; } else if (ch === '}') { depth--; } }
    if (seenBrace && depth <= 0) { endLine = i; break; }
    if (!seenBrace && lines[i].includes(';')) { endLine = i; break; } // abstract/interface
    endLine = i;
  }
  return { snippet: clip(lines, startLine, endLine + 1), from: startLine + 1, to: endLine + 1 };
}
/** The fallback window: the first 40 lines, and it says so when it is one. */
function head(lines, note) {
  const to = Math.min(lines.length, 40);
  const out = { snippet: clip(lines, 0, to), from: 1, to: Math.max(1, to) };
  if (note) out.note = note;
  return out;
}

// ---- the frontend lane's own three rules ------------------------------------

// What a file is written in, for COLOURING only. A .vue file is three languages
// in one, and the part a function lives in is the script block — which says
// which of them it is in its own tag, so that is read rather than assumed.
const WEB_EXT_LANG = Object.freeze({ js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'tsx', vue: 'vue' });
export function webLang(file, text) {
  const ext = String(file ?? '').split('.').pop().toLowerCase();
  const lang = WEB_EXT_LANG[ext] ?? 'js';
  if (lang !== 'vue') return lang;
  const open = /<script\b([^>]*)>/i.exec(String(text ?? ''));
  const attr = open ? /lang\s*=\s*["']?([\w-]+)/i.exec(open[1]) : null;
  const declared = attr ? attr[1].toLowerCase() : 'js';
  return declared === 'ts' ? 'ts' : declared === 'tsx' ? 'tsx' : 'js';
}

/** The 1-based line the `<script>` block opens on, or null when there is none. */
export function scriptLine(text, file) {
  if (String(file ?? '').split('.').pop().toLowerCase() !== 'vue') return null;
  const at = String(text).search(/<script\b/i);
  return at < 0 ? null : lineAt(text, at);
}
/** The 1-based line `</script>` closes on, so a scan cannot run into the styles. */
function scriptEnd(text, file) {
  if (String(file ?? '').split('.').pop().toLowerCase() !== 'vue') return null;
  const at = String(text).search(/<\/script\s*>/i);
  return at < 0 ? null : lineAt(text, at);
}

// How much of a file a web function gets when its braces do not close: enough
// to read, bounded so a file the balance walked off the end of cannot become
// the whole answer. The scan itself stops here too.
export const WEB_FALLBACK_LINES = 60;

/**
 * One frontend function, from the line the lane recorded to the line its braces
 * close on. Real FILE lines throughout, including inside a single-file
 * component: the `<script>` block is not re-numbered, so `path:line` from this
 * answer is what an editor opens.
 *
 * @param {string} text        the whole file
 * @param {number} line        1-based line the function is declared on
 * @param {number|null} [stop] 1-based line the scan must not pass (a .vue file's
 *                             `</script>`); null for a plain module
 */
export function extractWebFunction(text, line, stop) {
  const lines = String(text).split('\n');
  const last = Math.min(lines.length, stop != null && stop >= 1 ? stop : lines.length);
  const start = (Number.isInteger(line) && line >= 1 && line <= lines.length) ? line - 1 : 0;
  let depth = 0;
  let seen = false;
  let end = -1;
  const scanTo = Math.min(last, start + WEB_FALLBACK_LINES);
  for (let i = start; i < scanTo; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; seen = true; } else if (ch === '}') depth -= 1;
    }
    if (seen && depth <= 0) { end = i; break; }
  }
  if (end >= 0) return { snippet: clip(lines, start, end + 1), from: start + 1, to: end + 1 };
  const to = Math.max(start + 1, scanTo);
  return {
    snippet: clip(lines, start, to),
    from: start + 1,
    to,
    note: seen
      ? `the braces that open at line ${start + 1} do not close within ${WEB_FALLBACK_LINES} lines, so this is a ${WEB_FALLBACK_LINES}-line window rather than the function's own extent`
      : `no brace opens at line ${start + 1}, so this is a ${WEB_FALLBACK_LINES}-line window rather than the function's own extent`,
  };
}

/** A whole file as the cut, with the line a reader should land on marked. */
function wholeFileCut(text, file) {
  const lines = String(text).split('\n');
  const mark = scriptLine(text, file);
  const out = { snippet: lines.join('\n'), from: 1, to: lines.length };
  if (mark != null) out.mark = mark;
  return out;
}

export function extractCreateTable(text, table) {
  const re = new RegExp('create\\s+table\\s+`?' + escapeRe(table) + '`?', 'i');
  const m = re.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf('\n', m.index) + 1;
  // end at the first ';' after the create
  const semi = text.indexOf(';', m.index);
  const end = semi < 0 ? Math.min(text.length, m.index + 4000) : semi + 1;
  const snippet = text.slice(start, end);
  const from = lineAt(text, start);
  return { snippet, from, to: from + lineCount(snippet) - 1 };
}

function clip(lines, a, b) { return lines.slice(a, b).join('\n'); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
