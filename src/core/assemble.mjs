// assemble.mjs — facts → Graph, once, for every caller (SPEC §4, §8).
//
// THE LAYERING RULE THIS FILE EXISTS TO KEEP (I-3, SPEC §4):
//   core/ knows nothing about adapters/. Lanes are plug-ins; the core is the
//   thing they plug INTO. Until RM13 `src/core/overlay.mjs` imported
//   `../adapters/sql_bridge.mjs` and `../adapters/java_bridge.mjs` directly —
//   the dependency ran core → adapters, the opposite of the direction the spec
//   states, and CONTRIBUTING had to admit it in writing. The imports are gone;
//   the bridges now arrive as INJECTED FUNCTIONS, wired once by the CLI
//   (bin/cascade.mjs), which is the layer allowed to know both sides.
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
    bridges, catalogRecords = [], lineageRecords = [], javaFacts = [], webFacts = [],
    openapiDocuments = [], otelTraces = [],
    identifierCase = 'exact', java = null, jpa = null, mybatisPlus = null, openapi = null, web = null,
    runtime = null,
  } = a ?? {};
  if (!bridges || typeof bridges.buildGraphFromSql !== 'function') {
    throw new AssembleError('assembleGraph needs bridges.buildGraphFromSql. The core imports no lane, so the CLI is what wires one in');
  }
  const graph = bridges.buildGraphFromSql(catalogRecords, lineageRecords, { identifierCase });
  if (!(graph instanceof Graph)) throw new AssembleError('bridges.buildGraphFromSql must return a Graph');

  let javaStats = null;
  if (java) {
    if (typeof bridges.addJavaFacts !== 'function') throw new AssembleError('java options were given but bridges.addJavaFacts is missing');
    javaStats = bridges.addJavaFacts(graph, javaFacts, java);
  }
  let jpaStats = null;
  if (jpa) {
    if (typeof bridges.addJpaFacts !== 'function') throw new AssembleError('jpa options were given but bridges.addJpaFacts is missing');
    jpaStats = bridges.addJpaFacts(graph, javaFacts, jpa);
  }
  let mpStats = null;
  if (mybatisPlus) {
    if (typeof bridges.addMybatisPlusFacts !== 'function') throw new AssembleError('mybatisPlus options were given but bridges.addMybatisPlusFacts is missing');
    mpStats = bridges.addMybatisPlusFacts(graph, javaFacts, mybatisPlus);
  }
  let openapiStats = null;
  if (openapi) {
    if (typeof bridges.addOpenApiRoutes !== 'function') throw new AssembleError('openapi options were given but bridges.addOpenApiRoutes is missing');
    openapiStats = bridges.addOpenApiRoutes(graph, openapiDocuments, openapi);
  }
  let webStats = null;
  if (web) {
    if (typeof bridges.addWebFacts !== 'function') throw new AssembleError('web options were given but bridges.addWebFacts is missing');
    webStats = bridges.addWebFacts(graph, webFacts, web);
  }
  let runtimeStats = null;
  if (runtime) {
    if (typeof bridges.addRuntimeFacts !== 'function') throw new AssembleError('runtime options were given but bridges.addRuntimeFacts is missing');
    runtimeStats = bridges.addRuntimeFacts(graph, otelTraces, runtime);
  }
  return { graph, javaStats, jpaStats, mpStats, openapiStats, webStats, runtimeStats };
}

export class AssembleError extends Error {
  constructor(message) { super(message); this.name = 'AssembleError'; }
}
