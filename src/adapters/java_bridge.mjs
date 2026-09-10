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
//
// WHERE THE WORK IS. This file is the ORDER the steps run in, plus the one
// primitive they all write through; each step lives in its own module under
// `src/adapters/java/`, and each of those opens by saying what it owns and what
// it must never know about:
//   types.mjs        the fact index, the type index, the hierarchy, and what a
//                    name MEANS — nothing here touches a graph
//   routes.mjs       the routes this pack serves, and the routes it calls
//   calls.mjs        MAY_CALL, every rule that draws one, and every reason one
//                    could not be drawn
//   persistence.mjs  IMPLEMENTS_STMT, the mapper census, the transactions
//   stats.mjs        what the lane reports about its own run
// Every export this file had before that split is still exported from here, so
// no importer and no test had to change. Nothing under `src/adapters/java/`
// imports this file back.

import { Graph, FLOW_EDGE_TYPES } from '../core/graph.mjs';
import {
  buildHierarchyIndex, buildTypeIndex, classifyRouteHolder, endpointId, indexJavaFacts,
  isProjectPackage, looksLikeTypeName, ownerOf, packageOfType, symbolId,
  extendsChainWithBindings, findDeclaringAncestor, inheritorsOfTypeParam, resolveInheritedField,
  JAVA_LANG_TYPES, JDK_WILDCARD_PACKAGES, LOMBOK_LOGGERS, CONTROLLER_ANNOTATIONS,
} from './java/types.mjs';
import {
  classifyRoutes, placeDeclarativeCalls, placeEndpointNodes, placeHandlesEdges,
  placeImperativeCalls, ROUTE_RULE_BASIS,
} from './java/routes.mjs';
import {
  makeEmitter, makeGeneratedFields, makeInheritance, makeInheritorsFor, makeWildcardPlacer,
  placeCallEdges, placeModelAttributeCalls, reportTypesOutsideRoots, runDispatchToFixpoint,
  CALL_RULES, CALL_RULE_BASIS,
} from './java/calls.mjs';
import {
  bindStatements, mapperOwnersOf, markTransactions, registerMethodSymbols,
} from './java/persistence.mjs';
import {
  classifyGeneratedTypes, duplicateFqnCensus, emptyJavaStats, pathGlobMatcher, UNRESOLVED_REASONS,
} from './java/stats.mjs';

export const JAVAFACTS_SCHEMA = 'cascade:javafacts:1';

// The identity rules, the vocabularies and the index builders other bridges and
// tests read. Re-exported from where they live now, so `import { buildTypeIndex }
// from './java_bridge.mjs'` still means exactly what it always meant.
export {
  buildHierarchyIndex, buildTypeIndex, classifyRouteHolder, endpointId, extendsChainWithBindings,
  findDeclaringAncestor, inheritorsOfTypeParam, isProjectPackage, looksLikeTypeName,
  pathGlobMatcher, resolveInheritedField, symbolId,
  CALL_RULES, CALL_RULE_BASIS, CONTROLLER_ANNOTATIONS, JAVA_LANG_TYPES, JDK_WILDCARD_PACKAGES,
  LOMBOK_LOGGERS, ROUTE_RULE_BASIS, UNRESOLVED_REASONS,
};

/**
 * THE ONE PLACE A SYMBOL NODE IS WRITTEN, and the three questions it asks about
 * a member before writing one.
 *
 * Every step below draws its edges through `ensureSymbol`, so a member's node is
 * created once, with the same attributes, whichever rule reached it first. A
 * second writer would eventually disagree with this one about whether a symbol
 * is external or generated, and the pack would then say both.
 *
 * @returns {{ensureSymbol:(memberFqn:string)=>string, isExternalType:(fqn:string)=>boolean,
 *            fileOf:(fqn:string)=>(string|null), isGeneratedMember:(fqn:string)=>boolean}}
 */
function makeSymbolWriter({ g, stats, types, packagePrefixes, lineOfMember, generatedFqns }) {
  // A member of a generated type is generated. The owner is the whole rule:
  // nothing here reads a NAME, so a hand-written class in a generated module is
  // classified generated (which is what the declaration said) and a class called
  // `FooExample` outside one is not.
  const isGeneratedMember = (memberFqn) => generatedFqns.has(ownerOf(memberFqn));
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
  return { ensureSymbol, isExternalType, fileOf, isGeneratedMember };
}

/**
 * THE CENSUSES THAT ARE TAKEN BEFORE ANY EDGE IS DRAWN, written onto the stats.
 *
 * A multi-module repo declares the same FQN more than once. jeecg-boot does it
 * three times: `ISysBaseAPI`, `IOnlineBaseExtApi` and `IAiragBaseApi` are each
 * a plain interface in `jeecg-system-local-api` AND a @FeignClient in
 * `jeecg-system-cloud-api` — two Maven modules that are never on one
 * classpath. `types` keeps whichever record the fact stream ends with.
 *
 * MEASURED, then reported, and deliberately NOT resolved. Reversing those
 * three declarations on jeecg-boot moves ZERO edges and ZERO nodes: a node id
 * is the FQN, so both declarations name the same node; dispatch is keyed by
 * FQN, so both find the same implementors; and the one decision that DOES
 * depend on which file a fact came from — is this mapping annotation a route
 * this pack serves or a client call? — already goes through `typeAt(fqn,
 * file)`. Picking a winner by module proximity would therefore change nothing
 * except adding a rule with no fixture behind it. What was missing was the
 * DISCLOSURE: a reader who sees `ISysBaseAPI` listed once cannot tell whether
 * the analysis merged two modules or dropped one. Now the pack says so.
 *
 * @returns {Set<string>} the FQNs the profile classifies as machine-written
 */
function takeCensuses(stats, typeIndex, endpoints, generatedSources) {
  stats.duplicateFqns = duplicateFqnCensus(typeIndex.filesByFqn, typeIndex.typesByFile, endpoints);
  const generated = classifyGeneratedTypes(typeIndex.types, generatedSources);
  stats.generatedTypes = generated.fqns.size;
  stats.generatedTypesByAnnotation = generated.byAnnotation;
  stats.generatedTypesByPath = generated.byPath;
  return generated.fqns;
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
 *        `generated:true`. Undeclared classifies NOTHING (SPEC §6.2): the engine
 *        never decides on its own that somebody's code is machine-written.
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
 */export function addJavaFacts(g, javaFacts, opts = {}) {
  if (!(g instanceof Graph)) throw new JavaBridgeError('g must be a Graph');
  if (!Array.isArray(javaFacts)) throw new JavaBridgeError('javaFacts must be an array');
  const packagePrefixes = Array.isArray(opts.packagePrefixes) ? opts.packagePrefixes.slice().sort() : [];
  // `generatedSources` absent means NOTHING is classified (SPEC §6.2).
  const generatedSources = opts.generatedSources && typeof opts.generatedSources === 'object'
    ? opts.generatedSources : { annotations: [], pathGlobs: [] };
  const gatewayRoutes = opts.gatewayRoutes && typeof opts.gatewayRoutes === 'object' ? opts.gatewayRoutes : {};

  // ---- what the source says ----------------------------------------------
  const facts = indexJavaFacts(javaFacts);
  const typeIndex = buildTypeIndex(javaFacts);
  const hierarchy = buildHierarchyIndex(typeIndex.types, typeIndex.resolveType);
  const stats = emptyJavaStats({
    generatedSources, parseErrors: facts.parseErrors.length, parsedFiles: facts.parsedFiles.size,
  });
  const generatedFqns = takeCensuses(stats, typeIndex, facts.endpoints, generatedSources);

  const ctx = {
    g,
    stats,
    packagePrefixes,
    gatewayRoutes,
    ...facts,
    ...typeIndex,
    ...hierarchy,
    // The type record a FACT came from: same fqn AND same file, so a duplicated
    // FQN cannot make one module's declaration answer for another's.
    typeAt: (fqn, file) => (file ? typeIndex.typesByFile.get(`${fqn} ${file}`) : undefined) ?? typeIndex.types.get(fqn),
    ...makeSymbolWriter({
      g, stats, types: typeIndex.types, packagePrefixes, lineOfMember: facts.lineOfMember, generatedFqns,
    }),
  };

  // ---- the routes this pack serves, and the ones it calls -----------------
  const { routes, clientCalls } = classifyRoutes(ctx);
  const byRoute = placeEndpointNodes(ctx, routes);
  placeHandlesEdges(ctx, routes);
  placeDeclarativeCalls(ctx, clientCalls, byRoute);
  placeImperativeCalls(ctx, byRoute);

  // ---- calls: from-symbol --MAY_CALL--> target-symbol ---------------------
  //
  // The writer first (one edge, one count, one place), then the four things the
  // rules ask questions of, then the rules themselves, then dispatch — which
  // runs to a fixed point because instantiating an inherited member can reveal
  // more of both.
  const cw = makeEmitter(ctx);
  cw.generatedFieldFor = makeGeneratedFields(ctx);
  cw.inheritorsFor = makeInheritorsFor(ctx);
  Object.assign(cw, makeWildcardPlacer(ctx));
  Object.assign(cw, makeInheritance(ctx, cw));
  placeCallEdges(ctx, cw);
  placeModelAttributeCalls(ctx); // …and the call the FRAMEWORK makes, which no line of source writes
  reportTypesOutsideRoots(ctx, cw);
  runDispatchToFixpoint(ctx, cw);

  // ---- the last hop, and the transaction boundaries -----------------------
  registerMethodSymbols(ctx);
  bindStatements(ctx, mapperOwnersOf(ctx));
  markTransactions(ctx);
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
