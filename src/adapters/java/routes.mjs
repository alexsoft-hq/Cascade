// routes.mjs — the routes this pack SERVES, and the routes it CALLS.
//
// WHAT THIS MODULE OWNS. Everything a mapping annotation or an HTTP client turns
// into on the graph:
//   the classification  what a mapping annotation MEANS, decided from the type
//                       that carries it: a route served here, a route called
//                       over HTTP, or a contract somebody else implements
//   the endpoint node   one node per "METHOD path", whatever how many
//                       controllers declare it, with its primary handler
//   HANDLES             one edge per declaration, from the route to the method
//   CALLS_HTTP          from a @FeignClient/@HttpExchange method (the route is
//                       in the annotation) and from an imperative WebClient /
//                       RestClient / RestTemplate call (the verb is a method
//                       name and the url is an argument), with the declared
//                       gateway prefix applied to the second
//   the outbound node   a route this pack calls and does not answer
//
// WHAT IT MUST NEVER KNOW ABOUT: how a MAY_CALL was resolved, what a mapper is,
// or what the statistics mean. It is handed the fact index, the type index and
// the one primitive that writes a symbol node, and it writes routes.
//
// The route MATCH is not here either: `src/adapters/http_routes.mjs` owns it,
// because the web lane asks the same question of a browser call and two rules
// would mean two answers for one url.

import { routeMatches, normalizeUrlPath, gatewayRouteOf } from '../http_routes.mjs';
import { classifyRouteHolder, cmp, endpointId, ownerOf, symbolId } from './types.mjs';

/** What each ROUTE rule did, in one sentence, for `evidence.basis`. */
export const ROUTE_RULE_BASIS = Object.freeze({
  'route-contract-impl': 'the mapping is on an interface/abstract declaration; the handler is the concrete @Controller that implements it, matched through `implements` by method name (and arity where the worker recorded one), not by compiler binding',
  'route-contract-only': 'the mapping is on an interface/abstract declaration that NO concrete controller in this pack implements: the route is declared here and served somewhere this analysis cannot see',
  'http-client': 'a @FeignClient/@HttpExchange method CALLS this route over HTTP; which deployable answers is not knowable from source, so the service name and url are recorded as written and the grade says only whether a route with this method+path exists in the pack',
  'http-client-call': 'an IMPERATIVE client call (a WebClient/RestClient chain or a RestTemplate request) sends this method to this url: the verb is the method the code named, and the path is the url reduced as far as one file allows, with a scheme://host stripped off and kept as evidence. Which deployable answers is not knowable from source, so the grade says only whether a route with this method+path exists in the pack, and drops to HEURISTIC when the verb was an argument this lane could not read and only the path was matched',
});

  // ---- endpoints + HANDLES ----------------------------------------------
  //
  // A ROUTE CAN BE DECLARED BY MORE THAN ONE CONTROLLER. An endpoint is keyed by
  // "METHOD path" (position-independent, §8.1), so the same route string in two
  // modules is ONE node with two HANDLES edges — a real fact about the pack. In
  // mall, `GET /order/list` is declared by both `OmsOrderController#list` (the
  // admin module) and `OmsPortalOrderController#list` (the portal).
  //
  // THE DEFECT THIS BLOCK FIXES (RM11 fixed the WALKS; the node was left).
  // `addNode` merges by id, so writing the node once per endpoint FACT let the
  // second declaration overwrite the first: the node's `handler`, `file` and
  // `line` named whichever declaration came LAST in the fact stream.
  //
  // Measured, not assumed. On the `analyze` and overlay paths that stream is
  // sorted (core/facts_store.javaRecordSortKey sorts endpoint records by
  // handler fqn), so the winner was deterministic — and it was the HIGHEST
  // handler fqn, while `primaryHandlerOf` and every view that calls it walk the
  // LOWEST. So the node named a method the views did not follow: on mall, 7 of
  // 239 routes, each of them naming the `mall-demo` or `mall-portal` copy while
  // `flow`, `map` and `coupling` walked the admin one, and the source preview
  // opened the file the node named. Hand the bridge an unsorted stream — which
  // any other caller may — and the attribute changes again, because it depended
  // on arrival order rather than on the code.
  //
  // The rule now: group the facts by route, and derive the node's own
  // attributes from the PRIMARY handler — the lowest handler symbol id, which
  // is exactly the rule `primaryHandlerOf` in src/core/walks.mjs applies to the
  // HANDLES edges. One rule, so the node and the edges cannot name different
  // methods. `line` comes from the endpoint fact that declared THAT handler (the
  // lowest, when one method carries two mappings), so `file`+`line` always point
  // at a mapping that really handles this route.
  //
  // A route with more than one handler SAYS SO on the node: `handlers` lists
  // every one, sorted, so a reader who only ever sees the endpoint (a source
  // preview, the viewer's node card) is told the route is declared twice rather
  // than silently shown one of the two. It is absent on a single-handler route —
  // writing a one-element list on every endpoint would add a field to every
  // endpoint node in the pack to say nothing.
  //
  // AND A MAPPING ANNOTATION IS NOT ALWAYS A HANDLER (RM14). Every endpoint FACT
  // is first classified by its enclosing type (`classifyRouteHolder`): a
  // @FeignClient/@HttpExchange method CALLS the route, a plain interface or
  // abstract class DECLARES it for an implementer to serve, and only a concrete
  // controller serves it here. Measured on jeecg-boot, 107 routes carried two
  // HANDLES edges and 97 of them paired the @FeignClient `ISysBaseAPI` with the
  // @RestController that actually answers — the same route counted twice, once
  // as the caller.
/**
 * Every endpoint fact, classified and turned into the route declarations the
 * graph will carry. Nothing is written here; the two lists come back so the node
 * and the edges below are built from ONE reading of them.
 *
 * @returns {{routes:object[], clientCalls:object[]}}
 */
export function classifyRoutes(ctx) {
  const {
    endpoints, typeAt, aritiesOfMember, implementorsOf, types, declares, lineOfMember, stats,
  } = ctx;
  const routes = [];       // {epId, httpMethod, path, handler, line, grade, evidence, contractOnly}
  const clientCalls = [];  // {epId, httpMethod, path, from, client}
  for (const e of endpoints) {
    if (!e.handler) continue;
    const epId = endpointId(e.httpMethod, e.path);
    const holder = typeAt(e.handlerType, e.file);
    const kind = classifyRouteHolder(holder);
    if (kind === 'client') {
      clientCalls.push({ epId, httpMethod: e.httpMethod, path: e.path, from: e.handler, client: holder.client });
      continue;
    }
    if (kind === 'handler') {
      routes.push({ epId, httpMethod: e.httpMethod, path: e.path, handler: e.handler, line: e.line ?? null, grade: 'EXACT', evidence: null });
      continue;
    }
    // A ROUTE CONTRACT. The mapping is on the declaration; the code that runs is
    // the implementer's. Matched by name, and by ARITY when the worker recorded
    // one for the contract method — which it does for an interface method and
    // for any method that carries a mapping. `evidence.match` says which, so a
    // reader is never left to assume the stronger of the two.
    const name = e.handler.slice(e.handler.lastIndexOf('#') + 1);
    const arities = aritiesOfMember.get(e.handler) ?? null;
    const impls = [...(implementorsOf.get(e.handlerType) ?? new Set())]
      .filter((sub) => classifyRouteHolder(types.get(sub)) === 'handler'
        && (arities ? [...arities].some((n) => declares(sub, name, n)) : declares(sub, name, null)))
      .sort(cmp);
    stats.routeContracts += 1;
    if (impls.length === 0) {
      // Nobody in this pack implements it. The route is REAL — it is declared —
      // so it is emitted with the contract method as its handler and SAYS SO,
      // rather than being dropped or quietly attributed to a controller.
      stats.contractOnlyRoutes += 1;
      routes.push({
        epId, httpMethod: e.httpMethod, path: e.path, handler: e.handler, line: e.line ?? null,
        grade: 'EXACT', contractOnly: true,
        evidence: { rule: 'route-contract-only', basis: ROUTE_RULE_BASIS['route-contract-only'], contract: e.handler, contractOnly: true },
      });
      continue;
    }
    for (const sub of impls) {
      const member = `${sub}#${name}`;
      routes.push({
        epId, httpMethod: e.httpMethod, path: e.path, handler: member,
        line: lineOfMember.get(member) ?? null,
        grade: 'SOUND_SET',
        evidence: {
          rule: 'route-contract-impl', basis: ROUTE_RULE_BASIS['route-contract-impl'],
          contract: e.handler, match: arities ? 'name+arity' : 'name',
        },
      });
    }
  }
  return { routes, clientCalls };
}

/**
 * ONE NODE PER ROUTE, whatever how many controllers declare it, with the
 * attributes of the PRIMARY handler — the lowest handler symbol id, which is
 * exactly the rule `primaryHandlerOf` in src/core/walks.mjs applies to the
 * HANDLES edges. One rule, so the node and the edges cannot name different
 * methods.
 *
 * @returns {Map<string,object>} endpoint id -> {httpMethod, path, lineOf, contractOnly}
 */
export function placeEndpointNodes(ctx, routes) {
  const { g, fileOf } = ctx;
  const byRoute = new Map(); // endpoint id -> {httpMethod, path, lineOf:Map<handler,line>, contractOnly}
  for (const r of routes) {
    let rec = byRoute.get(r.epId);
    if (!rec) { rec = { httpMethod: r.httpMethod, path: r.path, lineOf: new Map(), contractOnly: true }; byRoute.set(r.epId, rec); }
    if (r.contractOnly !== true) rec.contractOnly = false;
    const prev = rec.lineOf.get(r.handler);
    // Two mappings on ONE method (`@GetMapping({"", "/"})` under a class-level
    // @RequestMapping) can be two facts for the same handler and route: keep the
    // LOWEST line, chosen by value, so the node does not depend on which of them
    // arrived first either.
    if (prev === undefined || (r.line != null && (prev == null || r.line < prev))) rec.lineOf.set(r.handler, r.line ?? null);
  }
  for (const [epId, rec] of byRoute) {
    const handlers = [...rec.lineOf.keys()].sort((a, b) => (symbolId(a) < symbolId(b) ? -1 : symbolId(a) > symbolId(b) ? 1 : 0));
    const primary = handlers[0];
    g.addNode({
      id: epId, path: rec.path, httpMethod: rec.httpMethod,
      handler: primary, file: fileOf(ownerOf(primary)), line: rec.lineOf.get(primary) ?? null,
      ...(handlers.length > 1 ? { handlers } : {}),
      // Only ever written as TRUE, like every other flag on a node: the census
      // can then say "N routes are declared by an interface nobody implements
      // here" without a field on every endpoint in the pack.
      ...(rec.contractOnly ? { contractOnly: true } : {}),
    });
  }
  return byRoute;
}

/** The HANDLES edges, one per declaration, in the order they were classified. */
export function placeHandlesEdges(ctx, routes) {
  const { g, ensureSymbol, stats } = ctx;
  // The edges stay one per declaration, in the order they were classified:
  // `stats.handles` counts declarations, and the pack sorts its edges by
  // (from, to, type).
  for (const r of routes) {
    const hId = ensureSymbol(r.handler);
    g.addEdge({
      from: r.epId, to: hId, type: 'HANDLES', grade: r.grade,
      ...(r.evidence ? { evidence: r.evidence } : {}),
    });
    stats.endpoints += 1; stats.handles += 1;
  }
}

  // ---- CALLS_HTTP: a declarative client method --> the route it calls -----
  //
  // The route node it points at may be one this pack SERVES (another module's
  // controller — the internal HTTP hop of §1.1, and the walks cross it) or one
  // it does not. Which deployable answers is not knowable from source, so the
  // service name and url the annotation carries ride as EVIDENCE, and the grade
  // says only what was checked: SOUND_SET when a route with that method+path is
  // in this pack, UNRESOLVED when none is — an UNRESOLVED edge is below every
  // mode's floor, so no walk follows it and nothing is claimed about where it
  // lands. The count is reported (`httpCallsUnresolved`) instead.
export function placeDeclarativeCalls(ctx, clientCalls, byRoute) {
  const { g, ensureSymbol, stats } = ctx;
  const servedRoutes = new Set(byRoute.keys());
  for (const c of clientCalls) {
    const resolved = servedRoutes.has(c.epId);
    if (!g.nodes.has(c.epId)) {
      // A route nothing here answers. It is a real target of a real call, so it
      // is in the graph — and marked, so a census can tell "a route this pack
      // serves" from "a route this pack calls".
      g.addNode({ id: c.epId, path: c.path, httpMethod: c.httpMethod, outbound: true });
    }
    const client = c.client ?? {};
    g.addEdge({
      from: ensureSymbol(c.from), to: c.epId, type: 'CALLS_HTTP',
      grade: resolved ? 'SOUND_SET' : 'UNRESOLVED',
      evidence: {
        rule: 'http-client', basis: ROUTE_RULE_BASIS['http-client'],
        annotation: client.kind ?? null,
        service: client.service ?? null,
        // The annotation very often names a CONSTANT, not a service; saying which
        // is the difference between evidence and a claim.
        serviceLiteral: client.serviceLiteral === true,
        url: client.url ?? null,
        target: resolved ? 'in-pack' : 'outside-pack',
      },
    });
    stats.httpCalls += 1;
    stats.httpCallsDeclarative += 1;
    if (resolved) stats.httpCallsResolved += 1; else stats.httpCallsUnresolved += 1;
  }
}

  // ---- CALLS_HTTP: an IMPERATIVE client call --> the route it calls -------
  //
  // The same edge, from the other way of writing the call. A declarative client
  // states its route in an annotation; a WebClient/RestClient chain or a
  // RestTemplate request states a VERB and a URL somebody built, and until this
  // rule the lane saw none of them — a five-service application whose gateway
  // calls the other four with a WebClient drew no cross-service edge at all.
  //
  // WHAT IS DECIDED HERE, and nowhere else:
  //  - the path is matched against the routes this pack SERVES with the web
  //    lane's own `routeMatches`, exactly and then by template, because a
  //    route's `{ownerId}` and a call's `{*}` are holes of different kinds;
  //  - `gatewayRoutes` rewrites the call's prefix first, the way the web bridge
  //    rewrites a frontend call's, so a service calling another THROUGH a
  //    gateway prefix lands on the route the other service really serves;
  //  - a url the worker could not reduce to a path draws NO edge. Inventing a
  //    route node for `restTemplate.exchange(url, …)` would put a route in the
  //    graph that no line of source spells. The count says how many.
  //
  // The grade never rises above SOUND_SET, for the reason the declarative edge
  // above gives: a host is a service NAME, and which deployable answers it is
  // not a fact about the source.
/**
 * The routes this pack SERVES, in one list, and the question "which of them
 * could this method+path reach?" asked once against it.
 */
export function servedRouteIndex(ctx, byRoute) {
  const { gatewayRoutes } = ctx;
  const servedList = [...byRoute.entries()]
    .map(([epId, r]) => ({ epId, httpMethod: r.httpMethod ?? 'ANY', path: normalizeUrlPath(r.path) }))
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.epId, b.epId));
  const gatewayKeys = Object.keys(gatewayRoutes)
    .filter((k) => k !== '*')
    .sort((a, b) => b.length - a.length || cmp(a, b));
  /** The routes this pack serves that this method+path could reach. */
  const matchServed = (httpMethod, callPath) => {
    const methodOk = (r) => httpMethod === null || r.httpMethod === 'ANY' || r.httpMethod === httpMethod;
    const exact = servedList.filter((r) => r.path === callPath && methodOk(r));
    if (exact.length > 0) return { how: 'exact', routes: exact };
    const hits = servedList.filter((r) => r.path !== callPath && routeMatches(r.path, callPath) && methodOk(r));
    return hits.length > 0 ? { how: 'template', routes: hits } : { how: null, routes: [] };
  };
  return { servedList, gatewayKeys, matchServed };
}

/**
 * WHERE THE CALL REALLY LANDS. The url the worker read, with the declared
 * gateway prefix applied, and the routes of this pack it could reach.
 *
 * A `gatewayRoutes` entry rewrites the prefix the way the web bridge rewrites a
 * frontend call's, so a service calling another THROUGH a gateway prefix lands
 * on the route the other service really serves — and the gateway's own table is
 * where the name of the deployable that answers comes from when the call itself
 * carried no host.
 */
function imperativeTarget(c, { gatewayKeys, gatewayRoutes, matchServed }) {
  let full = normalizeUrlPath(c.path);
  let prefix = null;
  // The service a DECLARED route forwards to, when the call itself carried no
  // host. A gateway's route table names the deployable, and that name is what
  // lets an answer cross into the right sibling later (src/mcp/federation.mjs).
  let routeService = null;
  const hit = gatewayKeys.find((k) => full === k || full.startsWith(`${k}/`));
  if (hit !== undefined) {
    const route = gatewayRouteOf(gatewayRoutes[hit]);
    full = normalizeUrlPath(`${route.to}${full.slice(hit.length)}`);
    prefix = { value: route.to, from: 'declared', written: hit };
    routeService = route.service;
  }
  const httpMethod = typeof c.httpMethod === 'string' && c.httpMethod.length > 0 ? c.httpMethod : null;
  const found = matchServed(httpMethod, full);
  const targets = found.routes.length > 0
    ? found.routes.map((r) => ({ epId: r.epId, resolved: true }))
    : [{ epId: endpointId(httpMethod ?? 'ANY', full), resolved: false }];
  return { full, prefix, routeService, httpMethod, found, targets };
}

/**
 * ONE CALLS_HTTP edge from an imperative call to one route it could reach, with
 * everything the source said riding on it as evidence.
 */
function placeOneImperativeEdge(ctx, c, t, where) {
  const { g, stats } = ctx;
  const { fromId, full, prefix, routeService, httpMethod, found } = where;
  if (!g.nodes.has(t.epId)) {
    // A route nothing here answers, marked the way the declarative rule
    // marks one: a census can then tell a route this pack serves from a
    // route it only calls.
    g.addNode({ id: t.epId, path: full, httpMethod: httpMethod ?? 'ANY', outbound: true });
  }
  // A call whose VERB the worker could not read (`exchange(url, method, …)`)
  // was matched on the path alone, so it names whichever routes share that
  // path whatever their method. That is a weaker rule than the one above and
  // says so: HEURISTIC is below the conservative floor, so a walk that only
  // trusts checked links does not cross it.
  const grade = t.resolved ? (httpMethod === null ? 'HEURISTIC' : 'SOUND_SET') : 'UNRESOLVED';
  g.addEdge({
    from: fromId, to: t.epId, type: 'CALLS_HTTP',
    grade,
    evidence: {
      rule: 'http-client-call', basis: ROUTE_RULE_BASIS['http-client-call'],
      // Which client the code used, when the receiver's declared type said
      // so; null when only the SHAPE of the chain identified it.
      client: c.client ?? null,
      // The host is usually a logical SERVICE NAME rather than a machine,
      // and `serviceLiteral` says whether it was written as one or came out
      // of a base the worker could not read — the same distinction the
      // declarative edge draws for an annotation that names a constant. A
      // call written with no host at all takes the name from the declared
      // gateway route that rewrote it, which is where a gateway states it.
      service: c.host ?? routeService ?? null,
      serviceLiteral: c.host ? c.hostLiteral === true : routeService !== null,
      // The url as the source wrote it, the path this pack was searched for,
      // and how much of it was literal.
      url: { written: c.written ?? null, template: full, kind: c.urlKind ?? null, base: c.base ?? null },
      ...(c.query ? { query: c.query } : {}),
      method: httpMethod,
      ...(prefix ? { prefix } : {}),
      match: found.how,
      line: c.line ?? null,
      target: t.resolved ? 'in-pack' : 'outside-pack',
    },
  });
  stats.httpCalls += 1;
  stats.httpCallsImperative += 1;
  if (t.resolved) stats.httpCallsResolved += 1; else stats.httpCallsUnresolved += 1;
}

/** The CALLS_HTTP edges an imperative client call produces. */
export function placeImperativeCalls(ctx, byRoute) {
  const { ensureSymbol, stats, httpCallFacts, gatewayRoutes } = ctx;
  const { gatewayKeys, matchServed } = servedRouteIndex(ctx, byRoute);
  // Sorted, and de-duplicated by (caller, route): the same call written twice in
  // one method is one relation, and two assemblies of the same shards must place
  // the same edges whatever order the records arrive in.
  const imperativeSeen = new Set();
  const imperative = httpCallFacts.slice().sort((a, b) => cmp(a.from ?? '', b.from ?? '')
    || (a.line ?? 0) - (b.line ?? 0)
    || cmp(a.httpMethod ?? '', b.httpMethod ?? '')
    || cmp(a.path ?? '', b.path ?? ''));
  for (const c of imperative) {
    if (!c.from || typeof c.path !== 'string' || c.path.length === 0) {
      stats.httpCallsUrlUnreadable += 1;
      continue;
    }
    const where = imperativeTarget(c, { gatewayKeys, gatewayRoutes, matchServed });
    where.fromId = ensureSymbol(c.from);
    for (const t of where.targets) {
      const key = `${where.fromId} ${t.epId}`;
      if (imperativeSeen.has(key)) continue;
      imperativeSeen.add(key);
      placeOneImperativeEdge(ctx, c, t, where);
    }
  }
}
