// chain.mjs — the chain walk behind the Flow view ("if I hit this API, which
// code does it run through, and which tables does it end at?") and behind its
// mirror, the Impact view ("if I change THIS column / table / statement /
// method, which HTTP endpoints are affected?").
//
// ONE BFS from a start node, in one of two directions, projected into the lanes
// the page draws left→right:
//   direction 'down'  entry  → service layer   → mapper statement → table
//   direction 'up'    target → mapper statement → service layer   → HTTP endpoint
//
// THE SCREEN AXIS (RM30) extends both ends of that, on a pack that has a
// frontend: down from a screen the lanes open with its own functions and the
// routes they call (screen → web functions → endpoints → services → statements
// → tables), and up from a column they close with the same two in reverse
// (… → endpoints → web functions → screens). `laneNames` on the result says
// which lanes THIS answer has, because a backend-only pack has neither: an
// empty screens column there would read as "no screen reaches this", when the
// truth is that no frontend was ever analyzed.
//
// EITHER DIRECTION MAY CROSS AN INTERNAL HTTP HOP (§1.1): a @FeignClient method
// calling a route another module in the same pack serves. Every row reached that
// way carries `viaHttp: true` and `httpHops`, because code on the far side of a
// hop is another deployable and must not read as one call stack.
// Pure: graph in, plain view model out — no fetch, no DOM, no response
// contract. The server walks; the page only draws (so the picture can never
// disagree with the engine).
//
// Two honesty rules are baked in here, not left to the caller:
//  - A row's grade is the WEAKEST link on the path that reached it, recomputed
//    from that path. A chain that passed through one candidate (SOUND_SET) call
//    is a candidate, never confirmed — even if its last edge was EXACT.
//  - The walk follows EXECUTION/DATA flow only (FLOW_EDGE_TYPES): a table's
//    DECLARES and JOINS edges are schema relations, not something the request
//    runs through, so following them would inflate `walked` and raise a false
//    "depth cap reached" on the columns of a table nobody's SQL joined here.
//  - What the walk did NOT look at is counted, not hidden: `cut.depth` (nodes
//    still expanding at the depth cap), `cut.nodeCap`, and `cut.byMode` (edges
//    skipped ONLY because their grade is below the mode's floor). An empty
//    column can be the mode, not an absence, and the caller must be able to
//    say which — on this pack, strict from any handler reaches nothing because
//    controller→service is MAY_CALL.

// The edges a REQUEST actually travels live in core/graph.mjs, next to the full
// WHERE THE WORK IS. This file is the ORDER the steps run in and little else;
// every step lives in `chain_steps.mjs` beside it, with a name that says which
// question it answers. The walk was one 730-line function, and a reader who
// wanted to know how the tables lane is built had to hold the BFS, the folding
// rule and six other lanes in their head to get to it.

import {
  buildDerivedEndpoints, buildLayers, buildTables, collectPageRows, collectRows,
  countDepthBoundary, countLinkGrades, countOther, emptyReasonFor, makeNodeFacts,
  makePathReader, readWalkOptions, runBfs, sortLanes,
} from './chain_steps.mjs';

// The three names this module has always exported beside `chainWalk`, from where
// they live now: `nodeLabel` is the one display rule the tools, the walk and the
// page share, and two importers read it from here.
export { nodeLabel, frontendCallsOf, weakestOf, ChainError } from './chain_steps.mjs';

/**
 * Walk the chain from `start` and project it into the Flow / Impact view model.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{start:string, direction?:'down'|'up', mode?:'strict'|'conservative'|'heuristic',
 *           maxDepth?:number, maxNodes?:number, edgeTypes?:string[],
 *           walkGenerated?:boolean}} opts
 *          edgeTypes defaults to FLOW_EDGE_TYPES (minus HANDLES when walking up:
 *          endpoints are a DERIVED lane there, not a step of the walk)
 *          walkGenerated (default false) — see THE GENERATED RULE below
 * @returns {object} down: {start, direction, mode, depth, walked, other, services,
 *            statements, tables, layers, beyond:{tables}, byLinkGrade, cut,
 *            emptyReason, endLane}
 *          up:   the same, with `statements, services, endpoints` and
 *                `beyond:{endpoints}` in place of the tables lane
 */
export function chainWalk(graph, opts = {}) {
  const w = readWalkOptions(graph, opts);
  const { best, cut, root } = runBfs(graph, w);
  countDepthBoundary(graph, w, best, cut);

  // What a row needs to know: the path that reached it, the line it is drawn
  // with, and the four facts that come from the graph rather than from the walk.
  const h = { best, ...makePathReader(graph, w, best), ...makeNodeFacts(graph, w, best) };

  // ---- the lanes ---------------------------------------------------------
  const rows = collectRows(graph, w, h);
  const { agg, tables } = buildTables(graph, w, h, rows.reachedStatements);
  const { epAgg, derivedEndpoints } = buildDerivedEndpoints(graph, w, h, rows.handlers);
  // Walking up, the endpoints lane is DERIVED from the handlers the walk
  // reached; walking down from the frontend, it is WALKED. One lane, two ways
  // of arriving at it, because a route above a handler is not a step of the
  // request and a route a screen calls is.
  const endpoints = w.up ? derivedEndpoints : rows.walkedEndpoints;
  const { services, webFunctions, screens, statements, walkedEndpoints } = rows;
  sortLanes({ services, webFunctions, screens, statements, tables, endpoints });

  // ---- what the walk saw, and what it did not ----------------------------
  const byLinkGrade = countLinkGrades(graph, w, best);
  const { layers, beyond, endLane } = buildLayers(graph, w, h, {
    services, statements, webFunctions, screens, walkedEndpoints, endpoints, agg,
  });
  const other = countOther(graph, w, h, epAgg);
  const pageRows = collectPageRows(graph, w, h, root);
  const emptyReason = emptyReasonFor(w);

  // The lanes this answer HAS, in the order the page draws them left to right.
  // The caller iterates this rather than a fixed table, because which lanes a
  // walk has depends on which side of the round trip it started from.
  const laneNames = w.up
    ? ['statements', 'services', 'endpoints', ...(h.webLanes ? ['webFunctions', 'screens'] : [])]
    : [...(h.webLanes ? ['webFunctions', 'endpoints'] : []), 'services', 'statements', 'tables',
      ...(pageRows.length > 0 ? ['screens'] : [])];
  // Every lane is on the RESULT, whether or not it is one of THIS answer's:
  // `laneNames` is the authority on what to draw, and a caller that wants a
  // count of something the answer does not draw should not have to test for
  // undefined to get it.
  const lanes = w.up
    ? { statements, services, endpoints, webFunctions, screens }
    : { webFunctions, endpoints, services, statements, tables, screens: pageRows };
  return {
    start: w.start,
    direction: w.direction,
    mode: w.mode,
    laneNames,
    depth: w.maxDepth,
    walked: best.size - (best.has(w.start) ? 1 : 0),
    other,
    ...lanes,
    layers,
    beyond,
    byLinkGrade,
    cut,
    emptyReason,
    endLane,
  };
}
