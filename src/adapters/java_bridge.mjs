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
//  - CALLS_HTTP     SOUND_SET  an HTTP client call reaches a route this pack also SERVES — the
//                              internal HTTP hop of §1.1. Two ways of writing one: a
//                              @FeignClient/@HttpExchange method (the route is in the annotation)
//                              and an imperative WebClient/RestClient/RestTemplate call (the verb
//                              is a method name and the url is an argument).
//                   UNRESOLVED …or one it does not: the target is outside the pack, so the edge is
//                              below every mode's floor and no walk follows it. It is counted, not
//                              hidden (`httpCallsUnresolved`). An imperative call whose url this
//                              lane could not reduce to a path gets NO edge at all, and is counted
//                              apart (`httpCallsUrlUnreadable`): a route nobody wrote is not put in
//                              the graph to stand in for one.
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
// One route-matching rule for the whole engine. The web lane wrote it (a call
// path and a route path each carry holes, and they are not the same kind of
// hole), and an imperative Java call is the same question asked from the other
// side of the wire: two rules would mean two answers for one url.
import { routeMatches, normalizeUrlPath } from './web_bridge.mjs';

export const JAVAFACTS_SCHEMA = 'cascade:javafacts:1';

/**
 * How far a `super.m()` walk climbs before giving up. A Java hierarchy is
 * acyclic, but a fact set assembled from shards need not be (two files can be
 * edited into a cycle), and a walk that hangs is worse than one that says it
 * stopped.
 */
const SUPER_CHAIN_LIMIT = 32;

/** The empty enclosing chain of a top-level type, shared so it is never rebuilt. */
const EMPTY_CHAIN = Object.freeze([]);

/** "no on-demand import explains this name", shared so it is never rebuilt. */
const UNKNOWN_PLACE = Object.freeze({ kind: 'unknown' });

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

/**
 * How many inheriting types one generic base's body is resolved for before the
 * downward walk gives up. A real hierarchy is far below it (jeecg-boot's widest
 * is 29 controllers on one base); the guard is against a fact set edited into a
 * cycle, for the same reason SUPER_CHAIN_LIMIT exists.
 */
const INHERITOR_WALK_LIMIT = 4096;

/**
 * How many (package, simple name) pairs the "outside the analyzed roots" list
 * NAMES. The count is always exact; naming a few is what turns it into advice.
 */
const TYPES_OUTSIDE_ROOTS_LISTED = 25;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * THE TYPES `java.lang` PUTS IN EVERY FILE, WITH NO IMPORT.
 *
 * `java.lang.*` is an on-demand import the language adds to every compilation
 * unit, so `Integer.valueOf(s)`, `System.currentTimeMillis()` and `String.format(f)`
 * name types no source line mentions. Without this list the resolver saw a
 * receiver it had never heard of and reported the call UNRESOLVED — 877 of them
 * on dolphinscheduler, 524 on jeecg-boot — which reads as "the analysis lost a
 * call" when in fact the call leaves the project by definition: the JDK is not
 * source this lane ever reads.
 *
 * IT IS A LIST AND NOT A PREFIX TEST, and that matters: `resolveType` returns
 * `java.lang.<Simple>` for a name IN THIS LIST and null for anything else, so a
 * receiver the lane cannot place is still reported as unplaced rather than
 * quietly invented into a package that has no such type.
 *
 * WHERE IT SITS IN THE ORDER is the language's own precedence — after a single
 * import, after the same package, after an explicit on-demand import, and
 * BEFORE this engine's "a globally unique simple name is probably that type"
 * rule. A project class called `Process` in some other package is not what
 * `Process.x()` means in a file that never imported it.
 *
 * Frozen and exported so a test can read the list instead of re-deriving it.
 */
export const JAVA_LANG_TYPES = Object.freeze([
  'AbstractMethodError', 'Appendable', 'ArithmeticException', 'ArrayIndexOutOfBoundsException',
  'ArrayStoreException', 'AssertionError', 'AutoCloseable', 'Boolean', 'BootstrapMethodError',
  'Byte', 'Character', 'CharSequence', 'Class', 'ClassCastException', 'ClassCircularityError',
  'ClassFormatError', 'ClassLoader', 'ClassNotFoundException', 'ClassValue',
  'CloneNotSupportedException', 'Cloneable', 'Comparable', 'Deprecated', 'Double',
  'EnumConstantNotPresentException', 'Enum', 'Error', 'Exception', 'ExceptionInInitializerError',
  'Float', 'FunctionalInterface', 'IllegalAccessError', 'IllegalAccessException',
  'IllegalArgumentException', 'IllegalCallerException', 'IllegalMonitorStateException',
  'IllegalStateException', 'IllegalThreadStateException', 'IncompatibleClassChangeError',
  'IndexOutOfBoundsException', 'InheritableThreadLocal', 'InstantiationError',
  'InstantiationException', 'Integer', 'InternalError', 'InterruptedException', 'Iterable',
  'LayerInstantiationException', 'LinkageError', 'Long', 'Math', 'Module', 'ModuleLayer',
  'NegativeArraySizeException', 'NoClassDefFoundError', 'NoSuchFieldError', 'NoSuchFieldException',
  'NoSuchMethodError', 'NoSuchMethodException', 'NullPointerException', 'Number',
  'NumberFormatException', 'Object', 'OutOfMemoryError', 'Override', 'Package', 'Process',
  'ProcessBuilder', 'ProcessHandle', 'Readable', 'Record', 'ReflectiveOperationException',
  'Runnable', 'Runtime', 'RuntimeException', 'RuntimePermission', 'SafeVarargs', 'ScopedValue',
  'SecurityException', 'SecurityManager', 'Short', 'StackOverflowError', 'StackTraceElement',
  'StackWalker', 'StrictMath', 'String', 'StringBuffer', 'StringBuilder',
  'StringIndexOutOfBoundsException', 'SuppressWarnings', 'System', 'Thread', 'ThreadDeath',
  'ThreadGroup', 'ThreadLocal', 'Throwable', 'TypeNotPresentException', 'UnknownError',
  'UnsatisfiedLinkError', 'UnsupportedClassVersionError', 'UnsupportedOperationException',
  'VerifyError', 'VirtualMachineError', 'Void', 'WrongThreadException',
]);
const JAVA_LANG = new Set(JAVA_LANG_TYPES);

/**
 * THE FIELD LOMBOK WRITES THAT THE SOURCE DOES NOT.
 *
 * `@Slf4j` on a class makes the compiler's annotation processor add
 * `private static final org.slf4j.Logger log = …`. The field is real at run
 * time and absent from every parse tree, so `log.info(…)` was a receiver
 * nothing declared — 1502 call sites on dolphinscheduler, 1147 on jeecg-boot,
 * every one of them reported as an unresolved call.
 *
 * Annotation simple name -> the FQN of the logger it generates. `CustomLog` is
 * the one that cannot be answered from source: its logger type is declared in
 * `lombok.config`, which is not a file this lane reads, so the edge names the
 * annotation that generates the field. It is outside the project either way, so
 * the call leaves it at exactly the same place — and the evidence says the
 * logger type itself was not knowable rather than pretending it was read.
 */
export const LOMBOK_LOGGERS = Object.freeze({
  Slf4j: 'org.slf4j.Logger',
  Log4j2: 'org.apache.logging.log4j.Logger',
  Log4j: 'org.apache.log4j.Logger',
  Log: 'java.util.logging.Logger',
  CommonsLog: 'org.apache.commons.logging.Log',
  XSlf4j: 'org.slf4j.ext.XLogger',
  JBossLog: 'org.jboss.logging.Logger',
  Flogger: 'com.google.common.flogger.FluentLogger',
  CustomLog: 'lombok.extern.CustomLog',
});

/** The name of the field every one of those annotations generates. */
const LOMBOK_LOG_FIELD = 'log';

/**
 * The on-demand import packages whose contents this lane will never parse.
 *
 * `import java.util.*;` then `Arrays.asList(…)` names `java.util.Arrays`, and
 * no amount of reading this project's source will ever turn that into a type
 * record. The JDK is a closed world: a call into it LEAVES the project, which
 * is a different fact from a call the analysis could not place, and it is the
 * one the reader should see.
 */
export const JDK_WILDCARD_PACKAGES = Object.freeze(['java', 'javax', 'jakarta']);

/**
 * WHY A CALL IS STILL UNRESOLVED, in the four words a reader can act on.
 *
 * `unresolvedCallsByRule` says which RULE failed; that is a fact about the
 * engine. This says what was MISSING, which is a fact about the run — and only
 * one of them is something a reader can fix.
 */
export const UNRESOLVED_REASONS = Object.freeze([
  // A wildcard import names a package of THIS project and the type it would
  // bring in is under no root this run analyzed. Pass the module's source root
  // and the call resolves.
  'project-type-outside-roots',
  // `super.m()` whose base class this lane never parsed AND whose name it could
  // not resolve either, so there is nothing to point an edge at.
  'superclass-outside-roots',
  // The receiver's type is a type parameter no subclass in this pack binds.
  'type-param-unbound',
  // Everything else: a third-party type behind a wildcard, a constant brought
  // in by a static import, a field a code generator adds after parsing.
  'unknown',
]);

/**
 * Whether a simple name is spelled like a TYPE rather than like a constant.
 *
 * Used only where the alternative is a guess: `Arrays.asList()` under
 * `import java.util.*` is a type, and `ADD_STRING.equals(x)` under the same
 * import is a constant somebody static-imported or inherited. Both start with a
 * capital; only the first has a lower-case letter in it, and guessing
 * `java.util.ADD_STRING` would be inventing a type that does not exist.
 * @param {string|null|undefined} simple
 * @returns {boolean}
 */
export function looksLikeTypeName(simple) {
  return typeof simple === 'string' && /^[A-Z]/.test(simple) && /[a-z]/.test(simple);
}

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
  'type-param-binding': 'the receiver\'s declared type is a TYPE PARAMETER of the enclosing type, so it has no meaning until a subclass binds it. The base method\'s body is shared, and it is read once per inheriting subclass IN THAT SUBCLASS\'S SUBSTITUTION: the edge leaves the SUBCLASS\'S OWN copy of the method and names the single collaborator that subclass binds, never the union of what every subclass binds. Still a dispatch through a type parameter and still an over-approximation of one CALL SITE, now bound to one owner',
  'interface-dispatch': 'interface→impl class-hierarchy dispatch (an over-approximation: every implementor is a candidate)',
  'inherited-field': 'the receiver names no variable the file declares, so it is a member INHERITED from a supertype: the `extends` chain was walked to the nearest ancestor that declares a field of that name (first declaration wins), and a field typed by one of that ancestor\'s type parameters was bound through the subclass\'s `extends` arguments, IN THE CONTEXT OF THIS SUBCLASS, so the edge names that subclass\'s binding and no other\'s',
  'interface-dispatch-inherited': 'interface→impl dispatch where the implementor does not DECLARE the method: the `extends` chain was walked to the nearest ancestor that declares it (name + arity), and the inherited member was instantiated as a symbol of the concrete class whose calls carry that class\'s type-parameter bindings. This is the same over-approximation as interface-dispatch on the implementor set, but no longer blind to a method a class only inherits',
  'generated-field': 'the receiver names no variable the file declares and no field any ancestor declares, but the enclosing type carries a Lombok logging annotation, which GENERATES a `log` field no line of source spells. The edge names the logger type that annotation creates, which is outside this project, so the chain ends here. That is where it really ends at run time too',
  'wildcard-jdk': 'the receiver\'s type is named by an on-demand import of a `java.*`, `javax.*` or `jakarta.*` package and no analyzed type declares it, so the target is that package\'s type: the JDK is a closed world this lane never reads, and the call leaves the project whichever of those packages it is in',
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
  'http-client-call': 'an IMPERATIVE client call (a WebClient/RestClient chain or a RestTemplate request) sends this method to this url: the verb is the method the code named, and the path is the url reduced as far as one file allows, with a scheme://host stripped off and kept as evidence. Which deployable answers is not knowable from source, so the grade says only whether a route with this method+path exists in the pack, and drops to HEURISTIC when the verb was an argument this lane could not read and only the path was matched',
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
 *            enclosingChainOf:(fqn:string)=>string[], topLevelOf:(fqn:string)=>string,
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

  // THE ENCLOSING TYPES OF A NESTED TYPE, rebuilt from its own record.
  //
  // A nested type has no compilation unit of its own: the worker keys every
  // import and wildcard by the TOP-LEVEL type, because that is where the file's
  // `import` lines belong, and it stamps the FILE's package on every type it
  // sees. So `a.b.Outer.Inner` carries `pkg = "a.b"`, and everything after the
  // package is the nesting — `Outer.Inner`. That is all it takes to rebuild the
  // scope chain, which is why the worker needs no new record for this.
  //
  // Innermost first; the LAST entry is the top-level type, which is the key the
  // imports are under. EMPTY for a top-level type, so a caller can tell the two
  // apart without asking again.
  //
  // WHAT IT COST TO NOT HAVE THIS: every call inside one of litemall's 76
  // generated `…Example.GeneratedCriteria` classes looked up `List` under the
  // key `…Example.GeneratedCriteria`, where there are no imports at all, and
  // 288 calls came back unresolved that a top-level class in the same file
  // resolves without trouble.
  const enclosingChainOf = (fqn) => {
    const t = types.get(fqn);
    if (!t) return EMPTY_CHAIN;
    const pkg = t.pkg ?? '';
    const nest = pkg ? (fqn.startsWith(`${pkg}.`) ? fqn.slice(pkg.length + 1) : null) : fqn;
    if (nest == null || !nest.includes('.')) return EMPTY_CHAIN;
    const segs = nest.split('.');
    const out = [];
    for (let i = segs.length - 1; i >= 1; i -= 1) {
      const outer = segs.slice(0, i).join('.');
      out.push(pkg ? `${pkg}.${outer}` : outer);
    }
    return out;
  };
  /** The top-level type a (possibly nested) type belongs to — the imports' key. */
  const topLevelOf = (fqn) => {
    const chain = enclosingChainOf(fqn);
    return chain.length > 0 ? chain[chain.length - 1] : fqn;
  };

  // Resolve a simple type name seen inside `ownerFqn` to a fully-qualified type,
  // in the order the LANGUAGE resolves it, which is also decreasing certainty:
  //   1. a member type in scope — this type's own nested types, then each
  //      enclosing type's                              (exact)
  //   2. an explicit single-type import of the FILE    (exact)
  //   3. the same package, if that type is known       (exact)
  //   4. an on-demand (wildcard) import package that contains a known type
  //   5. java.lang, which every compilation unit imports on demand
  //   6. a globally UNIQUE app type with that simple name (sound: no ambiguity)
  // None is compiler-verified, so callers still grade the resulting edge
  // SOUND_SET. Rules 1, 3, 4 and 6 yield a type the lane really parsed; rules 2
  // and 5 can yield one it never saw (an imported library class, a JDK class),
  // which is how a call OUT of the project gets an edge that says so instead of
  // being reported as a failure. Returns null when none of the six applies — we
  // never invent a package.
  const resolveType = (ownerFqn, simple) => {
    if (!simple) return null;
    const chain = enclosingChainOf(ownerFqn);
    for (const scope of [ownerFqn, ...chain]) {
      const guess = `${scope}.${simple}`;
      if (types.has(guess)) return guess;
    }
    const top = chain.length > 0 ? chain[chain.length - 1] : ownerFqn;
    const imp = importsByOwner.get(top);
    if (imp && imp.has(simple)) return imp.get(simple);
    const t = types.get(ownerFqn);
    if (t && t.pkg) {
      const guess = `${t.pkg}.${simple}`;
      if (types.has(guess)) return guess;
    }
    for (const pkg of wildcardsByOwner.get(top) ?? []) {
      const guess = `${pkg}.${simple}`;
      if (types.has(guess)) return guess;
    }
    if (JAVA_LANG.has(simple)) return `java.lang.${simple}`;
    const uniq = simpleIndex.get(simple);
    if (uniq && uniq.size === 1) return [...uniq][0];
    return null;
  };

  return {
    types, typesByFile, filesByFqn, importsByOwner, wildcardsByOwner, simpleIndex,
    enclosingChainOf, topLevelOf, resolveType,
  };
}

/**
 * The HIERARCHY half of the fact index, read four ways from one pass over the
 * type records:
 *
 *   implementorsOf  interfaceFqn -> Set(implFqn)      interface -> impl dispatch
 *   superOf         fqn -> resolved superclass fqn    `super.m()`
 *   subclassesOf    fqn -> Set(direct subclass fqn)   the same `extends` relation
 *                                                     read DOWNWARD, which is what
 *                                                     "who inherits this body?" asks
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
 *            subclassesOf:Map<string,Set<string>>,
 *            bindingsOf:Map<string,{sub:string,args:string[]}[]>,
 *            declaredByType:Map<string,Map<string,Set<number>>>,
 *            declares:(fqn:string,name:string,arity:(number|null))=>boolean}}
 */
export function buildHierarchyIndex(types, resolveType) {
  const implementorsOf = new Map();
  const superOf = new Map();
  const subclassesOf = new Map();
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
      if (sup) {
        let s = subclassesOf.get(sup);
        if (!s) { s = new Set(); subclassesOf.set(sup, s); }
        s.add(fqn);
      }
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

  return { implementorsOf, superOf, subclassesOf, bindingsOf, declaredByType, declaredLineOf, declares };
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
 * EVERY TYPE THAT INHERITS A GENERIC TYPE'S BODY, AND WHAT EACH ONE BINDS ONE OF
 * ITS TYPE PARAMETERS TO.
 *
 * `extendsChainWithBindings` answers this looking UP, from one subclass. A base
 * method's body is the other direction: `JeecgController<T, S extends IService<T>>`
 * writes `service.list(...)` ONCE and twenty-nine controllers run it, each with
 * its own `S`. Asking the question from the base is what lets the answer be
 * twenty-nine separate edges instead of one node holding all of them.
 *
 * The walk goes down the `extends` relation and reads each subclass's binding
 * back UP with the existing chain walk, so a class that binds through an
 * intermediate base (`class Leaf extends Mid`, `class Mid extends Base<X, XSvc>`)
 * is answered with what the intermediate wrote, and a class that binds nothing
 * (a raw `extends Base`) is simply absent. A type that reaches the base through
 * `implements` is not on that chain, so its own type arguments are read directly.
 *
 * @param {string} baseFqn        the generic type whose body is shared
 * @param {string} paramSimple    the type parameter the receiver is typed by
 * @param {{types:Map<string,object>, superOf:Map<string,(string|null)>,
 *          subclassesOf:Map<string,Set<string>>,
 *          bindingsOf:Map<string,{sub:string,args:string[]}[]>}} idx
 * @returns {Map<string,{simple:string, ctx:string}>}  subclass fqn -> its binding
 */
export function inheritorsOfTypeParam(baseFqn, paramSimple, idx) {
  const out = new Map();
  const base = idx.types.get(baseFqn);
  if (!base) return out;
  const paramIndex = (base.typeParams ?? []).indexOf(paramSimple);
  if (paramIndex < 0) return out;
  const direct = idx.bindingsOf.get(baseFqn) ?? [];
  const queue = direct.map((b) => b.sub);
  const seen = new Set();
  while (queue.length > 0) {
    const sub = queue.shift();
    if (!sub || seen.has(sub) || !idx.types.has(sub)) continue;
    seen.add(sub);
    // A fact set assembled from shards can be edited into a cycle, and a walk
    // that hangs is worse than one that says it stopped.
    if (seen.size > INHERITOR_WALK_LIMIT) break;
    for (const d of idx.subclassesOf.get(sub) ?? []) queue.push(d);
    const at = extendsChainWithBindings(sub, idx.types, idx.superOf).find((e) => e.fqn === baseFqn);
    let bound = at ? (at.subst.get(paramSimple) ?? null) : null;
    if (!bound) {
      const args = direct.find((b) => b.sub === sub)?.args ?? [];
      if (args[paramIndex]) bound = { simple: args[paramIndex], ctx: sub };
    }
    if (bound) out.set(sub, bound);
  }
  return out;
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
 *          generatedSources?:{annotations?:string[], pathGlobs?:string[]},
 *          gatewayRoutes?:object}} [opts]
 *        packagePrefixes: the profile's declared top-level packages — a symbol
 *        outside every one of them is marked `external:true`, and a call to one
 *        is counted as `externalCalls` rather than reported as "unresolved" (a
 *        library call the lane RESOLVED and deliberately did not follow is not
 *        the same failure as a call it could not resolve).
 *        generatedSources: the profile's declaration of what machine-written
 *        code looks like in THIS project — symbols of a matching type get
 *        `generated:true`. Undeclared classifies nothing.
 *        gatewayRoutes: the profile's declared prefix map, applied to an
 *        IMPERATIVE HTTP call's path the way the web bridge applies it to a
 *        frontend call, so a service that calls another through a gateway
 *        prefix lands on the route the other service really serves. The `*`
 *        key is a FRONT-END base url and means nothing here (a Java call writes
 *        its url at the call site), so it is not applied.
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
  const gatewayRoutes = opts.gatewayRoutes && typeof opts.gatewayRoutes === 'object' ? opts.gatewayRoutes : {};

  // ---- indices -----------------------------------------------------------
  const {
    types, typesByFile, filesByFqn, importsByOwner, wildcardsByOwner, enclosingChainOf, topLevelOf, resolveType,
  } = buildTypeIndex(javaFacts);
  // The type record a FACT came from: same fqn AND same file, so a duplicated
  // FQN cannot make one module's declaration answer for another's.
  const typeAt = (fqn, file) => (file ? typesByFile.get(`${fqn} ${file}`) : undefined) ?? types.get(fqn);
  const methods = [];                      // {fqn, owner, line}
  const calls = [];                        // {from, method, toTypeSimple}
  const endpoints = [];                    // {httpMethod, path, handler, line}
  const transactionals = [];               // {method, scope, line} — @Transactional boundaries
  // IMPERATIVE HTTP calls, as the worker read them (javafacts/8): a WebClient or
  // RestClient chain, or a RestTemplate request. Kept whole rather than picked
  // apart here, because the whole record is the evidence the edge carries.
  const httpCallFacts = [];                // {from, client, httpMethod, path, url, host, ...}
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
      case 'httpCall': httpCallFacts.push(r); break;
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

  const {
    implementorsOf, superOf, subclassesOf, bindingsOf, declaredLineOf, declares,
  } = buildHierarchyIndex(types, resolveType);
  // Who inherits a generic base's body, and what each of them binds one of its
  // parameters to. Asked once per (base, parameter) rather than once per call
  // site: a base method with three type-parameter calls asks the same question
  // three times, and the answer is a property of the hierarchy, not of the call.
  const inheritorCache = new Map();
  const inheritorsFor = (baseFqn, paramSimple) => {
    const key = `${baseFqn} ${paramSimple}`;
    let hit = inheritorCache.get(key);
    if (!hit) {
      hit = inheritorsOfTypeParam(baseFqn, paramSimple, { types, superOf, subclassesOf, bindingsOf });
      inheritorCache.set(key, hit);
    }
    return hit;
  };

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
      'generated-field': 0, 'wildcard-jdk': 0,
    },
    unresolvedCallsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-unbound': 0, 'inherited-field': 0,
    },
    // …AND WHY, which is the half a reader can act on. The rule split above
    // names the piece of THIS ENGINE that failed; this names what was MISSING
    // from the run. One of the four is a thing somebody can fix in a minute (a
    // module that was never passed as a source root) and the other three are
    // boundaries of what a parse-only lane can see, and a single total buries
    // the difference.
    unresolvedCallsByReason: Object.fromEntries(UNRESOLVED_REASONS.map((r) => [r, 0])),
    // The `project-type-outside-roots` reason, NAMED: which package, which
    // simple name, how many call sites. Up to TYPES_OUTSIDE_ROOTS_LISTED of
    // them — "pass --java-src <module>/src/main/java" is only advice if it says
    // which module.
    typesOutsideRoots: [],
    // WHAT THE WORKER'S `identifier` RECEIVERS TURNED OUT TO BE (javafacts/7).
    // The worker emits the NAME of every receiver its compilation unit never
    // declares; most of them are not inherited fields at all but TYPES —
    // `StringUtils.isEmpty(x)` is a static call, not a field access. Reporting
    // the whole stream as "unresolved" would bury the rule's real failures
    // under thousands of static calls, so the two are counted apart.
    // `generatedField` is the third kind: a field an ANNOTATION PROCESSOR adds,
    // which no parse tree can ever hold (Lombok's `log`).
    identifierReceivers: { total: 0, inheritedField: 0, generatedField: 0, staticReceiver: 0, unresolved: 0 },
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
    // The two producers of a CALLS_HTTP edge in this lane, which sum to
    // `httpCalls`: the DECLARATIVE client (a @FeignClient/@HttpExchange method)
    // and the IMPERATIVE one (a WebClient/RestClient chain, a RestTemplate
    // request). Counted apart because they fail differently — a declarative
    // client states its route, an imperative one states a url somebody built.
    httpCallsDeclarative: 0, httpCallsImperative: 0,
    // Imperative call sites whose url this lane could not reduce to a path (a
    // bare variable, a fully computed string). NO edge is drawn for them and no
    // route is invented: they are the honest gap, and this is its size.
    httpCallsUrlUnreadable: 0,
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
    stats.httpCallsDeclarative += 1;
    if (resolved) stats.httpCallsResolved += 1; else stats.httpCallsUnresolved += 1;
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
    let full = normalizeUrlPath(c.path);
    let prefix = null;
    const hit = gatewayKeys.find((k) => full === k || full.startsWith(`${k}/`));
    if (hit !== undefined) {
      full = normalizeUrlPath(`${gatewayRoutes[hit]}${full.slice(hit.length)}`);
      prefix = { value: String(gatewayRoutes[hit]), from: 'declared', written: hit };
    }
    const httpMethod = typeof c.httpMethod === 'string' && c.httpMethod.length > 0 ? c.httpMethod : null;
    const found = matchServed(httpMethod, full);
    const fromId = ensureSymbol(c.from);
    const targets = found.routes.length > 0
      ? found.routes.map((r) => ({ epId: r.epId, resolved: true }))
      : [{ epId: endpointId(httpMethod ?? 'ANY', full), resolved: false }];
    for (const t of targets) {
      const key = `${fromId} ${t.epId}`;
      if (imperativeSeen.has(key)) continue;
      imperativeSeen.add(key);
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
          // declarative edge draws for an annotation that names a constant.
          service: c.host ?? null,
          serviceLiteral: c.hostLiteral === true,
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
  const countUnresolved = (rule, reason) => {
    stats.unresolvedCalls += 1;
    stats.unresolvedCallsByRule[rule] = (stats.unresolvedCallsByRule[rule] ?? 0) + 1;
    const r = UNRESOLVED_REASONS.includes(reason) ? reason : 'unknown';
    stats.unresolvedCallsByReason[r] += 1;
  };

  // ---- what a name that did not resolve was missing ----------------------
  //
  // A FIELD LOMBOK WROTE (RM35 §C). `@Slf4j` on a class makes the annotation
  // processor add `private static final Logger log`; the field is real at run
  // time and in no parse tree, so `log.info(…)` reached the inherited-field
  // rule as a receiver nothing declares and was reported as an unresolved call
  // — 1502 of them on dolphinscheduler alone. The annotation IS the evidence,
  // so the field is synthesized here rather than left to the worker, which sees
  // one file and cannot know the annotation is Lombok's.
  //
  // Kept OUT of `fieldsByOwner` on purpose: Lombok's field is `private static`,
  // so a SUBCLASS does not inherit it, and putting it in the map the
  // inherited-field walk reads would hand it to every subclass in the tree.
  const generatedFieldsOf = new Map(); // typeFqn -> Map<name, {typeFqn, annotation}>
  for (const [fqn, t] of types) {
    // A class that declares its own `log` keeps it: Lombok refuses to generate
    // over a field the source already writes, and so do we.
    if (fieldsByOwner.get(fqn)?.has(LOMBOK_LOG_FIELD)) continue;
    for (const a of t.annotations ?? []) {
      const logger = LOMBOK_LOGGERS[a];
      if (!logger) continue;
      generatedFieldsOf.set(fqn, new Map([[LOMBOK_LOG_FIELD, { typeFqn: logger, annotation: a }]]));
      break;
    }
  }
  /**
   * The generated field this receiver name refers to, looked up in the type
   * itself and then in its enclosing types — a nested class reads the outer
   * class's `private static log`, which is how dolphinscheduler's
   * `PlaceholderUtils.PropertyPlaceholderResolver` logs.
   */
  const generatedFieldFor = (ownerFqn, name) => {
    if (!name) return null;
    for (const scope of [ownerFqn, ...enclosingChainOf(ownerFqn)]) {
      const hit = generatedFieldsOf.get(scope)?.get(name);
      if (hit) return { ...hit, declaredBy: scope };
    }
    return null;
  };

  // EVERY TYPE THIS PROJECT EVER IMPORTS BY NAME. A single-type import is a
  // line somebody wrote, so it is the one piece of evidence in the fact set
  // that says a given package really holds a given type — which is what
  // decides between two wildcards that both offer a name (see
  // `placeByWildcard`).
  const importedFqns = new Set();
  for (const byName of importsByOwner.values()) for (const fqn of byName.values()) importedFqns.add(fqn);

  // The (package, simple) pairs a wildcard of THIS PROJECT names and no
  // analyzed root holds. Counted in full, listed in part.
  const outsideRoots = new Map(); // "pkg simple" -> {package, simple, calls}

  /**
   * WHERE A SIMPLE NAME NOTHING RESOLVED COULD HAVE COME FROM (RM35 §D).
   *
   * Only on-demand imports are left to ask: a single import, the same package,
   * and an analyzed type in a wildcard package have all already been tried. So
   * the question is which `import x.y.*` line put this name in the file, and
   * there are three answers worth telling apart:
   *
   *   'outside-roots'  a wildcard names a package of THIS PROJECT and no root
   *                    this run analyzed holds the type. The type EXISTS; the
   *                    run did not read the module it is in. This is the only
   *                    one a reader can act on.
   *   'jdk'            a wildcard names a `java.*`, `javax.*` or `jakarta.*`
   *                    package. The JDK is a closed world this lane never
   *                    reads, so the call LEAVES the project, and an edge that
   *                    says so is worth more than a count that says the
   *                    analysis failed. Which of several JDK packages holds it
   *                    is not always knowable — `java.util.*` and
   *                    `java.util.concurrent.*` in one file both offer
   *                    `ThreadPoolExecutor` — so the lowest package name is
   *                    taken and EVERY candidate rides on the evidence.
   *   'unknown'        anything else: a third-party type behind a wildcard, a
   *                    constant somebody static-imported, a field a code
   *                    generator adds after parsing.
   *
   * WHICH WILDCARD, WHEN SEVERAL COULD ANSWER. A file that carries both
   * `org.jeecg.common.util.*` and `java.util.*` offers two homes for every
   * unplaced name, and picking by category alone is wrong in one direction or
   * the other: `RedisUtil` is jeecg's and `Arrays` is the JDK's. Measured on
   * the corpus, taking the project wildcard first misfiled 123 JDK types as a
   * module nobody passed, and taking the JDK wildcard first invented 83
   * `java.util.RedisUtil`s — a package that has no such type, which this engine
   * does not do.
   *
   * So the file is not asked; the PROJECT is. Somewhere in a tree this size,
   * some other file writes the single-type import, and that line is evidence
   * rather than a guess: `import org.jeecg.common.util.RedisUtil;` proves that
   * package holds that type, and `import java.util.Arrays;` proves the other
   * one does. A candidate package WITNESSED by a real import line anywhere in
   * this project wins; only when nothing witnesses the name does the category
   * order (project, then JDK) decide.
   *
   * Names not spelled like a type are never placed: `ADD_STRING.equals(x)`
   * under `import java.util.*` is a static-imported constant, and
   * `java.util.ADD_STRING` is a type that does not exist.
   *
   * @returns {{kind:'outside-roots', package:string}
   *          |{kind:'jdk', fqn:string, packages:string[]}
   *          |{kind:'unknown'}}
   */
  const placeByWildcard = (ownerFqn, simple) => {
    if (!looksLikeTypeName(simple)) return UNKNOWN_PLACE;
    const wildcards = wildcardsByOwner.get(topLevelOf(ownerFqn)) ?? [];
    const isProject = (pkg) => packagePrefixes.length > 0 && isProjectPackage(pkg, packagePrefixes)
      && !types.has(`${pkg}.${simple}`);
    const isJdk = (pkg) => JDK_WILDCARD_PACKAGES.includes(pkg.split('.')[0]);
    const jdk = wildcards.filter(isJdk).sort(cmp);
    const asJdk = () => (jdk.length > 0 ? { kind: 'jdk', fqn: `${jdk[0]}.${simple}`, packages: jdk } : UNKNOWN_PLACE);
    // The witness first: an import line somewhere in this project that names
    // exactly this package and this type.
    for (const pkg of wildcards) {
      if (!importedFqns.has(`${pkg}.${simple}`)) continue;
      if (isJdk(pkg)) return { kind: 'jdk', fqn: `${pkg}.${simple}`, packages: [pkg] };
      if (isProject(pkg)) return { kind: 'outside-roots', package: pkg };
      return UNKNOWN_PLACE;
    }
    for (const pkg of wildcards) if (isProject(pkg)) return { kind: 'outside-roots', package: pkg };
    return asJdk();
  };

  /**
   * WHY this name did not resolve, in the vocabulary of UNRESOLVED_REASONS —
   * and, for the one reason somebody can act on, WHICH package and name.
   */
  const reasonFor = (place, simple) => {
    if (place.kind !== 'outside-roots') return 'unknown';
    const key = `${place.package} ${simple}`;
    const seen = outsideRoots.get(key);
    if (seen) seen.calls += 1;
    else outsideRoots.set(key, { package: place.package, simple, calls: 1 });
    return 'project-type-outside-roots';
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
  /**
   * A `super.m()` CALL SITE RESOLVES THE ANCESTOR'S TYPE PARAMETERS TOO (RM37).
   *
   * `super.exportXls(request, obj, Obj.class, "…")` written in a controller runs
   * the generic base's body RIGHT HERE, as this subclass, so the
   * `service.list(…)` inside it means this subclass's service and no other. The
   * `super-enclosing` edge alone stops at the base method, where the receiver is
   * still a type parameter with 29 possible bindings; this carries the caller's
   * substitution into that body and emits the one edge it determines.
   *
   * It is deliberately driven by the CALL SITE and not by the method's name: on
   * jeecg-boot, `JeecgDemoController#exportXls` calls `super.exportXlsSheet(…)`,
   * so the body that runs is a different method of the base, and only the call
   * site says which.
   *
   * Emitted at most once per (caller member, base member): a method that writes
   * the same `super.m()` twice runs one body, not two.
   */
  const superBodyBound = new Set();
  const bindSuperBody = (fromMember, callerFqn, baseFqn, method) => {
    const key = `${fromMember} ${baseFqn}#${method}`;
    if (superBodyBound.has(key)) return;
    superBodyBound.add(key);
    const body = callsFrom.get(`${baseFqn}#${method}`) ?? [];
    if (body.length === 0) return;
    const params = types.get(baseFqn)?.typeParams ?? [];
    if (params.length === 0) return;
    const at = extendsChainWithBindings(callerFqn, types, superOf).find((e) => e.fqn === baseFqn);
    if (!at) return;
    for (const x of body) {
      if (!x.toTypeSimple || !params.includes(x.toTypeSimple)) continue;
      const b = at.subst.get(x.toTypeSimple);
      if (!b) continue;
      const targetFqn = resolveType(b.ctx, b.simple);
      if (!targetFqn) continue;
      emitCall(fromMember, targetFqn, x.method, 'type-param-binding', {
        receiver: x.toTypeSimple, binding: b.simple, boundThrough: b.ctx,
        inheritedFrom: `${baseFqn}#${method}`, viaSuper: true,
      });
    }
  };
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
      // The last type the walk actually READ, so a walk that ran out can say
      // whether it ran out at a base it could name or at one it could not.
      let last = ownerFqn;
      while (cur && types.has(cur) && hops < SUPER_CHAIN_LIMIT) {
        if (declares(cur, c.method, null)) { target = cur; break; }
        last = cur;
        cur = superOf.get(cur) ?? null;
        hops += 1;
      }
      if (target) {
        emitCall(c.from, target, c.method, 'super-enclosing', { receiver: 'super', declaredBy: target, hops });
        // …and the body that runs there runs AS THIS CLASS, so a receiver typed
        // by one of the base's type parameters is resolved here, where the
        // binding is known, instead of being left on the shared symbol.
        bindSuperBody(c.from, ownerFqn, target, c.method);
        continue;
      }
      // THE CHAIN RAN OFF THE EDGE OF THE TREE (RM35 §E). `cur` is a base class
      // an import NAMES and this lane never parsed — MyBatis-Plus's
      // `ServiceImpl`, `java.lang.Thread`. `super.list(…)` really does run that
      // class's method, so the edge is made and lands outside the project,
      // which is exactly where the chain ends at run time. Reporting it as
      // unresolved said the analysis had failed when it had not.
      if (cur) {
        emitCall(c.from, cur, c.method, 'super-enclosing', {
          receiver: 'super', declaredBy: cur, hops, outsideRoots: true,
        });
        continue;
      }
      // …or the base cannot be named at all: the last class the lane read has
      // an `extends` clause whose simple name resolves to nothing here.
      countUnresolved('super-enclosing', types.get(last)?.extendsSimple ? 'superclass-outside-roots' : 'unknown');
      continue;
    }

    // A RECEIVER THE FILE NEVER DECLARES. The worker recorded the name and no
    // type, because in a parse-only per-file worker the declaration is simply
    // not there to read: `mybatisMapper.selectById(id)` inside `XDaoImpl` names
    // a field of `BaseDao`, in another file. Here the whole tree is in hand.
    if (rule === 'inherited-field') {
      stats.identifierReceivers.total += 1;
      // A FIELD AN ANNOTATION PROCESSOR ADDS (RM35 §C). Checked FIRST, because
      // Lombok's `log` is the class's OWN field and a class's own field shadows
      // anything an ancestor declares — which is also Java's rule.
      const gen = generatedFieldFor(ownerFqn, c.receiver);
      if (gen) {
        stats.identifierReceivers.generatedField += 1;
        emitCall(c.from, gen.typeFqn, c.method, 'generated-field', {
          receiver: c.receiver, declaredBy: gen.declaredBy, annotation: gen.annotation,
          // @CustomLog's logger type is declared in `lombok.config`, which is
          // not source this lane reads: the edge names the annotation instead,
          // and says so rather than passing a placeholder off as a reading.
          ...(gen.annotation === 'CustomLog' ? { loggerTypeDeclaredOutsideSource: true } : {}),
        });
        continue;
      }
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
      // …and an on-demand import the lane will never read answers the same
      // question: `Arrays.asList(…)` under `import java.util.*` names
      // `java.util.Arrays`, a TYPE, so this is a static call like any other.
      const place = found ? UNKNOWN_PLACE : placeByWildcard(ownerFqn, c.receiver);
      if (!found && (resolveType(ownerFqn, c.receiver) || place.kind === 'jdk')) {
        stats.identifierReceivers.staticReceiver += 1;
        continue;
      }
      stats.identifierReceivers.unresolved += 1;
      const reason = reasonFor(place, c.receiver);
      countUnresolved('inherited-field', reason);
      if (stats.unresolvedIdentifiers.length < IDENTIFIER_SAMPLE_LIMIT) {
        stats.unresolvedIdentifiers.push({
          from: c.from, receiver: c.receiver, method: c.method, reason,
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
    //
    // THE SMEAR THIS BLOCK USED TO MAKE (RM37). The bodies of generic base
    // methods are read ONCE, so collecting every subclass's binding at the call
    // site put all of them on the BASE's symbol:
    // `JeecgController#exportXls` reached 27 services at once, and every one of
    // jeecg-boot's 29 export endpoints, which each carry a `super-enclosing`
    // edge to that one method, read as touching every sibling module's tables.
    // Measured: 9748 of 25376 endpoint→column pairs on jeecg-boot were that one
    // shortcut, and no other project in the corpus lost a single pair to it,
    // because nothing else routes an endpoint THROUGH a shared generic body.
    //
    // The bindings were never in doubt — RM35 already reads them, in the frame
    // of the subclass that wrote them. So the body is resolved once PER
    // INHERITING SUBCLASS and the edge leaves THAT subclass's copy of the
    // method: `AiragMcpController#exportXls -> IAiragMcpService#list`, one edge
    // each, and no controller reaches another's service. Nothing is claimed
    // that was not claimed before. The same set of targets is attached where
    // each of them is true, instead of being pooled on the symbol they share.
    const tpIndex = (types.get(ownerFqn)?.typeParams ?? []).indexOf(c.toTypeSimple);
    if (tpIndex >= 0 && c.toTypeSimple) {
      const member = c.from.slice(c.from.lastIndexOf('#') + 1);
      const inheritors = inheritorsFor(ownerFqn, c.toTypeSimple);
      let resolved = 0;
      for (const sub of [...inheritors.keys()].sort(cmp)) {
        const b = inheritors.get(sub);
        const targetFqn = resolveType(b.ctx, b.simple);
        if (!targetFqn) continue;
        resolved += 1;
        // A CONSTRUCTOR is neither inherited nor overridden: every subclass's
        // own runs the base's, whether or not it writes `super(…)`. So the
        // subclass's own constructor is where the base constructor's body is.
        if (member === '<init>') {
          emitCall(`${sub}#${member}`, targetFqn, c.method, 'type-param-binding', {
            receiver: c.toTypeSimple, binding: b.simple, boundThrough: b.ctx, inheritedFrom: c.from,
          });
          continue;
        }
        // A subclass that DECLARES this method has a body of its own, and
        // whether the ancestor's also runs is decided by whether it writes
        // `super.m(…)` — which the `super-enclosing` rule reads at the call site
        // (`bindSuperBody` above), where it also knows which base method was
        // called. An override that does not call it is a different method, and
        // claiming the ancestor's call site for it would be inventing one.
        //
        // A subclass that only INHERITS it has no body of its own, so the
        // ancestor's IS what runs. That member is instantiated for this class by
        // RM20's synthesis, which resolves this very call in this very
        // substitution (`inherited-member-call`), so the edge is written there
        // rather than twice.
        if (!declares(sub, member, null)) queueIfInherited(sub, member);
      }
      if (resolved === 0) countUnresolved('type-param-unbound', 'type-param-unbound');
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
    if (!targetFqn) {
      // THE FIELD'S TYPE CAME IN THROUGH A JDK ON-DEMAND IMPORT (RM35 §D).
      // `Map<Integer, List<Integer>> ringData` under `import java.util.*` is
      // `java.util.Map`: the call leaves the project, and an edge that says so
      // is worth more than a count that says the analysis failed. The rule is
      // its own, because its failure mode is its own — the package is read off
      // an import and the type is assumed to exist in it.
      const place = placeByWildcard(ownerFqn, c.toTypeSimple);
      if (place.kind === 'jdk') {
        emitCall(c.from, place.fqn, c.method, 'wildcard-jdk', {
          receiver: c.toTypeSimple, spelling: c.via ?? null,
          // More than one JDK package could hold it: the edge names one and
          // lists them all rather than presenting a coin toss as a reading.
          ...(place.packages.length > 1 ? { wildcards: place.packages } : {}),
        });
        continue;
      }
      countUnresolved(rule, reasonFor(place, c.toTypeSimple));
      continue;
    }
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

  // The actionable reason, NAMED. Ordered by how much of the gap each one is,
  // then by name, so the list does not depend on the order the calls arrived.
  stats.typesOutsideRoots = [...outsideRoots.values()]
    .sort((a, b) => (b.calls - a.calls) || cmp(a.package, b.package) || cmp(a.simple, b.simple))
    .slice(0, TYPES_OUTSIDE_ROOTS_LISTED);

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
