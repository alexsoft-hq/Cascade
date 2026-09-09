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

// The two halves of this worker that are not the walk itself. `ast.mjs` is how
// a syntax tree is read; `lib/templates.mjs` is how a server-rendered page is
// read as text. Both were in this file until RM49 and neither has changed.
import {
  calleeOf, eachChild, keyName, propOf, Scope, summarizeArg, toPosix,
} from './lib/ast.mjs';
import { visitCall } from './lib/calls.mjs';
import { emptyCounts, orderRecords, tally } from './lib/emit.mjs';
import {
  bindingOf, declareFunction, hoist, isRequireCall, recordConstant, recordImport, visitArray,
  visitAssignment, visitClass, visitExportDefault, visitExportNamed, visitFunctionBody, visitObject,
  visitVariableDeclaration,
} from './lib/imports.mjs';
import {
  anyPackSeesARoute, chainRoutes, collectModuleLocals, injectionScan,
  registrarRoutes, registrarScan, registrationScan, visitJsx,
} from './lib/routers.mjs';
import {
  customElementTags, MAX_TEMPLATE_BYTES, templateRecordsOf, templateScriptBlocks,
} from './lib/templates.mjs';

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
// Declaration packs (SPEC §18.2)
// ---------------------------------------------------------------------------

function loadPacks(dir) {
  const packs = [];
  let entries;
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

  /**
   * @param {Object} node
   * @param {{scope:Scope, func:Object|null, defaultExport:boolean}} env
   */
  const visit = (node, env) => {
    if (!node) return;
    switch (node.type) {
      case 'ImportDeclaration':
        recordImport(ctx, node);
        return;
      case 'ExportNamedDeclaration':
        visitExportNamed(ctx, node, env);
        return;
      case 'ExportDefaultDeclaration':
        visitExportDefault(ctx, node, env);
        return;
      case 'ExportAllDeclaration':
        emit({
          kind: 'export', file: relFile, line: lineOf(node), name: '*', of: 'reexport',
          source: node.source.value,
        }, lineOf(node));
        return;
      case 'VariableDeclaration':
        visitVariableDeclaration(ctx, node, env, null);
        return;
      case 'FunctionDeclaration': {
        const name = node.id ? node.id.name : 'default';
        const entry = env.func === null ? declareFunction(ctx, node, name, null, env.scope, env) : null;
        visitFunctionBody(ctx, node, env, entry);
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitClass(ctx, node, env, null);
        return;
      case 'TSEnumDeclaration':
        if (env.scope.isModule && node.id) recordConstant(ctx, node.id.name, node, false, lineOf(node));
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        // Reached only as an anonymous expression (a callback, an IIFE): it
        // gets no record of its own and whatever it does is attributed to the
        // nearest enclosing NAMED function.
        visitFunctionBody(ctx, node, env, null);
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression':
        visitCall(ctx, node, env);
        return;
      case 'AssignmentExpression':
        visitAssignment(ctx, node, env);
        return;
      case 'ObjectExpression':
        visitObject(ctx, node, env, false);
        return;
      case 'ArrayExpression':
        visitArray(ctx, node, env);
        return;
      case 'JSXElement':
        visitJsx(ctx, node, env, null);
        return;
      default:
        break;
    }
    eachChild(node, (child) => visit(child, env));
  };

  // THE WALK'S CONTEXT. Everything a rule in `lib/routers.mjs` is allowed to
  // look at, in one object, so a reader can tell at a signature what a rule can
  // reach. `visit` goes in as a lambda because the walk is declared below this
  // line and nothing calls it until the walk starts.
  const ctx = {
    packs,
    st,
    top,
    emit,
    relFile,
    lineOf,
    attachTemplate,
    routeHandled,
    routeObjects,
    declarationCalls,
    injectionTargets,
    injectedClients,
    globalClients,
    moduleScope,
    moduleEnclosing,
    endLineOf,
    columnOf,
    bindingOf: (root, scope, classInfo) => bindingOf(ctx, root, scope, classInfo),
    isRequireCall: (n, env) => isRequireCall(ctx, n, env),
    calleeOf,
    eachChild,
    keyName,
    summarizeArg,
    anyPackSeesARoute,
    visit: (node, env) => visit(node, env),
  };
  hoist(ctx, program.body);
  st.registrarPacks = new Set();
  registrarScan(ctx, program);

  const rootEnv = { scope: moduleScope, func: null, defaultExport: false, classInfo: null, injected: null };
  ctx.moduleLocals = new Set();
  ctx.registrationSpecs = packs.map((p) => p.registrations).filter((r) => r && Array.isArray(r.kinds));
  collectModuleLocals(ctx, program);
  injectionScan(ctx, program);
  chainRoutes(ctx, program);
  registrationScan(ctx, program);
  registrarRoutes(ctx, program, rootEnv);
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
/** `.env`, `.env.development`, `.env.production`: one record per name, per mode. */
function readDotenvFiles({ pkgDir, entries, rel, records, out }) {
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
}

/** `vue.config.js` / `vite.config.*`: the dev-server proxy rules and the path aliases. */
function readBundlerConfig({ pkgDir, entries, rel, records, parsedFiles }) {
  let atAliasDeclared = false;
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
  return atAliasDeclared;
}

/** `tsconfig.json` / `jsconfig.json`: the aliases the type checker resolves by. */
function readTsconfig({ pkgDir, entries, rel, records }) {
  let atAliasDeclared = false;
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
  return atAliasDeclared;
}

/** The one alias nobody declared, and why it is still an alias. */
function assumedAlias({ pkgDir, rel, records, atAliasDeclared }) {
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

}

function readPackageConfig(pkgDir, root, out) {
  const rel = (abs) => toPosix(path.relative(root, abs));
  const records = [];
  const parsedFiles = [];

  let entries;
  try { entries = fs.readdirSync(pkgDir); } catch { return { records, parsedFiles }; }

  readDotenvFiles({ pkgDir, entries, rel, records, out });
  const declaredInBundler = readBundlerConfig({ pkgDir, entries, rel, records, parsedFiles });
  const declaredInTsconfig = readTsconfig({ pkgDir, entries, rel, records });
  assumedAlias({ pkgDir, rel, records, atAliasDeclared: declaredInBundler || declaredInTsconfig });
  return { records, parsedFiles };
}

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

/**
 * The flags this worker takes, read once.
 *
 * `--configs-only` prints the two things about this lane that are NOT a
 * per-file fact, and PARSES NOTHING:
 *
 *   the package configuration  a `.env` value, a dev-server proxy rule, a path
 *                              alias. Each describes the PACKAGE, so no file's
 *                              shard could hold it honestly and the engine
 *                              never caches them (src/core/incremental.mjs).
 *   the source file LIST       one `sourceFile` record per file this lane
 *                              would read, in the same walk the full run uses.
 *                              It is what lets an incremental run decide, from
 *                              the bytes on disk, which shards still apply —
 *                              including for a frontend that lives in another
 *                              repository, where `git diff` on the analyzed
 *                              root can see nothing at all.
 *
 * `--web-root` names the frontend source roots this project DECLARES, whatever
 * this invocation was asked to read; it is used for one thing only, where an
 * HTML template named by a `templateUrl` is looked for. `--template-root` names
 * the TEMPLATE roots (RM48), each with the engine that renders them and the
 * suffix the view resolver adds to a view name. Both are passed on EVERY
 * invocation, because an incremental run is handed changed files and a file
 * only says which view name it answers to relative to its root.
 */
function parseArgs(argv) {
  let root = null;
  let configsOnly = false;
  const roots = [];
  const webRoots = [];
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
  // Longest root first, so a template root nested inside another wins.
  templateRoots.sort((a, b) => b.root.length - a.root.length || (a.root < b.root ? -1 : 1));
  return { root: path.resolve(root), roots, webRoots, templateRoots, configsOnly };
}

/**
 * WHERE AN HTML TEMPLATE IS LOOKED FOR.
 *
 * `templateUrl: 'scripts/owner-list/owner-list.template.html'` is a path the
 * SERVER resolves, and the server's root is not the source root: the sources
 * are under `static/scripts` and the url is written from `static`. So each
 * source root and a few directories above it are tried, in a fixed order, and
 * the first file that is there wins.
 *
 * THE BASES COME FROM `--web-root`, NEVER FROM THE TARGETS. A cold run is given
 * the source roots and an incremental one is given the changed FILES, so a list
 * derived from the arguments would put a file's own directory at the front on
 * one run and not on the other, and a `templateUrl` that is a bare file name
 * would then resolve to two different files. The CLI passes the declared roots
 * on every invocation; without the flag the targets are the roots, which is what
 * a hand-run over a directory means.
 *
 * @returns {{templateRootOf:Function, templateOf:Function}}
 */
function makeTemplateFinder({ root, roots, webRoots, templateRoots }) {
  /** The template root a file belongs to, or null when it is not a template. */
  const templateRootOf = (abs) => {
    for (const t of templateRoots) {
      if (abs !== t.root && !abs.startsWith(t.root + path.sep)) continue;
      if (!abs.endsWith(t.suffix)) continue;
      return t;
    }
    return null;
  };

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
  return { templateRootOf, templateOf };
}

/**
 * ONE source file, read: its `file` record, its parse errors, the records its
 * scripts produced, and — when it is a template — the page's own call sites.
 *
 * `continue` in the original loop is a `return` here, so the counters travel in
 * an object rather than in the enclosing scope.
 */
function analyzeSource(abs, cfg) {
  const { root, packs, templateRootOf, templateOf, push, counts } = cfg;
  const relFile = toPosix(path.relative(root, abs));
  const lang = langOf(abs);
  counts.files += 1;
  let stat;
  try { stat = fs.statSync(abs); } catch { stat = { size: 0 }; }
  if (stat.size > MAX_FILE_BYTES) {
    push(relFile, {
      kind: 'file', file: relFile, line: 1, lang, recoveredErrors: 0, skipped: 'too-large',
    }, 1, -1);
    return;
  }
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) {
    push(relFile, {
      kind: 'parse_error', file: relFile, line: 1, col: 0,
      message: `cannot read file: ${e.message}`,
    }, 1, 0);
    counts.parseErrors += 1;
    return;
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
  counts.recoveredErrors += res.recoveredErrors;
  for (const pe of res.parseErrors) {
    push(relFile, { kind: 'parse_error', file: relFile, line: pe.line, col: pe.col, message: pe.message }, pe.line, 0);
    counts.parseErrors += 1;
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

function main(argv) {
  const { root, roots, webRoots, templateRoots, configsOnly } = parseArgs(argv);
  const { templateRootOf, templateOf } = makeTemplateFinder({ root, roots, webRoots, templateRoots });
  const packs = loadPacks(path.join(HERE, 'packs'));

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
  const tallies = { files, parseErrors, recoveredErrors };
  for (const abs of configsOnly ? [] : sorted) {
    analyzeSource(abs, { root, packs, templateRootOf, templateOf, push, counts: tallies });
  }
  ({ files, parseErrors, recoveredErrors } = tallies);

  // ---- print --------------------------------------------------------------
  const write = [];
  write.push(JSON.stringify({
    kind: 'header', schema: SCHEMA, version: VERSION, root,
    roots: roots.map((r) => toPosix(path.relative(root, path.resolve(r))) || '.').sort(),
    files, parseErrors,
  }));

  const counts = emptyCounts({ files, parseErrors, recoveredErrors, envFiles: out.envFiles.size });

  for (const relFile of [...byFile.keys()].sort()) {
    for (const { rec } of orderRecords(byFile.get(relFile))) {
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

main(process.argv.slice(2));
