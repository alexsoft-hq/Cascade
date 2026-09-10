// overview.mjs — "what is in this pack, how much of it is connected end to end,
// and what could the engine NOT see?"
//
// The landing page's one answer. Every other view asks about ONE thing (this
// endpoint, this column, these two groups); this one is the census of the whole
// pack, so a reader arriving cold can see its size, how much of it is wired
// from an HTTP route down to a table, and — in the same breath — what the
// engine could not resolve. The page never counts anything itself: if a number
// is on screen it came from here, so the picture and the engine cannot disagree.
//
// THE END-TO-END STORY IS A WALK, not a join. `reach` runs the SAME forward
// chain walk the Flow tab draws — through core/walks.mjs, the one place that
// walk lives, so this census, the `map` view and the `coupling` matrix cannot
// disagree about what an endpoint reaches. "152 of 889 statements are reached"
// means exactly what the Flow tab would draw one endpoint at a time. That also
// fixes what the number is NOT: an unreached statement is one no ANALYSED
// endpoint calls — a generated mapper method, typically — not dead code, and
// this module says so in `gaps` rather than leaving the reader to assume.
//
// Pure: graph in, plain view model out — no contract, no paging, no DOM. Lists
// come back WHOLE and sorted; the tool caps them and declares the cut.

import { walkEndpoints, walkScreens, multiHandlerRoutes } from './walks.mjs';
import { GRADE_SETS, FLOW_EDGE_TYPES } from './graph.mjs';

// The lattice order, strongest first — the order grades are reported in, so the
// census reads the way the policy lattice does rather than by whichever grade
// happened to be most common.
const GRADE_ORDER = Object.freeze(['EXACT', 'SOUND_SET', 'HEURISTIC', 'RUNTIME_ONLY', 'UNRESOLVED']);
// A statement node with no `statementType` — kept as its own bucket rather than
// dropped, so the type counts always sum to the statement count.
const UNTYPED = 'unknown';
/** How many duplicated FQNs the `duplicate-types` note names inline. */
const DUPLICATE_TYPES_NAMED = 3;

// How many multi-handler routes the gap NOTE names inline. The whole list is in
// `reach.samples.multiHandlerEndpoints`; the note is a sentence, not a table.
const MULTI_HANDLER_NAMED = 3;

/** What each `unresolvedCallsByReason` key MEANS, for the gap sentence. */
const UNRESOLVED_REASON_WORDS = Object.freeze({
  'project-type-outside-roots': 'name a type in a package of this project that no analyzed source root holds',
  'superclass-outside-roots': 'are `super.m()` into a base class this run could neither read nor name',
  'type-param-unbound': 'are on a receiver typed by a type parameter no class in this pack binds',
  unknown: 'we could not place at all',
});

/**
 * The reason split behind `unresolvedCalls`, as one sentence, or '' when the
 * pack records none (an older pack) or has nothing left unresolved.
 *
 * WRITTEN AS A CONTINUATION, not a paragraph: the count already said how big
 * the gap is, and this says what it is made of, which is the difference between
 * a number a reader distrusts and a number they can act on.
 * @param {Object|null} laneStats
 * @returns {string}
 */
function unresolvedReasonSentence(laneStats) {
  const by = laneStats && laneStats.unresolvedCallsByReason;
  if (!by || typeof by !== 'object') return '';
  const parts = Object.keys(UNRESOLVED_REASON_WORDS)
    .filter((k) => Number.isInteger(by[k]) && by[k] > 0)
    .map((k) => `${by[k]} ${UNRESOLVED_REASON_WORDS[k]}`);
  if (parts.length === 0) return '';
  return `. Of those, ${parts.join('; ')}`;
}

/**
 * The whole-pack census.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:'strict'|'conservative'|'heuristic', depth?:number,
 *          lanes?:string[]|null, laneStats?:{unresolvedCalls?:number}|null,
 *          axes?:Object|null}} [opts]
 *        lanes/laneStats/axes are pack metadata, passed in when the caller has
 *        them: they only sharpen the notes in `gaps`, never a count. `axes` is
 *        the pack's own per-axis declaration, and the catalog entry of it is
 *        what tells this census that the pack was built with no schema.
 * @returns {{mode:string, depth:number,
 *            nodes:{kind:string,count:number}[], edges:{type:string,grade:string,count:number}[],
 *            grades:{grade:string,count:number}[], statementTypes:{type:string,count:number}[],
 *            reach:object, code:object, hubs:object, gaps:{kind:string,count:number|null,note:string}[]}}
 */

/**
 * 1. THE NODE CENSUS, and the per-kind facts that only need the node itself.
 * One pass over every node; nothing here walks an edge.
 */
function censusNodes(graph) {
  // 1. The node census, and the per-kind facts that only need the node itself.
  const nodeCount = new Map();
  const statementTypeCount = new Map();
  const statementIds = [];
  const tableIds = [];
  const endpointIds = [];
  let columns = 0;
  let symbols = 0;
  let external = 0;
  let transactional = 0;
  // The JPA axis, counted off the NODES themselves so it works on any pack, with
  // or without lane statistics: a table an @Entity maps to, a statement Spring
  // Data generates, and — the number that matters — how many of those statements
  // the bridge could not fully resolve.
  // The generated census (SPEC §8.4). Counted off the NODES, so it works on any
  // pack: how many symbols the profile's generatedSources declaration
  // classified, and — the number that decides whether shipping them is worth it
  // — how many of them are a CLOSED ISLAND: reachable from no hand-written code
  // and reaching none. Measured on mall, all 8 377 of them are.
  let generatedSymbols = 0;
  // The ids, not just the count: the edge pass below needs a membership test per
  // edge END, and a Set hit is far cheaper than re-reading the node map twice
  // for every one of a hundred thousand edges.
  const generatedIds = new Set();
  let jpaEntities = 0;
  let jpaStatements = 0;
  let jpaUnresolved = 0;
  const jpaRepositories = new Set();
  // The MyBatis-Plus axis, counted off the NODES the same way: a table an entity
  // maps to, a statement its generic CRUD generates, and the two numbers that
  // decide how far to trust the answer — how many of those statements had a
  // wrapper this lane could read, and how many touch their table with columns
  // that are only decided at run time.
  let mpEntities = 0;
  let mpStatements = 0;
  let mpRuntimeOnly = 0;
  let mpUnresolved = 0;
  let mpLogicDelete = 0;
  for (const n of graph.nodes.values()) {
    nodeCount.set(n.kind, (nodeCount.get(n.kind) ?? 0) + 1);
    if (n.kind === 'statement') {
      statementIds.push(n.id);
      const t = n.statementType ?? UNTYPED;
      statementTypeCount.set(t, (statementTypeCount.get(t) ?? 0) + 1);
      if (n.source === 'jpa') {
        jpaStatements += 1;
        if (n.hasUnresolved === true) jpaUnresolved += 1;
      } else if (n.source === 'mybatis-plus') {
        mpStatements += 1;
        if (n.columnsRuntimeOnly === true) mpRuntimeOnly += 1;
        if (n.hasUnresolved === true) mpUnresolved += 1;
        if (n.mpEvidence && n.mpEvidence.logicDelete === true) mpLogicDelete += 1;
      }
    } else if (n.kind === 'table') {
      tableIds.push(n.id);
      if (n.jpaEntity) jpaEntities += 1;
      if (n.mpEntity) mpEntities += 1;
    } else if (n.kind === 'column') columns += 1;
    else if (n.kind === 'endpoint') endpointIds.push(n.id);
    else if (n.kind === 'symbol') {
      if (n.repositoryMethod === true && n.owner) jpaRepositories.add(n.owner);
      symbols += 1;
      // No source file = a type the Java lane never parsed (a library or
      // framework class it only saw referenced). Its methods are not in this
      // graph, so every chain through one stops there.
      if ((n.file ?? null) === null) external += 1;
      if (n.transactional === true) transactional += 1;
      if (n.generated === true) { generatedSymbols += 1; generatedIds.add(n.id); }
    }
  }
  statementIds.sort(cmp);
  tableIds.sort(cmp);
  endpointIds.sort(cmp);

  return {
    nodeCount, statementTypeCount, statementIds, tableIds, endpointIds, columns, symbols, external,
    transactional, generatedSymbols, generatedIds, jpaEntities, jpaStatements, jpaUnresolved,
    jpaRepositories, mpEntities, mpStatements, mpRuntimeOnly, mpUnresolved, mpLogicDelete,
  };
}

/**
 * 2. THE EDGE CENSUS, by type AND grade — "932 calls" says nothing without the
 * grades — and the two counts the generated rule turns on.
 */
function censusEdges(graph, mode, generatedIds) {
  // 2. The edge census (by type AND grade — "932 calls" says nothing without
  // "…and every one of them is a candidate"), plus the two facts that live on
  // the IMPLEMENTS_STMT edge: which symbols are mapper methods, and which
  // statements have one.
  const edgeCount = new Map(); // "TYPE|GRADE" -> count
  const gradeCount = new Map();
  const mapperMethods = new Set();
  const statementsWithMapper = new Set();
  let generatedInternalEdges = 0;  // generated -> generated (the machine-written interior)
  let generatedBoundaryEdges = 0;  // one end generated, one end not (a real chain enters it)
  let belowFloor = 0;   // flow edges this mode may not follow
  let onlyCandidate = 0; // flow edges this mode DOES follow that strict would refuse
  const allow = GRADE_SETS[mode];
  const isFlow = new Set(FLOW_EDGE_TYPES);
  // Hoisted: a pack that classified nothing must not pay a membership test per
  // edge end for a census that is going to be 0 either way.
  const anyGenerated = generatedIds.size > 0;
  for (const e of graph.edges) {
    edgeCount.set(`${e.type}|${e.grade}`, (edgeCount.get(`${e.type}|${e.grade}`) ?? 0) + 1);
    gradeCount.set(e.grade, (gradeCount.get(e.grade) ?? 0) + 1);
    if (e.type === 'IMPLEMENTS_STMT') { mapperMethods.add(e.from); statementsWithMapper.add(e.to); }
    if (anyGenerated) {
      const gf = generatedIds.has(e.from);
      if (gf === generatedIds.has(e.to)) { if (gf) generatedInternalEdges += 1; }
      else generatedBoundaryEdges += 1;
    }
    if (!isFlow.has(e.type)) continue;
    if (!allow.has(e.grade)) belowFloor += 1;
    else if (e.grade !== 'EXACT') onlyCandidate += 1;
  }

  return {
    edgeCount, gradeCount, mapperMethods, statementsWithMapper, generatedInternalEdges,
    generatedBoundaryEdges, belowFloor, onlyCandidate,
  };
}

/**
 * THE SCREEN AXIS CENSUS (RM30): the same forward walk `browse kind=screen`
 * lists, from the router's own declaration down to the tables.
 *
 * Computed only where there IS a screen axis, so a backend-only pack pays
 * nothing for it and its overview has no `screens` block to be mistaken for an
 * empty one.
 */
function screensCensus(graph, { mode, depth }, screenNodes, webScreenStats) {
  const sw = walkScreens(graph, { mode, depth });
  let reachingAnEndpoint = 0;
  let reachingATable = 0;
  let observedScreens = 0;
  let depthCutScreens = 0;
  const nexacroScreens = screenNodes.filter((n) => n.source === 'nexacro').length;
  for (const s of sw.screens) {
    if (s.endpoints.length > 0) reachingAnEndpoint += 1;
    if (s.tables.length > 0) reachingATable += 1;
    if (s.observed) observedScreens += 1;
    if (s.depthCut > 0) depthCutScreens += 1;
  }
  const screensBlock = {
    declared: webScreenStats ? (webScreenStats.declared ?? screenNodes.length) : screenNodes.length,
    screens: screenNodes.length,
    withComponent: screenNodes.filter((n) => n.component != null).length,
    // THREE KINDS OF SCREEN: one a router declares (RM48), one a controller
    // renders, and one a Nexacro client IS (RM56). A hybrid application has
    // more than one of them, and a single total would hide that.
    //
    // The third is named ONLY where there is one, because this answer is what
    // a caller reads and a key that appears everywhere at zero would say
    // "this product could have Nexacro screens" about every product there is.
    byKind: {
      router: screenNodes.filter((n) => n.source !== 'view' && n.source !== 'nexacro').length,
      page: screenNodes.filter((n) => n.source === 'view').length,
      ...(nexacroScreens > 0 ? { nexacro: nexacroScreens } : {}),
    },
    reachingAnEndpoint,
    reachingATable,
    componentUnresolved: webScreenStats ? (webScreenStats.componentUnresolved ?? 0) : 0,
    // A screen the SOURCE never declared: the router is filled in at run time,
    // or a recording found a page nothing here states.
    fromRecording: screenNodes.filter((n) => n.source === 'har').length,
    observed: observedScreens,
    // The screens a RECORDING says something about: one the source never
    // declared, or one whose call the browser was seen to make. Both are
    // RUNTIME_ONLY facts, so neither is counted inside any other number here.
    seenAtRunTime: screenNodes.filter((n) => n.observed === true || n.source === 'har').length,
    depthCut: depthCutScreens,
    serverDriven: !!(webScreenStats && webScreenStats.serverDriven && webScreenStats.serverDriven.detected === true),
    walk: sw.walk,
  };
  return screensBlock;
}

/**
 * 3. THE END-TO-END WALK, and everything derived from where it got to.
 */
function walkAxis(graph, { mode, depth, laneStats }, c) {
  const { endpointIds, statementIds, tableIds } = c;
  // 3. The end-to-end walk: the Flow tab's own forward chain, from every
  // handler of every route (core/walks.mjs caches by START node, so two routes
  // on the same handler walk the same chain once — and a route declared by TWO
  // controllers contributes BOTH, or the second module's code would be counted
  // as unreached).
  const { endpoints: walked, walk } = walkEndpoints(graph, { mode, depth });
  const reachedStatements = new Set();
  const endpointsWithoutStatement = [];
  const tableEndpoints = new Map();  // table node id -> Set(endpoint id)
  const tableStatements = new Map(); // table node id -> Set(statement node id)
  const endpointRows = [];
  let depthCapped = 0;
  for (const ep of walked) {
    const epId = ep.id;
    // What lies past the depth cap is unknown, not absent — an endpoint that hit
    // it makes every count below a LOWER BOUND, and that is said in `gaps`.
    if (ep.depthCut > 0) depthCapped += 1;
    if (ep.statements.length === 0) endpointsWithoutStatement.push(epId);
    const tables = new Set();
    for (const s of ep.statements) {
      const sid = s.id;
      reachedStatements.add(sid);
      for (const e of graph.outEdges(sid)) {
        if (e.type !== 'EXECUTES') continue;
        tables.add(e.to);
        addTo(tableEndpoints, e.to, epId);
        addTo(tableStatements, e.to, sid);
      }
    }
    endpointRows.push({
      endpoint: strip(epId), httpMethod: ep.httpMethod, path: ep.path,
      tables: tables.size, statements: ep.statements.length,
    });
  }

  // What the reached statements actually touch. Read from the STATEMENTS' own
  // edges, exactly as the Flow tab derives its tables lane — a table or column
  // is "reached" because a reached statement names it, never because the walk
  // had budget to step onto it.
  const reachedTables = new Set();
  const reachedColumns = new Set();
  for (const sid of reachedStatements) {
    for (const e of graph.outEdges(sid)) {
      if (e.type === 'EXECUTES') reachedTables.add(e.to);
      else if (e.type === 'READS' || e.type === 'WRITES') reachedColumns.add(e.to);
    }
  }

  const screenNodes = [];
  for (const n of graph.nodes.values()) if (n.kind === 'screen') screenNodes.push(n);
  const webScreenStats = laneStats && laneStats.web && laneStats.web.screens && typeof laneStats.web.screens === 'object'
    ? laneStats.web.screens : null;
  const screensBlock = screenNodes.length > 0
    ? screensCensus(graph, { mode, depth }, screenNodes, webScreenStats) : null;

  const multiHandler = multiHandlerRoutes(graph);
  const statements = statementIds.length;
  const tables = tableIds.length;
  // The endpoint NODES split in two: the routes this pack serves (what `reach`
  // is about) and the routes it only CALLS over HTTP. `walkEndpoints` excluded
  // the second kind, so the reach denominator must too — and the difference is
  // said out loud in `gaps` rather than left as two numbers that do not add up.
  const outboundEndpoints = walk.outboundEndpoints ?? 0;
  const endpoints = endpointIds.length - outboundEndpoints;
  const codeAxis = endpointIds.length > 0;
  const unreachedStatements = statementIds.filter((id) => !reachedStatements.has(id)).map(strip);
  const unreachedTables = tableIds.filter((id) => !reachedTables.has(id)).map(strip);

  return {
    walked, walk, reachedStatements, endpointsWithoutStatement, tableEndpoints, tableStatements,
    endpointRows, depthCapped, reachedTables, reachedColumns, screenNodes, webScreenStats,
    screensBlock, multiHandler, statements, tables, outboundEndpoints, endpoints, codeAxis,
    unreachedStatements, unreachedTables,
  };
}

/**
 * 4-5. HUBS — where the pack concentrates — and the one number that only means
 * anything when there IS a code axis.
 */
function hubsOf(c, e, reach) {
  const { statementsWithMapper } = e;
  const { codeAxis, endpointRows, statements, tableEndpoints, tableStatements } = reach;
  // 4. Hubs — where the pack concentrates. A table nothing reaches is not a hub,
  // so only the reached ones are ranked (their total IS tablesReached).
  const hubTables = [...tableEndpoints.entries()].map(([tid, eps]) => ({
    table: strip(tid), endpoints: eps.size, statements: (tableStatements.get(tid) ?? EMPTY_SET).size,
  })).sort((a, b) => (b.endpoints - a.endpoints) || (b.statements - a.statements) || cmp(a.table, b.table));
  const hubEndpoints = endpointRows.filter((r) => r.tables > 0)
    .sort((a, b) => (b.tables - a.tables) || (b.statements - a.statements) || cmp(a.endpoint, b.endpoint));

  // 5. Without a code axis there are no mapper methods AT ALL, so reporting
  // every statement as "missing its mapper" would count the absent lane twice —
  // the not-shipped gap says it once, and says it better.
  const statementsWithoutMapper = codeAxis ? statements - statementsWithMapper.size : 0;

  return { hubTables, hubEndpoints, statementsWithoutMapper };
}

/**
 * 6. THE HONESTY BLOCK. Every entry is COMPUTED; a gap with nothing to report is
 * left out rather than padded with a zero, except the two whose whole point is
 * that they are unknown or a standing caveat (unresolved-calls, mode-floor).
 * The order is the order the story is told in — fixed here, not data-driven, so
 * the list is deterministic without being alphabetised into nonsense.
 */
function buildGaps(o) {
  // 6. The honesty block. Every entry is COMPUTED; a gap with nothing to report
  // is left out rather than padded with a zero, except the two whose whole point
  // is that they are unknown or a standing caveat (unresolved-calls, mode-floor).
  // The order is the order the story is told in — fixed here, not data-driven,
  // so the list is deterministic without being alphabetised into nonsense.
  const gaps = [];
  // NO SCHEMA. This is the gap that changes the shape of every other answer, so
  // it is told first and it carries its own remedy: without a catalog the ERD
  // has no relationship lines at all (a join names two columns, and neither can
  // be attributed to a table), SELECT * cannot be expanded, and a column answer
  // holds what the SQL spelled out rather than the whole truth. `count` is the
  // tables that came from statements alone, because that number IS the size of
  const say = (gap) => gaps.push(gap);
  schemaGaps(o, say);
  routeGaps(o, say);
  laneGaps(o, say);
  reachGaps(o, say);
  budgetGaps(o, say);
  restGaps(o, say);
  return gaps;
}

/**
 * NO SCHEMA, NO CODE AXIS, NO PROJECT BOUNDARY. The three gaps that change the
 * shape of every other answer, so they are told first and each carries its own
 * remedy.
 */
function schemaGaps(o, say) {
  const {
    codeAxis, external, lanes, laneStats, opts, statements, tableIds,
  } = o;
  // what is standing in for a schema here.
  if (opts.axes && opts.axes.catalog && opts.axes.catalog.status === 'not-shipped') {
    say({
      kind: 'no-catalog', count: tableIds.length,
      note: 'no database schema was read for this pack, so the ERD draws no relationship line, a SELECT * is not expanded '
        + 'into the columns it reads, and a bare column name is tied to its table only where the SQL says so unambiguously. '
        + `The ${tableIds.length} table(s) here are the ones a statement named. Run \`cascade catalog fetch --candidate 1\` to pin one `
        + 'from the database this project already names, or `cascade analyze --ddl <schema.sql>` if the schema is a file you have',
    });
  }
  if (!codeAxis) {
    say({
      kind: 'not-shipped', count: statements,
      note: `we read this pack without the Java lane${lanes ? ` (lanes: ${lanes.join(' + ')})` : ''}, so it holds no endpoint at all. All ${statements} statement(s) here have no known caller, and the service, endpoint and @Transactional counts are absent, not empty`,
    });
  } else {
    const unresolved = laneStats && Number.isInteger(laneStats.unresolvedCalls) ? laneStats.unresolvedCalls : null;
    say({
      kind: 'unresolved-calls', count: unresolved,
      note: unresolved == null
        ? 'this pack kept no lane statistics, so we cannot say how many method calls we failed to resolve. It is not zero: a call we could not resolve never entered the graph, and any chain that needed one is shorter here than it really is'
        : `we couldn't tell what ${unresolved} method call${unresolved === 1 ? '' : 's'} point to, so they aren't in the graph. Any chain that needed one of them is shorter than it really is`
          // WHY, not just how many. A call into a library is resolved and
          // followed no further, and it is NOT here: this number is what the
          // analyzer could not place at all, and the split says what is behind
          // it — one of the four is a module nobody passed, and that one somebody
          // can fix.
          + unresolvedReasonSentence(laneStats),
    });
  }
  if (external > 0) {
    say({
      kind: 'external-symbols', count: external,
      note: `${external} symbol(s) have no source file here. They are library or framework types we only saw referenced, so a chain that runs into one stops there`,
    });
  }
}

/**
 * THE ROUTES THAT DO NOT ADD UP: a route this pack CALLS and does not serve, and
 * a route string two controllers both declare.
 */
function routeGaps(o, say) {
  const {
    endpoints, laneStats, multiHandler, outboundEndpoints,
  } = o;
  // A ROUTE THIS PACK CALLS AND DOES NOT SERVE. The method that calls it is in
  // the graph (a @FeignClient/@HttpExchange declaration, or an imperative
  // WebClient/RestClient/RestTemplate call), the route it names is in the graph,
  // and nothing here answers it: the chain ends at this pack's edge. Said before
  // the reach numbers, because those numbers count only the routes this pack
  // SERVES and a reader comparing them to the node census must know why.
  if (outboundEndpoints > 0) {
    const calls = laneStats && Number.isInteger(laneStats.httpCallsUnresolved) ? laneStats.httpCallsUnresolved : null;
    // The FRONTEND's misses are counted apart from the backend's. Both end at
    // this pack's edge, but they mean different things to fix: a Feign call that
    // leaves is another deployable, while a frontend call that leaves is as
    // often a prefix nobody declared as a real external service.
    const web = laneStats && laneStats.web && laneStats.web.unresolved ? laneStats.web : null;
    const webMisses = web ? (web.unresolved.byReason.noMatch ?? 0) + (web.unresolved.byReason.outsidePack ?? 0) : 0;
    say({
      kind: 'http-calls-leaving-pack', count: outboundEndpoints,
      note: `${outboundEndpoints} HTTP call target(s) leave this pack. ${calls == null ? 'HTTP client calls in the code' : `${calls} HTTP client call(s) in the code`} name a route no controller here serves, so what they reach is outside this analysis. `
        + `The node census counts them as endpoints; the reach figures below count only the ${endpoints} route(s) this pack serves`
        + (webMisses > 0
          ? `. ${webMisses} of those target(s) are named by the FRONTEND (${web.unresolved.byReason.noMatch ?? 0} matched no route here, ${web.unresolved.byReason.outsidePack ?? 0} name another host), which is as often a prefix nobody declared as a real external service: check the web axis reason before reading them as external`
          : ''),
    });
  }
  // A route string declared by TWO controllers is one endpoint node with two
  // HANDLES edges — a real fact about the pack (two modules, one route string),
  // not a mistake. Disclosed BEFORE the reach numbers it affects, because a
  // reader who sees the same route mapped twice and is told nothing will
  // conclude the analysis is wrong. Every count above walks the UNION of those
  // handlers; the Flow picture, which can only draw one chain, follows one and
  // says which.
  if (multiHandler.length > 0) {
    const named = multiHandler.slice(0, MULTI_HANDLER_NAMED)
      .map((m) => `${m.endpoint} (${m.handlers.length})`).join(', ');
    say({
      kind: 'multi-handler-routes', count: multiHandler.length,
      note: `${multiHandler.length} route(s) are declared by more than one controller method. The same route string sits in two modules, so the endpoint node carries ${multiHandler.length === 1 ? 'two HANDLES edges' : 'several HANDLES edges'}: ${named}${multiHandler.length > MULTI_HANDLER_NAMED ? `, and ${multiHandler.length - MULTI_HANDLER_NAMED} more` : ''}. The reach counts above follow every handler together; a single-chain view (flow) follows one of them and names the others`,
    });
  }
}

/**
 * WHAT ANOTHER SOURCE KNOWS AND THE SOURCE DOES NOT: an OpenAPI document, a
 * frontend that fetches its own menu, a browser recording, a trace.
 */
function laneGaps(o, say) {
  const {
    laneStats, screensBlock, webScreenStats,
  } = o;
  // THE DRIFT BETWEEN THE CONTRACT AND THE CODE. Two independent statements
  // about the same routes, and where they disagree only a reader can decide
  // which one is wrong — so the gap names both directions and neither verdict.
  const oa = laneStats && laneStats.openapi && laneStats.openapi.drift ? laneStats.openapi : null;
  if (oa && (oa.onlyInDocument > 0 || oa.onlyInCode > 0)) {
    const named = (list) => list.slice(0, 3).map(strip).join(', ');
    say({
      kind: 'openapi-drift', count: oa.onlyInDocument + oa.onlyInCode,
      note: `the OpenAPI document(s) and this code do not describe the same routes. `
        + `${oa.onlyInDocument} route(s) are declared and not served here`
        + (oa.onlyInDocument > 0 ? ` (${named(oa.drift.onlyInDocument)}${oa.onlyInDocument > 3 ? `, and ${oa.onlyInDocument - 3} more` : ''})` : '')
        + `, and ${oa.onlyInCode} route(s) are served here and declared by no document`
        + (oa.onlyInCode > 0 ? ` (${named(oa.drift.onlyInCode)}${oa.onlyInCode > 3 ? `, and ${oa.onlyInCode - 3} more` : ''})` : '')
        + '. A declared route nothing serves may be a service in another repository or a contract that has moved on; '
        + 'a served route no document declares is undocumented API. This engine reports both and judges neither',
    });
  }
  // THE SCREENS THE SOURCE DOES NOT HOLD. A frontend whose menu is fetched from
  // the server declares a handful of routes in the code and the rest arrive at
  // run time, so the screens in this pack are not the app. Said before every
  // screen number, because otherwise a reader takes 21 screens for the whole
  // product.
  if (webScreenStats && webScreenStats.serverDriven && webScreenStats.serverDriven.detected === true) {
    const sd = webScreenStats.serverDriven;
    say({
      kind: 'screens-from-server', count: sd.routes ?? 0,
      note: `the app also fetches its menu from the server at run time: one of its calls resolved to ${(sd.menuEndpoints ?? []).join(', ')}, and it declares ${sd.routes} route(s) in its source. `
        + `${(sd.routes ?? 0) < (sd.ceiling ?? 0) ? 'Most screens arrive when the app runs' : `Screens beyond the ${sd.routes} declared arrive when the app runs`}, `
        + 'so the screens in this pack are the ones the source states, not the ones the product has, and every screen count here is a lower bound. '
        + 'Set screenAxis.enabled to false if you would rather have no screen axis than a partial one',
    });
  }
  // WHAT ONLY A RECORDING KNOWS. A HAR is evidence the source does not carry:
  // a page nothing here declares, or a call no static rule could confirm. It is
  // named as a blind spot of the SOURCE rather than as a number beside the
  // walked ones, because no walk followed a RUNTIME_ONLY edge to produce it.
  if (screensBlock && screensBlock.seenAtRunTime > 0) {
    say({
      kind: 'screens-seen-at-run-time', count: screensBlock.seenAtRunTime,
      note: `${screensBlock.seenAtRunTime} screen(s) here are known partly from a recording: ${screensBlock.fromRecording} that the source never declared, and ${screensBlock.observed} whose call to a route a recording confirms. `
        + 'A recorded edge is RUNTIME_ONLY, which is below every mode\'s floor, so nothing was walked from one: it is shown beside these numbers and never counted inside them. '
        + 'What the recording did not visit is unknown, not absent',
    });
  }
  // WHAT A TRACE SAW RUN. The same posture as the recording gap above, one lane
  // further in: a trace resolves the dispatch a static reading could only grade
  // as a candidate set, and it resolves it for the paths that were EXERCISED and
  // for no others. So the count is stated as coverage, and the sentence says out
  // loud that an unobserved candidate was not visited rather than shown dead.
  const otel = laneStats && laneStats.otel && typeof laneStats.otel === 'object' ? laneStats.otel : null;
  if (otel) {
    const narrowed = otel.dispatchThroughInterface ?? 0;
    say({
      kind: 'runtime-evidence',
      count: (otel.edgesObserved ?? 0) + (otel.edgesAdded ?? 0),
      note: `a trace of ${otel.spans ?? 0} span(s) confirmed ${otel.edgesObserved ?? 0} edge(s) this analysis already had, `
        + `${narrowed} of them a candidate set it could only grade SOUND_SET, and added ${otel.edgesAdded ?? 0} edge(s) graded RUNTIME_ONLY for a hop no static rule explains. `
        + `${otel.statementsObserved ?? 0} statement(s) and ${otel.endpointsObserved ?? 0} route(s) were seen to run. `
        + 'Not one grade was raised or lowered by any of it, and coverage is only what the capture exercised: '
        + 'a candidate the trace did not visit is unknown, not dead',
    });
  }
}

/**
 * WHAT THE WALK DID NOT REACH: a screen with no component, a route with no
 * statement, a statement and a table nothing runs.
 */
function reachGaps(o, say) {
  const {
    depth, endpointsWithoutStatement, mode, screensBlock, statements, tables,
    unreachedStatements, unreachedTables,
  } = o;
  if (screensBlock && screensBlock.componentUnresolved > 0) {
    say({
      kind: 'screen-components-unresolved', count: screensBlock.componentUnresolved,
      note: `${screensBlock.componentUnresolved} of ${screensBlock.declared} route declaration(s) name a component this lane could not resolve to a file it read. `
        + 'Those screens are in the pack with no RENDERS edge, so nothing hangs off them: what they show is unknown, not empty. '
        + 'The failing specifiers are on laneStats.web.screens.unresolvedSpecifiers, and an alias or a source root is usually what is missing',
    });
  }
  if (endpointsWithoutStatement.length > 0) {
    say({
      kind: 'endpoints-without-statement', count: endpointsWithoutStatement.length,
      note: `${endpointsWithoutStatement.length} endpoint(s) reach no SQL statement at mode=${mode}, depth ${depth}. They may touch no database at all (login, file upload), or we could not tell where one of their calls goes`,
    });
  }
  if (unreachedStatements.length > 0) {
    say({
      kind: 'statements-not-reached', count: unreachedStatements.length,
      note: `${unreachedStatements.length} of ${statements} statement(s) are not reached from the endpoints we analysed, and they are usually generated mapper methods nothing calls. That is NOT a claim that they are dead code: a caller outside this pack, such as a scheduled job, another service or reflection, would not be visible here`,
    });
  }
  if (unreachedTables.length > 0) {
    say({
      kind: 'tables-not-reached', count: unreachedTables.length,
      note: `${unreachedTables.length} of ${tables} table(s) are not reached from any endpoint. A statement may still execute them; what is missing is the HTTP route above`,
    });
  }
}

/**
 * WHAT THE WALK DELIBERATELY DID NOT LOOK AT: the generated interior, the node
 * cap and the depth cap. A bound on this answer is not an absence.
 */
function budgetGaps(o, say) {
  const {
    depth, depthCapped, generatedBoundaryEdges, generatedInternalEdges, generatedSymbols,
    symbols, walk,
  } = o;
  if (generatedSymbols > 0) {
    say({
      kind: 'generated-code', count: generatedSymbols,
      note: `${generatedSymbols} of ${symbols} symbol(s) are machine-written. The profile's generatedSources declaration classified them, `
        + `and they carry ${generatedInternalEdges} edge(s) among themselves. `
        + (generatedBoundaryEdges === 0
          ? 'No edge joins them to hand-written code, so they sit on an island of their own: nothing above counts on them, and neither does any question you ask. They are still shipped, because the pack states what we saw, and this number is what dropping them would save'
          : `${generatedBoundaryEdges} edge(s) join them to hand-written code, so a real chain does run through them. They are walked when a real caller reaches them, and only the interior above is skipped`),
    });
  }
  if (walk.generated > 0) {
    say({
      kind: 'generated-walk-skip', count: walk.generated,
      note: `${walk.generated} step(s) from one generated symbol to another were not walked, because that is the machine-written interior. A generated symbol a real caller reaches is still walked and still counted above`,
    });
  }
  if (walk.nodeCapStarts > 0) {
    say({
      kind: 'node-cap', count: walk.nodeCapStarts,
      note: `${walk.nodeCapStarts} handler walk(s) hit the per-walk node cap. The chain under them is bigger than one walk, so we counted only part of what those routes reach`,
    });
  }
  if (depthCapped > 0) {
    say({
      kind: 'depth-cap', count: depthCapped,
      note: `${depthCapped} endpoint(s) still had calls to walk when we stopped at depth ${depth}. What lies past that is unknown, so each "reached" count here is a lower bound: the real number is this one or higher`,
    });
  }
}

/**
 * THE LAST FOUR: one FQN in two files, a JPA statement with an unresolved part,
 * a MyBatis-Plus statement whose columns are built at run time, and the two that
 * are always said — what did not resolve, and where the mode floor sits.
 */
function restGaps(o, say) {
  const {
    belowFloor, depth, jpaStatements, jpaUnresolved, laneStats, mode, mpRuntimeOnly,
    mpStatements, onlyCandidate,
  } = o;
  // THE SAME FQN, DECLARED IN TWO FILES. A multi-module repo does this on
  // purpose (jeecg-boot ships three API interfaces twice: a plain interface in
  // the local module, a @FeignClient in the cloud one). One FQN is one node, so
  // nothing is doubled and nothing is dropped — but a reader who sees
  // `ISysBaseAPI` once, with edges from two modules on it, has no way to know
  // that unless the pack says so. Measured on jeecg-boot: reversing which
  // declaration the fact stream ends with moves zero edges and zero nodes, so
  // this is a disclosure, not a defect.
  const dup = laneStats && laneStats.duplicateFqns && Number.isInteger(laneStats.duplicateFqns.count)
    ? laneStats.duplicateFqns : null;
  if (dup && dup.count > 0) {
    const kinds = Object.entries(dup.byKind).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, n]) => `${k} ${n}`).join(', ');
    const named = (dup.types ?? []).slice(0, DUPLICATE_TYPES_NAMED).map((d) => d.fqn).join(', ');
    say({
      kind: 'duplicate-types', count: dup.count,
      note: `${dup.count} type(s) are declared in more than one file (${dup.declarations} declarations in total: ${kinds}). `
        + 'The same fully-qualified name sits in two modules that are never on one classpath. '
        + `They are ONE node each, so no count above is doubled; what the graph keeps for each is whichever declaration the fact stream ended with${named ? `. ${named}` : ''}`,
    });
  }
  if (jpaUnresolved > 0) {
    say({
      kind: 'jpa-statements-unresolved', count: jpaUnresolved,
      note: `${jpaUnresolved} of ${jpaStatements} JPA statement(s) carry a part we could not resolve: a derived method name, or a JPQL fragment the bridge could not tie to a column. The statement is KEPT with its reason, and its column list holds what we could read rather than the whole truth`,
    });
  }
  if (mpRuntimeOnly > 0) {
    say({
      kind: 'mp-columns-runtime-only', count: mpRuntimeOnly,
      note: `${mpRuntimeOnly} of ${mpStatements} MyBatis-Plus statement(s) reach their table with columns decided at RUN TIME. A condition wrapper built from request parameters, or handed in already built, names columns no source line states. `
        + 'The TABLE is certain; the column list on those statements holds only what we could read, and `column_impact` on any column of those tables says so in its limits',
    });
  }
  say({
    kind: 'mode-floor', count: belowFloor,
    note: `walked at mode=${mode}, depth ${depth}: ${belowFloor} flow edge(s) sit below this mode's grade floor, so we did not follow them`
      + (onlyCandidate > 0
        ? `. mode=strict would refuse ${onlyCandidate} more: where a controller reaches its service only through a MAY_CALL edge, which means the call may happen but we could not prove it, a strict walk from a handler reaches nothing at all`
        : '. This census is already at the strictest floor, so nothing here rests on a call we could not prove'),
  });
}

/**
 * THE TWO LANES THE GRAPH ALONE CANNOT DESCRIBE, from their own statistics.
 *
 * The graph cannot say how many frontend calls there were, only how many became
 * an edge; and it cannot say what a document DECLARED, only what the code
 * serves. Each block is ABSENT rather than zeroed on a pack whose lane did not
 * run, so "no frontend calls" and "no frontend was read" cannot be confused.
 */
function laneBlocks(laneStats) {
  const out = {};
  if (laneStats && laneStats.web && laneStats.web.resolved) {
    out.web = {
      calls: laneStats.web.calls?.withUrl ?? 0,
      resolved: {
        SOUND_SET: laneStats.web.resolved.SOUND_SET ?? 0,
        HEURISTIC: laneStats.web.resolved.HEURISTIC ?? 0,
      },
      unresolved: laneStats.web.unresolved?.total ?? 0,
      outbound: laneStats.web.outboundEndpoints ?? 0,
      prefix: Object.entries(laneStats.web.prefix ?? {}).sort(([a], [b]) => cmp(a, b))
        .flatMap(([dir, p]) => (p.instances ?? []).map((i) => ({
          package: dir, instance: i.id, value: i.value, from: i.from,
        }))),
    };
  }
  if (laneStats && laneStats.openapi && laneStats.openapi.drift) {
    out.openapi = {
      documents: (laneStats.openapi.documents ?? []).map((d) => ({
        path: d.path, version: d.version, basePath: d.basePath ?? '',
        paths: d.paths ?? 0, matchedServed: d.matchedServed ?? 0, onlyInDocument: d.onlyInDocument ?? 0,
        unreadable: (d.unreadable ?? []).length,
      })),
      paths: laneStats.openapi.paths ?? 0,
      matchedServed: laneStats.openapi.matchedServed ?? 0,
      onlyInDocument: laneStats.openapi.onlyInDocument ?? 0,
      onlyInCode: laneStats.openapi.onlyInCode ?? 0,
      samples: {
        onlyInDocument: (laneStats.openapi.drift.onlyInDocument ?? []).slice(0, 10).map(strip),
        onlyInCode: (laneStats.openapi.drift.onlyInCode ?? []).slice(0, 10).map(strip),
      },
    };
  }
  return out;
}

export function buildOverview(graph, opts = {}) {
  const mode = opts.mode ?? 'conservative';
  if (!GRADE_SETS[mode]) throw new OverviewError(`unknown mode: ${JSON.stringify(mode)}`);
  const depth = opts.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1) throw new OverviewError(`depth must be a positive integer, got ${depth}`);
  const lanes = Array.isArray(opts.lanes) ? opts.lanes : null;
  const laneStats = opts.laneStats && typeof opts.laneStats === 'object' ? opts.laneStats : null;
  const c = censusNodes(graph);
  const e = censusEdges(graph, mode, c.generatedIds);
  const r = walkAxis(graph, { mode, depth, laneStats }, c);
  const h = hubsOf(c, e, r);
  const o = { mode, depth, lanes, laneStats, opts, ...c, ...e, ...r, ...h };
  const gaps = buildGaps(o);
  // The answer reads what the four censuses produced, by name: an explicit list
  // is the one thing that keeps a field on the answer and the number behind it
  // from drifting apart.
  const {
    columns, endpoints, endpointsWithoutStatement, external, generatedBoundaryEdges,
    generatedInternalEdges, generatedSymbols, hubEndpoints, hubTables, jpaEntities,
    jpaRepositories, jpaStatements, jpaUnresolved, mapperMethods, mpEntities, mpLogicDelete,
    mpRuntimeOnly, mpStatements, mpUnresolved, multiHandler, nodeCount, outboundEndpoints,
    reachedColumns, reachedStatements, reachedTables, screensBlock, statementTypeCount,
    statements, statementsWithoutMapper, symbols, tables, transactional, unreachedStatements,
    unreachedTables, edgeCount, gradeCount,
  } = o;
  return {
    mode,
    depth,
    nodes: [...nodeCount.entries()].map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => (b.count - a.count) || cmp(a.kind, b.kind)),
    edges: [...edgeCount.entries()].map(([k, count]) => {
      const bar = k.indexOf('|');
      return { type: k.slice(0, bar), grade: k.slice(bar + 1), count };
    }).sort((a, b) => (b.count - a.count) || cmp(a.type, b.type) || cmp(a.grade, b.grade)),
    grades: GRADE_ORDER.filter((g) => gradeCount.has(g)).map((grade) => ({ grade, count: gradeCount.get(grade) })),
    statementTypes: [...statementTypeCount.entries()].map(([type, count]) => ({ type, count }))
      .sort((a, b) => (b.count - a.count) || cmp(a.type, b.type)),
    reach: {
      endpoints,
      // Routes the pack CALLS over HTTP and does not serve. `endpoints` above
      // excludes them, so the two always add up to the endpoint node count.
      outboundEndpoints,
      endpointsWithoutStatement: endpointsWithoutStatement.length,
      // How many routes more than one controller method declares. The walk above
      // covers every one of their handlers; this is the count that says so.
      endpointsWithMultipleHandlers: multiHandler.length,
      statements,
      statementsReached: reachedStatements.size,
      tables,
      tablesReached: reachedTables.size,
      columns,
      columnsReached: reachedColumns.size,
      samples: {
        endpointsWithoutStatement: endpointsWithoutStatement.map(strip).sort(cmp),
        unreachedStatements: unreachedStatements.slice().sort(cmp),
        unreachedTables: unreachedTables.slice().sort(cmp),
        // {endpoint, handlers[]} — the route and every method that declares it,
        // so a reader can see WHICH two modules collide rather than being asked
        // to trust a count.
        multiHandlerEndpoints: multiHandler,
      },
    },
    code: {
      symbols, external, transactional, mapperMethods: mapperMethods.size, statementsWithoutMapper,
      // What the MyBatis-Plus lane added to the CODE axis: entities mapped,
      // built-in statements generated, and how many of those name their columns
      // only at run time. Reported here as well as under `mybatisPlus` because
      // this is the block a reader looks at to size the code axis.
      mpEntities, mpBuiltinStatements: mpStatements, mpStatementsRuntimeOnlyColumns: mpRuntimeOnly,
      // 0 on a project that declared no generatedSources — which is "nothing was
      // classified", NOT "there is no generated code here". `gaps` says which.
      generated: generatedSymbols,
      generatedInternalEdges,
      generatedBoundaryEdges,
    },
    jpa: {
      entities: jpaEntities,
      repositories: jpaRepositories.size,
      statements: jpaStatements,
      unresolvedStatements: jpaUnresolved,
    },
    // The screen axis: how many screens the router declares, how many of them
    // this analysis can follow to a route and to a table, and how many it could
    // not resolve a component for. Absent (rather than zeroed) on a pack with no
    // screen axis, so "no screen reaches a table" and "no screen was built"
    // cannot be confused.
    ...(screensBlock ? { screens: screensBlock } : {}),
    ...laneBlocks(laneStats),
    mybatisPlus: {
      entities: mpEntities,
      statements: mpStatements,
      statementsWithRuntimeOnlyColumns: mpRuntimeOnly,
      unresolvedStatements: mpUnresolved,
      logicDeleteStatements: mpLogicDelete,
      // From the lane, when the caller wired it: how many wrapper OPS were seen
      // and how many columns came out of them. The graph alone cannot say —
      // a resolved wrapper column is indistinguishable from a mapped one once
      // it is an edge.
      ...(laneStats && laneStats.mybatisPlus ? {
        wrappers: laneStats.mybatisPlus.wrappers ?? 0,
        wrapperOps: laneStats.mybatisPlus.ops ?? 0,
        wrappersResolvedToColumns: laneStats.mybatisPlus.wrappersWithColumns ?? 0,
        wrappersRuntimeOnly: laneStats.mybatisPlus.wrappersRuntimeOnly ?? 0,
        wrapperColumnsFromMethodReference: laneStats.mybatisPlus.columnsFromMethodReference ?? 0,
        wrapperColumnsFromLiteral: laneStats.mybatisPlus.columnsFromLiteral ?? 0,
        opsUninterpreted: laneStats.mybatisPlus.opsUninterpreted ?? {},
      } : {}),
    },
    hubs: { tables: hubTables, endpoints: hubEndpoints },
    gaps,
  };
}

const EMPTY_SET = new Set();


function addTo(map, key, val) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(val);
}
function strip(id) { return id.slice(id.indexOf(':') + 1); }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class OverviewError extends Error {
  constructor(message) { super(message); this.name = 'OverviewError'; }
}


