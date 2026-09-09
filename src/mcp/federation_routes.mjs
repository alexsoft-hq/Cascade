// federation_routes.mjs — the route sidecar, and the rule that decides which
// project answers one call.
//
// WHAT THIS MODULE OWNS. Everything a crossing needs BEFORE anything is walked:
//   the sidecar     `routes.json` beside a pack: what that project SERVES and
//                   what it CALLS out to, written at analyze time and read by a
//                   server that holds several projects
//   the match       whether a call and a route are the same route, whether a
//                   project's own service names answer to the name a call
//                   carries, and which of several candidates is chosen
//   the census      every call that leaves a pack, with the code that makes it
//
// WHAT IT MUST NEVER KNOW ABOUT: the walk, the lanes, the answer's shape. It is
// an index and a comparison; nothing here reaches into another project's graph.
//
// The route MATCH itself is `src/adapters/http_routes.mjs`'s, because the web
// lane asks the same question of a browser call: two rules would mean two
// answers for one url.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeUrlPath, routeMatches } from '../adapters/http_routes.mjs';

/** The sidecar's schema id. Written by `analyze`, read by the server. */
export const ROUTES_SCHEMA = 'cascade-routes/1';
/** Its file name, beside `pack.json`. */
export const ROUTES_FILE = 'routes.json';


export const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
export const weaker = (a, b) => (RANK[a] <= RANK[b] ? a : b);
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const strip = (id) => String(id).slice(String(id).indexOf(':') + 1);

// ---------------------------------------------------------------------------
// The sidecar
// ---------------------------------------------------------------------------

/**
 * The routes index for one pack: what it SERVES, what it CALLS and does not
 * serve, and the service names it answers to.
 *
 * Derived from the graph, so it is NOT an input to the pack digest (I-9: the
 * cold digest and the incremental digest must stay equal, and a file derived
 * from the result cannot be allowed to change the result). It carries the
 * digest of the pack it was derived from instead, and the server refuses a
 * sidecar that no longer describes the pack it loads.
 *
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {{project:string, buildDigest:string, serviceNames?:string[]}} meta
 * @returns {{schema:string, project:(string|null), buildDigest:(string|null),
 *            serves:{id:string, method:string, path:string}[],
 *            calls:{id:string, method:string, path:string, service:(string|null)}[],
 *            serviceNames:string[]}}
 */
export function buildRoutesIndex(graph, meta = {}) {
  const serves = [];
  const calls = [];
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    const method = methodOf(n);
    const routePath = pathOf(n);
    if (graph.outEdges(n.id).some((e) => e.type === 'HANDLES')) {
      serves.push({ id: n.id, method, path: routePath });
      continue;
    }
    // A route this pack CALLS and does not serve. The lane marked the node
    // `outbound` and put an UNRESOLVED CALLS_HTTP edge on it, and both are
    // required here: a stub node nothing calls belongs in neither list.
    if (n.outbound !== true) continue;
    const services = new Set();
    let called = false;
    for (const e of graph.inEdges(n.id)) {
      if (e.type !== 'CALLS_HTTP' || e.grade !== 'UNRESOLVED') continue;
      called = true;
      const s = serviceOf(graph, e.idx);
      if (s) services.add(s);
    }
    if (!called) continue;
    // Two callers naming two different services for one route is not a name we
    // may pick from: it is a name we do not know.
    calls.push({ id: n.id, method, path: routePath, service: services.size === 1 ? [...services][0] : null });
  }
  serves.sort((a, b) => cmp(a.id, b.id));
  calls.sort((a, b) => cmp(a.id, b.id));
  const names = [...new Set((meta.serviceNames ?? []).filter((s) => typeof s === 'string' && s.length > 0))].sort();
  return {
    schema: ROUTES_SCHEMA,
    project: meta.project ?? null,
    buildDigest: meta.buildDigest ?? null,
    serves,
    calls,
    serviceNames: names,
  };
}

/** The sidecar as bytes: sorted by construction, so two builds write one file. */
export function serializeRoutesIndex(index) {
  return JSON.stringify(index) + '\n';
}

/**
 * Read one project's sidecar.
 * @param {string} packDir the directory `pack.json` sits in
 * @param {{existsSync:Function, readFileSync:Function}} [io]
 * @returns {{ok:true, index:object}|{ok:false, reason:'no-index'|'unreadable', detail:string}}
 */
export function readRoutesIndex(packDir, io = fs) {
  const file = path.join(packDir, ROUTES_FILE);
  if (!io.existsSync(file)) {
    return { ok: false, reason: 'no-index', detail: `no ${ROUTES_FILE} beside the pack at ${packDir}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'unreadable', detail: `${file} could not be parsed: ${(e && e.message) || e}` };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== ROUTES_SCHEMA) {
    return { ok: false, reason: 'unreadable', detail: `${file} is not a ${ROUTES_SCHEMA} document` };
  }
  if (!Array.isArray(parsed.serves) || !Array.isArray(parsed.calls)) {
    return { ok: false, reason: 'unreadable', detail: `${file} carries no serves and calls lists` };
  }
  return { ok: true, index: parsed };
}

/**
 * One route of THIS pack, as the crossing rules want it: the node id, the
 * method, and the path spelled the one way both sides key a path by.
 * @param {{id:string, httpMethod?:(string|null), path?:(string|null)}} row  an answer row (id is stripped)
 * @param {object} [extra]  whatever the caller has to carry with it (hops, grade)
 */
export function routeRef(row, extra = {}) {
  const key = String(row.id);
  return {
    id: `endpoint:${key}`,
    method: typeof row.httpMethod === 'string' && row.httpMethod.length > 0 ? row.httpMethod : 'ANY',
    path: normalizeUrlPath(row.path ?? key.replace(/^\S+\s+/, '')),
    ...extra,
  };
}

export const methodOf = (n) => (typeof n.httpMethod === 'string' && n.httpMethod.length > 0 ? n.httpMethod : 'ANY');
export const pathOf = (n) => normalizeUrlPath(n.path ?? strip(n.id).replace(/^\S+\s+/, ''));
function serviceOf(graph, edgeIdx) {
  const ev = graph.edgeAt(edgeIdx)?.evidence ?? null;
  return ev && typeof ev.service === 'string' && ev.service.length > 0 ? ev.service : null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Whether a route's method can answer a call's method, and how strongly.
 *
 * `ANY` on either side is the web lane's own rule for a call whose verb the
 * worker could not read: the match is real but it was made on the path alone,
 * so it is HEURISTIC, which is below the conservative floor everywhere else in
 * this engine and says exactly the same thing here.
 *
 * @returns {'SOUND_SET'|'HEURISTIC'|null} null when the two methods cannot meet
 */
export function methodMatch(routeMethod, callMethod) {
  const r = routeMethod == null || routeMethod === '' ? 'ANY' : String(routeMethod);
  const c = callMethod == null || callMethod === '' ? 'ANY' : String(callMethod);
  if (r === c && r !== 'ANY') return 'SOUND_SET';
  if (r === 'ANY' || c === 'ANY') return 'HEURISTIC';
  return null;
}

/**
 * The best route in ONE project's index for one call: an exact path first, then
 * a template match, then the stronger method rule, then the path itself.
 * @returns {{route:object, grade:string}|null}
 */
function bestRouteIn(index, call) {
  let best = null;
  for (const r of index.serves ?? []) {
    const grade = methodMatch(r.method, call.method);
    if (!grade) continue;
    if (!(r.path === call.path || routeMatches(r.path, call.path))) continue;
    const exact = r.path === call.path;
    if (!best
      || (exact && !best.exact)
      || (exact === best.exact && RANK[grade] > RANK[best.grade])
      || (exact === best.exact && grade === best.grade && cmp(r.path, best.route.path) < 0)) {
      best = { route: r, grade, exact };
    }
  }
  return best ? { route: best.route, grade: best.grade } : null;
}

/** Does this project answer to the service name the call's evidence carried? */
function answersTo(entry, service) {
  if (!entry || !service) return false;
  if (entry.id === service) return true;
  if (entry.index && entry.index.project === service) return true;
  return !!(entry.index && Array.isArray(entry.index.serviceNames) && entry.index.serviceNames.includes(service));
}

/**
 * WHICH PROJECTS COULD SERVE THIS CALL.
 *
 * One candidate is crossed at the grade the method rule gave. Several are
 * crossed to ALL of them at HEURISTIC unless the call's own service name picks
 * exactly one, which is the only thing in the evidence that can.
 *
 * @param {{method:string, path:string, service:(string|null)}} call
 * @param {{id:string, index:(object|null)}[]} entries  the projects to consider
 * @param {{exclude?:string}} [opts]  the project the call is made FROM
 * @returns {{chosen:{project:string, route:object, grade:string}[],
 *            candidates:{project:string, route:object, grade:string}[],
 *            ambiguous:boolean, checked:number, noIndex:number}}
 */
export function serversOf(call, entries, opts = {}) {
  const exclude = opts.exclude ?? null;
  const candidates = [];
  let checked = 0;
  let noIndex = 0;
  for (const entry of entries) {
    if (entry.id === exclude) continue;
    checked += 1;
    if (!entry.index) { noIndex += 1; continue; }
    const hit = bestRouteIn(entry.index, call);
    if (hit) candidates.push({ project: entry.id, route: hit.route, grade: hit.grade });
  }
  candidates.sort((a, b) => cmp(a.project, b.project));
  if (candidates.length <= 1) {
    return { chosen: candidates, candidates, ambiguous: false, checked, noIndex };
  }
  const named = candidates.filter((c) => answersTo(entries.find((e) => e.id === c.project), call.service));
  if (named.length === 1) return { chosen: named, candidates, ambiguous: false, checked, noIndex };
  return {
    chosen: candidates.map((c) => ({ ...c, grade: 'HEURISTIC' })),
    candidates,
    ambiguous: true,
    checked,
    noIndex,
  };
}

// ---------------------------------------------------------------------------
// Reading the crossings off a graph
// ---------------------------------------------------------------------------

/**
 * The calls that leave this pack from ONE symbol: its CALLS_HTTP out-edges onto
 * an `outbound` endpoint node. Those edges are UNRESOLVED, which is why no walk
 * follows them and why this reads them directly.
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {string} symbolId
 * @returns {{endpoint:string, method:string, path:string, service:(string|null)}[]}
 */
export function outboundCallsOf(graph, symbolId) {
  const out = [];
  for (const e of graph.outEdges(symbolId)) {
    if (e.type !== 'CALLS_HTTP') continue;
    const n = graph.nodes.get(e.to);
    if (!n || n.outbound !== true) continue;
    out.push({ endpoint: e.to, method: methodOf(n), path: pathOf(n), service: serviceOf(graph, e.idx) });
  }
  out.sort((a, b) => cmp(a.endpoint, b.endpoint));
  return out;
}

/**
 * Every call that leaves this pack, with the symbols that make it. The
 * pack-wide census behind the overview's one sentence.
 * @param {import('../core/graph.mjs').Graph} graph
 */
export function packOutboundCalls(graph) {
  const out = [];
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound !== true) continue;
    const callers = [];
    const services = new Set();
    for (const e of graph.inEdges(n.id)) {
      if (e.type !== 'CALLS_HTTP' || e.grade !== 'UNRESOLVED') continue;
      callers.push(e.from);
      const s = serviceOf(graph, e.idx);
      if (s) services.add(s);
    }
    if (callers.length === 0) continue;
    out.push({
      endpoint: n.id,
      method: methodOf(n),
      path: pathOf(n),
      service: services.size === 1 ? [...services][0] : null,
      callers: callers.sort(),
    });
  }
  out.sort((a, b) => cmp(a.endpoint, b.endpoint));
  return out;
}
