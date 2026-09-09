// federation_cross.mjs — the crossings themselves: this project's request
// arriving in another project's code, and another project's request arriving in
// this one's.
//
// WHAT THIS MODULE OWNS. Five walks, one per question a tool asks across a
// registered set of projects:
//   crossDown         this project's code calls a route another project serves,
//                     and the sibling's own walk continues from that route
//   crossUp           another project's code calls a route THIS project serves,
//                     and the sibling's walk continues upward from the caller
//   crossUpEndpoints  the same for `endpoint_impact`, which reaches with no
//                     depth bound
//   crossUpScreens    the same for `screen_impact`, stopped at the sibling's
//                     screens rather than at its routes — the sentence a
//                     federated product exists to answer
//   crossMap          the picture: which of this pack's routes reach into which
//                     other pack, and what each of those reaches there
// …plus the row plumbing all five share: a row that MOVED to another project
// carries that project, its hops rebased onto the crossing and its grade capped
// by the crossing it came through.
//
// WHAT IT MUST NEVER KNOW ABOUT: how a project is registered, how a sidecar is
// read, or how the answer's `federation` block is worded. Every function here
// takes the federator's own state as `f` and reads what it needs off it; the
// state, the index and the wording stay in federation.mjs.
//
// A ROW THAT CROSSED SAYS SO, always: `project`, `viaHttp` and `httpHops` ride
// on every moved row, because code on the far side of a hop is another
// deployable and a reader who is not told will read it as one call stack.

import { chainWalk } from '../core/chain.mjs';
import { FLOW_EDGE_TYPES } from '../core/graph.mjs';
import { normalizeUrlPath, routeMatches } from '../adapters/http_routes.mjs';
import { buildMap } from '../core/map.mjs';
import { screensAffecting } from '../core/walks.mjs';
import {
  cmp, methodMatch, methodOf, outboundCallsOf, packOutboundCalls, pathOf, serversOf,
  strip, weaker, RANK,
} from './federation_routes.mjs';

// The node cap the SIBLING's own sub-picture is built with. Deliberately far
// past anything one route can reach: the cap that bounds a federated answer is
// the OUTER picture's, applied once over the whole drawing, and a second cap in
// here would cut a sibling's nodes before the caller ever saw them.
const SUB_PICTURE_LIMIT = 1000000;

// -------------------------------------------------------------------------
// Walking DOWN: this project's code calls a route another project serves
// -------------------------------------------------------------------------

/**
 * @param {import('../core/graph.mjs').Graph} graph  the CALLING project's graph
 * @param {{id:string, hops:number, grade:string, http?:number, project:string}[]} callers
 * @param {{mode:string, depth:number}} opts
 * @returns {object} lane name -> the rows this crossing added
 */
export function crossDown(f, graph, callers, opts) {
  const { entries, maxCrossings, projectCtx, routeNode, recordCrossing, recordUnmatched } = f;
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
function serverEntryFor(f, project, route) {
  const { entries, self, packProjectName, selfServiceNames } = f;
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


/**
 * The projects that call ONE route, resolved BOTH ways: the caller's call has
 * to match the route, and that call has to resolve back to the project that
 * serves it. Without the second half, a call meant for a third project that
 * happens to serve the same path would read as a caller of this one.
 *
 * @param {{id:string, method:string, path:string}} route
 * @param {string} servedBy  the project that serves it
 */
function callersOf(f, route, servedBy) {
  const { available, entries } = f;
  const out = [];
  if (!available) return out;
  const server = serverEntryFor(f, servedBy, route);
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
export function crossUp(f, routes, opts) {
  const { self, maxCrossings, projectCtx, routeNode, recordCrossing } = f;
  const lanes = emptyLanes();
  const visited = new Set();
  step(routes, self, maxCrossings);
  return lanes;

  function step(from, servedBy, budget) {
    if (budget <= 0) return;
    for (const route of from) {
      for (const hit of callersOf(f, route, servedBy)) {
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
export function crossUpEndpoints(f, routes, opts) {
  const { self, maxCrossings, projectCtx, routeNode, recordCrossing } = f;
  const out = [];
  const seen = new Set();
  const visited = new Set();
  step(routes, self, maxCrossings);
  out.sort((a, b) => cmp(a.project, b.project) || cmp(a.id, b.id));
  return out;

  function step(from, servedBy, budget) {
    if (budget <= 0) return;
    for (const route of from) {
      for (const hit of callersOf(f, route, servedBy)) {
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
export function crossUpScreens(f, routes, opts) {
  const { self, maxCrossings, projectCtx, routeNode, recordCrossing } = f;
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
      for (const hit of callersOf(f, route, servedBy)) {
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
function callSites(f, graph, routeIds, opts) {
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
function subPicture(f, graph, routeId, opts) {
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
export function crossMap(f, graph, opts) {
  const {
    self, wanted, entries, maxCrossings, projectCtx, routeNode, recordCrossing,
    recordUnmatched, offPicture, hopCapped,
  } = f;
  const out = [];
  if (!wanted) return out;
  const built = new Set();   // "<project> <route node id>" — a portal is drawn once
  step(graph, self, servedRoutesOf(graph), maxCrossings);
  return out;

  function step(g, project, routeIds, budget) {
    const { sites, unreached } = callSites(f, g, routeIds, opts);
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
            picture: first ? subPicture(f, sib.graph, target.route.id, opts) : null,
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

