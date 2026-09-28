// path_prefixes.mjs — the path prefix configuration code puts before a controller's routes, as the profile declares it.
//
// WHAT THIS MODULE OWNS. Where a served route really is, when the profile's
// `pathPrefixes` says a prefix goes before it: which entry a controller class
// passes, the joined address, and the API group after the prefix.
//
// Spring serves a controller's routes under a prefix when its handler mapping
// is told to: `RequestMappingHandlerMapping.setPathPrefixes(prefix -> predicate)`,
// or `PathMatchConfigurer.addPathPrefix(prefix, predicate)` in a
// WebMvcConfigurer. The predicate is a lambda over the controller class and the
// prefix is usually a property, so no reading of the source can say either.
// The profile's `pathPrefixes` says what they are, and this module applies them
// as Spring does: to the class that serves the route, and the FIRST entry whose
// test the class passes wins.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, or what a mapping annotation
// means. It is handed a type record and a route path, and answers with an
// address; src/adapters/java/routes.mjs decides which routes are served.

import { packagePatternMatcher } from '../../core/package_pattern.mjs';

/** Two halves of a route path, joined the way the Java worker joins a class and a method mapping. */
export function prefixedPath(prefix, path) {
  const joined = `${prefix ?? ''}/${path ?? ''}`.replace(/\/{2,}/g, '/');
  const lead = joined.startsWith('/') ? joined : `/${joined}`;
  return lead.length > 1 && lead.endsWith('/') ? lead.slice(0, -1) : lead;
}

/**
 * The first segment of a route path after its prefix: the API group a reader
 * means when every route of a product starts with the same `/admin-api`. Null
 * when there is none, or when it is a hole (`{id}`, `*`) rather than a name.
 */
export function apiGroupAfter(prefix, fullPath) {
  const head = prefixedPath(prefix, '');
  const rest = head === '/' ? fullPath : fullPath.slice(head.length);
  const seg = String(rest ?? '').split('/').find((s) => s !== '') ?? null;
  return seg !== null && !/[{}*]/.test(seg) ? seg : null;
}

/** One declared entry, ready to test a type record. */
function compileEntry(entry, index) {
  const inPackage = typeof entry.packages === 'string' ? packagePatternMatcher(entry.packages) : null;
  const annotation = typeof entry.annotation === 'string' ? entry.annotation : null;
  return {
    index,
    value: prefixedPath(entry.prefix, ''),
    packages: inPackage ? entry.packages : null,
    annotation,
    from: typeof entry.from === 'string' ? entry.from : null,
    test: (t) => (annotation === null || (t.annotations ?? []).includes(annotation))
      && (inPackage === null || inPackage(t.pkg ?? '')),
  };
}

/**
 * The declared prefixes, ready to place routes: `addressOf(typeRecord, path)`,
 * the route's address under the first entry the class passes, and that entry;
 * or the path as written and null. A class this lane has no record of is never
 * given a prefix, because nothing about it can be tested.
 *
 * When something is declared, `stats.pathPrefixes` counts how many routes each
 * entry gave, so an entry that matched no controller can be said. When nothing
 * is, the stats are left exactly as they were.
 *
 * @param {object[]} declared  the profile's `pathPrefixes`, validated
 * @param {object} stats  the Java lane's stats
 */
export function makePathPrefixes(declared, stats) {
  const entries = (Array.isArray(declared) ? declared : []).map(compileEntry);
  const census = entries.map((e) => ({
    prefix: e.value, packages: e.packages, annotation: e.annotation, routes: 0,
  }));
  if (census.length > 0) stats.pathPrefixes = census;
  return (t, path) => {
    const entry = t ? entries.find((e) => e.test(t)) ?? null : null;
    if (!entry) return { path, prefix: null };
    census[entry.index].routes += 1;
    return { path: prefixedPath(entry.value, path), prefix: entry };
  };
}

/** What a route's evidence says about its prefix. */
export function prefixEvidence(entry) {
  return {
    value: entry.value, from: 'declared', declaration: `pathPrefixes[${entry.index}]`,
    ...(entry.packages ? { packages: entry.packages } : {}),
    ...(entry.annotation ? { annotation: entry.annotation } : {}),
    ...(entry.from ? { source: entry.from } : {}),
  };
}
