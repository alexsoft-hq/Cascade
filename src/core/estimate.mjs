// estimate.mjs — the coverage estimate (SPEC §10.4, §15 M4).
//
// The first ten minutes of onboarding do not want an impact answer; they want
// "what will this engine be able to tell me about MY repository, and what will
// it have to leave blank?" That is two different questions, and this module
// answers both, always both:
//
//   BEFORE ANALYSIS — from `discover()` + the profile alone: which axes will
//   ship, which will run degraded, which will not ship at all, each WITH the
//   count it rests on ("no DDL file with CREATE TABLE → the column axis runs
//   degraded"). No pack is needed; this is what you can be told before paying
//   for an analysis.
//
//   MEASURED — from a pack that exists: the ratios that decide how many
//   questions can be answered EXACTly. Every ratio is `{num, den, pct}`, and a
//   ratio with nothing to measure reports `pct: null` — NEVER 0%, because "no
//   statements at all" and "no statement has column facts" are different facts
//   and an AI reading 0% would treat the first as the second.
//
// Pure: graph/discovery/profile in, plain object out. `bin/cascade.mjs` does the
// filesystem work and the printing.

import { walkEndpoints } from './walks.mjs';
import { screenAxisOf } from './lanes.mjs';
import { ROUTER_PACKS } from './discover.mjs';

export const ESTIMATE_SCHEMA = 'cascade:estimate:1';

/** One decimal, or null when there is nothing to divide by. */
export function ratio(num, den, note = null) {
  const n = Number(num) || 0;
  const d = Number(den) || 0;
  return {
    num: n, den: d,
    pct: d === 0 ? null : Math.round((n / d) * 1000) / 10,
    ...(note ? { note } : {}),
  };
}

/**
 * The BEFORE-ANALYSIS half: what a run over this tree will be able to ship.
 *
 * @param {Object} discovery  a `discover()` result (or a synthetic one with the
 *                            same `counts` shape)
 * @param {Object} profile    a normalized profile
 * @param {{routes?:number|null}} [prev]  what the LAST run measured, when there
 *        is a pack to read it from. Only ever used to sharpen a sentence, never
 *        to change a status: this half is about what a run WOULD ship.
 * @returns {{axes:{axis:string,status:string,reason:string,counts:Object}[],
 *            notCovered:{technology:string,files:number,reason:string}[]}}
 */
export function estimateBefore(discovery, profile = {}, prev = {}) {
  const prevRoutes = prev && Number.isInteger(prev.routes) ? prev.routes : null;
  const c = (discovery && discovery.counts) || {};
  const n = (k) => Number(c[k]) || 0;
  const packs = Array.isArray(profile.frameworkPacks) ? profile.frameworkPacks : [];
  const catalogSource = (profile.catalog && profile.catalog.source) || 'none';

  const ddlFiles = n('ddlFiles');
  const mapperFiles = n('mybatisMapperXml');
  const javaFiles = n('javaFiles');
  const handlerFiles = n('springHandlerFiles');

  // A lane only runs unflagged when its framework pack is declared; discovery
  // finding the files is necessary, not sufficient.
  const sqlPackDeclared = packs.includes('mybatis-xml');
  const springPackDeclared = packs.includes('spring-mvc');
  const willReadCatalog = ddlFiles > 0 && catalogSource === 'file';
  const willReadStatements = mapperFiles > 0 && sqlPackDeclared;
  const willReadJava = javaFiles > 0 && springPackDeclared;

  const axes = [];
  axes.push({
    axis: 'catalog',
    status: willReadCatalog ? 'shipped' : 'not-shipped',
    reason: willReadCatalog
      ? `catalog.source is "file" and ${ddlFiles} DDL file(s) declare CREATE TABLE`
      : ddlFiles === 0
        ? 'no .sql file in this tree contains CREATE TABLE, so there is no schema to read'
        : `we found ${ddlFiles} DDL file(s), but catalog.source is ${JSON.stringify(catalogSource)}. Set it to "file" and point catalog.connectionFrom at one of them, or pass --ddl`,
    counts: { ddlFiles, catalogSource },
  });
  axes.push({
    axis: 'statements',
    status: willReadStatements ? 'shipped' : 'not-shipped',
    reason: willReadStatements
      ? `${mapperFiles} MyBatis mapper XML file(s) in ${(discovery.mapperDirs ?? []).length} directory(ies)`
      : mapperFiles === 0
        ? 'we found no MyBatis mapper XML (<mapper namespace=…>), and this engine reads SQL from mapper XML only'
        : `we found ${mapperFiles} mapper XML file(s), but frameworkPacks does not declare mybatis-xml, so an unflagged run will not read them`,
    counts: { mapperXmlFiles: mapperFiles, mapperDirs: (discovery.mapperDirs ?? []).length },
  });
  axes.push({
    axis: 'column',
    status: willReadStatements && willReadCatalog ? 'shipped'
      : willReadStatements ? 'degraded' : 'not-shipped',
    reason: willReadStatements && willReadCatalog
      ? 'both a DB catalog and mapper SQL are available, so a column reference can be attributed to its owning table'
      : willReadStatements
        ? 'there is no DB catalog here. Without one we cannot tie a bare column name to its table, so we record it as unresolved rather than guess, and column answers will be partial'
        : 'no mapper SQL, so nothing reads or writes a column in this pack',
    counts: { ddlFiles, mapperXmlFiles: mapperFiles },
  });
  const jpaFiles = n('jpaEntityFiles');
  const jpaPackDeclared = packs.includes('jpa');
  const willReadJpa = jpaFiles > 0 && jpaPackDeclared && willReadJava;
  const namingDeclared = !!(profile.jpa && profile.jpa.namingStrategy);
  axes.push({
    axis: 'jpa',
    status: willReadJpa ? (namingDeclared ? 'shipped' : 'degraded') : 'not-shipped',
    reason: !willReadJpa
      ? jpaFiles === 0
        ? 'there is no @Entity class in this tree, so nothing declares persistence through JPA'
        : !willReadJava
          ? `${jpaFiles} @Entity file(s) were found, but the Java lane will not run, and the JPA bridge reads the Java lane's facts`
          : `we found ${jpaFiles} @Entity file(s), but frameworkPacks does not declare jpa, so an unflagged run will not map them`
      : namingDeclared
        ? `${jpaFiles} @Entity file(s), mapped with the declared jpa.namingStrategy`
        : `${jpaFiles} @Entity file(s). jpa.namingStrategy is not declared, so a name the mapping did not spell out is DERIVED with Spring Boot's default and graded HEURISTIC`,
    counts: { jpaEntityFiles: jpaFiles, namingStrategy: (profile.jpa && profile.jpa.namingStrategy) || null },
  });
  const mpFiles = n('mybatisPlusFiles');
  const mpPackDeclared = packs.includes('mybatis-plus');
  const willReadMp = mpFiles > 0 && mpPackDeclared && willReadJava;
  const mpNamingDeclared = !!(profile.mybatisPlus && profile.mybatisPlus.namingStrategy);
  axes.push({
    axis: 'mybatisPlus',
    status: willReadMp ? (mpNamingDeclared ? 'shipped' : 'degraded') : 'not-shipped',
    reason: !willReadMp
      ? mpFiles === 0
        ? 'there is no `extends BaseMapper<…>` and no @TableName in this tree, so nothing declares persistence through MyBatis-Plus'
        : !willReadJava
          ? `${mpFiles} MyBatis-Plus file(s) were found, but the Java lane will not run, and this bridge reads the Java lane's facts`
          : `we found ${mpFiles} MyBatis-Plus file(s), but frameworkPacks does not declare mybatis-plus, so an unflagged run will not map them`
      : mpNamingDeclared
        ? `${mpFiles} MyBatis-Plus file(s), mapped with the declared mybatisPlus.namingStrategy`
        : `${mpFiles} MyBatis-Plus file(s). mybatisPlus.namingStrategy is not declared, so a name the mapping did not spell out is DERIVED with MyBatis-Plus's default and graded HEURISTIC`,
    counts: { mybatisPlusFiles: mpFiles, namingStrategy: (profile.mybatisPlus && profile.mybatisPlus.namingStrategy) || null },
  });

  const testFiles = n('javaTestFiles');
  const testRoots = (discovery.javaTestRoots ?? []).length;
  axes.push({
    axis: 'code',
    status: willReadJava ? 'shipped' : 'not-shipped',
    reason: willReadJava
      ? `${javaFiles - testFiles} main java file(s) across ${(discovery.javaSourceRoots ?? []).length} source root(s)`
        + (testRoots > 0 ? `; ${testFiles} more sit in ${testRoots} src/test root(s) an unflagged run does not read` : '')
      : javaFiles === 0
        ? 'no java source in this tree'
        : 'we found java sources, but frameworkPacks does not declare spring-mvc, so an unflagged run will not read them',
    counts: { javaFiles, javaMainFiles: javaFiles - testFiles, javaTestFiles: testFiles,
              javaSourceRoots: (discovery.javaSourceRoots ?? []).length, javaTestRoots: testRoots },
  });
  axes.push({
    axis: 'endpoints',
    status: willReadJava && handlerFiles > 0 ? 'shipped' : 'not-shipped',
    reason: !willReadJava
      ? 'the Java lane will not run, so no HTTP route can be attached to the SQL below it'
      : handlerFiles > 0
        ? `${handlerFiles} java file(s) carry a Spring mapping annotation`
        : 'no java file carries a Spring mapping annotation (@RestController/@Controller/@RequestMapping/@GetMapping…), so the endpoint axis is not shipped and impact answers stop at the mapper method',
    counts: { springHandlerFiles: handlerFiles },
  });
  // The web lane runs unflagged only when the profile declares the `web` pack,
  // the same rule the other three lanes follow.
  const webPackDeclared = packs.includes('web');
  const webFiles = n('webFiles');
  const webRoots = (discovery.webSourceRoots ?? []).length;
  const willReadWeb = webFiles > 0 && webRoots > 0 && webPackDeclared;
  axes.push({
    axis: 'web',
    // DEGRADED even before it runs, because the one thing that decides between
    // `shipped` and `degraded` is not knowable yet: whether the prefix and the
    // aliases this frontend goes through are stated in its own source or have
    // to be guessed. The pack's own axis says which, once the lane has run.
    status: willReadWeb ? 'degraded' : 'not-shipped',
    reason: willReadWeb
      ? `${webFiles} frontend source file(s) in ${webRoots} root(s). The lane will trace each HTTP call to the client that sends it and attach it to the route this pack serves; a call whose prefix or alias had to be assumed is graded HEURISTIC, and one no route here answers is counted, not dropped`
      : webFiles === 0
        ? 'there is no frontend source file in this tree (.js/.ts/.jsx/.tsx/.vue outside tests and type declarations), so there is no frontend to read'
        : webRoots === 0
          ? `we found ${webFiles} frontend source file(s), but no package.json declaring a framework dependency, so there is no frontend package to read. Pass --web-src to name a root anyway`
          : `we found ${webFiles} frontend source file(s), but frameworkPacks does not declare web, so an unflagged run will not read them`,
    counts: { frontendPackages: n('frontendPackageJson'), webFiles, vueFiles: n('vueFiles'), webSourceRoots: webRoots },
  });
  // The OpenAPI documents this run will read. No framework pack gates it: a
  // document is a document, and a project that ships one has said what it
  // serves.
  const openapiDocs = discovery.openapiDocuments ?? [];
  const declaredDocs = Array.isArray(profile.openapi && profile.openapi.documents) ? profile.openapi.documents : [];
  const willReadDocs = declaredDocs.length > 0 ? declaredDocs.length : openapiDocs.length;
  axes.push({
    axis: 'openapi',
    status: willReadDocs > 0 ? 'shipped' : 'not-shipped',
    reason: willReadDocs > 0
      ? `${willReadDocs} OpenAPI / Swagger document(s) will be read${declaredDocs.length > 0 ? ', as the profile declares them' : ''}: `
        + `${(declaredDocs.length > 0 ? declaredDocs : openapiDocs.map((d) => d.path)).slice(0, 5).join(', ')}`
        + `${willReadDocs > 5 ? `, and ${willReadDocs - 5} more` : ''}. `
        + 'Every route they declare becomes an endpoint, and the ones this code does not serve are reported as drift rather than dropped'
      : 'no .json/.yaml/.yml file in this tree carries a top-level `openapi` or `swagger` key, so no route is declared to this run',
    counts: {
      openapiDocuments: willReadDocs,
      byVersion: openapiDocs.reduce((acc, d) => ({ ...acc, [d.version]: (acc[d.version] ?? 0) + 1 }), {}),
    },
  });
  // THE SCREEN AXIS, before anything has been parsed. Two of the three things
  // that decide it ARE knowable here: whether a router declaration pack is
  // declared (the packs are what let the worker recognize a route object at
  // all) and whether the profile turned the axis on. The third — how many route
  // declarations there really are — is not, until the lane runs; the LAST run's
  // count is reported instead when there is one, said as such.
  const routerPacks = ROUTER_PACKS.filter((p) => packs.includes(p));
  // The same three-state switch `cascade analyze` resolves, over the evidence
  // an estimate has: the packages discovery found in THIS tree. An estimate
  // cannot know about a frontend a later `--web-src` will point outside it, and
  // says so in the reason rather than promising no screens.
  const screenGate = screenAxisOf(profile, { webPackages: discovery?.webPackages ?? [] });
  const screenEnabled = screenGate.enabled;
  const lastRoutes = Number.isInteger(prevRoutes) ? prevRoutes : null;
  const willBuildScreens = willReadWeb && screenEnabled && routerPacks.length > 0;
  axes.push({
    axis: 'screen',
    // DEGRADED before the fact, like the web axis and for the same reason: what
    // separates shipped from degraded is whether every route's component
    // resolves to a file, and that is not knowable until the lane has run.
    status: willBuildScreens ? 'degraded' : 'not-shipped',
    reason: willBuildScreens
      ? `the web lane will turn the route declarations it finds into screens (router pack(s): ${routerPacks.join(', ')})`
        + `${lastRoutes === null ? '' : `; the last run recorded ${lastRoutes} route declaration(s)`}`
        + '. Each screen gets a RENDERS edge onto the functions of the component it mounts, and a route whose component this lane cannot resolve is counted rather than dropped'
      : !willReadWeb
        ? (screenEnabled
          ? 'the profile enables the screen axis, but no web lane will run to record the routes a screen would come from'
          : 'no web lane will run, so there is no router declaration to build a screen from')
        : !screenEnabled
          ? `the web lane will run and the screen axis is off: ${screenGate.reason}. Set screenAxis.enabled to true in the profile to build screens anyway`
          : 'the web lane will run and frameworkPacks names no router pack (vue-router, react-router), so no route object is recognized and there is nothing to build a screen from',
    counts: {
      frontendPackages: n('frontendPackageJson'),
      webFiles,
      routerPacks,
      enabled: screenEnabled,
      enabledFrom: screenGate.from,
      lastRunRoutes: lastRoutes,
    },
  });

  const notCovered = [];
  if (n('kotlinFiles') > 0) {
    notCovered.push({
      technology: 'Kotlin', files: n('kotlinFiles'),
      reason: 'this engine ships no Kotlin lane, so these files add nothing to the graph',
    });
  }
  // A frontend the web lane WILL read is not an uncovered technology any more.
  // One it will not (no `web` pack declared, or no package found) still is, and
  // the axis reason above says which of the two it was.
  if (n('frontendPackageJson') > 0 && !willReadWeb) {
    notCovered.push({
      technology: 'frontend', files: n('frontendPackageJson'),
      reason: webPackDeclared
        ? 'the profile declares the web pack but no frontend source root was found, so screens and the calls they make are absent from the graph'
        : 'frameworkPacks does not declare web, so an unflagged run reads no frontend source and the calls they make are absent from the graph',
    });
  }
  // WHO THIS PROJECT IS AND WHERE IT FORWARDS, as the tree says it (RM46).
  // Neither is an axis — no lane ships or fails to ship them — but both decide
  // whether an answer can cross from this project into the next one, so the
  // report says them once instead of leaving them to be discovered in a profile.
  const identity = {
    serviceNames: (discovery.serviceNames ?? []).map((s) => ({ name: s.name, file: s.file })),
    declaredServiceNames: Array.isArray(profile.serviceNames) ? profile.serviceNames : [],
    gatewayRoutes: (discovery.gatewayRoutes ?? []).length,
    gatewayRouteFiles: [...new Set((discovery.gatewayRoutes ?? []).map((r) => r.file))].sort(),
    declaredGatewayRoutes: profile.gatewayRoutes && typeof profile.gatewayRoutes === 'object'
      ? Object.keys(profile.gatewayRoutes).length : 0,
  };
  return { axes, notCovered, identity };
}

/**
 * The MEASURED half: what a pack that EXISTS can actually answer.
 *
 * `callsResolved` needs lane statistics the graph does not carry (a call the
 * analyzer could not resolve leaves no edge behind — that is exactly why it is
 * counted at ingest), so it comes from `pack.meta.laneStats` and reports itself
 * as unmeasurable when the pack records none. `calls` there counts every edge
 * the lane DID create, external ones included, so the project-internal resolved
 * count is `calls - externalCalls` and the denominator is every call site seen.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{laneStats?:Object, mode?:string, depth?:number}} [opts]
 * @returns {Object} named ratios, each {num, den, pct}
 */
export function measurePack(graph, opts = {}) {
  const laneStats = opts.laneStats && typeof opts.laneStats === 'object' ? opts.laneStats : null;

  let statements = 0;
  let withColumnFacts = 0;
  let withStringSubst = 0;
  let exactAnswerable = 0;
  let schemaUnknown = 0;
  let mapperMethods = 0;
  let mapperMethodsBound = 0;
  let jpaStatements = 0;
  let jpaResolved = 0;
  let mpStatements = 0;
  let mpResolved = 0;
  let symbols = 0;
  let generatedSymbols = 0;
  for (const node of graph.nodes.values()) {
    if (node.kind === 'statement') {
      statements += 1;
      if (node.source === 'jpa') {
        jpaStatements += 1;
        if (node.hasUnresolved !== true) jpaResolved += 1;
      } else if (node.source === 'mybatis-plus') {
        mpStatements += 1;
        // RESOLVED means the whole statement's column list is known: a
        // statement whose wrapper was built at run time is NOT resolved, however
        // certain its table is.
        if (node.columnsRuntimeOnly !== true) mpResolved += 1;
      }
      const hasCols = graph.outEdges(node.id).some((e) => e.type === 'READS' || e.type === 'WRITES');
      const subst = node.hasStringSubst === true;
      if (hasCols) withColumnFacts += 1;
      if (subst) withStringSubst += 1;
      if (node.schemaUnknown === true) schemaUnknown += 1;
      // "EXACT-answerable": the statement's columns are known AND no raw text
      // was spliced into it — a `${}` statement can execute SQL this pack never
      // parsed, so its column list is a lower bound whatever the grade says.
      if (hasCols && !subst) exactAnswerable += 1;
    } else if (node.kind === 'symbol') {
      symbols += 1;
      if (node.generated === true) generatedSymbols += 1;
      if (node.mapperMethod === true) {
        mapperMethods += 1;
        if (graph.outEdges(node.id).some((e) => e.type === 'IMPLEMENTS_STMT')) mapperMethodsBound += 1;
      }
    }
  }

  let endpoints = 0;
  let endpointsReaching = 0;
  for (const node of graph.nodes.values()) if (node.kind === 'endpoint') endpoints += 1;
  if (endpoints > 0) {
    const { endpoints: rows } = walkEndpoints(graph, {
      mode: opts.mode ?? 'conservative', depth: opts.depth ?? 8,
    });
    endpointsReaching = rows.filter((r) => r.statements.length > 0).length;
  }

  const calls = laneStats && Number.isInteger(laneStats.calls) ? laneStats.calls : null;
  const unresolved = laneStats && Number.isInteger(laneStats.unresolvedCalls) ? laneStats.unresolvedCalls : null;
  const external = laneStats && Number.isInteger(laneStats.externalCalls) ? laneStats.externalCalls : 0;
  const callsRatio = calls == null || unresolved == null
    ? ratio(0, 0, 'this pack records no lane statistics, so how many calls resolved is UNKNOWN, not zero')
    : ratio(calls - external, calls + unresolved);

  return {
    // What share of this pack's code symbols the profile's generatedSources
    // declaration classified as machine-written. `pct: null` when the pack has
    // no code axis at all; 0% when it has one and the profile declared nothing —
    // which is "nothing was classified", NOT "there is no generated code", and
    // the overview's `generated-code` gap is where that distinction is spelled
    // out with the edge counts behind it.
    generatedSymbols: ratio(generatedSymbols, symbols),
    // The share of JPA statements whose every part resolved to a column. `null`
    // (no denominator) when the pack carries no JPA statement at all — UNKNOWN,
    // never a comforting 100%.
    jpaStatementsResolved: ratio(jpaResolved, jpaStatements),
    // The two MyBatis-Plus numbers a reader has to have before trusting a
    // column answer on this pack: how many generic-CRUD statements name their
    // columns from the SOURCE rather than at run time, and how many of the
    // wrapper ops the lane saw actually produced a column. Both `null` when the
    // pack has no MyBatis-Plus at all — UNKNOWN, never a comforting 100%.
    mpStatementsResolved: ratio(mpResolved, mpStatements),
    mpWrapperColumnsResolved: laneStats && laneStats.mybatisPlus
      ? ratio(laneStats.mybatisPlus.wrappersWithColumns ?? 0, laneStats.mybatisPlus.wrappers ?? 0)
      : ratio(0, 0, 'this pack records no MyBatis-Plus lane statistics, so how many wrappers resolved to columns is UNKNOWN, not zero'),
    statementsWithColumnFacts: ratio(withColumnFacts, statements),
    statementsWithStringSubst: ratio(withStringSubst, statements),
    statementsWithUnknownSchema: ratio(schemaUnknown, statements),
    endpointsReachingAStatement: ratio(endpointsReaching, endpoints),
    // How much of the frontend this pack could attach to a route it serves. The
    // denominator is CALL SITES WITH A URL, not every call: a call whose URL is
    // a parameter was never a candidate, and counting it would make the lane
    // look worse than it is while hiding the calls that really did miss.
    // `null` when the pack has no web lane at all: UNKNOWN, not zero.
    webCallsResolved: laneStats && laneStats.web && laneStats.web.resolved
      ? ratio(
        (laneStats.web.resolved.SOUND_SET ?? 0) + (laneStats.web.resolved.HEURISTIC ?? 0),
        laneStats.web.calls && typeof laneStats.web.calls === 'object' ? (laneStats.web.calls.withUrl ?? 0) : 0,
      )
      : ratio(0, 0, 'this pack records no web lane statistics, so how many frontend calls reached an endpoint is UNKNOWN, not zero'),
    mapperMethodsBound: ratio(mapperMethodsBound, mapperMethods),
    callsResolved: callsRatio,
    exactAnswerable: ratio(exactAnswerable, statements),
  };
}

/**
 * The JPA census of a pack: how many tables an @Entity maps to, how many
 * repositories generate statements, and how many of those statements carry an
 * unresolved part. Counted off the nodes, so it needs no lane statistics.
 * @param {import('./graph.mjs').Graph} graph
 * @returns {{entities:number, repositories:number, statements:number, unresolvedStatements:number}}
 */
export function jpaCensus(graph) {
  const out = { entities: 0, repositories: 0, statements: 0, unresolvedStatements: 0 };
  const repos = new Set();
  for (const n of graph.nodes.values()) {
    if (n.kind === 'table' && n.jpaEntity) out.entities += 1;
    else if (n.kind === 'symbol' && n.repositoryMethod === true && n.owner) repos.add(n.owner);
    else if (n.kind === 'statement' && n.source === 'jpa') {
      out.statements += 1;
      if (n.hasUnresolved === true) out.unresolvedStatements += 1;
    }
  }
  out.repositories = repos.size;
  return out;
}

/**
 * The MyBatis-Plus census of a pack: how many tables an entity maps to, how many
 * generic-CRUD statements were generated, how many of those touch their table
 * with columns only decided at run time, and how many are a @TableLogic delete
 * rewritten into a write. Counted off the nodes, so it needs no lane statistics.
 * @param {import('./graph.mjs').Graph} graph
 * @returns {{entities:number, statements:number, statementsWithRuntimeOnlyColumns:number,
 *            logicDeleteStatements:number}}
 */
export function mpCensus(graph) {
  const out = { entities: 0, statements: 0, statementsWithRuntimeOnlyColumns: 0, logicDeleteStatements: 0 };
  for (const n of graph.nodes.values()) {
    if (n.kind === 'table' && n.mpEntity) out.entities += 1;
    else if (n.kind === 'statement' && n.source === 'mybatis-plus') {
      out.statements += 1;
      if (n.columnsRuntimeOnly === true) out.statementsWithRuntimeOnlyColumns += 1;
      if (n.mpEvidence && n.mpEvidence.logicDelete === true) out.logicDeleteStatements += 1;
    }
  }
  return out;
}

/**
 * Both halves, in one object. `graph` may be null (no pack yet) — the measured
 * half is then null and `measuredNote` says why, rather than the estimate
 * quietly shrinking to one half.
 *
 * @param {{discovery:Object, profile:Object, graph?:Object|null, pack?:Object|null,
 *          root?:string, project?:string|null, mode?:string, depth?:number}} input
 * @returns {Object}
 */
export function buildEstimate(input = {}) {
  const { discovery, profile = {}, graph = null, pack = null } = input;
  if (!discovery) throw new EstimateError('buildEstimate requires a discovery result');
  const before = estimateBefore(discovery, profile, {
    routes: pack && pack.laneStats && pack.laneStats.web && Number.isInteger(pack.laneStats.web.routes)
      ? pack.laneStats.web.routes : null,
  });
  const measured = graph
    ? {
      pack: {
        digest: pack?.digest ?? null,
        builtAt: pack?.builtAt ?? null,
        lanes: pack?.lanes ?? null,
        axes: pack?.axes ?? null,
      },
      ratios: measurePack(graph, { laneStats: pack?.laneStats ?? null, mode: input.mode, depth: input.depth }),
      jpa: jpaCensus(graph),
      mybatisPlus: mpCensus(graph),
    }
    : null;
  return {
    schema: ESTIMATE_SCHEMA,
    root: input.root ?? null,
    project: input.project ?? null,
    before,
    measured,
    measuredNote: measured ? null : 'no pack yet. Run `cascade analyze` and ask again. The half above is what an analysis is expected to ship',
  };
}

export class EstimateError extends Error {
  constructor(message) { super(message); this.name = 'EstimateError'; }
}
