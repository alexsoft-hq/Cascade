// calls.mjs — `symbol --MAY_CALL--> symbol`, and every rule that draws one.
//
// WHAT THIS MODULE OWNS. The whole of what a Java call site becomes:
//   the rules          a field receiver through its declared type, an unqualified
//                      call through the enclosing type, `super.m()` up the
//                      `extends` chain, a receiver typed by a type PARAMETER
//                      resolved once per subclass that binds it, a receiver the
//                      file never declares looked for in an ancestor's fields,
//                      the field a Lombok annotation generates, and a type an
//                      on-demand import of the JDK names
//   dispatch           interface -> implementor, as a class-hierarchy
//                      over-approximation, and the member a class only INHERITS
//                      instantiated so the edge lands on something with a body
//   the failures       why a call is still unresolved, counted by RULE (what
//                      this engine could not do) and by REASON (what the run was
//                      missing), with the one reason a reader can act on NAMED
//
// WHAT IT MUST NEVER KNOW ABOUT: what a route is, what a mapper is, or how a
// statistic is printed. It is handed the fact index, the type index and the one
// primitive that writes a symbol node, and it writes calls.
//
// EVERY EDGE A RULE RESOLVES IS SOUND_SET AND NOT ONE IS EXACT: calls are
// resolved from the parse tree WITHOUT compiler binding or overload resolution,
// so the target set is a sound over-approximation and never a proof. The rule on
// each edge says which of the eight it rested on, because they fail in different
// ways.
//
// The one exception is the call nobody wrote: Spring runs a controller's
// `@ModelAttribute` methods before each of its handlers, and that edge resolves
// nothing at all. It is EXACT because the annotation and the framework's own
// contract state it (`placeModelAttributeCalls`, RM54).

import {
  cmp, extendsChainWithBindings, findDeclaringAncestor, inheritorsOfTypeParam,
  isProjectPackage, looksLikeTypeName, ownerOf, resolveInheritedField,
  CONTROLLER_ANNOTATIONS, JDK_WILDCARD_PACKAGES, LOMBOK_LOGGERS, LOMBOK_LOG_FIELD,
  SUPER_CHAIN_LIMIT, UNKNOWN_PLACE,
} from './types.mjs';
import { IDENTIFIER_SAMPLE_LIMIT, TYPES_OUTSIDE_ROOTS_LISTED, UNRESOLVED_REASONS } from './stats.mjs';

/**
 * How many dispatch/instantiation rounds run before the loop gives up. Both of
 * its worklists are monotone over a finite set, so it converges — the guard is
 * against a fact set assembled from shards that has been edited into a cycle.
 */
const INHERITED_FIXPOINT_LIMIT = 64;

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
  'spring-model-attribute': 'Spring invokes a @ModelAttribute method of the controller before each of its handlers; the framework, not a line of source, makes the call',
  'spring-bean-name': 'the field is injected BY NAME (`@Resource(name = "x")`, `@Qualifier("x")`), and exactly one class in this pack answers to that bean name: it declares it in its own stereotype annotation, or it is the only stereotype class whose decapitalised name is it, which is the name Spring gives a class that declares none. So the container puts THAT object in this field, and the call runs its method. Still SOUND_SET and not EXACT: this reads the name a field asks for and the names classes declare, without the container that would settle a `@Primary`, a profile, or a bean an XML or a @Bean method declares outside these rules',
});

/**
 * The annotations that make a class a Spring bean with a NAME OF ITS OWN.
 *
 * A class carrying one of these and no explicit value gets the name Spring
 * gives it: its simple name with the first letter lowered. That default is
 * applied HERE and not in the worker, because it is only usable once you can
 * see whether some OTHER class in the tree would claim the same name.
 */
export const BEAN_STEREOTYPES = Object.freeze([
  'Service', 'Repository', 'Component', 'Controller', 'RestController', 'Named',
]);

/** The annotations that make a class a Spring `@ControllerAdvice`. */
export const CONTROLLER_ADVICE_ANNOTATIONS = Object.freeze(['ControllerAdvice', 'RestControllerAdvice']);

/**
 * THE TWO THINGS EVERY RULE BELOW GOES THROUGH: one that writes an edge and one
 * that counts a failure. Written once because the type-parameter rule emits
 * SEVERAL edges for one call site, and because a rule that counted its own
 * failures would eventually count them differently from its neighbour.
 */
export function makeEmitter(ctx) {
  const { g, stats, types, ensureSymbol, isExternalType } = ctx;
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
  return { emitCall, countUnresolved, calledIfaceMethods };
}


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
export function makeGeneratedFields(ctx) {
  const { types, fieldsByOwner, enclosingChainOf } = ctx;
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
  return generatedFieldFor;
}


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

/**
 * The two closures that rule needs, and the census of the one answer a reader
 * can act on, built over the imports this project really writes.
 */
export function makeWildcardPlacer(ctx) {
  const { types, importsByOwner, wildcardsByOwner, topLevelOf, packagePrefixes } = ctx;
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
  return { placeByWildcard, reasonFor, outsideRoots };
}


// ---- members a class only INHERITS (RM20 §2) -------------------------------
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
function bindSuperBodyAtCallSite(ctx, cw, state, fromMember, callerFqn, baseFqn, method) {
  const { types, superOf, resolveType, callsFrom } = ctx;
  const { emitCall } = cw;
  const { superBodyBound } = state;
  {
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
  }
}

/**
 * ONE MEMBER A CLASS ONLY INHERITS, made real for that class: the ancestor's
 * file and line, so a reader opens the code that runs, and the ancestor's calls
 * carried over IN THIS SUBCLASS'S SUBSTITUTION.
 */
function instantiateInheritedMember(ctx, cw, state, { classFqn, method, anc }) {
  const {
    g, stats, types, superOf, declares, resolveType, callsFrom, lineOfMember,
    declaredLineOf, fieldsByOwner, ensureSymbol,
  } = ctx;
  const { emitCall } = cw;
  const { synthesizedMembers, queueIfInherited } = state;
  {
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
  }
}

/**
 * The three things the inheritance rules share: what has already been bound,
 * what is still queued, and what has already been synthesized. Held in one
 * `state` object rather than in three closures, so the two functions above can
 * be read on their own.
 */
export function makeInheritance(ctx, cw) {
  const { types, superOf, declares } = ctx;
  const state = {
    superBodyBound: new Set(),
    pendingInherited: [],
    synthesizedMembers: new Set(),
  };
  /** Queue `classFqn#method` when the class does not declare it but an ancestor does. */
  state.queueIfInherited = (classFqn, method) => {
    if (!types.has(classFqn) || declares(classFqn, method, null)) return;
    if (state.synthesizedMembers.has(`${classFqn}#${method}`)) return;
    const anc = findDeclaringAncestor(classFqn, method, null, { types, superOf, declares });
    if (anc) state.pendingInherited.push({ classFqn, method, anc });
  };
  return {
    bindSuperBody: (from, caller, base, method) => bindSuperBodyAtCallSite(ctx, cw, state, from, caller, base, method),
    queueIfInherited: state.queueIfInherited,
    instantiateInherited: (job) => instantiateInheritedMember(ctx, cw, state, job),
    pendingInherited: state.pendingInherited,
  };
}


/**
 * Who inherits a generic base's body, and what each of them binds one of its
 * parameters to. Asked once per (base, parameter) rather than once per call
 * site: a base method with three type-parameter calls asks the same question
 * three times, and the answer is a property of the hierarchy, not of the call.
 */
export function makeInheritorsFor(ctx) {
  const { types, superOf, subclassesOf, bindingsOf } = ctx;
  const inheritorCache = new Map();
  return (baseFqn, paramSimple) => {
    const key = `${baseFqn} ${paramSimple}`;
    let hit = inheritorCache.get(key);
    if (!hit) {
      hit = inheritorsOfTypeParam(baseFqn, paramSimple, { types, superOf, subclassesOf, bindingsOf });
      inheritorCache.set(key, hit);
    }
    return hit;
  };
}


/**
 * `super.m()` — walk the extends chain to the FIRST ancestor that declares `m`.
 * Returns true when this rule owned the call site.
 */
function resolveSuperCall(ctx, cw, c, rule, ownerFqn) {
  const { types, superOf, declares } = ctx;
  const { emitCall, countUnresolved, bindSuperBody } = cw;
  if (rule !== 'super-enclosing') return false;
  // `super.m()` — walk the extends chain to the FIRST ancestor that declares
  // `m`. Stopping at the immediate superclass would point the edge at a method
  // that type does not have, and the chain would die on a symbol with no body.
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
    return true;
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
    return true;
  }
  // …or the base cannot be named at all: the last class the lane read has
  // an `extends` clause whose simple name resolves to nothing here.
  countUnresolved('super-enclosing', types.get(last)?.extendsSimple ? 'superclass-outside-roots' : 'unknown');
  return true;
}


// ---- the bean a field asks for BY NAME (RM55) -------------------------------
//
// THE GAP THIS CLOSES. `@Resource(name = "EgovCmmUseService")` on a field typed
// by the INTERFACE is how every eGovFrame class gets its collaborator — 909
// fields in the common components, 145 in the enterprise template. The declared
// type is all the dispatch rule can see, so a call through such a field reaches
// every implementor of that interface; the name in the annotation says which
// object is really there, and it is written one line above the field.
//
// IT DOES NOT MAKE THE EDGE EXACT, and must not (policy I-1: an interface
// dispatch is never a proof). What it does is make the CANDIDATE SET one, name
// the bean in the evidence, and say which of the two ways the name was matched.
// A name no class in this pack answers to, or one that two answer to, changes
// nothing at all and is counted.

/**
 * The bean names this pack declares, and the one rule that reads them.
 * @returns {{beanNameOfField:(ownerFqn:string, field:string)=>(string|null),
 *            narrowByBeanName:(ifaceFqn:string, beanName:string)=>({impl:string, from:string}|null)}}
 */
export function makeBeanNames(ctx) {
  const { types, stats, implementorsOf, beanNamesByOwner, transactionals } = ctx;
  // A TRANSACTION BOUNDARY DECLARED ON THE INTERFACE keeps its hop. mall writes
  // `@Transactional` on the service INTERFACE's method declaration — there is no
  // body there, and the annotation applies to whatever implements it — so the
  // engine marks that member and computes the transaction's footprint by walking
  // FORWARD from it. Route the caller past that member and the boundary is still
  // on the graph with nothing under it. Narrowing buys precision; it must not buy
  // it by dropping a transaction.
  const boundaries = new Set((transactionals ?? []).map((t) => t.method).filter((m) => typeof m === 'string'));
  const declared = new Map(); // the name a class WROTE -> the classes that wrote it
  const byDefault = new Map(); // the name Spring would give it -> the stereotype classes
  const add = (map, name, fqn) => {
    if (!name) return;
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(fqn);
  };
  for (const [fqn, t] of types) {
    const simple = fqn.slice(Math.max(fqn.lastIndexOf('.'), fqn.lastIndexOf('$')) + 1);
    if (t.beanName) add(declared, t.beanName, fqn);
    if ((t.annotations ?? []).some((a) => BEAN_STEREOTYPES.includes(a))) {
      add(byDefault, simple.charAt(0).toLowerCase() + simple.slice(1), fqn);
    }
  }
  const beanNameOfField = (ownerFqn, field) => (field ? (beanNamesByOwner.get(ownerFqn)?.get(field) ?? null) : null);
  const narrowByBeanName = (ifaceFqn, beanName, method) => {
    const impls = implementorsOf.get(ifaceFqn);
    if (!impls || impls.size === 0) { stats.beanNames.noImplementor += 1; return null; }
    if (boundaries.has(`${ifaceFqn}#${method}`)) { stats.beanNames.transactionBoundary += 1; return null; }
    // The name a class WROTE outranks the name Spring would have given it: one
    // is a declaration, the other is a convention this rule applied.
    for (const [map, from] of [[declared, 'declared'], [byDefault, 'default-name']]) {
      const named = map.get(beanName);
      if (!named) continue;
      const hits = [...named].filter((fqn) => impls.has(fqn)).sort(cmp);
      if (hits.length === 1) return { impl: hits[0], from };
      if (hits.length > 1) { stats.beanNames.ambiguousName += 1; return null; }
      stats.beanNames.notAnImplementor += 1;
      return null;
    }
    stats.beanNames.unknownName += 1;
    return null;
  };
  return { beanNameOfField, narrowByBeanName };
}

/**
 * The one edge the bean name settles, or null when it settles nothing.
 * Returns the target the call really reaches, so both call rules read it the
 * same way.
 */
function beanNarrowedTarget(ctx, cw, { fieldOwnerFqn, field, targetFqn, method }) {
  const { types } = ctx;
  const { beanNameOfField, narrowByBeanName } = cw;
  const beanName = beanNameOfField(fieldOwnerFqn, field);
  if (!beanName) return null;
  ctx.stats.beanNames.sites += 1;
  // Only an INTERFACE has a dispatch to narrow. A field already typed by a
  // concrete class names one object whatever the annotation says — and a field
  // typed by something this run never PARSED is a third case, counted apart:
  // saying "not an interface" about a type nobody read would be a claim.
  const declared = types.get(targetFqn);
  if (!declared) { ctx.stats.beanNames.typeNotRead += 1; return null; }
  if (declared.typeKind !== 'interface') { ctx.stats.beanNames.notAnInterface += 1; return null; }
  const hit = narrowByBeanName(targetFqn, beanName, method);
  if (!hit) return null;
  ctx.stats.beanNames.narrowed += 1;
  return { ...hit, beanName };
}

/**
 * The narrowed edge, written where the bean name settles the dispatch.
 * @returns {boolean} true when the edge was written and the caller is done
 */
function emitBeanNarrowed(ctx, cw, c, { fieldOwnerFqn, targetFqn, receiver }) {
  const narrowed = beanNarrowedTarget(ctx, cw, {
    fieldOwnerFqn, field: c.receiver, targetFqn, method: c.method,
  });
  if (!narrowed) return false;
  cw.emitCall(c.from, narrowed.impl, c.method, 'spring-bean-name', {
    receiver, bean: narrowed.beanName, iface: targetFqn,
    nameFrom: narrowed.from, candidateCount: 1,
    ...(fieldOwnerFqn === ownerOf(c.from) ? {} : { declaredBy: fieldOwnerFqn }),
  });
  // The narrowed class may only INHERIT the method, exactly as a dispatched
  // implementor may, so the same instantiation applies.
  cw.queueIfInherited(narrowed.impl, c.method);
  return true;
}

/**
 * A RECEIVER THE FILE NEVER DECLARES. Returns true when this rule owned the call
 * site.
 */
function resolveInheritedFieldCall(ctx, cw, c, rule, ownerFqn) {
  const { types, superOf, fieldsByOwner, resolveType, stats } = ctx;
  const { emitCall, countUnresolved, generatedFieldFor, placeByWildcard, reasonFor } = cw;
  if (rule !== 'inherited-field') return false;
  // A RECEIVER THE FILE NEVER DECLARES. The worker recorded the name and no
  // type, because in a parse-only per-file worker the declaration is simply
  // not there to read: `mybatisMapper.selectById(id)` inside `XDaoImpl` names
  // a field of `BaseDao`, in another file. Here the whole tree is in hand.
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
    return true;
  }
  const found = resolveInheritedField(ownerFqn, c.receiver, { types, superOf, fieldsByOwner, resolveType });
  if (found && found.typeFqn) {
    stats.identifierReceivers.inheritedField += 1;
    // …and an ancestor's field is injected by name like any other (RM55).
    if (emitBeanNarrowed(ctx, cw, c, { fieldOwnerFqn: found.declaredBy, targetFqn: found.typeFqn, receiver: c.receiver })) return true;
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
    return true;
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
    return true;
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
  return true;
}


/**
 * A receiver whose declared type is a TYPE PARAMETER of the enclosing type.
 * Returns true when this rule owned the call site.
 */
function resolveTypeParamCall(ctx, cw, c, rule, ownerFqn) {
  const { types, resolveType, declares } = ctx;
  const { emitCall, countUnresolved, queueIfInherited, inheritorsFor } = cw;
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
    return true;
  }
  return false;
}


/** Every other spelling: the target type is named, or it is not. */
function resolvePlainCall(ctx, cw, c, rule, ownerFqn) {
  const { types, resolveType } = ctx;
  const { emitCall, countUnresolved, placeByWildcard, reasonFor, queueIfInherited } = cw;
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
      return;
    }
    countUnresolved(rule, reasonFor(place, c.toTypeSimple));
    return;
  }
  // THE BEAN THIS FIELD ASKS FOR BY NAME (RM55). `@Resource(name = "x")` on a
  // field typed by an interface says which of that interface's implementors is
  // really in it, so the call site reaches ONE class instead of all of them.
  if ((rule === 'field-receiver' || rule === 'this-field')
    && emitBeanNarrowed(ctx, cw, c, { fieldOwnerFqn: ownerFqn, targetFqn, receiver: c.toTypeSimple })) return;
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


/**
 * THE CALL SITES, ONE AT A TIME. Four rules, tried in the order their
 * preconditions get more general; the first that owns the site takes it.
 */
export function placeCallEdges(ctx, cw) {
  for (const c of ctx.calls) {
    if (!c.from) continue;
    const rule = CALL_RULES[c.via] ?? CALL_RULES.field;
    const ownerFqn = ownerOf(c.from);
    if (resolveSuperCall(ctx, cw, c, rule, ownerFqn)) continue;
    if (resolveInheritedFieldCall(ctx, cw, c, rule, ownerFqn)) continue;
    if (resolveTypeParamCall(ctx, cw, c, rule, ownerFqn)) continue;
    resolvePlainCall(ctx, cw, c, rule, ownerFqn);
  }
}


// ---- the calls the FRAMEWORK makes: @ModelAttribute --------------------------
//
// THE HOLE THIS CLOSES (RM54, measured). `GET /owners/{ownerId}/edit` in
// spring-petclinic answered NO table, and a real agent capture of that request
// shows it reading four. The owner is loaded by `OwnerController#findOwner`, a
// `@ModelAttribute("owner")` method Spring runs before every handler of that
// controller — and no line of source calls it, so no call record could name it
// and no edge led to it. `PetController` and `VisitController` have the same
// shape, and 3 of the 10 routes in that capture were dark for this one reason.
//
// EXACT, and the only rule here that is. Every other edge in this module is a
// parse-tree resolution without compiler binding, so the target set is an
// over-approximation. This one is not resolving anything: the annotation and
// Spring's own contract say the method runs before each handler of the class,
// and the edge says exactly that.
//
// WHAT IS NOT FOLLOWED, and is counted instead of being guessed: a
// @ControllerAdvice's model attributes (they run for controllers this rule
// cannot name from one class), the model attributes a controller INHERITS from a
// base class, and handlers a controller inherits rather than declares.

/**
 * The handlers each type DECLARES, from the endpoint facts. Keyed by the type
 * the mapping was written on, so a handler a subclass only inherits belongs to
 * the class that declared it, and not to both.
 */
function handlersByDeclaringType(endpoints) {
  const out = new Map();
  for (const e of endpoints ?? []) {
    if (!e || !e.handler || !e.handlerType) continue;
    const name = e.handler.slice(e.handler.lastIndexOf('#') + 1);
    const set = out.get(e.handlerType) ?? new Set();
    set.add(name);
    out.set(e.handlerType, set);
  }
  return out;
}

/** `handler --MAY_CALL--> @ModelAttribute method`, once per pair, for every controller. */
export function placeModelAttributeCalls(ctx) {
  const { g, stats, types, superOf, endpoints, ensureSymbol } = ctx;
  const handlersOf = handlersByDeclaringType(endpoints);
  const census = stats.modelAttribute;
  const emitted = new Set();
  for (const fqn of [...types.keys()].sort(cmp)) {
    const t = types.get(fqn);
    const declared = t.modelAttributeMethods ?? [];
    if (declared.length === 0) continue;
    const annotations = t.annotations ?? [];
    if (annotations.some((a) => CONTROLLER_ADVICE_ANNOTATIONS.includes(a))) {
      census.onAdvice += declared.length;
      continue;
    }
    if (!annotations.some((a) => CONTROLLER_ANNOTATIONS.includes(a))) {
      // A base class a controller may EXTEND. Spring runs its model attributes
      // for the subclass's handlers; this rule stays inside one class.
      census.onSuperclass += declared.length;
      continue;
    }
    census.methods += declared.length;
    census.inheritedHandlers += inheritedHandlerCount(fqn, superOf, handlersOf);
    for (const handler of [...(handlersOf.get(fqn) ?? new Set())].sort(cmp)) {
      for (const attribute of declared) {
        if (handler === attribute) continue; // a handler that is its own model attribute calls nothing
        const key = `${fqn}#${handler} ${attribute}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        g.addEdge({
          from: ensureSymbol(`${fqn}#${handler}`), to: ensureSymbol(`${fqn}#${attribute}`),
          type: 'MAY_CALL', grade: 'EXACT',
          evidence: { rule: 'spring-model-attribute', basis: CALL_RULE_BASIS['spring-model-attribute'], attribute },
        });
        stats.calls += 1;
        stats.callsByRule['spring-model-attribute'] += 1;
        census.edges += 1;
      }
    }
  }
}

/** How many handlers this controller only INHERITS, which this rule does not reach. */
function inheritedHandlerCount(fqn, superOf, handlersOf) {
  let cur = superOf.get(fqn) ?? null;
  let hops = 0;
  let n = 0;
  while (cur && hops < SUPER_CHAIN_LIMIT) {
    n += (handlersOf.get(cur) ?? new Set()).size;
    cur = superOf.get(cur) ?? null;
    hops += 1;
  }
  return n;
}

/**
 * The actionable reason, NAMED. Ordered by how much of the gap each one is, then
 * by name, so the list does not depend on the order the calls arrived.
 */
export function reportTypesOutsideRoots(ctx, cw) {
  const { stats } = ctx;
  const { outsideRoots } = cw;
  stats.typesOutsideRoots = [...outsideRoots.values()]
    .sort((a, b) => (b.calls - a.calls) || cmp(a.package, b.package) || cmp(a.simple, b.simple))
    .slice(0, TYPES_OUTSIDE_ROOTS_LISTED);
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
function makeDispatcher(ctx, cw) {
  const { g, stats, types, superOf, declares, aritiesOfMember, implementorsOf, ensureSymbol } = ctx;
  const { pendingInherited } = cw;
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
  return dispatchOne;
}

/**
 * Dispatch and instantiation run to a FIXED POINT, not in one pass:
 * instantiating a member can itself reveal more work — a synthesized body calls
 * an interface, or another member the class only inherits. Both sets are
 * monotone over a finite set, so it terminates.
 */
export function runDispatchToFixpoint(ctx, cw) {
  const { calledIfaceMethods, instantiateInherited, pendingInherited } = cw;
  const dispatchOne = makeDispatcher(ctx, cw);
  const dispatched = new Set();
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
}

