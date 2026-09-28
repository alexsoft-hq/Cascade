// prefix_notes.mjs — what `cascade analyze` says about the path prefixes the profile declares, once the lanes have run.
//
// Two things can go quietly wrong with a declared `pathPrefixes`, and both are
// said here rather than left to the numbers: an entry that no controller class
// passed (a typo, or a package that moved), and a frontend whose calls do not
// carry the prefix the backend is now keyed under (its base URL is an env value
// the web lane cannot read). Neither changes the graph: they are notes, and the
// second only names the declaration that would settle it.

import { prefixedPath } from '../../../adapters/java/path_prefixes.mjs';

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

/**
 * A FRONTEND THAT DOES NOT WRITE THE DECLARED PREFIX. Once `/admin-api` is put
 * before a route, a frontend call written as `/system/user/page` names it only
 * when the web lane knows the frontend's base URL carries the prefix. Counted
 * from the web calls that missed: how many name a served route once a declared
 * prefix is put before them. Exact paths only, so the count is a floor.
 */
export function prefixNotOnCallsNotes(graph, jstats) {
  const declared = (jstats?.pathPrefixes ?? []).filter((p) => p.routes > 0).map((p) => p.prefix);
  if (declared.length === 0) return [];
  const served = new Set();
  for (const n of graph.nodes.values()) if (n.kind === 'endpoint' && !n.outbound) served.add(n.path);
  const missed = graph.edges
    .filter((e) => e.type === 'CALLS_HTTP' && e.grade === 'UNRESOLVED' && e.evidence?.sink && !e.evidence.url?.host)
    .map((e) => e.evidence.url?.template).filter((t) => typeof t === 'string');
  const best = declared.map((prefix) => ({ prefix, count: missed.filter((t) => served.has(prefixedPath(prefix, t))).length }))
    .sort((a, b) => b.count - a.count || (a.prefix < b.prefix ? -1 : 1))[0];
  if (!best || best.count === 0) return [];
  return [{
    kind: 'PREFIX_NOT_ON_CALLS', severity: 'warn', key: 'gatewayRoutes',
    reason: `${best.count} of ${missed.length} frontend call(s) that name no route here would name one with ${best.prefix} before them, `
      + 'the prefix pathPrefixes puts before the routes they mean. If the frontend\'s base URL carries it (an env value the web lane does not read), '
      + `declare gatewayRoutes {"*": "${best.prefix}"}, or map the prefix the frontend writes onto it`,
  }];
}
