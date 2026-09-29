// mapping_reads.mjs — what a mapping annotation says that one file could not settle alone (javafacts/22).
//
// WHAT THIS MODULE OWNS. The step between the worker's endpoint records and the
// route declarations ./routes.mjs classifies:
//   a path in parts      `@PostMapping(RpcConstants.RPC_API_PREFIX + "/iot/device/auth")`
//                        names a constant of ANOTHER type, which is another file's
//                        fact: read here from that type's own record, or said
//   a composed mapping   `@AnonymousPostMapping("/login")` is a route when the tree
//                        declares that annotation with a meta @RequestMapping; its
//                        methods, its path and its aliases are the annotation's own
//                        record, read here against the method that uses it
//   the grade a route    a method name that is no HTTP method, and two handlers of
//   rests on             one route split by a request condition
//
// WHAT IT MUST NEVER KNOW ABOUT: which type holds a route (./types.mjs
// classifyRouteHolder), a prefix the profile declares (./path_prefixes.mjs), and
// what a HANDLES edge is. It hands back endpoint records like the worker's.
//
// NOTHING IS PLACED AT AN ADDRESS THE SOURCE DOES NOT STATE. A path that stays
// unread is no route, and the lane stats name it with what was written.

import { cmp } from './types.mjs';

/** How many unread mappings the lane stats name. The counts are always whole. */
const SAMPLE_LIMIT = 20;

/** What each reading of a mapping rests on, in one sentence, for `evidence.basis`. */
export const MAPPING_BASIS = Object.freeze({
  'route-path-constant': 'the mapping writes its path with a `static final String` constant, which the type that declares it initialises with a literal (or with literals and its own constants) in its own file. A compile-time constant is the literal, so the address is stated',
  'route-composed-mapping': 'the method carries an annotation this tree declares with a meta @RequestMapping (or one of its shortcuts). Spring serves such a method with the meta annotation\'s methods, and the path the annotation\'s own attribute gives through @AliasFor, so the address is stated',
  'route-method-not-read': 'the mapping names, in `method`, something that is no HTTP method (a constant this lane does not read), so the route answers some method this lane cannot say. It is placed on ANY, which may be wider than the truth',
  'route-condition-split': 'two or more handlers declare this route and at least one narrows it with a request condition (params, headers, consumes, produces), so Spring picks one of them per request by what the request carries. Which one runs is a candidate set',
});

function emptyStats() {
  return { pathsFromConstants: 0, pathsUnread: 0, composedRoutes: 0, composedNotRead: 0, methodsUnread: 0, conditionSplits: 0, samples: [] };
}

function sample(stats, entry) {
  stats.samples.push(entry);
}

/** A Spring path from what was joined: one leading slash, single slashes, no trailing one but the root's. */
export function normalizeJoinedPath(joined) {
  const s = `/${String(joined).trim()}`.replace(/\/+/g, '/');
  return s.length > 1 ? s.replace(/\/$/, '') : s;
}

/**
 * The type a name written in one type's file means, by the rules javac reads a
 * name with: a type nested in it or around it, a single-type import, its own
 * package, a package imported whole. A name none of them settles is null: a
 * constant is a fact only of a type this run read.
 */
function strictTypeOf(ctx, owner, written) {
  const [head, ...rest] = String(written).split('.');
  const fqnOfHead = (() => {
    const chain = ctx.enclosingChainOf(owner);
    for (const scope of [owner, ...chain]) if (ctx.types.has(`${scope}.${head}`)) return `${scope}.${head}`;
    const top = chain.length > 0 ? chain[chain.length - 1] : owner;
    const imp = ctx.importsByOwner.get(top);
    if (imp && imp.has(head)) return imp.get(head);
    const pkg = ctx.types.get(owner)?.pkg;
    if (pkg && ctx.types.has(`${pkg}.${head}`)) return `${pkg}.${head}`;
    return [...(ctx.wildcardsByOwner.get(top) ?? [])].map((p) => `${p}.${head}`).find((g) => ctx.types.has(g)) ?? null;
  })();
  if (ctx.types.has(written)) return written;
  return fqnOfHead ? [fqnOfHead, ...rest].join('.') : null;
}

/** The types above one, its superclasses and every interface, nearest first. */
function supertypesOf(ctx, fqn) {
  const out = [];
  const queue = [fqn];
  while (queue.length > 0 && out.length < 64) {
    const cur = queue.shift();
    const t = ctx.types.get(cur);
    if (!t) continue;
    const up = [ctx.superOf.get(cur), ...t.implementsSimple.map((s) => ctx.resolveType(cur, s))].filter(Boolean);
    for (const u of up) if (!out.includes(u)) { out.push(u); queue.push(u); }
  }
  return out;
}

/** A constant of this type or one it inherits: one value, or null when none or two disagree. */
function constantUp(ctx, fqn, name) {
  const own = ctx.types.get(fqn)?.constants?.[name];
  if (typeof own === 'string') return own;
  const found = new Set(supertypesOf(ctx, fqn).map((s) => ctx.types.get(s)?.constants?.[name]).filter((v) => typeof v === 'string'));
  return found.size === 1 ? [...found][0] : null;
}

/** What one `{ref}` part names: `Type.NAME` of a type the tree has, or a bare NAME the owner inherits. */
function constantOf(ctx, owner, ref) {
  const at = ref.lastIndexOf('.');
  if (at < 0) return constantUp(ctx, owner, ref);
  const fqn = strictTypeOf(ctx, owner, ref.slice(0, at));
  return fqn ? constantUp(ctx, fqn, ref.slice(at + 1)) : null;
}

/** The path the parts spell, read against the tree; null when a part stays unread. */
export function readParts(ctx, owner, parts) {
  let s = '';
  for (const p of parts ?? []) {
    const v = typeof p?.lit === 'string' ? p.lit : typeof p?.ref === 'string' ? constantOf(ctx, owner, p.ref) : null;
    if (v === null) return null;
    s += v;
  }
  return normalizeJoinedPath(s);
}

/** The worker's endpoint records with every path read that the tree lets read, and the rest said. */
function readEndpointPaths(ctx, stats) {
  const out = [];
  for (const e of ctx.endpoints) {
    if (Array.isArray(e.methodUnread)) stats.methodsUnread += 1;
    if (!Array.isArray(e.pathParts)) { out.push(e); continue; }
    const path = readParts(ctx, e.handlerType, e.pathParts);
    if (path === null) {
      stats.pathsUnread += 1;
      sample(stats, { handler: e.handler, line: e.line, code: 'path-not-literal', text: e.pathWritten ?? '' });
      continue;
    }
    stats.pathsFromConstants += 1;
    out.push({ ...e, path, pathFrom: e.pathWritten ?? null });
  }
  return out;
}

/** One path a record states: text, null for none, or `{parts, written}`, read against the tree. */
function pathOfRead(ctx, owner, read) {
  if (read === null || typeof read === 'string') return { path: read };
  const path = readParts(ctx, owner, read.parts);
  return path === null ? { unread: read.written ?? '' } : { path, written: read.written ?? null };
}

/** The union Spring makes of a class's methods and a mapping's (RequestMethodsRequestCondition.combine). */
function unionOf(a, b) {
  const read = [...new Set([...(a?.read ?? []), ...(b?.read ?? [])])];
  const unread = [...new Set([...(a?.unread ?? []), ...(b?.unread ?? [])])];
  return { read, unread };
}

/**
 * The paths a use of a composed mapping gives: the attribute it writes, when
 * the annotation aliases that attribute to the meta mapping's value or path;
 * the meta mapping's own path when it writes none. An attribute the annotation
 * does not alias is not the path Spring reads, so it is said, not guessed.
 */
function composedPaths(c, meta) {
  const attr = Array.isArray(c.value) ? 'value' : Array.isArray(c.path) ? 'path' : null;
  if (attr === null) return { paths: Array.isArray(meta.paths) && meta.paths.length > 0 ? meta.paths : [null] };
  if (!['value', 'path'].includes(meta.aliases?.[attr])) return { why: 'composed-mapping-attribute-not-aliased', text: `@${c.annotation} ${attr}` };
  return { paths: c[attr].length > 0 ? c[attr] : [null] };
}

/** The routes one use of a composed mapping serves, as endpoint records. */
function composedRoutes(ctx, c, meta, fqn, stats) {
  const got = composedPaths(c, meta);
  if (got.why) { sample(stats, { handler: c.handler, line: c.line, code: got.why, text: got.text }); return []; }
  const verbs = unionOf(c.classMethods, meta.methods);
  const methods = [...(verbs.read.length > 0 || verbs.unread.length > 0 ? verbs.read : ['ANY']).map((m) => [m, null]),
    ...(verbs.unread.length > 0 ? [['ANY', verbs.unread]] : [])];
  const out = [];
  for (const base of c.bases ?? [null]) {
    for (const own of got.paths) {
      const b = pathOfRead(ctx, c.owner, base);
      const o = pathOfRead(ctx, c.owner, own);
      if (b.unread !== undefined || o.unread !== undefined) {
        stats.pathsUnread += 1;
        sample(stats, { handler: c.handler, line: c.line, code: 'path-not-literal', text: b.unread ?? o.unread });
        continue;
      }
      const path = normalizeJoinedPath(`${b.path ?? ''}/${o.path ?? ''}`);
      for (const [httpMethod, methodUnread] of methods) {
        out.push({ httpMethod, path, handler: c.handler, handlerType: c.owner, line: c.line ?? null, file: c.file ?? null, composed: fqn, ...(methodUnread ? { methodUnread } : {}) });
      }
    }
  }
  stats.composedRoutes += out.length;
  return out;
}

/**
 * THE ROUTES A COMPOSED MAPPING SERVES. A controller method's annotation the
 * worker did not know is a route when it resolves to an annotation type of the
 * tree that is a composed mapping; one that resolves to an annotation type of
 * the tree that is not one serves nothing, and one this run did not read may
 * be either, so it is said.
 */
function composedEndpoints(ctx, javaFacts, stats) {
  const composed = new Map();
  const candidates = [];
  for (const r of javaFacts ?? []) {
    if (r?.kind === 'composedMapping' && typeof r.fqn === 'string') composed.set(r.fqn, r);
    else if (r?.kind === 'mappingCandidate' && typeof r.handler === 'string') candidates.push(r);
  }
  candidates.sort((a, b) => cmp(a.handler, b.handler) || cmp(a.annotation ?? '', b.annotation ?? ''));
  const out = [];
  const unread = [];
  const served = new Set();
  for (const c of candidates) {
    const fqn = strictTypeOf(ctx, c.owner, c.annotation);
    const meta = fqn ? composed.get(fqn) : null;
    if (meta) {
      served.add(c.handler);
      const routes = composedRoutes(ctx, c, meta, fqn, stats);
      if (routes.length > 0 && !ctx.lineOfMember.has(c.handler) && c.line != null) ctx.lineOfMember.set(c.handler, c.line);
      out.push(...routes);
    } else if (!fqn || !ctx.types.has(fqn)) unread.push(c);
  }
  // An annotation beside the composed mapping a method is served by changes
  // nothing about its route, so only a method with none is said.
  for (const c of unread.filter((x) => !served.has(x.handler))) {
    stats.composedNotRead += 1;
    sample(stats, { handler: c.handler, line: c.line, code: 'mapping-annotation-not-read', text: `@${c.annotation}` });
  }
  return out;
}

/**
 * EVERY ROUTE A MAPPING ANNOTATION DECLARES, with what one file could not
 * settle read against the tree. Writes `stats.mappingAnnotations`.
 *
 * @param {object} ctx  the Java bridge's context (the fact and type indexes)
 * @param {object[]} javaFacts  the assembled worker records
 * @returns {object[]} endpoint records, as the worker writes them, every one with a path
 */
export function readMappings(ctx, javaFacts) {
  const stats = emptyStats();
  ctx.stats.mappingAnnotations = stats;
  const out = [...readEndpointPaths(ctx, stats), ...composedEndpoints(ctx, javaFacts, stats)];
  stats.samples = stats.samples
    .sort((a, b) => cmp(a.handler, b.handler) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.code, b.code) || cmp(a.text, b.text))
    .slice(0, SAMPLE_LIMIT);
  return out;
}

/** The evidence and grade one endpoint record's own reading gives its HANDLES edge; null evidence when it states everything. */
export function mappingReading(e) {
  if (Array.isArray(e.methodUnread)) {
    return { grade: 'HEURISTIC', evidence: { rule: 'route-method-not-read', basis: MAPPING_BASIS['route-method-not-read'], methodUnread: e.methodUnread, ...(e.composed ? { annotation: e.composed } : {}) } };
  }
  if (e.composed) return { grade: 'EXACT', evidence: { rule: 'route-composed-mapping', basis: MAPPING_BASIS['route-composed-mapping'], annotation: e.composed } };
  if (e.pathFrom) return { grade: 'EXACT', evidence: { rule: 'route-path-constant', basis: MAPPING_BASIS['route-path-constant'], written: e.pathFrom } };
  return { grade: 'EXACT', evidence: null };
}

const RANK = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };

/**
 * ONE ROUTE, HANDLERS SPLIT BY A REQUEST CONDITION. Two methods of one route
 * where one narrows it with `params` (or headers, consumes, produces) are two
 * candidates for a request, not two facts: Spring runs the one whose condition
 * the request meets. Each HANDLES is then no stronger than SOUND_SET. Two
 * declarations with no condition keep the rule they had (two modules that each
 * serve the route are two deployables, not one choice).
 *
 * @param {object[]} routes  the served route declarations, changed in place
 * @param {object} stats  the lane stats; `mappingAnnotations.conditionSplits` counts the routes
 */
export function splitByConditions(routes, stats) {
  const byRoute = new Map();
  for (const r of routes) {
    if (r.contractOnly) continue;
    if (!byRoute.has(r.epId)) byRoute.set(r.epId, []);
    byRoute.get(r.epId).push(r);
  }
  for (const group of byRoute.values()) {
    const conditions = [...new Set(group.flatMap((r) => r.conditions ?? []))].sort();
    if (conditions.length === 0 || new Set(group.map((r) => r.handler)).size < 2) continue;
    stats.mappingAnnotations.conditionSplits += 1;
    for (const r of group) {
      if (RANK[r.grade] > RANK.SOUND_SET) r.grade = 'SOUND_SET';
      const split = { conditions, candidates: new Set(group.map((x) => x.handler)).size };
      r.evidence = r.evidence
        ? { ...r.evidence, conditionSplit: split }
        : { rule: 'route-condition-split', basis: MAPPING_BASIS['route-condition-split'], ...split };
    }
  }
}
