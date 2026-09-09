// web_bridge.mjs — turn the web lane's facts (adapters/web/webfacts.mjs, schema
// cascade:webfacts:1) into `symbol --CALLS_HTTP--> endpoint` edges on a graph
// that already holds the routes this pack SERVES (SPEC §8, §9.1, the round trip
// of §1.1 seen from the other end).
//
// It MUTATES a graph the Java bridge has already built, because the question it
// answers is "which of THIS pack's endpoints does this frontend function call?"
// and the endpoints are what the Java bridge put there. Run the SQL bridge,
// then the Java bridge, then this.
//
// The chain it completes (forward; impactOf walks it backward):
//   webFunction --CALLS_HTTP--> endpoint --HANDLES--> handler --MAY_CALL--> …
//     … --IMPLEMENTS_STMT--> statement --WRITES/READS--> column
//
// GRADES — deliberately, honestly (HANDOFF §3):
//  - CALLS_HTTP  SOUND_SET   a platform sink (`fetch`, `XMLHttpRequest`) or an HTTP client
//                            library a declaration pack names, or a WRAPPER traced back to
//                            one, whose URL resolves to a literal or a template, matched to
//                            a route this pack serves.
//  - CALLS_HTTP  HEURISTIC   a URL-shaped argument handed to a call this lane could NOT
//                            trace to a sink, or a call whose prefix, alias or method had to
//                            be assumed. A rule guessed part of it, and the edge says which.
//  - CALLS_HTTP  UNRESOLVED  the URL resolved but no route here answers it, or it names
//                            another host. The edge is below every mode's floor, so no walk
//                            follows it, and the route it names is a node marked `outbound`
//                            exactly as the Java bridge marks a Feign call that leaves.
// A call whose URL never resolved at all (a parameter, an imported constant)
// gets NO edge, and is COUNTED by reason. Nothing is dropped in silence.
//
// WHAT IS NOT IN HERE, on purpose (SPEC §3.4, §6, §18.2): no project name and no
// wrapper name. Real frontends call their HTTP wrapper anything at all, so a
// rule written against one project's spelling is a rule that works on one
// project. The library vocabulary that DOES have fixed names (axios, ky,
// superagent, and which of their methods are verbs) lives in
// adapters/web/packs/http-clients.json, which is a declaration a reader can
// extend without touching this file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeId } from '../core/graph.mjs';
import { gatewayRouteOf } from '../core/profile.mjs';

export const WEBFACTS_SCHEMA = 'cascade:webfacts:1';

/** The extensions a specifier is tried with, in the order a bundler tries them. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

/** How far a resolution walk follows re-exports and aliases before giving up. */
const HOP_LIMIT = 16;

/** How many rounds the wrapper fixpoint runs. Monotone, so it converges long before this. */
const FIXPOINT_LIMIT = 32;

/** The mode whose value wins when two .env files disagree and nothing else decides. */
const PREFERRED_MODE = 'development';

/** Hosts that mean "this machine", so an absolute URL to one is not another deployable. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * The prefix a SERVER-RENDERED PAGE's calls carry: none (RM48).
 *
 * A page writes its paths from the application root — `@{/owners}`,
 * `${request.contextPath}/cart/update` — and the context path is where the
 * deployment is mounted, not part of any route the pack serves. So the prefix
 * is the empty string, and no candidate had to be scored to find that out.
 */
const TEMPLATE_PREFIX = Object.freeze({ value: '', from: 'context-path', front: '', candidates: [] });

/** What each evidence layer actually did, in one sentence, for `evidence.basis`. */
export const WEB_CALL_BASIS = Object.freeze({
  platform: 'the call goes to a browser sink (fetch / XMLHttpRequest), which sends the request itself: the URL argument is the URL by contract, and no rule had to decide that this call is an HTTP call',
  library: 'the callee is an instance of an HTTP client library a declaration pack names (adapters/web/packs/http-clients.json), and the method called is one of that library\'s verbs, so the call sends a request and the URL it sends to is the argument the library reads',
  injected: 'the callee is a client the FRAMEWORK hands the function, named in a declaration pack (adapters/web/packs/http-clients.json) and found by parameter name inside a function the framework fills in. Nothing in the file binds it, so there was nothing to trace: the pack says that parameter is a client and the method called is one of its verbs',
  wrapper: 'the callee was traced through the project\'s own wrapper(s) to a client library instance, by following what each name is BOUND to in its file and what each wrapper forwards. The chain is on the edge; every hop is a binding this lane read, not a name it recognized',
  untraced: 'the argument is URL-shaped but the callee could not be traced to any sink: the call may send this URL or may only build it, so the edge says a rule guessed and the grade is HEURISTIC',
  template: 'the page itself makes this request: a `<form action=…>` posts to it, or a link opens it. The markup names the path and the attribute names the method, so nothing had to be traced and nothing was assumed',
});

/** What each RENDERS edge rested on, in one sentence, for `evidence.basis`. */
export const SCREEN_RENDERS_BASIS = Object.freeze({
  own: 'the route declaration names this file as the screen\'s component, and this function is declared in that file. Nothing was matched by name',
  child: 'the screen\'s component imports this file, directly or through other components, and this function is declared in it. Which of an imported component\'s functions a screen really runs is a run-time question, so the edge is a candidate',
  // RM47. A frontend written before modules resolves nothing by path: the
  // framework keeps a registry of names, and a name is how one thing finds
  // another. So the chain of names IS the resolution, and it is on the edge.
  registry: 'the route names a component, and the framework resolves that name through its own registry to the file that registers it. The chain of names is on the edge, and each link is a string the framework matches exactly, the same way an import names a file',
  ambiguous: 'the same chain of names, with one name registered more than once. Which registration the framework really uses depends on the order the modules load, which is not in the source, so every file that registers the name is a candidate',
  // RM48: a SERVER-RENDERED page's own scripts, and the fragments it pulls in.
  own: 'the inline `<script>` blocks of this page. They are the page: nothing imports them, nothing else runs them, and the file they sit in is the file the handler named',
  include: 'the page pulls this template in (`<%@ include%>`, `<#include>`, `th:replace`), so whatever the fragment does, this page does too. Which branch of the page really reaches the include is a run-time question, so it is a candidate',
});

/** What a RENDERS_PAGE edge and a redirect rest on, in one sentence. */
export const PAGE_RENDERS_BASIS = Object.freeze({
  view: 'the handler returns this view NAME as a literal, and the view resolver joins its configured prefix and suffix onto that literal to find the file. The name is the resolver\'s exact input, so nothing here was matched or guessed',
  constant: 'the handler returns a `static final String` its own class declares, and the field is initialised with this literal on the line above. Both are in one file, so the name is read rather than resolved, and it is the resolver\'s exact input like any other literal',
  helper: 'the handler returns a call to a private method of its own class, and every return of that method is a literal or one of the class\'s own constants. Both are in one file and the method is read one level deep, so a return inside it that is itself a call would have left the page unnamed rather than guessed',
  redirect: 'the handler returns `redirect:` or `forward:` with a path, which sends the browser (or the container) to another route of this same application. It is a call onto that route, matched against the routes this pack serves like any other call',
});

/**
 * A kebab-case element tag as the name a framework registry holds.
 * `owner-list` -> `ownerList`, `visits` -> `visits`.
 * @param {string} tag
 * @returns {string}
 */
export function registryNameOf(tag) {
  return String(tag ?? '').replace(/-+([a-zA-Z0-9])/g, (m, c) => c.toUpperCase());
}

/** What each prefix decision rested on, in one sentence. */
export const WEB_PREFIX_BASIS = Object.freeze({
  declared: 'the profile declares gatewayRoutes, and this front-end prefix maps onto that back-end prefix by declaration',
  derived: 'the base URL was read from the client\'s own configuration (an env value, a literal, an absolute address) and the dev-server proxy rule that explains it was applied',
  auto: 'nothing in the source states the prefix, so every candidate was matched against the routes this pack serves and the one with the most exact hits was chosen. That is a guess, and every edge through it is HEURISTIC',
  none: 'no candidate prefix matched any route this pack serves, so the URL is used as written',
  'context-path': 'the call is written in a server-rendered page, whose paths start at the application root. `${request.contextPath}`, `@{/…}` and `<c:url>` all name that root, and it is not part of any route this pack serves, so the prefix is empty',
});

/** symbol node id for a web function "file#enclosing" (position-independent). */
export function webSymbolId(file, enclosing) {
  return nodeId('symbol', `${file}#${enclosing}`);
}

/** screen node id, keyed by the COMPOSED route path (SPEC §8.1). */
export function webScreenId(pathStr) {
  return nodeId('screen', pathStr);
}

/**
 * The file extensions that make a file a COMPONENT, so a function in it is a
 * function in a screen rather than an api function.
 *
 * A `.ts` / `.js` module that exports a function returning JSX is a component
 * too, and this list does not catch it: the fact stream carries no JSX marker,
 * and inventing one is a change to the worker's schema. The gap is stated in
 * docs/setup/web-lane.md rather than papered over with a name rule.
 */
const COMPONENT_EXTENSIONS = Object.freeze(['.vue', '.tsx', '.jsx']);

/** Whether a root-relative file is a component by its extension. */
export function isComponentFile(file) {
  return COMPONENT_EXTENSIONS.some((e) => String(file).endsWith(e));
}

/**
 * How deep RENDERS follows one component importing another before it stops.
 * A child of a child of a child of a child is still a candidate; past that the
 * claim "this screen renders that function" is not worth making.
 */
const RENDERS_DEPTH = 4;

/**
 * The route paths that mean "this router is filled in by the server".
 *
 * A frontend whose menu comes from an API declares some routes in the source and
 * fetches the rest at run time, so the screens this lane can see are not the app.
 * THE RULE IS THE CALL: a call, resolved to a route this pack serves, whose path
 * ends in one of these. A frontend that really asks the server for its own menu
 * has screens this pack cannot hold, and how many routes it also declares in the
 * source does not change that.
 *
 * It used to need a second half, fewer than THIRTY declared routes, and a big
 * frontend that fetches its menu is server driven exactly as a small one is, so
 * the ceiling survives as the WORDING switch and nothing else: under it, most of
 * the app arrives at run time; over it, what arrives is whatever is beyond the
 * ones declared.
 *
 * WHAT THIS STILL DOES NOT CATCH, measured and left alone: a product whose menu
 * rides on an endpoint that is not spelled like one. The largest frontend in the
 * corpus declares 173 routes, 87 of them the framework's own demo pages, and
 * fetches every business screen at run time from a route named after PERMISSIONS
 * rather than after menus. No suffix here matches it, and adding that project's
 * spelling would be a rule that works on that project (SPEC §3.4).
 */
const SERVER_MENU_SUFFIXES = Object.freeze(['/getRouters', '/menu', '/menus', '/routes', '/nav']);

/** The line between "most screens arrive at run time" and "the ones beyond these do". */
const SERVER_MENU_ROUTE_CEILING = 30;

/** Past this share of unresolved components, the screen axis is degraded. */
export const SCREEN_UNRESOLVED_SHARE = 0.2;

/** The group of a screen whose path has no first segment (`/`). */
export const SCREEN_ROOT_GROUP = '(root)';

/** endpoint node id, keyed by "METHOD path", the same key the Java bridge uses. */
export function webEndpointId(httpMethod, pathStr) {
  return nodeId('endpoint', `${httpMethod} ${pathStr}`);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Weakest link across a call's URL candidates: the lower rank wins. */
const GRADE_RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const HERE = path.dirname(fileURLToPath(import.meta.url));

let PACK_CACHE = null;
/**
 * The HTTP client declaration pack (SPEC §18.2). Read once per process: it is a
 * DECLARATION, so a new library is a row in that file and not a rule in here.
 * @returns {{platform:object[], libraries:object[]}}
 */
export function httpClientPack() {
  if (PACK_CACHE === null) {
    const file = path.join(HERE, '..', '..', 'adapters', 'web', 'packs', 'http-clients.json');
    PACK_CACHE = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return PACK_CACHE;
}

// ---------------------------------------------------------------------------
// Small path helpers. Every path in the fact stream is ROOT-RELATIVE and POSIX,
// whatever the platform, so these never touch node:path's separator rules.
// ---------------------------------------------------------------------------

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function joinPosix(a, b) {
  if (a === '' || a === '.') return normalizePosix(b);
  return normalizePosix(`${a}/${b}`);
}

function normalizePosix(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    // A LEADING `..` is kept. The paths here are relative to the analyzed root,
    // and a frontend checked out beside its backend rather than inside it is
    // `../front/src/...` — dropping the `..` would make every file in it
    // resolve to a path that is not there.
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop(); else out.push('..');
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * A URL path with one leading slash, no doubled slashes and no trailing slash.
 * Exported because the HAR bridge has to key a recorded path exactly the way
 * this bridge keyed the route it is matched against; two spellings of one path
 * would be two nodes.
 */
export function normalizeUrlPath(u) { return normalizeUrl(u); }

/** A URL path with one leading slash, no doubled slashes and no trailing slash. */
function normalizeUrl(u) {
  let s = String(u ?? '');
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * The package a config record belongs to: the directory its file sits in. A
 * record whose `file` has no dot in its last segment IS a directory (the
 * assumed-alias record names the package directory itself when the package has
 * no package.json), so it is its own package.
 */
function configDirOf(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.includes('.') ? dirOf(file) : file;
}

/** The npm package name a bare specifier names: `a/b` -> `a`, `@s/n/x` -> `@s/n`. */
function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/**
 * Whether one ROUTE path template matches one CALL path template.
 *
 * Both sides have holes and they are not the same kind of hole. A route's
 * `{id}`, `{key:.+}` and `*` each stand for ONE segment and `**` for the rest;
 * a call's `{*}` is whatever the code interpolated, which is one whole segment
 * when the segment is nothing but the hole, and part of a segment otherwise
 * (`/thing-{*}.json`). So the comparison is segment by segment, and a hole on
 * either side is satisfied by anything the other side can be.
 *
 * @param {string} routePath  as the pack records it
 * @param {string} callPath   as the web lane resolved it
 * @returns {boolean}
 */
export function routeMatches(routePath, callPath) {
  const r = normalizeUrl(routePath).split('/');
  const c = normalizeUrl(callPath).split('/');
  let i = 0;
  for (; i < r.length; i += 1) {
    const rs = r[i];
    if (rs === '**') return true; // the rest, however many segments it is
    if (i >= c.length) return false;
    const cs = c[i];
    const routeHole = (rs.startsWith('{') && rs.endsWith('}')) || rs === '*';
    if (routeHole) continue; // one segment, whatever it is
    if (rs === cs) continue;
    if (!cs.includes('{*}')) return false;
    // The call segment carries a hole: it matches this literal route segment
    // when its fixed parts line up around it.
    const re = new RegExp(`^${cs.split('{*}').map(escapeRe).join(cs === '{*}' ? '[^/]+' : '[^/]*')}$`);
    if (!re.test(rs)) return false;
  }
  return i === r.length && c.length === r.length;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Add the web lane's CALLS_HTTP edges to a graph that already carries endpoints.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {object[]} webFacts  the whole cascade:webfacts:1 record stream
 * @param {{gatewayRoutes?:object, packages?:object[],
 *          screenAxis?:{enabled?:boolean, codeRegex?:string|null, pathRule?:string|null,
 *                       nameSource?:string}, codeLength?:number|null}} [opts]
 *        screenAxis is the profile's own block, read HERE and nowhere else
 *        (I-5); `enabled` is the gate, and with it false no screen is built.
 *        codeLength is `moduleAttribution.codeLength`, the number of leading
 *        characters of a screen code that name its group.
 * @returns {object} the lane statistics (§F of the round brief)
 */
export function addWebFacts(g, webFacts, opts = {}) {
  const records = Array.isArray(webFacts) ? webFacts : [];
  const gatewayRoutes = opts.gatewayRoutes && typeof opts.gatewayRoutes === 'object' ? opts.gatewayRoutes : {};
  const pack = httpClientPack();
  const libraries = new Map((pack.libraries ?? []).map((l) => [l.module, l]));
  // The clients a FRAMEWORK hands a function rather than a file importing them
  // (RM47). The worker decided which parameter really is one, by the pack's own
  // list and by where the function sits; here the name is looked up again for
  // the verb table and the default method.
  const injectedClients = new Map((pack.injected ?? []).map((c) => [c.name, c]));

  // ---- B1: the indices -----------------------------------------------------
  //
  // Everything is bucketed by FILE and sorted inside its bucket, so the answer
  // does not depend on the order the records arrived in. That is not a nicety:
  // an incremental run assembles the stream from shards, and two assemblies of
  // the same shards must produce the same edges.
  const files = new Map();
  const configs = [];
  const parsed = new Set();
  const fileOf = (name) => {
    let f = files.get(name);
    if (!f) {
      f = {
        imports: [], exports: [], functions: new Map(), constants: new Map(),
        bindings: new Map(), classes: new Map(), assigns: [], calls: [], routes: [],
        registrations: [],
        // The one record a server-rendered page carries about itself (RM48).
        template: null,
        importOf: new Map(),
      };
      files.set(name, f);
    }
    return f;
  };
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.kind !== 'string') continue;
    if (r.kind === 'header' || r.kind === 'summary' || r.kind === 'parse_error') continue;
    if (r.kind === 'config') { configs.push(r); continue; }
    if (typeof r.file !== 'string') continue;
    if (r.kind === 'file') { parsed.add(r.file); fileOf(r.file); continue; }
    const f = fileOf(r.file);
    switch (r.kind) {
      case 'import': f.imports.push(r); break;
      case 'export': f.exports.push(r); break;
      case 'function': f.functions.set(r.name, r); break;
      case 'constant': f.constants.set(r.name, r); break;
      case 'binding': f.bindings.set(r.name, r); break;
      case 'class': f.classes.set(r.name, r); break;
      case 'assign': f.assigns.push(r); break;
      case 'call': f.calls.push(r); break;
      case 'route': f.routes.push(r); break;
      case 'registration': f.registrations.push(r); break;
      case 'template': f.template = r; break;
      default: break;
    }
  }
  const sortKey = (r) => `${String(r.line ?? 0).padStart(9, '0')}|${JSON.stringify(r)}`;
  for (const f of files.values()) {
    f.imports.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    f.exports.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    f.assigns.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    f.calls.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    f.routes.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    f.registrations.sort((a, b) => cmp(sortKey(a), sortKey(b)));
    // The LAST import of a local name is the one in scope, and imports are now
    // in line order, so a later one legitimately shadows an earlier one.
    for (const imp of f.imports) {
      for (const s of imp.specifiers ?? []) f.importOf.set(s.local, { source: imp.source, imported: s.imported });
    }
  }
  const fileNames = [...files.keys()].sort();

  // ---- B1b: the server-rendered pages, before anything reads a call --------
  //
  // A `@Controller` returns a view name and a template engine turns it into a
  // page. The Java worker read the names (`view` records), the web worker read
  // the templates, and this is where the two meet: which template file each name
  // resolves to, which templates a page pulls in, and which of the templates
  // this run read are RENDERED at all.
  //
  // It runs here, before the calls are classified, because it decides two things
  // the call pass needs: a template's URLs are written from the app root, and a
  // template nobody renders is dead markup whose links are nobody's calls.
  const templatesByFile = new Map();
  for (const file of fileNames) {
    const t = files.get(file).template;
    if (t) templatesByFile.set(file, t);
  }
  const templateByName = new Map();
  for (const file of [...templatesByFile.keys()].sort()) {
    const t = templatesByFile.get(file);
    if (typeof t.name === 'string' && t.name !== '' && !templateByName.has(t.name)) templateByName.set(t.name, file);
  }
  /** The template files one template pulls in, directly, in a fixed order. */
  const includedBy = (file) => {
    const t = templatesByFile.get(file);
    if (!t) return [];
    return [...new Set((t.includes ?? [])
      .map((i) => (i && typeof i.file === 'string' ? i.file : null))
      .filter((f) => f !== null && f !== file && templatesByFile.has(f)))].sort();
  };
  /** Every template reachable from one, includes followed, with the depth each was found at. */
  const includeClosure = (file) => {
    const out = new Map();
    let frontier = [file];
    const seen = new Set([file]);
    for (let depth = 1; depth <= RENDERS_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const cur of frontier) {
        for (const child of includedBy(cur)) {
          if (seen.has(child)) continue;
          seen.add(child);
          out.set(child, depth);
          next.push(child);
        }
      }
      frontier = next;
    }
    return out;
  };
  /**
   * The JavaScript names that hold the CONTEXT PATH for one page: the ones its
   * own scripts assign, plus the ones every template it includes assigns. A
   * layout writes `var base_url = '${request.contextPath}'` once and every page
   * that includes it is written against that name.
   */
  const contextVarsCache = new Map();
  const contextVarsFor = (file) => {
    let out = contextVarsCache.get(file);
    if (out) return out;
    out = new Set(templatesByFile.get(file)?.contextVars ?? []);
    for (const other of includeClosure(file).keys()) {
      for (const n of templatesByFile.get(other)?.contextVars ?? []) out.add(n);
    }
    contextVarsCache.set(file, out);
    return out;
  };

  const viewRecords = (opts.views ?? [])
    .filter((v) => v && typeof v === 'object' && typeof v.owner === 'string' && typeof v.method === 'string')
    .slice()
    .sort((a, b) => cmp(a.owner, b.owner) || cmp(a.method, b.method) || (a.paramCount ?? 0) - (b.paramCount ?? 0));
  // Every template a handler names, and every template one of those includes.
  // A template outside that set is a fragment nobody pulls in or a page nobody
  // serves: it is COUNTED, and its links are not somebody's calls.
  const renderedTemplates = new Set();
  for (const v of viewRecords) {
    for (const view of v.views ?? []) {
      if (!view || view.kind !== 'view') continue;
      const file = templateByName.get(String(view.name ?? '').replace(/^\/+/, ''));
      if (file === undefined) continue;
      renderedTemplates.add(file);
      for (const other of includeClosure(file).keys()) renderedTemplates.add(other);
    }
  }

  // ---- packages, and what each one declares --------------------------------
  const packageDirs = new Set();
  for (const p of opts.packages ?? []) {
    // discovery names the package.json, and the package is the directory it sits in.
    if (p && typeof p.path === 'string') packageDirs.add(configDirOf(normalizePosix(p.path)));
  }
  for (const c of configs) packageDirs.add(configDirOf(c.file));
  if (packageDirs.size === 0) packageDirs.add('');
  const sortedPackages = [...packageDirs].sort((a, b) => b.length - a.length || cmp(a, b));
  const packageOf = (file) => {
    for (const d of sortedPackages) {
      if (d === '' || file === d || file.startsWith(`${d}/`)) return d;
    }
    return '';
  };
  const pkgConfig = new Map();
  const configFor = (dir) => {
    let c = pkgConfig.get(dir);
    if (!c) { c = { env: new Map(), proxies: [], aliases: [], axiosBaseUrl: null }; pkgConfig.set(dir, c); }
    return c;
  };
  for (const d of packageDirs) configFor(d);
  for (const c of configs.slice().sort((a, b) => cmp(sortKey(a), sortKey(b)))) {
    const dir = configDirOf(c.file);
    const cfg = configFor(packageDirs.has(dir) ? dir : packageOf(c.file));
    if (c.what === 'env') {
      if (!cfg.env.has(c.name)) cfg.env.set(c.name, []);
      cfg.env.get(c.name).push({ value: c.value, mode: c.mode ?? null, file: c.file });
    } else if (c.what === 'proxy') cfg.proxies.push(c);
    else if (c.what === 'alias') cfg.aliases.push(c);
    else if (c.what === 'axios-defaults' && c.key === 'baseURL') cfg.axiosBaseUrl = c.value ?? null;
  }
  for (const cfg of pkgConfig.values()) {
    // The longest context first: `/api/v2` must win over `/api`.
    cfg.proxies.sort((a, b) => b.context.length - a.context.length || cmp(a.context, b.context));
    cfg.aliases.sort((a, b) => b.from.length - a.from.length || cmp(a.from, b.from));
  }

  const stats = {
    instances: 0,
    wrappers: { count: 0, maxDepth: 0, byKind: { function: 0, classMethod: 0 } },
    // `notUrlShaped` is the fifth number the round's shape did not ask for and
    // the lane cannot honestly leave out: a call the worker recorded as
    // carrying a URL, that reached no client and whose argument is not written
    // like a path. Counted here so it is never a silent drop.
    calls: {
      withUrl: 0, traced: 0, platform: 0, injected: 0, untraced: 0, notUrlShaped: 0,
      // A form or a link in a server-rendered page (RM48).
      template: 0,
      // A call onto an imported name that is not a function this lane read: a
      // constant, a component, a client instance. No CALLS edge, and counted so
      // the missing hop is a number rather than a silence.
      notAFunction: 0,
      // A function handed to a call as a VALUE that resolved to a function this
      // lane read (RM32). Counted per REFERENCE, which is not the number of
      // edges: two references from one function to the same target are one
      // edge, a pair that is also CALLED keeps the call's edge, and an edge
      // whose ends never reach HTTP is left out by the rule below. Read it
      // beside `callsByRule['passed-as-value']`, which counts what was placed.
      passedAsValue: 0,
    },
    resolved: { SOUND_SET: 0, HEURISTIC: 0 },
    unresolved: {
      total: 0,
      // `allHoles` is the sixth reason the round's shape did not ask for and the
      // lane cannot honestly leave out: a URL that resolved to nothing but
      // interpolations. It is not `noMatch` (it matches far too much) and not
      // `expression` (the worker did resolve it), so it is counted as itself.
      byReason: {
        parameter: 0, expression: 0, importedConstant: 0, noMatch: 0, outsidePack: 0, allHoles: 0,
      },
    },
    matches: { exact: 0, template: 0, multi: 0 },
    outboundEndpoints: 0,
    prefix: {},
    assumedAliases: 0,
    // The URLs nothing here answers, most common first. A count alone cannot be
    // acted on; this is the list a reader fixes a prefix or a missing module by.
    unmatchedUrls: [],
    // ---- the screen axis (RM30) --------------------------------------------
    // `declared` counts ROUTE DECLARATIONS that compose to a screen; `screens`
    // counts the nodes, which is smaller when two declarations compose to the
    // same path. Both are here because a reader comparing them is asking a real
    // question ("why are there fewer screens than routes?").
    screens: {
      declared: 0,
      screens: 0,
      withComponent: 0,
      componentUnresolved: 0,
      duplicatePaths: 0,
      hidden: 0,
      withParams: 0,
      // The specifiers that failed, most common first: the list a reader adds an
      // alias or a missing source root by.
      unresolvedSpecifiers: [],
      // The framework NAMES a screen's component in a frontend written before
      // modules, and a name that nothing registers is the same kind of gap as a
      // specifier that resolves to no file. Counted the same way, and listed so
      // a reader can see which name it was.
      unresolvedNames: [],
      renders: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 },
      // The rule of SERVER_MENU_SUFFIXES, and the numbers behind whichever way
      // it went, so a reader can check it rather than take it. `detectedBy`
      // names what fired it, so a later rule cannot be mistaken for this one.
      serverDriven: {
        detected: false, detectedBy: null, routes: 0,
        ceiling: SERVER_MENU_ROUTE_CEILING, menuEndpoints: [],
      },
      // What the profile asked for and what was used. `nameSource` is refused
      // when it asks for a source this engine does not read.
      nameSource: { asked: 'none', used: 'none', refused: null },
      pathRule: null,
      codeRegex: null,
      codeLength: null,
      enabled: false,
      // A screen is a router declaration or a SERVER-RENDERED PAGE (RM48), and
      // a hybrid application has both. Counted apart, because they are found by
      // two different routes and a reader comparing them is asking a real
      // question.
      byKind: { router: 0, page: 0 },
    },
    // The server-rendered pages: how many templates this run read, how many of
    // them a handler names, and what the view names that resolved to nothing
    // were. `unrendered` is the honest other half — a fragment nobody pulls in
    // or a page nobody serves, whose links are nobody's calls.
    templates: {
      files: 0, byEngine: {}, rendered: 0, unrendered: 0, includes: 0,
      views: 0, viewNames: 0, redirects: 0, unresolvedViews: 0,
      // View names that resolved to no template this run read, counted by
      // OCCURRENCE. `viewNames` counts occurrences too and `byKind.page` counts
      // distinct pages, so the two can never be subtracted from one another:
      // four handlers naming one page are four names and one screen.
      viewNamesUnplaced: 0,
      unresolvedViewNames: [],
    },
    // The frontend's own call graph: how many functions send a request, how many
    // only lead to one, and how many nodes that adds up to. Everything else is
    // left out on purpose, so a pack does not double in size for utility code.
    functions: { withHttp: 0, reachingHttp: 0, created: 0 },
    callsEdges: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 },
    // The same edges by the RULE that found them, so a reader can tell a call
    // this lane followed from a function that was only handed over as a value.
    // A grade alone cannot: both can be SOUND_SET, for different reasons.
    callsByRule: { 'same-file': 0, 'esm-import': 0, 'passed-as-value': 0 },
  };

  // ---- B2: module resolution ----------------------------------------------
  const resolveSpecifier = (fromFile, spec) => {
    if (typeof spec !== 'string' || spec === '') return { unresolved: 'empty-specifier' };
    let target = null;
    let assumed = false;
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      target = joinPosix(dirOf(fromFile), spec);
    } else {
      const cfg = configFor(packageOf(fromFile));
      const pkgDir = packageOf(fromFile);
      for (const a of cfg.aliases) {
        const from = a.from.endsWith('/') ? a.from.slice(0, -1) : a.from;
        if (spec !== from && !spec.startsWith(`${from}/`)) continue;
        const rest = spec.slice(from.length);
        target = normalizePosix(`${joinPosix(pkgDir, a.to)}${rest}`);
        assumed = a.assumed === true;
        break;
      }
      if (target === null) return { external: packageNameOf(spec) };
    }
    const candidates = [target];
    for (const e of EXTENSIONS) candidates.push(`${target}${e}`);
    for (const e of EXTENSIONS) candidates.push(`${target}/index${e}`);
    for (const c of candidates) if (parsed.has(c)) return { file: c, assumed };
    return { unresolved: 'not-a-file-this-lane-read', assumed };
  };

  /**
   * WHERE A LOCAL NAME COMES FROM: the file that declares it, or the package it
   * is imported from. `assumed` rides along when an assumed alias was on the
   * path, because everything that rests on a guessed alias is graded down.
   */
  const resolveExport = (file, name, depth) => {
    if (depth > HOP_LIMIT) return null;
    const f = files.get(file);
    if (!f) return null;
    let assumed = false;
    for (const e of f.exports) {
      if (e.name !== name) continue;
      if (e.of === 'reexport' && e.source) {
        const r = resolveSpecifier(file, e.source);
        assumed = assumed || r.assumed === true;
        if (r.external) return { external: r.external, assumed };
        if (!r.file) continue;
        const hit = resolveExport(r.file, name, depth + 1);
        if (hit) return { ...hit, assumed: assumed || hit.assumed };
        continue;
      }
      const local = e.local ?? name;
      const hit = resolveLocal(file, local, depth + 1);
      if (hit) return { ...hit, assumed: assumed || hit.assumed };
      return { file, name: local, assumed, viaStar: false };
    }
    // `export * from './x'`: every named target is followed, first hit in path
    // order. Which one is a real decision, so it is DISCLOSED on the edge.
    const stars = f.exports.filter((e) => e.of === 'reexport' && e.name === '*' && e.source)
      .map((e) => e.source).sort();
    for (const src of stars) {
      const r = resolveSpecifier(file, src);
      if (!r.file) continue;
      const hit = resolveExport(r.file, name, depth + 1);
      if (hit) return { ...hit, assumed: assumed || hit.assumed || r.assumed === true, viaStar: true };
    }
    return null;
  };

  const resolveLocal = (file, name, depth) => {
    if (depth > HOP_LIMIT) return null;
    const f = files.get(file);
    if (!f) return null;
    if (f.bindings.has(name) || f.functions.has(name) || f.classes.has(name) || f.constants.has(name)) {
      return { file, name, assumed: false, viaStar: false };
    }
    const imp = f.importOf.get(name);
    if (!imp) return null;
    const r = resolveSpecifier(file, imp.source);
    if (r.external) return { external: r.external, assumed: r.assumed === true, viaStar: false };
    if (!r.file) return null;
    if (imp.imported === '*') return { file: r.file, namespace: true, assumed: r.assumed === true, viaStar: false };
    const hit = resolveExport(r.file, imp.imported, depth + 1);
    if (!hit) return null;
    return { ...hit, assumed: hit.assumed || r.assumed === true };
  };

  // ---- B4: what a name IS ---------------------------------------------------
  //
  // One memoised walk answers every question below: is this name an HTTP client
  // instance, an instance of a class the project wrote, a function, or a module
  // this analysis never read? The memo is keyed by `file#name`, and a name being
  // resolved already is a cycle, so it answers null.
  const VALUE = new Map();
  const valueOf = (file, name, depth) => {
    const key = `${file}#${name}`;
    if (VALUE.has(key)) return VALUE.get(key);
    if (depth > HOP_LIMIT) return null;
    VALUE.set(key, null);
    const f = files.get(file);
    let out = null;
    if (f) {
      if (f.classes.has(name)) out = { kind: 'class', key, file, name, assumed: false, viaStar: false };
      else if (f.bindings.has(name)) {
        const v = initValue(file, f.bindings.get(name).init, depth + 1);
        if (v && v.kind === 'sink-instance') out = { ...v, id: key };
        else out = v;
      } else if (f.functions.has(name)) out = { kind: 'function', key, file, name, assumed: false, viaStar: false };
    }
    VALUE.set(key, out);
    return out;
  };

  /** The value a `this.<field>` names inside a class: the field's last assignment. */
  const FIELD = new Map();
  const fieldValue = (file, className, field, depth) => {
    const key = `${file}#${className}.${field}`;
    if (FIELD.has(key)) return FIELD.get(key);
    FIELD.set(key, null);
    const f = files.get(file);
    let out = null;
    if (f) {
      for (const a of f.assigns) {
        if (a.class !== className || a.field !== field) continue;
        const v = initValue(file, a.init, depth + 1);
        if (v && v.kind === 'sink-instance') out = { ...v, id: key };
        else if (v) out = v;
      }
    }
    FIELD.set(key, out);
    return out;
  };

  /** What the ROOT of a callee names, before the member path is applied. */
  const rootValue = (file, callee, binding, depth) => {
    if (!callee || typeof callee.root !== 'string') return null;
    if (binding && binding.kind === 'this') return { kind: 'this', className: binding.class ?? null };
    if (binding && binding.kind === 'global') return null;
    const r = resolveLocal(file, callee.root, depth);
    if (!r) return null;
    if (r.external) return { kind: 'external', module: r.external, assumed: r.assumed === true, viaStar: false };
    if (r.namespace) return { kind: 'namespace', file: r.file, assumed: r.assumed === true, viaStar: r.viaStar === true };
    const v = valueOf(r.file, r.name, depth + 1);
    if (!v) return null;
    return {
      ...v,
      assumed: (v.assumed === true) || r.assumed === true,
      viaStar: (v.viaStar === true) || r.viaStar === true,
    };
  };

  /** What an `init` record (a const, a class field, a return) evaluates to. */
  const initValue = (file, init, depth) => {
    if (!init || !init.callee || depth > HOP_LIMIT) return null;
    const root = rootValue(file, init.callee, init.binding, depth);
    if (root === null) return null;
    const pathParts = init.callee.path ?? [];
    const last = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
    const carry = (v) => ({
      ...v,
      assumed: (v.assumed === true) || (root.assumed === true),
      viaStar: (v.viaStar === true) || (root.viaStar === true),
    });
    if (root.kind === 'external' || root.kind === 'namespace') {
      const module = root.kind === 'external' ? root.module : null;
      const lib = module ? libraries.get(module) : null;
      if (lib && init.shape === 'call' && last && (lib.instanceFactories ?? []).includes(last)) {
        return carry({ kind: 'sink-instance', module: lib.module, baseURL: init.baseURL ?? null });
      }
      return carry({ kind: 'external', module });
    }
    if (root.kind === 'this') {
      if (pathParts.length !== 1 || !root.className) return null;
      const v = fieldValue(file, root.className, pathParts[0], depth + 1);
      return v ? carry(v) : null;
    }
    if (init.shape === 'new') {
      return root.kind === 'class' ? carry({ kind: 'class-instance', key: root.key }) : null;
    }
    if (init.shape === 'call') {
      // A FACTORY: the value is whatever the function it calls hands back.
      if (root.kind !== 'function') return null;
      const fn = files.get(root.file)?.functions.get(root.name);
      if (!fn || !fn.returns) return null;
      const v = initValue(root.file, fn.returns, depth + 1);
      return v && (v.kind === 'class-instance' || v.kind === 'sink-instance') ? carry(v) : null;
    }
    // `const a = b` / `const a = b.c`: a is whatever b already was.
    if (pathParts.length === 0) return carry(root);
    if (root.kind === 'class-instance') return null;
    return null;
  };

  // ---- the instances this project builds ------------------------------------
  const instanceOf = new Map(); // instance id -> {id, module, baseURL, package}
  const noteInstance = (v, pkg) => {
    if (!v || v.kind !== 'sink-instance' || !v.id) return v;
    if (!instanceOf.has(v.id)) {
      instanceOf.set(v.id, { id: v.id, module: v.module, baseURL: v.baseURL ?? null, package: pkg });
    }
    return v;
  };
  for (const file of fileNames) {
    const f = files.get(file);
    const pkg = packageOf(file);
    for (const name of [...f.bindings.keys()].sort()) noteInstance(valueOf(file, name, 0), pkg);
    for (const a of f.assigns) noteInstance(fieldValue(file, a.class, a.field, 0), pkg);
  }

  // ---- what a CALL's callee resolves to -------------------------------------
  //
  // Four answers, and the grade of the edge follows from which one it is:
  //   sink      the callee IS a client instance or a platform sink
  //   member    the callee is a function/method of this project (maybe a wrapper)
  //   external  the callee comes from a package this analysis never read
  //   null      nothing here explains it
  const calleeTarget = (file, call) => {
    const callee = call.callee ?? null;
    if (!callee) return null;
    const pathParts = callee.path ?? [];
    const binding = call.binding ?? null;
    if (binding && binding.kind === 'this') {
      const className = binding.class ?? null;
      if (!className) return null;
      if (pathParts.length === 1) {
        return { kind: 'member', key: `${file}#${className}.${pathParts[0]}`, assumed: false, viaStar: false };
      }
      if (pathParts.length >= 2) {
        const v = fieldValue(file, className, pathParts[0], 0);
        if (v && v.kind === 'sink-instance') {
          return { kind: 'sink', instance: v, method: pathParts[1], assumed: v.assumed === true, viaStar: v.viaStar === true };
        }
        if (v && v.kind === 'class-instance') {
          const at = v.key.lastIndexOf('#');
          return {
            kind: 'member', key: `${v.key.slice(0, at)}#${v.key.slice(at + 1)}.${pathParts[1]}`,
            assumed: v.assumed === true, viaStar: v.viaStar === true,
          };
        }
      }
      return null;
    }
    const root = rootValue(file, callee, binding, 0);
    if (root === null) return null;
    const flags = { assumed: root.assumed === true, viaStar: root.viaStar === true };
    if (root.kind === 'external' || root.kind === 'namespace') {
      const module = root.kind === 'external' ? root.module : null;
      const lib = module ? libraries.get(module) : null;
      if (lib && pathParts.length <= 1) {
        return {
          kind: 'sink',
          instance: { kind: 'sink-instance', module: lib.module, baseURL: null, id: `${packageOf(file)}#(module ${lib.module})` },
          method: pathParts.length === 1 ? pathParts[0] : null,
          ...flags,
        };
      }
      return { kind: 'external', module, ...flags };
    }
    if (root.kind === 'sink-instance' && pathParts.length <= 1) {
      return { kind: 'sink', instance: root, method: pathParts.length === 1 ? pathParts[0] : null, ...flags };
    }
    if (root.kind === 'class-instance' && pathParts.length === 1) {
      const at = root.key.lastIndexOf('#');
      return { kind: 'member', key: `${root.key.slice(0, at)}#${root.key.slice(at + 1)}.${pathParts[0]}`, ...flags };
    }
    if (root.kind === 'function' && pathParts.length === 0) {
      return { kind: 'member', key: root.key, ...flags };
    }
    return null;
  };

  /** Whether a sink instance really is being CALLED here, per its library's vocabulary. */
  const sinkVerb = (target) => {
    const lib = libraries.get(target.instance.module);
    if (!lib) return null;
    const name = target.method;
    if (name === null) {
      return (lib.generic ?? []).includes('(call)') ? { verb: null, generic: true } : null;
    }
    const verbs = lib.verbs ?? {};
    if (Object.prototype.hasOwnProperty.call(verbs, name)) return { verb: verbs[name], generic: false };
    if ((lib.generic ?? []).includes(name)) return { verb: null, generic: true };
    return null;
  };

  /** The instance a platform sink belongs to: none. The URL is the URL. */
  const platformOf = (call) => {
    if (!call.platformSink) return null;
    return (pack.platform ?? []).find((p) => p.name === call.platformSink) ?? { name: call.platformSink };
  };

  // ---- B4: the wrapper fixpoint --------------------------------------------
  //
  // A WRAPPER is a function that hands a request on without knowing which one:
  // it contains a call to a sink (or to another wrapper) whose URL argument is
  // NOT a literal of its own. A function whose inner call spells the URL out is
  // an API function, and it is the thing that gets a node and an edge.
  const memberKeys = [];
  const memberRec = new Map();
  for (const file of fileNames) {
    for (const [name, rec] of files.get(file).functions) {
      const key = `${file}#${name}`;
      memberKeys.push(key);
      memberRec.set(key, { file, name, rec });
    }
  }
  memberKeys.sort();
  const callsIn = new Map(); // member key -> call records
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      const key = `${file}#${c.enclosing}`;
      if (!callsIn.has(key)) callsIn.set(key, []);
      callsIn.get(key).push(c);
    }
  }
  /** Whether a call spells its own URL out, which is what makes its caller an API function. */
  const hasOwnUrl = (c) => !!(c.url && Array.isArray(c.url.resolved) && c.url.resolved.length > 0);

  /**
   * A URL TEMPLATE THAT IS NOTHING BUT HOLES NAMES NO ROUTE.
   *
   * `` `/${a}/${b}/${c}` `` resolves to `/{*}/{*}/{*}`, which matches every
   * three-segment route this pack serves: on the largest frontend measured for
   * this round that is 413 of them,
   * from ONE call site. Those are not 413 facts, they are one absence, and
   * writing them would put 5 000 edges in the pack and tell every three-segment
   * route that hundreds of screens call it. So a template with no literal
   * segment left in it is counted as unresolved and gets no edge; the count
   * says how many, and the URL is in the unmatched list under its own reason.
   */
  // A SEGMENT is evidence when text survives taking its holes out: `pre{*}` is,
  // `{*}` is not, and neither is `{*}{*}` (two interpolations written next to
  // each other, which is still nothing but interpolation).
  const namesARoute = (template) => normalizeUrl(template).split('/').slice(1)
    .some((seg) => seg.split('{*}').join('') !== '');

  /**
   * Whether a resolved URL is WRITTEN like one: a leading slash, or an absolute
   * address. A URL that never resolved is kept (its shape is unknown, and it is
   * counted by reason further down); one that resolved to a bare word is not.
   */
  const urlShaped = (c, resolved) => {
    if (c.url.absolute) return true;
    if (!Array.isArray(resolved)) return true;
    return resolved.some((r) => typeof r.template === 'string' && r.template.startsWith('/'));
  };

  /**
   * A page's URL candidates with the CONTEXT PATH taken off the front.
   *
   * `base_url + '/jobinfo/pageList'` resolves to `{*}/jobinfo/pageList` in the
   * worker, because the file it is written in does not assign `base_url` — the
   * layout it includes does. Only here is the include graph known, so only here
   * can the hole be recognised as the app root and removed. The result is the
   * path the server sees, and everything downstream reads it as one.
   */
  const withContextPath = (call, contextVars) => {
    const resolved = Array.isArray(call.url.resolved) ? call.url.resolved : null;
    if (resolved === null || contextVars === null) return resolved;
    if (typeof call.url.base !== 'string' || !contextVars.has(call.url.base)) return resolved;
    return resolved.map((r) => (typeof r.template === 'string' && r.template.startsWith('{*}')
      ? { ...r, template: r.template.slice(3), dynamicParts: Math.max(0, (r.dynamicParts ?? 1) - 1) }
      : r));
  };

  const wrappers = new Map(); // key -> {depth, next, sink}
  const wrapperStep = (key) => {
    const m = memberRec.get(key);
    if (!m) return null;
    let best = null;
    const consider = (cand) => {
      if (!cand) return;
      if (best === null || cand.depth < best.depth || (cand.depth === best.depth && cmp(cand.next ?? '', best.next ?? '') < 0)) best = cand;
    };
    for (const c of callsIn.get(key) ?? []) {
      if (hasOwnUrl(c)) continue;
      const t = calleeTarget(m.file, c);
      if (!t) continue;
      if (t.kind === 'sink') {
        const v = sinkVerb(t);
        if (!v) continue;
        consider({ depth: 1, next: null, sink: { module: t.instance.module, instance: t.instance.id ?? null, kind: 'library' }, call: c });
      } else if (t.kind === 'member' && t.key !== key) {
        const w = wrappers.get(t.key);
        if (!w) continue;
        consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call: c });
      }
      if (c.platformSink) {
        consider({ depth: 1, next: null, sink: { module: c.platformSink, instance: null, kind: 'platform' }, call: c });
      }
    }
    // `get(config) { return this.request({ …config, method: 'GET' }) }` is the
    // same hop written as a return, and a body with no call record left (an
    // arrow that IS the call) is only visible this way.
    const ret = m.rec.returns ?? null;
    if (ret && ret.callee) {
      const t = calleeTarget(m.file, { callee: ret.callee, binding: ret.binding ?? null });
      if (t && t.kind === 'member' && t.key !== key) {
        const w = wrappers.get(t.key);
        if (w) consider({ depth: 1 + w.depth, next: t.key, sink: w.sink, call: null });
      }
    }
    return best;
  };
  for (let round = 0; round < FIXPOINT_LIMIT; round += 1) {
    let changed = false;
    for (const key of memberKeys) {
      const next = wrapperStep(key);
      if (next === null) continue;
      const prev = wrappers.get(key);
      if (!prev || prev.depth !== next.depth || prev.next !== next.next) { wrappers.set(key, next); changed = true; }
    }
    if (!changed) break;
  }
  stats.wrappers.count = wrappers.size;
  for (const [key, w] of wrappers) {
    stats.wrappers.maxDepth = Math.max(stats.wrappers.maxDepth, w.depth);
    const name = key.slice(key.lastIndexOf('#') + 1);
    if (name.includes('.')) stats.wrappers.byKind.classMethod += 1; else stats.wrappers.byKind.function += 1;
  }
  stats.instances = instanceOf.size;

  // ---- B5: the prefix per instance -----------------------------------------
  /**
   * ONE env name read across every mode the project declares.
   *
   * The modes DISAGREE more often than not. Two shapes, both measured on the
   * frontends this round was built against:
   *
   *   - `/dev-api`, `/prod-api` and `/stage-api` for the same variable: three
   *     real prefixes, and exactly one of them has a dev-proxy rule explaining
   *     it. That one is the one this analysis can follow to a route, so it wins.
   *   - a relative path for development and two absolute addresses for the two
   *     deployments, all three ending in the SAME path. Compared as strings
   *     those disagree; compared as PATHS they are one value, which is what
   *     they are. So the comparison is on paths.
   *
   * Only when neither settles it is the answer ambiguous, and the auto step
   * takes over.
   */
  const envValue = (pkg, name) => {
    const rows = configFor(pkg).env.get(name) ?? [];
    if (rows.length === 0) return { value: null, values: [], ambiguous: false };
    const values = [...new Set(rows.map((r) => absoluteSplit(r.value).value))].sort();
    if (values.length === 1) return { value: values[0], values, ambiguous: false };
    const cfg = configFor(pkg);
    const explained = values.filter((v) => v !== '' && cfg.proxies.some((p) => v === p.context || v.startsWith(p.context)));
    if (explained.length === 1) return { value: explained[0], values, ambiguous: false };
    const byMode = (m) => rows.find((r) => r.mode === m);
    const chosen = byMode(PREFERRED_MODE)
      ?? rows.slice().sort((a, b) => cmp(a.mode ?? '', b.mode ?? '') || cmp(a.file, b.file))[0];
    return { value: absoluteSplit(chosen.value).value, values, ambiguous: true };
  };

  /**
   * A base-URL summary read down to a string, in THREE states that must not be
   * confused with each other:
   *
   *   absent   the client declares no base URL and the package declares no
   *            axios default. That is not an unknown: a client with no base URL
   *            sends the path as written, which is a prefix of ''. Calling it a
   *            guess would grade every `fetch('/health')` in the corpus
   *            HEURISTIC for a fact the library documents.
   *   known    the value was read (a literal, an env value, an absolute address).
   *   unknown  a base URL IS declared and this lane could not read it: an env
   *            name with no .env record, a template with a hole in it, an
   *            expression. THAT is what the auto step exists for.
   */
  const baseUrlValue = (summary, pkg) => {
    if (!summary) return { state: 'absent', value: '', values: [''], absolute: false, ambiguous: false };
    if (summary.kind === 'string') return absoluteSplit(summary.value);
    if (summary.kind === 'template' && (summary.dynamicParts ?? 0) === 0) return absoluteSplit(summary.template);
    if (summary.kind === 'member' && Array.isArray(summary.path) && summary.path.length >= 2
      && summary.path[0] === 'env' && (summary.root === 'process' || summary.root === 'import.meta')) {
      const e = envValue(pkg, summary.path[1]);
      if (e.value === null) return { state: 'unknown', value: '', values: [''], absolute: false, ambiguous: false };
      // `absolute` is false here even when the env value was an absolute
      // address: `envValue` already reduced every value to its PATH, so what
      // comes back is a path and the proxy rules apply to it like any other.
      return {
        state: 'known', value: e.value, values: e.values, absolute: false, ambiguous: e.ambiguous,
      };
    }
    return { state: 'unknown', value: '', values: [''], absolute: false, ambiguous: false };
  };

  const absoluteSplit = (raw) => {
    const m = /^(https?:)?\/\/([^/]+)(\/.*)?$/.exec(String(raw ?? ''));
    if (m) {
      const v = normalizeTail(m[3] ?? '');
      return { state: 'known', value: v, values: [v], absolute: true, ambiguous: false, host: m[2] };
    }
    const v = normalizeTail(String(raw ?? ''));
    return { state: 'known', value: v, values: [v], absolute: false, ambiguous: false };
  };
  const normalizeTail = (v) => {
    let s = String(v ?? '').trim();
    if (s === '' || s === '/') return '';
    if (!s.startsWith('/')) s = `/${s}`;
    return s.endsWith('/') ? s.slice(0, -1) : s;
  };

  /** The proxy rule that explains a relative base URL, and what it leaves. */
  const throughProxy = (value, pkg) => {
    if (value === '') return { value: '', ok: true };
    const cfg = configFor(pkg);
    const rule = cfg.proxies.find((p) => value === p.context || value.startsWith(p.context));
    if (!rule) return { ok: false, reason: 'no-proxy-rule' };
    if (rule.rewrite === 'opaque') return { ok: false, reason: 'opaque-rewrite' };
    if (!Array.isArray(rule.rewrite) || rule.rewrite.length === 0) return { value, ok: true, rule: rule.context };
    let out = value;
    for (const r of rule.rewrite) {
      try { out = out.replace(new RegExp(r.from), r.to ?? ''); } catch { return { ok: false, reason: 'opaque-rewrite' }; }
    }
    return { value: normalizeTail(out), ok: true, rule: rule.context };
  };

  const prefixCache = new Map();
  const callsPerInstance = new Map(); // instance id -> call urls (for the auto count)
  // Longest key first, so `/api/customer` wins over `/api` on a call that
  // starts with both, and by name after that, so two runs choose the same one.
  const gatewayKeys = Object.keys(gatewayRoutes)
    .filter((k) => k !== '*')
    .sort((a, b) => b.length - a.length || cmp(a, b));

  const prefixOf = (instanceId) => {
    if (prefixCache.has(instanceId)) return prefixCache.get(instanceId);
    const inst = instanceOf.get(instanceId) ?? { id: instanceId, module: null, baseURL: null, package: '' };
    const pkg = inst.package ?? '';
    const cfg = configFor(pkg);
    const summary = inst.baseURL ?? cfg.axiosBaseUrl ?? null;
    const base = baseUrlValue(summary, pkg);
    let out = null;

    // 1. DECLARED. The profile said what the front-end prefix maps onto, so no
    // rule has to work it out. I-5: gatewayRoutes reaches exactly two readers,
    // this one and src/adapters/java_bridge.mjs, which applies the same rewrite
    // to an imperative Java HTTP call. Both read a value through the one reader
    // in src/core/profile.mjs, so a route's `service` means the same thing on
    // both sides of the wire.
    const star = Object.prototype.hasOwnProperty.call(gatewayRoutes, '*')
      ? gatewayRouteOf(gatewayRoutes['*']) : null;
    if (star !== null) out = { value: normalizeTail(star.to), from: 'declared', service: star.service, candidates: [] };
    if (out === null && base.state === 'known' && base.value !== '') {
      const hit = gatewayKeys.find((k) => base.value === k || base.value.startsWith(k));
      if (hit !== undefined) {
        const route = gatewayRouteOf(gatewayRoutes[hit]);
        out = {
          value: normalizeTail(`${route.to}${base.value.slice(hit.length)}`),
          from: 'declared', service: route.service, candidates: [],
        };
      }
    }

    // 2. DERIVED. Either there is nothing to apply (no base URL: the path as
    // written IS the path), or the base URL is in the source and a proxy rule
    // explains what of it reaches the server.
    if (out === null && base.state === 'absent') out = { value: '', from: 'derived', candidates: [] };
    if (out === null && base.state === 'known' && !base.ambiguous) {
      if (base.absolute) out = { value: base.value, from: 'derived', candidates: [] };
      else {
        const p = throughProxy(base.value, pkg);
        if (p.ok) out = { value: p.value, from: 'derived', candidates: [] };
      }
    }

    // 3. AUTO. Nothing states it, so every candidate is matched against the
    // routes this pack serves and the one that hits most wins. A guess, said so.
    if (out === null) {
      const cands = new Set(['']);
      for (const v of base.values ?? []) {
        cands.add(normalizeTail(v));
        const p = throughProxy(normalizeTail(v), pkg);
        if (p.ok) cands.add(p.value);
      }
      const urls = callsPerInstance.get(instanceId) ?? [];
      const scored = [...cands].sort().map((value) => {
        let exact = 0;
        let template = 0;
        for (const u of urls) {
          const full = normalizeUrl(`${value}${u}`);
          if (exactPaths.has(full)) exact += 1;
          else if (templatePaths.some((r) => routeMatches(r, full))) template += 1;
        }
        return { value, exact, template };
      });
      scored.sort((a, b) => b.exact - a.exact || b.template - a.template || b.value.length - a.value.length || cmp(a.value, b.value));
      const winner = scored[0] ?? { value: '', exact: 0, template: 0 };
      out = winner.exact + winner.template > 0
        ? { value: winner.value, from: 'auto', candidates: scored }
        : { value: '', from: 'none', candidates: scored };
    }
    // WHAT THE BROWSER SENDS, kept beside what the server answers. `value` is
    // the prefix that reaches the SERVER; `front` is the one on the address bar,
    // which is what a HAR recording holds (src/adapters/har_bridge.mjs). They
    // are the same string only when no dev-server proxy rewrote anything.
    out.front = base.state === 'known' ? base.value : '';
    prefixCache.set(instanceId, out);
    return out;
  };

  // ---- B6: the routes this pack SERVES -------------------------------------
  const exactPaths = new Set();
  const templatePaths = [];
  const routesByPath = new Map(); // normalized path -> [{id, httpMethod, path}]
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound === true || typeof n.path !== 'string') continue;
    const p = normalizeUrl(n.path);
    if (!routesByPath.has(p)) routesByPath.set(p, []);
    routesByPath.get(p).push({ id: n.id, httpMethod: n.httpMethod ?? 'ANY', path: p });
    exactPaths.add(p);
    templatePaths.push(p);
  }
  templatePaths.sort();
  const allRoutes = [...routesByPath.keys()].sort();

  const methodOk = (route, method) => method === null || route.httpMethod === 'ANY' || route.httpMethod === method;
  const matchUrl = (full, method) => {
    const p = normalizeUrl(full);
    const exact = (routesByPath.get(p) ?? []).filter((r) => methodOk(r, method));
    if (exact.length > 0) return { how: 'exact', routes: exact };
    const hits = [];
    for (const rp of allRoutes) {
      if (rp === p) continue;
      if (!routeMatches(rp, p)) continue;
      for (const r of routesByPath.get(rp)) if (methodOk(r, method)) hits.push(r);
    }
    return hits.length > 0 ? { how: 'template', routes: hits } : { how: null, routes: [] };
  };

  // ---- classify every call, then place the edges ---------------------------
  //
  // TWO PASSES over the calls, because the `auto` prefix has to count matches
  // over the calls of one instance before any of them can be graded.
  const sites = [];
  for (const file of fileNames) {
    const f = files.get(file);
    const pkg = packageOf(file);
    const isTemplate = templatesByFile.has(file);
    const ctxVars = isTemplate ? contextVarsFor(file) : null;
    // A TEMPLATE NOBODY RENDERS IS DEAD MARKUP. Its links go somewhere, but
    // nobody opens them, so they are not this application's calls.
    if (isTemplate && !renderedTemplates.has(file)) {
      stats.templates.unrendered += 1;
      continue;
    }
    for (const c of f.calls) {
      if (!c.url) continue;
      const resolved = withContextPath(c, ctxVars);
      const platform = platformOf(c);
      let sink = null;
      let target = null;
      if (isTemplate && c.template && typeof c.template.rule === 'string') {
        // A FORM AND A LINK ARE THE PAGE'S OWN CALLS. Nothing had to be traced:
        // the markup names the path and the attribute names the method.
        sink = { kind: 'template', module: c.template.rule, instance: null, chain: [], depth: 0 };
        stats.calls.template += 1;
      } else if (platform) {
        sink = { kind: 'platform', module: platform.name, instance: null, chain: [], depth: 0 };
        stats.calls.platform += 1;
      } else if (c.injected && injectedClients.has(c.injected.client)) {
        // AN INJECTED CLIENT IS A CLIENT. Nothing in the file binds `$http`, so
        // there is nothing to trace: the framework put it in the parameter list,
        // the pack says that parameter is a client, and the worker checked that
        // the function really sits where the framework fills it in.
        sink = {
          kind: 'injected', module: c.injected.client, instance: null, chain: [], depth: 0,
        };
        stats.calls.injected += 1;
      } else {
        target = calleeTarget(file, c);
        if (target && target.kind === 'sink' && sinkVerb(target)) {
          noteInstance(target.instance, pkg);
          sink = {
            kind: 'library', module: target.instance.module, instance: target.instance.id ?? null,
            chain: [], depth: 0,
          };
          stats.calls.traced += 1;
        } else if (target && target.kind === 'member' && wrappers.has(target.key)) {
          const chain = [];
          let cur = target.key;
          for (let i = 0; i < FIXPOINT_LIMIT && cur; i += 1) {
            chain.push(cur);
            cur = wrappers.get(cur)?.next ?? null;
          }
          const w = wrappers.get(target.key);
          sink = {
            kind: 'wrapper', module: w.sink.module, instance: w.sink.instance,
            chain: chain.reverse(), depth: w.depth,
          };
          stats.calls.traced += 1;
        } else {
          // AN UNTRACED CALL IS ONLY A CALL WHEN ITS ARGUMENT LOOKS LIKE A URL.
          //
          // The worker records the first argument of any verb-named call as the
          // URL, by the ecosystem's own convention, and that convention is right
          // for `thing.get('/x')` and wrong for `Cookies.get('size')`. Nothing in
          // ONE FILE can tell those apart; the bridge can, because it knows
          // whether the callee reached a client library at all. So a call that
          // reached none AND whose argument is not written like a path is not an
          // HTTP call here: it is counted (`notUrlShaped`) and left alone, rather
          // than becoming a route named `/size` that nothing serves.
          if (!urlShaped(c, resolved)) { stats.calls.notUrlShaped += 1; continue; }
          sink = { kind: 'untraced', module: target && target.kind === 'external' ? target.module : null, instance: null, chain: [], depth: 0 };
          stats.calls.untraced += 1;
        }
      }
      stats.calls.withUrl += 1;
      const instanceId = sink.instance ?? `${pkg}#(package)`;
      if (!instanceOf.has(instanceId)) {
        instanceOf.set(instanceId, { id: instanceId, module: sink.module, baseURL: null, package: pkg });
      }
      const method = methodFor(c, sink, target);
      const site = {
        file, pkg, call: c, sink, target, instanceId, method,
        assumed: (target && target.assumed === true) || false,
        template: isTemplate, resolved,
      };
      sites.push(site);
      if (Array.isArray(resolved) && !isTemplate) {
        if (!callsPerInstance.has(instanceId)) callsPerInstance.set(instanceId, []);
        for (const r of resolved) callsPerInstance.get(instanceId).push(r.template);
      }
    }
  }

  /** The HTTP method this call sends, and what said so. */
  function methodFor(c, sink, target) {
    if (sink.kind === 'wrapper' && target && target.kind === 'member') {
      const w = wrappers.get(target.key);
      const verbCall = w && w.call ? w.call : null;
      if (verbCall && verbCall.method && verbCall.method.value) {
        return { value: verbCall.method.value, from: 'wrapper-verb' };
      }
    }
    if (c.method && c.method.value) return { value: c.method.value, from: c.method.from ?? 'config' };
    if (sink.kind === 'library' || sink.kind === 'wrapper') {
      const lib = libraries.get(sink.module);
      if (lib && lib.defaultMethod) return { value: lib.defaultMethod, from: 'library-default' };
    }
    if (sink.kind === 'platform') {
      const p = (pack.platform ?? []).find((x) => x.name === sink.module);
      if (p && p.defaultMethod) return { value: p.defaultMethod, from: 'library-default' };
    }
    if (sink.kind === 'injected') {
      const cl = injectedClients.get(sink.module);
      if (cl && cl.defaultMethod) return { value: cl.defaultMethod, from: 'library-default' };
    }
    return { value: null, from: 'absent' };
  }

  // The URL never resolved: no edge at all, counted by the reason the worker gave.
  const REASON = { parameter: 'parameter', expression: 'expression', 'imported-constant': 'importedConstant' };
  const unmatched = new Map();
  const nodesToAdd = new Map();
  const edges = [];
  // The functions that SEND a request, and the routes their calls landed on.
  // Both are read by the screen axis below: the first seeds the fixpoint that
  // decides which functions get a node, the second answers "does this frontend
  // ask the server for its own menu?".
  const httpFunctionIds = new Set();
  const matchedRoutePaths = new Set();

  for (const site of sites) {
    const { file, call, sink } = site;
    if (!Array.isArray(site.resolved) || site.resolved.length === 0) {
      const reason = REASON[call.url.unresolved] ?? 'expression';
      stats.unresolved.total += 1;
      stats.unresolved.byReason[reason] += 1;
      continue;
    }
    // A PAGE'S URLS ARE WRITTEN FROM THE APP ROOT. `${request.contextPath}`,
    // `@{/…}` and `<c:url>` all mean "where this deployment is mounted", which
    // is not part of any route the pack serves, so the prefix is the empty
    // string and nothing had to be guessed to know that.
    const prefix = site.template ? TEMPLATE_PREFIX : prefixOf(site.instanceId);
    const absolute = call.url.absolute ?? null;
    const outsidePack = absolute !== null && !LOCAL_HOSTS.has(absolute.host)
      && !configFor(site.pkg).proxies.some((p) => typeof p.target === 'string' && p.target.includes(absolute.host));
    // A ternary URL is TWO possible requests from ONE call site: it gets an edge
    // each, and the census below counts the call once, at the weaker grade of
    // whatever its candidates reached. Counting the edges instead would make
    // "calls resolved" bigger than "calls".
    let callGrade = null;
    let callMatch = null;
    let callMulti = false;
    let callMissed = false;
    let callAllHoles = false;
    for (const cand of site.resolved) {
      const written = cand.template;
      if (!namesARoute(written)) { callAllHoles = true; continue; }
      // A declared gateway route rewrites the CALL, not just the client: a
      // project whose calls carry the dev prefix has nowhere else to say so.
      // The template is normalized BEFORE the prefix is joined on, or a path
      // written without its leading slash (`get('user/list')`) would be glued
      // to the prefix as `/adminuser/list`.
      let full = absolute !== null
        ? normalizeUrl(written)
        : normalizeUrl(`${prefix.value}${normalizeUrl(written)}`);
      let prefixEvidence = { value: prefix.value, from: prefix.from };
      // WHICH SERVICE ANSWERS THIS CALL, when the declared route names one. A
      // gateway route table says both halves — the prefix a request is
      // forwarded with, and the deployable it is forwarded to — and the second
      // half is what lets an answer cross into the right sibling when several
      // serve the same path (src/mcp/federation.mjs).
      let declaredService = prefix.from === 'declared' ? (prefix.service ?? null) : null;
      if (prefix.from !== 'declared') {
        const hit = gatewayKeys.find((k) => full === k || full.startsWith(`${k}/`));
        if (hit !== undefined) {
          const route = gatewayRouteOf(gatewayRoutes[hit]);
          full = normalizeUrl(`${route.to}${full.slice(hit.length)}`);
          prefixEvidence = { value: route.to, from: 'declared' };
          declaredService = route.service;
        }
      }
      if (prefix.from === 'auto') prefixEvidence.candidates = prefix.candidates;

      const found = outsidePack ? { how: null, routes: [] } : matchUrl(full, site.method.value);
      let grade;
      if (sink.kind === 'untraced') grade = 'HEURISTIC';
      else grade = 'SOUND_SET';
      // NOTHING RISES ABOVE SOUND_SET ON A CALL, a page's form included: which
      // handler answers a path is the route table's answer, not the markup's.
      if (prefixEvidence.from === 'auto' || site.assumed || site.method.value === null) grade = 'HEURISTIC';

      const enclosing = call.enclosing ?? '(module)';
      const fromId = webSymbolId(file, enclosing);
      const fnRec = files.get(file)?.functions.get(enclosing) ?? null;
      nodesToAdd.set(fromId, {
        id: fromId, symbol: `${file}#${enclosing}`, file, line: fnRec ? fnRec.line : (call.line ?? null),
        lane: 'web', exported: fnRec ? (fnRec.exported ?? null) : null,
        ...(isComponentFile(file) ? { component: true } : {}),
      });
      httpFunctionIds.add(fromId);

      const evidence = {
        rule: site.template && call.template ? call.template.rule : 'web-http-call',
        basis: WEB_CALL_BASIS[sink.kind],
        ...(site.template && call.template ? { attribute: call.template.attr, wrote: call.template.written } : {}),
        sink: { kind: sink.kind, module: sink.module, instance: sink.instance, chain: sink.chain, depth: sink.depth },
        // `written` is the path as the code spells it, `template` the path this
        // pack was searched for. An absolute URL keeps its HOST here, because
        // the node id is a path and two hosts would otherwise be one node.
        url: {
          written, template: full, via: cand.via ?? null,
          ...(absolute ? { host: absolute.host } : {}),
        },
        method: site.method,
        prefix: prefixEvidence,
        // The same two fields the Java lane puts on a call it read a host from
        // (src/adapters/java_bridge.mjs): the service this call is for, and
        // whether that name was WRITTEN somewhere rather than inferred. Here it
        // was written, in the gateway's own route table.
        ...(declaredService ? { service: declaredService, serviceLiteral: true } : {}),
        match: found.how,
        target: found.routes.length > 0 ? 'in-pack' : 'outside-pack',
      };
      if (site.assumed) evidence.alias = 'assumed';

      if (found.routes.length === 0) {
        const httpMethod = site.method.value ?? 'ANY';
        const epId = webEndpointId(httpMethod, full);
        if (!g.nodes.has(epId) && !nodesToAdd.has(epId)) {
          nodesToAdd.set(epId, { id: epId, path: full, httpMethod, outbound: true, source: 'web' });
          stats.outboundEndpoints += 1;
        }
        edges.push({ from: fromId, to: epId, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence });
        callMissed = true;
        const key = `${httpMethod} ${full}`;
        unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        continue;
      }
      const many = found.routes.length > 1;
      if (many) callMulti = true;
      if (callMatch === null || (callMatch === 'template' && found.how === 'exact')) callMatch = found.how;
      if (callGrade === null || GRADE_RANK[grade] < GRADE_RANK[callGrade]) callGrade = grade;
      for (const r of found.routes.slice().sort((a, b) => cmp(a.id, b.id))) {
        matchedRoutePaths.add(r.path);
        edges.push({
          from: fromId,
          to: r.id,
          type: 'CALLS_HTTP',
          grade,
          evidence: many ? { ...evidence, candidates: found.routes.length } : evidence,
        });
      }
    }
    if (callGrade !== null) {
      stats.resolved[callGrade] += 1;
      if (callMatch === 'exact') stats.matches.exact += 1; else stats.matches.template += 1;
      if (callMulti) stats.matches.multi += 1;
    } else if (callMissed) {
      stats.unresolved.total += 1;
      stats.unresolved.byReason[outsidePack ? 'outsidePack' : 'noMatch'] += 1;
    } else if (callAllHoles) {
      stats.unresolved.total += 1;
      stats.unresolved.byReason.allHoles += 1;
      const key = `${site.method.value ?? 'ANY'} ${normalizeUrl(`${prefix.value}${normalizeUrl(site.resolved[0].template)}`)}`;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    }
  }

  // =========================================================================
  // B7 — THE SCREEN AXIS (RM30)
  //
  // Everything above answers "which route does this function call?". Nothing
  // above says WHICH SCREEN that function belongs to, because the calls BETWEEN
  // frontend functions were not in the graph: a view that calls `listThings()`
  // from an api module had no path to the route at all. Three things close it:
  // the calls between frontend functions (B7a), the screens the router declares
  // (B7b), and the RENDERS edge from a screen to the functions of the component
  // it mounts (B7c).
  // =========================================================================

  // ---- B7a: `frontend function --CALLS--> frontend function` ---------------
  //
  // WHAT RESOLVES, and what each answer is graded:
  //   EXACT      a static import with a named or default specifier, followed
  //              through a relative path or a DECLARED alias to a `function`
  //              record in a file this lane parsed; or a call by name inside
  //              one file (`getList()`, `this.getList()`), where the name can
  //              only mean the declaration beside it
  //   SOUND_SET  the same, but the name came through an `export *` barrel or a
  //              re-export chain, so WHICH file it really comes from was a
  //              choice this lane made and disclosed
  //   HEURISTIC  an ASSUMED alias was on the path, so the file it resolved to
  //              rests on a guess
  //
  // AND A FUNCTION THAT IS NEVER CALLED HERE AT ALL (RM32). A view that writes
  // `usePagedList({ api: list })` hands `list` over as a VALUE: no call site
  // names it, so every rule above sees nothing and the screen ends there. The
  // worker records what was passed (`fnRefs`); this section resolves it exactly
  // as it resolves a callee, and the edge is SOUND_SET, never EXACT: whether
  // the receiver ever calls what it was given is not something this lane
  // looked at, and it does not pretend otherwise. An assumed alias on the path
  // lowers it to HEURISTIC, the same as everywhere else.
  //
  // A member call on an imported OBJECT (`client.get(...)`, where `client` is a
  // client instance) is not a call to a function this lane read, and it is not
  // counted as a miss either: the HTTP pass above already explained it.
  const httpSiteCalls = new Set(sites.map((s) => s.call));
  const callTargetOf = (file, c) => {
    const callee = c.callee ?? null;
    if (!callee || typeof callee.root !== 'string') return null;
    // `new Thing()` builds a value; it is not the hop from a screen to the
    // function that fetches its data, which is what this section is about.
    if (callee.shape === 'new') return null;
    const parts = callee.path ?? [];
    const binding = c.binding ?? null;
    const f = files.get(file);
    if (!f) return null;
    const sameFile = (name) => ({
      file, name, grade: 'EXACT', evidence: { rule: 'same-file', origin: `${file}#${name}` },
    });
    // `this.getList()` inside a class: the member is a function of THIS file,
    // recorded under `<Class>.<name>`.
    if (binding && binding.kind === 'this') {
      if (parts.length !== 1 || typeof binding.class !== 'string') return null;
      const name = `${binding.class}.${parts[0]}`;
      return f.functions.has(name) ? sameFile(name) : null;
    }
    const imp = f.importOf.get(callee.root);
    if (!imp) {
      // A name this file declares, called by name. Only a bare call: a member
      // path on a local object is not a function this lane can name.
      if (parts.length !== 0) return null;
      return f.functions.has(callee.root) ? sameFile(callee.root) : null;
    }
    const namespace = imp.imported === '*';
    if (namespace ? parts.length !== 1 : parts.length !== 0) return null;
    const r = resolveSpecifier(file, imp.source);
    if (!r.file) return null; // a package this analysis never read
    const wanted = namespace ? parts[0] : imp.imported;
    const hit = resolveExport(r.file, wanted, 0);
    if (!hit || hit.external || !hit.file) return null;
    if (!files.get(hit.file)?.functions.has(hit.name)) {
      // It resolved, and what it landed on is not a function: a constant, a
      // component, a client. No edge, and a number rather than a silence —
      // except where the HTTP pass above already explained this call, because a
      // call onto a client instance is not a missing hop, it is the sink.
      if (!httpSiteCalls.has(c)) stats.calls.notAFunction += 1;
      return null;
    }
    const assumed = hit.assumed === true || r.assumed === true;
    const viaStar = hit.viaStar === true;
    const grade = assumed ? 'HEURISTIC' : viaStar ? 'SOUND_SET' : 'EXACT';
    const evidence = { rule: 'esm-import', specifier: imp.source, origin: `${hit.file}#${hit.name}` };
    if (viaStar) evidence.viaStar = true;
    if (assumed) evidence.assumedAlias = true;
    return { file: hit.file, name: hit.name, grade, evidence };
  };

  /**
   * The function one `fnRefs` entry names, resolved the way a callee is.
   *
   * Nothing about the RECEIVER is inspected: this rule does not ask whether
   * `usePagedList` calls its `api`, because answering that would mean following
   * a value into another module's body, and a lane that guessed at it would be
   * guessing on every hook in the ecosystem. What is stated instead is what the
   * source states: this function was handed over here, so whoever took it may
   * call it. That is a sound candidate, and SOUND_SET is what it is graded.
   */
  const fnRefTargetOf = (file, ref) => {
    if (!ref || typeof ref.name !== 'string') return null;
    const f = files.get(file);
    if (!f) return null;
    const parts = Array.isArray(ref.path) ? ref.path : [];
    const via = ref.via === 'property' ? 'property' : 'argument';
    const keyPart = typeof ref.key === 'string' ? { key: ref.key } : {};
    const imp = f.importOf.get(ref.name);
    if (!imp) {
      // A name this file declares. Only a bare name: a member of a local object
      // is not a function this lane can put a symbol on.
      if (parts.length !== 0 || !f.functions.has(ref.name)) return null;
      return {
        file,
        name: ref.name,
        grade: 'SOUND_SET',
        evidence: { rule: 'passed-as-value', via, ...keyPart, origin: `${file}#${ref.name}` },
      };
    }
    const namespace = imp.imported === '*';
    if (namespace ? parts.length !== 1 : parts.length !== 0) return null;
    const r = resolveSpecifier(file, imp.source);
    if (!r.file) return null; // a package this analysis never read
    const wanted = namespace ? parts[0] : imp.imported;
    const hit = resolveExport(r.file, wanted, 0);
    if (!hit || hit.external || !hit.file) return null;
    // What was passed is not a function this lane read: a constant, a component,
    // a client instance. Handing one of those over is ordinary, and it is not a
    // missing hop, so it is not counted as one either.
    if (!files.get(hit.file)?.functions.has(hit.name)) return null;
    const assumed = hit.assumed === true || r.assumed === true;
    const evidence = {
      rule: 'passed-as-value', via, ...keyPart, specifier: imp.source, origin: `${hit.file}#${hit.name}`,
    };
    if (hit.viaStar === true) evidence.viaStar = true;
    if (assumed) evidence.assumedAlias = true;
    return { file: hit.file, name: hit.name, grade: assumed ? 'HEURISTIC' : 'SOUND_SET', evidence };
  };

  const symbolMeta = new Map(); // symbol node id -> {file, name}
  for (const [id, n] of nodesToAdd) {
    if (n.lane === 'web') symbolMeta.set(id, { file: n.file, name: String(n.symbol).slice(String(n.symbol).indexOf('#') + 1) });
  }
  const callCandidates = new Map(); // `${from}|${to}` -> {from, to, grade, evidence}
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      const t = callTargetOf(file, c);
      if (!t) continue;
      const fromName = c.enclosing ?? '(module)';
      const fromId = webSymbolId(file, fromName);
      const toId = webSymbolId(t.file, t.name);
      if (fromId === toId) continue; // a function calling itself is not a hop
      symbolMeta.set(fromId, { file, name: fromName });
      symbolMeta.set(toId, { file: t.file, name: t.name });
      const key = `${fromId}|${toId}`;
      // Two calls to the same target from the same function are ONE edge. The
      // records are in line order, so the first one is the one kept.
      if (!callCandidates.has(key)) {
        callCandidates.set(key, { from: fromId, to: toId, grade: t.grade, evidence: t.evidence });
      }
    }
  }

  // A SECOND PASS, after every call has had its say. A pair that is both CALLED
  // and PASSED keeps the call's answer, which is the stronger of the two: a
  // view that writes `list()` beside `usePagedList({ api: list })` gets one
  // EXACT edge, not a SOUND_SET one that happened to be seen first.
  for (const file of fileNames) {
    for (const c of files.get(file).calls) {
      for (const ref of c.fnRefs ?? []) {
        const t = fnRefTargetOf(file, ref);
        if (!t) continue;
        stats.calls.passedAsValue += 1;
        const fromName = c.enclosing ?? '(module)';
        const fromId = webSymbolId(file, fromName);
        const toId = webSymbolId(t.file, t.name);
        if (fromId === toId) continue; // a function handing itself over is not a hop
        symbolMeta.set(fromId, { file, name: fromName });
        symbolMeta.set(toId, { file: t.file, name: t.name });
        const key = `${fromId}|${toId}`;
        if (!callCandidates.has(key)) {
          callCandidates.set(key, { from: fromId, to: toId, grade: t.grade, evidence: t.evidence });
        }
      }
    }
  }

  // THE FUNCTION-CREATION RULE. Only a function that sends a request, or that
  // reaches one through these edges, becomes a node. Everything else — the
  // formatters, the validators, the date helpers — is counted and left out, or
  // the pack doubles in size for code no question is ever about.
  const callersOf = new Map();
  for (const e of callCandidates.values()) {
    let arr = callersOf.get(e.to);
    if (!arr) callersOf.set(e.to, arr = []);
    arr.push(e.from);
  }
  const reachingHttp = new Set(httpFunctionIds);
  const queue = [...httpFunctionIds];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const from of callersOf.get(id) ?? []) {
      if (reachingHttp.has(from)) continue;
      reachingHttp.add(from);
      queue.push(from);
    }
  }
  for (const id of [...reachingHttp].sort()) {
    if (nodesToAdd.has(id)) continue;
    const m = symbolMeta.get(id);
    if (!m) continue;
    const fnRec = files.get(m.file)?.functions.get(m.name) ?? null;
    nodesToAdd.set(id, {
      id, symbol: `${m.file}#${m.name}`, file: m.file, line: fnRec ? fnRec.line : null,
      lane: 'web', exported: fnRec ? (fnRec.exported ?? null) : null,
      ...(isComponentFile(m.file) ? { component: true } : {}),
    });
  }
  for (const key of [...callCandidates.keys()].sort()) {
    const e = callCandidates.get(key);
    if (!reachingHttp.has(e.from) || !reachingHttp.has(e.to)) continue;
    stats.callsEdges[e.grade] += 1;
    const rule = e.evidence?.rule;
    if (typeof rule === 'string') stats.callsByRule[rule] = (stats.callsByRule[rule] ?? 0) + 1;
    edges.push({ from: e.from, to: e.to, type: 'CALLS', grade: e.grade, evidence: e.evidence });
  }
  stats.functions = {
    withHttp: httpFunctionIds.size,
    reachingHttp: reachingHttp.size - httpFunctionIds.size,
    created: reachingHttp.size,
  };

  // ---- B7b: the screens the router declares --------------------------------
  const screenAxis = opts.screenAxis && typeof opts.screenAxis === 'object' ? opts.screenAxis : {};
  const screenEnabled = screenAxis.enabled === true;
  const askedNameSource = typeof screenAxis.nameSource === 'string' ? screenAxis.nameSource : 'none';
  const pathRule = typeof screenAxis.pathRule === 'string' && screenAxis.pathRule !== '' ? screenAxis.pathRule : null;
  const codeLength = Number.isInteger(opts.codeLength) && opts.codeLength > 0 ? opts.codeLength : null;
  let codeRegex = null;
  if (typeof screenAxis.codeRegex === 'string' && screenAxis.codeRegex !== '') {
    try { codeRegex = new RegExp(screenAxis.codeRegex); } catch { codeRegex = null; }
  }
  // A NAME SOURCE THIS ENGINE DOES NOT READ IS REFUSED, not quietly ignored.
  // `route-meta` is the route's own `meta.title`, which the worker records;
  // `jsdoc-comment` would need the comment above the component, which no lane
  // reads, so asking for it leaves every title null and says why.
  const nameSource = askedNameSource === 'route-meta' ? 'route-meta' : 'none';
  const nameSourceRefused = askedNameSource === 'jsdoc-comment'
    ? 'screenAxis.nameSource asks for jsdoc-comment, and no lane here reads the comment above a component, so every screen title is null'
    : null;
  stats.screens.enabled = screenEnabled;
  stats.screens.nameSource = { asked: askedNameSource, used: nameSource, refused: nameSourceRefused };
  stats.screens.pathRule = pathRule;
  stats.screens.codeRegex = typeof screenAxis.codeRegex === 'string' ? screenAxis.codeRegex : null;
  stats.screens.codeLength = codeLength;

  const routeRecords = [];
  for (const file of fileNames) for (const r of files.get(file).routes) routeRecords.push(r);
  routeRecords.sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
  stats.screens.declared = routeRecords.length;
  stats.screens.serverDriven.routes = routeRecords.length;
  const menuEndpoints = [...matchedRoutePaths]
    .filter((p) => SERVER_MENU_SUFFIXES.some((s) => p.endsWith(s))).sort();
  stats.screens.serverDriven.menuEndpoints = menuEndpoints;
  // THE CALL ALONE DECIDES. A frontend that fetches its own menu has screens
  // this pack cannot hold, however many it also writes down.
  stats.screens.serverDriven.detected = menuEndpoints.length > 0;
  stats.screens.serverDriven.detectedBy = menuEndpoints.length > 0 ? 'menu-call' : null;

  // The parent of a route declaration is a LINE in the same file (the worker
  // resolves nothing across files), so the chain is looked up that way.
  const routeAt = new Map();
  for (const r of routeRecords) {
    const k = `${r.file}|${r.line}`;
    if (!routeAt.has(k)) routeAt.set(k, r);
  }
  // A CHAIN ROUTE NAMES ITS PARENT, and the parent is as often in another file
  // (`app.js` declares `app`, `owner-list.js` declares `owners` under it). The
  // worker resolves nothing across files, so the name is what it records and
  // this is where the two are put together. The first declaration in (file,
  // line) order wins a name, the same rule two declarations of one path follow.
  const routeByName = new Map();
  for (const r of routeRecords) {
    if (typeof r.name !== 'string' || r.name === '') continue;
    if (!routeByName.has(r.name)) routeByName.set(r.name, r);
  }
  const parentChain = (rec) => {
    const chain = [];
    const seen = new Set();
    let cur = rec;
    for (let i = 0; i < HOP_LIMIT && cur; i += 1) {
      const k = `${cur.file}|${cur.line}`;
      if (seen.has(k)) break;
      seen.add(k);
      chain.push(cur);
      if (typeof cur.parentName === 'string' && cur.parentName !== '') {
        cur = routeByName.get(cur.parentName) ?? null;
        continue;
      }
      cur = cur.parent == null ? null : (routeAt.get(`${cur.file}|${cur.parent}`) ?? null);
    }
    chain.reverse();
    return chain;
  };

  // ---- the framework's own name registry (RM47) ----------------------------
  //
  // `angular.module('ownerList').component('ownerList', {controller:
  // 'OwnerListController'})` is a frontend written before modules saying what a
  // name means. Two indexes, one per kind, each holding EVERY file that
  // registers a name: a name registered twice is a real ambiguity, and the
  // grade says so rather than the first one winning silently.
  const registryOf = new Map(); // `${what}:${name}` -> registration records
  for (const file of fileNames) {
    for (const r of files.get(file).registrations) {
      if (typeof r.name !== 'string' || r.name === '' || typeof r.what !== 'string') continue;
      const key = `${r.what}:${r.name}`;
      let arr = registryOf.get(key);
      if (!arr) registryOf.set(key, arr = []);
      arr.push(r);
    }
  }

  const unresolvedNames = new Map();
  const noteMissingName = (what, name) => {
    const key = `${what} ${name}`;
    unresolvedNames.set(key, (unresolvedNames.get(key) ?? 0) + 1);
  };

  /**
   * The RENDERS edges one route earns through the name registry, and the names
   * that led nowhere.
   *
   * The walk is over NAMES, not over files: a route names a component, the
   * component names a controller and a template, and the template names more
   * components by their tags. Each hop is a string the framework matches
   * exactly, so a hop that lands on exactly one registration is EXACT; a name
   * registered twice makes every edge below it HEURISTIC, because which one
   * loads last is not in the source.
   *
   * @param {Object} rec  a route record carrying registry names
   * @returns {{targets:{file:string, rule:string, chain:string[], grade:string}[], primary:(string|null)}}
   */
  const attachByRegistry = (rec) => {
    const targets = [];
    const placed = new Set();
    const seenNames = new Set();
    const add = (file, rule, chain, grade) => {
      const key = `${file}|${rule}|${chain.join('>')}`;
      if (placed.has(key)) return;
      placed.add(key);
      targets.push({ file, rule, chain: [...chain], grade });
    };
    // Every name the route itself puts forward, in a fixed order.
    const seeds = [];
    if (typeof rec.componentName === 'string' && rec.componentName !== '') {
      seeds.push({ what: 'component', name: rec.componentName, rule: 'angular-component', chain: [rec.componentName] });
    }
    if (typeof rec.componentTag === 'string' && rec.componentTag !== '') {
      const name = registryNameOf(rec.componentTag);
      seeds.push({ what: 'component', name, rule: 'angular-component', chain: [rec.componentTag, name] });
    }
    for (const tag of rec.templateTags ?? []) {
      const name = registryNameOf(tag);
      seeds.push({ what: 'component', name, rule: 'angular-template-tag', chain: [rec.templateFile ?? rec.templateUrl ?? '(template)', tag, name] });
    }
    if (typeof rec.controllerName === 'string' && rec.controllerName !== '') {
      seeds.push({ what: 'controller', name: rec.controllerName, rule: 'angular-controller', chain: [rec.controllerName] });
    }

    let frontier = seeds.map((s) => ({ ...s, grade: 'EXACT' }));
    for (let depth = 0; depth < RENDERS_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const hop of frontier.slice().sort((a, b) => cmp(a.name, b.name) || cmp(a.rule, b.rule))) {
        const nameKey = `${hop.what}:${hop.name}`;
        if (seenNames.has(nameKey)) continue; // a cycle in the registry, cut here
        seenNames.add(nameKey);
        // A COMPONENT, OR THE DIRECTIVE THAT IS ONE. Before components existed
        // the same job was done by a directive with a controller, and the
        // framework mounts both by writing the element. The component registry
        // is asked first, because that is the one a modern file registers in.
        let hits = registryOf.get(nameKey) ?? [];
        if (hits.length === 0 && hop.what === 'component') hits = registryOf.get(`directive:${hop.name}`) ?? [];
        if (hits.length === 0) { noteMissingName(hop.what, hop.name); continue; }
        const grade = hits.length > 1 ? 'HEURISTIC' : hop.grade;
        for (const hit of hits) {
          add(hit.file, hop.rule, hop.chain, grade);
          if (hop.what !== 'component') continue;
          if (typeof hit.controller === 'string' && hit.controller !== '') {
            next.push({
              what: 'controller', name: hit.controller, rule: 'angular-controller',
              chain: [...hop.chain, hit.controller], grade,
            });
          }
          for (const tag of hit.templateTags ?? []) {
            const name = registryNameOf(tag);
            next.push({
              what: 'component', name, rule: 'angular-template-tag',
              chain: [...hop.chain, hit.templateFile ?? hit.templateUrl ?? '(template)', tag, name], grade,
            });
          }
        }
      }
      frontier = next;
    }
    // The file a reader would call "the screen's component": the first target
    // of the first seed, in the order above.
    const primary = targets.length > 0 ? targets[0].file : null;
    return { targets, primary };
  };

  /** Whether a route names its component through a registry rather than a path. */
  const namesByRegistry = (rec) => typeof rec.componentName === 'string'
    || typeof rec.componentTag === 'string'
    || typeof rec.controllerName === 'string'
    || (rec.templateTags ?? []).length > 0;
  // THE PATH IS COMPOSED, not read. A child path that starts with `/` is
  // ABSOLUTE and replaces everything above it; a parent whose path is `''`
  // contributes nothing; everything else is joined with one slash.
  const composedPath = (rec) => {
    let out = '';
    for (const part of parentChain(rec)) {
      const p = String(part.path ?? '');
      if (p.startsWith('/')) out = p;
      else if (p === '') continue;
      else out = `${out}/${p}`;
    }
    return normalizeUrl(out);
  };

  const componentImports = new Map();
  const componentChildrenOf = (file) => {
    let out = componentImports.get(file);
    if (out) return out;
    out = [];
    const f = files.get(file);
    for (const imp of f ? f.imports : []) {
      const r = resolveSpecifier(file, imp.source);
      if (!r.file || !isComponentFile(r.file) || r.file === file) continue;
      out.push(r.file);
    }
    out = [...new Set(out)].sort();
    componentImports.set(file, out);
    return out;
  };

  const symbolsByFile = new Map();
  for (const [id, n] of nodesToAdd) {
    if (n.lane !== 'web' || typeof n.file !== 'string') continue;
    let arr = symbolsByFile.get(n.file);
    if (!arr) symbolsByFile.set(n.file, arr = []);
    arr.push(id);
  }
  for (const arr of symbolsByFile.values()) arr.sort();

  const unresolvedSpecifiers = new Map();
  const screenNodes = new Map(); // screen id -> node
  const registryTargets = new Map(); // screen id -> what attachByRegistry found
  if (screenEnabled) {
    for (const rec of routeRecords) {
      const hasComponent = typeof rec.componentSource === 'string' || typeof rec.componentLocal === 'string'
        || namesByRegistry(rec);
      // A REDIRECT IS NOT A SCREEN. `{path:'/', redirect:'/home'}` mounts
      // nothing and shows nothing; it is a rule about where to go next.
      if (!hasComponent && (rec.children ?? 0) === 0 && rec.redirect != null) continue;
      // AN ABSTRACT STATE IS NOT A SCREEN EITHER, and it is not nothing: it is
      // the path its children hang off, so it composes and it does not mount.
      if (rec.abstract === true) continue;
      const full = composedPath(rec);
      const id = webScreenId(full);
      const existing = screenNodes.get(id);
      if (existing) {
        // TWO DECLARATIONS, ONE PATH. The first in (file, line) order is the
        // node; every declaration is listed, because which one a reader is
        // looking at is a real question.
        existing.declaredAt.push({ file: rec.file, line: rec.line });
        stats.screens.duplicatePaths += 1;
        continue;
      }
      let componentFile = null;
      let componentSpec = null;
      let registryHit = null;
      if (namesByRegistry(rec)) {
        // A NAME, NOT A PATH. Nothing imports anything here, so the file comes
        // from the framework's registry and a name nobody registered is the
        // same gap an unresolvable specifier is.
        registryHit = attachByRegistry(rec);
        componentFile = registryHit.primary;
        if (componentFile === null) stats.screens.componentUnresolved += 1;
      } else if (typeof rec.componentSource === 'string' && rec.componentSource !== '') {
        componentSpec = rec.componentSource;
        const r = resolveSpecifier(rec.file, rec.componentSource);
        if (r.file) componentFile = r.file;
      } else if (typeof rec.componentLocal === 'string' && rec.componentLocal !== '') {
        componentSpec = `(declared in ${rec.file} as ${rec.componentLocal})`;
      }
      if (componentSpec !== null && componentFile === null) {
        stats.screens.componentUnresolved += 1;
        unresolvedSpecifiers.set(componentSpec, (unresolvedSpecifiers.get(componentSpec) ?? 0) + 1);
      }
      const title = nameSource === 'route-meta' ? (rec.metaTitle ?? null) : null;
      const segments = full.split('/').filter((s) => s !== '');
      const label = pathRule === 'last-segment' ? (segments[segments.length - 1] ?? full) : full;
      let code = null;
      if (codeRegex) {
        for (const hay of [rec.name ?? null, title, full]) {
          if (typeof hay !== 'string') continue;
          const m = codeRegex.exec(hay);
          if (m) { code = m[1] ?? m[0]; break; }
        }
      }
      // The GROUP a screen belongs to: the leading characters of its code when
      // the project declares both, and otherwise the first path segment, which
      // is a naming habit rather than a boundary anybody declared.
      const group = code !== null && codeLength !== null
        ? code.slice(0, codeLength)
        : (segments[0] ?? SCREEN_ROOT_GROUP);
      const node = {
        id,
        path: full,
        name: rec.name ?? null,
        title,
        label,
        code,
        group,
        component: componentFile,
        file: rec.file,
        line: rec.line ?? null,
        pack: rec.pack ?? null,
        params: /[:*]/.test(full),
        lane: 'web',
        source: 'router',
        declaredAt: [{ file: rec.file, line: rec.line }],
      };
      if (rec.hidden === true) { node.hidden = true; stats.screens.hidden += 1; }
      if (node.params) stats.screens.withParams += 1;
      if (componentFile !== null) stats.screens.withComponent += 1;
      screenNodes.set(id, node);
      if (registryHit !== null) registryTargets.set(id, registryHit.targets);
    }
  }
  stats.screens.byKind.router = screenNodes.size;

  // ---- B7b': the pages a handler renders (RM48) ----------------------------
  //
  // The other kind of screen. A router declares a path and mounts a component;
  // a `@Controller` answers a path and names a view, and the view resolver turns
  // that name into a template file. Both are a screen; the id says which, so a
  // hybrid application's two kinds never collide.
  //
  //   screen:<route path>        the router declared it
  //   screen:view:<view name>    a handler rendered it
  //
  // A view name that resolves to no template this run read is a GAP with a name
  // on it, not a screen: a template root nobody declared, a suffix that is not
  // the one configured, a name built at run time.
  const pageEdges = [];
  const handlersOf = new Map(); // screen id -> the symbols that render it
  for (const [file, t] of templatesByFile) {
    stats.templates.files += 1;
    stats.templates.byEngine[t.engine] = (stats.templates.byEngine[t.engine] ?? 0) + 1;
    stats.templates.includes += includedBy(file).length;
  }
  stats.templates.rendered = renderedTemplates.size;
  if (screenEnabled) {
    // Which routes a handler serves, read off the graph the Java bridge built:
    // `endpoint --HANDLES--> symbol` is already there, and re-deriving it from
    // the facts would let the two disagree about the same method.
    const routesOfHandler = new Map();
    for (const e of g.edges) {
      if (e.type !== 'HANDLES') continue;
      const ep = g.nodes.get(e.from);
      if (!ep || ep.kind !== 'endpoint' || typeof ep.path !== 'string') continue;
      if (!routesOfHandler.has(e.to)) routesOfHandler.set(e.to, new Set());
      routesOfHandler.get(e.to).add(ep.path);
    }
    const unresolvedViews = new Map();
    for (const v of viewRecords) {
      stats.templates.views += 1;
      stats.templates.unresolvedViews += Number.isInteger(v.unresolved) ? v.unresolved : 0;
      const symbol = nodeId('symbol', `${v.owner}#${v.method}`);
      const paths = [...(routesOfHandler.get(symbol) ?? new Set())].sort();
      for (const view of v.views ?? []) {
        if (!view || typeof view.name !== 'string') continue;
        if (view.kind !== 'view') {
          // A REDIRECT IS NOT A PAGE, IT IS A ROUTE. `return "redirect:/catalog"`
          // sends the browser to another route of this same application, so it
          // is a call onto that route and is graded by the route match like any
          // other call. `forward:` is the same journey without the round trip.
          stats.templates.redirects += 1;
          if (!g.nodes.has(symbol)) continue;
          const full = normalizeUrl(view.name.split('?')[0]);
          if (!namesARoute(full)) continue;
          const found = matchUrl(full, 'GET');
          const evidence = {
            rule: 'view-redirect',
            basis: PAGE_RENDERS_BASIS.redirect,
            kind: view.kind,
            url: { written: view.name, template: full },
            method: { value: 'GET', from: 'redirect' },
            match: found.how,
            target: found.routes.length > 0 ? 'in-pack' : 'outside-pack',
          };
          if (found.routes.length === 0) {
            const epId = webEndpointId('GET', full);
            if (!g.nodes.has(epId) && !nodesToAdd.has(epId)) {
              nodesToAdd.set(epId, { id: epId, path: full, httpMethod: 'GET', outbound: true, source: 'web' });
              stats.outboundEndpoints += 1;
            }
            edges.push({ from: symbol, to: epId, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence });
            continue;
          }
          for (const r of found.routes.slice().sort((a, b) => cmp(a.id, b.id))) {
            edges.push({
              from: symbol, to: r.id, type: 'CALLS_HTTP', grade: 'SOUND_SET',
              evidence: found.routes.length > 1 ? { ...evidence, candidates: found.routes.length } : evidence,
            });
          }
          continue;
        }
        stats.templates.viewNames += 1;
        // A LEADING SLASH IS THE ROOT THE PREFIX ALREADY IS. `return
        // "/pages/index"` and `return "pages/index"` are the same view to every
        // resolver, because the prefix ends in one.
        const name = view.name.replace(/^\/+/, '');
        const file = templateByName.get(name);
        if (file === undefined) {
          unresolvedViews.set(view.name, (unresolvedViews.get(view.name) ?? 0) + 1);
          continue;
        }
        const t = templatesByFile.get(file);
        const id = nodeId('screen', `view:${name}`);
        let node = screenNodes.get(id);
        if (node === undefined) {
          const segments = name.split('/').filter((x) => x !== '');
          const label = pathRule === 'last-segment' ? (segments[segments.length - 1] ?? name) : name;
          let code = null;
          if (codeRegex) {
            const m = codeRegex.exec(name);
            if (m) code = m[1] ?? m[0];
          }
          node = {
            id,
            path: '',
            paths: [],
            name,
            title: null,
            label,
            code,
            group: code !== null && codeLength !== null
              ? code.slice(0, codeLength)
              : (segments.length > 1 ? segments[0] : SCREEN_ROOT_GROUP),
            component: null,
            template: file,
            engine: t.engine,
            file,
            line: 1,
            pack: null,
            params: false,
            lane: 'web',
            source: 'view',
            declaredAt: [],
          };
          screenNodes.set(id, node);
          stats.screens.byKind.page += 1;
        }
        for (const p of paths) if (!node.paths.includes(p)) node.paths.push(p);
        node.paths.sort();
        node.path = node.paths[0] ?? '';
        node.params = node.paths.some((p) => /[{*]/.test(p));
        node.declaredAt.push({ file: v.file, line: v.line ?? null });
        if (!handlersOf.has(id)) handlersOf.set(id, new Set());
        handlersOf.get(id).add(symbol);
        // THE HANDLER RENDERS THE PAGE, exactly. The literal it returned is the
        // resolver's own input, and joining the prefix and the suffix onto it is
        // what the resolver does; nothing here was matched by name or by shape.
        if (g.nodes.has(symbol)) {
          pageEdges.push({
            from: symbol, to: id, type: 'RENDERS_PAGE', grade: 'EXACT',
            evidence: {
              rule: 'view-name', view: name, from: view.from,
              // WHICH method of the handler's own class the name was read out
              // of, when it was not the handler itself.
              ...(typeof view.helper === 'string' ? { helper: view.helper } : {}),
              template: file, engine: t.engine, suffix: t.suffix, root: t.root,
              basis: view.from === 'helper' ? PAGE_RENDERS_BASIS.helper
                : view.from === 'constant' ? PAGE_RENDERS_BASIS.constant
                  : PAGE_RENDERS_BASIS.view,
            },
          });
        }
      }
    }
    stats.templates.viewNamesUnplaced = [...unresolvedViews.values()].reduce((n, x) => n + x, 0);
    stats.templates.unresolvedViewNames = [...unresolvedViews.entries()]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
  }
  for (const [id, symbols] of handlersOf) {
    const node = screenNodes.get(id);
    if (node) node.renderedBy = [...symbols].sort();
  }

  stats.screens.screens = screenNodes.size;
  stats.screens.unresolvedSpecifiers = [...unresolvedSpecifiers.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, 10)
    .map(([specifier, count]) => ({ specifier, count }));
  stats.screens.unresolvedNames = [...unresolvedNames.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // ---- B7c: RENDERS --------------------------------------------------------
  //
  // NOTHING HERE IS GUESSED FROM A NAME. A file the route declares is the
  // screen's own component (EXACT); a file that component IMPORTS is a
  // candidate child (SOUND_SET, with the import chain on the edge); a file
  // nobody imports is not a child at all.
  for (const e of pageEdges) edges.push(e);
  for (const id of [...screenNodes.keys()].sort()) {
    const node = screenNodes.get(id);
    nodesToAdd.set(id, node);
    // A PAGE'S OWN CODE IS ITS OWN FILE (RM48). Nothing imports a template and
    // nothing imports out of one: what the page runs is the scripts written in
    // it, and what it also runs is whatever the templates it INCLUDES do. So the
    // walk is over the include graph and over nothing else.
    if (node.source === 'view') {
      for (const sym of symbolsByFile.get(node.template) ?? []) {
        stats.screens.renders.EXACT += 1;
        edges.push({
          from: id, to: sym, type: 'RENDERS', grade: 'EXACT',
          evidence: { rule: 'template-own', component: node.template, basis: SCREEN_RENDERS_BASIS.own },
        });
      }
      for (const [child, depth] of [...includeClosure(node.template).entries()].sort((a, b) => cmp(a[0], b[0]))) {
        // The fragment itself, as one node: a reader asking "what does this page
        // pull in?" gets one answer per include, whether or not it holds code.
        const childId = nodeId('symbol', child);
        if (!nodesToAdd.has(childId)) {
          nodesToAdd.set(childId, {
            id: childId, symbol: child, file: child, line: 1, lane: 'web',
            exported: null, template: true, engine: templatesByFile.get(child)?.engine ?? null,
          });
        }
        stats.screens.renders.SOUND_SET += 1;
        edges.push({
          from: id, to: childId, type: 'RENDERS', grade: 'SOUND_SET',
          evidence: { rule: 'template-include', component: child, depth, basis: SCREEN_RENDERS_BASIS.include },
        });
        for (const sym of symbolsByFile.get(child) ?? []) {
          stats.screens.renders.SOUND_SET += 1;
          edges.push({
            from: id, to: sym, type: 'RENDERS', grade: 'SOUND_SET',
            evidence: { rule: 'template-include', component: child, depth, basis: SCREEN_RENDERS_BASIS.include },
          });
        }
      }
      continue;
    }
    // A SCREEN THAT RESOLVED BY NAME took a different road here (RM47): the
    // registry walk already knows every file, and following imports out of
    // those files would be following imports a frontend written before modules
    // does not have.
    const byRegistry = registryTargets.get(id);
    if (byRegistry !== undefined) {
      for (const t of byRegistry.slice().sort((a, b) => cmp(a.file, b.file) || cmp(a.rule, b.rule) || cmp(a.chain.join('>'), b.chain.join('>')))) {
        for (const sym of symbolsByFile.get(t.file) ?? []) {
          stats.screens.renders[t.grade] += 1;
          edges.push({
            from: id, to: sym, type: 'RENDERS', grade: t.grade,
            evidence: {
              rule: t.rule,
              component: t.file,
              names: t.chain,
              basis: t.grade === 'HEURISTIC' ? SCREEN_RENDERS_BASIS.ambiguous : SCREEN_RENDERS_BASIS.registry,
            },
          });
        }
      }
      continue;
    }
    const root = node.component;
    if (root === null) continue;
    for (const sym of symbolsByFile.get(root) ?? []) {
      stats.screens.renders.EXACT += 1;
      edges.push({
        from: id, to: sym, type: 'RENDERS', grade: 'EXACT',
        evidence: { rule: 'route-component', component: root, basis: SCREEN_RENDERS_BASIS.own },
      });
    }
    const seen = new Set([root]);
    let frontier = [[root]];
    for (let depth = 0; depth < RENDERS_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const via of frontier) {
        for (const child of componentChildrenOf(via[via.length - 1])) {
          if (seen.has(child)) continue; // a cycle, cut here
          seen.add(child);
          const chain = [...via, child];
          next.push(chain);
          for (const sym of symbolsByFile.get(child) ?? []) {
            stats.screens.renders.SOUND_SET += 1;
            edges.push({
              from: id, to: sym, type: 'RENDERS', grade: 'SOUND_SET',
              evidence: { rule: 'component-import', component: child, via: chain, basis: SCREEN_RENDERS_BASIS.child },
            });
          }
        }
      }
      frontier = next;
    }
  }

  // ---- write the graph, in a fixed order -----------------------------------
  for (const id of [...nodesToAdd.keys()].sort()) g.addNode(nodesToAdd.get(id));
  edges.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(JSON.stringify(a.evidence), JSON.stringify(b.evidence)));
  for (const e of edges) g.addEdge(e);

  // ---- the prefix census, per package --------------------------------------
  for (const inst of [...instanceOf.values()].sort((a, b) => cmp(a.id, b.id))) {
    const p = prefixOf(inst.id);
    const pkg = inst.package ?? '';
    if (!stats.prefix[pkg]) stats.prefix[pkg] = { instances: [] };
    stats.prefix[pkg].instances.push({
      id: inst.id, value: p.value, from: p.from, front: p.front ?? '',
      // Only when a declared route named one: an instance whose prefix nobody
      // declared has no service to name, and an always-present null would read
      // as "we looked and found nothing".
      ...(p.service ? { service: p.service } : {}),
      candidates: p.from === 'auto' ? p.candidates : [],
    });
  }
  stats.instances = [...instanceOf.values()].filter((i) => !i.id.endsWith('#(package)')).length;
  for (const site of sites) if (site.assumed) stats.assumedAliases += 1;
  stats.unmatchedUrls = [...unmatched.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, 15)
    .map(([url, count]) => ({ url, count }));
  return stats;
}

export class WebBridgeError extends Error {
  constructor(message) { super(message); this.name = 'WebBridgeError'; }
}
