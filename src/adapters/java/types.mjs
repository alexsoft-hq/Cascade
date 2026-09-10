// types.mjs — what the Java lane KNOWS ABOUT TYPES, before any edge is drawn.
//
// WHAT THIS MODULE OWNS. Everything that answers "what does this name mean?"
// without looking at a graph:
//   the fact index      every record the worker emitted, bucketed by kind, and
//                       the two look-up tables built from it (a member's line, a
//                       member's arities, the calls written inside one)
//   the type index      which types the lane saw, what each file imported, and
//                       the simple-name -> FQN resolver built from both
//   the hierarchy       who implements what, who extends what, and what a
//                       subclass binds its ancestor's type parameters to
//   the identity rules  a symbol id, an endpoint id, the owner of a member, the
//                       package of a type, the namespace of a statement key
//   the three closed worlds it can never read: `java.lang`'s implicit types, the
//                       field a Lombok annotation generates, and the JDK
//                       packages an on-demand import names
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the lane's statistics, or what any
// of this is going to be used for. Nothing here adds a node, counts anything or
// decides a grade — hand it the fact stream, get back what the source says.
//
// The JPA bridge (src/adapters/jpa_bridge.mjs) reads `buildTypeIndex` from here
// through java_bridge.mjs's re-export, so a simple name resolves through the
// SAME four rules, in the same order, wherever it is asked about. Two resolvers
// would eventually disagree, and then one graph would hold two opinions about
// what `Owner` means.

import { nodeId } from '../../core/graph.mjs';

/**
 * THE FACT STREAM, BUCKETED. One pass over the records, one list per kind, plus
 * the three tables every later step looks a member up in.
 *
 * It is one pass and not five because the stream is the biggest thing the lane
 * holds — jeecg-boot's is over a million records — and because a record that
 * belongs to no bucket must be IGNORED rather than dropped noisily: the schema
 * is additive, and a worker one version ahead emits kinds this reader has never
 * heard of.
 *
 * @param {object[]} javaFacts  parsed cascade:javafacts:1 records
 * @returns {{methods:object[], calls:object[], endpoints:object[],
 *            transactionals:object[], httpCallFacts:object[],
 *            fieldsByOwner:Map<string,Map<string,string|null>>,
 *            parseErrors:object[], parsedFiles:Set<string>,
 *            lineOfMember:Map<string,number>, aritiesOfMember:Map<string,Set<number>>,
 *            callsFrom:Map<string,object[]>}}
 */
export function indexJavaFacts(javaFacts) {
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
  // owner fqn -> (field name -> the bean name it is injected by). Separate from
  // the map above because it answers a different question and is almost always
  // empty: a field is named only where somebody wrote `@Resource(name = "…")`.
  const beanNamesByOwner = new Map();
  const parseErrors = [];                  // {file, line, message} — one per file that failed to parse
  const parsedFiles = new Set();           // every file any record came from

  for (const r of javaFacts) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.file === 'string' && r.file.length > 0) parsedFiles.add(r.file);
    switch (r.kind) {
      case 'method': methods.push({ fqn: r.fqn, owner: r.owner, line: r.line ?? null, paramCount: r.paramCount ?? null }); break;
      case 'call': calls.push({
        from: r.from,
        method: r.method,
        toTypeSimple: r.toTypeSimple,
        receiver: r.receiver ?? null,
        via: r.via ?? null,
        // The MyBatis statement id this call names, when it names one
        // (javafacts/11), what was written when the worker could not read one,
        // and where the call site is. Absent on every call that is not one of
        // the ten session methods.
        stmtId: typeof r.stmtId === 'string' ? r.stmtId : null,
        stmtIdFrom: typeof r.stmtIdFrom === 'string' ? r.stmtIdFrom : null,
        stmtArg: typeof r.stmtArg === 'string' ? r.stmtArg : null,
        // The iBATIS bare id (RM56): one word, no namespace. Kept apart from
        // `stmtId` because it is a weaker witness — it binds only when this
        // pack holds exactly one statement under that id.
        stmtIdBare: typeof r.stmtIdBare === 'string' ? r.stmtIdBare : null,
        line: Number.isInteger(r.line) ? r.line : null,
        file: typeof r.file === 'string' ? r.file : null,
      }); break;
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
        // …and the BEAN this field asks for by name, when it asks for one
        // (javafacts/11). Kept in a map of its own so `fieldsByOwner` stays what
        // every rule already reads it as: a name to a declared type.
        if (typeof r.beanName === 'string' && r.beanName !== '') {
          let b = beanNamesByOwner.get(r.owner);
          if (!b) { b = new Map(); beanNamesByOwner.set(r.owner, b); }
          if (!b.has(r.name)) b.set(r.name, r.beanName);
        }
        break;
      }
      case 'parse_error': parseErrors.push({ file: r.file, line: r.line ?? null, message: r.message ?? null }); break;
      // type/import are indexed by buildTypeIndex; header and unknown kinds: ignore (additive)
    }
  }

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
  // The calls written inside one member, in stream order: the inherited-member
  // rule reads an ancestor's body, and this is where a body is.
  const callsFrom = new Map(); // member fqn -> its call facts, in stream order
  for (const c of calls) {
    if (!c.from) continue;
    let list = callsFrom.get(c.from);
    if (!list) { list = []; callsFrom.set(c.from, list); }
    list.push(c);
  }

  return {
    methods, calls, endpoints, transactionals, httpCallFacts, fieldsByOwner, beanNamesByOwner,
    parseErrors, parsedFiles, lineOfMember, aritiesOfMember, callsFrom,
  };
}

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How far a `super.m()` walk climbs before giving up. A Java hierarchy is
 * acyclic, but a fact set assembled from shards need not be (two files can be
 * edited into a cycle), and a walk that hangs is worse than one that says it
 * stopped.
 */
export const SUPER_CHAIN_LIMIT = 32;

/** The empty enclosing chain of a top-level type, shared so it is never rebuilt. */
const EMPTY_CHAIN = Object.freeze([]);

/** "no on-demand import explains this name", shared so it is never rebuilt. */
export const UNKNOWN_PLACE = Object.freeze({ kind: 'unknown' });

/**
 * How many inheriting types one generic base's body is resolved for before the
 * downward walk gives up. A real hierarchy is far below it (jeecg-boot's widest
 * is 29 controllers on one base); the guard is against a fact set edited into a
 * cycle, for the same reason SUPER_CHAIN_LIMIT exists.
 */
const INHERITOR_WALK_LIMIT = 4096;

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
export const LOMBOK_LOG_FIELD = 'log';

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
export function memberToStatementKey(memberFqn) {
  const h = memberFqn.lastIndexOf('#');
  return h < 0 ? memberFqn : memberFqn.slice(0, h) + '.' + memberFqn.slice(h + 1);
}

export function ownerOf(memberFqn) {
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
 * The annotations that make a CLASS a Spring web controller. A type carrying one
 * of these owns the routes its methods declare; a mapping annotation anywhere
 * else has to be classified before it can be believed (see `classifyRouteHolder`).
 */
export const CONTROLLER_ANNOTATIONS = Object.freeze(['RestController', 'Controller']);

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

/** The package of a type FQN: everything before its simple name ('' for a default-package type). */
export function packageOfType(typeFqn) {
  const dot = typeFqn.lastIndexOf('.');
  return dot < 0 ? '' : typeFqn.slice(0, dot);
}

/** The MyBatis namespace a statement key belongs to ("ns.Mapper.select" → "ns.Mapper"). */
export function namespaceOfStatementKey(key) {
  const dot = key.lastIndexOf('.');
  return dot < 0 ? '' : key.slice(0, dot);
}

/**
 * One `type` record, as the index holds it. Every field is defended, because the
 * stream may come from a fact cache written by an older worker: a missing list
 * reads as empty rather than throwing halfway through building the index.
 *
 * `declaredMethodLines` is aligned index-for-index with `declaredMethods`
 * (javafacts/7), so a member a subclass only INHERITS can still be previewed at
 * the line that really declares it. `modelAttributeMethods` (javafacts/10) is
 * what Spring runs before each handler of a controller, which no line of source
 * calls, and `placeModelAttributeCalls` in calls.mjs is what draws that edge.
 * @param {object} r
 */
function indexedType(r) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    typeKind: r.typeKind,
    pkg: r.package ?? null,
    abstract: r.abstract === true,
    implementsSimple: list(r.implements),
    implementsArgs: list(r.implementsArgs),
    annotations: list(r.annotations),
    extendsSimple: r.extends ?? null,
    extendsArgs: list(r.extendsArgs),
    typeParams: list(r.typeParams),
    typeParamBounds: list(r.typeParamBounds),
    client: (r.client && typeof r.client === 'object') ? r.client : null,
    declaredMethods: list(r.declaredMethods),
    declaredMethodLines: list(r.declaredMethodLines),
    modelAttributeMethods: list(r.modelAttributeMethods),
    // The name Spring knows this class by, when its stereotype annotation gave
    // it one (javafacts/11). Null is not "no name": Spring then decapitalises
    // the simple name, and src/adapters/java/calls.mjs applies that rule where
    // it can also see whether two classes would claim the same one.
    beanName: typeof r.beanName === 'string' && r.beanName !== '' ? r.beanName : null,
    file: r.file ?? null,
  };
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
/**
 * THE ENCLOSING TYPES OF A NESTED TYPE, rebuilt from its own record.
 *
 * A nested type has no compilation unit of its own: the worker keys every import
 * and wildcard by the TOP-LEVEL type, because that is where the file's `import`
 * lines belong, and it stamps the FILE's package on every type it sees. So
 * `a.b.Outer.Inner` carries `pkg = "a.b"`, and everything after the package is
 * the nesting, `Outer.Inner`. That is all it takes to rebuild the scope chain,
 * which is why the worker needs no new record for this.
 *
 * Innermost first; the LAST entry is the top-level type, which is the key the
 * imports are under. EMPTY for a top-level type, so a caller can tell the two
 * apart without asking again.
 *
 * WHAT IT COST TO NOT HAVE THIS: every call inside one of litemall's 76
 * generated `…Example.GeneratedCriteria` classes looked up `List` under the key
 * `…Example.GeneratedCriteria`, where there are no imports at all, and 288 calls
 * came back unresolved that a top-level class in the same file resolves without
 * trouble.
 */
function makeEnclosingChainOf(types) {
  return (fqn) => {
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
}

/**
 * Resolve a simple type name seen inside `ownerFqn` to a fully-qualified type,
 * in the order the LANGUAGE resolves it, which is also decreasing certainty:
 *   1. a member type in scope: this type's own nested types, then each
 *      enclosing type's                                (exact)
 *   2. an explicit single-type import of the FILE      (exact)
 *   3. the same package, if that type is known         (exact)
 *   4. an on-demand (wildcard) import package that contains a known type
 *   5. java.lang, which every compilation unit imports on demand
 *   6. a globally UNIQUE app type with that simple name (sound: no ambiguity)
 *
 * None is compiler-verified, so callers still grade the resulting edge
 * SOUND_SET. Rules 1, 3, 4 and 6 yield a type the lane really parsed; rules 2
 * and 5 can yield one it never saw (an imported library class, a JDK class),
 * which is how a call OUT of the project gets an edge that says so instead of
 * being reported as a failure. Returns null when none of the six applies: we
 * never invent a package.
 */
function makeResolveType({ types, importsByOwner, wildcardsByOwner, simpleIndex, enclosingChainOf }) {
  return (ownerFqn, simple) => {
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
}

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
      types.set(r.fqn, indexedType(r));
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

  const enclosingChainOf = makeEnclosingChainOf(types);
  /** The top-level type a (possibly nested) type belongs to: the imports' key. */
  const topLevelOf = (fqn) => {
    const chain = enclosingChainOf(fqn);
    return chain.length > 0 ? chain[chain.length - 1] : fqn;
  };
  const resolveType = makeResolveType({
    types, importsByOwner, wildcardsByOwner, simpleIndex, enclosingChainOf,
  });

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
