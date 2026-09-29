// functional_routes.mjs — the routes a Spring functional endpoint serves, and the method each one runs.
//
// WHAT THIS MODULE OWNS. The step from what the `java.route-function` rules
// read in one class (src/core/rules/kinds/java_route_function.mjs) to the route
// declarations the Java bridge places, beside the ones a mapping annotation
// gives (./routes.mjs), with the same endpoint id every lane uses:
//   where a route is served  a @Bean's routes where they say; a route no code in
//                            its file mounts, only where the project's OpenAPI
//                            document declares the operation it names, a guess
//                            unless the profile declares that document written
//                            from this code as it is now (openapi.generatedFromCode)
//   which method runs        the handler reference, resolved with the whole
//                            tree of types: this class, a field's or a
//                            parameter's declared type, a type name
//   what could not be read   counted and named, never guessed
//
// WHAT IT MUST NEVER KNOW ABOUT: which call names a verb or a nest (the rule
// pack's), and what a MAY_CALL or a statement is.

import { builtinRegistry } from '../../core/rules/registry.mjs';
import { readRouteFunctions, handlerWords } from '../../core/rules/kinds/java_route_function.mjs';
import { pathOfRoute } from '../../core/rules/java_routes_eval.mjs';
import { cmp, endpointId, findDeclaringAncestor } from './types.mjs';

/** What each way of placing a functional route rests on, in one sentence, for `evidence.basis`. */
export const FUNCTIONAL_BASIS = Object.freeze({
  bean: 'a method annotated as a bean returns this RouterFunction, so the framework serves its routes at the paths its calls compose; the handler is the method its reference or its one-call lambda names',
  'operation-id': 'the method that builds this route is mounted by code elsewhere, so its prefix is not in its file; the project\'s OpenAPI document declares the operation id the route names, with this verb, at a path that ends with the route\'s own. No line of the source mounts it there: the match is a convention, so the link is a guess',
  'operation-id-declared': 'the method that builds this route is mounted by code elsewhere, so its prefix is not in its file; the project\'s OpenAPI document declares the operation id the route names, with this verb, at a path that ends with the route\'s own, and the profile declares that document generated from this code as it is now (openapi.generatedFromCode). So the document says where this code serves the route, and the link is as sure as its handler is read',
});

/** The profile's word that a document is written from this code as it is now (src/core/lanes.mjs openapiDeclarationsOf). */
const GENERATED_FROM_CODE = 'openapi.generatedFromCode';

/** How many unread parts and disagreements the lane stats name. The counts are always whole. */
const SAMPLE_LIMIT = 20;

function emptyStats() {
  return {
    functions: 0, routes: 0, served: 0, servedWithoutHandler: 0, mountedByOperationId: 0, mountedByDeclaredDocument: 0, unmounted: 0,
    pathUnread: 0, handlerUnread: 0, handlerUnresolved: 0, handles: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 },
    staticResources: 0, notRead: {}, operationIdDisagreements: 0, samples: [], disagreements: [],
  };
}

const said = (stats, code) => { stats.notRead[code] = (stats.notRead[code] ?? 0) + 1; };

/** One sample of what was not read, kept in a bounded list. */
function sample(stats, entry) {
  said(stats, entry.code);
  stats.samples.push(entry);
}

/** The type a declared type name means from this owner, or null. */
function typeNamed(ctx, owner, written) {
  if (!written) return null;
  if (ctx.types.has(written)) return written;
  const [head, ...rest] = written.split('.');
  const base = ctx.resolveType(owner, head);
  return base ? [base, ...rest].join('.') : null;
}

const nameOf = (entry) => String(entry).slice(0, String(entry).lastIndexOf('/'));
const anonymousIndex = new WeakMap();

/**
 * The anonymous classes of the tree, and the classes a method body declares
 * (javafacts/22), by each type they extend or implement, read once per bridge run.
 */
function anonymousBySupertype(ctx) {
  let idx = anonymousIndex.get(ctx);
  if (idx) return idx;
  idx = new Map();
  for (const a of [...(ctx.anonymousTypes?.values() ?? [])].sort((x, y) => cmp(x.id, y.id))) {
    for (const written of Array.isArray(a.supertypes) ? a.supertypes : [a.supertype]) {
      const sup = ctx.resolveType(a.owner, written);
      if (sup && !(idx.get(sup) ?? []).includes(a.id)) idx.set(sup, [...(idx.get(sup) ?? []), a.id]);
    }
  }
  anonymousIndex.set(ctx, idx);
  return idx;
}

/** Every type below `fqn` in the tree: its implementors, their subclasses, the anonymous classes written from them, and so on down. */
function descendantsOf(ctx, fqn) {
  const seen = new Set();
  const queue = [fqn];
  const anonymous = anonymousBySupertype(ctx);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const sub of [...(ctx.implementorsOf.get(cur) ?? []), ...(ctx.subclassesOf.get(cur) ?? []), ...(anonymous.get(cur) ?? [])]) {
      if (!seen.has(sub) && sub !== fqn) { seen.add(sub); queue.push(sub); }
    }
  }
  return [...seen];
}

/** The interfaces a type names in its own implements (an interface: its extends) clause. */
const interfacesOf = (ctx, fqn) => (ctx.types.get(fqn)?.implementsSimple ?? []).map((s) => ctx.resolveType(fqn, s)).filter(Boolean);

/**
 * The default bodies a class runs for `method` when neither it nor a class
 * above it declares one: the nearest default up each interface line of it and
 * of its superclasses. Two lines may each have one; both are candidates.
 */
function interfaceDefaults(ctx, fqn, method) {
  const out = new Set();
  const seen = new Set();
  const queue = [];
  for (let c = fqn, i = 0; c && i < 32; c = ctx.superOf.get(c), i += 1) queue.push(...interfacesOf(ctx, c));
  while (queue.length > 0) {
    const i = queue.shift();
    if (seen.has(i)) continue;
    seen.add(i);
    if ((ctx.types.get(i)?.defaultMethods ?? []).some((e) => nameOf(e) === method)) out.add(`${i}#${method}`);
    else queue.push(...interfacesOf(ctx, i));
  }
  return [...out];
}

/**
 * The superclass this run did not read that a class of the tree stands on, or
 * null: the class, or one above it, extends a type with no record here.
 */
function superclassNotRead(ctx, fqn) {
  for (let c = fqn, i = 0; c && i < 32; i += 1) {
    const t = ctx.types.get(c);
    if (!t || !t.extendsSimple) return null;
    const sup = ctx.superOf.get(c);
    if (!sup || !ctx.types.has(sup)) return sup ?? t.extendsWritten ?? t.extendsSimple;
    c = sup;
  }
  return null;
}

/**
 * The methods an object of exactly this type runs: its own, the one a class
 * above it declares, or an interface's default body. An interface runs its own
 * default, which an implementor outside the tree may keep; an anonymous class
 * adds only what it declares, since what it inherits its supertype gives. A
 * class that stands on a superclass this run did not read may run that
 * superclass's method, which wins over any default: it is a candidate, and the
 * gap is said in `gaps` (RM67 review 4, J-12).
 */
function runsAs(ctx, fqn, method, gaps = []) {
  const anon = ctx.anonymousTypes?.get(fqn);
  if (anon) return (anon.declaredMethods ?? []).some((e) => nameOf(e) === method) ? [`${fqn}#${method}`] : [];
  const t = ctx.types.get(fqn);
  if (!t) return [];
  if (t.typeKind === 'interface') return (t.defaultMethods ?? []).some((e) => nameOf(e) === method) ? [`${fqn}#${method}`] : [];
  if (ctx.declares(fqn, method, null)) return [`${fqn}#${method}`];
  const up = findDeclaringAncestor(fqn, method, null, { types: ctx.types, superOf: ctx.superOf, declares: ctx.declares });
  if (up) return [`${up.declaredBy}#${method}`];
  const outside = superclassNotRead(ctx, fqn);
  if (outside === null) return interfaceDefaults(ctx, fqn, method);
  gaps.push({ code: 'superclass-not-read', text: `${fqn} extends ${outside}, which this run did not read, so ${method} may be that class's` });
  return [`${outside}#${method}`, ...interfaceDefaults(ctx, fqn, method)];
}

/**
 * The methods an object of this declared type may run for `method`: what the
 * type itself runs, and what each type below it runs, overrides, inherited
 * interface defaults and anonymous subclasses included. The object may be any
 * of them, so the set holds every one (`Base b = new Derived()` reaches
 * `Derived#h`). A type this run did not read may run its own.
 */
function membersOfType(ctx, fqn, method, gaps = []) {
  const out = new Set();
  if (!ctx.types.has(fqn)) {
    out.add(`${fqn}#${method}`);
    gaps.push({ code: 'type-not-read', text: `${fqn} is a type this run did not read, so any class may be an object of it` });
  }
  for (const t of [fqn, ...descendantsOf(ctx, fqn)]) for (const m of runsAs(ctx, t, method, gaps)) out.add(m);
  return out.size > 0 ? [...out].sort(cmp) : [`${fqn}#${method}`];
}

/**
 * Whether a lambda or a method reference may be an object of this type: an
 * interface with exactly one abstract method, counted over it and every
 * interface above it (a default below takes one away), or one whose count a
 * super-interface this run did not read may complete. A class never is.
 */
function mayBeALambda(ctx, fqn) {
  const t = ctx.types.get(fqn);
  if (!t || t.typeKind !== 'interface') return false;
  if (t.annotations.includes('FunctionalInterface')) return true;
  const abstract = new Set();
  const defaults = new Set();
  let unknown = false;
  const seen = new Set();
  for (const queue = [fqn]; queue.length > 0;) {
    const cur = queue.shift();
    const x = ctx.types.get(cur);
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (!x || x.abstractMethods === null) { unknown = true; continue; }
    for (const m of x.abstractMethods) abstract.add(m);
    for (const m of x.defaultMethods) defaults.add(m);
    for (const s of x.implementsSimple) { const r = ctx.resolveType(cur, s); if (r) queue.push(r); else unknown = true; }
  }
  const live = [...abstract].filter((m) => !defaults.has(m)).length;
  return live === 1 || (unknown && live === 0);
}

/**
 * A handler reached through an object of a declared type: every method the
 * object may run, a candidate set that is closed only where the tree shows
 * every member (design 2). A type this run did not read, a superclass it did
 * not read, and an interface a lambda may implement each leave a member the
 * set cannot name: the set is then HEURISTIC, and the first gap is said.
 */
function declaredTypeHandler(ctx, fqn, method, via) {
  const gaps = [];
  const members = membersOfType(ctx, fqn, method, gaps);
  if (mayBeALambda(ctx, fqn)) gaps.push({ code: 'functional-interface', text: `${fqn} has one abstract method, so a lambda or a method reference anywhere may be the object, and its body is not a method of the tree` });
  return { members, grade: gaps.length > 0 ? 'HEURISTIC' : 'SOUND_SET', via, ...(gaps.length > 0 ? { openSet: gaps[0] } : {}) };
}

/** Where a candidate method is declared: a type's declaration line, or the one its anonymous class records. */
function lineOfCandidate(ctx, member) {
  const line = ctx.declaredLineOf.get(member);
  if (line != null) return line;
  const hash = member.lastIndexOf('#');
  const anon = ctx.anonymousTypes?.get(member.slice(0, hash));
  const at = (anon?.declaredMethods ?? []).findIndex((e) => nameOf(e) === member.slice(hash + 1));
  return at >= 0 ? anon.declaredMethodLines?.[at] ?? null : null;
}

/**
 * `this::m`: `this` is this class or a subclass of it, so the reference is EXACT
 * only when nothing in the tree overrides the method, and otherwise every
 * method the object may run.
 */
function thisHandler(ctx, owner, h) {
  const gaps = [];
  const members = membersOfType(ctx, owner, h.method, gaps);
  const own = members.length === 1 && members[0] === `${owner}#${h.method}` && ctx.declares(owner, h.method, null);
  if (gaps.length > 0) return { members, grade: 'HEURISTIC', via: h.via, openSet: gaps[0] };
  return { members, grade: own ? 'EXACT' : 'SOUND_SET', via: h.via };
}

/**
 * The methods a handler reference runs, each with how sure the reading is:
 * EXACT where the source names the class and the method (`this::list`,
 * `OwnerHandler::list` of a type this pack declares with that method), a
 * candidate set where an object of a declared type is (a field, a parameter, a
 * local, a superclass), and nothing where no type is named at all.
 *
 * @returns {{members:string[], grade:string, via:string}|null}
 */
export function resolveHandler(ctx, owner, h) {
  const idx = { types: ctx.types, superOf: ctx.superOf, declares: ctx.declares };
  if (h.via === 'this') return thisHandler(ctx, owner, h);
  if (h.via === 'super') {
    const up = findDeclaringAncestor(owner, h.method, null, idx);
    return { members: [`${up ? up.declaredBy : owner}#${h.method}`], grade: 'SOUND_SET', via: h.via };
  }
  const fieldType = h.via === 'name' ? ctx.fieldsByOwner.get(owner)?.get(h.name) ?? null : null;
  const declared = h.via === 'param' || h.via === 'local' ? h.type : fieldType;
  if (declared) {
    const fqn = typeNamed(ctx, owner, declared);
    return fqn ? declaredTypeHandler(ctx, fqn, h.method, fieldType ? 'field' : h.via) : null;
  }
  // No binding of that name here: it is a type, and the reference a static method of it.
  const fqn = h.via === 'name' || h.via === 'type' ? typeNamed(ctx, owner, h.name) : null;
  if (!fqn) return null;
  return { members: [`${fqn}#${h.method}`], grade: ctx.declares(fqn, h.method, null) ? 'EXACT' : 'SOUND_SET', via: 'type' };
}

/**
 * The operations the OpenAPI documents declare, by operation id and by
 * endpoint. Each keeps the first document that declares it and, when one of
 * the documents that declare it there is written from this code as it is now,
 * that one (`current`).
 */
export function declaredOperations(documents) {
  const byOp = new Map();
  const byEp = new Map();
  for (const d of [...(documents ?? [])].sort((a, b) => cmp(a.path ?? '', b.path ?? ''))) {
    for (const p of d.paths ?? []) {
      if (typeof p.operationId !== 'string' || p.operationId === '') continue;
      const key = `${p.method} ${p.path}`;
      indexOperation(byOp, d, p, key);
      if (!byEp.has(key)) byEp.set(key, new Set());
      byEp.get(key).add(p.operationId);
    }
  }
  return { byOp, byEp };
}

/** One document's operation, kept once per route, with the first document written from this code that declares it there. */
function indexOperation(byOp, d, p, key) {
  if (!byOp.has(p.operationId)) byOp.set(p.operationId, new Map());
  const at = byOp.get(p.operationId);
  if (!at.has(key)) at.set(key, { method: p.method, path: p.path, document: d.path ?? null, current: null });
  const op = at.get(key);
  if (op.current === null && d.declaration === GENERATED_FROM_CODE) op.current = d.path ?? null;
}

/**
 * Where an unmounted route is served: the one operation the documents declare
 * under its operation id, when that operation has its verb and a path that ends
 * with its own. Anything else is a reason it is not placed.
 */
function mountByOperationId(declared, verb, rel, operationId) {
  if (!operationId) return { why: 'mount-unknown' };
  // Two routes of the code that name one operation: springdoc renames one of
  // them in the document (`X_1`), so which document entry is which is not known.
  if ((declared.inCode.get(operationId) ?? 0) > 1) return { why: 'operation-id-not-unique' };
  const at = [...(declared.byOp.get(operationId)?.values() ?? [])];
  if (at.length === 0) return { why: 'operation-id-not-declared' };
  if (at.length > 1) return { why: 'operation-id-declared-twice' };
  const [op] = at;
  if (op.method !== verb || !(op.path === rel || (rel !== '/' && op.path.endsWith(rel)))) {
    return { why: 'operation-id-elsewhere', disagree: op };
  }
  return { path: op.path, document: op.document, current: op.current };
}

/** What the documents say about a route the code serves at a path it composes itself, when they disagree. */
function operationIdDisagreement(declared, verb, path, operationId) {
  if (!operationId) return null;
  const atEndpoint = declared.byEp.get(`${verb} ${path}`);
  if (atEndpoint && !atEndpoint.has(operationId)) return { document: [...atEndpoint].sort().join(', '), documentAt: `${verb} ${path}` };
  const elsewhere = [...(declared.byOp.get(operationId)?.values() ?? [])].filter((op) => `${op.method} ${op.path}` !== `${verb} ${path}`);
  return elsewhere.length > 0 && !atEndpoint ? { document: operationId, documentAt: elsewhere.map((op) => `${op.method} ${op.path}`).join(', ') } : null;
}

/** Where one route is served, or why it is not placed; disagreements with the documents are counted on the way. */
function placementOf(fn, r, declared, stats) {
  const path = pathOfRoute(r);
  if (fn.mount === 'bean') {
    const d = operationIdDisagreement(declared, r.verb, path, r.operationId);
    if (d) recordDisagreement(stats, { endpoint: `${r.verb} ${path}`, operationId: r.operationId, ...d });
    return { path, mount: 'bean' };
  }
  const m = mountByOperationId(declared, r.verb, path, r.operationId);
  if (m.disagree) recordDisagreement(stats, { endpoint: `${r.verb} ${path}`, operationId: r.operationId, document: r.operationId, documentAt: `${m.disagree.method} ${m.disagree.path}` });
  if (!m.path) return { why: m.why, relativePath: path };
  return { path: m.path, mount: 'operation-id', document: m.document, relativePath: path, ...(m.current ? { current: m.current } : {}) };
}

function recordDisagreement(stats, d) {
  stats.operationIdDisagreements += 1;
  stats.disagreements.push(d);
}

/** The evidence one functional route's HANDLES edge carries. */
function evidenceOf(fn, r, where, resolved) {
  return {
    rule: r.rule, basis: FUNCTIONAL_BASIS[where.current ? 'operation-id-declared' : where.mount], mount: where.mount,
    routeFunction: fn.function, declaredAt: { file: fn.file, line: r.line },
    handler: handlerWords(r.handler), handlerVia: resolved.via,
    ...(r.handler.lambda ? { lambda: true } : {}),
    ...(resolved.members.length > 1 ? { candidates: resolved.members.length } : {}),
    // A candidate set the tree cannot close (RM67 review 4): what it leaves out.
    ...(resolved.openSet ? { openSet: resolved.openSet } : {}),
    ...(r.operationId ? { operationId: r.operationId } : {}),
    ...(where.mount === 'operation-id' ? { document: where.document, relativePath: where.relativePath } : {}),
    ...(where.current ? { declared: { key: GENERATED_FROM_CODE, document: where.current } } : {}),
    ...(r.underNest ? { pattern: 'none, so the route answers the path of the nest it is in' } : {}),
  };
}

/**
 * How sure a placed route's HANDLES is. A bean's routes are where the source
 * says, so the handler's own reading decides. A mount the source does not state
 * is a document's operation id matched by convention: HEURISTIC, below the
 * conservative floor, whatever the handler (RM67 review 2), unless the profile
 * declares the document written from this code as it is now: then the document
 * says where the code serves it, and the handler's reading decides again.
 */
const gradeOf = (where, resolved) => (where.mount === 'bean' || where.current ? resolved.grade : 'HEURISTIC');

/** A route placed by a document's operation id is counted, and apart, one on a document declared written from this code. */
function countMount(stats, where) {
  if (where.mount !== 'operation-id') return;
  stats.mountedByOperationId += 1;
  if (where.current) stats.mountedByDeclaredDocument += 1;
}

/** One route read: a declaration to place, a node with no handler, or a reason it is not placed. */
function placeRoute(ctx, fn, r, declared, out) {
  const { stats } = out;
  stats.routes += 1;
  for (const u of r.unread) sample(stats, { function: fn.function, line: r.line, code: u.code, text: u.text });
  if (r.parts === null) { stats.pathUnread += 1; return; }
  const where = placementOf(fn, r, declared, stats);
  if (!where.path) {
    stats.unmounted += 1;
    sample(stats, { function: fn.function, line: r.line, code: where.why, text: `${r.verb} ${where.relativePath}${r.operationId ? `, operation ${r.operationId}` : ''}` });
    return;
  }
  countMount(stats, where);
  const epId = endpointId(r.verb, where.path);
  const resolved = r.handler ? resolveHandler(ctx, fn.owner, r.handler) : null;
  if (!resolved) {
    if (r.handler) { stats.handlerUnresolved += 1; sample(stats, { function: fn.function, line: r.line, code: 'handler-not-resolved', text: handlerWords(r.handler) }); } else stats.handlerUnread += 1;
    out.noHandler.push({ epId, httpMethod: r.verb, path: where.path, file: fn.file, line: r.line, operationId: r.operationId ?? null });
    return;
  }
  const grade = gradeOf(where, resolved);
  for (const member of resolved.members) {
    out.routes.push({
      epId, httpMethod: r.verb, path: where.path, handler: member, line: lineOfCandidate(ctx, member),
      grade, operationId: r.operationId ?? null, evidence: evidenceOf(fn, r, where, resolved),
    });
  }
}

/**
 * A route whose handler this lane could not name is still a route the code
 * serves: its node is placed with no HANDLES edge and says why, unless another
 * declaration of the same route has a handler.
 */
function placeRoutesWithoutHandler(ctx, noHandler, served, stats) {
  for (const n of noHandler) {
    if (served.has(n.epId) || ctx.g.nodes.has(n.epId)) continue;
    served.add(n.epId);
    ctx.g.addNode({
      id: n.epId, path: n.path, httpMethod: n.httpMethod, file: n.file, line: n.line, handlerUnread: true,
      ...(n.operationId ? { operationId: n.operationId } : {}),
    });
    stats.servedWithoutHandler += 1;
  }
}

/** The declarations kept once each (one route read twice, through two beans, is one route), counted by grade. */
function dedupe(routes, stats) {
  const seen = new Set();
  return routes.filter((r) => {
    const key = `${r.epId} ${r.handler}`;
    if (seen.has(key)) return false;
    seen.add(key);
    stats.served += 1;
    stats.handles[r.grade] = (stats.handles[r.grade] ?? 0) + 1;
    return true;
  });
}

/** How many routes of the code, each counted once where it is written, name each operation id. */
function operationIdsInCode(read) {
  const sites = new Map();
  for (const fn of read) {
    for (const r of fn.routes.filter((x) => x.operationId)) {
      if (!sites.has(r.operationId)) sites.set(r.operationId, new Set());
      sites.get(r.operationId).add(`${fn.file}:${r.line}:${r.verb}`);
    }
  }
  return new Map([...sites].map(([op, s]) => [op, s.size]));
}

const bySite = (a, b) => cmp(a.function, b.function) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.code ?? '', b.code ?? '') || cmp(a.text ?? '', b.text ?? '');

/**
 * THE ROUTES SPRING'S FUNCTIONAL ENDPOINTS SERVE, added to the ones the mapping
 * annotations gave, so the endpoint nodes and HANDLES edges are placed from one
 * list by one rule (./routes.mjs). Writes `stats.functionalRoutes`.
 *
 * @param {object} ctx  the Java bridge's context
 * @param {{routes:object[], clientCalls:object[]}} classified  what `classifyRoutes` gave
 * @param {object[]} javaFacts  the assembled worker records
 * @param {{openapiDocuments?:object[], registry?:object}} [opts]
 */
export function withFunctionalRoutes(ctx, classified, javaFacts, opts = {}) {
  const stats = emptyStats();
  ctx.stats.functionalRoutes = stats;
  const read = readRouteFunctions(javaFacts, (opts.registry ?? builtinRegistry()).ofKind('java.route-function'));
  const declared = { ...declaredOperations(opts.openapiDocuments), inCode: operationIdsInCode(read) };
  const out = { stats, routes: [], noHandler: [] };
  for (const fn of read) {
    stats.functions += 1;
    for (const n of fn.notes) {
      if (n.code === 'resources') stats.staticResources += 1;
      else sample(stats, { function: fn.function, line: n.line ?? fn.line, code: n.code, text: n.text });
    }
    for (const r of fn.routes) placeRoute(ctx, fn, r, declared, out);
  }
  const routes = dedupe(out.routes, stats);
  for (const r of routes) if (!ctx.lineOfMember.has(r.handler) && r.line !== null) ctx.lineOfMember.set(r.handler, r.line);
  placeRoutesWithoutHandler(ctx, out.noHandler, new Set([...classified.routes, ...routes].map((r) => r.epId)), stats);
  stats.samples = stats.samples.sort(bySite).slice(0, SAMPLE_LIMIT);
  stats.disagreements = stats.disagreements.sort((a, b) => cmp(a.endpoint, b.endpoint)).slice(0, SAMPLE_LIMIT);
  return { ...classified, routes: [...classified.routes, ...routes] };
}

