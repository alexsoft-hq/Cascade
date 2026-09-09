#!/usr/bin/env node
// webfacts.mjs - the web lane's fact worker.
//
// Same position in the engine as adapters/java/JavaFacts.java: the CLI spawns
// it, it reads source, it prints JSONL on stdout, and it RESOLVES NOTHING
// ACROSS FILES. Every record describes the file it was read from. Turning a
// frontend call into an edge onto a backend endpoint needs the whole set of
// files plus the backend's routes, so that job belongs to the bridge, not here.
//
//   node adapters/web/webfacts.mjs --root <abs root> <abs source root>...
//
// WHAT IT DOES NOT CONTAIN, on purpose (SPEC §3.4, §6, §18.2): no project name,
// and no HTTP wrapper name. Real frontends call their wrapper anything at all,
// so a rule written against one project's spelling is a rule that works on one
// project. What this worker records instead is SHAPE: which identifier a call
// goes through, what that identifier is bound to in this file, and what the
// argument looks like. The bridge reads the shapes and decides.
//
// Framework conventions that DO have a fixed vocabulary live in declaration
// packs (adapters/web/packs/*.json), which is where the router key names sit.
//
// webfacts/2 adds the shapes a CLASS is written in, because a frontend's HTTP
// client is as often a class as a function: what the class declares (`class`),
// what its constructor puts on `this` (`assign`), which class a `this.x()` call
// belongs to (`binding:{kind:'this'}`), and what a function hands back
// (`returns`). Together those let the bridge walk `thing.get(...)` down to the
// library call that really sends the request, without this worker knowing one
// wrapper's name.
//
// webfacts/3 adds `fnRefs` to a call record: the functions a call HANDS OVER as
// values. A view that writes `usePagedList({ api: list })` never calls `list`,
// so nothing that follows calls alone can see that the screen depends on it.
// The worker records which identifier was passed and what this file binds it
// to; whether the receiver ever calls it is the bridge's problem, and the bridge
// says so in the grade.
//
// webfacts/4 adds the shapes a frontend written BEFORE modules is in, because a
// gateway that ships AngularJS as `<script>` tags has neither imports nor a
// package (RM47):
//   - a CHAIN registrar, `$stateProvider.state(name, route).state(…)`, where
//     each link is one route and the route's own object says its parent;
//   - `registration` records for the framework's own name registry
//     (`angular.module(…).component('ownerList', {controller: 'OwnerListController'})`),
//     which is how such a frontend resolves one thing to another when nothing
//     imports anything;
//   - the custom element tags of an HTML template a registration points at,
//     read for tags and nothing else;
//   - an INJECTED client: `$http` is a parameter the framework fills in, so
//     nothing in the file binds it, and the pack says which parameter names are
//     clients and in which registrar a function has to sit for that to be true.
// It also stops a ROUTE DECLARATION being read as an HTTP call: the `url` of an
// object a router pack recognizes as a route is a route, not a request, and a
// call a pack lists as a declaration never sends one.
//
// webfacts/5 reads the SERVER-RENDERED PAGE (RM48). A large share of the systems
// this tool is for have no router at all: a `@Controller` returns a view name, a
// template engine renders it, and the page's own `<script>` calls the backend,
// its `<form>` posts to a route and its links open other routes. So a template
// root named on the command line (`--template-root`) is walked like a source
// root, and each template file produces:
//   - a `template` record: which engine, which view name it answers to, what it
//     includes, and which of its JavaScript variables hold the CONTEXT PATH;
//   - `call` records for its inline `<script>` blocks, read by the SAME reader
//     the `.js` files go through after the template's own directives have been
//     neutralised into placeholders, plus one per `<form>` and per link.
// jQuery joins the pack as a platform global for the same round: a page that
// loads it with a `<script>` tag has nothing to import and nothing to bind, so
// `$` is a client the way `fetch` is one.
//
// DETERMINISM: the same tree prints the same bytes. Files come out in sorted
// root-relative path order, records inside a file in (line, kind, ordinal)
// order, and nothing here reads a clock, a locale or an environment variable.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'cascade:webfacts:1';
const VERSION = 'webfacts/5';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The parser is VENDORED (adapters/web/vendor/README.md): this engine has no
// npm install step and no network at analysis time, and a parser version that
// moved under the engine would change what every fact shard means.
const babel = require('./vendor/babel-parser.cjs');

// ---------------------------------------------------------------------------
// What the walk reads
// ---------------------------------------------------------------------------

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue'];

/**
 * Directories that are never first-party source, WHEREVER they sit. A vendored
 * dependency tree, a git directory and this engine's own state are not code
 * anybody wrote here, and a `__tests__` / `__mocks__` directory is a different
 * program at any depth.
 */
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', '.cascade', '__tests__', '__mocks__']);

/**
 * Names that mean OUTPUT, but only where output goes.
 *
 * A build directory is a build directory at the top of a package or at the top
 * of a source root. Deeper down these are ordinary words: `src/views/tool/build`
 * is a form BUILDER, six real screens, and skipping it because of the folder's
 * name lost all six without a word. So the name alone is not the rule; the name
 * AND the position are.
 */
const OUTPUT_DIRS = new Set(['dist', 'build', 'coverage', 'public']);
// 2 MB. A file this big is a bundle, a generated client or a data blob; parsing
// it costs more than it can ever tell us, so it is RECORDED as skipped rather
// than dropped silently.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The HTTP verbs a call can name in its own callee. */
const VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** Identifiers that are the browser's, not the project's, when nothing declares them. */
const PLATFORM_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'window', 'document', 'globalThis', 'self', 'this']);

/** The object keys a call's config argument is summarized by. */
const CONFIG_KEYS = ['url', 'method', 'baseURL', 'type', 'data', 'params'];

/** How far a walk down a member/call spine goes before it gives up. */
const HOP_GUARD = 64;

function langOf(file) {
  if (file.endsWith('.vue')) return 'vue';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.ts')) return 'ts';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/**
 * The parser plugins one language needs.
 *
 * `jsx` is NOT put on a `.ts` file, deliberately: with JSX enabled, TypeScript's
 * `<T>(x) => x` generic arrow reads as an unclosed JSX tag and the file fails to
 * parse. TypeScript itself makes the same split, which is why `.tsx` exists.
 */
function pluginsFor(lang) {
  if (lang === 'ts') return ['typescript', 'decorators-legacy'];
  if (lang === 'tsx') return ['typescript', 'jsx', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

function parseCode(code, lang) {
  return babel.parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    attachComment: false,
    ranges: false,
    tokens: false,
    plugins: pluginsFor(lang),
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isNode = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string';
const SKIP_KEYS = new Set(['loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'comments', 'tokens']);

function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const item of v) if (isNode(item)) fn(item, key);
    } else if (isNode(v)) fn(v, key);
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

/** A property key as written: `a`, `'a'`, `"a"`, `1`. Computed keys give null. */
function keyName(prop) {
  if (!prop || !prop.key) return null;
  if (prop.computed && prop.key.type !== 'StringLiteral' && prop.key.type !== 'NumericLiteral') return null;
  const k = prop.key;
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  if (k.type === 'PrivateName' && k.id) return `#${k.id.name}`;
  return null;
}

/** The value of an object literal's property, by key name. Null when absent. */
function propOf(objectNode, name) {
  if (!objectNode || objectNode.type !== 'ObjectExpression') return null;
  for (const p of objectNode.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
    if (keyName(p) === name) return p.type === 'ObjectMethod' ? p : p.value;
  }
  return null;
}

const isFunctionNode = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod'
  || n.type === 'ClassPrivateMethod');

// ---------------------------------------------------------------------------
// Argument summaries
// ---------------------------------------------------------------------------

/**
 * The one-line description of an argument. It is deliberately lossy: the stream
 * has to stay small enough to ship a 1600-file frontend, and the bridge only
 * ever needs the URL, the method and what the call went through.
 *
 * A `+` concatenation and a template literal collapse to the same shape, with
 * every expression written as `{*}`, because `'/user/' + id` and `` `/user/${id}` ``
 * are the same route with the same hole in it.
 */
function summarizeArg(node) {
  if (!node) return { kind: 'other' };
  switch (node.type) {
    case 'StringLiteral':
      return { kind: 'string', value: node.value };
    case 'TemplateLiteral':
    case 'BinaryExpression': {
      const t = flattenText(node);
      if (t === null) break;
      if (t.dynamicParts === 0) return { kind: 'string', value: t.template };
      return {
        kind: 'template', template: t.template, dynamicParts: t.dynamicParts,
        ...(t.base === null ? {} : { base: t.base }),
      };
    }
    case 'ConditionalExpression':
      return {
        kind: 'ternary',
        candidates: [summarizeArg(node.consequent), summarizeArg(node.alternate)],
      };
    case 'Identifier':
      return { kind: 'ident', name: node.name };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const c = calleeOf(node);
      if (!c || c.root === null) break;
      return { kind: 'member', root: c.root, path: c.path };
    }
    case 'ObjectExpression': {
      const keys = {};
      for (const key of CONFIG_KEYS) {
        const v = propOf(node, key);
        if (v === null) continue;
        // `data` and `params` are the request BODY. What is in them is the
        // application's business, never a route, so they are recorded as
        // present and not summarized any further.
        keys[key] = (key === 'data' || key === 'params') ? 'present' : summarizeArg(v);
      }
      return { kind: 'object', keys };
    }
    default:
      break;
  }
  return { kind: 'other' };
}

/**
 * A template literal or a `+` chain flattened into `'/a/{*}/b'`. Null when the
 * node is not made of text at all.
 *
 * `base` is the NAME of the hole the text starts with, when it is a plain name
 * (`base_url + '/things/list'`, `` `${api}/things` ``). The template alone says
 * a hole is there and not what it was; a page whose scripts are written against
 * a variable the server filled in with the application's context path cannot be
 * read without it (RM48), and nothing else in the record carries the name.
 *
 * @returns {{template:string, dynamicParts:number, base:(string|null)}|null}
 */
function flattenText(node) {
  const parts = [];
  let dynamic = 0;
  let base = null;
  const nameOfHole = (n) => {
    if (!n) return null;
    if (n.type === 'Identifier') return n.name;
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const c = calleeOf(n);
      return c && c.root !== null ? [c.root, ...c.path].join('.') : null;
    }
    return null;
  };
  const walkText = (n) => {
    if (!n) return false;
    if (n.type === 'StringLiteral') { parts.push(n.value); return true; }
    if (n.type === 'TemplateLiteral') {
      for (let i = 0; i < n.quasis.length; i += 1) {
        parts.push(n.quasis[i].value.cooked ?? n.quasis[i].value.raw ?? '');
        if (i < n.expressions.length) {
          if (parts.join('') === '') base = nameOfHole(n.expressions[i]);
          parts.push('{*}');
          dynamic += 1;
        }
      }
      return true;
    }
    if (n.type === 'BinaryExpression' && n.operator === '+') {
      return walkText(n.left) && walkText(n.right);
    }
    // Anything else inside a concatenation is a hole.
    if (parts.join('') === '') base = nameOfHole(n);
    parts.push('{*}');
    dynamic += 1;
    return true;
  };
  if (node.type === 'BinaryExpression' && node.operator !== '+') return null;
  if (!walkText(node)) return null;
  return { template: parts.join(''), dynamicParts: dynamic, base };
}

// ---------------------------------------------------------------------------
// Callee descriptors
// ---------------------------------------------------------------------------

/**
 * The shape of a callee (or of any member chain): its root identifier, the
 * chain of names after it, and the last segment.
 *
 * `import.meta.env.X` is spelled with the root `import.meta`, because that IS
 * the identifier as far as anything reading this stream is concerned.
 */
function calleeOf(node) {
  const segments = [];
  let cur = node;
  for (;;) {
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
      let seg = null;
      if (!cur.computed && cur.property && cur.property.type === 'Identifier') seg = cur.property.name;
      else if (cur.property && cur.property.type === 'StringLiteral') seg = cur.property.value;
      else seg = '*';
      segments.unshift(seg);
      cur = cur.object;
      continue;
    }
    break;
  }
  let root = null;
  if (cur.type === 'Identifier') root = cur.name;
  else if (cur.type === 'ThisExpression') root = 'this';
  else if (cur.type === 'MetaProperty') root = `${cur.meta.name}.${cur.property.name}`;
  else if (cur.type === 'Import') root = 'import';
  else return null;
  return {
    shape: segments.length > 0 ? 'member' : 'ident',
    root,
    path: segments,
    name: segments.length > 0 ? segments[segments.length - 1] : root,
  };
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

class Scope {
  constructor(parent, isModule) {
    this.parent = parent;
    this.isModule = isModule === true;
    this.names = new Map(); // name -> init node or null
  }

  declare(name, init) {
    if (typeof name === 'string') this.names.set(name, init ?? null);
  }

  /** The scope that declares `name`, or null. */
  find(name) {
    let s = this;
    while (s) {
      if (s.names.has(name)) return s;
      s = s.parent;
    }
    return null;
  }
}

/** Every binding name a destructuring pattern introduces. */
function patternNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') patternNames(p.argument, out);
        else patternNames(p.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) if (el) patternNames(el, out);
      break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declaration packs (SPEC §18.2)
// ---------------------------------------------------------------------------

function loadPacks(dir) {
  const packs = [];
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch { return packs; }
  for (const f of entries) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    packs.push(JSON.parse(text));
  }
  // Every key each pack names, so a route object can say which pack it belongs
  // to without either pack being hard-coded here.
  for (const p of packs) {
    const ro = p.routeObject || {};
    const keys = new Set([
      ro.pathKey, ro.childrenKey, ro.nameKey, ro.metaKey, ro.redirectKey, ro.hiddenKey, ro.indexKey,
      ...(ro.componentKeys || []),
    ].filter(Boolean));
    p.__keys = keys;
  }
  for (const p of packs) {
    const others = new Set();
    for (const q of packs) if (q !== p) for (const k of q.__keys) others.add(k);
    p.__distinctive = new Set([...p.__keys].filter((k) => !others.has(k)));
    // A pack whose routes come from a CHAIN is never matched by an object
    // literal on its own. `{url: '/x', template: '<y>'}` is a route where a
    // `$stateProvider` chain names it and an ordinary options object anywhere
    // else, and this is the difference.
    p.__routesFrom = p.routesFrom === 'chain' ? 'chain' : 'object';
    p.__chains = [p.chain, p.chainAlt].filter((c) => c && Array.isArray(c.receivers) && typeof c.method === 'string');
  }
  return packs;
}

// ---------------------------------------------------------------------------
// HTML templates: custom element tags, and nothing else
// ---------------------------------------------------------------------------

/** 512 KB. Past that a `.html` is a generated page, not a component's template. */
const MAX_TEMPLATE_BYTES = 512 * 1024;

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
const CTX_MARKER = '__cascade_ctx__';

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
function templateRecordsOf(a) {
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

  for (const { rec } of records) {
    if (rec.kind !== 'call' || !rec.url || !Array.isArray(rec.url.resolved)) continue;
    let stripped = false;
    rec.url.resolved = rec.url.resolved.map((r) => {
      if (typeof r.template !== 'string') return r;
      if (r.template.startsWith(CTX_MARKER)) {
        stripped = true;
        return { ...r, template: r.template.slice(CTX_MARKER.length) };
      }
      if (typeof rec.url.base === 'string' && isContextVar.has(rec.url.base) && r.template.startsWith('{*}')) {
        stripped = true;
        return { ...r, template: r.template.slice(3), dynamicParts: Math.max(0, (r.dynamicParts ?? 1) - 1) };
      }
      return r;
    });
    if (stripped) rec.url.contextPath = true;
  }

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

// ---------------------------------------------------------------------------
// The per-file analysis
// ---------------------------------------------------------------------------

/**
 * One file's records. `blocks` is a list of {code, lang, setup, lineOffset} so
 * a Vue single-file component's several script blocks share one file and one
 * set of top-level declarations, with every line number reported as the line in
 * the `.vue` file.
 */
function analyzeFile(ctx) {
  const { relFile, blocks, packs } = ctx;
  const records = [];
  let ordinal = 0;
  const emit = (rec, line) => {
    records.push({ order: ordinal++, line, rec });
    return rec;
  };

  // What this file declares at its top level. Shared across a Vue file's
  // script blocks, because `<script setup>` and `<script>` are one module to
  // everybody who reads them.
  const top = {
    imports: new Map(),   // local name -> {source, imported}
    constants: new Map(), // name -> {members:Map|null, value:string|null}
    bindings: new Map(),  // name -> record
    functions: new Map(), // name -> record
    xhr: new Set(),       // names bound to `new XMLHttpRequest()`
  };
  const usedFunctionNames = new Map();
  const funcEntries = [];

  let recoveredErrors = 0;
  const parseErrors = [];

  for (const block of blocks) {
    let ast;
    try {
      ast = parseCode(block.code, block.lang);
    } catch (e) {
      const line = (e && e.loc ? e.loc.line : 1) + block.lineOffset;
      const col = e && e.loc ? e.loc.column : 0;
      parseErrors.push({ line, col, message: String(e && e.message ? e.message : e).split('\n')[0] });
      continue;
    }
    recoveredErrors += (ast.errors || []).length;
    try {
      analyzeProgram(ast.program, {
        ...ctx, block, top, emit, funcEntries, usedFunctionNames, packs,
      });
    } catch (e) {
      // One file this worker cannot read must not silence the other 1600. The
      // failure is RECORDED with its message, in the same place a parse failure
      // goes, so it shows up in the lane line instead of disappearing.
      parseErrors.push({
        line: 1 + block.lineOffset, col: 0,
        message: `the web lane failed on this file: ${String(e && e.message ? e.message : e).split('\n')[0]}`,
      });
    }
  }

  // The name rule has to be POSITION-INDEPENDENT (the bridge's symbol key is
  // `<file>#<name>`), so a second function of the same name is `name~2` in LINE
  // order, never in walk order.
  funcEntries.sort((a, b) => a.line - b.line || a.column - b.column);
  for (const f of funcEntries) {
    const n = (usedFunctionNames.get(f.baseName) ?? 0) + 1;
    usedFunctionNames.set(f.baseName, n);
    f.finalName = n === 1 ? f.baseName : `${f.baseName}~${n}`;
    if (f.record) f.record.name = f.finalName;
  }
  // Every call was recorded against the function ENTRY, so the name it prints
  // is the final one whatever order the walk found things in.
  for (const r of records) {
    if (r.rec.kind === 'call' && r.rec.__enclosingEntry) {
      r.rec.enclosing = r.rec.__enclosingEntry.finalName ?? r.rec.__enclosingEntry.baseName;
      delete r.rec.__enclosingEntry;
    }
  }

  return { records, recoveredErrors, parseErrors, relFile };
}

/** One parsed program (a whole file, or one script block of a Vue file). */
function analyzeProgram(program, st) {
  const { block, top, emit, relFile, packs } = st;
  const off = block.lineOffset;
  const lineOf = (n) => (n && n.loc ? n.loc.start.line + off : 1 + off);
  const endLineOf = (n) => (n && n.loc ? n.loc.end.line + off : lineOf(n));
  const columnOf = (n) => (n && n.loc ? n.loc.start.column : 0);

  const moduleScope = new Scope(null, true);
  // Code outside any named function is the module's own body; inside a
  // `<script setup>` block it is the component's setup, which is a different
  // place a call can come from and worth telling apart.
  const moduleEnclosing = block.setup === true ? '(setup)' : '(module)';

  /**
   * The HTML template a record points at, read for its custom element tags.
   *
   * `templateUrl: 'scripts/owner-list/owner-list.template.html'` is a path the
   * SERVER resolves, not one this file's directory does, so finding it is the
   * caller's job (`main` walks up from each source root). What is recorded is
   * the file that was found and the tags in it; when nothing was found, the url
   * is recorded as written, so a reader can see what was looked for.
   */
  const attachTemplate = (rec, templateUrl) => {
    rec.templateUrl = templateUrl;
    const found = typeof st.templateOf === 'function' ? st.templateOf(templateUrl) : null;
    if (found === null) return;
    rec.templateFile = found.file;
    if (found.tags.length > 0) rec.templateTags = found.tags;
  };

  // ---- pass 1: hoist what the top level declares -------------------------
  // A function at the top of a file calls one declared at the bottom, so the
  // declarations are collected before anything is resolved.
  const hoist = (body) => {
    for (const node of body) {
      const d = (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration')
        ? node.declaration : node;
      if (!d) continue;
      if (d.type === 'VariableDeclaration') {
        for (const decl of d.declarations) for (const n of patternNames(decl.id)) moduleScope.declare(n, decl.init);
      } else if (d.type === 'FunctionDeclaration' && d.id) moduleScope.declare(d.id.name, null);
      else if (d.type === 'ClassDeclaration' && d.id) moduleScope.declare(d.id.name, null);
      else if (d.type === 'TSEnumDeclaration' && d.id) moduleScope.declare(d.id.name, null);
      else if (d.type === 'TSModuleDeclaration' && d.id && d.id.type === 'Identifier') moduleScope.declare(d.id.name, null);
      if (node.type === 'ImportDeclaration') {
        for (const s of node.specifiers) moduleScope.declare(s.local.name, null);
      }
    }
  };
  hoist(program.body);

  // ---- what a root identifier IS in this file ----------------------------
  //
  // `classInfo` is the class whose body we are inside, when we are inside one.
  // A `this` root there is not a global: it is THAT class, and saying so is the
  // whole difference between `this.inner.get(url)` being followable and being a
  // call on an unknown object.
  const bindingOf = (root, scope, classInfo) => {
    if (root === null) return null;
    if (root === 'this') {
      return classInfo ? { kind: 'this', class: classInfo.name } : { kind: 'global', name: 'this' };
    }
    if (root === 'import.meta') return { kind: 'global', name: root };
    const found = scope.find(root);
    if (found && !found.isModule) return null; // a parameter, or a variable of the enclosing function
    if (top.imports.has(root)) {
      const imp = top.imports.get(root);
      return { kind: 'import', source: imp.source, imported: imp.imported };
    }
    if (top.bindings.has(root) || top.constants.has(root) || top.functions.has(root)) {
      return { kind: 'local', name: root };
    }
    if (found && found.isModule) return { kind: 'local', name: root };
    return { kind: 'global', name: root };
  };

  // ---- URL resolution, file-locally --------------------------------------
  //
  // `via` names the OUTERMOST form the URL argument was written in, so every
  // candidate of one argument carries the same one and a reader can tell a
  // literal from a name that had to be followed:
  //   literal        '/things/list' written where it is used
  //   template       a template literal or a `+` concatenation
  //   local-constant an enum/object member or a top-level constant of this file
  //   local-variable a `const` of the enclosing function, followed once
  //   ternary        a conditional written in the argument itself
  const resolveSummary = (summary, scope, via, depth) => {
    if (!summary) return null;
    if (summary.kind === 'string') return [{ template: summary.value, dynamicParts: 0, via }];
    if (summary.kind === 'template') return [{ template: summary.template, dynamicParts: summary.dynamicParts, via }];
    if (summary.kind === 'ternary') {
      const out = [];
      for (const c of summary.candidates) {
        const r = resolveSummary(c, scope, via, depth);
        if (r === null) return null;
        out.push(...r);
      }
      return out.length > 0 ? out : null;
    }
    if (summary.kind === 'member') {
      const c = top.constants.get(summary.root);
      if (c && c.members && summary.path.length >= 1 && c.members.has(summary.path[0])) {
        return [{ template: c.members.get(summary.path[0]), dynamicParts: 0, via }];
      }
      return null;
    }
    if (summary.kind === 'ident') {
      const c = top.constants.get(summary.name);
      if (c && c.value !== null && c.value !== undefined) {
        return [{ template: c.value, dynamicParts: 0, via }];
      }
      if (depth <= 0) return null;
      const found = scope.find(summary.name);
      if (found && !found.isModule && found.names.get(summary.name)) {
        // A local `const` is followed ONCE. Twice would be a data-flow
        // analysis, and this worker is deliberately not one.
        return resolveSummary(summarizeArg(found.names.get(summary.name)), scope, via, depth - 1);
      }
      return null;
    }
    return null;
  };

  const whyUnresolved = (summary, scope) => {
    if (!summary) return 'expression';
    if (summary.kind === 'ident') {
      const found = scope.find(summary.name);
      if (found && !found.isModule) return 'parameter';
      if (top.imports.has(summary.name)) return 'imported-constant';
      return 'expression';
    }
    if (summary.kind === 'member') {
      if (top.imports.has(summary.root)) return 'imported-constant';
      const found = scope.find(summary.root);
      if (found && !found.isModule) return 'parameter';
      return 'expression';
    }
    if (summary.kind === 'ternary') {
      for (const c of summary.candidates) {
        const why = whyUnresolved(c, scope);
        if (why !== 'expression') return why;
      }
      return 'expression';
    }
    return 'expression';
  };

  const viaOf = (summary) => {
    if (!summary) return 'literal';
    if (summary.kind === 'string') return 'literal';
    if (summary.kind === 'template') return 'template';
    if (summary.kind === 'ternary') return 'ternary';
    if (summary.kind === 'member') return 'local-constant';
    if (summary.kind === 'ident') return top.constants.has(summary.name) ? 'local-constant' : 'local-variable';
    return 'literal';
  };

  const buildUrl = (summary, scope) => {
    if (!summary) return null;
    const url = { arg: summary };
    // The name the URL is built ON TOP OF, when the text starts with one. Only
    // the bridge can say what that name holds, because the file that assigns it
    // is as often another file (RM48).
    if (summary.kind === 'template' && typeof summary.base === 'string') url.base = summary.base;
    let resolved = resolveSummary(summary, scope, viaOf(summary), 1);
    if (resolved === null) {
      url.resolved = null;
      url.unresolved = whyUnresolved(summary, scope);
      if (summary.kind === 'member' && top.imports.has(summary.root)) {
        const imp = top.imports.get(summary.root);
        url.binding = { kind: 'import', source: imp.source, imported: imp.imported };
      } else if (summary.kind === 'ident' && top.imports.has(summary.name)) {
        const imp = top.imports.get(summary.name);
        url.binding = { kind: 'import', source: imp.source, imported: imp.imported };
      }
      return url;
    }
    let query = null;
    let absolute = null;
    resolved = resolved.map((r) => {
      let t = r.template;
      const abs = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(t);
      if (abs) {
        absolute = { host: abs[2], path: abs[3] ?? '/' };
        t = abs[3] ?? '/';
      }
      const q = t.indexOf('?');
      if (q >= 0) { if (query === null) query = t.slice(q + 1); t = t.slice(0, q); }
      return { ...r, template: t };
    });
    url.resolved = resolved;
    if (query !== null) url.query = query;
    if (absolute !== null) url.absolute = absolute;
    return url;
  };

  // ---- top-level declaration records -------------------------------------
  const recordImport = (node) => {
    const source = node.source.value;
    const specifiers = [];
    for (const s of node.specifiers) {
      let imported = 'default';
      if (s.type === 'ImportNamespaceSpecifier') imported = '*';
      else if (s.type === 'ImportSpecifier') {
        imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
      }
      specifiers.push({ imported, local: s.local.name });
      top.imports.set(s.local.name, { source, imported });
    }
    emit({ kind: 'import', file: relFile, line: lineOf(node), source, specifiers, dynamic: false }, lineOf(node));
  };

  const stringMembers = (node) => {
    const members = new Map();
    let omitted = 0;
    if (!node) return null;
    if (node.type === 'TSEnumDeclaration') {
      for (const m of node.members) {
        const name = m.id.type === 'Identifier' ? m.id.name : m.id.value;
        if (m.initializer && m.initializer.type === 'StringLiteral') members.set(name, m.initializer.value);
        else omitted += 1;
      }
      return { members, omitted };
    }
    if (node.type === 'ObjectExpression') {
      for (const p of node.properties) {
        if (p.type !== 'ObjectProperty') { omitted += 1; continue; }
        const name = keyName(p);
        if (name === null) { omitted += 1; continue; }
        if (p.value.type === 'StringLiteral') members.set(name, p.value.value);
        else omitted += 1;
      }
      return { members, omitted };
    }
    return null;
  };

  const recordConstant = (name, node, exported, line) => {
    const m = stringMembers(node);
    if (m && m.members.size > 0) {
      const members = {};
      for (const [k, v] of m.members) members[k] = v;
      top.constants.set(name, { members: m.members, value: null });
      emit({ kind: 'constant', file: relFile, line, name, exported, members, omitted: m.omitted }, line);
      return true;
    }
    if (node && node.type === 'StringLiteral') {
      top.constants.set(name, { members: null, value: node.value });
      emit({ kind: 'constant', file: relFile, line, name, exported, value: node.value }, line);
      return true;
    }
    return false;
  };

  /**
   * WHAT AN INITIALIZER IS, in the four shapes that can hold a client:
   * `f(...)`, `new C(...)`, another name, or a member of one. Null for anything
   * else. Shared by the three places a client can be put somewhere: a top-level
   * `const`, `this.field = …` inside a class, and what a function RETURNS.
   * @returns {{shape:string, callee:object, binding:object|null, baseURL?:object}|null}
   */
  const initOf = (init, env) => {
    if (!init) return null;
    let shape = null;
    let target = null;
    if (init.type === 'CallExpression' || init.type === 'OptionalCallExpression') { shape = 'call'; target = init.callee; }
    else if (init.type === 'NewExpression') { shape = 'new'; target = init.callee; }
    else if (init.type === 'Identifier') { shape = 'ident'; target = init; }
    else if (init.type === 'MemberExpression' || init.type === 'OptionalMemberExpression') { shape = 'member'; target = init; }
    if (shape === null) return null;
    const callee = target ? calleeOf(target) : null;
    if (callee === null) return null;
    const out = { shape, callee, binding: bindingOf(callee.root, env.scope, env.classInfo) };
    // A base URL declared where the client is built is the one thing in this
    // file that decides what every call through it resolves to, so it rides on
    // the record rather than being left for the bridge to go and find.
    if ((shape === 'call' || shape === 'new') && init.arguments && init.arguments.length > 0) {
      const first = init.arguments[0];
      if (first && first.type === 'ObjectExpression') {
        const b = propOf(first, 'baseURL');
        if (b) out.baseURL = summarizeArg(b);
      }
    }
    return out;
  };

  const recordBinding = (name, init, exported, line) => {
    const shaped = initOf(init, { scope: moduleScope, classInfo: null });
    if (shaped === null) return false;
    const rec = { kind: 'binding', file: relFile, line, name, exported, init: shaped };
    if (shaped.shape === 'new' && shaped.callee.name === 'XMLHttpRequest') top.xhr.add(name);
    top.bindings.set(name, rec);
    emit(rec, line);
    return true;
  };

  // ---- functions ----------------------------------------------------------

  /**
   * WHAT A FUNCTION HANDS BACK, in the one form that can be followed: the LAST
   * `return` at the top level of its body, when it returns a call or a `new`.
   *
   * Only the last one, and only at the top level, on purpose. A `return` inside
   * an `if` is one of several answers and picking it would state a fact the
   * code does not; a function that ends `return new Client(opts)` states
   * exactly one. Everything else is `null`, which the bridge reads as "not
   * followable" rather than as "returns nothing".
   *
   * A concise arrow body (`() => make()`) IS its return statement, so it counts.
   */
  const returnsOf = (node, env) => {
    if (!node || !node.body) return null;
    let arg = null;
    if (node.body.type === 'BlockStatement') {
      for (let i = node.body.body.length - 1; i >= 0; i -= 1) {
        if (node.body.body[i].type === 'ReturnStatement') { arg = node.body.body[i].argument; break; }
      }
    } else {
      arg = node.body;
    }
    if (!arg) return null;
    if (arg.type !== 'CallExpression' && arg.type !== 'OptionalCallExpression' && arg.type !== 'NewExpression') return null;
    // The parameters are in scope inside the body, so a `return handler(x)`
    // whose `handler` is a PARAMETER is correctly reported as unfollowable
    // rather than as a call on a module-level name of the same spelling.
    const inner = new Scope(env.scope, false);
    for (const p of node.params || []) for (const n of patternNames(p)) inner.declare(n, null);
    return initOf(arg, { scope: inner, classInfo: env.classInfo ?? null });
  };

  const declareFunction = (node, baseName, exported, scope, env) => {
    const line = lineOf(node);
    const entry = {
      node, baseName, line, column: columnOf(node), finalName: null, record: null, parent: null,
    };
    const rec = {
      kind: 'function', file: relFile, line, name: baseName,
      endLine: endLineOf(node), exported: exported ?? null,
      async: node.async === true, params: (node.params || []).length,
      returns: returnsOf(node, env ?? { scope, classInfo: null }),
    };
    entry.record = rec;
    st.funcEntries.push(entry);
    emit(rec, line);
    if (baseName && scope.isModule) top.functions.set(baseName, rec);
    return entry;
  };

  // ---- the walk -----------------------------------------------------------
  const routeHandled = new Set();
  // The object literals a router pack recognizes as ROUTE DECLARATIONS, and the
  // calls a pack lists as declaring rather than sending. Both are filled in
  // before the walk, and both exist for one reason: `{url: '/owners'}` inside
  // `$stateProvider.state(…)` is a route, and reading it as an HTTP call put
  // eight endpoints in a pack that nothing serves.
  const routeObjects = new Set();
  const declarationCalls = new Set();
  // Function nodes the framework INJECTS into: a parameter named `$http` there
  // is the client, and a parameter of the same name anywhere else is not.
  const injectionTargets = new Set();
  const injectedClients = new Map(
    (packs.flatMap((p) => p.injected ?? [])).map((c) => [c.name, c]),
  );

  // THE CLIENT A PAGE LOADS WITH A SCRIPT TAG (RM48). It is on `window`, so no
  // file imports it and nothing binds it: every rule that follows a name to what
  // it is bound to sees a call on an unknown global. What makes it a client is
  // the pack's own list of global names plus the method called, and the same two
  // things say which argument is the URL and what verb the call sends.
  const globalClients = new Map();
  for (const p of packs) {
    for (const g of p.platform ?? []) {
      for (const name of g.globals ?? []) globalClients.set(name, g);
    }
  }

  /** Whether one pack would read this object literal as a route declaration. */
  const packSeesARoute = (p, node) => {
    const ro = p.routeObject || {};
    if (!ro.pathKey) return false;
    const pathValue = propOf(node, ro.pathKey);
    if (pathValue === null || pathValue.type !== 'StringLiteral') return false;
    const hasComponent = (ro.componentKeys || []).some((k) => propOf(node, k) !== null);
    const hasChildren = ro.childrenKey ? propOf(node, ro.childrenKey) !== null : false;
    const hasRedirect = ro.redirectKey ? propOf(node, ro.redirectKey) !== null : false;
    const indexValue = ro.indexKey ? propOf(node, ro.indexKey) : null;
    const hasIndex = indexValue !== null && indexValue.type === 'BooleanLiteral' && indexValue.value === true;
    return hasComponent || hasChildren || hasRedirect || hasIndex;
  };
  const anyPackSeesARoute = (node) => node !== null && node !== undefined
    && node.type === 'ObjectExpression' && packs.some((p) => packSeesARoute(p, node));

  /**
   * @param {Object} node
   * @param {{scope:Scope, func:Object|null, defaultExport:boolean}} env
   */
  const visit = (node, env) => {
    if (!node) return;
    switch (node.type) {
      case 'ImportDeclaration':
        recordImport(node);
        return;
      case 'ExportNamedDeclaration':
        visitExportNamed(node, env);
        return;
      case 'ExportDefaultDeclaration':
        visitExportDefault(node, env);
        return;
      case 'ExportAllDeclaration':
        emit({
          kind: 'export', file: relFile, line: lineOf(node), name: '*', of: 'reexport',
          source: node.source.value,
        }, lineOf(node));
        return;
      case 'VariableDeclaration':
        visitVariableDeclaration(node, env, null);
        return;
      case 'FunctionDeclaration': {
        const name = node.id ? node.id.name : 'default';
        const entry = env.func === null ? declareFunction(node, name, null, env.scope, env) : null;
        visitFunctionBody(node, env, entry);
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitClass(node, env, null);
        return;
      case 'TSEnumDeclaration':
        if (env.scope.isModule && node.id) recordConstant(node.id.name, node, false, lineOf(node));
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        // Reached only as an anonymous expression (a callback, an IIFE): it
        // gets no record of its own and whatever it does is attributed to the
        // nearest enclosing NAMED function.
        visitFunctionBody(node, env, null);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
        visitCall(node, env);
        return;
      case 'AssignmentExpression':
        visitAssignment(node, env);
        return;
      case 'ObjectExpression':
        visitObject(node, env, false);
        return;
      case 'ArrayExpression':
        visitArray(node, env);
        return;
      case 'JSXElement':
        visitJsx(node, env, null);
        return;
      default:
        break;
    }
    eachChild(node, (child) => visit(child, env));
  };

  const visitExportNamed = (node, env) => {
    const line = lineOf(node);
    if (node.source) {
      for (const s of node.specifiers) {
        const name = s.exported ? (s.exported.name ?? s.exported.value) : '*';
        emit({ kind: 'export', file: relFile, line, name, of: 'reexport', source: node.source.value }, line);
      }
      if (node.specifiers.length === 0) {
        emit({ kind: 'export', file: relFile, line, name: '*', of: 'reexport', source: node.source.value }, line);
      }
      return;
    }
    const d = node.declaration;
    if (!d) {
      for (const s of node.specifiers) {
        const local = s.local ? (s.local.name ?? s.local.value) : null;
        const name = s.exported ? (s.exported.name ?? s.exported.value) : local;
        const of = top.functions.has(local) ? 'function' : top.constants.has(local) || top.bindings.has(local) ? 'const' : 'expression';
        emit({ kind: 'export', file: relFile, line, name, of, local }, line);
      }
      return;
    }
    if (d.type === 'FunctionDeclaration') {
      const name = d.id ? d.id.name : 'default';
      emit({ kind: 'export', file: relFile, line, name, of: 'function', local: name }, line);
      const entry = env.func === null ? declareFunction(d, name, 'named', env.scope, env) : null;
      visitFunctionBody(d, env, entry);
      return;
    }
    if (d.type === 'ClassDeclaration') {
      const name = d.id ? d.id.name : 'default';
      emit({ kind: 'export', file: relFile, line, name, of: 'class', local: name }, line);
      visitClass(d, env, 'named');
      return;
    }
    if (d.type === 'VariableDeclaration') {
      for (const decl of d.declarations) {
        for (const n of patternNames(decl.id)) {
          emit({ kind: 'export', file: relFile, line: lineOf(decl), name: n, of: 'const', local: n }, lineOf(decl));
        }
      }
      visitVariableDeclaration(d, env, 'named');
      return;
    }
    if (d.type === 'TSEnumDeclaration' && d.id) {
      emit({ kind: 'export', file: relFile, line, name: d.id.name, of: 'const', local: d.id.name }, line);
      if (env.scope.isModule) recordConstant(d.id.name, d, true, lineOf(d));
      return;
    }
    visit(d, env);
  };

  const visitExportDefault = (node, env) => {
    const line = lineOf(node);
    const d = node.declaration;
    if (!d) return;
    if (d.type === 'FunctionDeclaration' || d.type === 'FunctionExpression' || d.type === 'ArrowFunctionExpression') {
      const name = (d.id && d.id.name) || 'default';
      emit({ kind: 'export', file: relFile, line, name: 'default', of: 'function', local: name }, line);
      const entry = env.func === null ? declareFunction(d, name, 'default', env.scope, env) : null;
      visitFunctionBody(d, env, entry);
      return;
    }
    if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') {
      emit({ kind: 'export', file: relFile, line, name: 'default', of: 'class', local: d.id ? d.id.name : null }, line);
      visitClass(d, env, 'default');
      return;
    }
    if (d.type === 'ObjectExpression') {
      emit({ kind: 'export', file: relFile, line, name: 'default', of: 'object' }, line);
      // A Vue options component IS this object, and its methods are what the
      // screen calls. Every function-valued member of it, at any depth, is a
      // member of the default export.
      visitObject(d, { ...env, defaultExport: true }, true);
      return;
    }
    if (d.type === 'Identifier') {
      emit({ kind: 'export', file: relFile, line, name: 'default', of: 'expression', local: d.name }, line);
      return;
    }
    emit({ kind: 'export', file: relFile, line, name: 'default', of: 'expression' }, line);
    visit(d, env);
  };

  const isRequireCall = (n, env) => (
    (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')
    && n.callee && n.callee.type === 'Identifier' && n.callee.name === 'require'
    && n.arguments.length === 1 && n.arguments[0].type === 'StringLiteral'
    && !env.scope.find('require')
  );

  const visitVariableDeclaration = (node, env, exportedAs) => {
    for (const decl of node.declarations) {
      const names = patternNames(decl.id);
      for (const n of names) env.scope.declare(n, decl.init);
      const simple = decl.id.type === 'Identifier' ? decl.id.name : null;
      const line = lineOf(decl);
      // `const x = require('y')` names the local the import lands in, which a
      // bare `require('y')` further down cannot.
      if (decl.init && isRequireCall(decl.init, env)) {
        visit(decl.init, { ...env, requireLocal: simple });
        if (simple !== null) top.imports.set(simple, { source: decl.init.arguments[0].value, imported: 'default' });
        continue;
      }
      if (simple !== null && env.scope.isModule) {
        // Order matters: a constant is a constant even when its initializer is
        // also an object, and only what is left becomes a binding.
        const asConstant = recordConstant(simple, decl.init, exportedAs === 'named', line);
        if (!asConstant) recordBinding(simple, decl.init, exportedAs === 'named', line);
      }
      if (decl.init && isFunctionNode(decl.init) && simple !== null) {
        const entry = env.func === null
          ? declareFunction(decl.init, simple, exportedAs === 'named' ? 'named' : null, env.scope, env)
          : null;
        visitFunctionBody(decl.init, env, entry);
        continue;
      }
      if (decl.init && decl.init.type === 'NewExpression') {
        const c = calleeOf(decl.init.callee);
        if (c && c.name === 'XMLHttpRequest' && simple !== null) top.xhr.add(simple);
      }
      if (decl.init) visit(decl.init, env);
    }
  };

  /** A class member's name as written: `get`, `'get'`, `#secret`. */
  const memberNameOf = (m) => {
    if (m.type === 'ClassPrivateMethod' || m.type === 'ClassPrivateProperty') {
      return `#${m.key && m.key.id ? m.key.id.name : 'private'}`;
    }
    return keyName(m);
  };

  /**
   * The fields a class body ASSIGNS on `this`, wherever it does it. Most
   * JavaScript classes never declare a field at all: `this.inner = create(…)`
   * in the constructor is the declaration. Nested classes are not descended
   * into, because their `this` is a different object.
   */
  const thisAssignedFields = (classNode, out) => {
    const walk = (n) => {
      if (!n) return;
      if (n !== classNode && (n.type === 'ClassDeclaration' || n.type === 'ClassExpression')) return;
      if (n.type === 'AssignmentExpression' && n.left
        && (n.left.type === 'MemberExpression' || n.left.type === 'OptionalMemberExpression')) {
        const c = calleeOf(n.left);
        if (c && c.root === 'this' && c.path.length === 1 && c.path[0] !== '*') out.push(c.path[0]);
      }
      eachChild(n, walk);
    };
    walk(classNode);
  };

  const visitClass = (node, env, exportedAs) => {
    const className = node.id ? node.id.name : 'default';
    const line = lineOf(node);
    // WHAT THE CLASS DECLARES, collected BEFORE any body is walked: a method
    // that forwards to `this.request(…)` is written above the method it calls
    // as often as below it, and a walk that learned the member list on the way
    // through would follow one and not the other.
    const methods = [];
    const fields = [];
    for (const m of node.body.body) {
      const name = memberNameOf(m);
      if (name === null) continue;
      if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') { methods.push(name); continue; }
      if (m.type === 'ClassProperty' || m.type === 'ClassPrivateProperty') {
        if (m.value && isFunctionNode(m.value)) methods.push(name); else fields.push(name);
      }
    }
    thisAssignedFields(node, fields);
    const uniq = (xs) => [...new Set(xs)];
    const top = env.func === null;
    const classInfo = {
      name: className,
      members: new Set([...methods, ...fields]),
    };
    if (top) {
      emit({
        kind: 'class', file: relFile, line, name: className, exported: exportedAs ?? null,
        methods: uniq(methods), fields: uniq(fields),
      }, line);
    }
    const inner = { ...env, classInfo };
    for (const m of node.body.body) {
      if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') {
        const mName = memberNameOf(m) ?? 'anonymous';
        const entry = env.func === null
          ? declareFunction(m, `${className}.${mName}`, exportedAs === null ? null : exportedAs, inner.scope, inner)
          : null;
        visitFunctionBody(m, inner, entry);
        continue;
      }
      if (m.type === 'ClassProperty' || m.type === 'ClassPrivateProperty') {
        if (m.value && isFunctionNode(m.value)) {
          const pName = memberNameOf(m) ?? 'anonymous';
          const entry = env.func === null
            ? declareFunction(m.value, `${className}.${pName}`, exportedAs === null ? null : exportedAs, inner.scope, inner)
            : null;
          visitFunctionBody(m.value, inner, entry);
          continue;
        }
        if (m.value) visit(m.value, inner);
        continue;
      }
      eachChild(m, (child) => visit(child, inner));
    }
  };

  const visitFunctionBody = (node, env, entry) => {
    const scope = new Scope(env.scope, false);
    for (const p of node.params || []) for (const n of patternNames(p)) scope.declare(n, null);
    // A CLIENT ARRIVES AS A PARAMETER, in a function the framework fills in.
    // The map is inherited downward, because `$http.get(url).then(function () {
    // $http.post(…) })` is the same client one scope deeper.
    let injected = env.injected ?? null;
    if (injectedClients.size > 0 && injectionTargets.has(node)) {
      for (const p of node.params || []) {
        if (!p || p.type !== 'Identifier') continue;
        const client = injectedClients.get(p.name);
        if (!client) continue;
        if (injected === null || injected === env.injected) injected = new Map(injected ?? []);
        injected.set(p.name, client);
      }
    }
    const inner = {
      scope, func: entry ?? env.func, defaultExport: false, classInfo: env.classInfo ?? null, injected,
    };
    if (node.body) {
      if (node.body.type === 'BlockStatement') {
        for (const stmt of node.body.body) visit(stmt, inner);
      } else {
        visit(node.body, inner);
      }
    }
  };

  const visitObject = (node, env, defaultMember) => {
    for (const p of node.properties) {
      if (p.type === 'ObjectMethod') {
        const name = keyName(p);
        const entry = (env.func === null && name !== null)
          ? declareFunction(p, name, defaultMember ? 'default-member' : null, env.scope, env)
          : null;
        visitFunctionBody(p, env, entry);
        continue;
      }
      if (p.type === 'ObjectProperty') {
        const name = keyName(p);
        if (isFunctionNode(p.value)) {
          const entry = (env.func === null && name !== null)
            ? declareFunction(p.value, name, defaultMember ? 'default-member' : null, env.scope, env)
            : null;
          visitFunctionBody(p.value, env, entry);
          continue;
        }
        if (p.value.type === 'ObjectExpression') { visitObject(p.value, env, defaultMember); continue; }
        if (p.value.type === 'ArrayExpression') { visitArray(p.value, env, defaultMember); continue; }
        visit(p.value, env);
        continue;
      }
      eachChild(p, (child) => visit(child, env));
    }
  };

  const visitArray = (node, env, defaultMember) => {
    for (const el of node.elements) {
      if (!el) continue;
      if (el.type === 'ObjectExpression') {
        maybeRoute(el, env, null);
        visitObject(el, env, defaultMember === true);
        continue;
      }
      if (el.type === 'ArrayExpression') { visitArray(el, env, defaultMember); continue; }
      visit(el, env);
    }
  };

  const visitAssignment = (node, env) => {
    const left = node.left;
    if (left && (left.type === 'MemberExpression' || left.type === 'OptionalMemberExpression')) {
      const c = calleeOf(left);
      if (c && c.path.length >= 2 && c.path[c.path.length - 2] === 'defaults' && c.path[c.path.length - 1] === 'baseURL') {
        const line = lineOf(node);
        emit({
          kind: 'config', file: relFile, line, what: 'axios-defaults', key: 'baseURL',
          value: summarizeArg(node.right),
        }, line);
      }
      // `this.<field> = <what>` inside a class body. This is where a class puts
      // the client it will send everything through, so it is recorded with the
      // same `init` shape a top-level `const` gets.
      if (env.classInfo && c && c.root === 'this' && c.path.length === 1) {
        const shaped = initOf(node.right, env);
        if (shaped !== null) {
          const line = lineOf(node);
          emit({
            kind: 'assign', file: relFile, line, class: env.classInfo.name, field: c.path[0], init: shaped,
          }, line);
        }
      }
    }
    visit(node.right, env);
    if (left && left.type !== 'Identifier') eachChild(left, (child) => visit(child, env));
  };

  // ---- calls --------------------------------------------------------------
  const looksLikeUrlText = (s) => typeof s === 'string' && (s.startsWith('/') || /^(https?:)?\/\//.test(s));

  const argCarriesUrl = (summary) => {
    if (!summary) return false;
    if (summary.kind === 'string') return looksLikeUrlText(summary.value);
    if (summary.kind === 'template') return looksLikeUrlText(summary.template);
    if (summary.kind === 'ternary') return summary.candidates.some(argCarriesUrl);
    if (summary.kind === 'object') return Object.prototype.hasOwnProperty.call(summary.keys, 'url');
    return false;
  };

  /**
   * WHICH POSITIONAL ARGUMENT IS THE URL, when no object argument spells `url:`.
   *
   * The loose answer, "the first string", is wrong on real code and wrong in a
   * way that quietly inflates every count downstream: a frontend is full of
   * `emit('close')`, `ref('')` and `useDesign('app-logo')`, and calling those
   * URLs would tell a reader this project makes ten times the HTTP calls it
   * makes. So an argument is the URL only when something SHOWS that it is:
   *
   *   - the call is HTTP-SHAPED (its callee is named after an HTTP verb), in
   *     which case the first non-config argument is the URL by every convention
   *     in the ecosystem, whatever it resolves to;
   *   - or the argument is text that reads like a path: a leading slash, a
   *     protocol-relative `//host/x`, or an absolute http/https address. Nothing
   *     but a URL is written that way;
   *   - or it is a name this file can follow to such text.
   *
   * A relative path with no leading slash (`get('user/list')`) is only caught by
   * the first rule. That is the known cost of not guessing.
   */
  // A bare `'/'` is not evidence of anything: it is the separator, and
  // `p.split('/')`, `p.lastIndexOf('/')` and `p.indexOf('/')` are how every
  // frontend takes a path apart. A project that really does call the root path
  // writes `{ url: '/' }`, and the object rule above catches that untouched.
  const evidenceOfAUrl = (text) => looksLikeUrlText(text) && text !== '/';

  const looksLikeUrlSummary = (summary) => {
    if (!summary) return false;
    if (summary.kind === 'string') return evidenceOfAUrl(summary.value);
    if (summary.kind === 'template') return evidenceOfAUrl(summary.template);
    if (summary.kind === 'ternary') return summary.candidates.some(looksLikeUrlSummary);
    return false;
  };

  const resolvesToUrl = (summary, scope) => {
    const r = resolveSummary(summary, scope, viaOf(summary), 1);
    return r !== null && r.length > 0 && r.every((x) => looksLikeUrlText(x.template));
  };

  // ---- a function handed over as a VALUE ----------------------------------
  //
  // A view that writes `usePagedList({ api: list, save })` never calls `list`,
  // so a rule that follows CALLS sees nothing and the screen ends there. But
  // the view did name the function, and whoever received it may call it: that
  // is a real dependency and a sound candidate, and the bridge grades it as one.
  //
  // WHAT COUNTS AS A REFERENCE, and nothing else does:
  //   - an identifier, in any argument position, or as the value of an
  //     object-literal argument's property (one level deep, any key);
  //   - a member of one (`api.list`, where `api` is a namespace import);
  //   - and only when the file BINDS that identifier to an import or to a
  //     function it declares itself. A parameter of the enclosing function is
  //     not followable, and a global is not this project's.
  //
  // A string is a string, a call is already a call, and an inline arrow's own
  // body is attributed to the enclosing named function, so none of the three is
  // a reference here.
  const refBindingOf = (root, scope, classInfo) => {
    const b = bindingOf(root, scope, classInfo);
    if (!b) return null;
    if (b.kind === 'import') return { kind: 'import', source: b.source, imported: b.imported };
    if (b.kind === 'local' && top.functions.has(b.name)) return { kind: 'local', name: b.name };
    return null;
  };

  const refOf = (node, env, via, key) => {
    if (!node) return null;
    const keyPart = key === null ? {} : { key };
    if (node.type === 'Identifier') {
      const b = refBindingOf(node.name, env.scope, env.classInfo);
      return b ? { name: node.name, binding: b, via, ...keyPart } : null;
    }
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const c = calleeOf(node);
      if (!c || c.root === null || c.path.length === 0) return null;
      const b = refBindingOf(c.root, env.scope, env.classInfo);
      return b ? { name: c.root, path: c.path, binding: b, via, ...keyPart } : null;
    }
    return null;
  };

  /** Every function reference in one call's arguments, in source order, once each. */
  const fnRefsOf = (args, env) => {
    const out = [];
    const seen = new Set();
    const add = (r) => {
      if (r === null) return;
      const k = JSON.stringify(r);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    };
    for (const a of args ?? []) {
      if (!a) continue;
      if (a.type === 'ObjectExpression') {
        for (const p of a.properties) {
          if (p.type !== 'ObjectProperty') continue;
          const key = keyName(p);
          if (key === null) continue;
          add(refOf(p.value, env, 'property', key));
        }
        continue;
      }
      add(refOf(a, env, 'argument', null));
    }
    return out;
  };

  const visitCall = (node, env) => {
    const isNew = node.type === 'NewExpression';
    const calleeNode = node.callee;
    // `import('x')` is not a call to anything this file declares: it is the
    // route-component form, and it is recorded as a dynamic import.
    if (!isNew && calleeNode && calleeNode.type === 'Import') {
      const arg = node.arguments[0];
      const line = lineOf(node);
      if (arg && arg.type === 'StringLiteral') {
        emit({ kind: 'import', file: relFile, line, source: arg.value, specifiers: [], dynamic: true }, line);
      }
      for (const a of node.arguments) visit(a, env);
      return;
    }
    const callee = calleeNode ? calleeOf(calleeNode) : null;
    const line = lineOf(node);

    // `require('x')` is the CommonJS spelling of an import.
    if (isRequireCall(node, env)) {
      emit({
        kind: 'import', file: relFile, line, source: node.arguments[0].value,
        specifiers: env.requireLocal ? [{ imported: 'default', local: env.requireLocal }] : [],
        dynamic: false,
      }, line);
      return;
    }

    // A CALL A PACK LISTS AS A DECLARATION SENDS NOTHING.
    // `$urlRouterProvider.otherwise('/welcome')` names the route to fall back
    // to; reading it as a request put `ANY /welcome` in the pack and let a
    // frontend "call" a table it never touches. The arguments are still walked,
    // because a real call can sit inside one.
    if (!isNew && callee !== null) {
      const declared = packs.some((p) => (p.declarationCalls ?? []).some(
        (d) => (d.receivers ?? []).includes(callee.root)
          && (d.methods ?? []).includes(callee.path.length > 0 ? callee.path[callee.path.length - 1] : callee.root),
      ));
      if (declared || declarationCalls.has(node)) {
        for (const a of node.arguments) visit(a, env);
        return;
      }
    }

    const argNodes = node.arguments.slice(0, 3);
    // AN OBJECT A ROUTER PACK READS AS A ROUTE IS NOT A REQUEST. Its `path` or
    // `url` is where the browser goes, not where a request is sent, and the
    // route reader has already recorded it as one.
    const routeArg = argNodes.map((a) => anyPackSeesARoute(a));
    const summaries = argNodes.map((a) => summarizeArg(a));
    const binding = callee ? bindingOf(callee.root, env.scope, env.classInfo) : null;
    let platformSink = null;
    if (!isNew && callee && callee.shape === 'ident' && callee.root === 'fetch' && binding && binding.kind === 'global') {
      platformSink = 'fetch';
    } else if (!isNew && callee && callee.name === 'open' && callee.path.length >= 1 && top.xhr.has(callee.root)) {
      platformSink = 'xhr';
    } else if (!isNew && callee && callee.name === 'open' && callee.root === 'XMLHttpRequest') {
      platformSink = 'xhr';
    }

    // A GLOBAL CLIENT THE PAGE LOADED. `$.ajax({url})`, `$.post(url)`: the root
    // is a name the pack lists, nothing in this file declares it, and the method
    // is one the pack names. `$('#x').val()` is not this — its callee sits on
    // the result of a call, which has no root name at all.
    let globalClient = null;
    if (!isNew && callee !== null && callee.path.length === 1
      && binding !== null && binding.kind === 'global' && globalClients.has(callee.root)) {
      const client = globalClients.get(callee.root);
      const method = callee.path[0];
      const isConfig = (client.config?.methods ?? []).includes(method);
      const isVerb = Object.prototype.hasOwnProperty.call(client.verbs ?? {}, method);
      if (isConfig || isVerb) {
        platformSink = client.name;
        globalClient = { client, method, isConfig };
      }
    }

    // `this.something(…)` inside a class, where `something` is a member THIS
    // class declares or assigns. That restriction is what keeps the stream from
    // filling up with every `this.$emit`, `this.setState` and `this.$refs.x`
    // call a component makes: only a member of this class can be the client it
    // sends through, and only a member of this class is a call the bridge can
    // follow within the file.
    const throughThis = binding !== null && binding.kind === 'this'
      && callee.path.length >= 1 && env.classInfo.members.has(callee.path[0]);
    const goesThroughABinding = binding !== null
      && (binding.kind === 'import' || (binding.kind === 'local' && top.bindings.has(binding.name)) || throughThis);
    const carriesUrl = summaries.some((s, i) => !routeArg[i] && argCarriesUrl(s));

    // THE CLIENT THE FRAMEWORK HANDED IN. `$http` is a parameter, so nothing in
    // this file binds it and every rule above sees a call on an unknown name.
    // What makes it a client is the pack's own list plus where the function
    // sits, and both were settled before the walk. The verb has to be one the
    // pack names, so `$http.pending` is still nothing.
    let injected = null;
    if (!isNew && callee !== null && env.injected) {
      const client = env.injected.get(callee.root);
      if (client) {
        const verb = callee.path.length === 0 ? '(call)' : callee.path[callee.path.length - 1];
        const known = callee.path.length === 0
          ? (client.generic ?? []).includes('(call)')
          : Object.prototype.hasOwnProperty.call(client.verbs ?? {}, verb) || (client.generic ?? []).includes(verb);
        if (known) injected = { client: client.name, framework: client.framework ?? null };
      }
    }

    if (callee !== null && (goesThroughABinding || carriesUrl || platformSink !== null || injected !== null)) {
      const rec = {
        kind: 'call', file: relFile, line,
        enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : moduleEnclosing,
        callee: isNew ? { ...callee, shape: 'new' } : callee,
        binding,
        args: summaries,
        url: null,
        method: null,
        platformSink,
        ...(injected !== null ? { injected } : {}),
      };
      if (env.func) rec.__enclosingEntry = env.func;

      // ---- the URL argument ------------------------------------------
      // The two platform sinks say which argument the URL is, by contract:
      // `fetch(url, init)` and `xhr.open(method, url)`. Nothing has to be shown.
      let urlSummary = null;
      if (globalClient !== null) {
        // `$.ajax({url: …})` and `$.ajax(url, settings)` are the same call
        // written two ways; a verb call (`$.post(url, data)`) puts it first.
        const at = summaries[globalClient.client.config?.urlArg ?? globalClient.client.urlArg ?? 0] ?? null;
        if (!globalClient.isConfig) urlSummary = at;
        else if (at && at.kind === 'object') {
          urlSummary = Object.prototype.hasOwnProperty.call(at.keys, globalClient.client.config.urlKey)
            ? at.keys[globalClient.client.config.urlKey] : null;
        } else urlSummary = at;
      } else if (platformSink === 'xhr') {
        urlSummary = summaries[1] ?? null;
      } else if (platformSink === 'fetch') {
        urlSummary = summaries[0] ?? null;
      } else {
        for (let i = 0; i < summaries.length; i += 1) {
          const s = summaries[i];
          if (routeArg[i]) continue;
          if (s.kind === 'object' && Object.prototype.hasOwnProperty.call(s.keys, 'url')) {
            urlSummary = s.keys.url;
            break;
          }
        }
        if (urlSummary === null) {
          const httpShaped = typeof callee.name === 'string' && VERBS.has(callee.name.toUpperCase());
          for (let i = 0; i < summaries.length; i += 1) {
            const s = summaries[i];
            if (routeArg[i]) continue;
            if (s.kind === 'object' || s.kind === 'other') continue;
            if (httpShaped) { urlSummary = s; break; }
            if (looksLikeUrlSummary(s)) { urlSummary = s; break; }
            if ((s.kind === 'member' || s.kind === 'ident') && resolvesToUrl(s, env.scope)) {
              urlSummary = s; break;
            }
          }
        }
      }
      if (urlSummary !== null) rec.url = buildUrl(urlSummary, env.scope);

      // ---- the method -------------------------------------------------
      rec.method = methodOf(callee, summaries, platformSink, globalClient);

      // ---- the functions this call HANDS OVER --------------------------
      // Left off when there are none, so a frontend's tens of thousands of
      // ordinary call records do not each grow an empty list.
      const refs = fnRefsOf(node.arguments, env);
      if (refs.length > 0) rec.fnRefs = refs;

      emit(rec, line);
    }

    for (const a of node.arguments) visit(a, env);
    if (calleeNode && calleeNode.type !== 'Identifier') {
      // A call on the result of another call (`create().get(…)`) still has to
      // be walked, or the inner call disappears.
      eachChild(calleeNode, (child) => visit(child, env));
    }
  };

  const methodOf = (callee, summaries, platformSink, globalClient = null) => {
    const fromObject = (keys = ['method', 'type']) => {
      for (const s of summaries) {
        if (s.kind !== 'object') continue;
        for (const key of keys) {
          const v = s.keys[key];
          if (v && v.kind === 'string' && VERBS.has(v.value.toUpperCase())) {
            return v.value.toUpperCase();
          }
        }
      }
      return null;
    };
    if (globalClient !== null) {
      // The pack's own verb table first: `getJSON` is a GET and is spelled like
      // nothing. Then the config keys, for the one method that takes a config.
      const verbs = globalClient.client.verbs ?? {};
      if (Object.prototype.hasOwnProperty.call(verbs, globalClient.method)) {
        return { value: verbs[globalClient.method], from: 'callee-name' };
      }
      const v = fromObject(globalClient.client.config?.methodKeys ?? []);
      return v ? { value: v, from: 'config' } : null;
    }
    if (platformSink === 'xhr') {
      const first = summaries[0];
      if (first && first.kind === 'string' && VERBS.has(first.value.toUpperCase())) {
        return { value: first.value.toUpperCase(), from: 'positional' };
      }
      return null;
    }
    if (platformSink === 'fetch') {
      const v = fromObject();
      return v ? { value: v, from: 'positional' } : null;
    }
    if (callee && typeof callee.name === 'string' && VERBS.has(callee.name.toUpperCase())) {
      return { value: callee.name.toUpperCase(), from: 'callee-name' };
    }
    const v = fromObject();
    return v ? { value: v, from: 'config' } : null;
  };

  // ---- routes -------------------------------------------------------------
  /**
   * Emit a route record for `node` when one of the packs recognizes it. The
   * pack is chosen by the keys the object itself carries: each pack's
   * DISTINCTIVE keys (the ones no other pack names) decide, and the file's own
   * registrar calls break a tie. Nothing here is hard-coded to a framework.
   */
  const maybeRoute = (node, env, parentLine) => {
    if (routeHandled.has(node)) return;
    const matches = [];
    for (const p of packs) {
      // A chain pack's route objects are read where its registrar names them
      // (`chainRoutes` below) and nowhere else.
      if (p.__routesFrom === 'chain') continue;
      if (!packSeesARoute(p, node)) continue;
      let score = 0;
      for (const k of p.__distinctive) if (propOf(node, k) !== null) score += 1;
      if (st.registrarPacks && st.registrarPacks.has(p.pack)) score += 0.5;
      matches.push({ pack: p, score });
    }
    if (matches.length === 0) return;
    matches.sort((a, b) => b.score - a.score || (a.pack.pack < b.pack.pack ? -1 : 1));
    const pack = matches[0].pack;
    const ro = pack.routeObject || {};
    const line = lineOf(node);
    routeHandled.add(node);

    const rec = { kind: 'route', file: relFile, line, pack: pack.pack };
    const pathValue = propOf(node, ro.pathKey);
    rec.path = pathValue.value;
    const nameValue = ro.nameKey ? propOf(node, ro.nameKey) : null;
    if (nameValue && nameValue.type === 'StringLiteral') rec.name = nameValue.value;
    for (const k of ro.componentKeys || []) {
      const c = propOf(node, k);
      if (!c) continue;
      const src = componentSourceOf(c);
      if (src.source) rec.componentSource = src.source;
      if (src.local) rec.componentLocal = src.local;
      break;
    }
    const redirect = ro.redirectKey ? propOf(node, ro.redirectKey) : null;
    if (redirect && redirect.type === 'StringLiteral') rec.redirect = redirect.value;
    const meta = ro.metaKey ? propOf(node, ro.metaKey) : null;
    if (meta && meta.type === 'ObjectExpression' && ro.titleKey) {
      const title = propOf(meta, ro.titleKey);
      if (title && title.type === 'StringLiteral') rec.metaTitle = title.value;
    }
    const hidden = ro.hiddenKey ? propOf(node, ro.hiddenKey) : null;
    if (hidden && hidden.type === 'BooleanLiteral') rec.hidden = hidden.value;
    rec.parent = parentLine;

    const children = ro.childrenKey ? propOf(node, ro.childrenKey) : null;
    let childCount = 0;
    if (children && children.type === 'ArrayExpression') {
      for (const el of children.elements) {
        if (el && el.type === 'ObjectExpression') {
          const before = routeHandled.size;
          maybeRoute(el, env, line);
          if (routeHandled.size > before) childCount += 1;
        }
      }
    }
    rec.children = childCount;
    emit(rec, line);
  };

  /** Where a route's component comes from: a dynamic import, or an imported name. */
  const componentSourceOf = (node) => {
    let n = node;
    if (n.type === 'ArrowFunctionExpression' && n.body) n = n.body;
    if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee && n.callee.type === 'Import') {
      const a = n.arguments[0];
      if (a && a.type === 'StringLiteral') return { source: a.value, local: null };
    }
    if (n.type === 'ObjectExpression') {
      // `components: { default: X }`: take the first member that resolves.
      for (const p of n.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const r = componentSourceOf(p.value);
        if (r.source || r.local) return r;
      }
      return { source: null, local: null };
    }
    if (n.type === 'JSXElement' && n.openingElement && n.openingElement.name) {
      const nm = n.openingElement.name;
      const local = nm.type === 'JSXIdentifier' ? nm.name : null;
      if (local && top.imports.has(local)) return { source: top.imports.get(local).source, local };
      return { source: null, local };
    }
    if (n.type === 'Identifier') {
      if (top.imports.has(n.name)) return { source: top.imports.get(n.name).source, local: n.name };
      return { source: null, local: n.name };
    }
    if (n.type === 'StringLiteral') return { source: n.value, local: null };
    return { source: null, local: null };
  };

  const jsxAttr = (element, name) => {
    const open = element.openingElement;
    if (!open) return null;
    for (const a of open.attributes) {
      if (a.type !== 'JSXAttribute') continue;
      const an = a.name && a.name.type === 'JSXIdentifier' ? a.name.name : null;
      if (an === name) return a.value;
    }
    return null;
  };

  const visitJsx = (node, env, parentLine) => {
    const open = node.openingElement;
    const tag = open && open.name && open.name.type === 'JSXIdentifier' ? open.name.name : null;
    let emitted = null;
    for (const p of packs) {
      const jsx = p.jsx;
      if (!jsx || jsx.element !== tag) continue;
      const pathAttr = jsxAttr(node, jsx.pathAttr);
      let pathText = null;
      if (pathAttr && pathAttr.type === 'StringLiteral') pathText = pathAttr.value;
      else if (pathAttr && pathAttr.type === 'JSXExpressionContainer' && pathAttr.expression.type === 'StringLiteral') {
        pathText = pathAttr.expression.value;
      }
      if (pathText === null) continue;
      const line = lineOf(node);
      const rec = { kind: 'route', file: relFile, line, pack: p.pack, path: pathText };
      for (const attr of jsx.componentAttrs || []) {
        const v = jsxAttr(node, attr);
        if (!v) continue;
        const inner = v.type === 'JSXExpressionContainer' ? v.expression : v;
        const src = componentSourceOf(inner);
        if (src.source) rec.componentSource = src.source;
        if (src.local) rec.componentLocal = src.local;
        break;
      }
      rec.parent = parentLine;
      let childCount = 0;
      for (const child of node.children || []) {
        if (child.type === 'JSXElement') {
          const t = child.openingElement && child.openingElement.name && child.openingElement.name.type === 'JSXIdentifier'
            ? child.openingElement.name.name : null;
          if (t === jsx.element) { visitJsx(child, env, line); childCount += 1; continue; }
        }
        visit(child, env);
      }
      rec.children = childCount;
      emit(rec, line);
      emitted = rec;
      break;
    }
    if (emitted !== null) {
      for (const a of (open.attributes || [])) if (a.type === 'JSXAttribute' && a.value) visit(a.value, env);
      return;
    }
    eachChild(node, (child) => visit(child, env));
  };

  // ---- the registrars this file names, for the pack tie-break -------------
  st.registrarPacks = new Set();
  const registrarScan = (n) => {
    if (!n) return;
    if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && n.callee) {
      const c = calleeOf(n.callee);
      if (c) {
        for (const p of packs) {
          if ((p.registrars || []).includes(c.name)) st.registrarPacks.add(p.pack);
        }
      }
    }
    if (n.type === 'JSXElement' && n.openingElement && n.openingElement.name && n.openingElement.name.type === 'JSXIdentifier') {
      for (const p of packs) if (p.jsx && p.jsx.element === n.openingElement.name.name) st.registrarPacks.add(p.pack);
    }
    eachChild(n, registrarScan);
  };
  registrarScan(program);

  // ---- a registrar call's own routes array --------------------------------
  const registrarRoutes = (n, env) => {
    if (!n) return;
    if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && n.callee) {
      const c = calleeOf(n.callee);
      if (c) {
        for (const p of packs) {
          if (!(p.registrars || []).includes(c.name)) continue;
          const first = n.arguments && n.arguments[0];
          const list = first && first.type === 'ObjectExpression' && p.routesKey ? propOf(first, p.routesKey) : null;
          if (list && list.type === 'ArrayExpression') {
            for (const el of list.elements) if (el && el.type === 'ObjectExpression') maybeRoute(el, env, null);
          }
        }
      }
    }
    eachChild(n, (child) => registrarRoutes(child, env));
  };

  // ---- a CHAIN registrar's routes -----------------------------------------
  //
  // `$stateProvider.state('owners', {…}).state('vets', {…})` is one call per
  // route, each written on the result of the one before it. `calleeOf` gives up
  // on that shape by design (its root is a call, not a name), so the chain is
  // walked here: down the member/call spine to the identifier at the bottom,
  // which is the receiver the pack names.
  const chainReceiverOf = (node, spec) => {
    if (!node.callee || (node.callee.type !== 'MemberExpression' && node.callee.type !== 'OptionalMemberExpression')) return null;
    const prop = node.callee.property;
    const method = !node.callee.computed && prop && prop.type === 'Identifier' ? prop.name
      : (prop && prop.type === 'StringLiteral' ? prop.value : null);
    if (method !== spec.method) return null;
    let cur = node.callee.object;
    for (let i = 0; i < HOP_GUARD && cur; i += 1) {
      if (cur.type === 'Identifier') return spec.receivers.includes(cur.name) ? cur.name : null;
      if ((cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') && cur.callee) { cur = cur.callee; continue; }
      if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') { cur = cur.object; continue; }
      return null;
    }
    return null;
  };

  /** The parent state a route names: its own `parent` key, or a dotted name. */
  const parentNameOf = (routeNode, ro, stateName) => {
    const p = ro.parentKey ? propOf(routeNode, ro.parentKey) : null;
    if (p && p.type === 'StringLiteral' && p.value !== '') return p.value;
    if (typeof stateName === 'string') {
      const dot = stateName.lastIndexOf('.');
      if (dot > 0) return stateName.slice(0, dot);
    }
    return null;
  };

  const chainRoutes = (n) => {
    if (!n) return;
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      for (const p of packs) {
        for (const spec of p.__chains ?? []) {
          const receiver = chainReceiverOf(n, spec);
          if (receiver === null) continue;
          declarationCalls.add(n);
          const args = n.arguments ?? [];
          const routeNode = args[spec.routeArg];
          if (routeNode && routeNode.type === 'ObjectExpression') routeObjects.add(routeNode);
          const ro = p.routeObject || {};
          // THE LINE OF THIS LINK, not of the chain. Every `.state(…)` written
          // on the result of the one before it starts where the whole
          // expression starts, so the call node's own position would give the
          // ten routes of one chain the same line.
          const line = lineOf(n.callee.property ?? n);
          const rec = { kind: 'route', file: relFile, line, pack: p.pack, via: 'chain', receiver };
          const nameNode = Number.isInteger(spec.nameArg) ? args[spec.nameArg] : null;
          if (nameNode && nameNode.type === 'StringLiteral') rec.name = nameNode.value;
          // The path is the route object's own key on a `state`, and the first
          // argument on a `when`. Missing is '' — a state with no url of its own
          // is the parent's path, which is what composing it says.
          let pathText = null;
          if (Number.isInteger(spec.pathArg)) {
            const pathNode = args[spec.pathArg];
            if (pathNode && pathNode.type === 'StringLiteral') pathText = pathNode.value;
          }
          if (pathText === null && routeNode && ro.pathKey) {
            const urlNode = propOf(routeNode, ro.pathKey);
            if (urlNode && urlNode.type === 'StringLiteral') pathText = urlNode.value;
          }
          rec.path = pathText ?? '';
          const parentName = routeNode ? parentNameOf(routeNode, ro, rec.name) : null;
          if (parentName !== null) rec.parentName = parentName;
          const abstractNode = routeNode && ro.abstractKey ? propOf(routeNode, ro.abstractKey) : null;
          if (abstractNode && abstractNode.type === 'BooleanLiteral' && abstractNode.value === true) rec.abstract = true;
          if (routeNode) {
            for (const k of ro.componentKeys ?? []) {
              const v = propOf(routeNode, k);
              if (!v || v.type !== 'StringLiteral') continue;
              if (k === 'component') { rec.componentName = v.value; break; }
              if (k === 'template') {
                const tag = soleElementTag(v.value);
                if (tag !== null) { rec.componentTag = tag; break; }
                continue;
              }
              if (k === 'templateUrl') { attachTemplate(rec, v.value); break; }
            }
            const ctrl = ro.controllerKey ? propOf(routeNode, ro.controllerKey) : null;
            if (ctrl && ctrl.type === 'StringLiteral') rec.controllerName = ctrl.value;
          }
          rec.parent = null;
          rec.children = 0;
          emit(rec, line);
        }
      }
    }
    eachChild(n, chainRoutes);
  };

  // ---- the framework's own name registry ----------------------------------
  //
  // `angular.module('ownerList').component('ownerList', {controller: 'OwnerListController'})`
  // is how a frontend written before modules says one thing is made of another.
  // Nothing is resolved here: the record says which NAME was registered, in
  // which file, and which other names it points at. Putting those together is
  // the bridge's job, because the two names are in two files.
  const moduleLocals = new Set();
  const registrationSpecs = packs.map((p) => p.registrations).filter((r) => r && Array.isArray(r.kinds));
  const isRegistryRoot = (name, spec) => name === spec.root || moduleLocals.has(name);

  const collectModuleLocals = (n) => {
    if (!n) return;
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.init) {
      const c = n.init.type === 'CallExpression' || n.init.type === 'OptionalCallExpression'
        ? calleeOf(n.init.callee) : null;
      for (const spec of registrationSpecs) {
        if (c && c.root === spec.root && c.path.length === 1 && c.path[0] === spec.moduleMethod) moduleLocals.add(n.id.name);
      }
    }
    eachChild(n, collectModuleLocals);
  };

  /** The definition object a registration was given, through the DI array form. */
  const definitionObjectOf = (node) => {
    if (!node) return null;
    if (node.type === 'ObjectExpression') return node;
    if (node.type === 'ArrayExpression') {
      const last = node.elements[node.elements.length - 1];
      return last && last.type === 'ObjectExpression' ? last : null;
    }
    // `.directive('x', function () { return { controller: 'X' } })`
    if (isFunctionNode(node)) {
      let body = node.body;
      if (body && body.type === 'BlockStatement') {
        for (let i = body.body.length - 1; i >= 0; i -= 1) {
          if (body.body[i].type === 'ReturnStatement') { body = body.body[i].argument; break; }
        }
      }
      return body && body.type === 'ObjectExpression' ? body : null;
    }
    return null;
  };

  const registrationScan = (n) => {
    if (!n) return;
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      const method = n.callee && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')
        && !n.callee.computed && n.callee.property && n.callee.property.type === 'Identifier'
        ? n.callee.property.name : null;
      if (method !== null) {
        let cur = n.callee.object;
        let rootName = null;
        for (let i = 0; i < HOP_GUARD && cur; i += 1) {
          if (cur.type === 'Identifier') { rootName = cur.name; break; }
          if ((cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') && cur.callee) { cur = cur.callee; continue; }
          if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') { cur = cur.object; continue; }
          break;
        }
        for (const spec of registrationSpecs) {
          if (rootName === null || !isRegistryRoot(rootName, spec)) continue;
          const kind = spec.kinds.find((k) => k.method === method);
          if (!kind) continue;
          const args = n.arguments ?? [];
          const nameNode = args[kind.nameArg];
          if (!nameNode || nameNode.type !== 'StringLiteral' || nameNode.value === '') continue;
          const def = definitionObjectOf(args[kind.defArg]);
          const line = lineOf(n);
          const rec = {
            kind: 'registration', file: relFile, line, framework: spec.root,
            what: method, name: nameNode.value,
          };
          if (def) {
            const ctrl = spec.controllerKey ? propOf(def, spec.controllerKey) : null;
            if (ctrl && ctrl.type === 'StringLiteral') rec.controller = ctrl.value;
            const tpl = spec.templateKey ? propOf(def, spec.templateKey) : null;
            if (tpl && tpl.type === 'StringLiteral') {
              const tags = customElementTags(tpl.value);
              if (tags.length > 0) rec.templateTags = tags;
            }
            const url = spec.templateUrlKey ? propOf(def, spec.templateUrlKey) : null;
            if (url && url.type === 'StringLiteral') attachTemplate(rec, url.value);
          }
          // A directive is only a mount point when its definition names a
          // controller. Every other directive is behaviour on an element, and
          // claiming it renders a screen would be an invention.
          if (kind.needs && !Object.prototype.hasOwnProperty.call(rec, kind.needs)) continue;
          emit(rec, line);
        }
      }
    }
    eachChild(n, registrationScan);
  };

  // ---- the client the framework hands you ---------------------------------
  //
  // `$http` is not imported and not declared: it arrives as a parameter, and
  // the only thing that says it is a client is WHERE the function sits. So the
  // two forms the pack names are found first, and a parameter is a client only
  // inside one of them.
  const injectionScan = (n) => {
    if (!n) return;
    if (n.type === 'ArrayExpression') {
      // `['$http', function ($http) {…}]`: the framework's own inline
      // annotation. The names come first, the function last.
      const els = n.elements ?? [];
      const last = els[els.length - 1];
      if (els.length >= 2 && last && isFunctionNode(last)
        && els.slice(0, -1).every((e) => e && e.type === 'StringLiteral')) {
        injectionTargets.add(last);
      }
    }
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
      const c = n.callee ? calleeOf(n.callee) : null;
      const method = c ? c.name : (n.callee && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')
        && !n.callee.computed && n.callee.property && n.callee.property.type === 'Identifier'
        ? n.callee.property.name : null);
      const named = [...injectedClients.values()].some((client) => (client.registrars ?? []).includes(method));
      if (named) {
        for (const a of n.arguments ?? []) {
          if (!a) continue;
          if (isFunctionNode(a)) { injectionTargets.add(a); continue; }
          if (a.type === 'ObjectExpression') {
            for (const prop of a.properties) {
              if (prop.type !== 'ObjectProperty') continue;
              if (isFunctionNode(prop.value)) injectionTargets.add(prop.value);
            }
          }
        }
      }
    }
    eachChild(n, injectionScan);
  };

  const rootEnv = { scope: moduleScope, func: null, defaultExport: false, classInfo: null, injected: null };
  collectModuleLocals(program);
  injectionScan(program);
  chainRoutes(program);
  registrationScan(program);
  registrarRoutes(program, rootEnv);
  for (const stmt of program.body) visit(stmt, rootEnv);
}

// ---------------------------------------------------------------------------
// Vue single-file components
// ---------------------------------------------------------------------------

const SCRIPT_OPEN = /(^|\n)[ \t]*<script(\s[^>]*)?>/g;

/**
 * The script blocks of a `.vue` file, each with the LINE OFFSET of its first
 * line of code, so that every line number this worker prints is the line in the
 * `.vue` file rather than the line in an extracted fragment.
 *
 * `<template>` is not parsed: it is markup, and the calls live in the script.
 */
function vueBlocks(text) {
  const blocks = [];
  SCRIPT_OPEN.lastIndex = 0;
  let m;
  while ((m = SCRIPT_OPEN.exec(text)) !== null) {
    const attrs = m[2] || '';
    const openEnd = m.index + m[0].length;
    const close = text.indexOf('</script>', openEnd);
    if (close < 0) break;
    const code = text.slice(openEnd, close);
    const before = text.slice(0, openEnd);
    const lineOffset = before.split('\n').length - 1;
    const langMatch = /\blang\s*=\s*["']([^"']+)["']/.exec(attrs);
    const declared = langMatch ? langMatch[1].toLowerCase() : 'js';
    const lang = declared === 'ts' ? 'ts' : declared === 'tsx' ? 'tsx' : declared === 'jsx' ? 'jsx' : 'js';
    blocks.push({
      code, lang, setup: /\bsetup\b/.test(attrs), lineOffset,
      line: lineOffset + 1,
    });
    SCRIPT_OPEN.lastIndex = close;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Package-level configuration: env files, proxies, aliases
// ---------------------------------------------------------------------------

/** JSON with `//` and block comments and trailing commas, as tsconfig is written. */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      out += c; i += 1;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i];
        if (text[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A dotenv file: `KEY = value`, quotes stripped, `#` comments ignored, no interpolation. */
function parseDotenv(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let name = line.slice(0, eq).trim();
    if (name.startsWith('export ')) name = name.slice(7).trim();
    if (name === '') continue;
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(' #');
    if (hash >= 0 && !/^["']/.test(value)) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

/** `.env.development.local` -> `development`; `.env` and `.env.local` -> null. */
function envModeOf(fileName) {
  let rest = fileName.slice('.env'.length);
  if (rest.endsWith('.local')) rest = rest.slice(0, -'.local'.length);
  rest = rest.replace(/^\./, '');
  return rest === '' ? null : rest;
}

/** The first string inside an expression that reads like a relative path. */
function firstPathString(node) {
  let found = null;
  const walk = (n) => {
    if (found !== null || !n) return;
    if (n.type === 'StringLiteral') {
      const v = n.value;
      if (v !== '' && !v.includes(':') && !v.startsWith('@')) { found = v; return; }
      return;
    }
    eachChild(n, walk);
  };
  walk(node);
  if (found === null) return null;
  const to = found.replace(/^\.\//, '').replace(/\/+$/, '');
  // `path.resolve(__dirname, './')` is the package directory itself, and an
  // empty string would read as "no target" further down the line.
  return to === '' ? '.' : to;
}

/** The rewrite an arrow `(p) => p.replace(/^\/x/, '')` states, or 'opaque'. */
function rewriteOf(node) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') {
    // `pathRewrite: { '^/api': '' }` is the webpack-dev-server spelling.
    const out = [];
    for (const p of node.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const from = keyName(p);
      if (from === null || p.value.type !== 'StringLiteral') return 'opaque';
      out.push({ from, to: p.value.value });
    }
    return out.length > 0 ? out : null;
  }
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') return 'opaque';
  let body = node.body;
  if (body && body.type === 'BlockStatement') {
    const ret = body.body.find((s) => s.type === 'ReturnStatement');
    if (!ret || !ret.argument) return 'opaque';
    body = ret.argument;
  }
  if (!body || (body.type !== 'CallExpression' && body.type !== 'OptionalCallExpression')) return 'opaque';
  const c = calleeOf(body.callee);
  if (!c || c.name !== 'replace' || body.arguments.length < 2) return 'opaque';
  const [pat, rep] = body.arguments;
  let from = null;
  if (pat.type === 'RegExpLiteral') from = pat.pattern;
  else if (pat.type === 'StringLiteral') from = pat.value;
  if (from === null || rep.type !== 'StringLiteral') return 'opaque';
  return [{ from, to: rep.value }];
}

/**
 * The proxy table an object literal declares, in either spelling a dev server
 * accepts: a bare target string, or an object with `target` and a rewrite.
 */
function proxyRecordsOf(objectNode, relFile, lineOf) {
  const out = [];
  if (!objectNode || objectNode.type !== 'ObjectExpression') return out;
  for (const p of objectNode.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const context = keyName(p);
    if (context === null) continue;
    const line = lineOf(p);
    if (p.value.type === 'StringLiteral') {
      out.push({ kind: 'config', file: relFile, line, what: 'proxy', context, target: p.value.value, rewrite: null });
      continue;
    }
    if (p.value.type !== 'ObjectExpression') continue;
    const targetNode = propOf(p.value, 'target');
    const target = targetNode && targetNode.type === 'StringLiteral' ? targetNode.value : null;
    const rw = propOf(p.value, 'rewrite') ?? propOf(p.value, 'pathRewrite');
    out.push({ kind: 'config', file: relFile, line, what: 'proxy', context, target, rewrite: rewriteOf(rw) });
  }
  return out;
}

/**
 * Everything a package directory says about itself: its env files, its dev
 * proxy and its path aliases. Read ONCE per package directory, even when two
 * source roots share it.
 */
function readPackageConfig(pkgDir, root, out) {
  const rel = (abs) => toPosix(path.relative(root, abs));
  const records = [];
  const parsedFiles = [];
  let atAliasDeclared = false;

  let entries = [];
  try { entries = fs.readdirSync(pkgDir); } catch { return { records, parsedFiles }; }

  // ---- dotenv -------------------------------------------------------------
  for (const name of entries.filter((f) => /^\.env(\..+)?$/.test(f)).sort()) {
    const abs = path.join(pkgDir, name);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const mode = envModeOf(name);
    let line = 0;
    for (const raw of text.split('\n')) {
      line += 1;
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const parsed = parseDotenv(raw);
      for (const kv of parsed) {
        records.push({ kind: 'config', file: rel(abs), line, what: 'env', name: kv.name, value: kv.value, mode });
      }
    }
    out.envFiles.add(rel(abs));
  }

  // ---- vue.config.js / vite.config.* -------------------------------------
  for (const name of ['vue.config.js', 'vue.config.mjs', 'vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    if (!entries.includes(name)) continue;
    const abs = path.join(pkgDir, name);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lang = langOf(name);
    let ast;
    try { ast = parseCode(text, lang); } catch (e) {
      records.push({
        kind: 'parse_error', file: rel(abs),
        line: e && e.loc ? e.loc.line : 1, col: e && e.loc ? e.loc.column : 0,
        message: String(e && e.message ? e.message : e).split('\n')[0],
      });
      parsedFiles.push({ rel: rel(abs), lang, recoveredErrors: 0, failed: true });
      continue;
    }
    parsedFiles.push({ rel: rel(abs), lang, recoveredErrors: (ast.errors || []).length, failed: false });
    const relFile = rel(abs);
    const lineOf = (n) => (n && n.loc ? n.loc.start.line : 1);

    const scan = (n) => {
      if (!n) return;
      if (n.type === 'ObjectProperty') {
        const key = keyName(n);
        if (key === 'proxy' && n.value.type === 'ObjectExpression') {
          records.push(...proxyRecordsOf(n.value, relFile, lineOf));
        }
        if (key === 'alias') {
          if (n.value.type === 'ObjectExpression') {
            for (const p of n.value.properties) {
              if (p.type !== 'ObjectProperty') continue;
              const from = keyName(p);
              const to = firstPathString(p.value);
              if (from === null || to === null) continue;
              records.push({ kind: 'config', file: relFile, line: lineOf(p), what: 'alias', from, to });
              if (from === '@') atAliasDeclared = true;
            }
          } else if (n.value.type === 'ArrayExpression') {
            for (const el of n.value.elements) {
              if (!el || el.type !== 'ObjectExpression') continue;
              const findNode = propOf(el, 'find');
              const replacement = propOf(el, 'replacement');
              const from = findNode && findNode.type === 'StringLiteral' ? findNode.value : null;
              const to = replacement ? firstPathString(replacement) : null;
              if (from === null || to === null) continue;
              records.push({ kind: 'config', file: relFile, line: lineOf(el), what: 'alias', from, to });
              if (from === '@') atAliasDeclared = true;
            }
          }
        }
      }
      // `chainWebpack: (config) => config.resolve.alias.set('@', resolve('src'))`
      if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee) {
        const c = calleeOf(n.callee);
        if (c && c.name === 'set' && c.path.includes('alias') && n.arguments.length >= 2
          && n.arguments[0].type === 'StringLiteral') {
          const to = firstPathString(n.arguments[1]);
          if (to !== null) {
            records.push({
              kind: 'config', file: relFile, line: lineOf(n), what: 'alias',
              from: n.arguments[0].value, to,
            });
            if (n.arguments[0].value === '@') atAliasDeclared = true;
          }
        }
      }
      eachChild(n, scan);
    };
    scan(ast.program);
  }

  // ---- tsconfig.json / jsconfig.json --------------------------------------
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    if (!entries.includes(name)) continue;
    const abs = path.join(pkgDir, name);
    let json;
    try { json = parseJsonc(fs.readFileSync(abs, 'utf8')); } catch { continue; }
    const paths = json && json.compilerOptions && json.compilerOptions.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const key of Object.keys(paths).sort()) {
      const targets = paths[key];
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const from = key.replace(/\/\*$/, '');
      const to = String(targets[0]).replace(/\/\*$/, '').replace(/^\.\//, '');
      records.push({ kind: 'config', file: rel(abs), line: 1, what: 'alias', from, to });
      if (from === '@') atAliasDeclared = true;
    }
  }

  // ---- the assumed alias --------------------------------------------------
  // Nothing declared `@`, and `<pkg>/src` is there. The convention is so nearly
  // universal that leaving it out would lose every import in the project, and
  // so nearly is not always: the record says `assumed`, and the bridge grades
  // what it resolves HEURISTIC.
  //
  // The test is `@` specifically, not "no alias at all": a project can declare
  // an alias of its own for one directory and still rely on the `@` its build
  // tool sets by default, and counting any declaration at all would then drop
  // the one alias every import in the project actually goes through. One of the
  // five frontends measured for this round does exactly that.
  if (!atAliasDeclared && fs.existsSync(path.join(pkgDir, 'src'))) {
    const marker = fs.existsSync(path.join(pkgDir, 'package.json'))
      ? rel(path.join(pkgDir, 'package.json'))
      : rel(pkgDir);
    records.push({ kind: 'config', file: marker, line: 1, what: 'alias', from: '@', to: 'src', assumed: true });
  }

  return { records, parsedFiles };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function isSkippedFileName(name) {
  if (name.endsWith('.d.ts')) return true;
  if (name.endsWith('.min.js')) return true;
  if (/\.(?:test|spec)\./.test(name)) return true;
  return false;
}

/**
 * Every source file under one root.
 *
 * `boundaries` are the two places an OUTPUT directory can legitimately sit: the
 * source root itself, and the package directory it belongs to. A `dist` or a
 * `build` that is a direct child of one of those is output and is skipped; the
 * same name anywhere else is a feature's folder and is walked like any other.
 *
 * @param {string} sourceRoot  absolute
 * @param {Set<string>} found  collects absolute file paths
 * @param {string[]} boundaries  absolute directories where OUTPUT_DIRS apply
 */
function collectFiles(sourceRoot, found, boundaries = [], alsoAccept = () => false) {
  let st;
  try { st = fs.statSync(sourceRoot); } catch { return; }
  if (st.isFile()) {
    if (alsoAccept(sourceRoot)) { found.add(sourceRoot); return; }
    if (EXTENSIONS.some((e) => sourceRoot.endsWith(e)) && !isSkippedFileName(path.basename(sourceRoot))) found.add(sourceRoot);
    return;
  }
  const atBoundary = new Set([sourceRoot, ...boundaries].map((d) => path.resolve(d)));
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name)) continue;
        if (OUTPUT_DIRS.has(e.name) && atBoundary.has(path.resolve(dir))) continue;
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (alsoAccept(abs)) { found.add(abs); continue; }
      if (!EXTENSIONS.some((x) => e.name.endsWith(x))) continue;
      if (isSkippedFileName(e.name)) continue;
      found.add(abs);
    }
  };
  walk(sourceRoot);
}

/**
 * The directory holding the nearest package.json at or above `dir`.
 *
 * THE WALK IS NOT BOUNDED BY `--root`, and that is the whole point. A frontend
 * and its backend are two repositories as often as one, and the analyzed root is
 * then the backend, with `--web-src ../front/src` pointing outside it. Stopping
 * the walk at the root lost that frontend's package.json, its `.env` files, its
 * dev-proxy rules and its path aliases — so every `@/…` import failed to
 * resolve, the client could not be traced, and every match came out HEURISTIC
 * for a reason that has nothing to do with the code. Measured on two of the four
 * pairs this lane was built against: 0 sound matches became 142 and 145.
 *
 * A path above the root is stamped root-relative like any other, so those
 * records simply start with `../` — which is exactly what `--web-src
 * ../front/src` already produces for the source files themselves.
 *
 * A source root with NO package.json anywhere above it is its own package,
 * unchanged.
 */
function packageDirOf(dir) {
  let cur = dir;
  for (;;) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return dir;
    cur = up;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(argv) {
  let root = null;
  // `--configs-only` prints the two things about this lane that are NOT a
  // per-file fact, and PARSES NOTHING:
  //
  //   the package configuration  a `.env` value, a dev-server proxy rule, a path
  //                              alias. Each describes the PACKAGE, so no file's
  //                              shard could hold it honestly and the engine
  //                              never caches them (src/core/incremental.mjs).
  //   the source file LIST       one `sourceFile` record per file this lane
  //                              would read, in the same walk the full run uses.
  //                              It is what lets an incremental run decide, from
  //                              the bytes on disk, which shards still apply —
  //                              including for a frontend that lives in another
  //                              repository, where `git diff` on the analyzed
  //                              root can see nothing at all.
  let configsOnly = false;
  const roots = [];
  // The frontend source roots this project DECLARES, whatever this invocation
  // was asked to read. Repeatable, and used for one thing only: where an HTML
  // template named by a `templateUrl` is looked for.
  const webRoots = [];
  // The TEMPLATE roots this project declares (RM48), each with the engine that
  // renders them and the suffix the view resolver adds to a view name. Passed on
  // every invocation, like `--web-root`: an incremental run is handed changed
  // FILES, and a file only says which view name it answers to relative to its
  // root.
  const templateRoots = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { root = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '--web-root') { webRoots.push(argv[i + 1]); i += 1; continue; }
    if (argv[i] === '--template-root') {
      let spec;
      try { spec = JSON.parse(argv[i + 1]); } catch (e) {
        process.stderr.write(`--template-root must be a JSON object ({"root":…,"engine":…,"suffix":…}): ${e.message}\n`);
        process.exit(2);
      }
      templateRoots.push({
        root: path.resolve(spec.root),
        engine: typeof spec.engine === 'string' ? spec.engine : 'plain-html',
        suffix: typeof spec.suffix === 'string' && spec.suffix !== '' ? spec.suffix : '.html',
      });
      i += 1;
      continue;
    }
    if (argv[i] === '--configs-only') { configsOnly = true; continue; }
    roots.push(argv[i]);
  }
  if (root === null || roots.length === 0) {
    process.stderr.write('usage: node adapters/web/webfacts.mjs [--configs-only] --root <abs root> [--web-root <abs source root>]... [--template-root <json>]... <abs source root or file>...\n');
    process.exit(2);
  }
  root = path.resolve(root);
  const packs = loadPacks(path.join(HERE, 'packs'));

  // Longest root first, so a template root nested inside another wins.
  templateRoots.sort((a, b) => b.root.length - a.root.length || (a.root < b.root ? -1 : 1));
  /** The template root a file belongs to, or null when it is not a template. */
  const templateRootOf = (abs) => {
    for (const t of templateRoots) {
      if (abs !== t.root && !abs.startsWith(t.root + path.sep)) continue;
      if (!abs.endsWith(t.suffix)) continue;
      return t;
    }
    return null;
  };

  // The package directory each source root belongs to, resolved BEFORE the walk:
  // it is one of the two places where a `dist`/`build` really is output.
  const out = { envFiles: new Set() };
  const pkgDirs = new Set();
  const pkgOfRoot = new Map();
  for (const r of roots) {
    const abs = path.resolve(r);
    const pkg = packageDirOf(abs);
    pkgOfRoot.set(abs, pkg);
    pkgDirs.add(pkg);
  }

  const found = new Set();
  const isTemplateFile = (abs) => templateRootOf(abs) !== null;
  for (const r of roots) {
    const abs = path.resolve(r);
    collectFiles(abs, found, [pkgOfRoot.get(abs)], isTemplateFile);
  }

  // ---- where an HTML template is looked for --------------------------------
  //
  // `templateUrl: 'scripts/owner-list/owner-list.template.html'` is a path the
  // SERVER resolves, and the server's root is not the source root: the sources
  // are under `static/scripts` and the url is written from `static`. So each
  // source root and a few directories above it are tried, in a fixed order, and
  // the first file that is there wins.
  //
  // THE BASES COME FROM `--web-root`, NEVER FROM THE TARGETS. A cold run is
  // given the source roots and an incremental one is given the changed FILES,
  // so a list derived from the arguments would put a file's own directory at
  // the front on one run and not on the other, and a `templateUrl` that is a
  // bare file name would then resolve to two different files. The CLI passes
  // the declared roots on every invocation; without the flag the targets are
  // the roots, which is what a hand-run over a directory means.
  const TEMPLATE_BASE_LEVELS = 4;
  const templateBases = [];
  for (const r of (webRoots.length > 0 ? webRoots : roots).map((x) => path.resolve(x)).sort()) {
    let cur = r;
    for (let i = 0; i <= TEMPLATE_BASE_LEVELS; i += 1) {
      if (!templateBases.includes(cur)) templateBases.push(cur);
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  const templateCache = new Map();
  const templateOf = (templateUrl) => {
    const url = String(templateUrl ?? '');
    if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.includes('{') || url.includes('$')) return null;
    if (templateCache.has(url)) return templateCache.get(url);
    let out = null;
    for (const base of templateBases) {
      const abs = path.resolve(base, url.replace(/^\/+/, ''));
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (!stat.isFile() || stat.size > MAX_TEMPLATE_BYTES) continue;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      out = { file: toPosix(path.relative(root, abs)), tags: customElementTags(text) };
      break;
    }
    templateCache.set(url, out);
    return out;
  };

  const configRecords = [];
  const configParsed = [];
  for (const dir of [...pkgDirs].sort()) {
    const res = readPackageConfig(dir, root, out);
    configRecords.push(...res.records);
    configParsed.push(...res.parsedFiles);
  }
  // A config file the walk also picked up (a source root that IS the package
  // directory) must not be read twice.
  for (const p of configParsed) found.delete(path.resolve(root, p.rel));


  const byFile = new Map();
  const push = (rel, rec, line, order) => {
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push({ rec, line, order });
  };

  let files = 0;
  let parseErrors = 0;
  let recoveredErrors = 0;

  // Config files that WERE parsed count as files, like any other source; the
  // dotenv and JSON ones are not parsed by the parser, so they do not.
  for (const p of configParsed) {
    files += 1;
    if (!p.failed) {
      push(p.rel, { kind: 'file', file: p.rel, line: 1, lang: p.lang, recoveredErrors: p.recoveredErrors }, 1, -1);
      recoveredErrors += p.recoveredErrors;
    }
  }
  for (const rec of configRecords) {
    if (rec.kind === 'parse_error') { parseErrors += 1; push(rec.file, rec, rec.line, 0); continue; }
    push(rec.file, rec, rec.line, byFile.has(rec.file) ? byFile.get(rec.file).length : 0);
  }

  const sorted = [...found].sort();
  // `--configs-only` LISTS these files and parses none of them. The list is
  // printed after the config records below, in the same sorted order.
  const sourceList = configsOnly ? sorted.map((abs) => toPosix(path.relative(root, abs))) : [];
  for (const abs of configsOnly ? [] : sorted) {
    const relFile = toPosix(path.relative(root, abs));
    const lang = langOf(abs);
    files += 1;
    let stat;
    try { stat = fs.statSync(abs); } catch { stat = { size: 0 }; }
    if (stat.size > MAX_FILE_BYTES) {
      push(relFile, {
        kind: 'file', file: relFile, line: 1, lang, recoveredErrors: 0, skipped: 'too-large',
      }, 1, -1);
      continue;
    }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
      push(relFile, {
        kind: 'parse_error', file: relFile, line: 1, col: 0,
        message: `cannot read file: ${e.message}`,
      }, 1, 0);
      parseErrors += 1;
      continue;
    }
    const tmpl = templateRootOf(abs);
    const blocks = tmpl !== null
      ? templateScriptBlocks(text, tmpl.engine)
      : lang === 'vue'
        ? vueBlocks(text)
        : [{ code: text, lang, setup: false, lineOffset: 0, line: 1 }];
    const res = analyzeFile({ relFile, blocks, packs, lang: tmpl !== null ? 'js' : lang, templateOf });
    const fileRec = {
      kind: 'file', file: relFile, line: 1,
      lang: tmpl !== null ? 'template' : lang,
      recoveredErrors: res.recoveredErrors,
    };
    if (lang === 'vue' && tmpl === null) {
      fileRec.blocks = blocks.map((b) => ({ lang: b.lang, setup: b.setup, line: b.line }));
    }
    push(relFile, fileRec, 1, -1);
    recoveredErrors += res.recoveredErrors;
    for (const pe of res.parseErrors) {
      push(relFile, { kind: 'parse_error', file: relFile, line: pe.line, col: pe.col, message: pe.message }, pe.line, 0);
      parseErrors += 1;
    }
    if (tmpl !== null) {
      for (const rec of templateRecordsOf({
        abs, relFile, text, root, tmpl, records: res.records, scripts: blocks.length,
      })) {
        push(relFile, rec.rec, rec.line, rec.order);
      }
    }
    for (const r of res.records) push(relFile, r.rec, r.line, r.order);
  }

  // ---- print --------------------------------------------------------------
  const write = [];
  write.push(JSON.stringify({
    kind: 'header', schema: SCHEMA, version: VERSION, root,
    roots: roots.map((r) => toPosix(path.relative(root, path.resolve(r))) || '.').sort(),
    files, parseErrors,
  }));

  const counts = {
    files, parseErrors, recoveredErrors,
    vueFiles: 0, tsFiles: 0, jsFiles: 0, skippedFiles: 0,
    imports: 0, exports: 0, functions: 0, constants: 0, bindings: 0,
    classes: 0, assigns: 0,
    calls: 0, callsWithUrl: 0,
    urlByShape: { literal: 0, template: 0, constant: 0, unresolved: 0 },
    methodBySource: { 'callee-name': 0, config: 0, positional: 0 },
    routes: 0, byPack: {}, aliases: 0, proxies: 0, envRecords: 0,
    envFiles: out.envFiles.size,
    platformSinks: { fetch: 0, xhr: 0, jquery: 0 },
    // The server-rendered pages this run read (RM48): how many template files,
    // how many inline `<script>` blocks went through the JavaScript reader, and
    // how many call sites came out of a form, a link or an include.
    templates: {
      files: 0, byEngine: {}, scripts: 0, forms: 0, links: 0, includes: 0, contextVars: 0,
    },
    // What a frontend written before modules put in the stream (RM47): the
    // names the framework's own registry holds, the templates read for their
    // tags, and the calls that went through a client the framework injected.
    registrations: { component: 0, controller: 0, directive: 0 },
    templatesRead: 0,
    injectedCalls: 0,
  };

  const KIND_RANK = (k) => (k === 'file' ? 0 : 1);
  for (const relFile of [...byFile.keys()].sort()) {
    const recs = byFile.get(relFile).slice().sort((a, b) => (
      a.line - b.line
      || KIND_RANK(a.rec.kind) - KIND_RANK(b.rec.kind)
      || (a.rec.kind < b.rec.kind ? -1 : a.rec.kind > b.rec.kind ? 1 : 0)
      || a.order - b.order
    ));
    for (const { rec } of recs) {
      tally(rec, counts);
      write.push(JSON.stringify(rec));
    }
  }
  for (const file of sourceList) write.push(JSON.stringify({ kind: 'sourceFile', file }));
  write.push(JSON.stringify({
    kind: 'summary', version: VERSION,
    ...(configsOnly ? { configsOnly: true, sourceFiles: sourceList.length } : {}),
    ...counts,
  }));
  process.stdout.write(write.join('\n') + '\n');
}

function tally(rec, counts) {
  switch (rec.kind) {
    case 'file':
      if (rec.lang === 'template') counts.templates.files += 1;
      else if (rec.lang === 'vue') counts.vueFiles += 1;
      else if (rec.lang === 'ts' || rec.lang === 'tsx') counts.tsFiles += 1;
      else counts.jsFiles += 1;
      if (rec.skipped) counts.skippedFiles += 1;
      break;
    case 'template':
      counts.templates.byEngine[rec.engine] = (counts.templates.byEngine[rec.engine] ?? 0) + 1;
      counts.templates.scripts += rec.scripts ?? 0;
      counts.templates.forms += rec.forms ?? 0;
      counts.templates.links += rec.links ?? 0;
      counts.templates.includes += (rec.includes ?? []).length;
      counts.templates.contextVars += (rec.contextVars ?? []).length;
      break;
    case 'import': counts.imports += 1; break;
    case 'export': counts.exports += 1; break;
    case 'function': counts.functions += 1; break;
    case 'constant': counts.constants += 1; break;
    case 'binding': counts.bindings += 1; break;
    case 'class': counts.classes += 1; break;
    case 'assign': counts.assigns += 1; break;
    case 'route':
      counts.routes += 1;
      counts.byPack[rec.pack] = (counts.byPack[rec.pack] ?? 0) + 1;
      if (typeof rec.templateFile === 'string') counts.templatesRead += 1;
      break;
    case 'registration':
      counts.registrations[rec.what] = (counts.registrations[rec.what] ?? 0) + 1;
      if (typeof rec.templateFile === 'string') counts.templatesRead += 1;
      break;
    case 'config':
      if (rec.what === 'alias') counts.aliases += 1;
      else if (rec.what === 'proxy') counts.proxies += 1;
      else if (rec.what === 'env') counts.envRecords += 1;
      break;
    case 'call': {
      counts.calls += 1;
      if (typeof rec.platformSink === 'string') {
        counts.platformSinks[rec.platformSink] = (counts.platformSinks[rec.platformSink] ?? 0) + 1;
      }
      if (rec.injected) counts.injectedCalls += 1;
      if (rec.method && rec.method.from) {
        counts.methodBySource[rec.method.from] = (counts.methodBySource[rec.method.from] ?? 0) + 1;
      }
      if (rec.url) {
        counts.callsWithUrl += 1;
        const first = rec.url.resolved && rec.url.resolved[0];
        if (!first) counts.urlByShape.unresolved += 1;
        else if (first.via === 'literal') counts.urlByShape.literal += 1;
        else if (first.via === 'template') counts.urlByShape.template += 1;
        else counts.urlByShape.constant += 1;
      }
      break;
    }
    default: break;
  }
}

main(process.argv.slice(2));
