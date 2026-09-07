// tools.mjs — the MCP query surface over a loaded graph (SQL axis, SPEC §13).
//
// These are the calls an AI makes instead of grepping. Each returns a
// contract-valid response (basis/trust/limits/truncated) via mcp/contract, so
// the AI receives the answer WITH its confidence, limits, and truncation — a
// cut list is never mistaken for complete, 0 results never read as "safe".
//
// SQL-axis subset for the current vertical slice:
//   - column_impact : change a column → which statements read/write it
//   - table_usage   : which statements touch a table, and its columns' r/w counts
//   - search        : find a table/column/statement by name substring (entry point)
//   - browse        : one KIND of thing, listed, with the numbers to pick by
//
// Every SQL-lane edge is EXACT (direct facts), so these answers are confirmed;
// when the code axis (Java lane) lands, the same tools gain candidate grades and
// the response contract already carries them.

import { nodeId, FLOW_EDGE_TYPES } from '../core/graph.mjs';
import { changeImpact } from '../core/overlay.mjs';
import { chainWalk, nodeLabel } from '../core/chain.mjs';
import { buildCoupling, SHARED_AT } from '../core/coupling.mjs';
import { buildMap, LAYERS as MAP_LAYERS, DEFAULT_LIMIT as MAP_LIMIT_DEFAULT } from '../core/map.mjs';
import { buildOverview } from '../core/overview.mjs';
import {
  handlersOf, primaryHandlerOf, walkEndpoints, walkScreens, groupOfEndpoint, frontendCallsOf,
  screensAffecting, observedCall,
} from '../core/walks.mjs';
import { resolveSchemaName } from '../core/name_resolve.mjs';
import { endpointsAffectingColumn } from '../adapters/java_bridge.mjs';
import { makeResponse } from './contract.mjs';
import { NO_STATE_TRUST_LEVEL } from '../core/trust.mjs';

/**
 * The trust block a tool attaches to its answer. `trustLevel` is never written
 * here as a literal (SPEC §14.3 MUST): the server computes it from the gate
 * state and the golden corpus and puts it on `ctx`, and a caller that wired no
 * state at all still gets a COMPUTED level — `NO_STATE_TRUST_LEVEL` is the
 * return value of `computeTrust({})`, not a constant somebody typed.
 * `gatesNotShown` travels with it, so an answer names the quality gates that
 * were never demonstrated instead of leaving their absence to be assumed.
 * @param {Object} ctx
 * @param {string[]} axes  the gate axes THIS answer leaned on
 */
function trustFor(ctx, axes) {
  return {
    trustLevel: ctx.trust?.trustLevel ?? NO_STATE_TRUST_LEVEL,
    axes,
    gatesNotShown: ctx.trust?.gatesNotShown ?? [],
    knownGaps: ctx.trust?.knownGaps ?? [],
  };
}

const LIMITS = { default: 25, max: 100 };
const REACH_MODE = { strict: 'strict', conservative: 'conservative', heuristic: 'heuristic' };
// Own-property lookup only: a plain-object read would accept 'constructor' or
// '__proto__' as a mode and let it through to the engine as a 500.
const reachMode = (m) => (Object.hasOwn(REACH_MODE, m) ? REACH_MODE[m] : undefined);
// The next mode that would look wider than this one; null when already widest.
const widerMode = (m) => (m === 'strict' ? 'conservative' : m === 'conservative' ? 'heuristic' : null);

/** column_impact — "if I change this column, which statements break?" */
export function column_impact(graph, args, ctx) {
  const col = schemaArg(graph, ctx, 'column', req(args, 'column'));
  const column = col.key;
  const mode = args.mode || 'both'; // read | write | both
  const { limit, offset } = paging(args);
  const colId = col.id;

  const items = [];
  for (const e of graph.edges) {
    if (e.to !== colId) continue;
    if (e.type === 'READS' && mode !== 'write') items.push({ id: strip(e.from), access: 'read', grade: e.grade });
    else if (e.type === 'WRITES' && mode !== 'read') items.push({ id: strip(e.from), access: 'write', grade: e.grade });
  }
  items.sort(byAccessThenId);
  const node = graph.nodes.get(colId);
  const answer = listAnswer(
    'statements', items, limit, offset,
    { column, comment: node.comment ?? null, type: node.type ?? null },
    axisStatus(graph, ctx, 'statements') === 'not-shipped' ? 'not-shipped' : 'none',
  );
  return respond(ctx, answer, ['column'], node, [...col.limits, ...runtimeColumnLimits(graph, colId)]);
}

/**
 * THE LIMIT A MyBatis-Plus COLUMN ANSWER MUST CARRY.
 *
 * A statement whose condition wrapper is built at run time
 * (`QueryGenerator.initQueryWrapper(object, request.getParameterMap())`) touches
 * a KNOWN table with an UNKNOWN column list. The engine cannot put a READS edge
 * on any particular column of that table without inventing one — so it puts
 * none, and the list above is then short by however many of those there are.
 *
 * Saying nothing would let a reader take a 3-statement answer as the whole
 * truth. Naming the count and the statements is the honest partial answer: "3
 * statements name this column, and 12 more touch this table with columns
 * decided at run time — one of them may be this column."
 *
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {string} colId
 * @returns {{scope:string, reason:string}[]}
 */
function runtimeColumnLimits(graph, colId) {
  // The column's table, from the DECLARES edge the catalog/bridges put there.
  let tableId = null;
  for (const e of graph.inEdges(colId)) {
    if (e.type === 'DECLARES') { tableId = e.from; break; }
  }
  if (!tableId) return [];
  const stmts = [];
  for (const e of graph.inEdges(tableId)) {
    if (e.type !== 'EXECUTES') continue;
    const n = graph.nodes.get(e.from);
    if (n && n.columnsRuntimeOnly === true) stmts.push(e.from.slice('statement:'.length));
  }
  if (stmts.length === 0) return [];
  stmts.sort();
  const table = tableId.slice('table:'.length);
  return [{
    scope: `runtime-only-columns:${table}`,
    reason: `${stmts.length} statement(s) touch ${table} with columns decided at RUN TIME. A MyBatis-Plus condition wrapper built from request parameters names no column any source line states, so we emit no column edge for those rather than guess one. `
      + `The list above is therefore a LOWER BOUND for this column, and the real answer is that list or bigger: ${stmts.slice(0, 5).join(', ')}${stmts.length > 5 ? `, … (${stmts.length - 5} more)` : ''}`,
  }];
}

/**
 * endpoint_impact — "if I change this column, which HTTP endpoints are affected?"
 * Walks the stitched code axis backward (column ← statement ← mapper ← service ←
 * handler ← endpoint). Each endpoint carries the WEAKEST-link grade on its path:
 * the SQL links are EXACT but the call chain is SOUND_SET, so an endpoint reached
 * through the call graph is reported SOUND_SET — a candidate, never confirmed.
 */
export function endpoint_impact(graph, args, ctx) {
  const col = schemaArg(graph, ctx, 'column', req(args, 'column'));
  const column = col.key;
  const { limit, offset } = paging(args);
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const colId = col.id;

  const eps = endpointsAffectingColumn(graph, colId, { mode });
  // `viaHttp` rides through: a route reached only across an internal HTTP hop is
  // affected through another deployable, and the row says so (SPEC §1.1).
  const items = eps.map((e) => {
    // How many frontend functions call this route. Present only when there are
    // some: on a pack with no web lane the field would read as "no screen calls
    // this", when the truth is that no frontend was analyzed.
    const frontend = frontendCallsOf(graph, e.endpoint);
    const n = graph.nodes.get(e.endpoint);
    return {
      id: e.endpoint.slice('endpoint:'.length), httpMethod: e.httpMethod, path: e.path, grade: e.pathGrade,
      ...(e.viaHttp ? { viaHttp: true, httpHops: e.httpHops } : {}),
      ...(frontend > 0 ? { frontendCalls: frontend } : {}),
      // A recording or a trace saw this route serve a request. It sits BESIDE
      // the grade and never inside it: a route nothing observed is a route this
      // capture did not visit, not a route nothing reaches.
      ...(n && n.observed === true ? { observed: true } : {}),
    };
  });
  // strongest grade first, then id — mirror the other tools' ordering intent.
  items.sort((a, b) => (a.grade !== b.grade ? gradeRank(b.grade) - gradeRank(a.grade) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  const shown = items.slice(offset, offset + limit);
  // WHICH SCREENS ARE ON THE OTHER SIDE of each affected route. Folded per
  // endpoint from the same backward walk, and computed only for the rows this
  // answer actually shows: a reader paging through 300 endpoints must not pay
  // for 300 forward walks they will never read. Absent on a pack with no screen
  // axis, because `{count: 0}` there would read as "no screen calls this".
  if (axisStatus(graph, ctx, 'screen') !== 'not-shipped') {
    for (const row of shown) {
      const epId = nodeId('endpoint', row.id);
      const screens = screensAffecting(graph, epId, { mode }).map((s) => s.path ?? strip(s.screen));
      row.screens = { count: screens.length, sample: screens.slice(0, 5) };
    }
  }
  const node = graph.nodes.get(colId);
  const answer = { column, comment: node.comment ?? null, endpoints: shown };
  if (shown.length === 0) {
    // Distinguish "this pack carries no code axis" (Java lane not run) from
    // "the code axis is present but nothing reaches this column".
    answer.empty = { endpoints: items.length > 0 ? 'not-in-this-axis' : (hasCodeAxis(graph, ctx) ? 'none' : 'not-shipped') };
  }
  const trunc = [truncField('endpoints', shown.length, items.length, offset)];
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: trustFor(ctx, ['column', 'endpoint']),
    limits: [...(ctx.limits ?? []), ...col.limits],
    truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

// ---- the screen axis: one census, shared by every view that counts on it ----
//
// `walkScreens` is the mirror of `walkEndpoints`, one lane further out, and it
// costs the same: one forward chain walk per screen. So it is run ONCE per pack
// and kept on the graph object, exactly as the browse census is, and every view
// that wants "how many routes does this screen reach?" reads the same numbers.
const SCREEN_CENSUS = new WeakMap();
const SCREEN_CENSUS_MODE = 'conservative';
const SCREEN_CENSUS_DEPTH = 8;

/**
 * The per-pack screen census, computed once and kept on the graph.
 * @param {import('../core/graph.mjs').Graph} graph
 */
function screenCensus(graph) {
  const cached = SCREEN_CENSUS.get(graph);
  if (cached) return cached;
  const w = walkScreens(graph, { mode: SCREEN_CENSUS_MODE, depth: SCREEN_CENSUS_DEPTH });
  const rows = w.screens.map((s) => ({
    id: s.id,
    path: s.path,
    label: s.label,
    title: s.title,
    group: s.group,
    component: s.component,
    source: s.source,
    observed: s.observed,
    depthCut: s.depthCut,
    endpoints: new Set(s.endpoints.map((e) => e.id)),
    statements: new Set(s.statements.map((x) => x.id)),
    tables: new Set(s.tables.map((t) => t.id)),
  }));
  const census = { rows, walk: w.walk };
  SCREEN_CENSUS.set(graph, census);
  return census;
}

/**
 * The screen census read from the SCHEMA's side: which screens reach each table
 * and each column. One pass over the census the whole pack already paid for
 * (`screenCensus`), memoised on the graph the same way, because `browse
 * kind=table` builds every row of the pack at once and a per-row backward walk
 * there would be one walk per table.
 *
 * A screen reaches a COLUMN when one of the statements its forward walk reached
 * READS or WRITES that column — the same rule the endpoint census in
 * `browseCensus` uses one lane in, so the `api` and `scr` counts on a row are
 * two readings of one walk rather than two different questions.
 *
 * @param {import('../core/graph.mjs').Graph} graph
 * @returns {{tables:Map<string,Set<string>>, columns:Map<string,Set<string>>}}
 */
const SCREEN_REACH = new WeakMap();
function screenReach(graph) {
  const cached = SCREEN_REACH.get(graph);
  if (cached) return cached;
  const tables = new Map();
  const columns = new Map();
  const add = (m, k, v) => { let s = m.get(k); if (!s) m.set(k, s = new Set()); s.add(v); };
  for (const r of screenCensus(graph).rows) {
    for (const tid of r.tables) add(tables, tid, r.id);
    for (const sid of r.statements) {
      for (const e of graph.outEdges(sid)) {
        if (e.type === 'READS' || e.type === 'WRITES') add(columns, e.to, r.id);
      }
    }
  }
  const out = { tables, columns };
  SCREEN_REACH.set(graph, out);
  return out;
}

/** The one sentence every screen-census answer owes its reader. */
function screenWalkLimit() {
  return {
    scope: 'screen',
    reason: `a screen reaches a route because a walk (mode=${SCREEN_CENSUS_MODE}, depth ${SCREEN_CENSUS_DEPTH}) goes from its RENDERS functions through the frontend's own calls to that route. It is the same forward walk \`flow\` draws, so what a deeper or wider walk would add is unknown, not absent. A recording (\`observed\`) is shown beside these numbers and never counted inside them: a RUNTIME_ONLY edge is below every mode's floor and no walk follows one`,
  };
}

/** Why a screen list is empty: an axis that never ran, or one that found none. */
function screenNoneReason(graph, ctx) {
  return axisStatus(graph, ctx, 'screen') === 'not-shipped' ? 'not-shipped' : 'none';
}

/**
 * screen_impact — "if I change this column / table / statement / method, which
 * SCREENS are affected?" The far end of the round trip (SPEC §1.1), read the
 * way `endpoint_impact` reads the near end: the same backward walk, carried two
 * lanes further out through the frontend's own calls and the RENDERS edge.
 *
 * Each row names the endpoints the screen goes through, so the answer can be
 * checked rather than taken, and `observed` says whether a recording confirms
 * the browser really made one of those calls from that screen.
 */
export function screen_impact(graph, args, ctx) {
  args = args || {};
  const kinds = ['column', 'table', 'statement', 'symbol'];
  const given = kinds.filter((k) => args[k] != null && args[k] !== '');
  if (given.length > 1) throw new ToolError('bad-input', `pass exactly one of ${kinds.join(' / ')}, got ${given.join(', ')}`);
  if (given.length === 0) throw new ToolError('bad-input', `screen_impact needs a target: one of ${kinds.join(' / ')}`);
  const [kind] = given;
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const { limit, offset } = paging(args);

  let targetId;
  let entryLimits = [];
  if (kind === 'column' || kind === 'table') {
    const r = schemaArg(graph, ctx, kind, args[kind]);
    targetId = r.id;
    entryLimits = r.limits;
  } else {
    targetId = nodeId(kind, String(args[kind]));
    if (!graph.nodes.has(targetId)) return notFound(ctx, kind, args[kind]);
  }

  // The routes this change is felt on, so a screen row can name the ones IT
  // goes through rather than every route it happens to call.
  const affectedEndpoints = new Set();
  for (const [id] of graph.impactOf(targetId, { mode, edgeTypes: FLOW_EDGE_TYPES })) {
    if (graph.nodes.get(id)?.kind === 'endpoint') affectedEndpoints.add(id);
  }
  const items = screensAffecting(graph, targetId, { mode }).map((s) => {
    const forward = graph.reach(s.screen, { direction: 'out', mode, edgeTypes: FLOW_EDGE_TYPES });
    const through = [...forward.keys()].filter((id) => affectedEndpoints.has(id)).sort();
    return {
      screen: s.path ?? strip(s.screen),
      label: s.label,
      grade: s.pathGrade,
      endpoints: through.map(strip),
      observed: observedCall(graph, s.screen, through),
      ...(s.viaHttp ? { viaHttp: true, httpHops: s.httpHops } : {}),
    };
  });
  items.sort((a, b) => (a.grade !== b.grade ? gradeRank(b.grade) - gradeRank(a.grade) : cmpStr(a.screen, b.screen)));

  const shown = items.slice(offset, offset + limit);
  const node = graph.nodes.get(targetId);
  const answer = {
    target: { kind, id: strip(targetId), short: nodeLabel(node, targetId), comment: node.comment ?? null },
    mode,
    screens: shown,
  };
  if (shown.length === 0) {
    answer.empty = { screens: items.length > 0 ? 'not-in-this-axis' : screenNoneReason(graph, ctx) };
  }
  const trunc = [truncField('screens', shown.length, items.length, offset, 'grade desc, screen asc')];
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: trustFor(ctx, ['screen', 'column']),
    limits: [...(ctx.limits ?? []), ...entryLimits, screenWalkLimit()],
    truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/**
 * changed_impact — the working-tree overlay (SPEC §10). "I edited these files —
 * what is the blast radius?" Given a list of changed paths (or the live git diff
 * the server computed), it maps them to base-graph nodes and returns the upstream
 * endpoints and downstream columns in reach.
 *
 * This is PROVISIONAL by construction: every fact is from the base pack (the file
 * as last analyzed), so freshness is stamped `provisional-overlay` and the edited
 * files are echoed. A changed file with no node (new file, uncovered lane) is
 * reported in `unmatchedFiles` — "0 impact" there means unknown, not safe.
 */
export function changed_impact(graph, args, ctx) {
  // The live overlay, when the caller wired one (CLI / server). It carries the
  // graph BUILT FROM THE BYTES ON DISK; without it this tool falls back to the
  // base pack, which is the pre-edit structure, and says so in `note`.
  const ov = overlayOf(ctx);
  const applied = !!(ov && ov.applied && ov.graph);
  const g = applied ? ov.graph : graph;

  let files = args && Array.isArray(args.files) ? args.files : null;
  if (!files && ov && Array.isArray(ov.dirtyFiles)) files = ov.dirtyFiles;
  if (!files) {
    const src = ctx && ctx.changedFiles;
    if (typeof src === 'function') files = src();
    else if (Array.isArray(src)) files = src;
  }
  if (!Array.isArray(files)) {
    throw new ToolError('bad-input', 'changed_impact needs a "files" array (changed paths), or a server configured with a git base');
  }
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const { limit, offset } = paging(args);

  const r = changeImpact(g, files, { mode });
  // A row is PROVISIONAL when its node exists only in the overlay — the base
  // graph never had that id. It is a MARKER beside the grade, not a grade: the
  // lattice is untouched (I-1), and an AI reader must not report a provisional
  // row as confirmed (§10.3).
  const prov = (id) => (g.nodes.get(id)?.provisional === true ? { provisional: true } : null);
  const eps = r.upstreamEndpoints.map((e) => {
    // How many FRONTEND functions call this route. An edited controller does not
    // only affect what is below it: it affects every screen that calls it, and
    // without this number the reader has to go and count them.
    const frontend = frontendCallsOf(g, e.id);
    return {
      id: e.id.slice('endpoint:'.length), grade: e.grade,
      ...(e.viaHttp ? { viaHttp: true, httpHops: e.httpHops } : {}),
      ...(frontend > 0 ? { frontendCalls: frontend } : {}), ...prov(e.id),
    };
  });
  // The other direction, for an edited FRONTEND file: the routes it calls.
  const calledEps = (r.calledEndpoints ?? []).map((e) => ({
    id: e.id.slice('endpoint:'.length), grade: e.grade,
    ...(e.viaHttp ? { viaHttp: true, httpHops: e.httpHops } : {}), ...prov(e.id),
  }));
  const cols = r.downstreamColumns.map((c) => ({
    id: c.id.slice('column:'.length), grade: c.grade,
    ...(c.viaHttp ? { viaHttp: true, httpHops: c.httpHops } : {}), ...prov(c.id),
  }));
  const epShown = eps.slice(offset, offset + limit);
  const calledShown = calledEps.slice(offset, offset + limit);
  const colShown = cols.slice(offset, offset + limit);

  // A frontend file the WEB LANE READ is not an unmatched file. It has no node
  // because the lane read it and found no HTTP call in it, which is an answer;
  // leaving it under "impact unknown" would tell the reader to go and check a
  // file this engine has already checked. A file no lane read stays unmatched.
  const hasWebEdits = (r.touched.webSymbols ?? []).length > 0;
  const laneRead = new Set(applied ? (ov.parsedWebFiles ?? []) : []);
  const unmatched = r.unmatchedFiles.filter((f) => !laneRead.has(f));
  const readNoNode = r.unmatchedFiles.filter((f) => laneRead.has(f));

  const answer = {
    changedFiles: r.changedFiles,
    // Nested so the contract's top-level empty-list check applies only to the
    // RESULT lists below — an empty unmatchedFiles means "all matched", not an
    // unexplained empty result.
    files: {
      matched: r.matchedFiles,
      unmatched,
      ...(readNoNode.length ? { readNoFacts: readNoNode } : {}),
    },
    touched: {
      symbols: r.touched.symbols.map(strip), statements: r.touched.statements.map(strip),
      endpoints: r.touched.endpoints.map(strip), columns: r.touched.columns.map(strip),
      // The frontend functions in the edited files, kept apart from the Java
      // symbols: what is downstream of one is a ROUTE, not a table.
      webSymbols: (r.touched.webSymbols ?? []).map(strip),
      // ...and the screens those functions are drawn on, which is the answer a
      // reader editing a `.vue` file actually wants.
      screens: (r.touched.screens ?? []).map(strip),
    },
    upstreamEndpoints: epShown,
    // Only when a FRONTEND file was edited. On a backend-only change the field
    // would be an empty list with nothing to say, and an empty list that means
    // "this question does not apply here" reads as "nothing calls anything".
    ...(hasWebEdits ? { calledEndpoints: calledShown } : {}),
    downstreamColumns: colShown,
    note: applied
      ? 'provisional overlay: the dirty files were RE-PARSED and this answer describes the bytes on disk. Rows marked provisional exist only in the overlay (no certified run has seen them); nothing here is published and the pack digest is unchanged.'
      : 'provisional: computed from the base pack (files as last analyzed). Edited regions may add or remove connections. Re-run `cascade analyze` for a certified result.',
  };
  if (ov) answer.overlay = overlayReport(ov, applied);
  const empty = {};
  if (epShown.length === 0) empty.upstreamEndpoints = eps.length ? 'not-in-this-axis' : (hasCodeAxis(g, ctx) ? 'none' : 'not-shipped');
  if (hasWebEdits && calledShown.length === 0) {
    empty.calledEndpoints = calledEps.length ? 'not-in-this-axis' : 'none';
  }
  if (colShown.length === 0) empty.downstreamColumns = cols.length ? 'not-in-this-axis' : 'none';
  if (Object.keys(empty).length) answer.empty = empty;

  const trunc = [
    truncField('upstreamEndpoints', epShown.length, eps.length, offset),
    ...(hasWebEdits ? [truncField('calledEndpoints', calledShown.length, calledEps.length, offset)] : []),
    truncField('downstreamColumns', colShown.length, cols.length, offset),
  ];
  const limits = [...(ctx.limits ?? []), ...((ov && ov.limits) ?? [])];
  if (unmatched.length) {
    limits.push({ scope: 'changed-files', reason: `${unmatched.length} changed file(s) have no node in the ${applied ? 'overlay' : 'base'} graph, such as a config file or one from a lane that did not run. What they affect is unknown, not zero` });
  }
  return makeResponse({
    answer,
    // The verdict is the AI's behavior protocol (§10.3), so it states exactly
    // what happened: the edits were applied (provisional-overlay), the tree
    // moved past the pack and the overlay was DISCARDED (behind), or the
    // overlay declined and this is the base pack's own answer (unknown).
    basis: { ...ctx.basis, freshness: overlayFreshness(ov, applied) },
    trust: trustFor(ctx, ['column', 'endpoint', 'overlay']),
    limits,
    truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/** The live overlay a server/CLI attached to the context, if any. */
function overlayOf(ctx) {
  const src = ctx && ctx.overlay;
  if (typeof src === 'function') return src();
  return src && typeof src === 'object' ? src : null;
}

/** What the answer discloses about the overlay itself (§10.2 MUST: id + doc versions). */
function overlayReport(ov, applied) {
  return {
    applied,
    state: ov.state ?? null,
    reason: applied ? null : (ov.reason ?? null),
    overlaySessionId: ov.session?.overlaySessionId ?? null,
    baseCommit: ov.session?.baseCommit ?? null,
    headCommit: ov.session?.headCommit ?? null,
    docVersions: ov.session?.docVersions ?? {},
    dirtyFiles: ov.dirtyFiles ?? [],
    parsedFiles: ov.parsedFiles ?? [],
    droppedFiles: ov.droppedFiles ?? [],
    parsedWebFiles: ov.parsedWebFiles ?? [],
    droppedWebFiles: ov.droppedWebFiles ?? [],
    webConfigFiles: ov.webConfigFiles ?? [],
    unmatchedLanes: ov.unmatched ?? [],
    provisionalEdges: ov.provisional?.edges ?? 0,
    provisionalIds: {
      symbols: ov.provisional?.symbols ?? [],
      endpoints: ov.provisional?.endpoints ?? [],
      statements: ov.provisional?.statements ?? [],
    },
    timingsMs: ov.timingsMs ?? null,
  };
}

function overlayFreshness(ov, applied) {
  if (applied) return { verdict: 'provisional-overlay', overlaySessionId: ov.session?.overlaySessionId ?? null };
  if (!ov) return { verdict: 'provisional-overlay' };
  // Nothing is dirty and the pack was built at HEAD: this IS the certified base.
  if (ov.state === 'clean') return { verdict: 'current', behindTotal: 0 };
  if (ov.state === 'stale-commit') {
    return { verdict: 'behind', reason: ov.reason ?? 'the working tree has moved past the commit this pack was built from' };
  }
  return { verdict: 'unknown', reason: ov.reason ?? 'the overlay could not be applied' };
}

/** table_usage — which statements touch a table; per-column read/write counts. */
export function table_usage(graph, args, ctx) {
  const tbl = schemaArg(graph, ctx, 'table', req(args, 'table'));
  const table = tbl.key;
  const { limit, offset } = paging(args);
  const tblId = tbl.id;

  const stmts = new Map(); // stmt -> access set
  for (const e of graph.edges) {
    if (e.type === 'EXECUTES' && e.to === tblId) {
      const s = stmts.get(e.from) || new Set();
      s.add(e.evidence?.access || 'read');
      stmts.set(e.from, s);
    }
  }
  const statements = [...stmts.entries()]
    .map(([id, acc]) => ({ id: strip(id), access: [...acc].sort().join('+') }))
    .sort(byId);
  // per-column r/w counts for this table's columns
  const colCounts = new Map();
  const prefix = `column:${table}.`;
  for (const e of graph.edges) {
    if ((e.type === 'READS' || e.type === 'WRITES') && e.to.startsWith(prefix)) {
      const c = e.to.slice('column:'.length);
      const rec = colCounts.get(c) || { column: c, reads: 0, writes: 0 };
      if (e.type === 'READS') rec.reads++; else rec.writes++;
      colCounts.set(c, rec);
    }
  }
  const columns = [...colCounts.values()].sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes) || (a.column < b.column ? -1 : 1));

  const answer = multiListAnswer(
    { statements: cut(statements, limit, offset), columns: cut(columns, limit, 0) },
    { statements: statements.length, columns: columns.length },
    { statementsOffset: offset, limit },
  );
  return respond(ctx, answer, ['table'], graph.nodes.get(tblId), tbl.limits);
}

/**
 * neighborhood — the graph slice around a focus node, for the visual Graph /
 * Impact view. direction=up (what depends on it → toward endpoints), down (what
 * it reaches → toward columns), or both. Returns nodes + graded edges (capped),
 * so the page renders the SAME graph the engine holds — grades and all.
 */
export function neighborhood(graph, args, ctx) {
  const { id: focus, limits: focusLimits } = resolveNodeArg(graph, ctx, args);
  const hops = clamp(args.hops, 1, 5, 2);
  const cap = clamp(args.limit, 1, 800, 200);
  const dir = args.direction || 'both';
  if (!['up', 'down', 'both'].includes(dir)) throw new ToolError('bad-input', 'direction must be up | down | both');

  // BFS outward collecting nodes (capped) and the edges among them.
  const nodeSet = new Set([focus]);
  let frontier = [focus];
  let capped = false;
  for (let h = 0; h < hops && !capped; h++) {
    const next = [];
    for (const id of frontier) {
      const around = [];
      if (dir === 'up' || dir === 'both') for (const e of graph.edges) { if (e.to === id) around.push(e.from); }
      if (dir === 'down' || dir === 'both') for (const e of graph.edges) { if (e.from === id) around.push(e.to); }
      for (const nb of around) {
        if (nodeSet.has(nb)) continue;
        if (nodeSet.size >= cap) { capped = true; break; }
        nodeSet.add(nb); next.push(nb);
      }
      if (capped) break;
    }
    frontier = next;
  }
  const nodes = [...nodeSet].map((id) => {
    const n = graph.nodes.get(id) || { id, kind: id.slice(0, id.indexOf(':')) };
    return {
      id, kind: n.kind, label: nodeLabel(n, id), comment: n.comment ?? null,
      // A frontend function is a symbol like any other and would read as
      // backend code without this. Written only where it is true.
      ...(n.lane ? { lane: n.lane } : {}),
      // A recording says the browser really was here, or really made this call.
      ...(n.observed === true ? { observed: true } : {}),
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [];
  for (const e of graph.edges) {
    if (nodeSet.has(e.from) && nodeSet.has(e.to)) {
      edges.push({
        from: e.from, to: e.to, type: e.type, grade: e.grade, access: e.evidence?.access ?? null,
        // A trace saw this very call happen. Written only where it is true, and
        // BESIDE the grade the static lane gave the edge: SOUND_SET that a
        // capture confirmed is still SOUND_SET, and an edge with no mark was
        // not visited by that capture rather than absent.
        ...(e.evidence?.observed === true ? { observed: true } : {}),
      });
    }
  }
  edges.sort((a, b) => (a.from + a.to + a.type < b.from + b.to + b.type ? -1 : 1));

  const answer = { focus, direction: dir, hops, nodes, edges };
  const empty = {};
  if (nodes.length === 0) empty.nodes = 'none';
  if (edges.length === 0) empty.edges = nodes.length > 1 ? 'not-in-this-axis' : 'none';
  if (Object.keys(empty).length) answer.empty = empty;
  const limits = [...(ctx.limits ?? []), ...focusLimits];
  if (capped) limits.push({ scope: 'neighborhood', reason: `node cap ${cap} reached. The graph around this node is bigger than this, so narrow it with hops or direction` });
  const trunc = [{ field: 'nodes', shown: nodes.length, total: capped ? nodes.length + 1 : nodes.length, order: 'id asc', nextOffset: capped ? nodes.length : null }];
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: trustFor(ctx, ['graph']),
    limits,
    truncated: { any: capped, fields: trunc },
  });
}

/**
 * erd — an entity-relationship view built from how the mapper SQL JOINS tables
 * (this schema declares no foreign keys, so relationships are recovered from the
 * queries; grade EXACT — the join is literal in the SQL). With `table` set,
 * returns that table's JOIN-neighborhood (tables within `hops`) WITH columns;
 * without it, the whole-schema overview (tables + column counts + every relationship).
 */
// The ERD's table cap. Without one this answer is UNBOUNDED: the whole-schema
// mode returns every table and every JOINS relationship, and the focus mode
// returns every column of every table within `hops`. MEASURED: 400 tables →
// 86 KB whole-schema and 296 KB for a 4-hop neighbourhood WITH columns, so a
// 4 000-table schema would be megabytes with nothing in the answer saying so.
// The cap keeps the best-connected tables (the ones an ERD is read for) and the
// caller is told the true total.
const ERD_LIMIT_DEFAULT = 400;
const ERD_LIMIT_MAX = 5000;

export function erd(graph, args, ctx) {
  const hops = clamp(args.hops, 1, 4, 1);
  const limit = clamp(args.limit, 1, ERD_LIMIT_MAX, ERD_LIMIT_DEFAULT);
  let focusKey = null;
  let tset;
  let focusLimits = [];
  if (args && args.table) {
    const focus = schemaArg(graph, ctx, 'table', args.table);
    const fid = focus.id;
    focusLimits = focus.limits;
    focusKey = focus.key;
    tset = new Set([fid]);
    let frontier = [fid];
    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const t of frontier) for (const e of graph.edges) {
        if (e.type !== 'JOINS') continue;
        const o = e.from === t ? e.to : e.to === t ? e.from : null;
        if (o && !tset.has(o)) { tset.add(o); next.push(o); }
      }
      frontier = next;
    }
  } else {
    tset = new Set([...graph.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id));
  }
  // The cap, applied BEFORE the columns are gathered — cutting after would pay
  // the cost the cap exists to avoid. Kept: the focus table always, then the
  // most-joined tables (join degree over the whole pack, ties by name), because
  // an ERD with its hubs removed is not a smaller ERD, it is a different one.
  const tablesTotal = tset.size;
  if (tset.size > limit) {
    const joinDegree = new Map();
    for (const e of graph.edges) {
      if (e.type !== 'JOINS') continue;
      if (tset.has(e.from)) joinDegree.set(e.from, (joinDegree.get(e.from) ?? 0) + 1);
      if (tset.has(e.to)) joinDegree.set(e.to, (joinDegree.get(e.to) ?? 0) + 1);
    }
    const focusId = focusKey ? nodeId('table', focusKey) : null;
    const ranked = [...tset].sort((a, b) => {
      if (a === focusId) return -1;
      if (b === focusId) return 1;
      return ((joinDegree.get(b) ?? 0) - (joinDegree.get(a) ?? 0)) || (a < b ? -1 : a > b ? 1 : 0);
    });
    tset = new Set(ranked.slice(0, limit));
  }
  const tablesCut = tablesTotal - tset.size;

  const withCols = !!focusKey;
  const colsByTable = new Map();
  const countByTable = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'DECLARES' || !tset.has(e.from)) continue;
    countByTable.set(e.from, (countByTable.get(e.from) || 0) + 1);
    if (withCols) {
      const c = graph.nodes.get(e.to) || {};
      const arr = colsByTable.get(e.from) || [];
      arr.push({ column: c.name ?? strip(e.to).split('.').pop(), type: c.type ?? null, comment: c.comment ?? null, pk: c.pk === true });
      colsByTable.set(e.from, arr);
    }
  }
  const tables = [...tset].map((id) => {
    const n = graph.nodes.get(id) || {};
    const t = { table: strip(id), comment: n.comment ?? null, columnCount: countByTable.get(id) || 0 };
    if (withCols) t.columns = colsByTable.get(id) || [];
    return t;
  }).sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));

  const seen = new Set();
  const relationships = [];
  for (const e of graph.edges) {
    if (e.type !== 'JOINS' || !tset.has(e.from) || !tset.has(e.to)) continue;
    const k = e.from + '|' + e.to;
    if (seen.has(k)) continue; seen.add(k);
    const fromT = strip(e.from), toT = strip(e.to);
    const cols = e.evidence?.columns ?? [];
    relationships.push({ from: fromT, to: toT, columns: cols, statements: e.evidence?.count ?? 1, grade: e.grade, cardinality: cardinalityOf(graph, fromT, toT, cols) });
  }
  relationships.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));

  const answer = { focus: focusKey, hops: focusKey ? hops : null, limit, tables, relationships };
  const empty = {};
  if (tables.length === 0) empty.tables = 'none';
  if (relationships.length === 0) empty.relationships = tables.length > 1 ? 'none' : 'not-in-this-axis';
  if (Object.keys(empty).length) answer.empty = empty;
  const limits = [...(ctx.limits ?? []), ...focusLimits];
  if (tablesCut > 0) {
    limits.push({ scope: 'erd', reason: `table cap ${limit} reached, so ${tablesCut} of ${tablesTotal} table(s) in scope are not drawn (we keep the most-joined${focusKey ? ', and the focus table always' : ''}). Every relationship between a kept and a cut table went with them. Raise limit (max ${ERD_LIMIT_MAX}); what is missing is unknown, not absent` });
  }
  // An ERD is a picture, not a page: `truncated` declares the true total with no
  // nextOffset (the same rule `map` follows), and the cut itself is in `limits`.
  const trunc = [
    { field: 'tables', shown: tables.length, total: tablesTotal, order: 'join degree desc, table asc', nextOffset: null },
    { field: 'relationships', shown: relationships.length, total: relationships.length, order: 'from+to asc', nextOffset: null },
  ];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['erd']),
    limits, truncated: { any: false, fields: trunc },
  });
}

/**
 * transactions — the @Transactional boundaries and each one's atomic read/write
 * footprint: the tables/columns reachable from the boundary method through the
 * call graph → mapper → statement (SPEC §9). With method=<owner#name> returns one
 * transaction's full column lists; without it, the list with per-transaction
 * counts. Footprint grade follows the weakest reachable edge (SOUND_SET via the
 * call graph) — the boundary is EXACT (the annotation is definitional).
 */
export function transactions(graph, args, ctx) {
  const { limit, offset } = paging(args);
  let nodes;
  if (args && args.method) {
    const id = nodeId('symbol', String(args.method));
    const n = graph.nodes.get(id);
    if (!n) return notFound(ctx, 'symbol', args.method);
    if (!n.transactional) throw new ToolError('bad-input', `${args.method} is not a @Transactional boundary`);
    nodes = [id];
  } else {
    nodes = [...graph.nodes.values()].filter((n) => n.transactional).map((n) => n.id).sort();
  }
  const detail = !!(args && args.method);

  const footprint = (id) => {
    // Flow edges only. The lists below are built from the reached STATEMENTS'
    // own edges, so a schema hop would not change them — but every impact walk
    // in the engine means the same thing by "reached", and this one is no
    // exception.
    const reached = graph.reach(id, { direction: 'out', mode: 'conservative', edgeTypes: FLOW_EDGE_TYPES });
    const stmts = [];
    for (const [rid] of reached) if (graph.nodes.get(rid)?.kind === 'statement') stmts.push(rid);
    const writes = new Set(), reads = new Set(), tables = new Set();
    // Read each reached statement's OWN out-edges, the way every other view
    // derives its tables lane. Scanning `graph.edges` here instead cost one full
    // pass over the pack PER TRANSACTION: measured on a 400-table /
    // 3 800-endpoint pack, 2 300 boundaries x 105 068 edges = 242M steps, and
    // this one tool took 1.45 s of a 2 s gate while every other took under 200 ms.
    for (const sid of stmts) {
      for (const e of graph.outEdges(sid)) {
        if (e.type === 'WRITES') { const c = strip(e.to); writes.add(c); tables.add(tableOf(c)); }
        else if (e.type === 'READS') { const c = strip(e.to); reads.add(c); tables.add(tableOf(c)); }
        else if (e.type === 'EXECUTES') tables.add(strip(e.to));
      }
    }
    return { writes: [...writes].sort(), reads: [...reads].sort(), tables: [...tables].sort(), statements: stmts.length };
  };

  const all = nodes.map((id) => {
    const n = graph.nodes.get(id);
    const f = footprint(id);
    const base = { method: strip(id), scope: n.txScope ?? null, line: n.line ?? null,
      writeCount: f.writes.length, readCount: f.reads.length, tableCount: f.tables.length, statementCount: f.statements };
    return detail ? { ...base, writes: f.writes, reads: f.reads, tables: f.tables } : base;
  }).sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));

  const shown = all.slice(offset, offset + limit);
  const answer = { transactions: shown };
  if (shown.length === 0) answer.empty = { transactions: all.length > 0 ? 'not-in-this-axis' : (hasCodeAxis(graph, ctx) ? 'none' : 'not-shipped') };
  const trunc = [truncField('transactions', shown.length, all.length, offset)];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['transaction']),
    limits: ctx.limits ?? [], truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

// A pair lists at most this many items; `count` stays the true total, and a cut
// is declared in `limits` — a 20-item list must never read as the whole cell.
const COUPLING_ITEM_CAP = 20;
// The fan-out disclosure is a sample of the shared statements, sized like any
// other list and reported in `truncated`.
const COUPLING_SHARED_CAP = 20;
// The `map` node cap: how many nodes one picture may carry. 6000 draws the
// a pack of about 3,800 endpoints whole; 20000 is the ceiling a caller
// may raise it to.
const MAP_LIMIT_MAX = 20000;
// The map's ANSWER budget, in measured bytes of its nodes+links payload (SPEC
// §13: the response-size limit is taken from measured bytes, and going over is
// disclosed, never silently trimmed). 512 KB draws mall whole (its payload is
// ~140 KB) and cuts a 3 800-endpoint pack, saying so.
const MAP_MAX_BYTES_DEFAULT = 512 * 1024;
const MAP_MAX_BYTES_MAX = 8 * 1024 * 1024;

/**
 * coupling — "which API group writes what another API group reads?" The DB
 * sharing between modules that no call edge shows: group A writes a column (or
 * table) group B reads. The engine builds it (core/coupling.mjs); this tool only
 * validates the arguments, cuts the lists and stamps the contract.
 *
 * A group is an API path prefix, and a statement is attributed to every group
 * whose endpoints can REACH it — so both the boundary and the attribution are
 * approximations. Both are stated in `limits`, together with how many statements
 * are so widely reached (`sharedStatements`) that attributing them says little.
 */
export function coupling(graph, args, ctx) {
  args = args || {};
  const axis = args.axis == null || args.axis === '' ? 'column' : String(args.axis);
  if (axis !== 'column' && axis !== 'table') throw new ToolError('bad-input', 'axis must be column | table');
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const depth = clamp(args.depth, 1, 8, 8);
  const limit = clamp(args.limit, 1, 500, 50);
  const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);

  const c = buildCoupling(graph, { axis, mode, depth, packageDepth: packageDepthOf(ctx) });
  const shownPairs = c.pairs.slice(offset, offset + limit).map((p) => ({
    writer: p.writer, reader: p.reader, count: p.count,
    items: p.items.slice(0, COUPLING_ITEM_CAP), viaShared: p.viaShared,
    // THIS pair's own fan-out evidence, not the pack's global top of the list.
    sharedVia: p.sharedVia,
  }));
  const itemsCut = shownPairs.reduce((n, p) => n + (p.count > p.items.length ? 1 : 0), 0);
  // The matrix reads EVERY cell — paging it would draw a picture with holes in
  // it — so `cells` carries no items and is never cut.
  const cells = c.pairs.map((p) => ({ writer: p.writer, reader: p.reader, count: p.count }));
  const shared = c.sharedStatements.slice(0, COUPLING_SHARED_CAP);

  const answer = {
    axis, mode, depth,
    groups: c.groups,
    pairs: shownPairs,
    cells,
    sharedStatements: shared,
    // What the walks behind this matrix did NOT look at — the page reads it to
    // say why a matrix is empty, instead of calling the mode an absence.
    walk: c.walk,
    summary: c.summary,
  };
  // No endpoints at all is "the Java lane never ran", not "these modules share
  // nothing" — the difference between not-shipped and none.
  const noAxis = !hasCodeAxis(graph, ctx);
  const empty = {};
  if (c.groups.length === 0) empty.groups = 'not-shipped';
  if (shownPairs.length === 0) empty.pairs = c.pairs.length > 0 ? 'not-in-this-axis' : (noAxis ? 'not-shipped' : 'none');
  if (cells.length === 0) empty.cells = noAxis ? 'not-shipped' : 'none';
  if (shared.length === 0) empty.sharedStatements = noAxis ? 'not-shipped' : 'none';
  if (Object.keys(empty).length) answer.empty = empty;

  const limits = [...(ctx.limits ?? []),
    { scope: 'coupling', reason: `we attribute a statement to a group by following calls (${mode}, depth ${depth}), so a statement behind a shared service counts for every group that reaches it. ${c.summary.sharedStatements} statement(s) are reached by ${SHARED_AT} or more groups` },
    groupingLimit('coupling', ctx),
    { scope: 'coupling', reason: 'this view sees sharing through the database only. A direct call from one group to another is not counted here' },
  ];
  if (itemsCut) limits.push({ scope: 'coupling', reason: `${itemsCut} pair(s) list only the first ${COUPLING_ITEM_CAP} ${axis}s. Each pair's \`count\` still carries the full number` });
  // What the walks did not look at, in the same words the `flow` tool uses —
  // one engine, one wording, so the two views cannot describe the same cut
  // differently.
  const w = c.walk;
  if (w.depthCut > 0) {
    limits.push({ scope: 'coupling', reason: `depth cap ${depth} reached at ${w.depthCut} call(s) across ${w.depthCutStarts} endpoint chain(s), so deeper statements are not attributed to any group and pairs beyond are unknown, not absent` });
  }
  if (w.nodeCapStarts > 0) {
    limits.push({ scope: 'coupling', reason: `node cap reached from ${w.nodeCapStarts} handler(s). Those chains are bigger than one walk, and what they reach beyond the cap is unknown, not absent` });
  }
  // Not a cut — a shape. A route two controllers declare is ONE endpoint node
  // with two handlers, and this matrix walked both of them; said out loud so a
  // reader who notices the duplicate route does not read it as an analysis bug.
  if (w.generated > 0) {
    limits.push({ scope: 'coupling', reason: `${w.generated} step(s) from one generated symbol to another were not walked, following the profile's generatedSources declaration. A generated method a real caller reaches IS walked; only the machine-written interior is skipped` });
  }
  if (w.multiHandlerEndpoints > 0) {
    limits.push({ scope: 'coupling', reason: `${w.multiHandlerEndpoints} route(s) are declared by more than one controller method, which means the same route string sits in more than one module. We walked every handler, so those routes reach their group through everything all of them reach together` });
  }
  // An empty matrix that the WALK produced must never read as "these groups
  // share nothing" — under mode=strict a controller→service call is below the
  // floor, so every group reaches zero statements and the answer is the mode.
  // That total emptiness is the special case; otherwise the skipped links are
  // reported the way `flow` reports them.
  if (c.summary.endpoints > 0 && c.summary.statements === 0) {
    const wider = widerMode(mode);
    limits.push({ scope: 'coupling', reason: `the walk reached no statement at all (mode=${mode}, depth ${depth}). This matrix is empty because of the walk, not because these groups share nothing${wider ? `; try mode=${wider}` : ''}` });
  } else if (w.byMode > 0) {
    const wider = widerMode(mode);
    limits.push({ scope: 'coupling', reason: wider
      ? `${w.byMode} link(s) below the grade floor of mode=${mode} were not walked. An empty cell here can be the mode, not an absence. Try mode=${wider}`
      : `${w.byMode} link(s) are RUNTIME_ONLY/UNRESOLVED, and no mode walks them, so an empty cell here is what the analyzer could not resolve, not the mode` });
  }
  if (c.unknownAccess > 0) {
    limits.push({ scope: 'coupling', reason: `${c.unknownAccess} EXECUTES edge(s) carry no read, write or delete access. We count each on BOTH sides, as writer and as reader, so a pair may rest on an access the lane never recorded` });
  }
  // The grouping rule itself can degenerate: one bucket holding almost every
  // endpoint, or a path VARIABLE as the first segment, means "first path
  // segment" is not a module boundary on this pack.
  const totalEndpoints = c.summary.endpoints;
  if (totalEndpoints > 0) {
    const big = c.groups.filter((g) => g.endpoints >= totalEndpoints * 0.8);
    for (const g of big) {
      limits.push({ scope: 'coupling', reason: `grouping by first path segment breaks down on this pack: ${g.endpoints} of ${totalEndpoints} endpoints fall in one group (${g.group})` });
    }
  }
  const vars = c.groups.filter((g) => g.group.startsWith('{')).map((g) => g.group);
  if (vars.length) {
    limits.push({ scope: 'coupling', reason: `grouping by first path segment breaks down on this pack: a path variable is the first segment (${vars.join(', ')}), so that group is a placeholder rather than a module` });
  }

  const trunc = [
    truncField('groups', c.groups.length, c.groups.length, 0, 'group asc'),
    truncField('pairs', shownPairs.length, c.pairs.length, offset, 'count desc, writer asc, reader asc'),
    truncField('cells', cells.length, cells.length, 0, 'count desc, writer asc, reader asc'),
    // A capped DISCLOSURE, not a page: there is no offset that fetches the rest
    // (ask `flow` about a statement instead), so it declares no nextOffset and
    // never turns `truncated.any` true on its own.
    { field: 'sharedStatements', shown: shared.length, total: c.sharedStatements.length, order: 'groups desc, statement asc', nextOffset: null },
  ];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['coupling']),
    limits, truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/**
 * map — the whole-pack relation map: API groups → endpoints → tables, plus the
 * joins the mapper SQL witnesses between those tables. The engine builds it
 * (core/map.mjs, on the SAME per-endpoint walk `coupling` runs); this tool
 * validates the arguments, applies the node cap and stamps the contract.
 *
 * Everything the picture rests on that is NOT a fact — the group boundary, the
 * attribution by reachability, the tables no endpoint touches, and whatever the
 * node cap refused to draw — is said out loud in `limits`.
 */
export function map(graph, args, ctx) {
  args = args || {};
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const depth = clamp(args.depth, 1, 8, 8);
  const limit = clamp(args.limit, 1, MAP_LIMIT_MAX, MAP_LIMIT_DEFAULT);
  // The node cap is in the wrong unit for §13's promise. MEASURED on a 400-table
  // / 3 800-endpoint pack: 4 227 nodes — well under the 6 000 default — carry
  // 12 200 links and serialise to 2.5 MB, and nothing in the answer said so.
  // So the map is also bounded by the MEASURED size of its own payload, and a
  // caller who really wants a bigger picture raises it deliberately.
  const maxBytes = clamp(args.maxBytes, 64 * 1024, MAP_MAX_BYTES_MAX, MAP_MAX_BYTES_DEFAULT);
  const asked = args.layers == null || args.layers === '' ? [] : args.layers;
  if (!Array.isArray(asked)) throw new ToolError('bad-input', 'layers must be an array of strings');
  for (const l of asked) {
    if (typeof l !== 'string' || !MAP_LAYERS.includes(l)) {
      throw new ToolError('bad-input', `unknown layer: ${JSON.stringify(l)}. The only recognised layer is ${MAP_LAYERS.join(', ')}`);
    }
  }

  const m = buildMap(graph, { mode, depth, layers: asked, limit, maxBytes, packageDepth: packageDepthOf(ctx) });
  const s = m.summary;
  const answer = {
    mode, depth, layers: m.layers, limit, maxBytes,
    nodes: m.nodes,
    links: m.links,
    summary: s,
  };
  // No endpoints at all is "the Java lane never ran", not "this system relates
  // nothing" — the difference between not-shipped and none.
  const noAxis = !hasCodeAxis(graph, ctx);
  const empty = {};
  if (m.nodes.length === 0) empty.nodes = noAxis ? 'not-shipped' : 'none';
  if (m.links.length === 0) empty.links = noAxis ? 'not-shipped' : 'none';
  if (Object.keys(empty).length) answer.empty = empty;

  const limits = [...(ctx.limits ?? []),
    groupingLimit('map', ctx),
    { scope: 'map', reason: `a table is on this map because a walk (${mode}, depth ${depth}) from an endpoint reaches a statement that touches it. It is the same forward walk \`flow\` draws, and what a deeper or wider walk would add is unknown, not absent` },
  ];
  if (s.tablesTouched < s.tables) {
    limits.push({ scope: 'map', reason: `${s.tablesTouched} of ${s.tables} table(s) in the pack are reached from an endpoint. The other ${s.tables - s.tablesTouched} are NOT drawn: they are in the schema, and no endpoint we analysed touches them` });
  }
  if (!m.layers.statements) {
    limits.push({ scope: 'map', reason: 'an endpoint to table link folds away the statements that carried it. Its `statements` count says how many, and layers:["statements"] draws them as nodes of their own instead' });
  }
  if (m.layers.screens) {
    limits.push(screenWalkLimit());
    if (s.screensTotal > s.screens) {
      limits.push({ scope: 'map', reason: `${s.screens} of ${s.screensTotal} screen(s) in this pack reach a route this map draws. The other ${s.screensTotal - s.screens} are NOT drawn: nothing we could follow leaves them, which is unknown rather than "this screen calls nothing"` });
    }
  }
  const cutBy = (kind, total) => total - (s.shown[kind] ?? 0);
  const cuts = [];
  for (const [kind, total] of [['statements', s.statements ?? 0], ['screens', s.screens ?? 0], ['endpoints', s.endpoints], ['tables', s.tablesTouched]]) {
    const n = cutBy(kind, total);
    if (n > 0) cuts.push(`${n} ${kind}`);
  }
  if (cuts.length) {
    limits.push({ scope: 'map', reason: s.cutBy === 'byte-budget'
      ? `the ${maxBytes}-byte answer budget was reached at ${s.bytes} bytes, so ${cuts.join(', ')} not drawn (we keep the best-connected of each kind; statements give way first, then endpoints, then tables, and groups are never cut). The whole map is ${s.nodesTotal} nodes / ${s.linksTotal} links; raise maxBytes (max ${MAP_MAX_BYTES_MAX}) to draw more of it. What is missing is unknown, not absent`
      : `node cap ${limit} reached, so ${cuts.join(', ')} not drawn (we keep the best-connected of each kind; statements give way first, then endpoints, then tables, and groups are never cut). What is missing is unknown, not absent` });
  }
  if (s.shown.groups > limit) {
    limits.push({ scope: 'map', reason: `${s.shown.groups} groups go past the node cap ${limit} on their own. We never cut groups, so this answer is bigger than the cap you asked for` });
  }
  // What the walks did not look at, in the same words `flow` and `coupling` use.
  const w = s.walk;
  if (w.depthCut > 0) {
    limits.push({ scope: 'map', reason: `depth cap ${depth} reached at ${w.depthCut} call(s) across ${w.depthCutStarts} endpoint chain(s). Tables past the cap are on no endpoint's line here, and they are unknown, not absent` });
  }
  if (w.nodeCapStarts > 0) {
    limits.push({ scope: 'map', reason: `node cap reached from ${w.nodeCapStarts} handler(s). Those chains are bigger than one walk, and what they reach beyond the cap is unknown, not absent` });
  }
  // Not a cut — a shape (see the same note in `coupling`). The node's
  // `handlerShort` names the primary handler; `handlers` on it says how many
  // there are, and the map drew the lines of ALL of them.
  if (w.generated > 0) {
    limits.push({ scope: 'map', reason: `${w.generated} step(s) from one generated symbol to another were not walked, following the profile's generatedSources declaration. A generated method a real caller reaches IS walked; only the machine-written interior is skipped` });
  }
  if (w.multiHandlerEndpoints > 0) {
    limits.push({ scope: 'map', reason: `${w.multiHandlerEndpoints} route(s) are declared by more than one controller method, which means the same route string sits in more than one module. Each is ONE node here, labelled with its primary handler (\`handlers\` says how many), and its lines are everything all the handlers reach together` });
  }
  if (s.endpoints > 0 && s.tablesTouched === 0) {
    const wider = widerMode(mode);
    limits.push({ scope: 'map', reason: `the walk reached no statement at all (mode=${mode}, depth ${depth}). This map has no endpoint to table line because of the walk, not because these endpoints touch nothing${wider ? `; try mode=${wider}` : ''}` });
  } else if (w.byMode > 0) {
    const wider = widerMode(mode);
    limits.push({ scope: 'map', reason: wider
      ? `${w.byMode} link(s) below the grade floor of mode=${mode} were not walked. A missing line here can be the mode, not an absence. Try mode=${wider}`
      : `${w.byMode} link(s) are RUNTIME_ONLY/UNRESOLVED, and no mode walks them, so a missing line here is what the analyzer could not resolve, not the mode` });
  }

  // A map cannot be PAGED — the second page of a picture is not a picture — so
  // both fields declare their true total with no nextOffset, the way `coupling`
  // declares its shared-statement disclosure. The cut itself is in `limits`.
  const trunc = [
    { field: 'nodes', shown: m.nodes.length, total: s.nodesTotal, order: 'kind (group, endpoint, table, statement) asc, id asc', nextOffset: null },
    { field: 'links', shown: m.links.length, total: s.linksTotal, order: 'kind (member, touches, executes, joins) asc, source asc, target asc', nextOffset: null },
  ];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['map']),
    limits, truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

// The overview's OPEN-ENDED lists (hubs, the reach samples) are a HEADLINE, not
// a page: they are cut at ten and their true total is declared in `truncated`.
// There is no offset — a reader who wants the eleventh table asks the view that
// is about that table.
//
// The CENSUSES are exempt: nodes / edges / grades / statementTypes have one row
// per node kind, edge type+grade, grade and statement type — bounded by the
// schema, not by the pack — so cutting them at ten would hide a whole edge type
// behind a "showing 10 of 12" and call the answer a census anyway.
const OVERVIEW_CAP = 10;

/**
 * overview — the pack at a glance: what is in it, how much of it is connected
 * from an HTTP route down to a table, and what the engine could not see. The
 * engine counts (core/overview.mjs); this tool copies the pack's own metadata
 * in, cuts the lists, turns every gap into a `limits` entry and stamps the
 * contract. The landing page reads ONE answer and draws it — it never counts.
 */
export function overview(graph, args, ctx) {
  args = args || {};
  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  const depth = clamp(args.depth, 1, 8, 8);

  // The pack's own metadata: the server holds it, this tool only relays it. A
  // server that supplied none says so in `limits` rather than inventing a name.
  const meta = (ctx && ctx.pack) || null;
  const base = meta && meta.base
    ? { commit: meta.base.commit ?? null, ...(meta.base.repoPath ? { repoPath: meta.base.repoPath } : {}) }
    : null;
  const pack = {
    project: meta?.project ?? null,
    digest: meta?.digest ?? null,
    builtAt: meta?.builtAt ?? null,
    lanes: Array.isArray(meta?.lanes) ? meta.lanes : null,
    base,
    ...(meta?.ddl ? { ddl: meta.ddl } : {}),
  };

  const o = buildOverview(graph, { mode, depth, lanes: pack.lanes, laneStats: meta?.laneStats ?? null });
  const cut = (list) => list.slice(0, OVERVIEW_CAP);

  const answer = {
    mode: o.mode,
    depth: o.depth,
    pack,
    // The pack's OWN axis declaration, verbatim (SPEC §10.4): per axis, whether
    // it is shipped / degraded / not-shipped and why. `{}` for a pack built
    // before axes were declared — the reader then falls back to `gaps`, which
    // is inferred from the graph shape.
    axes: (meta && meta.axes) || {},
    // Complete by construction (see OVERVIEW_CAP) — never cut.
    nodes: o.nodes,
    edges: o.edges,
    grades: o.grades,
    statementTypes: o.statementTypes,
    reach: {
      ...o.reach,
      samples: {
        endpointsWithoutStatement: cut(o.reach.samples.endpointsWithoutStatement),
        unreachedStatements: cut(o.reach.samples.unreachedStatements),
        unreachedTables: cut(o.reach.samples.unreachedTables),
      },
    },
    code: o.code,
    // The JPA axis of this pack: how many tables an @Entity maps to, how many
    // repositories generate statements, and how many of those statements the
    // bridge could not fully resolve (kept, with their reasons, on the nodes).
    jpa: o.jpa,
    // The screen axis, when the router gave one: how many screens are declared,
    // how many reach a route and a table, and how many components this lane
    // could not resolve.
    ...(o.screens ? { screens: o.screens } : {}),
    // The OpenAPI axis, when a document was read: what it declares, how much of
    // that this code serves, and the drift in both directions.
    ...(o.openapi ? { openapi: o.openapi } : {}),
    hubs: { tables: cut(o.hubs.tables), endpoints: cut(o.hubs.endpoints) },
    gaps: o.gaps,
  };
  const empty = {};
  if (answer.nodes.length === 0) empty.nodes = 'none';
  if (answer.edges.length === 0) empty.edges = 'none';
  if (answer.grades.length === 0) empty.grades = 'none';
  // No statement at all is the SQL lane never having run, not "this schema has
  // no queries" — the same word the other tools use for a lane that is absent.
  if (answer.statementTypes.length === 0) empty.statementTypes = 'not-shipped';
  if (answer.gaps.length === 0) empty.gaps = 'none';
  if (Object.keys(empty).length) answer.empty = empty;

  // The honesty block twice, in the two places a reader looks: `gaps` is the
  // page's panel, `limits` is what the contract makes an AI read.
  const limits = [...(ctx.limits ?? []), ...o.gaps.map((g) => ({
    scope: 'overview',
    reason: `${g.kind} (${g.count == null ? 'unknown' : g.count}): ${g.note}`,
  }))];
  if (!meta) limits.push({ scope: 'overview', reason: 'this server supplied no pack metadata, so project, digest, build time, lanes and base commit are unknown, not absent' });

  const trunc = [
    // shown === total on all four: a census declares itself complete.
    truncField('nodes', answer.nodes.length, o.nodes.length, 0, 'count desc, kind asc'),
    truncField('edges', answer.edges.length, o.edges.length, 0, 'count desc, type asc, grade asc'),
    truncField('grades', answer.grades.length, o.grades.length, 0, 'grade lattice desc'),
    truncField('statementTypes', answer.statementTypes.length, o.statementTypes.length, 0, 'count desc, type asc'),
    truncField('gaps', answer.gaps.length, o.gaps.length, 0, 'the order the story is told in'),
    truncField('hubs.tables', answer.hubs.tables.length, o.hubs.tables.length, 0, 'endpoints desc, statements desc, table asc'),
    truncField('hubs.endpoints', answer.hubs.endpoints.length, o.hubs.endpoints.length, 0, 'tables desc, statements desc, endpoint asc'),
    truncField('reach.samples.endpointsWithoutStatement', answer.reach.samples.endpointsWithoutStatement.length, o.reach.samples.endpointsWithoutStatement.length, 0, 'id asc'),
    truncField('reach.samples.unreachedStatements', answer.reach.samples.unreachedStatements.length, o.reach.samples.unreachedStatements.length, 0, 'id asc'),
    truncField('reach.samples.unreachedTables', answer.reach.samples.unreachedTables.length, o.reach.samples.unreachedTables.length, 0, 'id asc'),
  ];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['overview']),
    limits, truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

// The lanes each direction answers with, in the order the page draws them.
// This is the FLOOR, not the whole list: on a pack with a frontend the walk
// itself adds `webFunctions` / `endpoints` / `screens` and says so in
// `laneNames` (src/core/chain.mjs), because which lanes an answer has depends
// on which side of the round trip it started from.
const FLOW_LANES = Object.freeze({
  down: ['services', 'statements', 'tables'],
  up: ['statements', 'services', 'endpoints'],
});
// direction=up starts at one of these (exactly one); direction=down at an
// endpoint, a screen or a method, as before.
const UP_ENTRY_KINDS = Object.freeze(['column', 'table', 'statement', 'symbol']);

/**
 * flow — the chain behind one API call: "if I hit this endpoint, which code does
 * it run through, and which tables does it end at?" — and, with direction=up,
 * its mirror: "if I change THIS column / table / statement / method, which HTTP
 * endpoints are affected?" The engine walks (core/chain.mjs); this tool only
 * resolves the entry, cuts the lists and stamps the contract — the page draws
 * what it gets and never re-derives it.
 *
 * Without endpoint/symbol (direction=down) it is a LIST of the endpoints you can
 * walk from. direction=up has no list mode: it needs a target.
 *
 * hop 0 is the entry (the handler method walking down, the target walking up);
 * every row carries the WEAKEST grade on its path, so a chain through one
 * MAY_CALL is SOUND_SET (a candidate) even where its last edge is EXACT. What
 * the walk did not look at comes back in `limits`/`walk.note` — with mode=strict
 * a controller→service call is below the floor, so the whole picture is empty
 * for a reason that is the MODE, not an absence of code.
 */
export function flow(graph, args, ctx) {
  args = args || {}; // called with no arguments at all: that is list mode, not a crash
  const direction = args.direction == null || args.direction === '' ? 'down' : String(args.direction);
  if (direction !== 'down' && direction !== 'up') throw new ToolError('bad-input', 'direction must be down | up');
  const up = direction === 'up';
  const has = (k) => args[k] != null && args[k] !== '';

  let entryKind = null;
  if (up) {
    // An endpoint is where a request ENTERS: nothing in this graph calls it.
    if (has('endpoint')) throw new ToolError('bad-input', 'an endpoint has nothing upstream. direction=up starts at a column, table, statement or method (symbol=)');
    const given = UP_ENTRY_KINDS.filter(has);
    if (given.length > 1) throw new ToolError('bad-input', `pass exactly one of ${UP_ENTRY_KINDS.join(' / ')}, got ${given.join(', ')}`);
    if (given.length === 0) throw new ToolError('bad-input', `direction=up needs a target: one of ${UP_ENTRY_KINDS.join(' / ')} (there is no list mode upstream)`);
    entryKind = given[0];
  } else {
    const wrong = ['column', 'table', 'statement'].filter(has);
    if (wrong.length) throw new ToolError('bad-input', `${wrong.join('/')} is a direction=up target. direction=down starts at an endpoint, a screen or a method (symbol=)`);
    const given = ['endpoint', 'screen', 'symbol'].filter(has);
    if (given.length > 1) throw new ToolError('bad-input', `pass exactly one of endpoint / screen / symbol, got ${given.join(', ')}`);
    if (given.length === 0) return flowList(graph, args, ctx);
    [entryKind] = given;
  }

  const mode = reachMode(args.mode || 'conservative');
  if (!mode) throw new ToolError('bad-input', `mode must be one of ${Object.keys(REACH_MODE).join(', ')}`);
  // Measured on mall: the deepest a column sits below its nearest endpoint is 8
  // hops, so the reverse walk defaults to the full 8 and the node cap is the
  // real guard. Walking down, 6 already reaches the tables on every endpoint.
  // A SCREEN IS FURTHER OUT than a handler: its own function, the api function
  // it calls, the route, the handler, the service, the mapper, the statement is
  // seven hops before a table is even in sight. So a screen entry defaults to
  // the full 8, the way the reverse walk does.
  const depth = clamp(args.depth, 1, 8, (up || entryKind === 'screen') ? 8 : 6);
  const limit = clamp(args.limit, 1, 200, 40);
  // Paging a walk would page a picture: the lists are one connected drawing, so
  // a caller wanting more raises the limit rather than sliding a window.
  if (args.offset != null) throw new ToolError('bad-input', 'offset is not accepted in chain mode. Raise limit instead');

  let entry;
  let start;
  // Set when a route names more than one handler: said in `limits` below, next
  // to everything else this picture did not look at.
  let handlerNote = null;
  // Set when a table/column argument was resolved through the pack's identifier
  // rule rather than matched literally (see schemaArg).
  let entryLimits = [];
  if (entryKind === 'endpoint') {
    const epId = nodeId('endpoint', String(args.endpoint));
    const ep = graph.nodes.get(epId);
    if (!ep) return notFound(ctx, 'endpoint', args.endpoint);
    // The walk starts at the code, not the route: the handler method the
    // endpoint HANDLES. Only a route with no handler edge starts at itself.
    //
    // A route can name MORE THAN ONE handler — the same route string declared in
    // two modules. ONE picture can follow only one of them, and merging the two
    // would claim a request runs through both deployables, so the choice is the
    // shared primary rule (core/walks.mjs, the same method `map` labels the
    // route with) and the others are named in `limits` with the query that draws
    // them. The whole-pack views (overview/map/coupling) walk the UNION instead;
    // that difference is stated in the note, because the same route can then
    // reach more tables in the census than in this one picture.
    const handlerIds = handlersOf(graph, epId);
    start = primaryHandlerOf(graph, epId) ?? epId;
    const handled = handlerIds.length > 0;
    if (handlerIds.length > 1) {
      const others = handlerIds.filter((id) => id !== start);
      handlerNote = `this route is declared by ${handlerIds.length} controller methods, which means the same route string sits in more than one module. This picture follows ${nodeLabel(graph.nodes.get(start), start)}; for the others, ask flow with symbol=${others.map(strip).join(' / symbol=')}. The whole-pack views (overview, map, coupling) walk ALL of them, so their counts for this route can be bigger than this picture`;
    }
    const startNode = graph.nodes.get(start);
    entry = {
      kind: 'endpoint', id: strip(epId), httpMethod: ep.httpMethod ?? null, path: ep.path ?? null,
      // Read from the EDGE, not from the endpoint node's own `handler`: a node
      // merged from two controllers carries whichever was ingested last, and the
      // card must name the method this picture actually walked.
      handler: handled ? strip(start) : (ep.handler ?? null),
      handlerShort: handled ? nodeLabel(startNode, start) : null,
      handlers: handlerIds.length,
      owner: startNode?.owner ?? null,
      file: ep.file ?? null, line: ep.line ?? null, start,
    };
  } else if (entryKind === 'screen') {
    // THE OTHER END OF THE ROUND TRIP (SPEC §1.1). A screen is named by its
    // COMPOSED path, the same string the node is keyed by, so `screen=/things/list`
    // is what a reader sees in the router and in this answer alike.
    const scrId = nodeId('screen', String(args.screen));
    const n = graph.nodes.get(scrId);
    if (!n) return notFound(ctx, 'screen', args.screen);
    start = scrId;
    entry = {
      kind: 'screen', id: strip(scrId), short: nodeLabel(n, scrId),
      path: n.path ?? null, title: n.title ?? null, name: n.name ?? null,
      group: n.group ?? null, component: n.component ?? null,
      source: n.source ?? null, observed: n.observed === true,
      file: n.file ?? null, line: n.line ?? null, start,
    };
  } else if (!up) {
    const symId = nodeId('symbol', String(args.symbol));
    const n = graph.nodes.get(symId);
    if (!n) return notFound(ctx, 'symbol', args.symbol);
    start = symId;
    entry = {
      kind: 'symbol', id: strip(symId), short: nodeLabel(n, symId), owner: n.owner ?? null,
      transactional: n.transactional === true, file: n.file ?? null, line: n.line ?? null, start,
      ...(n.lane === 'web' ? { lane: 'web', component: n.component === true } : {}),
    };
  } else {
    // Walking up, the entry is the thing you are about to change. It is the row
    // the page draws at hop 0 — kept minimal on purpose: what it IS, where it
    // lives, and the node id the lanes hang off.
    //
    // A table/column argument goes through the pack's identifier rule first (a
    // reader types the spelling their SQL uses); statement and symbol names are
    // not schema objects and stay exact.
    let id;
    if (entryKind === 'column' || entryKind === 'table') {
      const r = schemaArg(graph, ctx, entryKind, args[entryKind]);
      id = r.id;
      entryLimits = r.limits;
    } else {
      id = nodeId(entryKind, String(args[entryKind]));
      if (!graph.nodes.has(id)) return notFound(ctx, entryKind, args[entryKind]);
    }
    const n = graph.nodes.get(id);
    start = id;
    entry = { kind: entryKind, id: strip(id), short: nodeLabel(n, id), file: n.file ?? null, line: n.line ?? null, start };
    if (entryKind === 'column' || entryKind === 'table') entry.comment = n.comment ?? null;
    if (entryKind === 'statement') {
      entry.statementType = n.statementType ?? null;
      // The same tables a statement ROW carries, so a statement read as the
      // TARGET is described exactly like one read as a row of the chain.
      entry.tables = graph.outEdges(id)
        .filter((e) => e.type === 'EXECUTES')
        .map((e) => ({ table: strip(e.to), access: graph.edgeAt(e.idx)?.evidence?.access ?? 'read' }))
        .sort((a, b) => cmpStr(a.table, b.table));
    }
    if (entryKind === 'symbol') { entry.owner = n.owner ?? null; entry.transactional = n.transactional === true; }
  }

  const w = chainWalk(graph, { start, direction, mode, maxDepth: depth });

  // Everything the walk skipped, said once — in limits AND in walk.note, so the
  // page has a single place to read it.
  const limits = [...(ctx.limits ?? []), ...entryLimits];
  const notes = [];
  const note = (reason) => { limits.push({ scope: 'flow', reason }); notes.push(reason); };
  if (handlerNote) note(handlerNote);
  if (w.cut.depth > 0) {
    note(up
      ? `depth cap ${depth} reached at ${w.cut.depth} caller(s), so deeper CALLERS were not walked and endpoints beyond are unknown, not absent`
      : `depth cap ${depth} reached at ${w.cut.depth} call(s), so deeper calls were not walked and what they reach is unknown, not absent`);
  }
  if (w.cut.nodeCap) note('node cap reached. The chain from here is bigger than one picture, so lower the depth or start further in');
  if (w.cut.generated > 0) {
    note(`${w.cut.generated} step(s) from one generated symbol to another were not walked, following the profile's generatedSources declaration. A generated method a real caller reaches IS on this picture; what is missing is the machine-written interior below it`);
  }
  if (w.cut.byMode > 0) {
    // Name the mode that WOULD look wider, if there is one. Under heuristic
    // there is none: those links are below every floor, and saying "try
    // conservative" there would send the reader backwards.
    const wider = widerMode(mode);
    note(wider
      ? `${w.cut.byMode} link(s) below the grade floor of mode=${mode} were not walked, so an empty band here can be the mode rather than an absence; try mode=${wider}`
      : `${w.cut.byMode} link(s) are RUNTIME_ONLY/UNRESOLVED, which no mode walks, so an empty band here is what we could not resolve rather than the mode`);
  }
  // No code axis at all: the lanes above the SQL are not empty, they were never
  // shipped. Said here as well as in `empty`, so a reader of the note alone
  // cannot mistake this picture for "nothing calls this column".
  const codeAxis = hasCodeAxis(graph, ctx);
  if (!codeAxis) note('this pack has no code axis, because the Java lane did not run. The picture stops at the statements, and the service and endpoint columns are not shipped rather than empty');

  const answer = {
    entry,
    walk: {
      mode, direction, depth, walked: w.walked,
      // Reached and counted in `walked`, but shown in no lane (an injected type,
      // an outbound HTTP call, a screen): named, never quietly dropped.
      other: w.other,
      byLinkGrade: w.byLinkGrade, cut: w.cut,
      // The end-of-chain rows a reached node NAMES but the walk never stepped
      // onto (its statement / its handler sat at the depth cap): known, not
      // walked, and in no layer. `tables` walking down, `endpoints` walking up.
      beyond: w.beyond,
      endLane: w.endLane,
      note: notes.length ? notes.join('  ') : null,
    },
    // The same walk folded per hop. A census, so `limit` never cuts it — that
    // is why it carries no truncated entry.
    layers: w.layers,
  };
  const empty = {};
  const trunc = [];
  for (const field of (w.laneNames ?? FLOW_LANES[direction])) {
    const all = w[field];
    const shown = all.slice(0, limit);
    answer[field] = shown;
    // A lane the TARGET sits on the wrong side of is "not in this axis", not
    // "none" — the walk says which, this only reports it. And a CODE lane on a
    // pack with no code axis is "not-shipped", the same word endpoint_impact,
    // transactions and flow-list use: "none" would read as "no endpoint reaches
    // this column", when the Java lane was simply never run.
    if (shown.length === 0) {
      empty[field] = w.emptyReason[field]
        ?? ((field === 'services' || field === 'endpoints') && !codeAxis ? 'not-shipped' : 'none');
    }
    trunc.push({ field, shown: shown.length, total: all.length, order: FLOW_ORDER[field], nextOffset: shown.length < all.length ? shown.length : null });
  }
  if (answer.layers.length === 0) empty.layers = 'none'; // a walk that reached nothing has no layers
  if (Object.keys(empty).length) answer.empty = empty;
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['flow']),
    limits, truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

const FLOW_ORDER = Object.freeze({
  services: 'hops asc, grade desc, id asc',
  webFunctions: 'hops asc, grade desc, id asc',
  screens: 'hops asc, grade desc, id asc',
  statements: 'hops asc, grade desc, id asc',
  tables: 'hops asc, grade desc, table asc',
  endpoints: 'hops asc, grade desc, id asc',
});

/**
 * THE HANDLER A LIST NAMES for one route, in ONE place.
 *
 * Read off the HANDLES edges (the shared primary rule), never off the endpoint
 * node's own `handler` — on a route two controllers declare, that attribute is
 * whichever of them the analyzer ingested last. `flow`'s entry picker and
 * `browse`'s endpoint rows both name a route's handler, and two copies of these
 * three lines is how the two lists would come to name different methods for the
 * same route.
 *
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {{id:string, handler?:string|null}} n  an endpoint node
 * @returns {{handlerIds:string[], handlerId:(string|null), handlerShort:(string|null)}}
 */
function endpointHandler(graph, n) {
  const handlerIds = handlersOf(graph, n.id);
  const handlerId = handlerIds[0] ?? (n.handler ? nodeId('symbol', n.handler) : null);
  return {
    handlerIds,
    handlerId,
    handlerShort: handlerId ? nodeLabel(graph.nodes.get(handlerId), handlerId) : null,
  };
}

/** flow list mode — the endpoints or screens a chain can be walked from (the entry picker). */
function flowList(graph, args, ctx) {
  const limit = clamp(args.limit, 1, 500, 100);
  const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const q = args.query != null && args.query !== '' ? String(args.query).toLowerCase() : null;
  const kind = args.kind == null || args.kind === '' ? 'endpoint' : String(args.kind);
  if (kind !== 'endpoint' && kind !== 'screen') throw new ToolError('bad-input', 'kind must be endpoint | screen');
  if (kind === 'screen') return flowScreenList(graph, { q, limit, offset }, ctx);
  const all = [];
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    // The handler this picker names is the one `flow` would actually walk from
    // (the shared primary rule), read off the HANDLES edges — not the endpoint
    // node's own `handler`, which on a route two controllers declare is
    // whichever of them the analyzer ingested last. `handlers` says when there
    // is more than one, so the list can show it without a second lookup.
    const { handlerIds, handlerId, handlerShort } = endpointHandler(graph, n);
    const item = {
      id: strip(n.id), httpMethod: n.httpMethod ?? null, path: n.path ?? null,
      handler: handlerId ? strip(handlerId) : null,
      handlerShort,
      handlers: handlerIds.length,
      file: n.file ?? null, line: n.line ?? null,
    };
    // The query matches EVERY handler of the route, not only the one named: a
    // reader searching for the second controller must still find its route.
    const hay = `${item.httpMethod ?? ''} ${item.path ?? ''} ${handlerIds.map(strip).join(' ') || item.handler || ''}`;
    if (q && !hay.toLowerCase().includes(q)) continue;
    all.push(item);
  }
  all.sort((a, b) => cmpStr(a.path, b.path) || cmpStr(a.httpMethod, b.httpMethod));
  const shown = all.slice(offset, offset + limit);
  const answer = { kind, query: q, entries: shown };
  if (shown.length === 0) {
    // 0 matches with a code axis present is an absence; 0 endpoints at all means
    // the Java lane never ran — "not shipped", not "nothing to see".
    answer.empty = { entries: all.length > 0 ? 'not-in-this-axis' : (hasCodeAxis(graph, ctx) ? 'none' : 'not-shipped') };
  }
  const trunc = [truncField('entries', shown.length, all.length, offset, 'path asc, httpMethod asc')];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['flow']),
    limits: ctx.limits ?? [], truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/**
 * flow list mode, the OTHER entry picker: the screens a chain can be walked
 * from, with the component each one mounts and how many routes it reaches. The
 * census is the shared per-pack one (`walkScreens` through `screenCensus`), so
 * this list and `browse kind=screen` cannot disagree about a number.
 */
function flowScreenList(graph, p, ctx) {
  const census = screenCensus(graph);
  const all = census.rows.map((r) => ({
    screen: r.path, label: r.label, title: r.title, group: r.group,
    component: r.component, source: r.source, observed: r.observed,
    endpoints: r.endpoints.size, tables: r.tables.size,
  }));
  const matched = p.q === null
    ? all
    : all.filter((r) => `${r.screen} ${r.label ?? ''} ${r.title ?? ''} ${r.component ?? ''}`.toLowerCase().includes(p.q));
  matched.sort((a, b) => (b.endpoints - a.endpoints) || cmpStr(a.screen, b.screen));
  const shown = matched.slice(p.offset, p.offset + p.limit);
  const answer = { kind: 'screen', query: p.q, entries: shown };
  if (shown.length === 0) {
    answer.empty = { entries: matched.length > 0 ? 'not-in-this-axis' : screenNoneReason(graph, ctx) };
  }
  const trunc = [truncField('entries', shown.length, matched.length, p.offset, 'endpoints desc, screen asc')];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['flow', 'screen']),
    limits: [...(ctx.limits ?? []), screenWalkLimit()],
    truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/** search — find tables/columns/statements by name substring (entry point). */
export function search(graph, args, ctx) {
  const q = req(args, 'query');
  if (String(q).length < 2) return badInput(ctx, 'query must be at least 2 characters');
  const limit = clamp(args.limit, 1, LIMITS.max, 10);
  const needle = String(q).toLowerCase();
  const tables = [];
  const columns = [];
  const statements = [];
  // The frontend's own functions, which are keyed by FILE PATH plus name, so a
  // reader finds them by either half ("orders", "getOrder", "api/orders.js").
  const webSymbols = [];
  // The screens the router declares, matched by path, label or title, so a
  // reader who knows the menu entry can find the route.
  const screens = [];
  for (const n of graph.nodes.values()) {
    const key = n.id.slice(n.id.indexOf(':') + 1);
    const hay = n.kind === 'screen'
      ? `${key} ${n.label ?? ''} ${n.title ?? ''} ${n.component ?? ''}`.toLowerCase()
      : `${key} ${n.comment ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    if (n.kind === 'table') tables.push({ table: key, comment: n.comment ?? null });
    else if (n.kind === 'column') columns.push({ column: key, comment: n.comment ?? null });
    else if (n.kind === 'statement') statements.push({ statement: key });
    else if (n.kind === 'screen') {
      screens.push({
        screen: key, label: n.label ?? null, title: n.title ?? null,
        component: n.component ?? null, source: n.source ?? null,
      });
    } else if (n.kind === 'symbol' && n.lane === 'web') {
      webSymbols.push({ symbol: key, file: n.file ?? null, line: n.line ?? null });
    }
  }
  tables.sort((a, b) => (a.table < b.table ? -1 : 1));
  columns.sort((a, b) => (a.column < b.column ? -1 : 1));
  statements.sort((a, b) => (a.statement < b.statement ? -1 : 1));
  webSymbols.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  screens.sort((a, b) => (a.screen < b.screen ? -1 : 1));
  const answer = multiListAnswer(
    {
      tables: tables.slice(0, limit),
      columns: columns.slice(0, limit),
      statements: statements.slice(0, limit),
      webSymbols: webSymbols.slice(0, limit),
      screens: screens.slice(0, limit),
    },
    {
      tables: tables.length,
      columns: columns.length,
      statements: statements.length,
      webSymbols: webSymbols.length,
      screens: screens.length,
    },
    { limit },
  );
  return respond(ctx, answer, ['column'], null);
}

// ---- browse: the lists a reader picks from, instead of a search box --------
//
// The page opens Explore, Flow and Impact on the PACK rather than on an empty
// input, and the README rule is that the page re-derives nothing: every row and
// every count on that rail is an answer, not a count the browser did. So this
// is one tool that lists a kind, with the numbers a reader picks by already on
// each row.
//
// THE ONE CENSUS. Three of those numbers ("how many endpoints reach this
// table / this column / this statement") are the same per-endpoint forward walk
// `overview`, `map` and `coupling` run, and running it per request would pay
// for it once per keystroke. It is run ONCE per pack and memoised on the graph
// object, then INVERTED: endpoint -> statements becomes statement -> endpoints,
// and from each statement's own SQL edges, table -> endpoints and
// column -> endpoints. The walk is fixed at mode=conservative, depth 8 (the
// whole-pack default), and every answer says so in `limits`: a row's `endpoints`
// is what THAT walk reaches, and what a wider one would add is unknown, not
// absent.

const BROWSE_CENSUS = new WeakMap();
const BROWSE_CENSUS_MODE = 'conservative';
const BROWSE_CENSUS_DEPTH = 8;
const EMPTY_SET = Object.freeze(new Set());

/**
 * The per-pack census, computed once and kept on the graph.
 * @param {import('../core/graph.mjs').Graph} graph
 * @returns {{endpoints:Map<string,{statements:Set<string>,tables:Set<string>}>,
 *            stmtEps:Map<string,Set<string>>, tableEps:Map<string,Set<string>>,
 *            colEps:Map<string,Set<string>>, counts:Object}}
 */
function browseCensus(graph) {
  const cached = BROWSE_CENSUS.get(graph);
  if (cached) return cached;
  const w = walkEndpoints(graph, { mode: BROWSE_CENSUS_MODE, depth: BROWSE_CENSUS_DEPTH });
  const endpoints = new Map();
  const stmtEps = new Map();
  const tableEps = new Map();
  const colEps = new Map();
  const add = (m, k, v) => { let s = m.get(k); if (!s) m.set(k, s = new Set()); s.add(v); };
  for (const ep of w.endpoints) {
    const statements = new Set(ep.statements.map((s) => s.id));
    const tables = new Set();
    for (const sid of statements) {
      add(stmtEps, sid, ep.id);
      for (const e of graph.outEdges(sid)) {
        if (e.type === 'EXECUTES') { tables.add(e.to); add(tableEps, e.to, ep.id); }
        else if (e.type === 'READS' || e.type === 'WRITES') add(colEps, e.to, ep.id);
      }
    }
    endpoints.set(ep.id, { statements, tables });
  }
  // The kind census the rail's chips print. An OUTBOUND route is a route this
  // pack CALLS and does not serve, so it is not one of this pack's endpoints and
  // it is neither counted nor listed (`walkEndpoints` drops it for the same
  // reason). Everything else is one row per node.
  const counts = { table: 0, column: 0, statement: 0, endpoint: 0, symbol: 0, screen: 0 };
  for (const n of graph.nodes.values()) {
    if (!Object.hasOwn(counts, n.kind)) continue;
    if (n.kind === 'endpoint' && !endpoints.has(n.id)) continue;
    counts[n.kind] += 1;
  }
  const census = { endpoints, stmtEps, tableEps, colEps, counts };
  BROWSE_CENSUS.set(graph, census);
  return census;
}

const BROWSE_KINDS = Object.freeze(['table', 'column', 'statement', 'endpoint', 'symbol', 'screen']);
// The sorts each kind offers. The FIRST is the default, and it is the
// busiest-first one for every kind but `symbol`: a rail that opened on the
// alphabet would put `act_ge_bytearray` on the first screen of every project.
const BROWSE_SORTS = Object.freeze({
  table: ['statements', 'endpoints', 'groups', 'columns', 'name'],
  column: ['writes', 'reads', 'endpoints', 'name'],
  statement: ['tables', 'name'],
  endpoint: ['tables', 'statements', 'path'],
  symbol: ['name'],
  screen: ['endpoints', 'tables', 'name'],
});
// The field that IS the row's id, per kind: the tiebreak of every sort, so two
// rows with the same count come back in the same order every time.
const BROWSE_ID = Object.freeze({
  table: 'table', column: 'column', statement: 'statement', endpoint: 'endpoint', symbol: 'symbol',
  screen: 'screen',
});
// A sort key the row does not carry as a field of its own.
const BROWSE_KEY = Object.freeze({
  'table:statements': (r) => r.statementsRead + r.statementsWrite,
});

function browseSortKey(kind, sort) {
  return BROWSE_KEY[`${kind}:${sort}`] ?? ((r) => r[sort]);
}
function browseCmp(kind, sort) {
  const id = BROWSE_ID[kind];
  if (sort === 'path') return (a, b) => cmpStr(a.path, b.path) || cmpStr(a.httpMethod, b.httpMethod) || cmpStr(a[id], b[id]);
  if (sort === 'name') return (a, b) => cmpStr(a[id], b[id]);
  const key = browseSortKey(kind, sort);
  return (a, b) => (Number(key(b) ?? 0) - Number(key(a) ?? 0)) || cmpStr(a[id], b[id]);
}
function browseOrder(kind, sort) {
  const id = BROWSE_ID[kind];
  if (sort === 'path') return 'path asc, httpMethod asc';
  if (sort === 'name') return `${id} asc`;
  return `${sort} desc, ${id} asc`;
}

/**
 * browse — one kind of thing in this pack, as rows a reader can pick from.
 *
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {{kind:string, query?:string, table?:string, sort?:string, limit?:number, offset?:number}} args
 * @param {Object} ctx
 */
export function browse(graph, args, ctx) {
  args = args || {};
  const kind = args.kind == null || args.kind === '' ? null : String(args.kind);
  if (!BROWSE_KINDS.includes(kind)) {
    throw new ToolError('bad-input', `kind must be one of ${BROWSE_KINDS.join(', ')}`);
  }
  const q = args.query == null || args.query === '' ? null : String(args.query).toLowerCase();
  // A pack carries tens of thousands of methods (mall: 10784), and a list of all
  // of them is not a list anybody reads. So this kind alone demands a query.
  if (kind === 'symbol' && (q === null || q.length < 2)) {
    throw new ToolError('bad-input', 'kind=symbol needs a query of at least 2 characters: a pack carries tens of thousands of methods, and every one of them is not a list');
  }
  const sorts = BROWSE_SORTS[kind];
  const sort = args.sort == null || args.sort === '' ? sorts[0] : String(args.sort);
  if (!sorts.includes(sort)) {
    throw new ToolError('bad-input', `sort for kind=${kind} must be one of ${sorts.join(', ')}`);
  }
  const limit = clamp(args.limit, 1, 500, 200);
  const offset = clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  let tableKey = null;
  let entryLimits = [];
  if (args.table != null && args.table !== '') {
    if (kind !== 'column') throw new ToolError('bad-input', 'table= narrows kind=column to one table\'s columns, and means nothing for the other kinds');
    const r = schemaArg(graph, ctx, 'table', args.table);
    tableKey = r.key;
    entryLimits = r.limits;
  }

  const census = browseCensus(graph);
  const packageDepth = packageDepthOf(ctx);
  const groupCache = new Map();
  const groupOf = (epId) => {
    let g = groupCache.get(epId);
    if (g === undefined) groupCache.set(epId, g = groupOfEndpoint(graph.nodes.get(epId) || {}, { packageDepth }));
    return g;
  };
  // WHICH SCREENS a table or a column is felt on, from the same `walkScreens`
  // census `browse kind=screen` lists. Absent on a pack with no screen axis,
  // because `screens: 0` there would read as "no screen touches this table",
  // when the truth is that no frontend was ever analyzed.
  const reach = (kind === 'table' || kind === 'column') && axisStatus(graph, ctx, 'screen') !== 'not-shipped'
    ? screenReach(graph) : null;
  const built = browseRows(graph, kind, census, { tableKey, groupOf, reach });
  const matched = (q ? built.filter((x) => x.hay.includes(q)) : built).map((x) => x.row);
  matched.sort(browseCmp(kind, sort));
  const shown = matched.slice(offset, offset + limit);

  const answer = { kind, sort, items: shown, total: matched.length, counts: { ...census.counts } };
  if (shown.length === 0) answer.empty = { items: matched.length > 0 ? 'not-in-this-axis' : browseNoneReason(graph, ctx, kind) };

  const limits = [...(ctx.limits ?? []), ...entryLimits, {
    scope: 'browse',
    reason: `\`endpoints\` on a row counts the endpoints whose walk (mode=${BROWSE_CENSUS_MODE}, depth ${BROWSE_CENSUS_DEPTH}) reaches a statement that touches it. It is the same forward walk \`flow\` draws and \`map\` and \`coupling\` count on, so what a deeper or wider walk would add is unknown, not absent`,
  }];
  if (kind === 'endpoint' || kind === 'table') limits.push(groupingLimit('browse', ctx));
  if (kind === 'screen' || reach) limits.push(screenWalkLimit());
  const trunc = [truncField('items', shown.length, matched.length, offset, browseOrder(kind, sort))];
  return makeResponse({
    answer, basis: ctx.basis,
    trust: trustFor(ctx, ['browse']),
    limits, truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

/** Why a kind lists nothing: a lane that never ran, or a lane that found none. */
function browseNoneReason(graph, ctx, kind) {
  if (kind === 'screen') return screenNoneReason(graph, ctx);
  if (kind === 'endpoint' || kind === 'symbol') return hasCodeAxis(graph, ctx) ? 'none' : 'not-shipped';
  if (kind === 'statement') return axisStatus(graph, ctx, 'statements') === 'not-shipped' ? 'not-shipped' : 'none';
  if (kind === 'column') return axisStatus(graph, ctx, 'catalog') === 'not-shipped' ? 'not-shipped' : 'none';
  return 'none';
}

/**
 * Every row of one kind, each with the lower-cased text `query` matches.
 * @returns {{row:Object, hay:string}[]}
 */
function browseRows(graph, kind, census, opts) {
  const out = [];
  if (kind === 'table') {
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'table') continue;
      let columns = 0;
      for (const e of graph.outEdges(n.id)) if (e.type === 'DECLARES') columns += 1;
      // A statement is a reader or a writer of this table by the access ITS
      // EXECUTES edge carries; a delete is a write (it changes the rows).
      const read = new Set();
      const write = new Set();
      for (const e of graph.inEdges(n.id)) {
        if (e.type !== 'EXECUTES') continue;
        const access = graph.edgeAt(e.idx)?.evidence?.access;
        (access === 'write' || access === 'delete' ? write : read).add(e.from);
      }
      const eps = census.tableEps.get(n.id) ?? EMPTY_SET;
      const groups = new Set();
      for (const ep of eps) groups.add(opts.groupOf(ep));
      const row = {
        table: strip(n.id), comment: n.comment ?? null, columns,
        statementsRead: read.size, statementsWrite: write.size,
        endpoints: eps.size, groups: groups.size,
        ...(opts.reach ? { screens: (opts.reach.tables.get(n.id) ?? EMPTY_SET).size } : {}),
      };
      out.push({ row, hay: `${row.table} ${row.comment ?? ''}`.toLowerCase() });
    }
    return out;
  }
  if (kind === 'column') {
    // One table's columns are matched by the id prefix, the same rule
    // `table_usage` counts them by: a pack with no DB catalog has column nodes
    // that no DECLARES edge points at, and they still belong to their table.
    const prefix = opts.tableKey == null ? null : `column:${opts.tableKey}.`;
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'column') continue;
      if (prefix !== null && !n.id.startsWith(prefix)) continue;
      let reads = 0;
      let writes = 0;
      for (const e of graph.inEdges(n.id)) {
        if (e.type === 'READS') reads += 1;
        else if (e.type === 'WRITES') writes += 1;
      }
      const key = strip(n.id);
      const row = {
        column: key, table: tableOf(key), type: n.type ?? null, pk: n.pk === true,
        comment: n.comment ?? null, reads, writes,
        endpoints: (census.colEps.get(n.id) ?? EMPTY_SET).size,
        ...(opts.reach ? { screens: (opts.reach.columns.get(n.id) ?? EMPTY_SET).size } : {}),
      };
      out.push({ row, hay: `${row.column} ${row.comment ?? ''}`.toLowerCase() });
    }
    return out;
  }
  if (kind === 'statement') {
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'statement') continue;
      const tables = new Set();
      for (const e of graph.outEdges(n.id)) if (e.type === 'EXECUTES') tables.add(e.to);
      const row = {
        statement: strip(n.id), type: n.statementType ?? null, tables: tables.size,
        // The statement's own two honesty flags, carried from the lanes: text
        // spliced into the SQL at run time, and a column list the bridge could
        // not fully resolve. Both make the row a lower bound.
        hasUnresolved: n.hasUnresolved === true, hasStringSubst: n.hasStringSubst === true,
        file: n.file ?? null, line: n.line ?? null,
        endpoints: (census.stmtEps.get(n.id) ?? EMPTY_SET).size,
      };
      out.push({ row, hay: `${row.statement} ${row.file ?? ''}`.toLowerCase() });
    }
    return out;
  }
  if (kind === 'screen') {
    for (const r of screenCensus(graph).rows) {
      const row = {
        screen: r.path ?? strip(r.id),
        path: r.path,
        label: r.label,
        title: r.title,
        group: r.group,
        component: r.component,
        // A screen the router never declared, seen only in a recording. It has
        // no component and no RENDERS edge, and the row says which it is.
        source: r.source,
        endpoints: r.endpoints.size,
        tables: r.tables.size,
        observed: r.observed,
      };
      out.push({ row, hay: `${row.screen} ${row.label ?? ''} ${row.title ?? ''} ${row.component ?? ''}`.toLowerCase() });
    }
    return out;
  }
  if (kind === 'endpoint') {
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'endpoint') continue;
      const reach = census.endpoints.get(n.id);
      if (!reach) continue;   // outbound: a route this pack calls and does not serve
      const { handlerIds, handlerShort } = endpointHandler(graph, n);
      const row = {
        endpoint: strip(n.id), httpMethod: n.httpMethod ?? null, path: n.path ?? null,
        group: opts.groupOf(n.id), handlerShort, handlers: handlerIds.length,
        statements: reach.statements.size, tables: reach.tables.size,
      };
      out.push({ row, hay: `${row.httpMethod ?? ''} ${row.path ?? ''} ${handlerIds.map(strip).join(' ')}`.toLowerCase() });
    }
    return out;
  }
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'symbol') continue;
    const key = strip(n.id);
    const row = {
      symbol: key, owner: n.owner ?? null, short: nodeLabel(n, n.id),
      file: n.file ?? null, line: n.line ?? null,
      transactional: n.transactional === true, mapperMethod: n.mapperMethod === true,
      external: n.external === true,
    };
    out.push({ row, hay: key.toLowerCase() });
  }
  return out;
}

/**
 * projects — what this SERVER serves (SPEC §13 MUST, §15 M8). The one tool that
 * is not about a pack: it answers from the registry and the pack cache, so it
 * takes no `project` argument and loads nothing. `answer.projects` is the
 * registry listing with, per project, whether its pack is currently in memory
 * and how many bytes of pack JSON that is; `answer.cache` is the LRU's own
 * accounting (§17.6) — how many are loaded, against which budget, and how many
 * evictions it has done since the server started.
 *
 * The basis is the SERVER, not a pack: `project:'*'`, no build digest, freshness
 * unknown. A listed project's `lastCertifiedAt` is what the REGISTRY recorded at
 * its last analyze — it is not a freshness check on that project's pack.
 */
export function projects(graph, args, ctx) {
  const host = ctx && ctx.projects;
  if (!host || typeof host.list !== 'function') {
    throw new ToolError('bad-input', 'this server keeps no project registry (it was started on a single pack), and every other tool answers that pack directly');
  }
  const items = host.list();
  const answer = {
    projects: items,
    cache: typeof host.stats === 'function' ? host.stats() : null,
  };
  if (items.length === 0) answer.empty = { projects: 'none' };
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: trustFor(ctx, ['server']),
    limits: ctx.limits ?? [],
    // The registry listing is never cut: a server that serves N projects names
    // all N, or the AI cannot know which ids exist to route to.
    truncated: { any: false, fields: [{ field: 'projects', shown: items.length, total: items.length, order: 'id asc', nextOffset: null }] },
  });
}

// ---- shared assembly -------------------------------------------------------

// `noneReason` lets a caller say WHY an empty result is empty when the pack's
// declared axes know better than the list length does: "there is no statement in
// this pack at all" is `not-shipped`, not `none` (SPEC §10.4).
function listAnswer(field, items, limit, offset, extra, noneReason = 'none') {
  const shown = items.slice(offset, offset + limit);
  const a = { ...extra, [field]: shown };
  if (shown.length === 0) a.empty = { [field]: items.length === 0 ? noneReason : 'not-in-this-axis' };
  a.__trunc = [truncField(field, shown.length, items.length, offset)];
  return a;
}

function multiListAnswer(lists, totals, p) {
  const a = {};
  const trunc = [];
  const empty = {};
  for (const [field, shown] of Object.entries(lists)) {
    a[field] = shown;
    const total = totals[field];
    const off = field === 'statements' ? (p.statementsOffset || 0) : 0;
    if (shown.length === 0) empty[field] = total === 0 ? 'none' : 'not-in-this-axis';
    trunc.push(truncField(field, shown.length, total, off));
  }
  if (Object.keys(empty).length) a.empty = empty;
  a.__trunc = trunc;
  return a;
}

function truncField(field, shown, total, offset, order = 'grade/access desc, id asc') {
  const more = offset + shown < total;
  return { field, shown, total, order, nextOffset: more ? offset + shown : null };
}

function respond(ctx, answer, axes, node, extraLimits = []) {
  const trunc = answer.__trunc;
  delete answer.__trunc;
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: trustFor(ctx, axes),
    limits: extraLimits.length ? [...(ctx.limits ?? []), ...extraLimits] : (ctx.limits ?? []),
    truncated: { any: trunc.some((t) => t.nextOffset != null), fields: trunc },
  });
}

function notFound(ctx, kind, key) {
  const err = new ToolError(`unknown-${kind}`, `${kind} not found in pack: ${key}`);
  throw err;
}

// ---- arguments that name a schema object (SPEC §8.1) ----------------------
// A reader types the spelling their SQL uses (`ORDERS`); the pack stores the
// catalog's (`orders`). The lineage worker already treats those as ONE table
// under the dialect's declared identity rule, so the query layer must too —
// through the SAME fold (src/core/name_resolve.mjs), driven by the rule the
// pack RECORDS (`pack.meta.identifierCase`), never by a guess. A pack that
// declares no rule (one an older engine built) folds nothing and behaves
// exactly as it did before.
const SCHEMA_KINDS = new Set(['table', 'column']);

/** The identity rule this pack was built under, or null when it declares none. */
function identifierCaseOf(ctx) {
  const c = ctx && ctx.pack ? ctx.pack.identifierCase : null;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

/**
 * Resolve a `table=` / `column=` argument to a node id.
 * @returns {{id:string, key:string, limits:Array}} `limits` carries ONE line
 *          when the hit came from a fold — an answer about a name other than
 *          the one that was typed always says so.
 * @throws {ToolError} `unknown-<kind>`, with "did you mean …" when a near name exists
 */
function schemaArg(graph, ctx, kind, typed) {
  const r = resolveSchemaName(graph, kind, String(typed), identifierCaseOf(ctx));
  if (r.how === 'exact') return { id: r.id, key: r.key, limits: [] };
  if (r.how === 'folded') {
    return {
      id: r.id,
      key: r.key,
      limits: [{
        scope: 'identifier-case',
        reason: `nothing is spelled ${JSON.stringify(r.typed)} in this pack, so we read it as the ${kind} ${JSON.stringify(r.key)}. That follows the identity rule this pack was built with (${r.identifierCase}), the same rule the SQL analyzer uses to match two spellings inside one statement. The answer below is about ${JSON.stringify(r.key)}`,
      }],
    };
  }
  let msg = `${kind} not found in pack: ${r.typed}`;
  if (r.how === 'ambiguous') {
    msg += `: ${r.candidates.join(', ')} all fold onto it under this pack's identity rule (${r.identifierCase}), so the argument names more than one ${kind}. Ask for one of them exactly`;
  } else if (r.suggestions.length > 0) {
    msg += `. Did you mean ${r.suggestions.join(', ')}?`;
  }
  throw new ToolError(`unknown-${kind}`, msg);
}
function badInput(ctx, msg) { throw new ToolError('bad-input', msg); }

function req(args, name) {
  if (!args || args[name] == null || args[name] === '') throw new ToolError('bad-input', `missing required arg: ${name}`);
  return args[name];
}
function paging(args) {
  return { limit: clamp(args.limit, 1, LIMITS.max, LIMITS.default), offset: clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0) };
}
function clamp(v, lo, hi, dflt) {
  if (v == null) return dflt;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new ToolError('bad-input', `value out of range [${lo},${hi}]: ${v}`);
  return v;
}
function cut(arr, limit, offset) { return arr.slice(offset, offset + limit); }
const GRADE_RANK = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };
function gradeRank(g) { return GRADE_RANK[g] ?? -1; }
/**
 * The status of one axis: what the PACK DECLARED (SPEC §10.4) when it declared
 * anything, and otherwise what the graph's shape implies. The declaration wins
 * because it can say things a shape cannot — a column axis that ran without a
 * DB catalog looks exactly like a healthy one from the graph, and is `degraded`.
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {Object} ctx
 * @param {string} axis
 * @returns {'shipped'|'degraded'|'not-shipped'}
 */
function axisStatus(graph, ctx, axis) {
  const declared = ctx && ctx.pack && ctx.pack.axes && ctx.pack.axes[axis];
  if (declared && typeof declared.status === 'string') return declared.status;
  // Fallback for a pack built before axes were declared: infer from the shape.
  switch (axis) {
    case 'code': return anyKind(graph, 'endpoint') ? 'shipped' : 'not-shipped';
    case 'statements': return anyKind(graph, 'statement') ? 'shipped' : 'not-shipped';
    case 'catalog': return anyKind(graph, 'column') ? 'shipped' : 'not-shipped';
    case 'column': return graph.edges.some((e) => e.type === 'READS' || e.type === 'WRITES') ? 'shipped' : 'not-shipped';
    case 'screen': return anyKind(graph, 'screen') ? 'shipped' : 'not-shipped';
    default: return 'not-shipped';
  }
}
/** The profile's declared module-attribution depth, or null (the path rule). */
function packageDepthOf(ctx) {
  const d = ctx && ctx.profile && ctx.profile.moduleAttribution
    ? ctx.profile.moduleAttribution.packageDepth : null;
  return Number.isInteger(d) && d > 0 ? d : null;
}
/** Say WHICH grouping rule produced the groups in this answer — the two are not comparable. */
function groupingLimit(scope, ctx) {
  const depth = packageDepthOf(ctx);
  return depth == null
    ? { scope, reason: 'a group is the first segment of an API path. It is a naming habit, not a module boundary anyone declared' }
    : { scope, reason: `a group is the handler's package, cut to ${depth} segment(s) by the profile's moduleAttribution.packageDepth. That is a boundary the project declared in its code layout, not the API path` };
}
function anyKind(graph, kind) {
  for (const n of graph.nodes.values()) if (n.kind === kind) return true;
  return false;
}
/**
 * Was the CODE axis actually walked here?
 *
 * SHIPPED, not "anything but not-shipped": a `degraded` code axis is a pack
 * whose endpoints came from an OpenAPI document and whose chains below them were
 * never walked (src/core/lanes.mjs). Asking such a pack which endpoint reaches a
 * column has no answer, and calling the empty list `none` would say we looked.
 */
function hasCodeAxis(graph, ctx) {
  return axisStatus(graph, ctx, 'code') === 'shipped';
}
function tableOf(columnKeyStr) { const p = String(columnKeyStr).split('.'); return p.length > 1 ? p.slice(0, -1).join('.') : columnKeyStr; }
// Cardinality of a JOINS relationship, inferred from which side joins on a PK:
// a PK side is "1", a non-PK side is "N", an unknown column is "?". Uses the
// first column pair "fromCol=toCol". (A PK↔FK join is 1:N, PK↔PK is 1:1.)
function cardinalityOf(graph, fromTable, toTable, columns) {
  if (!columns || !columns.length) return '?:?';
  const eq = columns[0].split('=');
  if (eq.length !== 2) return '?:?';
  const side = (table, col) => {
    const n = graph.nodes.get(nodeId('column', `${table}.${col}`));
    return n ? (n.pk === true ? '1' : 'N') : '?';
  };
  return `${side(fromTable, eq[0])}:${side(toTable, eq[1])}`;
}
// Resolve a focus node for the graph slice: an explicit `node` id, or one of the
// kind-specific args (column/table/statement/endpoint/symbol). Throws if absent.
// A table/column focus — including one spelled as a `node` id — goes through the
// pack's identifier rule (schemaArg), so the focus of a picture is found by the
// same name the other tools accept. Returns the id AND any disclosure the fold
// owes the caller.
function resolveNodeArg(graph, ctx, args) {
  if (args && typeof args.node === 'string' && args.node) {
    if (graph.nodes.has(args.node)) return { id: args.node, limits: [] };
    // A `node="table:ORDERS"` names a schema object just as `table="ORDERS"`
    // does, so it folds too. Its ERROR stays `unknown-node` (the code a client
    // pinned to this argument), and only gains the same suggestion.
    const i = args.node.indexOf(':');
    const kind = i > 0 ? args.node.slice(0, i) : null;
    const key = i > 0 ? args.node.slice(i + 1) : '';
    if (SCHEMA_KINDS.has(kind) && key !== '') {
      const r = resolveSchemaName(graph, kind, key, identifierCaseOf(ctx));
      if (r.how === 'exact' || r.how === 'folded') {
        const a = schemaArg(graph, ctx, kind, key);
        return { id: a.id, limits: a.limits };
      }
      const hint = r.how === 'ambiguous'
        ? `: ${r.candidates.map((c) => `${kind}:${c}`).join(', ')} all fold onto it under this pack's identity rule (${r.identifierCase})`
        : r.suggestions.length > 0 ? `. Did you mean ${r.suggestions.map((c) => `${kind}:${c}`).join(', ')}?` : '';
      throw new ToolError('unknown-node', `node not in pack: ${args.node}${hint}`);
    }
    throw new ToolError('unknown-node', `node not in pack: ${args.node}`);
  }
  const kinds = ['column', 'table', 'statement', 'endpoint', 'symbol', 'screen'];
  for (const k of kinds) {
    if (args && args[k]) {
      if (SCHEMA_KINDS.has(k)) {
        const r = schemaArg(graph, ctx, k, args[k]);
        return { id: r.id, limits: r.limits };
      }
      const id = nodeId(k, String(args[k]));
      if (!graph.nodes.has(id)) throw new ToolError(`unknown-${k}`, `${k} not in pack: ${args[k]}`);
      return { id, limits: [] };
    }
  }
  throw new ToolError('bad-input', `neighborhood needs a focus: node="<kind>:<key>" or one of ${kinds.join('/')}`);
}
// nodeLabel lives in core/chain.mjs so the walk, these tools and the page all
// name a node the same way (one rule, imported — not three copies).
function strip(id) { return id.slice(id.indexOf(':') + 1); }
function cmpStr(a, b) { const x = String(a ?? ''), y = String(b ?? ''); return x < y ? -1 : x > y ? 1 : 0; }
function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function byAccessThenId(a, b) {
  if (a.access !== b.access) return a.access === 'write' ? -1 : 1; // writes first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ToolError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code; }
}
