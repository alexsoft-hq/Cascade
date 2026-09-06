// java_bridge.mjs — turn Java source-lane facts (adapters/java/JavaFacts.java,
// schema cascade:javafacts:1) into knowledge-graph nodes/edges, and STITCH them
// onto an existing SQL graph so a column-impact query reaches up to the HTTP
// endpoint (SPEC §8, §9.1-9.2, the round-trip of §1.1).
//
// It MUTATES a Graph that already carries the SQL lane's statement/table/column
// nodes (built by sql_bridge), so IMPLEMENTS_STMT edges can reference the real
// statement nodes. Run the SQL bridge first, then this.
//
// The chain it forms (forward; impactOf walks it backward):
//   endpoint --HANDLES--> handler --MAY_CALL--> serviceIface --MAY_CALL(dispatch)-->
//   serviceImpl --MAY_CALL--> mapperMethod --IMPLEMENTS_STMT--> statement --WRITES/READS--> column
//
// GRADES — deliberately, honestly:
//  - HANDLES        EXACT      a Spring mapping annotation on a CONCRETE CONTROLLER method IS its
//                              handler (definitional).
//  - HANDLES        SOUND_SET  …but a mapping on an interface/abstract DECLARATION is a route
//                              CONTRACT: the handler is the implementer this bridge matched by name
//                              (and arity), which is a resolution, not a definition.
//  - CALLS_HTTP     SOUND_SET  a @FeignClient/@HttpExchange method calls a route this pack also
//                              SERVES — the internal HTTP hop of §1.1.
//                   UNRESOLVED …or one it does not: the target is outside the pack, so the edge is
//                              below every mode's floor and no walk follows it. It is counted, not
//                              hidden (`httpCallsUnresolved`).
//  - IMPLEMENTS_STMT EXACT     a MyBatis statement id IS the mapper interface FQN + method (definitional).
//  - MAY_CALL       SOUND_SET  calls are resolved from the parse tree WITHOUT compiler binding or
//                              overload resolution — a field receiver (`repo.save`, `this.repo.save`)
//                              through its declared type, an UNQUALIFIED call (`helper(x)`) through the
//                              enclosing type, and interface→impl dispatch as a class-hierarchy
//                              over-approximation. A sound candidate set, NOT compiler-proven — so
//                              never CALLS/EXACT (I-1/§3.1). The evidence on each edge says which rule fired.
// The weakest link on an endpoint→column path is therefore SOUND_SET, and the
// graph reports it as such; a call chain is never dressed up as confirmed.

import { nodeId, Graph, FLOW_EDGE_TYPES } from '../core/graph.mjs';

export const JAVAFACTS_SCHEMA = 'cascade:javafacts:1';

/**
 * How far a `super.m()` walk climbs before giving up. A Java hierarchy is
 * acyclic, but a fact set assembled from shards need not be (two files can be
 * edited into a cycle), and a walk that hangs is worse than one that says it
 * stopped.
 */
const SUPER_CHAIN_LIMIT = 32;

/**
 * How many unexplained `identifier` receivers the lane stats list by name. The
 * COUNT is always exact; the list is a sample, so a project with thousands of
 * them does not put thousands of strings in every pack.
 */
const IDENTIFIER_SAMPLE_LIMIT = 20;

/**
 * How many dispatch/instantiation rounds run before the loop gives up. Both of
 * its worklists are monotone over a finite set, so it converges — the guard is
 * against a fact set assembled from shards that has been edited into a cycle.
 */
const INHERITED_FIXPOINT_LIMIT = 64;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** symbol node id for a Java member "fqn#method". */
export function symbolId(memberFqn) {
  return nodeId('symbol', memberFqn);
}
/** endpoint node id, keyed by "METHOD path" (position-independent). */
export function endpointId(httpMethod, pathStr) {
  return nodeId('endpoint', `${httpMethod} ${pathStr}`);
}
/** statement key for a member fqn "owner#method" → "owner.method" (MyBatis id). */
function memberToStatementKey(memberFqn) {
  const h = memberFqn.lastIndexOf('#');
  return h < 0 ? memberFqn : memberFqn.slice(0, h) + '.' + memberFqn.slice(h + 1);
}
function ownerOf(memberFqn) {
  const h = memberFqn.lastIndexOf('#');
  return h < 0 ? memberFqn : memberFqn.slice(0, h);
}

/**
 * Whether `pkg` lies inside one of the project's declared top-level packages
 * (`profile.packagePrefixes`, SPEC §6.2). An EMPTY prefix list means the profile
 * declares no boundary, so nothing is external — the caller says so in a
 * diagnostic rather than the engine inventing a prefix (§6, MUST NOT).
 * @param {string|null} pkg
 * @param {string[]} prefixes
 * @returns {boolean}
 */
export function isProjectPackage(pkg, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return true;
  if (typeof pkg !== 'string' || pkg.length === 0) return false;
  return prefixes.some((p) => pkg === p || pkg.startsWith(p + '.'));
}

/**
 * The rules that can produce a MAY_CALL edge, keyed by the spelling the worker
 * recorded. EVERY MAY_CALL edge carries its rule in `evidence.rule`: they share
 * one grade (SOUND_SET — none is compiler-verified) but they do NOT share one
 * failure mode, and a reader deciding how far to trust a chain is entitled to
 * know which one it rested on.
 *
 * `this.m()` is the SAME call as the unqualified `m()` — one spelling, one rule.
 * `super.m()` is not: it names the SUPERCLASS, and which ancestor declares the
 * method has to be walked, so it gets a rule (and a failure mode) of its own.
 */
export const CALL_RULES = Object.freeze({
  field: 'field-receiver',
  'this-field': 'this-field',
  unqualified: 'unqualified-enclosing',
  'this-method': 'unqualified-enclosing',
  'super-method': 'super-enclosing',
  // A receiver name the worker found DECLARED NOWHERE in its compilation unit
  // (javafacts/7). The worker knows only the name; this bridge holds every type
  // record, so it is the one that can walk the `extends` chain and say whether
  // that name is a field an ancestor declares.
  identifier: 'inherited-field',
});

/** What each rule actually did, in one sentence, for `evidence.basis`. */
export const CALL_RULE_BASIS = Object.freeze({
  'field-receiver': 'parse-tree receiver→field→declared type, method-by-name (no binding); the runtime object may be a subtype',
  'this-field': 'parse-tree `this.field`→declared type, method-by-name (no binding); the runtime object may be a subtype',
  'unqualified-enclosing': 'an unqualified call resolved to the ENCLOSING type by name; a method the type INHERITS is attributed to the subclass, not to the class that declares it',
  'super-enclosing': '`super.m()` resolved by walking the `extends` chain to the first ancestor that DECLARES m (by name); an ancestor the lane never parsed ends the walk unresolved',
  'type-param-binding': 'the receiver\'s declared type is a TYPE PARAMETER of the enclosing type, so it has no meaning until a subclass binds it: one edge per concrete binding found in the pack. The base method\'s body is shared by every subclass, so every target here is a genuine possible callee. The set is an over-approximation of one CALL SITE, not a guess',
  'interface-dispatch': 'interface→impl class-hierarchy dispatch (an over-approximation: every implementor is a candidate)',
  'inherited-field': 'the receiver names no variable the file declares, so it is a member INHERITED from a supertype: the `extends` chain was walked to the nearest ancestor that declares a field of that name (first declaration wins), and a field typed by one of that ancestor\'s type parameters was bound through the subclass\'s `extends` arguments, IN THE CONTEXT OF THIS SUBCLASS, so the edge names that subclass\'s binding and no other\'s',
  'interface-dispatch-inherited': 'interface→impl dispatch where the implementor does not DECLARE the method: the `extends` chain was walked to the nearest ancestor that declares it (name + arity), and the inherited member was instantiated as a symbol of the concrete class whose calls carry that class\'s type-parameter bindings. This is the same over-approximation as interface-dispatch on the implementor set, but no longer blind to a method a class only inherits',
  'inherited-member-call': 'a call in the body of a method this class only INHERITS, instantiated for this class: the ancestor wrote the call site, and the ancestor\'s type parameters were replaced by what this subclass binds them to, so the edge names this subclass\'s collaborator and not every subclass\'s. Same standing (SOUND_SET) as the rule that resolved the call in the ancestor, plus one assumption the compiler would check: that this class really inherits that body rather than an intervening one this lane never parsed',
});

/**
 * The annotations that make a CLASS a Spring web controller. A type carrying one
 * of these owns the routes its methods declare; a mapping annotation anywhere
 * else has to be classified before it can be believed (see `classifyRouteHolder`).
 */
export const CONTROLLER_ANNOTATIONS = Object.freeze(['RestController', 'Controller']);

/** What each ROUTE rule did, in one sentence, for `evidence.basis`. */
export const ROUTE_RULE_BASIS = Object.freeze({
  'route-contract-impl': 'the mapping is on an interface/abstract declaration; the handler is the concrete @Controller that implements it, matched through `implements` by method name (and arity where the worker recorded one), not by compiler binding',
  'route-contract-only': 'the mapping is on an interface/abstract declaration that NO concrete controller in this pack implements: the route is declared here and served somewhere this analysis cannot see',
  'http-client': 'a @FeignClient/@HttpExchange method CALLS this route over HTTP; which deployable answers is not knowable from source, so the service name and url are recorded as written and the grade says only whether a route with this method+path exists in the pack',
});

/**
 * WHAT A MAPPING ANNOTATION MEANS, decided from the ENCLOSING TYPE.
 *
 * `@GetMapping("/x")` on a method is not, by itself, evidence that this pack
 * SERVES `/x`. Three different things wear the same annotation:
 *
 *   'handler'  a concrete @RestController/@Controller class — the route is
 *              declared and served here. HANDLES, EXACT (definitional).
 *   'client'   an interface annotated @FeignClient (or a class-level
 *              @HttpExchange) — the method CALLS `/x` over HTTP on some other
 *              deployable. It is never a handler; it gets CALLS_HTTP. WHICH
 *              deployable answers is not knowable statically, so the service
 *              name and url ride along as evidence rather than as a claim.
 *   'contract' a plain interface or abstract class — the route is DECLARED here
 *              and served by whichever concrete controller implements it.
 *
 * Anything else (a concrete class with no controller annotation) keeps the old
 * behaviour and is a handler: the table stays TOTAL, and a project whose
 * controllers are marked by a meta-annotation this engine does not know still
 * gets its routes.
 *
 * @param {{typeKind?:string, abstract?:boolean, annotations?:string[], client?:object|null}|undefined} t
 * @returns {'handler'|'client'|'contract'}
 */
export function classifyRouteHolder(t) {
  if (!t) return 'handler';
  if (t.client && typeof t.client === 'object') return 'client';
  const isController = (t.annotations ?? []).some((a) => CONTROLLER_ANNOTATIONS.includes(a));
  if (isController) return 'handler';
  if (t.typeKind === 'interface' || t.abstract === true) return 'contract';
  return 'handler';
}

/**
 * GENERATED SOURCES (SPEC §8.4, the completeness budget).
 *
 * Machine-written code is the bulk of a MyBatis project and none of its
 * meaning: measured on mall, 8 377 of 12 674 nodes (66%) and 8 307 of 19 268
 * edges are `…Example.GeneratedCriteria` methods calling their own
 * `addCriterion`, and NOT ONE edge crosses between them and hand-written code.
 * They are 67% of the pack's bytes and answer nothing.
 *
 * The engine never guesses which those are. It is told, in one of two ways, and
 * BOTH are evidence the worker really has:
 *   - an ANNOTATION the type carries (`generatedSources.annotations`, e.g.
 *     "Generated" for @Generated / @javax.annotation.Generated); or
 *   - a PATH the profile declares (`generatedSources.pathGlobs`, e.g.
 *     "mall-mbg/**"), which is the rule for a generator that leaves no mark in
 *     the file at all — mall's does not, and a `*Example` NAME match in core
 *     would be the engine inventing a convention rather than reading one.
 *
 * A project that declares neither classifies nothing, and every count below is
 * 0 — never a silent default that quietly reshapes somebody's graph.
 */

/**
 * Compile `generatedSources.pathGlobs` into one matcher. `*` matches within a
 * path segment, `**` across segments; everything else is literal. Paths are the
 * root-relative ones the worker records, with `/` separators.
 * @param {string[]} globs
 * @returns {(file:string|null)=>boolean}
 */
export function pathGlobMatcher(globs) {
  const list = Array.isArray(globs) ? globs.filter((g) => typeof g === 'string' && g.length > 0) : [];
  if (list.length === 0) return () => false;
  const res = list.map((glob) => {
    // Escape every regex metacharacter, then re-open the two wildcards. `**` is
    // replaced first (via a placeholder) so the single-star rule cannot eat it.
    const body = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`);
  });
  return (file) => typeof file === 'string' && res.some((re) => re.test(file));
}

/**
 * Which types this fact set's profile classifies as generated.
 * @param {Map<string,object>} types  from buildTypeIndex
 * @param {{annotations?:string[], pathGlobs?:string[]}} declared
 * @returns {{fqns:Set<string>, byAnnotation:number, byPath:number}}
 */
export /**
 * Which FQNs are declared in more than one file, how many declarations there
 * are, and what kind of thing each one is.
 *
 * The KIND matters because "3 types are declared twice" reads very differently
 * depending on whether they are two modules' copies of one API interface (a fact
 * about the repository) or two controllers claiming one class name (something a
 * reader would want to look at). Classified from the annotations of EVERY
 * declaration — the union, since a type can be a plain interface in one module
 * and a @FeignClient in the other, which is exactly jeecg-boot's case.
 *
 * @param {Map<string,Set<string>>} filesByFqn  from buildTypeIndex
 * @param {Map<string,object>} typesByFile      from buildTypeIndex
 * @param {{handlerType:string}[]} endpoints
 * @returns {{count:number, declarations:number, byKind:Object, types:object[]}}
 */
function duplicateFqnCensus(filesByFqn, typesByFile, endpoints) {
  const handlerTypes = new Set(endpoints.map((e) => e.handlerType).filter(Boolean));
  const out = { count: 0, declarations: 0, byKind: {}, types: [] };
  for (const fqn of [...filesByFqn.keys()].sort()) {
    const files = [...filesByFqn.get(fqn)].sort();
    if (files.length < 2) continue;
    const anns = new Set();
    for (const f of files) {
      for (const a of typesByFile.get(`${fqn} ${f}`)?.annotations ?? []) anns.add(a);
    }
    const kind = duplicateKindOf(fqn, anns, handlerTypes);
    out.count += 1;
    out.declarations += files.length;
    out.byKind[kind] = (out.byKind[kind] ?? 0) + 1;
    if (out.types.length < DUPLICATE_FQNS_LISTED) out.types.push({ fqn, kind, files });
  }
  return out;
}

/** How many collided FQNs the census NAMES; the counts always cover them all. */
const DUPLICATE_FQNS_LISTED = 25;

function duplicateKindOf(fqn, anns, handlerTypes) {
  if (anns.has('FeignClient') || anns.has('HttpExchange')) return 'http-client';
  if (handlerTypes.has(fqn) || anns.has('RestController') || anns.has('Controller')) return 'controller';
  if (anns.has('Mapper') || anns.has('Repository')) return 'mapper';
  if (anns.has('Service')) return 'service';
  if (anns.has('Entity') || anns.has('TableName')) return 'entity';
  if (anns.has('Configuration') || anns.has('Component')) return 'config';
  return 'other';
}

function classifyGeneratedTypes(types, declared = {}) {
  const anns = new Set(Array.isArray(declared.annotations) ? declared.annotations : []);
  const matchesPath = pathGlobMatcher(declared.pathGlobs);
  const fqns = new Set();
  let byAnnotation = 0;
  let byPath = 0;
  if (anns.size === 0 && !Array.isArray(declared.pathGlobs)) return { fqns, byAnnotation, byPath };
  for (const [fqn, t] of types) {
    const annHit = anns.size > 0 && (t.annotations ?? []).some((a) => anns.has(a));
    const pathHit = matchesPath(t.file);
    if (!annHit && !pathHit) continue;
    fqns.add(fqn);
    if (annHit) byAnnotation += 1; else byPath += 1;
  }
  return { fqns, byAnnotation, byPath };
}

/** The package of a type FQN: everything before its simple name ('' for a default-package type). */
function packageOfType(typeFqn) {
  const dot = typeFqn.lastIndexOf('.');
  return dot < 0 ? '' : typeFqn.slice(0, dot);
}

/** The MyBatis namespace a statement key belongs to ("ns.Mapper.select" → "ns.Mapper"). */
function namespaceOfStatementKey(key) {
  const dot = key.lastIndexOf('.');
  return dot < 0 ? '' : key.slice(0, dot);
}

/**
 * The TYPE half of the fact index: which types the lane saw, what each file
 * imported, and the simple-name -> FQN resolver built from both.
 *
 * Extracted so the JPA bridge (src/adapters/jpa_bridge.mjs) resolves a simple
 * name — `JpaRepository<Owner, Integer>`'s `Owner`, an entity's superclass —
 * through the SAME four rules, in the same order, as a call target. Two
 * resolvers would eventually disagree, and then one graph would hold two
 * opinions about what `Owner` means.
 *
 * @param {object[]} javaFacts
 * @returns {{types:Map<string,object>, typesByFile:Map<string,object>,
 *            filesByFqn:Map<string,Set<string>>,
 *            importsByOwner:Map<string,Map<string,string>>,
 *            wildcardsByOwner:Map<string,string[]>, simpleIndex:Map<string,Set<string>>,
 *            resolveType:(ownerFqn:string, simple:string)=>(string|null)}}
 */
export function buildTypeIndex(javaFacts) {
  const types = new Map();
  const typesByFile = new Map();
  const filesByFqn = new Map();
  const importsByOwner = new Map();
  const wildcardsByOwner = new Map();
  const simpleIndex = new Map();

  for (const r of javaFacts ?? []) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'type') {
      types.set(r.fqn, {
        typeKind: r.typeKind, pkg: r.package ?? null,
        abstract: r.abstract === true,
        implementsSimple: Array.isArray(r.implements) ? r.implements : [],
        implementsArgs: Array.isArray(r.implementsArgs) ? r.implementsArgs : [],
        annotations: Array.isArray(r.annotations) ? r.annotations : [],
        extendsSimple: r.extends ?? null,
        extendsArgs: Array.isArray(r.extendsArgs) ? r.extendsArgs : [],
        typeParams: Array.isArray(r.typeParams) ? r.typeParams : [],
        typeParamBounds: Array.isArray(r.typeParamBounds) ? r.typeParamBounds : [],
        client: (r.client && typeof r.client === 'object') ? r.client : null,
        declaredMethods: Array.isArray(r.declaredMethods) ? r.declaredMethods : [],
        // Aligned index-for-index with `declaredMethods` (javafacts/7): where each
        // one is declared, so a member a subclass only INHERITS can still be
        // previewed at the line that really declares it.
        declaredMethodLines: Array.isArray(r.declaredMethodLines) ? r.declaredMethodLines : [],
        file: r.file ?? null,
      });
      // TWO FILES CAN DECLARE THE SAME FQN. Not a mistake and not rare: jeecg-boot
      // ships `org.jeecg.common.system.api.ISysBaseAPI` twice — a plain interface
      // in `jeecg-system-local-api` and a @FeignClient with 100 mappings in
      // `jeecg-system-cloud-api`, two Maven modules that are never on one
      // classpath. `types` keeps one of them (whichever the stream ends with), so
      // anything that must read the DECLARATION a particular fact came from —
      // above all "is the type holding this mapping a client?" — looks the type
      // up by fqn AND file, and falls back to `types` only when it cannot.
      if (r.file) typesByFile.set(`${r.fqn} ${r.file}`, types.get(r.fqn));
      // …and the CENSUS of that: every file that declares this FQN. A reader who
      // sees `SysUserController` twice must be told the analysis did not double
      // anything, so the count is reported rather than left to be inferred.
      const seen = filesByFqn.get(r.fqn);
      if (seen) seen.add(r.file ?? '(no file)');
      else filesByFqn.set(r.fqn, new Set([r.file ?? '(no file)']));
    } else if (r.kind === 'import') {
      if (r.simple === '*') {
        if (r.owner && r.fqn) {
          const w = wildcardsByOwner.get(r.owner) ?? [];
          w.push(r.fqn); wildcardsByOwner.set(r.owner, w);
        }
      } else {
        let m = importsByOwner.get(r.owner);
        if (!m) { m = new Map(); importsByOwner.set(r.owner, m); }
        if (r.simple && r.fqn) m.set(r.simple, r.fqn);
      }
    }
  }

  for (const fqn of types.keys()) {
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    const s = simpleIndex.get(simple) ?? new Set();
    s.add(fqn); simpleIndex.set(simple, s);
  }

  // Resolve a simple type name seen inside `ownerFqn` to a fully-qualified app
  // type, in order of decreasing certainty:
  //   1. an explicit single-type import              (exact)
  //   2. the same package, if that type is known     (exact)
  //   3. an on-demand (wildcard) import package that contains a known type
  //   4. a globally UNIQUE app type with that simple name (sound: no ambiguity)
  // All four yield an app type; none is compiler-verified, so callers still
  // grade the resulting edge SOUND_SET. Returns null when it cannot resolve to a
  // type the lane actually saw (we never invent a package).
  const resolveType = (ownerFqn, simple) => {
    if (!simple) return null;
    const imp = importsByOwner.get(ownerFqn);
    if (imp && imp.has(simple)) return imp.get(simple);
    const t = types.get(ownerFqn);
    if (t && t.pkg) {
      const guess = `${t.pkg}.${simple}`;
      if (types.has(guess)) return guess;
    }
    for (const pkg of wildcardsByOwner.get(ownerFqn) ?? []) {
      const guess = `${pkg}.${simple}`;
      if (types.has(guess)) return guess;
    }
    const uniq = simpleIndex.get(simple);
    if (uniq && uniq.size === 1) return [...uniq][0];
    return null;
  };

  return { types, typesByFile, filesByFqn, importsByOwner, wildcardsByOwner, simpleIndex, resolveType };
}

/**
 * The HIERARCHY half of the fact index, read four ways from one pass over the
 * type records:
 *
 *   implementorsOf  interfaceFqn -> Set(implFqn)      interface -> impl dispatch
 *   superOf         fqn -> resolved superclass fqn    `super.m()`
 *   bindingsOf      baseFqn -> [{sub, args}]          every place a type is named
 *                                                     WITH type arguments, which is
 *                                                     what binds a type parameter
 *   declares(fqn, name, arity)                        what a type declares itself
 *
 * Extracted (RM15) so the MyBatis-Plus bridge answers "which concrete service
 * implements this interface" and "what does this subclass bind `T` to" with the
 * SAME walk the call lane uses. Two hierarchy indices would eventually disagree,
 * and then one graph would hold two opinions about what `ServiceImpl<M, T>` is.
 *
 * @param {Map<string,object>} types  from buildTypeIndex
 * @param {(ownerFqn:string, simple:string)=>(string|null)} resolveType
 * @returns {{implementorsOf:Map<string,Set<string>>, superOf:Map<string,(string|null)>,
 *            bindingsOf:Map<string,{sub:string,args:string[]}[]>,
 *            declaredByType:Map<string,Map<string,Set<number>>>,
 *            declares:(fqn:string,name:string,arity:(number|null))=>boolean}}
 */
export function buildHierarchyIndex(types, resolveType) {
  const implementorsOf = new Map();
  const superOf = new Map();
  const bindingsOf = new Map();
  const addBinding = (baseFqn, sub, args) => {
    if (!baseFqn || !Array.isArray(args) || args.length === 0) return;
    let list = bindingsOf.get(baseFqn);
    if (!list) { list = []; bindingsOf.set(baseFqn, list); }
    list.push({ sub, args });
  };
  for (const [fqn, t] of types) {
    (t.implementsSimple ?? []).forEach((simple, i) => {
      const ifaceFqn = resolveType(fqn, simple);
      if (!ifaceFqn) return;
      let s = implementorsOf.get(ifaceFqn);
      if (!s) { s = new Set(); implementorsOf.set(ifaceFqn, s); }
      s.add(fqn);
      addBinding(ifaceFqn, fqn, (t.implementsArgs ?? [])[i] ?? []);
    });
    if (t.extendsSimple) {
      const sup = resolveType(fqn, t.extendsSimple);
      superOf.set(fqn, sup);
      addBinding(sup, fqn, t.extendsArgs ?? []);
    }
  }
  for (const list of bindingsOf.values()) list.sort((a, b) => cmp(a.sub, b.sub));

  const declaredByType = new Map(); // fqn -> Map<name, Set<arity>>
  const declaredLineOf = new Map();   // "fqn#name" -> line of the first declaration
  for (const [fqn, t] of types) {
    const byName = new Map();
    const lines = t.declaredMethodLines ?? [];
    (t.declaredMethods ?? []).forEach((entry, i) => {
      const slash = String(entry).lastIndexOf('/');
      if (slash < 0) return;
      const name = entry.slice(0, slash);
      const arity = Number(entry.slice(slash + 1));
      let set = byName.get(name);
      if (!set) { set = new Set(); byName.set(name, set); }
      set.add(Number.isInteger(arity) ? arity : -1);
      const line = lines[i];
      const key = `${fqn}#${name}`;
      if (Number.isInteger(line) && line > 0 && !declaredLineOf.has(key)) declaredLineOf.set(key, line);
    });
    declaredByType.set(fqn, byName);
  }
  const declares = (fqn, name, arity) => {
    const set = declaredByType.get(fqn)?.get(name);
    if (!set) return false;
    return arity == null ? true : set.has(arity);
  };

  return { implementorsOf, superOf, bindingsOf, declaredByType, declaredLineOf, declares };
}

/**
 * THE `extends` CHAIN OF A TYPE, WITH ITS TYPE PARAMETERS ALREADY SUBSTITUTED.
 *
 * A subclass is the only place a generic base's type parameters mean anything:
 * `class BaseDao<E, M extends BaseMapper<E>> { protected M mybatisMapper; }` says
 * nothing about which mapper is called until `class XDaoImpl extends BaseDao<X,
 * XMapper>` binds M. So walking the chain is not enough — every hop must carry
 * the bindings down with it, or the answer at the top is a type parameter's NAME
 * rather than a type.
 *
 * Each entry is one ancestor and the substitution that holds THERE, expressed in
 * the frame of a concrete subclass:
 *
 *   {fqn, subst: Map<paramName, {simple, ctx}>, depth}
 *
 * `simple` is the simple type name bound to that parameter and `ctx` is the type
 * whose FILE spelled it — the two together are what `resolveType` needs, because
 * `XMapper` is resolvable through XDaoImpl's imports and not through BaseDao's.
 * The chain starts with `startFqn` itself (depth 0, empty substitution).
 *
 * Stops at a type the lane never parsed, and at SUPER_CHAIN_LIMIT hops: a fact
 * set assembled from shards can be edited into a cycle, and a walk that hangs is
 * worse than one that says it stopped.
 *
 * @param {string} startFqn
 * @param {Map<string,object>} types
 * @param {Map<string,(string|null)>} superOf
 * @returns {{fqn:string, subst:Map<string,{simple:string, ctx:string}>, depth:number}[]}
 */
export function extendsChainWithBindings(startFqn, types, superOf) {
  const out = [];
  if (!types.has(startFqn)) return out;
  let cur = startFqn;
  let subst = new Map();
  const seen = new Set();
  for (let depth = 0; depth <= SUPER_CHAIN_LIMIT; depth += 1) {
    if (!cur || seen.has(cur) || !types.has(cur)) break;
    seen.add(cur);
    out.push({ fqn: cur, subst, depth });
    const sup = superOf.get(cur) ?? null;
    if (!sup || !types.has(sup)) break;
    const args = types.get(cur).extendsArgs ?? [];
    const params = types.get(sup).typeParams ?? [];
    const next = new Map();
    params.forEach((p, i) => {
      const a = args[i];
      if (!a) return;
      // The argument may itself be a type PARAMETER of `cur`, already bound one
      // hop below (`class B<M> extends A<M>`): carry the binding through instead
      // of writing the parameter's name as if it were a type.
      next.set(p, subst.get(a) ?? { simple: a, ctx: cur });
    });
    subst = next;
    cur = sup;
  }
  return out;
}

/**
 * The nearest ancestor that DECLARES a field of this name, with the field's
 * declared type resolved in the context that gives it meaning.
 *
 * "Nearest first, first declaration wins" is Java's own rule for a field a
 * subclass does not shadow. The type it returns is the SUBCLASS's binding when
 * the field is typed by a type parameter, which is the whole point: 32 DAOs
 * share one `protected MYBATIS_MAPPER mybatisMapper`, and each of them reaches
 * exactly one mapper — never all 32.
 *
 * The start type itself is skipped: a field the class declares is already
 * resolved by the worker, and only a receiver the file never declares gets here.
 *
 * @param {string} startFqn
 * @param {string} name  the receiver identifier
 * @param {{types:Map<string,object>, superOf:Map<string,(string|null)>,
 *          fieldsByOwner:Map<string,Map<string,(string|null)>>,
 *          resolveType:(owner:string, simple:string)=>(string|null)}} idx
 * @returns {{declaredBy:string, typeSimple:string, typeFqn:(string|null),
 *            boundThrough:(string|null), chain:string[], hops:number}|null}
 */
export function resolveInheritedField(startFqn, name, idx) {
  const chainEntries = extendsChainWithBindings(startFqn, idx.types, idx.superOf);
  const chain = chainEntries.map((e) => e.fqn);
  for (const entry of chainEntries) {
    if (entry.depth === 0) continue; // the class's own fields are the worker's job
    const declared = idx.fieldsByOwner.get(entry.fqn)?.get(name);
    if (declared == null) continue;
    const bound = entry.subst.get(declared) ?? null;
    const simple = bound ? bound.simple : declared;
    const ctx = bound ? bound.ctx : entry.fqn;
    return {
      declaredBy: entry.fqn,
      typeSimple: simple,
      typeFqn: idx.resolveType(ctx, simple),
      boundThrough: bound ? ctx : null,
      chain,
      hops: entry.depth,
    };
  }
  return null;
}

/**
 * The nearest ancestor that DECLARES a method of this name (and arity, when one
 * is known), with the substitution that holds there.
 *
 * `TenantDaoImpl` implements `TenantDao#deleteById` by inheriting `BaseDao`'s —
 * it declares nothing at all — so a dispatch that only looks at what the
 * implementor DECLARES ends at the interface with the chain dead.
 *
 * @param {string} startFqn
 * @param {string} name
 * @param {number|null} arity
 * @param {{types:Map<string,object>, superOf:Map<string,(string|null)>,
 *          declares:(fqn:string,name:string,arity:(number|null))=>boolean}} idx
 * @returns {{declaredBy:string, subst:Map<string,{simple:string, ctx:string}>,
 *            chain:string[], hops:number}|null}
 */
export function findDeclaringAncestor(startFqn, name, arity, idx) {
  const chainEntries = extendsChainWithBindings(startFqn, idx.types, idx.superOf);
  const chain = chainEntries.map((e) => e.fqn);
  for (const entry of chainEntries) {
    if (entry.depth === 0) continue;
    if (!idx.declares(entry.fqn, name, arity)) continue;
    return { declaredBy: entry.fqn, subst: entry.subst, chain, hops: entry.depth };
  }
  return null;
}

/**
 * Add Java-lane facts to a graph (typically one already holding SQL nodes) and
 * stitch endpoint→…→statement chains. Mutates `g`.
 * @param {Graph} g
 * @param {object[]} javaFacts  parsed cascade:javafacts:1 records (header optional)
 * @param {{packagePrefixes?:string[],
 *          generatedSources?:{annotations?:string[], pathGlobs?:string[]}}} [opts]
 *        packagePrefixes: the profile's declared top-level packages — a symbol
 *        outside every one of them is marked `external:true`, and a call to one
 *        is counted as `externalCalls` rather than reported as "unresolved" (a
 *        library call the lane RESOLVED and deliberately did not follow is not
 *        the same failure as a call it could not resolve).
 *        generatedSources: the profile's declaration of what machine-written
 *        code looks like in THIS project — symbols of a matching type get
 *        `generated:true`. Undeclared classifies nothing.
 * @returns {{endpoints:number, handles:number, calls:number, dispatch:number,
 *            implementsStmt:number, unresolvedCalls:number, externalCalls:number,
 *            externalSymbols:number, mapperMethods:number, mapperMethodsBound:number,
 *            unboundMapperMethods:number, transactional:number}}
 */
export function addJavaFacts(g, javaFacts, opts = {}) {
  if (!(g instanceof Graph)) throw new JavaBridgeError('g must be a Graph');
  if (!Array.isArray(javaFacts)) throw new JavaBridgeError('javaFacts must be an array');
  const packagePrefixes = Array.isArray(opts.packagePrefixes) ? opts.packagePrefixes.slice().sort() : [];
  // The profile's generated-source declaration (SPEC §6.2). Absent = nothing is
  // classified: the engine never decides on its own that somebody's code is
  // machine-written.
  const generatedSources = opts.generatedSources && typeof opts.generatedSources === 'object'
    ? opts.generatedSources : { annotations: [], pathGlobs: [] };

  // ---- indices -----------------------------------------------------------
  const { types, typesByFile, filesByFqn, resolveType } = buildTypeIndex(javaFacts);
  // The type record a FACT came from: same fqn AND same file, so a duplicated
  // FQN cannot make one module's declaration answer for another's.
  const typeAt = (fqn, file) => (file ? typesByFile.get(`${fqn} ${file}`) : undefined) ?? types.get(fqn);
  const methods = [];                      // {fqn, owner, line}
  const calls = [];                        // {from, method, toTypeSimple}
  const endpoints = [];                    // {httpMethod, path, handler, line}
  const transactionals = [];               // {method, scope, line} — @Transactional boundaries
  // owner fqn -> (field name -> declared type SIMPLE name), from `field` records.
  // The inherited-field rule reads it: a receiver a file never declares is
  // looked for in the fields of its ancestors, and the ancestor's own record is
  // the only place that declaration exists.
  const fieldsByOwner = new Map();
  const parseErrors = [];                  // {file, line, message} — one per file that failed to parse
  const parsedFiles = new Set();           // every file any record came from

  for (const r of javaFacts) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.file === 'string' && r.file.length > 0) parsedFiles.add(r.file);
    switch (r.kind) {
      case 'method': methods.push({ fqn: r.fqn, owner: r.owner, line: r.line ?? null, paramCount: r.paramCount ?? null }); break;
      case 'call': calls.push({ from: r.from, method: r.method, toTypeSimple: r.toTypeSimple, receiver: r.receiver ?? null, via: r.via ?? null }); break;
      case 'endpoint': endpoints.push({ httpMethod: r.httpMethod, path: r.path, handler: r.handler, handlerType: r.handlerType ?? ownerOf(r.handler ?? ''), line: r.line ?? null, file: r.file ?? null }); break;
      case 'transactional': transactionals.push({ method: r.method, scope: r.scope ?? null, line: r.line ?? null }); break;
      case 'field': {
        if (!r.owner || !r.name) break;
        let m = fieldsByOwner.get(r.owner);
        if (!m) { m = new Map(); fieldsByOwner.set(r.owner, m); }
        // FIRST declaration wins, so a stream that repeats a file cannot change
        // which type a field is read as.
        if (!m.has(r.name)) m.set(r.name, r.typeSimple ?? null);
        break;
      }
      case 'parse_error': parseErrors.push({ file: r.file, line: r.line ?? null, message: r.message ?? null }); break;
      // type/import are indexed above; header and unknown kinds: ignore (additive)
    }
  }

  const { implementorsOf, superOf, bindingsOf, declaredLineOf, declares } = buildHierarchyIndex(types, resolveType);

  // member fqn → definition line, for exact source preview (from method facts).
  const lineOfMember = new Map();
  const aritiesOfMember = new Map(); // "owner#name" -> Set(paramCount), from method records
  for (const m of methods) {
    if (m.line != null) lineOfMember.set(m.fqn, m.line);
    if (Number.isInteger(m.paramCount)) {
      let s = aritiesOfMember.get(m.fqn);
      if (!s) { s = new Set(); aritiesOfMember.set(m.fqn, s); }
      s.add(m.paramCount);
    }
  }

  const stats = {
    endpoints: 0, handles: 0, calls: 0, dispatch: 0, implementsStmt: 0,
    unresolvedCalls: 0, externalCalls: 0, externalSymbols: 0,
    mapperMethods: 0, mapperMethodsBound: 0, unboundMapperMethods: 0, transactional: 0,
    // MEASURED FROM THE FACT SET, not from one worker invocation (RM9): the
    // worker emits a per-file `parse_error` record that rides in that file's
    // shard, so an incremental run over a subset and a cold run over the whole
    // tree report the same two numbers — which is what lets the calibration gate
    // compare them at all (src/core/calibration.mjs, `javaParseErrors`).
    parseErrors: parseErrors.length,
    parsedFiles: parsedFiles.size,
    // Which resolution rule produced how many edges, and which failed how often.
    // Without this split "1568 calls, 8617 unresolved" is a number nobody can act
    // on: the two halves come from rules with very different reach.
    callsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-binding': 0, 'interface-dispatch': 0,
      'inherited-field': 0, 'interface-dispatch-inherited': 0, 'inherited-member-call': 0,
    },
    unresolvedCallsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-unbound': 0, 'inherited-field': 0,
    },
    // WHAT THE WORKER'S `identifier` RECEIVERS TURNED OUT TO BE (javafacts/7).
    // The worker emits the NAME of every receiver its compilation unit never
    // declares; most of them are not inherited fields at all but TYPES —
    // `StringUtils.isEmpty(x)` is a static call, not a field access. Reporting
    // the whole stream as "unresolved" would bury the rule's real failures
    // under thousands of static calls, so the two are counted apart.
    identifierReceivers: { total: 0, inheritedField: 0, staticReceiver: 0, unresolved: 0 },
    // Up to IDENTIFIER_SAMPLE_LIMIT of the receivers nothing explained, with the
    // ancestor chain that was searched: the counter says how big the gap is, the
    // sample says what it is made of.
    unresolvedIdentifiers: [],
    // Members a concrete class only INHERITS, instantiated so a dispatch edge
    // lands on something with a body (§2). `overapproximated` counts the ones
    // that fell back to the ancestor method itself.
    inheritedMembers: { synthesized: 0, calls: 0, overapproximated: 0 },
    // What a mapping annotation turned out to MEAN (src/adapters/java_bridge.mjs
    // `classifyRouteHolder`): a route this pack serves, a route it CALLS over
    // HTTP, or a route contract an interface declares for somebody else to serve.
    // `httpCallsUnresolved` is the one that matters most: those calls leave the
    // pack, so every chain through them ends at this pack's edge.
    routeContracts: 0, contractOnlyRoutes: 0,
    httpCalls: 0, httpCallsResolved: 0, httpCallsUnresolved: 0,
    // What the profile's generatedSources declaration classified. All zero when
    // it declares nothing — which is the default, and is NOT a claim that the
    // project has no generated code (see `generatedDeclared`).
    generatedDeclared: (Array.isArray(generatedSources.annotations) && generatedSources.annotations.length > 0)
      || (Array.isArray(generatedSources.pathGlobs) && generatedSources.pathGlobs.length > 0),
    generatedTypes: 0, generatedTypesByAnnotation: 0, generatedTypesByPath: 0, generatedSymbols: 0,
  };
  // ---- the duplicated-FQN census (SPEC §3.3) -----------------------------
  //
  // A multi-module repo declares the same FQN more than once. jeecg-boot does it
  // three times: `ISysBaseAPI`, `IOnlineBaseExtApi` and `IAiragBaseApi` are each
  // a plain interface in `jeecg-system-local-api` AND a @FeignClient in
  // `jeecg-system-cloud-api` — two Maven modules that are never on one
  // classpath. `types` keeps whichever record the fact stream ends with.
  //
  // MEASURED, then reported, and deliberately NOT resolved. Reversing those
  // three declarations on jeecg-boot moves ZERO edges and ZERO nodes: a node id
  // is the FQN, so both declarations name the same node; dispatch is keyed by
  // FQN, so both find the same implementors; and the one decision that DOES
  // depend on which file a fact came from — is this mapping annotation a route
  // this pack serves or a client call? — already goes through `typeAt(fqn,
  // file)`. Picking a winner by module proximity would therefore change nothing
  // except adding a rule with no fixture behind it. What was missing was the
  // DISCLOSURE: a reader who sees `ISysBaseAPI` listed once cannot tell whether
  // the analysis merged two modules or dropped one. Now the pack says so.
  stats.duplicateFqns = duplicateFqnCensus(filesByFqn, typesByFile, endpoints);

  const generated = classifyGeneratedTypes(types, generatedSources);
  stats.generatedTypes = generated.fqns.size;
  stats.generatedTypesByAnnotation = generated.byAnnotation;
  stats.generatedTypesByPath = generated.byPath;
  // A member of a generated type is generated. The owner is the whole rule:
  // nothing here reads a NAME, so a hand-written class in a generated module is
  // classified generated (which is what the declaration said) and a class called
  // `FooExample` outside one is not.
  const isGeneratedMember = (memberFqn) => generated.fqns.has(ownerOf(memberFqn));
  const fileOf = (typeFqn) => types.get(typeFqn)?.file ?? null;
  // A type is EXTERNAL when the profile declares top-level packages and the
  // type's own package is outside all of them. Its package comes from the type
  // record when the lane parsed it, and from the FQN otherwise (a type the lane
  // only ever saw named in an import is still placeable).
  const isExternalType = (typeFqn) => {
    const pkg = types.get(typeFqn)?.pkg ?? packageOfType(typeFqn);
    return !isProjectPackage(pkg, packagePrefixes);
  };
  const ensureSymbol = (memberFqn) => {
    const id = symbolId(memberFqn);
    if (!g.nodes.has(id)) {
      const owner = ownerOf(memberFqn);
      const external = isExternalType(owner);
      // The file lets the working-tree overlay map an edited file → its symbols
      // (SPEC §10); the line lets the viewer preview the exact method from disk.
      // Both null for a target type the lane never saw (external).
      const gen = isGeneratedMember(memberFqn);
      g.addNode({
        id, symbol: memberFqn, owner, file: fileOf(owner), line: lineOfMember.get(memberFqn) ?? null,
        ...(external ? { external: true } : {}),
        // Only ever written as TRUE: an absent flag means "not classified",
        // which on a project that declared nothing is every symbol — writing
        // `generated:false` everywhere would turn a silence into a claim (and
        // add a field to every node in the pack).
        ...(gen ? { generated: true } : {}),
      });
      if (external) stats.externalSymbols += 1;
      if (gen) stats.generatedSymbols += 1;
    }
    return id;
  };

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
    if (resolved) stats.httpCallsResolved += 1; else stats.httpCallsUnresolved += 1;
  }

  // ---- calls: from-symbol --MAY_CALL--> target-symbol -------------------
  // Track which (interfaceFqn, method) targets were actually called, so dispatch
  // edges are only created where a call exists (no combinatorial phantom edges).
  const calledIfaceMethods = new Set(); // "ifaceFqn#method"
  // One MAY_CALL edge, its stats and its dispatch bookkeeping — written once
  // because the type-parameter rule emits SEVERAL edges for one call site.
  const emitCall = (fromMember, targetFqn, method, rule, extra) => {
    const targetMember = `${targetFqn}#${method}`;
    g.addEdge({
      from: ensureSymbol(fromMember), to: ensureSymbol(targetMember),
      type: 'MAY_CALL', grade: 'SOUND_SET',
      evidence: { rule, basis: CALL_RULE_BASIS[rule], ...extra },
    });
    stats.calls += 1;
    stats.callsByRule[rule] = (stats.callsByRule[rule] ?? 0) + 1;
    if (isExternalType(targetFqn)) stats.externalCalls += 1;
    const t = types.get(targetFqn);
    if (t && t.typeKind === 'interface') calledIfaceMethods.add(targetMember);
  };
  const countUnresolved = (rule) => {
    stats.unresolvedCalls += 1;
    stats.unresolvedCallsByRule[rule] = (stats.unresolvedCallsByRule[rule] ?? 0) + 1;
  };

  // ---- members a class only INHERITS (RM20 §2) ---------------------------
  //
  // `TenantDaoImpl` implements `TenantDao#deleteById` by declaring nothing at
  // all: the body is `BaseDao`'s. Pointing an edge at `TenantDaoImpl#deleteById`
  // was therefore pointing at an empty symbol, and every chain died there.
  //
  // The member is INSTANTIATED instead: one symbol per concrete class, carrying
  // the ancestor's file and line so a reader opens the code that really runs,
  // and carrying the ancestor's calls WITH THIS SUBCLASS'S TYPE ARGUMENTS. That
  // last part is the whole difference between an answer and a smear: the
  // ancestor's `mybatisMapper.deleteById(id)` is one call site shared by every
  // subclass, and dispatching it from the ancestor reaches every mapper in the
  // project, while dispatching it from `TenantDaoImpl` reaches exactly one.
  const callsFrom = new Map(); // member fqn -> its call facts, in stream order
  for (const c of calls) {
    if (!c.from) continue;
    let list = callsFrom.get(c.from);
    if (!list) { list = []; callsFrom.set(c.from, list); }
    list.push(c);
  }
  const pendingInherited = [];
  const synthesizedMembers = new Set();
  /** Queue `classFqn#method` when the class does not declare it but an ancestor does. */
  const queueIfInherited = (classFqn, method) => {
    if (!types.has(classFqn) || declares(classFqn, method, null)) return;
    if (synthesizedMembers.has(`${classFqn}#${method}`)) return;
    const anc = findDeclaringAncestor(classFqn, method, null, { types, superOf, declares });
    if (anc) pendingInherited.push({ classFqn, method, anc });
  };
  const instantiateInherited = ({ classFqn, method, anc }) => {
    const member = `${classFqn}#${method}`;
    if (synthesizedMembers.has(member)) return;
    synthesizedMembers.add(member);
    const ancMember = `${anc.declaredBy}#${method}`;
    const id = ensureSymbol(member);
    const node = g.nodes.get(id);
    // The node SAYS it is inherited and where from, so nothing downstream has to
    // infer it from an absent method record — and the source preview opens the
    // ancestor's file at the ancestor's line, which is the code that runs.
    node.inherited = true;
    node.inheritedFrom = ancMember;
    const ancFile = types.get(anc.declaredBy)?.file ?? null;
    if (ancFile) node.file = ancFile;
    const ancLine = declaredLineOf.get(ancMember) ?? lineOfMember.get(ancMember) ?? null;
    if (ancLine != null) node.line = ancLine;
    stats.inheritedMembers.synthesized += 1;

    for (const c of callsFrom.get(ancMember) ?? []) {
      const rule = CALL_RULES[c.via] ?? CALL_RULES.field;
      const ev = { inheritedFrom: ancMember, forClass: classFqn, receiver: c.receiver ?? null, spelling: c.via ?? null };
      let targetFqn = null;
      if (rule === 'unqualified-enclosing') {
        // An unqualified call in the ancestor's body is a call on `this`, and at
        // run time `this` is the CONCRETE object — so it stays inside the
        // subclass, where it may itself be a member only inherited.
        targetFqn = classFqn;
        queueIfInherited(classFqn, c.method);
      } else if (rule === 'super-enclosing') {
        let cur = superOf.get(anc.declaredBy) ?? null;
        let hops = 0;
        while (cur && types.has(cur) && hops < SUPER_CHAIN_LIMIT) {
          if (declares(cur, c.method, null)) { targetFqn = cur; break; }
          cur = superOf.get(cur) ?? null;
          hops += 1;
        }
      } else if (rule === 'inherited-field') {
        const f = resolveInheritedField(anc.declaredBy, c.receiver, { types, superOf, fieldsByOwner, resolveType });
        if (f) {
          const bound = anc.subst.get(f.typeSimple) ?? null;
          targetFqn = bound ? resolveType(bound.ctx, bound.simple) : f.typeFqn;
          if (bound) ev.binding = bound.simple;
        }
      } else {
        const simple = c.toTypeSimple;
        const bound = simple ? (anc.subst.get(simple) ?? null) : null;
        targetFqn = bound ? resolveType(bound.ctx, bound.simple) : resolveType(anc.declaredBy, simple);
        if (bound) ev.binding = bound.simple;
      }
      if (!targetFqn) continue;
      emitCall(member, targetFqn, c.method, 'inherited-member-call', ev);
      stats.inheritedMembers.calls += 1;
    }
  };

  for (const c of calls) {
    if (!c.from) continue;
    const rule = CALL_RULES[c.via] ?? CALL_RULES.field;
    const ownerFqn = ownerOf(c.from);

    // `super.m()` — walk the extends chain to the FIRST ancestor that declares
    // `m`. Stopping at the immediate superclass would point the edge at a method
    // that type does not have, and the chain would die on a symbol with no body.
    if (rule === 'super-enclosing') {
      let cur = superOf.get(ownerFqn) ?? null;
      let hops = 0;
      let target = null;
      while (cur && types.has(cur) && hops < SUPER_CHAIN_LIMIT) {
        if (declares(cur, c.method, null)) { target = cur; break; }
        cur = superOf.get(cur) ?? null;
        hops += 1;
      }
      if (!target) { countUnresolved('super-enclosing'); continue; }
      emitCall(c.from, target, c.method, 'super-enclosing', { receiver: 'super', declaredBy: target, hops });
      continue;
    }

    // A RECEIVER THE FILE NEVER DECLARES. The worker recorded the name and no
    // type, because in a parse-only per-file worker the declaration is simply
    // not there to read: `mybatisMapper.selectById(id)` inside `XDaoImpl` names
    // a field of `BaseDao`, in another file. Here the whole tree is in hand.
    if (rule === 'inherited-field') {
      stats.identifierReceivers.total += 1;
      const found = resolveInheritedField(ownerFqn, c.receiver, { types, superOf, fieldsByOwner, resolveType });
      if (found && found.typeFqn) {
        stats.identifierReceivers.inheritedField += 1;
        emitCall(c.from, found.typeFqn, c.method, 'inherited-field', {
          receiver: c.receiver,
          declaredBy: found.declaredBy,
          fieldType: found.typeSimple,
          // Present only when the field's declared type was a TYPE PARAMETER
          // that this subclass bound: the name of the type whose `extends`
          // clause spelled the binding.
          ...(found.boundThrough ? { boundThrough: found.boundThrough } : {}),
          hops: found.hops,
        });
        continue;
      }
      // No ancestor declares such a field. If the NAME resolves to a type, the
      // call was `Type.m()` — a static call. It is RESOLVED, not a failure of
      // this rule, and this round does not follow static calls, so it makes no
      // edge and is counted under its own name rather than as an unresolved
      // inherited field.
      if (!found && resolveType(ownerFqn, c.receiver)) {
        stats.identifierReceivers.staticReceiver += 1;
        continue;
      }
      stats.identifierReceivers.unresolved += 1;
      countUnresolved('inherited-field');
      if (stats.unresolvedIdentifiers.length < IDENTIFIER_SAMPLE_LIMIT) {
        stats.unresolvedIdentifiers.push({
          from: c.from, receiver: c.receiver, method: c.method,
          // The chain that WAS searched — the honest answer to "why not?" is the
          // list of ancestors the lane could see, which is often just the class
          // itself (a base class outside the analyzed tree, or a field a code
          // generator adds after parsing).
          chain: found ? found.chain : extendsChainWithBindings(ownerFqn, types, superOf).map((e) => e.fqn),
          ...(found ? { declaredBy: found.declaredBy, fieldType: found.typeSimple } : {}),
        });
      }
      continue;
    }

    // A receiver whose declared type is a TYPE PARAMETER of the enclosing type
    // (`class B<T, S extends IService<T>> { S service; }`) means nothing on its
    // own — `service.list(...)` has no callee until a subclass says what S is.
    // Resolve it PER BINDING: `class C extends B<A, IAService>` binds S, so the
    // call site in B really can run IAService#list.
    const tpIndex = (types.get(ownerFqn)?.typeParams ?? []).indexOf(c.toTypeSimple);
    if (tpIndex >= 0 && c.toTypeSimple) {
      const bound = new Map(); // targetFqn -> {boundAt, bindings}
      for (const b of bindingsOf.get(ownerFqn) ?? []) {
        const argSimple = b.args[tpIndex];
        if (!argSimple) continue;
        const argFqn = resolveType(b.sub, argSimple);
        if (!argFqn) continue;
        const prev = bound.get(argFqn);
        if (prev) prev.bindings += 1;
        else bound.set(argFqn, { boundAt: b.sub, binding: argSimple, bindings: 1 });
      }
      if (bound.size === 0) { countUnresolved('type-param-unbound'); continue; }
      for (const targetFqn of [...bound.keys()].sort(cmp)) {
        const b = bound.get(targetFqn);
        emitCall(c.from, targetFqn, c.method, 'type-param-binding', {
          receiver: c.toTypeSimple, binding: b.binding, boundAt: b.boundAt, bindings: b.bindings,
        });
      }
      continue;
    }

    // An UNQUALIFIED call needs no name resolution at all: its target type IS
    // the enclosing type, which `from` already names in full. Sending it through
    // the simple-name resolver was a mistake that cost the truth twice — a NESTED
    // type's own simple name cannot be rebuilt from `package + name`, and mall's
    // 76 generated `…Example.GeneratedCriteria` classes then made the last-resort
    // "globally unique simple name" rule refuse. Result: 8307 call sites whose
    // target was never in doubt were reported UNRESOLVED. Take the FQN directly.
    const targetFqn = rule === 'unqualified-enclosing' && types.has(ownerFqn)
      ? ownerFqn
      : resolveType(ownerFqn, c.toTypeSimple);
    if (!targetFqn) { countUnresolved(rule); continue; }
    // ONE grade, but the evidence names the RULE that produced the edge: the
    // rules can be wrong in different ways, and a reader deciding how far to
    // trust a chain needs to know which one it rested on.
    emitCall(c.from, targetFqn, c.method, rule, {
      receiver: rule === 'unqualified-enclosing' ? 'this' : c.toTypeSimple,
    });
    // `insert(model)` written inside a subclass of a base that declares `insert`
    // is the base's body running as this subclass — the same instantiation the
    // dispatch path needs, reached by a different spelling.
    if (rule === 'unqualified-enclosing') queueIfInherited(targetFqn, c.method);
  }

  // ---- dispatch: interfaceMethod --MAY_CALL--> implMethod (CHA over-approx)
  //
  // AND THE HALF THAT USED TO END HERE. `tenantDao.deleteById(id)` resolves to
  // the interface; the implementor DECLARES nothing — it inherits the method
  // from a generic abstract base — so the edge landed on a symbol with no body
  // and the chain stopped one hop short of the mapper. What runs at that call
  // site is the ancestor's code AS THAT SUBCLASS: the same body, with the
  // subclass's type arguments. So the member is instantiated for the concrete
  // class (`instantiateInherited` below) and the dispatch edge lands on
  // something that leads somewhere.
  //
  // Instantiating can itself reveal more work — a synthesized body calls an
  // interface (more dispatch) or another member the class only inherits — so
  // the two run to a fixed point rather than in one pass. Both sets are
  // monotone, so it terminates.
  const dispatched = new Set();
  const dispatchOne = (ifaceMember) => {
    const ifaceFqn = ownerOf(ifaceMember);
    const method = ifaceMember.slice(ifaceMember.lastIndexOf('#') + 1);
    const impls = implementorsOf.get(ifaceFqn);
    if (!impls) return;
    const fromId = ensureSymbol(ifaceMember);
    const arities = aritiesOfMember.get(ifaceMember) ?? null;
    for (const implFqn of [...impls].sort(cmp)) {
      // Does the implementor DECLARE it, or only inherit it? Arity is used when
      // the interface record gave one (it does for every interface method), so a
      // same-named overload cannot answer for the method that was called.
      const declaresIt = arities
        ? [...arities].some((n) => declares(implFqn, method, n))
        : declares(implFqn, method, null);
      let anc = null;
      if (!declaresIt) {
        anc = null;
        for (const n of arities ? [...arities].sort() : [null]) {
          anc = findDeclaringAncestor(implFqn, method, n, { types, superOf, declares });
          if (anc) break;
        }
        // An arity-matched ancestor is best; fall back to the name alone rather
        // than losing the member because the worker recorded no arity.
        if (!anc && arities) anc = findDeclaringAncestor(implFqn, method, null, { types, superOf, declares });
      }
      const toId = ensureSymbol(`${implFqn}#${method}`);
      g.addEdge({
        from: fromId, to: toId, type: 'MAY_CALL', grade: 'SOUND_SET',
        evidence: anc
          ? {
            rule: 'interface-dispatch-inherited', basis: CALL_RULE_BASIS['interface-dispatch-inherited'],
            iface: ifaceFqn, inheritedFrom: `${anc.declaredBy}#${method}`, hops: anc.hops,
          }
          : { rule: 'interface-dispatch', basis: CALL_RULE_BASIS['interface-dispatch'], iface: ifaceFqn },
      });
      stats.dispatch += 1;
      stats.callsByRule[anc ? 'interface-dispatch-inherited' : 'interface-dispatch'] += 1;
      if (anc) pendingInherited.push({ classFqn: implFqn, method, anc });
    }
  };

  // Run dispatch and instantiation to a fixed point.
  for (let guard = 0; guard < INHERITED_FIXPOINT_LIMIT; guard += 1) {
    let moved = false;
    for (const m of [...calledIfaceMethods].sort(cmp)) {
      if (dispatched.has(m)) continue;
      dispatched.add(m);
      dispatchOne(m);
      moved = true;
    }
    while (pendingInherited.length > 0) {
      instantiateInherited(pendingInherited.shift());
      moved = true;
    }
    if (!moved) break;
  }

  // ---- IMPLEMENTS_STMT: any symbol whose fqn matches a statement node -----
  // Register method records as symbols first so uncalled mapper methods still
  // bind (table_usage sees every mapper method, not only reachable ones).
  for (const m of methods) ensureSymbol(m.fqn);

  // Which owner types are MyBatis mappers at all. Two independent witnesses, so
  // the census works in a pack that has only one of the two lanes:
  //   - a type whose FQN is the namespace of a statement THIS pack carries;
  //   - a type the source annotates @Mapper (the only witness a java-only pack has).
  const mapperOwners = new Set();
  for (const id of g.nodes.keys()) {
    if (!id.startsWith('statement:')) continue;
    const ns = namespaceOfStatementKey(id.slice('statement:'.length));
    if (ns) mapperOwners.add(ns);
  }
  for (const [fqn, t] of types) {
    if ((t.annotations ?? []).includes('Mapper')) mapperOwners.add(fqn);
  }

  for (const [id, node] of g.nodes) {
    if (node.kind !== 'symbol') continue;
    const memberFqn = id.slice('symbol:'.length);
    const stmtNodeId = nodeId('statement', memberToStatementKey(memberFqn));
    const isMapperMethod = mapperOwners.has(ownerOf(memberFqn));
    if (isMapperMethod) {
      // Marked on the node so `cascade estimate` can measure "how many mapper
      // methods actually bind to SQL" from the pack alone, with no lane stats.
      node.mapperMethod = true;
      stats.mapperMethods += 1;
    }
    if (g.nodes.has(stmtNodeId)) {
      g.addEdge({ from: id, to: stmtNodeId, type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
      stats.implementsStmt += 1;
      if (isMapperMethod) stats.mapperMethodsBound += 1;
    } else if (isMapperMethod) {
      // The statement this method would run is not in this pack (the SQL lane
      // was not run, or its mapper XML was outside the analyzed directories).
      // DELIBERATE CHOICE: skip the edge — a stub statement node would be a
      // fact the engine never saw. It is counted here instead, and `overview`
      // and `estimate` report the count so the gap is visible, not silent.
      stats.unboundMapperMethods += 1;
    }
  }

  // Mark transaction boundaries on their symbol nodes (create if the method was
  // never otherwise referenced). The read/write footprint is computed at query
  // time by forward reach from the node (SPEC §9: a transaction's atomic set).
  for (const tx of transactionals) {
    const id = ensureSymbol(tx.method);
    const n = g.nodes.get(id);
    n.transactional = true;
    n.txScope = tx.scope;
    if (n.line == null && tx.line != null) n.line = tx.line;
    stats.transactional += 1;
  }

  return stats;
}

/**
 * The HTTP endpoints from which a column is reachable (backward impact over the
 * stitched chain). Returns endpoints with the weakest-link path grade.
 *
 * FLOW edges only: without the filter the walk would step column ← DECLARES ←
 * table ← EXECUTES ← statement and report every endpoint whose SQL touches the
 * TABLE as if it touched this column (measured on mall: 339 of 669 columns came
 * back with endpoints they do not have, 1253 phantom entries in all).
 * @param {Graph} g
 * @param {string} columnNodeId
 * @param {{mode?:string}} [opts]
 * @returns {{endpoint:string, httpMethod:string, path:string, pathGrade:string}[]}
 */
export function endpointsAffectingColumn(g, columnNodeId, opts = {}) {
  const reached = g.impactOf(columnNodeId, { mode: opts.mode ?? 'conservative', edgeTypes: FLOW_EDGE_TYPES });
  const out = [];
  for (const [id, info] of reached) {
    const node = g.nodes.get(id);
    if (node && node.kind === 'endpoint') {
      out.push({
        endpoint: id,
        httpMethod: node.httpMethod,
        path: node.path,
        pathGrade: info.pathGrade,
        // A route reached only ACROSS an internal HTTP hop is affected through
        // ANOTHER DEPLOYABLE. Disclosed, never folded in silently.
        ...(info.http > 0 ? { viaHttp: true, httpHops: info.http } : {}),
      });
    }
  }
  out.sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0));
  return out;
}

export class JavaBridgeError extends Error {
  constructor(message) { super(message); this.name = 'JavaBridgeError'; }
}
