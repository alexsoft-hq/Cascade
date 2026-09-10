// http.mjs — a tiny HTTP face over the SAME tool catalog the stdio MCP server
// uses (SPEC §13: both transports share one catalog so they cannot drift). This
// backs the local web viewer: the browser POSTs a tool call and gets back the
// exact contract-valid response the AI would get over stdio — no reimplemented
// query logic in the page, so the viewer can never disagree with the engine.
//
// `handleApi` is PURE (method, pathname, body, deps) → {status, json}: unit-
// testable with no sockets. `serveHttp` is a thin node:http loop around it that
// also serves the static viewer file, the page's own scripts, the two vendored
// browser bundles and the translation catalogues.

import fs from 'node:fs';
import path from 'node:path';

// The ONLY file types /vendor serves. An extension this table does not name is
// a 404 — the route is a shelf for two MIT bundles, the vendored web fonts and
// their licence texts, not a static file server pointed at a directory.
const VENDOR_TYPES = Object.freeze({
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
});
// How long a browser may keep each kind. A bundle can be replaced by an update
// under the SAME name, so it gets a day. A font file NEVER changes under its
// name — the name carries the family, the weight and the subset, and a new cut
// is a new file — so it is immutable for a year: the page then repaints on a
// reload without going back for a face it already has.
const VENDOR_CACHE = Object.freeze({
  '.woff2': 'public, max-age=31536000, immutable',
});
const VENDOR_CACHE_DEFAULT = 'public, max-age=86400';
const VENDOR_PREFIX = '/vendor/';

/**
 * Serve one file out of the viewer's vendor directory. Confined to that
 * directory by a RESOLVED-PATH prefix check (the same rule src/viewer/source.mjs
 * uses for the repo): `..`, an absolute path and a percent-encoded escape all
 * resolve outside the root and are refused — as a 404, so the route never
 * reports whether the file it refused exists.
 *
 * @param {string} method
 * @param {string} pathname  "/vendor/<name>"
 * @param {{vendorDir?:string, readFile?:(abs:string)=>Buffer|string}} deps
 * @returns {{status:number, headers:object, body:Buffer|string}}
 */
export function handleVendor(method, pathname, deps) {
  return serveFromDir({
    method,
    pathname,
    prefix: VENDOR_PREFIX,
    dir: deps && deps.vendorDir,
    types: VENDOR_TYPES,
    cacheFor: (ext) => (Object.hasOwn(VENDOR_CACHE, ext) ? VENDOR_CACHE[ext] : VENDOR_CACHE_DEFAULT),
    deps,
  });
}

/**
 * One file out of one directory, by the rule /vendor has always used: a GET, an
 * extension the route names, and a path that RESOLVES inside the root — `..`, an
 * absolute path and a percent-encoded escape all land outside it and are refused
 * as a 404, so the route never reports whether the file it refused exists.
 *
 * The three static routes are the same rule with different tables, so it is
 * written once here rather than three times.
 */
function serveFromDir({ method, pathname, prefix, dir, types, cacheFor, deps }) {
  if (method !== 'GET' && method !== 'HEAD') return vendorErr(405, `use GET for ${prefix}…`);
  if (!dir) return vendorErr(404, 'not found');
  if (!pathname.startsWith(prefix)) return vendorErr(404, 'not found');
  let name;
  try { name = decodeURIComponent(pathname.slice(prefix.length)); }
  catch { return vendorErr(404, 'not found'); } // a malformed %-escape names no file
  if (!name) return vendorErr(404, 'not found');
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot);
  if (!Object.hasOwn(types, ext)) return vendorErr(404, 'not found');
  const root = path.resolve(dir);
  const abs = path.resolve(root, name);
  if (abs !== root && !abs.startsWith(root + path.sep)) return vendorErr(404, 'not found'); // no escape
  const readFile = (deps && deps.readFile) || ((p) => fs.readFileSync(p));
  let body;
  try { body = readFile(abs); }
  catch { return vendorErr(404, 'not found'); }
  return { status: 200, headers: { 'content-type': types[ext], 'cache-control': cacheFor(ext) }, body };
}

function vendorErr(status, message) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: message };
}

// The ONLY file type /i18n serves. A translation catalogue is JSON and nothing
// else (SPEC §17.11).
const I18N_TYPES = Object.freeze({ '.json': 'application/json; charset=utf-8' });
const I18N_PREFIX = '/i18n/';

// The page's own scripts. `viewer/js/*.js` are classic scripts sharing one
// global scope, loaded in the numbered order their names make explicit, and
// they are served like the vendored bundles: a day of cache, one directory, no
// escaping it.
const VIEWER_JS_TYPES = Object.freeze({ '.js': 'application/javascript; charset=utf-8' });
const VIEWER_JS_PREFIX = '/viewer/js/';

// The two modules the page shares with the engine, served FROM the engine.
//
// The page cannot `import`: it is one global scope, and the modules under
// src/viewer/ are ES modules with their own tests. The page used to carry a
// verbatim COPY of each, kept in step by a drift test — which meant two places
// to edit and a test whose whole job was to notice when somebody edited one.
// Now there is one file, read at request time and served minus its `export `
// keywords, which is exactly the transform the copies were. There is nothing
// left to drift.
const VIEWER_LIB_PREFIX = '/viewer/lib/';
const VIEWER_LIB_MODULES = Object.freeze(['i18n', 'graphlayout', 'source']);

/**
 * One ES module as a classic script: the same text, minus the `export `
 * keywords. Nothing else changes — the names it declares land in the shared
 * global scope, which is how the page reaches them.
 */
export function classicSource(text) {
  return String(text).replace(/^export /gm, '');
}

// What the two mark routes answer with. A day of cache: the file can be
// replaced under the same name by an update, the way a bundle can.
const SVG_HEADERS = Object.freeze({
  'content-type': 'image/svg+xml; charset=utf-8',
  'cache-control': 'public, max-age=86400',
});

/**
 * Serve one translation catalogue out of the viewer's i18n directory
 * (`viewer/i18n/<lang>.json`). The page is English by default and fetches a
 * catalogue only when another language is chosen, so the translations are NOT
 * inlined in the page — which is also what lets the English-only gate keep
 * scanning `viewer/index.html` and `src/` for non-English text.
 *
 * Confined to that directory by the same RESOLVED-PATH prefix check /vendor
 * uses: `/i18n/../x`, an absolute path and a percent-encoded escape all resolve
 * outside the root and are refused as a 404.
 *
 * @param {string} method
 * @param {string} pathname  "/i18n/<lang>.json"
 * @param {{i18nDir?:string, readFile?:(abs:string)=>Buffer|string}} deps
 * @returns {{status:number, headers:object, body:Buffer|string}}
 */
export function handleI18n(method, pathname, deps) {
  return serveFromDir({
    method,
    pathname,
    prefix: I18N_PREFIX,
    dir: deps && deps.i18nDir,
    types: I18N_TYPES,
    // No cache: a translator editing ko.json wants a reload to show the edit.
    cacheFor: () => 'no-cache',
    deps,
  });
}

/**
 * Serve one of the page's own scripts out of `viewer/js`. Same rule as /vendor,
 * same day of cache: these files change when the engine is updated, under the
 * same names.
 *
 * @param {string} method
 * @param {string} pathname  "/viewer/js/<name>.js"
 * @param {{viewerJsDir?:string, readFile?:(abs:string)=>Buffer|string}} deps
 */
export function handleViewerJs(method, pathname, deps) {
  return serveFromDir({
    method,
    pathname,
    prefix: VIEWER_JS_PREFIX,
    dir: deps && deps.viewerJsDir,
    types: VIEWER_JS_TYPES,
    cacheFor: () => VENDOR_CACHE_DEFAULT,
    deps,
  });
}

/**
 * Serve one module of `src/viewer/` as a classic script.
 *
 * NOT a directory: the three names are listed above, and anything else is a
 * 404. `src/viewer/` is engine source, not a shelf of files to hand out, so the
 * route answers by NAME rather than by path — there is no traversal to defend
 * against because there is no path to traverse.
 *
 * @param {string} method
 * @param {string} pathname  "/viewer/lib/<name>.js"
 * @param {{viewerLibDir?:string, readFile?:(abs:string)=>Buffer|string}} deps
 */
export function handleViewerLib(method, pathname, deps) {
  if (method !== 'GET' && method !== 'HEAD') return vendorErr(405, `use GET for ${VIEWER_LIB_PREFIX}…`);
  const dir = deps && deps.viewerLibDir;
  if (!dir) return vendorErr(404, 'not found');
  if (!pathname.startsWith(VIEWER_LIB_PREFIX)) return vendorErr(404, 'not found');
  const name = pathname.slice(VIEWER_LIB_PREFIX.length);
  if (!name.endsWith('.js')) return vendorErr(404, 'not found');
  const stem = name.slice(0, -'.js'.length);
  if (!VIEWER_LIB_MODULES.includes(stem)) return vendorErr(404, 'not found');
  const readFile = (deps && deps.readFile) || ((p) => fs.readFileSync(p, 'utf8'));
  let text;
  try { text = readFile(path.join(path.resolve(dir), `${stem}.mjs`)); }
  catch { return vendorErr(404, 'not found'); }
  return {
    status: 200,
    headers: { 'content-type': VIEWER_JS_TYPES['.js'], 'cache-control': VENDOR_CACHE_DEFAULT },
    body: classicSource(String(text)),
  };
}

/**
 * The uniform error model of SPEC §17.4, as HTTP statuses. Input errors, data
 * that cannot be served, and server defects are kept apart — an AI (or a page)
 * reading a 409 knows to ask again with a `project`, where a 500 means the
 * server is broken and asking again will not help.
 */
const ERROR_STATUS = Object.freeze({
  'bad-input': 400,
  'bad-request': 400,
  'unknown-tool': 400,   // a name no catalog has is a client mistake, not a missing resource
  ambiguous: 409,
  'pack-unreadable': 503,
  'overlay-stale': 409,
  'db-connect-error': 503,
  'contract-violation': 500,
});

/** The HTTP status for a dispatch error code (§17.4). */
export function statusForCode(code) {
  if (Object.hasOwn(ERROR_STATUS, code)) return ERROR_STATUS[code];
  // Every other `unknown-<thing>` (column, table, key, …) is a missing resource.
  if (String(code).startsWith('unknown-')) return 404;
  return 500;
}

/** The `project` a request names: a query parameter (GET) or a body field (POST). */
function projectOf(body, query) {
  const fromQuery = query && (typeof query.get === 'function' ? query.get('project') : query.project);
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (body && typeof body === 'object') {
    if (typeof body.project === 'string' && body.project.length > 0) return body.project;
    const args = body.arguments;
    if (args && typeof args === 'object' && typeof args.project === 'string' && args.project.length > 0) return args.project;
  }
  return null;
}

/**
 * Route one API request. Pure.
 * @param {string} method  HTTP method
 * @param {string} pathname  e.g. "/api/tools" or "/api/call"
 * @param {object|null} body  parsed JSON request body (for POST)
 * @param {{toolList:()=>object, callTool:(name:string,args:object)=>object}} deps
 * @returns {{status:number, json:object}}
 */
export function handleApi(method, pathname, body, deps, query) {
  // Which project the request is about, if it says: `?project=` on a GET,
  // `body.project` (or `body.arguments.project`) on a POST. A single-project
  // server ignores it; a multi-project one refuses to guess without it (409).
  const project = projectOf(body, query);
  if (pathname === '/api/source') {
    if (method !== 'GET') return err(405, 'method-not-allowed', 'use GET for /api/source');
    const node = query && (typeof query.get === 'function' ? query.get('node') : query.node);
    if (!node) return err(400, 'bad-request', 'node query param required');
    if (typeof deps.source !== 'function') return err(404, 'not-found', 'source preview not available (no repo path in this pack)');
    // `?whole=1` asks for the file around the snippet rather than the snippet
    // alone. It is the same answer with more text in it: the line range the
    // preview is about does not move.
    const wholeArg = query && (typeof query.get === 'function' ? query.get('whole') : query.whole);
    const whole = wholeArg === '1' || wholeArg === 'true';
    try { return { status: 200, json: deps.source(node, project, { whole }) }; }
    catch (e) { return dispatchErr(e, 'source-error', 'source read failed'); }
  }
  if (pathname === '/api/meta') {
    if (method !== 'GET') return err(405, 'method-not-allowed', 'use GET for /api/meta');
    try { return { status: 200, json: (deps.meta && deps.meta(project)) || {} }; }
    catch (e) { return dispatchErr(e, 'meta-error', 'meta failed'); }
  }
  if (pathname === '/api/tools') {
    if (method !== 'GET') return err(405, 'method-not-allowed', 'use GET for /api/tools');
    return { status: 200, json: deps.toolList() };
  }
  if (pathname === '/api/projects') {
    // The registry listing, through the SAME dispatcher the AI calls over stdio
    // (§13: one catalog, two transports) — so the page and the model cannot be
    // told different things about which projects exist.
    if (method !== 'GET') return err(405, 'method-not-allowed', 'use GET for /api/projects');
    try { return { status: 200, json: deps.callTool('projects', {}) }; }
    catch (e) { return dispatchErr(e, 'error', 'projects failed'); }
  }
  if (pathname === '/api/call') {
    if (method !== 'POST') return err(405, 'method-not-allowed', 'use POST for /api/call');
    if (!body || typeof body !== 'object') return err(400, 'bad-request', 'JSON body required');
    const name = body.name;
    const args = { ...(body.arguments || {}), ...(project ? { project } : {}) };
    if (typeof name !== 'string' || !name) return err(400, 'bad-request', 'body.name (string) required');
    try {
      // Same dispatcher as stdio: a tool/dispatch failure carries a .code. We
      // surface it as a structured error the page renders — never a 200 with a
      // silent empty answer.
      const result = deps.callTool(name, args);
      return { status: 200, json: result };
    } catch (e) {
      return dispatchErr(e, 'error', 'tool failed');
    }
  }
  return err(404, 'not-found', `no route: ${method} ${pathname}`);
}

/** A thrown dispatch/tool error as structured JSON with its §17.4 status. */
function dispatchErr(e, fallbackCode, fallbackMessage) {
  const code = (e && e.code) || fallbackCode;
  // A plain Error (no code) from a dep is a server defect: 500 with its message.
  const status = e && e.code ? statusForCode(code) : 500;
  return err(status, code, (e && e.message) || fallbackMessage);
}

function err(status, code, message) {
  return { status, json: { error: { code, message } } };
}

/**
 * Serve the API + the static viewer over HTTP.
 * @param {{http:object, port?:number, host?:string, deps:object, html:string, mark?:string, markDark?:string}} cfg
 *   http: the node:http module; deps: {toolList, callTool, meta?, source?, vendorDir?,
 *   i18nDir?, viewerJsDir?, viewerLibDir?};
 *   html: viewer page; mark / markDark: the SVG of the Cascade mark for a light
 *   and for a dark ground, served at `/cascade-mark.svg` and
 *   `/cascade-mark-dark.svg`. All three are STRINGS held in memory and answered
 *   by an exact name: there is no directory behind any of these routes, so
 *   nothing else on disk is reachable through them.
 * The promise resolves with the port the socket really got, not the one that was
 * asked for. They differ exactly where it matters: `--port 0` asks the kernel for
 * a free port, and printing the 0 back gave a URL nobody could open.
 *
 * @returns {Promise<{server:object, port:number}>}
 */
export function serveHttp({ http, port = 4319, host = '127.0.0.1', deps, html, mark = null, markDark = null }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${host}`);
      const pathname = url.pathname;
      if (pathname.startsWith('/api/')) {
        collectBody(req, (body) => {
          let parsed = null;
          if (body) { try { parsed = JSON.parse(body); } catch { return send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ error: { code: 'bad-request', message: 'invalid JSON body' } })); } }
          const out = handleApi(req.method, pathname, parsed, deps, url.searchParams);
          send(res, out.status, { 'content-type': 'application/json' }, JSON.stringify(out.json));
        });
        return;
      }
      if (pathname === '/vendor' || pathname.startsWith(VENDOR_PREFIX)) {
        const out = handleVendor(req.method, pathname, deps);
        return send(res, out.status, out.headers, out.body);
      }
      if (pathname === '/i18n' || pathname.startsWith(I18N_PREFIX)) {
        const out = handleI18n(req.method, pathname, deps);
        return send(res, out.status, out.headers, out.body);
      }
      if (pathname.startsWith(VIEWER_JS_PREFIX)) {
        const out = handleViewerJs(req.method, pathname, deps);
        return send(res, out.status, out.headers, out.body);
      }
      if (pathname.startsWith(VIEWER_LIB_PREFIX)) {
        const out = handleViewerLib(req.method, pathname, deps);
        return send(res, out.status, out.headers, out.body);
      }
      if (pathname === '/' || pathname === '/index.html') {
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, html);
      }
      // The mark, as a file, for anything that cannot inline it (a README
      // rendered elsewhere, a slide, a link) — one for a light ground and one
      // for a dark one, because the dark variant is a different drawing, not a
      // recolouring the browser could do for itself. The page does not fetch
      // either: it carries the same geometry as an inline <symbol> and a
      // data-URI favicon, so a machine with no network still sees the mark.
      if (pathname === '/cascade-mark.svg' && mark != null) {
        return send(res, 200, SVG_HEADERS, mark);
      }
      if (pathname === '/cascade-mark-dark.svg' && markDark != null) {
        return send(res, 200, SVG_HEADERS, markDark);
      }
      send(res, 404, { 'content-type': 'text/plain' }, 'not found');
    });
    server.listen(port, host, () => resolve({ server, port: boundPort(server, port) }));
  });
}

/**
 * The port the socket REALLY got. `address()` is the only thing that knows it:
 * with `--port 0` the kernel picks one, and resolving with the requested 0 gave
 * every caller a URL nobody could open.
 *
 * An injected http module (the tests use one, so the routes can be driven with no
 * socket at all) has no address to give, and there the requested port is all
 * there is.
 */
function boundPort(server, port) {
  const bound = typeof server.address === 'function' ? server.address() : null;
  return bound && typeof bound.port === 'number' ? bound.port : port;
}

function collectBody(req, cb) {
  let buf = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { buf += c; if (buf.length > (1 << 24)) req.destroy(); });
  req.on('end', () => cb(buf));
  req.on('error', () => cb(''));
}
function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}
