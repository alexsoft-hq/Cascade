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

//
// WHERE THE WORK IS. This file holds the federator's STATE and the words it puts
// on an answer; the two stages either side of it live beside it:
//   federation_routes.mjs  the sidecar index, and which project answers a call
//   federation_cross.mjs   the five crossings, and the rows they move
// Every export this file had before that split is still exported from here, so
// no importer and no test had to change.

import {
  crossDown, crossMap, crossUp, crossUpEndpoints, crossUpScreens,
} from './federation_cross.mjs';
import { block, limits, saysAnything, siblingBasis } from './federation_report.mjs';
import { strip } from './federation_routes.mjs';

// The sidecar and the match, from where they live now: `buildRoutesIndex` is
// written by `cascade analyze`, `readRoutesIndex` is read by the project host,
// and `serversOf` is the rule every crossing asks.
export {
  buildRoutesIndex, methodMatch, outboundCallsOf, packOutboundCalls, readRoutesIndex,
  routeRef, serializeRoutesIndex, serversOf, ROUTES_FILE, ROUTES_SCHEMA,
} from './federation_routes.mjs';

/**
 * How many CROSSINGS one answer may make. Not hops: a crossing is one whole
 * sibling walk, and three of them is a request that left home, arrived, left
 * again and arrived again.
 */
export const DEFAULT_FEDERATION_HOPS = 3;

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
    let sib;
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

  const packProjectName = () => (ctx && ctx.pack && typeof ctx.pack.project === 'string' ? ctx.pack.project : null);
  const selfServiceNames = () => (ctx && ctx.pack && Array.isArray(ctx.pack.serviceNames) ? ctx.pack.serviceNames : []);

  function recordUnmatched(from, call, r) {
    unmatched.push({
      from: { project: from.project, symbol: strip(from.id) },
      route: { method: call.method, path: call.path },
      service: call.service ?? null,
      checked: r ? r.checked : 0,
      noIndex: r ? r.noIndex : 0,
    });
  }

  // THE STATE THE REPORT AND THE CROSSINGS SHARE. Every walk in
  // federation_cross.mjs and every sentence in federation_report.mjs takes this
  // object and reads what it needs off it, so the lists a crossing appends to
  // are the same lists the report words — one state, one account of what
  // happened.
  const f = {
    self,
    wanted,
    available,
    entries,
    maxCrossings,
    crossed,
    unmatched,
    hopCapped,
    offPicture,
    siblings,
    skippedById,
    projectCtx,
    routeNode,
    recordCrossing,
    recordUnmatched,
    packProjectName,
    selfServiceNames,
  };

  return {
    self,
    available,
    wanted,
    entries,
    maxCrossings,
    crossDown: (graph, callers, opts) => crossDown(f, graph, callers, opts),
    crossUp: (routes, opts) => crossUp(f, routes, opts),
    crossUpEndpoints: (routes, opts) => crossUpEndpoints(f, routes, opts),
    crossUpScreens: (routes, opts) => crossUpScreens(f, routes, opts),
    crossMap: (graph, opts) => crossMap(f, graph, opts),
    contextFor: projectCtx,
    saysAnything: () => saysAnything(f),
    block: () => block(f),
    siblingBasis: () => siblingBasis(f),
    limits: () => limits(f),
  };
}

// ---------------------------------------------------------------------------
// Row plumbing
// ---------------------------------------------------------------------------

