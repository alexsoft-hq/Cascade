// har_bridge.mjs — a browser recording as RUNTIME EVIDENCE on the screen axis
// (SPEC §8.2, the RUNTIME_ONLY grade; RM30 §E).
//
// A HAR file is what the browser saw: the page that was open, and every request
// it sent. That is a different KIND of fact from everything else in this engine,
// and it is treated as one:
//
//   - It is SHOWN, never WALKED. Every edge this bridge writes is RUNTIME_ONLY,
//     which sits below the floor of every query mode (src/core/graph.mjs), so no
//     chain, impact or census walk follows it. A recording proves that a request
//     happened once; it proves nothing about what the code can do.
//   - It never RAISES a grade. Where the static analysis already found the same
//     screen calling the same endpoint, that edge is left exactly as it was and
//     the tools say `observed: true` beside it.
//   - It is never DISCOVERED. `cascade analyze --har <file>` or the profile's
//     `runtimeEvidence.har` is a person saying "I recorded this on purpose";
//     nothing here goes looking for a .har in the tree.
//
// WHAT IT MATCHES. A recorded request carries the FRONTEND prefix (the address
// the browser really asked for, `/dev-api/system/user/list`), and the routes in
// the graph carry the BACKEND path. So the front prefix is stripped and the back
// prefix applied, using the very prefix decisions the web bridge made for that
// package — declared, then derived, then auto, in that order. An entry that
// matches nothing is COUNTED BY PATH, never dropped: a recording that lands
// nowhere is usually a prefix nobody declared, and the list is how a reader
// finds that out.
//
// Pure: records in, graph mutated, statistics out. `readHar` is the one function
// that touches text, and it takes the text, not a path.

import { routeMatches, webScreenId, normalizeUrlPath } from './web_bridge.mjs';

/**
 * Extensions that mean "the browser fetched a file, not an API".
 * Skipped and counted apart, so a recording of one screen does not report two
 * hundred unmatched paths that were only the bundle.
 */
export const HAR_ASSET_EXTENSIONS = Object.freeze(['.js', '.css', '.png', '.woff2', '.map', '.ico', '.svg']);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The path of a request URL: no origin, no query, no fragment. */
export function requestPathOf(url) {
  let s = String(url ?? '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  const cut = Math.min(...['?', '#'].map((c) => (s.indexOf(c) < 0 ? s.length : s.indexOf(c))));
  return normalizeUrlPath(s.slice(0, cut));
}

/**
 * The ROUTE a page URL names.
 *
 * A single-page app in hash mode puts its route in the fragment
 * (`https://example.com/#/things/list`), so the fragment IS the screen path there. In
 * history mode the path is the route. Both are read, because which one a
 * project uses is a router setting this bridge cannot see.
 */
export function pageRoutePathOf(url) {
  const s = String(url ?? '');
  const hash = s.indexOf('#');
  if (hash >= 0) {
    const frag = s.slice(hash + 1);
    if (frag.startsWith('/')) return requestPathOf(frag);
  }
  return requestPathOf(s);
}

/** Whether a request path is a static asset rather than an API call. */
export function isAssetPath(p) {
  const last = String(p).slice(String(p).lastIndexOf('/') + 1).toLowerCase();
  return HAR_ASSET_EXTENSIONS.some((e) => last.endsWith(e));
}

/**
 * Whether a SCREEN path template matches a path the browser was on.
 * A `:id` segment stands for one segment (`:path(.*)` included), `*` for the
 * rest. This is the router's own spelling, which is not the backend's `{id}`,
 * so it has its own matcher rather than borrowing the route one.
 */
export function screenPathMatches(template, actual) {
  const t = normalizeUrlPath(template).split('/');
  const a = normalizeUrlPath(actual).split('/');
  for (let i = 0; i < t.length; i += 1) {
    const seg = t[i];
    if (seg === '*' || seg === '**') return true;
    if (i >= a.length) return false;
    if (seg.startsWith(':')) continue;
    if (seg !== a[i]) return false;
  }
  return t.length === a.length;
}

/**
 * Read one HAR document. Text in, a plain summary out — no filesystem here, so
 * the caller decides what a path means (SPEC §4).
 *
 * @param {string} text  the file's bytes as UTF-8
 * @param {{file?:string}} [opts]  the name to put on the evidence
 * @returns {{file:string, pages:{id:string,title:string|null,path:string|null}[],
 *            entries:{pageref:string|null, method:string, path:string, at:string|null}[],
 *            unreadable:string|null}}
 */
export function readHar(text, opts = {}) {
  const file = typeof opts.file === 'string' ? opts.file : '(har)';
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (e) {
    return { file, pages: [], entries: [], unreadable: `not JSON: ${e.message}` };
  }
  const log = doc && typeof doc === 'object' ? doc.log : null;
  if (!log || typeof log !== 'object' || !Array.isArray(log.entries)) {
    return { file, pages: [], entries: [], unreadable: 'no log.entries array, so this is not a HAR 1.2 recording' };
  }
  const entries = [];
  for (const e of log.entries) {
    if (!e || typeof e !== 'object') continue;
    const req = e.request && typeof e.request === 'object' ? e.request : null;
    if (!req || typeof req.url !== 'string') continue;
    entries.push({
      pageref: typeof e.pageref === 'string' ? e.pageref : null,
      method: typeof req.method === 'string' ? req.method.toUpperCase() : 'GET',
      path: requestPathOf(req.url),
      url: req.url,
      mimeType: e.response && e.response.content && typeof e.response.content.mimeType === 'string'
        ? e.response.content.mimeType : '',
      at: typeof e.startedDateTime === 'string' ? e.startedDateTime : null,
    });
  }
  // THE PAGE'S OWN URL, which the HAR format does not state. `log.pages[]`
  // carries an id and a title and no address, so the address is read from the
  // entries: the first one of that page whose response is HTML is the document
  // the browser navigated to, and where nothing says HTML the first entry of the
  // page is the best a recording can offer.
  const pages = [];
  for (const p of Array.isArray(log.pages) ? log.pages : []) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') continue;
    const mine = entries.filter((e) => e.pageref === p.id);
    const doc0 = mine.find((e) => /text\/html/i.test(e.mimeType)) ?? mine[0] ?? null;
    pages.push({
      id: p.id,
      title: typeof p.title === 'string' ? p.title : null,
      path: doc0 ? pageRoutePathOf(doc0.url) : null,
    });
  }
  return { file, pages, entries, unreadable: null };
}

/**
 * The (front prefix, back prefix) pairs a recorded path is tried against, in
 * the order the web bridge itself decided them: declared, then derived, then
 * auto, then the identity. Built from `laneStats.web.prefix`, so there is ONE
 * prefix decision in the engine and this bridge reuses it rather than making a
 * second one.
 *
 * @param {Object} prefixCensus  `laneStats.web.prefix`
 * @returns {{front:string, back:string, from:string}[]}
 */
export function prefixRules(prefixCensus) {
  const rank = { declared: 0, derived: 1, auto: 2, none: 3 };
  const out = [];
  const seen = new Set();
  for (const p of Object.values(prefixCensus ?? {})) {
    for (const i of p.instances ?? []) {
      const rule = { front: String(i.front ?? ''), back: String(i.value ?? ''), from: String(i.from ?? 'none') };
      const key = `${rule.front}|${rule.back}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rule);
    }
  }
  if (!seen.has('|')) out.push({ front: '', back: '', from: 'none' });
  // Longest front prefix first within a rank, so `/api/v2` is tried before
  // `/api` and the more specific reading wins.
  out.sort((a, b) => (rank[a.from] ?? 9) - (rank[b.from] ?? 9)
    || b.front.length - a.front.length || cmp(a.front, b.front) || cmp(a.back, b.back));
  return out;
}

/**
 * Attach the recordings to a graph that already holds this pack's routes and
 * (usually) its screens.
 *
 * @param {import('../core/graph.mjs').Graph} g
 * @param {ReturnType<typeof readHar>[]} recordings
 * @param {{prefix?:Object}} [opts]  `prefix` is `laneStats.web.prefix`
 * @returns {{files:number, entries:number, matched:number, unmatched:number,
 *            assets:number, pagesWithoutScreen:number, pairs:number,
 *            screensObserved:number, endpointsObserved:number,
 *            unmatchedPaths:{method:string, path:string, count:number}[],
 *            unreadable:{file:string, reason:string}[]}}
 */
export function addHarFacts(g, recordings, opts = {}) {
  const rules = prefixRules(opts.prefix);
  const stats = {
    files: 0,
    entries: 0,
    matched: 0,
    unmatched: 0,
    assets: 0,
    pagesWithoutScreen: 0,
    pairs: 0,
    screensObserved: 0,
    endpointsObserved: 0,
    unmatchedPaths: [],
    unreadable: [],
  };

  // The routes this pack SERVES, keyed the way the web bridge keys them.
  const routesByPath = new Map();
  const allRoutes = [];
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound === true || typeof n.path !== 'string') continue;
    const p = normalizeUrlPath(n.path);
    if (!routesByPath.has(p)) { routesByPath.set(p, []); allRoutes.push(p); }
    routesByPath.get(p).push({ id: n.id, httpMethod: n.httpMethod ?? 'ANY' });
  }
  allRoutes.sort();

  // The screens the router declared, longest path first so `/a/b` wins over a
  // `/a/:x` that would also swallow it.
  const screens = [];
  for (const n of g.nodes.values()) {
    if (n.kind !== 'screen' || typeof n.path !== 'string') continue;
    screens.push({ id: n.id, path: n.path });
  }
  screens.sort((a, b) => b.path.length - a.path.length || cmp(a.path, b.path));

  const methodOk = (r, method) => r.httpMethod === 'ANY' || r.httpMethod === method;
  const matchServed = (recordedPath, method) => {
    for (const rule of rules) {
      let rest = recordedPath;
      if (rule.front !== '') {
        if (recordedPath !== rule.front && !recordedPath.startsWith(`${rule.front}/`)) continue;
        rest = recordedPath.slice(rule.front.length);
      }
      const full = normalizeUrlPath(`${rule.back}${normalizeUrlPath(rest)}`);
      const exact = (routesByPath.get(full) ?? []).filter((r) => methodOk(r, method));
      if (exact.length > 0) return { route: exact[0], via: rule, path: full };
      for (const rp of allRoutes) {
        if (rp === full || !routeMatches(rp, full)) continue;
        const hit = routesByPath.get(rp).filter((r) => methodOk(r, method));
        if (hit.length > 0) return { route: hit[0], via: rule, path: full };
      }
    }
    return null;
  };

  const pairs = new Map(); // `${screenId}|${endpointId}` -> accumulator
  const newScreens = new Map(); // screen id -> node
  const unmatched = new Map();
  const observedScreens = new Set();
  const observedEndpoints = new Set();

  const list = Array.isArray(recordings) ? recordings : [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    stats.files += 1;
    if (rec.unreadable) {
      stats.unreadable.push({ file: rec.file, reason: rec.unreadable });
      continue;
    }
    // Which screen each page id belongs to, decided once per page.
    const screenOfPage = new Map();
    for (const p of rec.pages) {
      if (typeof p.path !== 'string' || p.path === '') continue;
      const hit = screens.find((s) => screenPathMatches(s.path, p.path));
      if (hit) { screenOfPage.set(p.id, hit.id); continue; }
      // A PAGE THE SOURCE NEVER DECLARED. The browser really was there, so it
      // becomes a screen of its own, marked as coming from the recording and
      // rendering nothing: no source line says which component it mounts.
      const id = webScreenId(p.path);
      screenOfPage.set(p.id, id);
      if (!g.nodes.has(id) && !newScreens.has(id)) {
        const segments = p.path.split('/').filter((s) => s !== '');
        newScreens.set(id, {
          id,
          path: p.path,
          name: null,
          title: p.title ?? null,
          label: p.path,
          code: null,
          group: segments[0] ?? '(root)',
          component: null,
          file: null,
          line: null,
          pack: null,
          params: false,
          lane: 'web',
          source: 'har',
          observed: true,
          declaredAt: [],
        });
        stats.pagesWithoutScreen += 1;
      }
    }
    for (const e of rec.entries) {
      stats.entries += 1;
      if (isAssetPath(e.path)) { stats.assets += 1; continue; }
      const found = matchServed(e.path, e.method);
      if (!found) {
        stats.unmatched += 1;
        // BY PATH, and by the method with it: `GET /thing` and `POST /thing`
        // are two different requests, and a reader fixing a prefix needs both.
        const key = `${e.method} ${e.path}`;
        unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        continue;
      }
      stats.matched += 1;
      const screenId = e.pageref !== null ? screenOfPage.get(e.pageref) ?? null : null;
      if (screenId === null) continue; // a request with no page: matched, and on no screen
      const key = `${screenId}|${found.route.id}`;
      let acc = pairs.get(key);
      if (!acc) {
        acc = {
          screen: screenId, endpoint: found.route.id, file: rec.file, count: 0,
          firstSeen: e.at, lastSeen: e.at, methods: new Set(),
        };
        pairs.set(key, acc);
      }
      acc.count += 1;
      acc.methods.add(e.method);
      if (e.at !== null) {
        if (acc.firstSeen === null || e.at < acc.firstSeen) acc.firstSeen = e.at;
        if (acc.lastSeen === null || e.at > acc.lastSeen) acc.lastSeen = e.at;
      }
      observedScreens.add(screenId);
      observedEndpoints.add(found.route.id);
    }
  }

  for (const id of [...newScreens.keys()].sort()) g.addNode(newScreens.get(id));
  for (const key of [...pairs.keys()].sort()) {
    const a = pairs.get(key);
    g.addEdge({
      from: a.screen,
      to: a.endpoint,
      type: 'CALLS_HTTP',
      grade: 'RUNTIME_ONLY',
      evidence: {
        rule: 'har',
        file: a.file,
        count: a.count,
        firstSeen: a.firstSeen,
        lastSeen: a.lastSeen,
        methods: [...a.methods].sort(),
      },
    });
    stats.pairs += 1;
  }
  // `observed` on BOTH ends, because both questions get asked: "was this screen
  // ever opened?" and "did anything really call this route?".
  for (const id of [...observedScreens].sort()) if (g.nodes.has(id)) g.addNode({ id, observed: true });
  for (const id of [...observedEndpoints].sort()) if (g.nodes.has(id)) g.addNode({ id, observed: true });
  stats.screensObserved = observedScreens.size;
  stats.endpointsObserved = observedEndpoints.size;
  stats.unmatchedPaths = [...unmatched.entries()]
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .slice(0, 15)
    .map(([key, count]) => {
      const sp = key.indexOf(' ');
      return { method: key.slice(0, sp), path: key.slice(sp + 1), count };
    });
  return stats;
}

export class HarBridgeError extends Error {
  constructor(message) { super(message); this.name = 'HarBridgeError'; }
}
