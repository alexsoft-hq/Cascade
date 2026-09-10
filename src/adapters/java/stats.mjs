// stats.mjs — what the Java lane REPORTS about its own run, and the censuses
// behind three of the numbers.
//
// WHAT THIS MODULE OWNS: the shape of the statistics object, every counter in
// it, the comment beside each counter saying why that number is worth having,
// and the three things the lane counts that are not edges — which FQNs are
// declared twice, which types the profile calls machine-written, and the
// vocabulary of reasons a call is still unresolved. `cascade analyze` prints
// these lines, `pack.meta.laneStats.java` carries them, and
// `src/core/lanes.mjs` decides from them whether an axis is shipped, degraded or
// absent. So this is the lane's own account of what it could and could not see,
// and every field here is a promise to a reader.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the fact stream, and the other
// modules in this directory. It builds an object of zeroes and hands it over;
// the steps fill it in as they go. It imports nothing.


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
 * How many unexplained `identifier` receivers the lane stats list by name. The
 * COUNT is always exact; the list is a sample, so a project with thousands of
 * them does not put thousands of strings in every pack.
 */
export const IDENTIFIER_SAMPLE_LIMIT = 20;

/**
 * How many (package, simple name) pairs the "outside the analyzed roots" list
 * NAMES. The count is always exact; naming a few is what turns it into advice.
 */
export const TYPES_OUTSIDE_ROOTS_LISTED = 25;


/**
 * A fresh statistics object, every counter at zero.
 *
 * It is one literal rather than a dozen, because the caller returns it whole and
 * a field that exists only after some step ran would read as "we did not look"
 * where the truth is "there were none". The three arguments are the only numbers
 * that are known before any edge is drawn.
 *
 * @param {{generatedSources:{annotations?:string[], pathGlobs?:string[]},
 *          parseErrors:number, parsedFiles:number}} seed
 * @returns {object}
 */
/**
 * WHICH RESOLUTION RULE PRODUCED HOW MANY EDGES, WHICH FAILED HOW OFTEN, AND WHY.
 *
 * Without the first split "1568 calls, 8617 unresolved" is a number nobody can
 * act on: the two halves come from rules with very different reach. The third
 * map is the half a reader can act on. The rule split names the piece of THIS
 * ENGINE that failed; the reason names what was MISSING from the run. One of the
 * four reasons is a thing somebody can fix in a minute (a module that was never
 * passed as a source root) and the other three are boundaries of what a
 * parse-only lane can see, and a single total buries the difference.
 */
function emptyCallCensus() {
  return {
    callsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-binding': 0, 'interface-dispatch': 0,
      'inherited-field': 0, 'interface-dispatch-inherited': 0, 'inherited-member-call': 0,
      'generated-field': 0, 'wildcard-jdk': 0, 'spring-model-attribute': 0,
    },
    unresolvedCallsByRule: {
      'field-receiver': 0, 'this-field': 0, 'unqualified-enclosing': 0,
      'super-enclosing': 0, 'type-param-unbound': 0, 'inherited-field': 0,
    },
    unresolvedCallsByReason: Object.fromEntries(UNRESOLVED_REASONS.map((r) => [r, 0])),
  };
}

export function emptyJavaStats({ generatedSources, parseErrors, parsedFiles }) {
  return {
    endpoints: 0, handles: 0, calls: 0, dispatch: 0, implementsStmt: 0,
    unresolvedCalls: 0, externalCalls: 0, externalSymbols: 0,
    mapperMethods: 0, mapperMethodsBound: 0, unboundMapperMethods: 0, transactional: 0,
    // MEASURED FROM THE FACT SET, not from one worker invocation (RM9): the
    // worker emits a per-file `parse_error` record that rides in that file's
    // shard, so an incremental run over a subset and a cold run over the whole
    // tree report the same two numbers — which is what lets the calibration gate
    // compare them at all (src/core/calibration.mjs, `javaParseErrors`).
    parseErrors,
    parsedFiles,
    ...emptyCallCensus(),
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
    // The calls SPRING makes and no line of source writes: a `@ModelAttribute`
    // method runs before every handler of its controller. `methods` and `edges`
    // are what the rule followed; the other three are what it deliberately did
    // not, counted rather than guessed at (see `placeModelAttributeCalls`).
    modelAttribute: { methods: 0, edges: 0, onAdvice: 0, onSuperclass: 0, inheritedHandlers: 0 },
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
 * Which types this fact set's profile classifies as generated.
 * @param {Map<string,object>} types  from buildTypeIndex
 * @param {{annotations?:string[], pathGlobs?:string[]}} declared
 * @returns {{fqns:Set<string>, byAnnotation:number, byPath:number}}
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
      // NUL as a SENTINEL, on purpose: `**` is replaced by a byte no path can
      // contain, so the `*` rule below cannot eat half of it, and the sentinel is
      // then replaced by what `**` means. A control character in a regular
      // expression is a mistake everywhere else, which is why the rule is on.
      // eslint-disable-next-line no-control-regex
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`);
  });
  return (file) => typeof file === 'string' && res.some((re) => re.test(file));
}

export function classifyGeneratedTypes(types, declared = {}) {
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

/**
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
export function duplicateFqnCensus(filesByFqn, typesByFile, endpoints) {
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
