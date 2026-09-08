// walks.mjs — the ONE per-endpoint forward walk the whole-pack views run on,
// and the ONE rule for reading a route's handlers off the graph.
//
// Three views ask the same question of every endpoint in the pack ("run the Flow
// walk from here; which mapper statements does it reach?") and then project the
// answer differently:
//   overview → the whole-pack census (how much of the pack is wired end to end)
//   coupling → which API GROUPS reach each statement (a group × group matrix)
//   map      → which TABLES each endpoint ends at (the relation map the Graph
//              tab draws)
// One walk, three projections. Keeping the walk here means the views can never
// disagree about what an endpoint reaches, and the cut census (`walk`) they all
// disclose is counted once, in one place, in one way.
//
// THE HANDLER RULE lives here too (handlersOf / startsOf / primaryHandlerOf),
// because a route can name MORE THAN ONE handler method and every consumer that
// read `outEdges(ep).find(HANDLES)` for itself silently walked the first one:
// whatever the second handler reached was missing from that answer, and the
// views disagreed about which method a route even runs (`map` named the
// lowest-sorted handler, `flow` named the one the endpoint NODE carries — which
// is whichever controller was ingested last). Read it from the edges, here.
//
// Pure: graph in, plain result out — no contract, no paging, no DOM.

import { chainWalk, frontendCallsOf } from './chain.mjs';
import { GRADE_SETS, FLOW_EDGE_TYPES } from './graph.mjs';

// Re-exported from here because this is the module a reader looks in for the
// endpoint helpers; it LIVES in chain.mjs because the chain walk needs it and
// this module already depends on that one, so defining it here would make the
// two files import each other.
export { frontendCallsOf };

/** An endpoint whose path has no first segment ("/" or ""). */
export const ROOT_GROUP = '(root)';

// Grade rank for weakest-link math (mirrors the policy lattice in chain.mjs).
const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });

/**
 * The API group of an endpoint path: its first path segment.
 * `/product/update/{id}` → `product`, `/` or `` → `(root)`.
 *
 * This is a NAMING CONVENTION, not a declared module boundary — every caller
 * that shows a group has to say so in its own `limits`.
 *
 * @param {string|null|undefined} path
 * @returns {string}
 */
export function groupOfPath(path) {
  const p = String(path ?? '').trim();
  const seg = p.replace(/^\/+/, '').split('/')[0];
  return seg || ROOT_GROUP;
}

/** An endpoint whose handler package cannot be read (no handler on the node). */
export const UNKNOWN_PACKAGE_GROUP = '(unknown package)';

/**
 * The API group of one endpoint node, under the profile's module-attribution
 * rule (`moduleAttribution.packageDepth`, SPEC §6.2).
 *
 * `packageDepth: null` (the default) keeps the path rule above — the first path
 * segment. A number switches to the DECLARED rule: the handler's own package,
 * truncated to that many segments (depth 4 → `com.example.mall.product`). That
 * is a code-structure boundary rather than a URL-naming convention, which is
 * why a project that has one says so in its profile instead of the engine
 * guessing which of the two is meaningful.
 *
 * A handler whose package is shorter than the depth keeps its whole package (it
 * is not padded); an endpoint with no handler at all falls back to
 * `(unknown package)` — never to the path rule, because silently mixing the two
 * rules in one matrix would make two groups that are not comparable look like
 * peers.
 *
 * @param {{path?:string|null, handler?:string|null}} node  an endpoint node
 * @param {{packageDepth?:number|null}} [opts]
 * @returns {string}
 */
export function groupOfEndpoint(node, opts = {}) {
  const depth = opts.packageDepth ?? null;
  if (depth == null) return groupOfPath(node && node.path);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new WalkError(`packageDepth must be a positive integer or null, got ${JSON.stringify(depth)}`);
  }
  const handler = node && typeof node.handler === 'string' ? node.handler : null;
  if (!handler) return UNKNOWN_PACKAGE_GROUP;
  const hash = handler.lastIndexOf('#');
  const owner = hash < 0 ? handler : handler.slice(0, hash);
  const segs = owner.split('.').filter(Boolean);
  // The last segment is the type's own simple name; the package is what precedes it.
  const pkg = segs.slice(0, -1);
  if (pkg.length === 0) return UNKNOWN_PACKAGE_GROUP;
  return pkg.slice(0, depth).join('.');
}

/**
 * Every handler method a route names, sorted by node id.
 *
 * A route CAN name more than one: the same route string declared by two
 * controllers (in mall, `GET /order/list` is declared by both the admin module's
 * `OmsOrderController#list` and the portal module's `OmsPortalOrderController#list`).
 * The engine keys an endpoint by "METHOD path", so those become ONE node with
 * two HANDLES edges — a real fact about the pack, not an error.
 *
 * Sorted by id, so the order does not depend on which module the analyzer
 * happened to parse first.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} endpointId
 * @returns {string[]} handler symbol node ids (possibly empty)
 */
export function handlersOf(graph, endpointId) {
  return graph.outEdges(endpointId).filter((e) => e.type === 'HANDLES').map((e) => e.to).sort(cmp);
}

/**
 * The nodes a forward walk from this endpoint must start at: EVERY handler.
 *
 * A census that walked only one of them would report the other module's code as
 * unreached, so this is the union — the same rule for `overview`, `map` and
 * `coupling`. A route the pack recorded no handler edge for starts at ITSELF
 * (the walk then finds whatever the route node itself is wired to, normally
 * nothing), so a handler-less route is still counted as an endpoint that reaches
 * nothing rather than dropped from the census.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} endpointId
 * @returns {string[]} one or more start node ids
 */
export function startsOf(graph, endpointId) {
  const handlers = handlersOf(graph, endpointId);
  return handlers.length ? handlers : [endpointId];
}

/**
 * The ONE handler a single-picture view follows (`flow` draws one chain, not a
 * union of chains — two controllers declaring the same route string are two
 * DEPLOYABLES, and merging their code into one drawing would claim a request
 * runs through both).
 *
 * The rule is the lowest handler id, which is a property of the GRAPH. It is
 * deliberately NOT the endpoint node's own `handler` attribute: an endpoint node
 * merged from two controllers carries whichever handler was ingested last, so a
 * view that trusted it named a different method than a view that read the edges.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} endpointId
 * @returns {string|null} null when the pack recorded no handler edge at all
 */
export function primaryHandlerOf(graph, endpointId) {
  const handlers = handlersOf(graph, endpointId);
  return handlers.length ? handlers[0] : null;
}

/**
 * The routes this pack maps to more than one handler method — the disclosure
 * that stops a reader seeing one route twice and concluding the analysis is
 * wrong.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @returns {{endpoint:string, handlers:string[]}[]} sorted by endpoint id;
 *          ids are stripped of their kind prefix (display form)
 */
export function multiHandlerRoutes(graph) {
  const out = [];
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    const handlers = handlersOf(graph, n.id);
    if (handlers.length < 2) continue;
    out.push({ endpoint: strip(n.id), handlers: handlers.map(strip) });
  }
  return out.sort((a, b) => cmp(a.endpoint, b.endpoint));
}

/**
 * Walk forward from EVERY endpoint in the graph and report, per endpoint, the
 * mapper statements it reaches.
 *
 * Two routes on the same handler walk the same chain, so the walk is memoised
 * by START node, not by endpoint — a 160-endpoint pack must not walk the same
 * tree twice. A route can name MORE THAN ONE handler (an interface method with
 * two implementations): every one of them runs when that route is hit, so the
 * endpoint gets the UNION of their walks. Taking only the first would hide the
 * statements the other one reaches.
 *
 * A statement reached by two starts keeps the STRONGEST of the two path grades,
 * each of which is already the weakest link ON ITS OWN PATH. That is the
 * engine's rule everywhere (Graph.reach, chainWalk's `best` record, the tables
 * lane of the Flow view): weakest-link WITHIN a path, strongest ACROSS the
 * alternative paths. Taking the weakest across paths instead would report a
 * relation the analyzer confirmed as a candidate, and the same endpoint→table
 * relation would read SOUND_SET here and EXACT in the Flow tab.
 *
 * `walk` is the cut census, summed over DISTINCT starts (a start walked for two
 * routes is ONE walk and must not be counted twice): what the walks did NOT
 * look at, so an empty answer can be told apart from an absence: `generated`
 * counts the machine-written interior steps the generated rule did not take
 * (core/chain.mjs). One field there is a SHAPE rather than a cut —
 * `multiHandlerEndpoints`, how many routes needed more than one start — because
 * a caller must be able to disclose it without scanning the graph a second time.
 *
 * Each endpoint also carries its OWN `depthCut` — how many nodes were still
 * expanding at the depth cap across ITS starts — because a census counting
 * ENDPOINTS that hit the cap cannot be derived from a per-start total.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:'strict'|'conservative'|'heuristic', depth?:number, maxNodes?:number,
 *          packageDepth?:number|null, only?:string[]}} [opts]
 *        packageDepth comes from the profile (`moduleAttribution.packageDepth`)
 *        and only changes how endpoints are GROUPED — never which statements
 *        they reach. `only` narrows the census to the endpoint node ids it
 *        names; everything else about the walk is unchanged.
 * @returns {{endpoints:{id:string, path:string|null, httpMethod:string|null, group:string,
 *                       handlers:number, depthCut:number,
 *                       statements:{id:string, grade:string}[]}[],
 *            walk:{starts:number, depthCut:number, depthCutStarts:number,
 *                  nodeCapStarts:number, byMode:number, generated:number,
 *                  multiHandlerEndpoints:number, outboundEndpoints:number}}}
 *          outboundEndpoints: routes in the graph that this pack CALLS over HTTP
 *          and does not serve — excluded from the walk, never from the report.
 */
export function walkEndpoints(graph, opts = {}) {
  const mode = opts.mode ?? 'conservative';
  if (!GRADE_SETS[mode]) throw new WalkError(`unknown mode: ${JSON.stringify(mode)}`);
  const depth = opts.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1) throw new WalkError(`depth must be a positive integer, got ${depth}`);

  let endpoints = [];
  let outboundEndpoints = 0;
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    // AN OUTBOUND ROUTE IS NOT ONE OF THIS PACK'S ENDPOINTS. It is in the graph
    // because a @FeignClient method here CALLS it, and nothing here answers it
    // (src/adapters/java_bridge.mjs marks it `outbound`). Walking from it would
    // add a route this project does not serve to every per-endpoint census, and
    // it would reach nothing — an "endpoint that reaches no statement" that is
    // really an endpoint somebody else serves. Counted, not walked.
    if (n.outbound === true && handlersOf(graph, n.id).length === 0) { outboundEndpoints += 1; continue; }
    endpoints.push({
      id: n.id,
      path: n.path ?? null,
      httpMethod: n.httpMethod ?? null,
      group: groupOfEndpoint(n, { packageDepth: opts.packageDepth ?? null }),
      handlers: 0,
      depthCut: 0,
      statements: [],
    });
  }
  // ONE ROUTE'S PICTURE, NOT THE WHOLE PACK'S (RM45). `only` narrows this
  // census to the endpoints it names. The caller that needs it already knows
  // which route it is asking about - a map that crosses into another project
  // asks that project for the route it called and nothing else - and walking
  // every handler in that pack to throw all but one away would cost the whole
  // pack for one line. An id that is not a served endpoint here is simply
  // absent: the same silence a route this pack does not serve already gets.
  if (opts.only != null) {
    if (!Array.isArray(opts.only)) throw new WalkError('only must be an array of endpoint node ids');
    const want = new Set(opts.only);
    endpoints = endpoints.filter((e) => want.has(e.id));
  }
  endpoints.sort((a, b) => cmp(a.id, b.id)); // deterministic walk order

  const walkCache = new Map(); // start node id -> {statements:[{id,grade}], cutDepth:number}
  const walk = { starts: 0, depthCut: 0, depthCutStarts: 0, nodeCapStarts: 0, byMode: 0, generated: 0, multiHandlerEndpoints: 0, outboundEndpoints };
  for (const ep of endpoints) {
    const handlers = handlersOf(graph, ep.id);
    const starts = handlers.length ? handlers : [ep.id];
    ep.handlers = handlers.length;
    if (handlers.length > 1) walk.multiHandlerEndpoints += 1;
    const reached = new Map(); // statement node id -> weakest path grade
    for (const start of starts) {
      let cached = walkCache.get(start);
      if (!cached) {
        const w = chainWalk(graph, {
          start, direction: 'down', mode, maxDepth: depth,
          ...(opts.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
        });
        cached = {
          statements: w.statements.map((s) => ({ id: `statement:${s.id}`, grade: s.grade })),
          cutDepth: w.cut.depth,
        };
        walkCache.set(start, cached);
        walk.starts += 1;
        walk.depthCut += w.cut.depth;
        if (w.cut.depth > 0) walk.depthCutStarts += 1;
        if (w.cut.nodeCap) walk.nodeCapStarts += 1;
        walk.byMode += w.cut.byMode;
        walk.generated += w.cut.generated;
      }
      ep.depthCut += cached.cutDepth;
      for (const s of cached.statements) {
        const prev = reached.get(s.id);
        if (prev === undefined || RANK[s.grade] > RANK[prev]) reached.set(s.id, s.grade);
      }
    }
    ep.statements = [...reached.entries()].map(([id, grade]) => ({ id, grade })).sort((a, b) => cmp(a.id, b.id));
  }

  return { endpoints, walk };
}

/**
 * Walk forward from EVERY screen in the graph and report, per screen, the
 * endpoints, mapper statements and tables it reaches (RM30 §C).
 *
 * The mirror of `walkEndpoints`, one lane further out: it starts at the router's
 * own declaration, goes through the component's functions and the api functions
 * they call, and comes out at the same statements and tables. It is the walk
 * `browse kind=screen` lists and `overview` counts, so the two cannot disagree
 * about what a screen touches.
 *
 * A HAR edge is RUNTIME_ONLY and therefore below every mode's floor, so nothing
 * here follows one: a recording is shown beside these numbers (`observed`),
 * never counted inside them.
 *
 * DEPTH. A screen is FURTHER from a table than an endpoint is (screen → its
 * function → the api function → the route → the handler → the service → the
 * mapper → the statement is already seven hops), so the default is the same 8
 * every whole-pack census uses and the cut is disclosed per screen rather than
 * silently swallowed.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:'strict'|'conservative'|'heuristic', depth?:number, maxNodes?:number}} [opts]
 * @returns {{screens:{id:string, path:string|null, label:string|null, title:string|null,
 *                     group:string|null, component:string|null, source:string|null,
 *                     observed:boolean, depthCut:number,
 *                     endpoints:{id:string, grade:string}[],
 *                     statements:{id:string, grade:string}[],
 *                     tables:{id:string, grade:string}[]}[],
 *            walk:{starts:number, depthCut:number, depthCutStarts:number,
 *                  nodeCapStarts:number, byMode:number, generated:number}}}
 */
export function walkScreens(graph, opts = {}) {
  const mode = opts.mode ?? 'conservative';
  if (!GRADE_SETS[mode]) throw new WalkError(`unknown mode: ${JSON.stringify(mode)}`);
  const depth = opts.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1) throw new WalkError(`depth must be a positive integer, got ${depth}`);

  const ids = [];
  for (const n of graph.nodes.values()) if (n.kind === 'screen') ids.push(n.id);
  ids.sort(cmp);

  const screens = [];
  const walk = { starts: 0, depthCut: 0, depthCutStarts: 0, nodeCapStarts: 0, byMode: 0, generated: 0 };
  for (const id of ids) {
    const n = graph.nodes.get(id);
    const w = chainWalk(graph, {
      start: id, direction: 'down', mode, maxDepth: depth,
      ...(opts.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
    });
    walk.starts += 1;
    walk.depthCut += w.cut.depth;
    if (w.cut.depth > 0) walk.depthCutStarts += 1;
    if (w.cut.nodeCap) walk.nodeCapStarts += 1;
    walk.byMode += w.cut.byMode;
    walk.generated += w.cut.generated;
    screens.push({
      id,
      path: n.path ?? null,
      label: n.label ?? null,
      title: n.title ?? null,
      group: n.group ?? null,
      component: n.component ?? null,
      source: n.source ?? null,
      observed: n.observed === true,
      depthCut: w.cut.depth,
      endpoints: (w.endpoints ?? []).map((e) => ({ id: `endpoint:${e.id}`, grade: e.grade }))
        .sort((a, b) => cmp(a.id, b.id)),
      statements: w.statements.map((s) => ({ id: `statement:${s.id}`, grade: s.grade }))
        .sort((a, b) => cmp(a.id, b.id)),
      tables: w.tables.map((t) => ({ id: `table:${t.table}`, grade: t.grade }))
        .sort((a, b) => cmp(a.id, b.id)),
    });
  }
  return { screens, walk };
}

/**
 * The SCREENS a change to this node would be felt on, with the weakest grade on
 * the path that reaches them (RM30 §C).
 *
 * The same backward reach `endpointsAffectingColumn` runs, read one lane
 * further out: column ← statement ← … ← handler ← route ← api function ←
 * component function ← screen. A HAR edge is RUNTIME_ONLY and below every
 * mode's floor, so a screen is here because the CODE says so, never because a
 * recording did.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} targetNodeId  a column, table, statement, symbol or endpoint
 * @param {{mode?:string}} [opts]
 * @returns {{screen:string, path:string|null, label:string|null, pathGrade:string,
 *            viaHttp?:boolean, httpHops?:number}[]}
 */
export function screensAffecting(graph, targetNodeId, opts = {}) {
  const reached = graph.impactOf(targetNodeId, { mode: opts.mode ?? 'conservative', edgeTypes: FLOW_EDGE_TYPES });
  const out = [];
  for (const [id, info] of reached) {
    const n = graph.nodes.get(id);
    if (!n || n.kind !== 'screen') continue;
    out.push({
      screen: id,
      path: n.path ?? null,
      label: n.label ?? null,
      pathGrade: info.pathGrade,
      ...(info.http > 1 ? { viaHttp: true, httpHops: info.http } : {}),
    });
  }
  return out.sort((a, b) => cmp(a.screen, b.screen));
}

/**
 * The screens a change to this COLUMN would be felt on. The named form of
 * `screensAffecting`, beside `endpointsAffectingColumn` in the java bridge, so
 * the two halves of the same question read the same way.
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} columnNodeId
 * @param {{mode?:string}} [opts]
 */
export function screensAffectingColumn(graph, columnNodeId, opts = {}) {
  return screensAffecting(graph, columnNodeId, opts);
}

/**
 * Whether a recording confirms this screen calling this endpoint: a HAR edge
 * (RUNTIME_ONLY, `evidence.rule === 'har'`) between the two. It is a MARKER on
 * a row, never a grade and never a step of a walk.
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} screenId
 * @param {Set<string>|string[]} endpointIds
 * @returns {boolean}
 */
export function observedCall(graph, screenId, endpointIds) {
  const wanted = endpointIds instanceof Set ? endpointIds : new Set(endpointIds ?? []);
  for (const e of graph.outEdges(screenId)) {
    if (e.type !== 'CALLS_HTTP' || e.grade !== 'RUNTIME_ONLY') continue;
    if (wanted.size === 0 || wanted.has(e.to)) return true;
  }
  return false;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function strip(id) { return id.slice(id.indexOf(':') + 1); }

export class WalkError extends Error {
  constructor(message) { super(message); this.name = 'WalkError'; }
}
