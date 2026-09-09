// federation.mjs — one answer across several packs (RM44).
//
// One repository per microservice is the normal shape, so Cascade analyzes each
// service into its own pack. A pack therefore knows that its code sends
// `GET /owners/{ownerId}` SOMEWHERE and stops there: the route it calls is not
// a route it serves, so the lane put an `outbound` endpoint node in the graph
// and an UNRESOLVED CALLS_HTTP edge onto it, which is below every mode's floor
// and which no walk follows.
//
// When "somewhere" is another project THIS SERVER also serves, the answer can
// keep walking. That is all federation is: a query-time join between packs,
// with the packs themselves untouched.
//
// THREE RULES DECIDE EVERYTHING HERE.
//
//   1. THE SIDECAR, NEVER THE PACK. Which project serves which route is read
//      from `routes.json`, the small sorted index `analyze` writes beside
//      pack.json. Reading it costs a stat and a few kilobytes, so a server can
//      answer "who serves this?" for twenty projects without parsing one pack.
//      A sibling's pack is loaded only when the answer really crosses into it,
//      through the SAME cache and the SAME memory budget as any other project.
//   2. NOTHING RISES ABOVE SOUND_SET. Which deployable answers a service name
//      is not a fact about anybody's source. A crossing is at best a checked
//      candidate, and it weakens the path grade of every row below it exactly
//      as any other edge does.
//   3. WHAT WAS NOT CROSSED IS SAID. A call that matched no registered project
//      is listed (`unmatched`), a project with no sidecar is named (`skipped`,
//      with the remedy), and a call that matched several is crossed to all of
//      them at HEURISTIC and marked `ambiguous`. A reader who never sees the
//      list cannot know to register the project that would answer it.
//
// Pure except `readRoutesIndex`, which reads one file and takes its `io`
// injected. The walk itself is `core/chain.mjs`, untouched: the crossing is
// computed here and the sibling's walk is a NEW walk in the sibling's graph.

import fs from 'node:fs';
import path from 'node:path';
import { routeMatches, normalizeUrlPath } from '../adapters/web_bridge.mjs';
import { chainWalk } from '../core/chain.mjs';
import { buildMap } from '../core/map.mjs';
import { screensAffecting } from '../core/walks.mjs';
import { FLOW_EDGE_TYPES } from '../core/graph.mjs';

/** The sidecar's schema id. Written by `analyze`, read by the server. */
export const ROUTES_SCHEMA = 'cascade-routes/1';
/** Its file name, beside `pack.json`. */
export const ROUTES_FILE = 'routes.json';

/** How many crossings one answer may chain (A to B to C) unless told otherwise. */
export const DEFAULT_FEDERATION_HOPS = 3;

// The node cap the SIBLING's own sub-picture is built with. Deliberately far
// past anything one route can reach: the cap that bounds a federated answer is
// the OUTER picture's, applied once over the whole drawing, and a second cap in
// here would cut a sibling's nodes before the caller ever saw them.
const SUB_PICTURE_LIMIT = 1000000;

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weaker = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const strip = (id) => String(id).slice(String(id).indexOf(':') + 1);

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

const methodOf = (n) => (typeof n.httpMethod === 'string' && n.httpMethod.length > 0 ? n.httpMethod : 'ANY');
const pathOf = (n) => normalizeUrlPath(n.path ?? strip(n.id).replace(/^\S+\s+/, ''));
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

// ---------------------------------------------------------------------------
// The federator: what one tool holds while it answers one question
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx  the project context a tool was handed
 * @param {{federate?:boolean, federationHops?:number}} [args]  the tool's own arguments
 * @returns {object} the federator. Never null: a single-project server still
 *          has to LIST the calls that leave the pack, because "register the
 *          project that serves these" is the remedy.
 */
export function makeFederator(ctx, args = {}) {
  const host = ctx && ctx.federation && typeof ctx.federation.ids === 'function' ? ctx.federation : null;
  const self = (host && typeof host.self === 'string' && host.self.length > 0)
    ? host.self
    : (ctx && ctx.basis && typeof ctx.basis.project === 'string' ? ctx.basis.project : null);
  const wanted = args.federate !== false;
  const maxCrossings = Number.isInteger(args.federationHops) && args.federationHops >= 0
    ? args.federationHops
    : DEFAULT_FEDERATION_HOPS;

  // Every federated project and its sidecar, read ONCE per answer. A project
  // whose sidecar is missing or unreadable stays in the list with a null index:
  // it is still a project this server serves, and the answer has to say that it
  // could not be asked.
  const entries = [];
  const skippedById = new Map();
  if (host && wanted) {
    for (const id of host.ids()) {
      const r = host.indexOf(id);
      if (r && r.ok) entries.push({ id, index: r.index });
      else {
        entries.push({ id, index: null });
        if (id !== self) skippedById.set(id, { project: id, reason: r && r.reason === 'unreadable' ? 'unreadable' : 'no-index' });
      }
    }
  }
  const siblingCount = entries.filter((e) => e.id !== self).length;
  const available = !!host && wanted && siblingCount > 0;

  const crossed = [];
  const unmatched = [];
  // Calls this answer did not even ASK about, because the crossing cap was
  // already spent. They are not `unmatched`: nobody looked, so "none of the
  // registered projects serves it" would be a claim this answer cannot make.
  const hopCapped = [];
  // Calls that leave this pack from code NO route on the picture reaches: a
  // scheduled job, a startup listener, a tool function an AI model calls. They
  // are real calls (`overview.federation` counts them) and they are not on a
  // picture drawn from routes, so the picture has to say so rather than let a
  // reader read the silence as "this project calls nobody".
  const offPicture = [];
  const siblings = new Map(); // project id -> the basis entry it contributed
  const ctxCache = new Map(); // project id -> ctx or null

  /** The sibling's context, loaded through the host's own cache and budget. */
  function projectCtx(id) {
    if (id === self) return ctx;
    if (ctxCache.has(id)) return ctxCache.get(id);
    let sib = null;
    try {
      sib = host.ctxFor(id);
    } catch (e) {
      skippedById.set(id, { project: id, reason: 'unreadable', detail: (e && e.message) || String(e) });
      ctxCache.set(id, null);
      return null;
    }
    // THE SIDECAR MUST STILL DESCRIBE THE PACK. It is derived from the pack and
    // is not part of its digest, so a pack rebuilt without rewriting the sidecar
    // would let an old route list answer for a new graph. Refuse it.
    const entry = entries.find((e) => e.id === id);
    const digest = sib && sib.basis ? sib.basis.buildDigest : null;
    if (!entry || !entry.index || entry.index.buildDigest !== digest) {
      skippedById.set(id, { project: id, reason: 'stale-index' });
      ctxCache.set(id, null);
      return null;
    }
    siblings.set(id, {
      project: id,
      buildDigest: digest,
      builtAt: sib.basis.builtAt ?? null,
      freshness: sib.basis.freshness ?? { verdict: 'unknown' },
    });
    ctxCache.set(id, sib);
    return sib;
  }

  /** The graph node the sidecar promised, or null when the two disagree. */
  function routeNode(graph, id, project, want) {
    const n = graph.nodes.get(id);
    const ok = n && n.kind === 'endpoint' && (want === 'outbound' ? n.outbound === true : n.outbound !== true);
    if (!ok) {
      skippedById.set(project, { project, reason: 'stale-index' });
      return null;
    }
    return n;
  }

  function recordCrossing(from, call, to, grade, ambiguous, extra = {}) {
    crossed.push({
      from: { project: from.project, symbol: strip(from.id) },
      route: { method: call.method, path: call.path },
      service: call.service ?? null,
      to: { project: to.project, endpoint: strip(to.endpoint) },
      grade,
      ambiguous,
      ...extra,
    });
  }

  function recordUnmatched(from, call, r) {
    unmatched.push({
      from: { project: from.project, symbol: strip(from.id) },
      route: { method: call.method, path: call.path },
      service: call.service ?? null,
      checked: r ? r.checked : 0,
      noIndex: r ? r.noIndex : 0,
    });
  }

  // -------------------------------------------------------------------------
  // Walking DOWN: this project's code calls a route another project serves
  // -------------------------------------------------------------------------

  /**
   * @param {import('../core/graph.mjs').Graph} graph  the CALLING project's graph
   * @param {{id:string, hops:number, grade:string, http?:number, project:string}[]} callers
   * @param {{mode:string, depth:number}} opts
   * @returns {object} lane name -> the rows this crossing added
   */
  function crossDown(graph, callers, opts) {
    const lanes = emptyLanes();
    const visited = new Set();
    step(graph, callers, maxCrossings);
    return lanes;

    function step(g, from, budget) {
      if (budget <= 0) return;
      for (const caller of from) {
        for (const call of outboundCallsOf(g, caller.id)) {
          const r = serversOf(call, entries, { exclude: caller.project });
          if (r.chosen.length === 0) { recordUnmatched(caller, call, r); continue; }
          for (const target of r.chosen) {
            const key = `${target.project} ${target.route.id}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const sib = projectCtx(target.project);
            if (!sib) continue;
            if (!routeNode(sib.graph, target.route.id, target.project, 'served')) continue;
            const grade = weaker(caller.grade, target.grade);
            const hopsBase = caller.hops + 1;   // the caller, and then the route it called
            const remaining = opts.depth - hopsBase;
            const httpBase = (caller.http ?? 0) + 1;
            recordCrossing(caller, call, { project: target.project, endpoint: target.route.id },
              grade, r.ambiguous, remaining < 1 ? { depthCut: true } : {});
            // THE ROUTE THE REQUEST ENTERED IS A ROW. The sibling's walk starts
            // AT that route, so nothing below draws it, and the endpoint lane
            // came back empty for a request that plainly entered one: "0 / 0,
            // and we left out 1 connection" for a screen whose call is answered
            // by `GET /owners` in the next project. It is a row with a project
            // on it, like the tables already are, and it is not counted in this
            // project's own endpoint census.
            lanes.endpoints.push(crossedRouteRow(sib.graph, target.route.id, {
              project: target.project, hops: hopsBase, grade, httpBase, caller, crossGrade: target.grade,
            }));
            if (remaining < 1) continue;
            const w = chainWalk(sib.graph, {
              start: target.route.id, direction: 'down', mode: opts.mode, maxDepth: remaining,
            });
            const next = [];
            for (const field of LANE_FIELDS) {
              for (const row of (Array.isArray(w[field]) ? w[field] : [])) {
                const moved = moveRow(row, {
                  project: target.project, hopsBase, gradeCap: grade, httpBase,
                  startNodeId: target.route.id, caller, crossGrade: target.grade,
                });
                lanes[field].push(moved);
                if (field === 'services' || field === 'webFunctions') {
                  next.push({
                    id: `symbol:${row.id}`, hops: moved.hops, grade: moved.grade,
                    http: moved.httpHops, project: target.project,
                  });
                }
              }
            }
            if (next.length) step(sib.graph, next, budget - 1);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Walking UP: another project's code calls a route THIS project serves
  // -------------------------------------------------------------------------

  /** One project's index reduced to the single route a crossing is about. */
  function serverEntryFor(project, route) {
    const own = entries.find((e) => e.id === project);
    return {
      id: project,
      index: {
        project: own && own.index ? own.index.project : (project === self ? packProjectName() : null),
        serves: [{ id: route.id, method: route.method, path: route.path }],
        serviceNames: own && own.index ? (own.index.serviceNames ?? []) : (project === self ? selfServiceNames() : []),
      },
    };
  }

  const packProjectName = () => (ctx && ctx.pack && typeof ctx.pack.project === 'string' ? ctx.pack.project : null);
  const selfServiceNames = () => (ctx && ctx.pack && Array.isArray(ctx.pack.serviceNames) ? ctx.pack.serviceNames : []);

  /**
   * The projects that call ONE route, resolved BOTH ways: the caller's call has
   * to match the route, and that call has to resolve back to the project that
   * serves it. Without the second half, a call meant for a third project that
   * happens to serve the same path would read as a caller of this one.
   *
   * @param {{id:string, method:string, path:string}} route
   * @param {string} servedBy  the project that serves it
   */
  function callersOf(route, servedBy) {
    const out = [];
    if (!available) return out;
    const server = serverEntryFor(servedBy, route);
    const pool = [server, ...entries.filter((e) => e.id !== servedBy)];
    for (const entry of entries) {
      if (entry.id === servedBy || !entry.index) continue;
      for (const call of entry.index.calls ?? []) {
        if (!methodMatch(route.method, call.method)) continue;
        if (!(route.path === call.path || routeMatches(route.path, call.path))) continue;
        const r = serversOf(call, pool, { exclude: entry.id });
        const mine = r.chosen.find((c) => c.project === servedBy);
        if (!mine) continue;
        out.push({ project: entry.id, call, grade: mine.grade, ambiguous: r.ambiguous });
      }
    }
    out.sort((a, b) => cmp(a.project, b.project) || cmp(a.call.id, b.call.id));
    return out;
  }

  /**
   * Walk UP out of this project's routes into the projects that call them.
   *
   * @param {{id:string, method:string, path:string, hops:number, grade:string, http?:number}[]} routes
   *        this project's endpoints, as the in-pack walk reported them
   * @param {{mode:string, depth:number}} opts
   * @returns {object} lane name -> the rows this crossing added
   */
  function crossUp(routes, opts) {
    const lanes = emptyLanes();
    const visited = new Set();
    step(routes, self, maxCrossings);
    return lanes;

    function step(from, servedBy, budget) {
      if (budget <= 0) return;
      for (const route of from) {
        for (const hit of callersOf(route, servedBy)) {
          const sib = projectCtx(hit.project);
          if (!sib) continue;
          if (!routeNode(sib.graph, hit.call.id, hit.project, 'outbound')) continue;
          const grade = weaker(route.grade, hit.grade);
          const hopsBase = route.hops + 1;
          const httpBase = (route.http ?? 0) + 1;
          const next = [];
          for (const callerId of callingSymbols(sib.graph, hit.call.id)) {
            const key = `${hit.project} ${callerId}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const remaining = opts.depth - hopsBase;
            recordCrossing({ project: hit.project, id: callerId }, hit.call,
              { project: servedBy, endpoint: route.id }, grade, hit.ambiguous,
              remaining < 1 ? { depthCut: true } : {});
            if (remaining < 1) continue;
            // The calling method itself is a row. The crossing lands on it and
            // the sibling's walk starts there, so nothing else would draw it,
            // and the chain would jump from this route to whatever sits above.
            lanes.services.push(callerRow(sib.graph, callerId, {
              project: hit.project, hops: hopsBase, grade, httpBase, route, servedBy,
            }));
            const w = chainWalk(sib.graph, {
              start: callerId, direction: 'up', mode: opts.mode, maxDepth: remaining,
            });
            for (const field of LANE_FIELDS) {
              for (const row of (Array.isArray(w[field]) ? w[field] : [])) {
                const moved = moveRow(row, {
                  project: hit.project, hopsBase, gradeCap: grade, httpBase,
                  startNodeId: callerId, caller: null, crossGrade: hit.grade,
                });
                lanes[field].push(moved);
                if (field === 'endpoints') {
                  next.push({
                    id: `endpoint:${row.id}`, method: row.httpMethod ?? 'ANY',
                    path: normalizeUrlPath(row.path ?? ''), hops: moved.hops,
                    grade: moved.grade, http: moved.httpHops,
                  });
                }
              }
            }
          }
          if (next.length) step(next, hit.project, budget - 1);
        }
      }
    }
  }

  /**
   * The same crossing for `endpoint_impact`: which routes in the OTHER projects
   * are affected because they call one of ours. `endpoint_impact` reaches with
   * `impactOf` and no depth bound, so this does too.
   *
   * @param {{id:string, method:string, path:string, grade:string}[]} routes
   * @param {{mode:string}} opts
   */
  function crossUpEndpoints(routes, opts) {
    const out = [];
    const seen = new Set();
    const visited = new Set();
    step(routes, self, maxCrossings);
    out.sort((a, b) => cmp(a.project, b.project) || cmp(a.id, b.id));
    return out;

    function step(from, servedBy, budget) {
      if (budget <= 0) return;
      for (const route of from) {
        for (const hit of callersOf(route, servedBy)) {
          const sib = projectCtx(hit.project);
          if (!sib) continue;
          if (!routeNode(sib.graph, hit.call.id, hit.project, 'outbound')) continue;
          const grade = weaker(route.grade, hit.grade);
          const next = [];
          for (const callerId of callingSymbols(sib.graph, hit.call.id)) {
            const key = `${hit.project} ${callerId}`;
            if (visited.has(key)) continue;
            visited.add(key);
            recordCrossing({ project: hit.project, id: callerId }, hit.call,
              { project: servedBy, endpoint: route.id }, grade, hit.ambiguous);
            for (const [id, info] of sib.graph.impactOf(callerId, { mode: opts.mode, edgeTypes: FLOW_EDGE_TYPES })) {
              const n = sib.graph.nodes.get(id);
              if (!n || n.kind !== 'endpoint' || n.outbound === true) continue;
              const rowKey = `${hit.project} ${id}`;
              if (seen.has(rowKey)) continue;
              seen.add(rowKey);
              const rowGrade = weaker(grade, info.pathGrade);
              out.push({
                id: strip(id), httpMethod: n.httpMethod ?? null, path: n.path ?? null,
                grade: rowGrade, project: hit.project, viaHttp: true,
                httpHops: (info.http ?? 0) + 1, federated: true,
              });
              next.push({ id, method: methodOf(n), path: pathOf(n), grade: rowGrade });
            }
          }
          if (next.length) step(next, hit.project, budget - 1);
        }
      }
    }
  }

  /**
   * The same crossing for `screen_impact`: which SCREENS in the other projects
   * are shown a change to this column, because a function behind one of them
   * calls a route we serve.
   *
   * This is the sentence a federated product exists to answer, and the screens
   * are as often in another deployable as the column is: a gateway's frontend
   * shows a table another service owns. It is `crossUpEndpoints` with the last
   * step changed — the sibling's own backward walk from the calling symbol,
   * stopped at its screens instead of at its routes.
   *
   * @param {{id:string, method:string, path:string, grade:string}[]} routes
   * @param {{mode:string}} opts
   * @returns {{screen:string, label:(string|null), grade:string, project:string,
   *            endpoints:string[], viaHttp:boolean, httpHops:number, federated:boolean}[]}
   */
  function crossUpScreens(routes, opts) {
    // ONE ROW PER SCREEN, and every route it came in on. A screen whose
    // controller sends three requests to three affected routes is one screen,
    // and naming only the first route it was reached through would read as
    // "that is the only one".
    const rows = new Map();
    // Two guards, not one. `crossed` keeps a (caller, route) pair from being
    // recorded twice; `walked` keeps the sibling's own walk from being run
    // twice for one caller. Separating them is what lets a screen name every
    // affected route it reaches rather than only the first one found.
    const crossedPairs = new Set();
    const walked = new Set();
    const screensCache = new Map();
    step(routes, self, maxCrossings);
    const out = [...rows.values()];
    for (const row of out) row.endpoints.sort(cmp);
    out.sort((a, b) => cmp(a.project, b.project) || cmp(a.screen, b.screen));
    return out;

    function step(from, servedBy, budget) {
      if (budget <= 0) return;
      for (const route of from) {
        for (const hit of callersOf(route, servedBy)) {
          const sib = projectCtx(hit.project);
          if (!sib) continue;
          if (!routeNode(sib.graph, hit.call.id, hit.project, 'outbound')) continue;
          const grade = weaker(route.grade, hit.grade);
          const next = [];
          for (const callerId of callingSymbols(sib.graph, hit.call.id)) {
            const key = `${hit.project} ${callerId}`;
            const pair = `${key} ${route.id}`;
            if (crossedPairs.has(pair)) continue;
            crossedPairs.add(pair);
            recordCrossing({ project: hit.project, id: callerId }, hit.call,
              { project: servedBy, endpoint: route.id }, grade, hit.ambiguous);
            let screens = screensCache.get(key);
            if (screens === undefined) {
              screens = screensAffecting(sib.graph, callerId, { mode: opts.mode });
              screensCache.set(key, screens);
            }
            for (const s of screens) {
              const rowKey = `${hit.project} ${s.screen}`;
              const rowGrade = weaker(grade, s.pathGrade);
              const existing = rows.get(rowKey);
              if (existing) {
                if (!existing.endpoints.includes(strip(route.id))) existing.endpoints.push(strip(route.id));
                if (RANK[rowGrade] > RANK[existing.grade]) existing.grade = rowGrade;
                continue;
              }
              rows.set(rowKey, {
                screen: s.path ?? strip(s.screen),
                label: s.label ?? null,
                grade: rowGrade,
                // The routes the crossing came in on, said as this project's
                // own: a reader asking "which of my routes does that screen
                // reach?" gets the answer without another call.
                endpoints: [strip(route.id)],
                project: hit.project,
                viaHttp: true,
                httpHops: (s.httpHops ?? 1),
                federated: true,
              });
            }
            // A route in the caller that is also affected keeps the walk going,
            // so a screen two deployables away is still reached.
            if (walked.has(key)) continue;
            walked.add(key);
            for (const [id, info] of sib.graph.impactOf(callerId, { mode: opts.mode, edgeTypes: FLOW_EDGE_TYPES })) {
              const n = sib.graph.nodes.get(id);
              if (!n || n.kind !== 'endpoint' || n.outbound === true) continue;
              next.push({ id, method: methodOf(n), path: pathOf(n), grade: weaker(grade, info.pathGrade) });
            }
          }
          if (next.length) step(next, hit.project, budget - 1);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Walking down for a PICTURE: what this pack's requests reach over there
  // -------------------------------------------------------------------------

  /**
   * The routes THIS pack serves, by the same rule the per-endpoint walk uses:
   * an outbound route with no handler is a route somebody else answers.
   */
  function servedRoutesOf(graph) {
    const out = [];
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'endpoint') continue;
      if (n.outbound === true && !graph.outEdges(n.id).some((e) => e.type === 'HANDLES')) continue;
      out.push(n.id);
    }
    return out.sort(cmp);
  }

  /**
   * WHICH ROUTE MAKES WHICH OUTBOUND CALL, on one graph.
   *
   * The call itself is on a SYMBOL (`packOutboundCalls` / `outboundCallsOf`),
   * and a picture is drawn from ROUTES, so the two have to be joined: for each
   * symbol that makes a call, which of the routes we are drawing reaches it.
   * That is the impact question, asked upward with the same edge set and the
   * same depth the forward walk used, so a line appears here only where the
   * picture's own walk would have gone.
   *
   * One climb per calling symbol, not one per route: a pack with three Feign
   * clients pays three walks whatever its endpoint count is.
   */
  function callSites(graph, routeIds, opts) {
    const want = new Set(routeIds);
    const callers = new Set();
    for (const c of packOutboundCalls(graph)) for (const id of c.callers) callers.add(id);
    const sites = [];
    const unreached = [];
    for (const symbol of [...callers].sort(cmp)) {
      if (!graph.nodes.has(symbol)) continue;
      let reach;
      try {
        reach = graph.impactOf(symbol, { mode: opts.mode, edgeTypes: FLOW_EDGE_TYPES, maxHops: opts.depth });
      } catch (e) {
        continue;
      }
      let found = false;
      for (const [id, info] of reach) {
        if (!want.has(id)) continue;
        found = true;
        sites.push({ endpoint: id, symbol, grade: info.pathGrade });
      }
      // The symbol IS a route of this pack when it is a handler reached by
      // nothing above it; `want` holds route nodes, so a caller that is itself
      // reached from no drawn route has no line on this picture.
      if (!found) unreached.push(symbol);
    }
    sites.sort((a, b) => cmp(a.endpoint, b.endpoint) || cmp(a.symbol, b.symbol));
    return { sites, unreached };
  }

  /** The sibling's own picture FROM ONE ROUTE, and nothing else of that pack. */
  function subPicture(graph, routeId, opts) {
    const m = buildMap(graph, {
      mode: opts.mode, depth: opts.depth, layers: opts.layers ?? [],
      limit: SUB_PICTURE_LIMIT, maxBytes: null, only: [routeId],
    });
    return { nodes: m.nodes, links: m.links };
  }

  /**
   * EVERY CROSSING A WHOLE-PACK PICTURE MAKES, with the sibling's own picture
   * of the route it landed on.
   *
   * The same crossing rules `flow` walks by (`serversOf`, the same grades, the
   * same ambiguity and the same unmatched handling); what differs is the shape
   * of the answer, because a picture needs nodes and lines rather than lanes.
   *
   * Nothing here is namespaced or drawn: the caller decides how to put two
   * packs on one sheet. `picture` is filled the FIRST time a (project, route)
   * is reached and null on any later crossing to the same portal, so two
   * callers of one route draw two lines onto one node.
   *
   * @param {import('../core/graph.mjs').Graph} graph  this project's graph
   * @param {{mode:string, depth:number, layers?:string[]}} opts
   * @returns {{from:{project:string, endpoint:string, symbol:string},
   *            route:{method:string, path:string}, service:(string|null),
   *            to:{project:string, endpoint:string}, grade:string, ambiguous:boolean,
   *            buildDigest:(string|null), picture:({nodes:object[], links:object[]}|null)}[]}
   */
  function crossMap(graph, opts) {
    const out = [];
    if (!wanted) return out;
    const built = new Set();   // "<project> <route node id>" — a portal is drawn once
    step(graph, self, servedRoutesOf(graph), maxCrossings);
    return out;

    function step(g, project, routeIds, budget) {
      const { sites, unreached } = callSites(g, routeIds, opts);
      // Only for the pack the reader asked about. A SIBLING's other routes are
      // not on this picture by design (only the route we called is drawn), so
      // listing every call they make would be noise about a pack nobody asked
      // the whole of.
      if (project === self) {
        for (const symbol of unreached) {
          for (const call of outboundCallsOf(g, symbol)) {
            offPicture.push({ from: { project, symbol: strip(symbol) }, route: { method: call.method, path: call.path } });
          }
        }
      }
      if (sites.length === 0) return;
      if (budget <= 0) {
        for (const site of sites) {
          for (const call of outboundCallsOf(g, site.symbol)) {
            hopCapped.push({ from: { project, symbol: strip(site.symbol) }, route: { method: call.method, path: call.path } });
          }
        }
        return;
      }
      const next = new Map();   // project id -> the routes crossed into it this level
      for (const site of sites) {
        for (const call of outboundCallsOf(g, site.symbol)) {
          const r = serversOf(call, entries, { exclude: project });
          if (r.chosen.length === 0) { recordUnmatched({ project, id: site.symbol }, call, r); continue; }
          for (const target of r.chosen) {
            const sib = projectCtx(target.project);
            if (!sib) continue;
            if (!routeNode(sib.graph, target.route.id, target.project, 'served')) continue;
            const grade = weaker(site.grade, target.grade);
            recordCrossing({ project, id: site.symbol }, call,
              { project: target.project, endpoint: target.route.id }, grade, r.ambiguous);
            const key = `${target.project} ${target.route.id}`;
            const first = !built.has(key);
            if (first) built.add(key);
            out.push({
              from: { project, endpoint: site.endpoint, symbol: strip(site.symbol) },
              route: { method: call.method, path: call.path },
              service: call.service ?? null,
              to: { project: target.project, endpoint: target.route.id },
              grade,
              ambiguous: r.ambiguous,
              buildDigest: sib.basis ? (sib.basis.buildDigest ?? null) : null,
              picture: first ? subPicture(sib.graph, target.route.id, opts) : null,
            });
            if (first) {
              const set = next.get(target.project);
              if (set) set.add(target.route.id); else next.set(target.project, new Set([target.route.id]));
            }
          }
        }
      }
      for (const [pid, routes] of [...next.entries()].sort((a, b) => cmp(a[0], b[0]))) {
        const sib = projectCtx(pid);
        if (!sib) continue;
        step(sib.graph, pid, [...routes].sort(cmp), budget - 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  // What the answer carries
  // -------------------------------------------------------------------------

  const sortedSkipped = () => [...skippedById.values()]
    .map((s) => ({ project: s.project, reason: s.reason }))
    .sort((a, b) => cmp(a.project, b.project) || cmp(a.reason, b.reason));
  const sortedUnmatched = () => unmatched.slice()
    .sort((a, b) => cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));

  const sortedHopCapped = () => hopCapped.slice()
    .sort((a, b) => cmp(a.from.project, b.from.project) || cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));

  /**
   * HAS THIS FEDERATOR ANYTHING TO SAY? A picture on a server that serves one
   * project and calls nobody must come back exactly as it did before federation
   * existed: an empty block on it would be a field that says nothing, in an
   * answer whose shape other tools diff against.
   */
  function saysAnything() {
    return wanted && (available || unmatched.length > 0 || hopCapped.length > 0 || offPicture.length > 0);
  }

  /** The `answer.federation` block. */
  function block() {
    if (!wanted) return { available: false, reason: 'turned-off', unmatched: [] };
    if (!available) {
      return { available: false, reason: 'single-project', unmatched: sortedUnmatched() };
    }
    return {
      crossed: crossed.slice().sort((a, b) => cmp(a.from.project, b.from.project)
        || cmp(a.from.symbol, b.from.symbol) || cmp(a.to.project, b.to.project) || cmp(a.to.endpoint, b.to.endpoint)),
      unmatched: sortedUnmatched(),
      skipped: sortedSkipped(),
    };
  }

  /** `basis.siblings`, or null when this answer walked no other pack. */
  function siblingBasis() {
    if (siblings.size === 0) return null;
    return [...siblings.values()].sort((a, b) => cmp(a.project, b.project));
  }

  /** One scoped sentence per unmatched, ambiguous or skipped item. */
  function limits() {
    if (!wanted) return [];
    const out = [];
    const say = (reason) => out.push({ scope: 'federation', reason });
    for (const u of sortedUnmatched()) {
      say(!available
        ? `${u.route.method} ${u.route.path} leaves this project, and this server serves no other project, so where it lands is unknown rather than absent. Register the project that serves it (\`cascade init\` and then \`cascade analyze\` there) and ask again`
        : `${u.route.method} ${u.route.path} leaves this project and none of the ${u.checked} other registered project(s) serves it`
          + `${u.noIndex > 0 ? `, and ${u.noIndex} of them carries no route index, so it could not be asked` : ''}. `
          + 'The chain stops at the call. Register the project that serves this route and ask again');
    }
    const off = offPicture.slice().sort((a, b) => cmp(a.from.symbol, b.from.symbol) || cmp(a.route.path, b.route.path));
    if (off.length) {
      const routes = [...new Set(off.map((o) => `${o.route.method} ${o.route.path}`))].sort();
      const symbols = [...new Set(off.map((o) => o.from.symbol))].sort();
      say(`${routes.length} call(s) leave this project from ${symbols.length} method(s) that no route on this picture reaches (${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? `, and ${symbols.length - 3} more` : ''}): ${routes.join(', ')}. `
        + 'A picture drawn from routes cannot show them, and they are real calls: a scheduled job, a startup listener or a tool an AI model calls is code nothing upstream of it names. '
        + '`overview.federation` counts every call that leaves the pack, and `flow` from the method itself follows this one');
    }
    for (const h of sortedHopCapped()) {
      say(`${h.route.method} ${h.route.path} leaves ${h.from.project} and the crossing cap (federationHops ${maxCrossings}) was already spent, `
        + 'so this answer never asked which project serves it. That is a bound on this answer, not an absence. '
        + 'Raise federationHops and ask again');
    }
    const amb = new Map();
    for (const c of crossed) {
      if (!c.ambiguous) continue;
      const key = `${c.from.symbol} ${c.route.method} ${c.route.path}`;
      if (!amb.has(key)) amb.set(key, { call: c, projects: [] });
      amb.get(key).projects.push(c.to.project);
    }
    for (const a of [...amb.values()].sort((x, y) => cmp(x.call.from.symbol, y.call.from.symbol))) {
      say(`${a.call.route.method} ${a.call.route.path} is served by ${a.projects.slice().sort().join(', ')}, and nothing in the call says which of them it goes to`
        + `${a.call.service ? `, because the service name it carries (${a.call.service}) matches none of them` : ', because the call carries no service name'}. `
        + 'All of them are on this answer at HEURISTIC, so the rows below that crossing are candidates rather than one measured chain');
    }
    for (const s of sortedSkipped()) {
      say(s.reason === 'no-index'
        ? `${s.project} is registered and carries no route index, so this answer could not ask what it serves. Re-run \`cascade analyze\` for ${s.project}`
        : s.reason === 'stale-index'
          ? `${s.project} carries a route index built from a different pack than the one this server loads, so it was not crossed. Re-run \`cascade analyze\` for ${s.project}`
          : `${s.project} is registered and its pack could not be read, so it was not crossed. Re-run \`cascade analyze\` for ${s.project}`);
    }
    return out;
  }

  return {
    self,
    available,
    wanted,
    entries,
    maxCrossings,
    crossDown,
    crossUp,
    crossUpEndpoints,
    crossUpScreens,
    crossMap,
    contextFor: projectCtx,
    saysAnything,
    block,
    siblingBasis,
    limits,
  };
}

// ---------------------------------------------------------------------------
// Row plumbing
// ---------------------------------------------------------------------------

/** The lanes a chain walk can produce. */
const LANE_FIELDS = Object.freeze(['webFunctions', 'endpoints', 'services', 'statements', 'tables', 'screens']);

function emptyLanes() {
  const o = {};
  for (const f of LANE_FIELDS) o[f] = [];
  return o;
}

/** The symbols that make one outbound call, sorted. */
function callingSymbols(graph, endpointId) {
  return graph.inEdges(endpointId)
    .filter((e) => e.type === 'CALLS_HTTP' && graph.nodes.get(e.from)?.kind === 'symbol')
    .map((e) => e.from)
    .sort();
}

/**
 * One row of another project's walk, moved onto this answer: hops continued,
 * the path grade weakened by the crossing, the project named, and the link that
 * would have pointed at that walk's own start pointed at the caller instead.
 */
function moveRow(row, o) {
  const moved = {
    ...row,
    hops: row.hops + o.hopsBase,
    grade: weaker(row.grade, o.gradeCap),
    httpHops: (row.httpHops ?? 0) + o.httpBase,
    project: o.project,
    federated: true,
    viaHttp: true,
  };
  if (row.link && typeof row.link === 'object') {
    moved.link = row.link.from === o.startNodeId && o.caller
      ? crossingLink(o.caller.id, o.caller.project, o.crossGrade,
        'this project calls a route the other project serves, and the server matched them by method and path')
      : { ...row.link, fromProject: o.project };
  }
  return moved;
}

/**
 * The method in another project that MAKES the call, as a service row. Walking
 * up, the crossing lands on it and the sibling's walk starts there.
 */
function callerRow(graph, id, o) {
  const n = graph.nodes.get(id) ?? {};
  return {
    id: strip(id),
    short: shortSymbol(id),
    owner: n.owner ?? null,
    hops: o.hops,
    grade: o.grade,
    external: (n.file ?? null) === null,
    transactional: n.transactional === true,
    file: n.file ?? null,
    line: n.line ?? null,
    project: o.project,
    federated: true,
    viaHttp: true,
    httpHops: o.httpBase,
    link: crossingLink(o.route.id, o.servedBy, o.grade,
      'the other project calls this route, and the server matched that call to it by method and path'),
    path: [],
  };
}

/**
 * The route in another project that a request ENTERED, as an endpoint row.
 *
 * Shaped exactly like the endpoint row a walk down from a screen produces
 * (src/core/chain.mjs), so a page draws the two the same way, plus the three
 * fields every federated row carries. `path` is the URL, as it is there;
 * `walkedPath` is empty because this row is the crossing itself and there is no
 * step of this project's walk below it.
 */
function crossedRouteRow(graph, id, o) {
  const n = graph.nodes.get(id) ?? {};
  return {
    id: strip(id),
    httpMethod: n.httpMethod ?? null,
    path: n.path ?? null,
    handler: n.handler ?? null,
    hops: o.hops,
    grade: o.grade,
    file: n.file ?? null,
    line: n.line ?? null,
    ...(n.observed === true ? { observed: true } : {}),
    project: o.project,
    federated: true,
    viaHttp: true,
    httpHops: o.httpBase,
    link: crossingLink(o.caller.id, o.caller.project, o.crossGrade,
      'this project calls a route the other project serves, and the server matched them by method and path'),
    walkedPath: [],
  };
}

function crossingLink(fromId, fromProject, grade, basis) {
  return {
    from: fromId,
    fromShort: shortSymbol(fromId),
    fromProject,
    type: 'CALLS_HTTP',
    grade,
    basis,
    receiver: null,
    iface: null,
    federated: true,
  };
}

/** `Class#method` out of a symbol id, the rule core/chain.mjs nodeLabel uses. */
function shortSymbol(id) {
  const key = strip(id);
  const h = key.lastIndexOf('#');
  if (h < 0) return key;
  if (key.includes('/')) return key.slice(key.lastIndexOf('/', h) + 1);
  return key.slice(key.lastIndexOf('.', h) + 1);
}
