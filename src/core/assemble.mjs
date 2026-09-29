// assemble.mjs — facts → Graph, once, for every caller (SPEC §4, §8).
//
// THE LAYERING RULE THIS FILE EXISTS TO KEEP (I-3, SPEC §4):
//   core/ knows nothing about adapters/. Lanes are plug-ins; the core is the
//   thing they plug INTO. Until RM13 `src/core/overlay.mjs` imported
//   `../adapters/sql_bridge.mjs` and `../adapters/java_bridge.mjs` directly —
//   the dependency ran core → adapters, the opposite of the direction the spec
//   states, and CONTRIBUTING had to admit it in writing. The imports are gone;
//   the bridges now arrive as INJECTED FUNCTIONS, wired once by the CLI
//   (src/cli/lanes_run.mjs), which is the layer allowed to know both sides.
//
// It is the same three steps `cascade analyze` ran inline, in the same order,
// with the same arguments, so `analyze` and the working-tree overlay cannot
// drift apart in how they turn a fact stream into a graph:
//
//   1. buildGraphFromSql(catalog, lineage, {identifierCase})  the SQL lane
//   2. addJavaFacts(graph, javaFacts, {...})                  the code lane
//   3. addJpaFacts(graph, javaFacts, {...})                   the JPA bridge
//   4. addMybatisPlusFacts(graph, javaFacts, {...})           the MyBatis-Plus bridge
//   5. addOpenApiRoutes(graph, documents, {...})              the OpenAPI bridge
//   6. addWebFacts(graph, webFacts, {...})                    the web bridge
//   7. addRuntimeFacts(graph, traces, {...})                  the runtime evidence lane
//
// The code lane is handed the OpenAPI documents too, and reads one thing in
// them: where a document declares the operation a functional route names, when
// the code that mounts that route is not in its file (RM67). It adds no route a
// document alone declares; that stays the OpenAPI bridge's, run after it.
//
// The web bridge runs after the routes because a frontend call becomes an edge
// onto an endpoint node, and the endpoints are what the Java bridge and the
// OpenAPI bridge put in the graph. Running it earlier would leave every
// frontend call unmatched — and running the OpenAPI bridge after it would leave
// a call that only a DOCUMENT can explain unmatched, which is the whole point of
// having a document on a project whose backend this engine cannot read.
//
// The runtime evidence lane runs LAST OF ALL, because it annotates what every
// other lane put in the graph: a trace marks a dispatch edge the Java bridge
// wrote, a statement the SQL lane wrote and a route either the Java or the
// OpenAPI bridge wrote. It adds nothing a walk can follow (every edge it writes
// is RUNTIME_ONLY), so nothing downstream of it depends on it either.
//
// WHAT THIS FILE DOES NOT DECIDE. Whether a lane RAN at all is the caller's
// call — it knows whether there were Java source roots and whether the profile
// asked for the JPA pack — so a lane is skipped here by passing null for its
// options, never by this module inspecting a profile it was not given.
//
// Pure: records in, graph out. No filesystem, no workers, no process.

import { Graph } from './graph.mjs';
import { builtinRegistry } from './rules/registry.mjs';
import { codeSettingsIn } from './rules/kinds/java_code_setting.mjs';

/**
 * WHY THE ROUTES' ADDRESSES MAY LACK A PREFIX, for the web bridge's matcher: a
 * call that sets controllers' path prefix in code (a `java.code-setting` rule
 * for `pathPrefixes`), seen while the Java lane was given none. Every route the
 * lane recorded may then be served under a prefix it does not show, so a call
 * that only a catch-all matches may be a more specific route's (RM67-J4). Null
 * with no Java lane, a declared list, or no such call; the same condition
 * `cascade analyze` says as SETTING_IN_CODE.
 */
function unreadRoutePrefix(java, javaFacts) {
  if (!java || (java.pathPrefixes ?? []).length > 0) return null;
  const found = codeSettingsIn(javaFacts, builtinRegistry().ofKind('java.code-setting')).filter((f) => f.setting === 'pathPrefixes');
  if (found.length === 0) return null;
  const f = found[0];
  return `${f.file ?? '(unknown file)'}${f.line ? `:${f.line}` : ''} calls ${f.on}.${f.method}, which serves controllers under a path prefix this engine does not read and the profile does not declare (pathPrefixes), so a more specific route of this pack may answer this address instead of the catch-all`;
}

/**
 * The web bridge's options with what this file adds from the Java stream: the
 * view names each handler returns (the server-rendered screen, RM48), and why
 * the routes' addresses may lack a prefix (unreadRoutePrefix).
 */
function webOptionsOf(web, java, javaFacts) {
  return {
    ...web,
    views: web.views ?? javaFacts.filter((r) => r && typeof r === 'object' && r.kind === 'view'),
    unreadRoutePrefix: unreadRoutePrefix(java, javaFacts),
  };
}

/**
 * One lane's bridge: null when no options were given for it, else what it
 * returns. Options given with no bridge to read them are the caller's mistake,
 * and are said as one.
 *
 * `also` is what this file adds to the caller's options: the OpenAPI bridge is
 * handed the Java records and the Java lane's options, because a controller may
 * handle a document's route through an interface only the build generates, and
 * the rule that pairs the two reads both (src/adapters/contract_links.mjs).
 */
function runBridge(bridges, fn, lane, graph, facts, opts, also = null) {
  if (!opts) return null;
  if (typeof bridges[fn] !== 'function') throw new AssembleError(`${lane} options were given but bridges.${fn} is missing`);
  return bridges[fn](graph, facts, also ? { ...opts, ...also } : opts);
}

/**
 * The code lane's options, with the documents when the OpenAPI lane runs too;
 * null runs no code lane.
 */
function javaOptions(java, openapi, openapiDocuments) {
  return java && (openapi ? { ...java, openapiDocuments } : java);
}

/**
 * THE CODE LANE'S OPTIONS, from the profile, for `analyze` and the working-tree
 * overlay alike. Two callers that each wrote this list drifted apart: the
 * overlay was handed the documents without the OpenAPI bridge that reads them,
 * and lost every route a document declares and every contract link on one. What
 * a caller cannot have is passed empty here and said by that caller (the
 * overlay does not re-read the Spring XML id generators: src/cli/overlay_provider.mjs).
 *
 * @param {object|null} profile  the normalized profile
 * @param {{packagePrefixes?:string[], idGenerators?:object[]}} [inputs]
 *        what the run read beyond the profile: the package prefixes it analyzed
 *        under (the profile's by default) and the id generators discovery found
 */
export function javaLaneOptions(profile, { packagePrefixes, idGenerators = [] } = {}) {
  const p = profile ?? {};
  return {
    packagePrefixes: packagePrefixes ?? p.packagePrefixes ?? [],
    generatedSources: p.generatedSources ?? { annotations: [], pathGlobs: [] },
    // One declaration for the web bridge and the Java one: a Java service that
    // calls another through a declared gateway prefix has nowhere else to say so.
    gatewayRoutes: p.gatewayRoutes ?? {},
    // The path prefixes configuration code puts before a controller's routes.
    pathPrefixes: p.pathPrefixes ?? [],
    // The table id generators the Spring XMLs declare (RM62).
    idGenerators,
  };
}

/** The OpenAPI bridge's options: it runs when a document was read, for `analyze` and the overlay alike. */
export function openapiLaneOptions(documents) {
  return Array.isArray(documents) && documents.length > 0 ? {} : null;
}

/**
 * THE WEB BRIDGE'S OPTIONS, for `analyze` and the working-tree overlay alike.
 * The two callers wrote this list apart and drifted: the overlay handed the
 * bridge no packages and no ports, so a frontend package with no config file of
 * its own was filed under another directory, and a call to this machine on
 * another service's port landed on this pack's route. What the caller read to
 * fill it (discovery's walk, or the record the base pack kept of it) is the
 * caller's; the list itself is built here once.
 *
 * @param {object|null} profile  the normalized profile
 * @param {{packages?:{path:string}[], serverPorts?:object|null, screenAxisEnabled?:boolean}} [inputs]
 *        packages: the frontend packages the run read, each `path` a package.json
 *        relative to the root the web facts' `file` keys are relative to.
 *        serverPorts: src/core/server_ports.mjs's answer, or null when unknown.
 *        screenAxisEnabled: the screen axis gate (src/core/lanes.mjs screenAxisOf).
 */
export function webLaneOptions(profile, { packages = [], serverPorts = null, screenAxisEnabled = false } = {}) {
  const p = profile ?? {};
  return {
    // One declaration for the web bridge and the Java one (javaLaneOptions).
    gatewayRoutes: p.gatewayRoutes ?? {},
    packages,
    serverPorts,
    // I-5: the `screenAxis` block and `moduleAttribution.codeLength` are read
    // here and nowhere else. `enabled` is the gate on the whole axis.
    screenAxis: { ...(p.screenAxis ?? {}), enabled: screenAxisEnabled },
    codeLength: p.moduleAttribution?.codeLength ?? null,
  };
}

/**
 * Build one graph from already-parsed fact records.
 *
 * @param {Object} a
 * @param {{buildGraphFromSql:Function, addJavaFacts?:Function, addJpaFacts?:Function,
 *          addMybatisPlusFacts?:Function, addOpenApiRoutes?:Function, addWebFacts?:Function,
 *          addRuntimeFacts?:Function}} a.bridges
 *        the lane bridges, injected. `buildGraphFromSql` is always required;
 *        the other two only when the matching options are given.
 * @param {object[]} [a.catalogRecords=[]]  catalog records (DDL or snapshot)
 * @param {object[]} [a.lineageRecords=[]]  lineage records, one per statement
 * @param {object[]} [a.javaFacts=[]]       the whole-project JavaFacts stream
 * @param {string} [a.identifierCase='exact']  the SQL identity rule this run
 *        matched names with — the SAME one the lineage worker was given, or the
 *        bridge would key a table differently from the worker that resolved it.
 * @param {{packagePrefixes?:string[], generatedSources?:object}|null} [a.java=null]
 *        options for the Java bridge; null runs no code lane.
 * @param {{namingStrategy?:string|null, schema?:string|null,
 *          identifierCase?:string|null}|null} [a.jpa=null]
 *        options for the JPA bridge; null runs no JPA bridge.
 * @param {{namingStrategy?:string|null, tablePrefix?:string|null,
 *          logicDeleteValue?:string|null, logicNotDeleteValue?:string|null,
 *          schema?:string|null}|null} [a.mybatisPlus=null]
 *        options for the MyBatis-Plus bridge; null runs no MyBatis-Plus bridge.
 * @param {object[]} [a.tsFacts=[]]  the TypeScript backend's tsfacts stream
 * @param {{tsconfig?:object, prisma?:object|null, globalPrefix?:string|null, schemaName?:string|null, identifierCase?:string}|null} [a.ts=null]
 *        options for the TypeScript backend bridge; null runs none.
 * @param {object[]} [a.openapiDocuments=[]]  documents as `readOpenApiDocument` returns them
 * @param {{}|null} [a.openapi=null]  options for the OpenAPI bridge; null runs none
 * @param {object[]} [a.webFacts=[]]  the whole-project webfacts stream
 * @param {{gatewayRoutes?:object, packages?:object[]}|null} [a.web=null]
 *        options for the web bridge; null runs no web bridge.
 * @param {object[]} [a.otelTraces=[]]  traces as `readOtelTrace` returns them
 * @param {{}|null} [a.runtime=null]  options for the runtime evidence lane; null runs none
 * @returns {{graph:Graph, javaStats:(object|null), jpaStats:(object|null),
 *            mpStats:(object|null), openapiStats:(object|null), webStats:(object|null),
 *            runtimeStats:(object|null)}}
 */
export function assembleGraph(a) {
  const {
    bridges, catalogRecords = [], lineageRecords = [], javaFacts = [], webFacts = [], tsFacts = [],
    openapiDocuments = [], otelTraces = [],
    identifierCase = 'exact', java = null, jpa = null, mybatisPlus = null, ts = null, openapi = null, web = null,
    runtime = null,
  } = a ?? {};
  if (!bridges || typeof bridges.buildGraphFromSql !== 'function') {
    throw new AssembleError('assembleGraph needs bridges.buildGraphFromSql. The core imports no lane, so the CLI is what wires one in');
  }
  const graph = bridges.buildGraphFromSql(catalogRecords, lineageRecords, { identifierCase });
  if (!(graph instanceof Graph)) throw new AssembleError('bridges.buildGraphFromSql must return a Graph');

  const javaStats = runBridge(bridges, 'addJavaFacts', 'java', graph, javaFacts, javaOptions(java, openapi, openapiDocuments));
  const jpaStats = runBridge(bridges, 'addJpaFacts', 'jpa', graph, javaFacts, jpa);
  const mpStats = runBridge(bridges, 'addMybatisPlusFacts', 'mybatisPlus', graph, javaFacts, mybatisPlus);
  // The TypeScript backend: its routes have to exist before the web bridge
  // below matches a frontend call to one.
  const tsStats = runBridge(bridges, 'addTsFacts', 'ts', graph, tsFacts, ts);
  const openapiStats = runBridge(bridges, 'addOpenApiRoutes', 'openapi', graph, openapiDocuments, openapi, { java, javaFacts });
  // THE TWO HALVES OF A SERVER-RENDERED SCREEN meet here (RM48): the Java
  // worker read which view name each handler returns, the web worker read the
  // templates, and the web bridge is the only place that has both. Taken out
  // of the Java stream rather than asked of the caller, so `analyze` and the
  // working-tree overlay cannot pass different sets.
  const webStats = runBridge(bridges, 'addWebFacts', 'web', graph, webFacts, web && webOptionsOf(web, java, javaFacts));
  const runtimeStats = runBridge(bridges, 'addRuntimeFacts', 'runtime', graph, otelTraces, runtime);
  return { graph, javaStats, jpaStats, mpStats, tsStats, openapiStats, webStats, runtimeStats };
}

export class AssembleError extends Error {
  constructor(message) { super(message); this.name = 'AssembleError'; }
}
