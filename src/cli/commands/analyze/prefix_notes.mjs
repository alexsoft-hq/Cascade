// prefix_notes.mjs — what `cascade analyze` says about the path prefixes the profile declares, once the lanes have run.
//
// Two things can go quietly wrong with a declared `pathPrefixes`, and both are
// said here rather than left to the numbers: an entry that no controller class
// passed (a typo, or a package that moved), and a frontend whose calls do not
// carry the prefix the backend is now keyed under (its base URL was not read,
// or the calls were never traced to the client that carries it). Neither
// changes the graph: they are notes, and the second only names the
// declaration that would settle it.

import { prefixedPath } from '../../../adapters/java/path_prefixes.mjs';
import { routeServesMethod } from '../../../adapters/web/calls.mjs';

/** A declared entry that was put before no route. */
export function unusedPrefixNotes(jstats) {
  return (jstats?.pathPrefixes ?? []).flatMap((p, i) => {
    if (p.routes > 0) return [];
    const tests = [p.annotation ? `carries @${p.annotation}` : null, p.packages ? `sits in a package that ${p.packages} matches` : null]
      .filter(Boolean).join(' and ');
    return [{
      kind: 'PATH_PREFIX_UNUSED', severity: 'warn', key: 'pathPrefixes',
      reason: `pathPrefixes[${i}] (${p.prefix}) is put before no route: no controller class this run read ${tests || 'serves a route'}. `
        + 'Check the entry against the controllers it is meant for',
    }];
  });
}

/** Every route this pack serves, by path, with the methods it is declared for. */
function servedByPath(graph) {
  const served = new Map();
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint' || n.outbound) continue;
    if (!served.has(n.path)) served.set(n.path, []);
    served.get(n.path).push(n.httpMethod ?? 'ANY');
  }
  return served;
}

/**
 * The missed calls a prefix would make name a served route: same path once the
 * prefix is before it, and a method that route serves. A missed call's method is
 * the one the web lane keyed the route it missed by (ANY when it read none).
 */
function callsNamedWith(graph, missed) {
  const served = servedByPath(graph);
  const names = (prefix, e) => (served.get(prefixedPath(prefix, e.evidence.url.template)) ?? [])
    .some((m) => routeServesMethod(m, graph.nodes.get(e.to)?.httpMethod ?? null));
  return (prefix) => missed.filter((e) => names(prefix, e));
}

/**
 * A FRONTEND THAT DOES NOT WRITE THE DECLARED PREFIX. Once `/admin-api` is put
 * before a route, a frontend call written as `/system/user/page` names it only
 * when the web lane knows the frontend's base URL carries the prefix. Counted
 * from the web calls that missed: how many name a served route once a declared
 * prefix is put before them, with the method the route serves (the rule the web
 * lane matches a call by: src/adapters/web/calls.mjs, routeServesMethod). Exact
 * paths only, so the count is a floor.
 */
export function prefixNotOnCallsNotes(graph, jstats) {
  const declared = (jstats?.pathPrefixes ?? []).filter((p) => p.routes > 0).map((p) => p.prefix);
  if (declared.length === 0) return [];
  const missed = missedCallEdges(graph);
  const hits = callsNamedWith(graph, missed);
  const best = declared.map((prefix) => ({ prefix, count: hits(prefix).length }))
    .sort((a, b) => b.count - a.count || (a.prefix < b.prefix ? -1 : 1))[0];
  if (!best || best.count === 0) return [];
  const untraced = hits(best.prefix).filter((e) => e.evidence.sink.kind === 'untraced').length;
  return [{
    kind: 'PREFIX_NOT_ON_CALLS', severity: 'warn', key: 'gatewayRoutes', reason: notOnCallsReason(best, missed.length, untraced),
  }];
}

/**
 * The sentence. A call traced to no client had no client's base URL put before
 * it, however well the lane read that base URL: a different cure from a base
 * URL nobody could read, so it is said apart.
 */
function notOnCallsReason(best, missedCount, untraced) {
  return `${best.count} of ${missedCount} frontend call(s) that name no route here would name one with ${best.prefix} before them, `
    + 'the prefix pathPrefixes puts before the routes they mean'
    + `${untraced > 0 ? `; ${untraced} of them were traced to no client, so no client's base URL was put before them` : ''}. `
    + 'If the frontend\'s base URL carries it and this run did not read or apply it, '
    + `declare gatewayRoutes {"*": "${best.prefix}"}, or map the prefix the frontend writes onto it`;
}

/** The web calls that named no route here, written as a path with no host. */
function missedCallEdges(graph) {
  return graph.edges.filter((e) => e.type === 'CALLS_HTTP' && e.grade === 'UNRESOLVED' && e.evidence?.sink
    && !e.evidence.url?.host && typeof e.evidence.url?.template === 'string');
}
