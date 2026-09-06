// chain.mjs — the chain walk behind the Flow view ("if I hit this API, which
// code does it run through, and which tables does it end at?") and behind its
// mirror, the Impact view ("if I change THIS column / table / statement /
// method, which HTTP endpoints are affected?").
//
// ONE BFS from a start node, in one of two directions, projected into the lanes
// the page draws left→right:
//   direction 'down'  entry  → service layer   → mapper statement → table
//   direction 'up'    target → mapper statement → service layer   → HTTP endpoint
//
// THE SCREEN AXIS (RM30) extends both ends of that, on a pack that has a
// frontend: down from a screen the lanes open with its own functions and the
// routes they call (screen → web functions → endpoints → services → statements
// → tables), and up from a column they close with the same two in reverse
// (… → endpoints → web functions → screens). `laneNames` on the result says
// which lanes THIS answer has, because a backend-only pack has neither: an
// empty screens column there would read as "no screen reaches this", when the
// truth is that no frontend was ever analyzed.
//
// EITHER DIRECTION MAY CROSS AN INTERNAL HTTP HOP (§1.1): a @FeignClient method
// calling a route another module in the same pack serves. Every row reached that
// way carries `viaHttp: true` and `httpHops`, because code on the far side of a
// hop is another deployable and must not read as one call stack.
// Pure: graph in, plain view model out — no fetch, no DOM, no response
// contract. The server walks; the page only draws (so the picture can never
// disagree with the engine).
//
// Two honesty rules are baked in here, not left to the caller:
//  - A row's grade is the WEAKEST link on the path that reached it, recomputed
//    from that path. A chain that passed through one candidate (SOUND_SET) call
//    is a candidate, never confirmed — even if its last edge was EXACT.
//  - The walk follows EXECUTION/DATA flow only (FLOW_EDGE_TYPES): a table's
//    DECLARES and JOINS edges are schema relations, not something the request
//    runs through, so following them would inflate `walked` and raise a false
//    "depth cap reached" on the columns of a table nobody's SQL joined here.
//  - What the walk did NOT look at is counted, not hidden: `cut.depth` (nodes
//    still expanding at the depth cap), `cut.nodeCap`, and `cut.byMode` (edges
//    skipped ONLY because their grade is below the mode's floor). An empty
//    column can be the mode, not an absence, and the caller must be able to
//    say which — on this pack, strict from any handler reaches nothing because
//    controller→service is MAY_CALL.

// The edges a REQUEST actually travels live in core/graph.mjs, next to the full
// edge-type list — every impact walk shares them, not just this one (an ignored
// type is not "skipped by mode": nothing was withheld from you).
import { GRADE_SETS, FLOW_EDGE_TYPES } from './graph.mjs';

// Grade rank for weakest-link math (mirrors the policy lattice).
const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });

// The node kinds this view has a place for. Anything else the walk reaches is
// counted in `other` rather than dropped out of the picture unannounced.
const LANE_KINDS = new Set(['symbol', 'statement', 'table', 'column', 'screen']);

// Does this pack have a screen side at all? Walking UP from a column, the two
// frontend lanes are drawn only where there is a frontend: on a backend-only
// pack an empty `screens` column would read as "no screen reaches this", when
// the truth is that no frontend was ever analyzed. Cached per graph object,
// because the walk runs once per handler in the whole-pack censuses and an
// O(nodes) scan per walk is not free on a hundred-thousand-node pack.
const WEB_AXIS = new WeakMap();
function hasWebAxis(graph) {
  const cached = WEB_AXIS.get(graph);
  if (cached !== undefined) return cached;
  let found = false;
  for (const n of graph.nodes.values()) {
    if (n.kind === 'screen' || (n.kind === 'symbol' && n.lane === 'web')) { found = true; break; }
  }
  WEB_AXIS.set(graph, found);
  return found;
}

/**
 * Walk the chain from `start` and project it into the Flow / Impact view model.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{start:string, direction?:'down'|'up', mode?:'strict'|'conservative'|'heuristic',
 *           maxDepth?:number, maxNodes?:number, edgeTypes?:string[],
 *           walkGenerated?:boolean}} opts
 *          edgeTypes defaults to FLOW_EDGE_TYPES (minus HANDLES when walking up:
 *          endpoints are a DERIVED lane there, not a step of the walk)
 *          walkGenerated (default false) — see THE GENERATED RULE below
 * @returns {object} down: {start, direction, mode, depth, walked, other, services,
 *            statements, tables, layers, beyond:{tables}, byLinkGrade, cut,
 *            emptyReason, endLane}
 *          up:   the same, with `statements, services, endpoints` and
 *                `beyond:{endpoints}` in place of the tables lane
 */
export function chainWalk(graph, opts = {}) {
  const start = opts.start;
  const direction = opts.direction ?? 'down';
  if (direction !== 'down' && direction !== 'up') {
    throw new ChainError(`unknown direction: ${JSON.stringify(direction)}`);
  }
  const up = direction === 'up';
  const mode = opts.mode ?? 'conservative';
  const maxDepth = opts.maxDepth ?? 6;
  const maxNodes = opts.maxNodes ?? 4000;
  // Walking UP, an endpoint is a ROUTE, not code: the walk stops at the handler
  // method and the endpoints lane is read from that method's HANDLES in-edges
  // directly — exactly as the tables lane is read from a reached statement's
  // EXECUTES edges when walking down. Stepping onto the route node instead
  // would put a non-code node in `walked`, in a layer, and in `other`.
  const baseTypes = opts.edgeTypes ?? FLOW_EDGE_TYPES;
  const follow = new Set(up ? baseTypes.filter((t) => t !== 'HANDLES') : baseTypes);
  // THE INTERNAL HTTP HOP (§1.1). A request can leave one deployable and arrive
  // at another over HTTP: a @FeignClient method --CALLS_HTTP--> the route, and
  // that route --HANDLES--> the controller that answers it. Walking DOWN, both
  // steps are ordinary flow edges and the walk already crosses them.
  //
  // Walking UP it could not, because HANDLES is excluded above: an endpoint is a
  // ROUTE, not code, and the endpoints lane is DERIVED from a reached handler's
  // own HANDLES edges rather than walked onto. That rule is right for the route
  // a request ENTERED by — and wrong for a route it passed THROUGH, which is a
  // real step of the same request and the one thing standing between a column
  // and the caller in the module upstream.
  //
  // So the HANDLES step is taken upwards on EXACTLY the routes that are a hop:
  // an endpoint with at least one CALLS_HTTP in-edge. Every other route stays
  // derived, and a handler at the depth cap still claims no cut.
  const crossesHttp = follow.has('CALLS_HTTP');
  const isHttpHop = (endpointNodeId) => graph.inEdges(endpointNodeId).some((e) => e.type === 'CALLS_HTTP');
  const allow = GRADE_SETS[mode];
  if (!allow) throw new ChainError(`unknown mode: ${JSON.stringify(mode)}`);
  if (typeof start !== 'string' || !graph.nodes.has(start)) {
    throw new ChainError(`start node not in graph: ${start}`);
  }

  // The one place the direction is spelled out: which adjacency the walk reads,
  // and which end of an edge it steps onto. Everything below is written once
  // and works both ways.
  const adjOf = (id) => (up ? graph.inEdges(id) : graph.outEdges(id));
  const stepTo = (edge) => (up ? edge.from : edge.to);
  // The node a row hangs off in the DRAWING: the end of the edge nearer the
  // start. Walking down that is the caller (`from`); walking up it is the
  // callee (`to`) — the same edge, read from the other side.
  const prevNodeOf = (e) => (up ? e.to : e.from);

  // THE GENERATED RULE. A node the profile's `generatedSources` declaration
  // marked `generated:true` (src/adapters/java_bridge.mjs) is walked normally
  // when a real caller reaches it — a generated method really can be the next
  // step of a real chain, and dropping it would lose a path. What is NOT walked
  // is the step from one generated node to ANOTHER: that is the machine-written
  // interior (mall's 8 307 `GeneratedCriteria`→`addCriterion` edges), which no
  // question is ever about and which a walk can spend its whole node budget
  // inside. Every skip is COUNTED (`cut.generated`) and the caller says so, so
  // an empty band is never mistaken for an absence.
  //
  // `walkGenerated: true` turns the rule off, for a caller that really does want
  // the interior. A project that declares no generatedSources has no node with
  // the flag, so the rule costs one boolean test per step and fires never.
  const walkGenerated = opts.walkGenerated === true;
  const isGenerated = (id) => graph.nodes.get(id)?.generated === true;

  const cut = { depth: 0, nodeCap: false, byMode: 0, generated: 0 };
  const best = new Map(); // id -> {hops, pathGrade, via, parent}
  const modeCounted = new Set(); // nodes whose skipped-by-mode edges are already counted

  // BFS, same best-record rule as Graph.reach (stronger path grade wins; tie →
  // fewer hops). A record is an IMMUTABLE SNAPSHOT that carries the parent
  // record it was reached from, not just the parent's id: an ancestor can later
  // be re-reached by a stronger-but-longer path, and if a child re-read the
  // ancestor's CURRENT record it would report a path that was never walked —
  // longer than its own hops, and graded better than any path within the cap.
  // Following `parent` keeps hops === path.length and grade === weakest(path).
  const root = { hops: 0, pathGrade: 'EXACT', via: null, parent: null, generated: isGenerated(start), http: 0 };
  const queue = [{ id: start, rec: root }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.rec.hops >= maxDepth) continue;
    const adj = adjOf(cur.id);
    const countMode = !modeCounted.has(cur.id);
    if (countMode) modeCounted.add(cur.id);
    // Only a generated node can start a generated→generated step, so the flag
    // of the node we are ON decides whether the next one is even looked up.
    const curGenerated = !walkGenerated && cur.rec.generated === true;
    for (const edge of adj) {
      // Walking up, HANDLES is followed only off a route that is an HTTP HOP
      // (see `isHttpHop` above); every other route stays a derived lane.
      if (up && edge.type === 'HANDLES') {
        if (!crossesHttp || !isHttpHop(edge.from)) continue;
      } else if (!follow.has(edge.type)) continue; // not an execution step — silently out of scope
      if (!allow.has(edge.grade)) {
        // Skipped ONLY because of the grade floor — the caller reports this as
        // "the mode did not look", never as "there is nothing there".
        if (countMode) cut.byMode += 1;
        continue;
      }
      const next = stepTo(edge);
      if (curGenerated && isGenerated(next)) {
        if (countMode) cut.generated += 1;
        continue;
      }
      const pathGrade = weaker(cur.rec.pathGrade, edge.grade);
      const hops = cur.rec.hops + 1;
      const prev = best.get(next);
      if (!prev) {
        // The cap stops the walk GROWING; records already found may still
        // improve, so the result stays deterministic under the same cap.
        if (best.size >= maxNodes) { cut.nodeCap = true; continue; }
      } else if (!(RANK[pathGrade] > RANK[prev.pathGrade] || (RANK[pathGrade] === RANK[prev.pathGrade] && hops < prev.hops))) {
        continue;
      }
      const rec = {
        hops, pathGrade, via: edge.idx, parent: cur.rec,
        generated: walkGenerated ? false : isGenerated(next),
        // How many HTTP hops this path crossed. Carried on the record, not
        // recomputed from the path, so a row can disclose it in one read.
        http: cur.rec.http + (edge.type === 'CALLS_HTTP' ? 1 : 0),
      };
      best.set(next, rec);
      queue.push({ id: next, rec });
    }
  }

  // Nodes sitting at the depth cap that still had somewhere to go: what lies
  // beyond them is unknown, not absent. WHICH boundary hides something depends
  // on the direction, because each direction derives a different lane from a
  // node's own edges rather than by walking:
  //   DOWN counts only boundary symbols — a statement at the cap hides nothing,
  //   because the statements lane reads its EXECUTES/READS/WRITES edges DIRECTLY,
  //   so its tables and columns are complete whether or not the walk had budget
  //   to step onto them (counting those raised a depth warning about nothing:
  //   measured on mall, it fired on 5 endpoints whose lanes are identical at
  //   depth 6 and 8).
  //   UP counts boundary symbols AND boundary statements — nothing is derived
  //   downwards there, so a statement at the cap really does hide its mapper
  //   method and every caller above it. HANDLES in-edges are still ignored (the
  //   endpoints lane IS derived, from the handler's own edges), so a handler at
  //   the cap claims no cut.
  // Boundary tables/columns never count, in either direction.
  //   UP also counts a boundary ENDPOINT — but only ever a route the walk
  //   STEPPED on, which is only ever an HTTP hop: what it hides is the client
  //   method that called it and everything above that, in another module.
  const boundaryKinds = up ? new Set(['symbol', 'statement', 'endpoint']) : new Set(['symbol']);
  for (const [id, rec] of best) {
    if (rec.hops !== maxDepth || !boundaryKinds.has(kindOf(id))) continue;
    const genHere = !walkGenerated && rec.generated === true;
    for (const edge of adjOf(id)) {
      if (!follow.has(edge.type) || !allow.has(edge.grade)) continue;
      const next = stepTo(edge);
      // A step this walk would not have taken anyway is not something the DEPTH
      // cap hid: counting it would raise a depth warning about the generated
      // interior the generated rule already declared.
      if (genHere && isGenerated(next)) continue;
      if (!best.has(next) && next !== start) { cut.depth += 1; break; }
    }
  }

  /**
   * The edges actually walked between start and `id`, in order. Rebuilt from the
   * record's own parent chain (each parent was created before its child, so the
   * chain is acyclic and is exactly the path that produced this record).
   *
   * The sequence always reads FROM THE START OUTWARD, and every element is the
   * REAL edge — so walking up it is a caller→callee edge read backwards
   * (path[i].from === path[i+1].to) rather than forwards.
   */
  const pathTo = (id) => {
    const out = [];
    for (let rec = best.get(id); rec && rec.via != null; rec = rec.parent) {
      const e = graph.edgeAt(rec.via);
      if (!e) break;
      out.push({ from: e.from, to: e.to, type: e.type, grade: e.grade, evidence: e.evidence ?? null });
    }
    out.reverse();
    return out;
  };

  // The link a row is drawn with. `run` is the stretch of the path between the
  // nearest DRAWN row and this one — one edge normally, more when folded nodes
  // (mapper methods) sit in between.
  //
  // Two different questions, answered from two different edges, on purpose:
  //   WHERE the row hangs   → the first edge of the run (its far end is the
  //                           drawn parent, so the line lands on a real row);
  //   WHAT the step WAS     → the WEAKEST edge of the run, because that is what
  //                           the reader is being asked to trust. Walking up, a
  //                           service is reached through mapper --MAY_CALL-->
  //                           service, but the edge touching the drawn statement
  //                           is IMPLEMENTS_STMT/EXACT: reporting that one would
  //                           show a SOUND_SET row with an EXACT justification
  //                           and no receiver/basis to show for it.
  // Ties keep the edge nearest the drawn parent (the one the line is drawn from).
  const linkFromRun = (run) => {
    if (!run.length || !run[0]) return null;
    const parent = prevNodeOf(run[0]);
    let e = run[0];
    for (const cand of run) if (RANK[cand.grade] < RANK[e.grade]) e = cand;
    const ev = e.evidence ?? {};
    return {
      from: parent,
      fromShort: nodeLabel(graph.nodes.get(parent), parent),
      type: e.type,
      grade: e.grade,
      basis: ev.basis ?? null,
      receiver: ev.receiver ?? null,
      iface: ev.iface ?? null,
    };
  };
  const linkOf = (rec) => (rec && rec.via != null ? linkFromRun([graph.edgeAt(rec.via)]) : null);

  // A mapper method is a symbol that IS a statement's implementation; it belongs
  // to the statement column, so it never doubles as a "service".
  const isMapperMethod = (id) => graph.outEdges(id).some((e) => e.type === 'IMPLEMENTS_STMT');
  // A handler is a symbol a ROUTE points at (endpoint --HANDLES--> symbol): the
  // controller method. It is real code, so walking up it IS a service row —
  // flagged, so the page can say where the request entered.
  const isHandlerSymbol = (id) => graph.inEdges(id).some((e) => e.type === 'HANDLES');

  // THE FOLDING RULE, stated once and applied to every row in both directions:
  // some reached nodes are folded into another row instead of being drawn (a
  // mapper method is folded into its statement — always, whichever way the walk
  // ran). A row's draw `link` must therefore point at the nearest node that was
  // actually RENDERED: walk back along the row's own path until the previous
  // node is a drawn row, or the start (the start is always drawn). Without this
  // a lane hangs off a row nobody put on screen. Everything from that edge to
  // the row is ONE folded run, and linkFromRun grades it by its weakest step.
  const isFolded = (id) => isMapperMethod(id);
  const drawLink = (path, rec) => {
    if (!path.length) return linkOf(rec);
    let li = path.length - 1;
    while (li > 0 && prevNodeOf(path[li]) !== start && isFolded(prevNodeOf(path[li]))) li -= 1;
    return linkFromRun(path.slice(li));
  };

  // The table a column belongs to, from the schema itself (table --DECLARES-->
  // column), memoised. null when no catalog declared it.
  const columnOwner = new Map();
  const tableOfColumn = (colId) => {
    if (columnOwner.has(colId)) return columnOwner.get(colId);
    let owner = null;
    for (const e of graph.inEdges(colId)) if (e.type === 'DECLARES') { owner = e.from; break; }
    columnOwner.set(colId, owner);
    return owner;
  };

  // The mapper method that declares a statement. Walking down it is ON the
  // walked path (the edge that entered the statement); walking up it sits ABOVE
  // the statement and is not on the path at all, so it is read from the
  // statement's own IMPLEMENTS_STMT in-edge — the same fact, from the other side.
  const mapperAbove = (stmtId) => {
    const impls = graph.inEdges(stmtId).filter((e) => e.type === 'IMPLEMENTS_STMT').map((e) => e.from).sort(cmp);
    return impls.find((m) => best.has(m)) ?? impls[0] ?? null;
  };

  // A row reached ACROSS an internal HTTP hop says so. The disclosure is the
  // point: the code on the far side of the hop belongs to another deployable,
  // and a reader who is not told will read it as one call stack.
  const httpMark = (rec) => (rec && rec.http > 0 ? { viaHttp: true, httpHops: rec.http } : null);

  // THE SCREEN AXIS LANES (RM30), drawn only where they mean something.
  // Walking DOWN they belong to a walk that STARTED on the frontend (a screen,
  // or one of its functions); walking UP they belong to any pack that has a
  // frontend at all. Everywhere else they are absent rather than empty, because
  // an empty column reads as an absence and this one would be a lie.
  const startNode = graph.nodes.get(start) ?? {};
  const webLanes = up ? hasWebAxis(graph) : (kindOf(start) === 'screen' || startNode.lane === 'web');

  const services = [];
  const webFunctions = [];
  const screens = [];
  const walkedEndpoints = [];   // {id, hops, grade, http} — the DOWN endpoints lane
  const handlers = [];          // {id, hops, grade, http} — the endpoints lane aggregates over these
  const reachedStatements = []; // {id, hops, grade, http} — pre-cut, tables aggregate over ALL of them
  const statements = [];
  for (const [id, rec] of best) {
    const n = graph.nodes.get(id) ?? { id, kind: kindOf(id) };
    if (id === start) continue;
    if (n.kind === 'screen') {
      if (!(up && webLanes)) continue; // counted in `other` below, never dropped
      const path = pathTo(id);
      screens.push({
        id: strip(id),
        short: n.label ?? strip(id),
        title: n.title ?? null,
        name: n.name ?? null,
        group: n.group ?? null,
        component: n.component ?? null,
        hops: rec.hops,
        grade: weakestOf(path),
        // A recording says the browser really was here. It is a MARKER beside
        // the grade, never a grade: nothing about it was walked.
        ...(n.observed === true ? { observed: true } : {}),
        ...(n.source === 'har' ? { source: 'har' } : {}),
        link: drawLink(path, rec),
        walkedPath: path,
      });
      continue;
    }
    if (n.kind === 'symbol') {
      if (isMapperMethod(id)) continue;
      const path = pathTo(id);
      const grade = weakestOf(path);
      const row = {
        id: strip(id),
        short: nodeLabel(n, id),
        owner: n.owner ?? null,
        hops: rec.hops,
        grade,
        external: (n.file ?? null) === null, // a type the lane never saw (library / framework)
        transactional: n.transactional === true,
        file: n.file ?? null,
        line: n.line ?? null,
        link: drawLink(path, rec),
        ...(httpMark(rec) ?? {}),
        path,
      };
      // A FRONTEND FUNCTION IS NOT A SERVICE. What is below it is a ROUTE, not a
      // mapper, and putting the two in one column would read as one call stack
      // across two deployables.
      if (n.lane === 'web' && webLanes) {
        row.component = n.component === true;
        webFunctions.push(row);
        continue;
      }
      if (up) {
        // The controller method IS a code row (that is where the request enters
        // the code); the ROUTE above it is the derived endpoints lane.
        row.handler = isHandlerSymbol(id);
        if (row.handler) handlers.push({ id, hops: rec.hops, grade, http: rec.http });
      }
      services.push(row);
    } else if (n.kind === 'statement') {
      const path = pathTo(id);
      const grade = weakestOf(path);
      const last = path.length ? path[path.length - 1] : null;
      const above = up ? mapperAbove(id) : null;
      const mapper = up
        ? (above ? strip(above) : null)
        : (last && last.type === 'IMPLEMENTS_STMT' ? strip(last.from) : null);
      statements.push({
        id: strip(id),
        short: nodeLabel(n, id),
        symbol: mapper,
        statementType: n.statementType ?? null,
        // A MyBatis-Plus built-in whose condition wrapper is built at run time
        // touches a KNOWN table with an UNKNOWN column list. The flow row says
        // so, because a reader looking at "reaches sys_user" is entitled to know
        // that WHICH columns is not in this pack.
        ...(n.columnsRuntimeOnly === true ? { columnsRuntimeOnly: true } : {}),
        file: n.file ?? null,
        line: n.line ?? null,
        hops: rec.hops,
        grade,
        link: drawLink(path, rec),
        ...(httpMark(rec) ?? {}),
        path,
        tables: graph.outEdges(id)
          .filter((e) => e.type === 'EXECUTES')
          .map((e) => ({ table: strip(e.to), access: graph.edgeAt(e.idx)?.evidence?.access ?? 'read' }))
          .sort((a, b) => cmp(a.table, b.table)),
      });
      reachedStatements.push({ id, hops: rec.hops, grade, http: rec.http });
    } else if (n.kind === 'endpoint' && !up && webLanes) {
      // WALKING DOWN FROM THE FRONTEND, a route is a step of the chain and not
      // a lane derived from something else: the screen calls it, and the code
      // that answers it is what comes next. It is a row here for the same reason
      // the handler above it is one.
      const path = pathTo(id);
      const frontend = frontendCallsOf(graph, id);
      walkedEndpoints.push({
        id: strip(id),
        httpMethod: n.httpMethod ?? null,
        path: n.path ?? null,
        handler: n.handler ?? null,
        hops: rec.hops,
        grade: weakestOf(path),
        file: n.file ?? null,
        line: n.line ?? null,
        ...(n.observed === true ? { observed: true } : {}),
        ...(frontend > 0 ? { frontendCalls: frontend } : {}),
        link: drawLink(path, rec),
        walkedPath: path,
      });
    }
  }
  // Walking up FROM a handler method: that method is hop 0 — the start, never a
  // row — but the routes above it are still the honest answer to "which
  // endpoints reach this?". They sit at hop 1, graded EXACT because nothing on
  // the (empty) path weakened the definitional HANDLES edge.
  if (up && kindOf(start) === 'symbol' && isHandlerSymbol(start)) {
    handlers.push({ id: start, hops: 0, grade: 'EXACT', http: 0 });
  }

  // Tables: what the reached statements actually touch (EXECUTES), with the
  // distinct columns those statements read/write on each — the end of the chain
  // walking DOWN. Walking up, the target IS the table side, so this lane is
  // absent from the answer rather than echoing the thing you asked about.
  const agg = new Map(); // table node id -> accumulator
  if (!up) {
    for (const st of reachedStatements) {
      const outs = graph.outEdges(st.id);
      const touched = [];
      for (const e of outs) {
        if (e.type !== 'EXECUTES') continue;
        let a = agg.get(e.to);
        if (!a) {
          a = { id: e.to, hops: st.hops + 1, grade: st.grade, via: st, statements: 0, access: new Set(), reads: new Set(), writes: new Set(), http: st.http };
          agg.set(e.to, a);
        }
        a.statements += 1;
        a.access.add(graph.edgeAt(e.idx)?.evidence?.access ?? 'read');
        if (st.hops + 1 < a.hops) a.hops = st.hops + 1;
        if (RANK[st.grade] > RANK[a.grade]) a.grade = st.grade;
        // A table this walk reached WITHOUT crossing a hop is not "across the
        // hop", even if another statement reached it across one: the weakest
        // claim wins, and the weakest claim here is the shortest way in.
        if (st.http < a.http) a.http = st.http;
        // The statement to point the link at: strongest grade, then fewest hops,
        // then id — one deterministic representative, not "whichever came first".
        if (RANK[st.grade] > RANK[a.via.grade]
          || (RANK[st.grade] === RANK[a.via.grade] && (st.hops < a.via.hops || (st.hops === a.via.hops && st.id < a.via.id)))) a.via = st;
        touched.push(a);
      }
      if (!touched.length) continue;
      for (const e of outs) {
        if (e.type !== 'READS' && e.type !== 'WRITES') continue;
        // Which table owns this column: its DECLARES edge, not its name. A prefix
        // match ("t." on "t.c") mis-files a column when one table's name is
        // another's schema (`a` vs `a.b`). The name is the fallback only when the
        // catalog lane never declared the column, and it is then all we have.
        const owner = tableOfColumn(e.to);
        const col = strip(e.to);
        for (const a of touched) {
          if (owner ? owner !== a.id : !col.startsWith(strip(a.id) + '.')) continue;
          (e.type === 'READS' ? a.reads : a.writes).add(col);
        }
      }
    }
  }
  const tables = [...agg.values()].map((a) => {
    const n = graph.nodes.get(a.id) ?? {};
    return {
      table: strip(a.id),
      comment: n.comment ?? null,
      hops: a.hops,
      grade: a.grade,
      via: strip(a.via.id),
      viaShort: nodeLabel(graph.nodes.get(a.via.id), a.via.id),
      statements: a.statements,
      ...(a.http > 0 ? { viaHttp: true, httpHops: a.http } : {}),
      access: [...a.access].sort().join('+'),
      reads: a.reads.size,   // DISTINCT columns of this table read by the reached statements
      writes: a.writes.size, // …and written
    };
  });

  // Endpoints: DERIVED from the reached handler methods' HANDLES in-edges, the
  // way tables are derived from a statement's EXECUTES edges walking down. The
  // route is not a walked node (it is not code), so it sits in no layer of its
  // own; a route above a handler that sat AT the depth cap lands in `beyond`.
  const epAgg = new Map(); // endpoint node id -> accumulator
  if (up) {
    for (const h of handlers) {
      for (const e of graph.inEdges(h.id)) {
        if (e.type !== 'HANDLES') continue;
        const n = graph.nodes.get(e.from) ?? {};
        // The HANDLES edge is part of this row's evidence, so its grade is part
        // of the row's grade. It used to be assumed EXACT — true while every
        // route was declared on a concrete controller, false since a route
        // CONTRACT resolves to its implementer (SOUND_SET).
        const rowGrade = weaker(h.grade, e.grade);
        let a = epAgg.get(e.from);
        if (!a) {
          a = { id: e.from, node: n, hops: h.hops + 1, grade: rowGrade, via: h, viaEdge: e.idx, viaGrade: rowGrade, http: h.http ?? 0 };
          epAgg.set(e.from, a);
        }
        if (h.hops + 1 < a.hops) a.hops = h.hops + 1;
        if (RANK[rowGrade] > RANK[a.grade]) a.grade = rowGrade;
        if ((h.http ?? 0) < a.http) a.http = h.http ?? 0;
        // One deterministic representative handler when a route resolves to more
        // than one: strongest grade, then fewest hops, then id. The HANDLES edge
        // travels with it — the row's path must be the path of the handler it names.
        if (RANK[rowGrade] > RANK[a.viaGrade]
          || (RANK[rowGrade] === RANK[a.viaGrade] && (h.hops < a.via.hops || (h.hops === a.via.hops && h.id < a.via.id)))) { a.via = h; a.viaEdge = e.idx; a.viaGrade = rowGrade; }
      }
    }
  }
  const derivedEndpoints = [...epAgg.values()].map((a) => {
    // The row's own evidence: its handler's walked path, plus the HANDLES edge
    // that derived this route from it — so a grade on this row can be read back
    // to the steps that produced it, like every other row.
    // It is `walkedPath`, not `path`: on an endpoint row `path` is the ROUTE
    // ("/product/update/{id}"), and one field cannot be both.
    const he = graph.edgeAt(a.viaEdge);
    const walkedPath = pathTo(a.via.id);
    if (he) walkedPath.push({ from: he.from, to: he.to, type: he.type, grade: he.grade, evidence: he.evidence ?? null });
    // How many frontend functions call this route. Written only when there ARE
    // some: a field on every endpoint row of a pack with no web lane would say
    // "no frontend calls this" where the truth is that no frontend was read.
    const frontend = frontendCallsOf(graph, a.id);
    return {
      id: strip(a.id),
      httpMethod: a.node.httpMethod ?? null,
      path: a.node.path ?? null,
      handler: strip(a.via.id),
      handlerShort: nodeLabel(graph.nodes.get(a.via.id), a.via.id),
      hops: a.hops,
      grade: a.grade,
      file: a.node.file ?? null,
      line: a.node.line ?? null,
      ...(a.http > 0 ? { viaHttp: true, httpHops: a.http } : {}),
      ...(frontend > 0 ? { frontendCalls: frontend } : {}),
      walkedPath,
    };
  });

  // Walking up, the endpoints lane is DERIVED from the handlers the walk
  // reached; walking down from the frontend, it is WALKED. One lane, two ways
  // of arriving at it, because a route above a handler is not a step of the
  // request and a route a screen calls is.
  const endpoints = up ? derivedEndpoints : walkedEndpoints;

  services.sort(byHopGradeKey('id'));
  webFunctions.sort(byHopGradeKey('id'));
  screens.sort(byHopGradeKey('id'));
  statements.sort(byHopGradeKey('id'));
  tables.sort(byHopGradeKey('table'));
  endpoints.sort(byHopGradeKey('id'));

  // Link-grade census over every reached non-column node: how much of this
  // picture is confirmed vs candidate, in one number per grade. The start is
  // never its own link (a cycle back to it must not add a grade to the count).
  const byLinkGrade = { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 };
  for (const [id, rec] of best) {
    if (id === start || kindOf(id) === 'column' || rec.via == null) continue;
    const e = graph.edgeAt(rec.via);
    if (e && byLinkGrade[e.grade] != null) byLinkGrade[e.grade] += 1;
  }

  // LAYERS — the same walk folded per hop: how deep this chain goes and how wide
  // each hop is. A CENSUS, not a list: the caller's `limit` cuts the lanes, it
  // never cuts this. `nodes` counts exactly what byLinkGrade counts (every
  // reached non-column node, folded mapper methods included), so the layers'
  // grade counts sum to walk.byLinkGrade. hop 0 is the start and is no layer.
  // The end lane is per direction: walking down it is `tables`, walking up it is
  // `endpoints` — and those, being derived rather than walked, are counted in
  // their hop WITHOUT being counted in `nodes`.
  const endLane = up ? 'endpoints' : 'tables';
  const layerBy = new Map(); // hops -> layer
  const layerAt = (h) => {
    let l = layerBy.get(h);
    if (!l) {
      l = up
        ? { hops: h, nodes: 0, statements: 0, services: 0, endpoints: 0, byLinkGrade: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 } }
        : { hops: h, nodes: 0, services: 0, statements: 0, tables: 0, byLinkGrade: { EXACT: 0, SOUND_SET: 0, HEURISTIC: 0 } };
      // The frontend lanes join the census only where they are drawn, so a
      // backend-only pack's layers keep exactly the shape they always had.
      if (webLanes) {
        l.webFunctions = 0;
        if (up) l.screens = 0; else l.endpoints = 0;
      }
      layerBy.set(h, l);
    }
    return l;
  };
  for (const [id, rec] of best) {
    if (id === start || kindOf(id) === 'column') continue;
    const l = layerAt(rec.hops);
    l.nodes += 1;
    const e = rec.via != null ? graph.edgeAt(rec.via) : null;
    if (e && l.byLinkGrade[e.grade] != null) l.byLinkGrade[e.grade] += 1;
  }
  for (const s of services) layerAt(s.hops).services += 1;
  for (const s of statements) layerAt(s.hops).statements += 1;
  if (webLanes) {
    for (const w of webFunctions) layerAt(w.hops).webFunctions += 1;
    if (up) for (const s of screens) layerAt(s.hops).screens += 1;
    else for (const e of walkedEndpoints) layerAt(e.hops).endpoints += 1;
  }
  // A row the walk never STEPPED on (its statement / its handler sat at the
  // depth cap) is known — that node's own EXECUTES / HANDLES edge names it —
  // but it was not walked, so it belongs to no layer. It is counted apart,
  // never silently dropped.
  const beyond = up ? { endpoints: 0 } : { tables: 0 };
  if (up) {
    for (const ep of endpoints) {
      if (ep.hops <= maxDepth) layerAt(ep.hops).endpoints += 1;
      else beyond.endpoints += 1;
    }
  } else {
    for (const a of agg.values()) {
      if (best.has(a.id)) layerAt(a.hops).tables += 1;
      else beyond.tables += 1;
    }
  }
  const maxHop = layerBy.size ? Math.max(...layerBy.keys()) : 0;
  const layers = [];
  for (let h = 1; h <= maxHop; h++) layers.push(layerAt(h));

  // Reached, counted in `walked`, and shown in NO lane: an injected type, an
  // outbound HTTP endpoint, a rendered screen. Small on this pack, but a census
  // that silently loses nodes is the kind of quiet lie this engine must not tell.
  let other = 0;
  const showScreens = up && webLanes;
  for (const [id, rec] of best) {
    void rec;
    if (id === start) continue;
    // A SCREEN IS A LANE ROW ONLY WHERE THE SCREENS LANE IS DRAWN. Reached any
    // other way — a RENDERS edge out of backend code, a walk down from a
    // handler — it is in no lane, and it belongs in this count rather than
    // vanishing between the two.
    if (kindOf(id) === 'screen') { if (!showScreens) other += 1; continue; }
    if (LANE_KINDS.has(kindOf(id))) continue;
    // A route the walk STEPPED on to cross an HTTP hop is not "shown in no
    // lane": it is in the endpoints lane, as itself. Counting it here as well
    // would report the same node twice under two contradictory descriptions.
    if (up && epAgg.has(id)) continue;
    // ...and the same for a route the walk stepped on coming DOWN from a
    // screen: it is the endpoints lane there, not a node with no home.
    if (!up && webLanes && kindOf(id) === 'endpoint') continue;
    other += 1;
  }

  // A lane that is empty because the TARGET sits on the wrong side of it is not
  // an absence. Walking up from a statement or a method, nothing upstream can be
  // a statement (nothing CALLS a statement; a statement is where the SQL axis
  // begins), so the caller must say "not in this axis", never "none".
  const emptyReason = {};
  if (up && (kindOf(start) === 'statement' || kindOf(start) === 'symbol')) {
    emptyReason.statements = 'not-in-this-axis';
  }

  // The lanes this answer HAS, in the order the page draws them left to right.
  // The caller iterates this rather than a fixed table, because which lanes a
  // walk has depends on which side of the round trip it started from.
  const laneNames = up
    ? ['statements', 'services', 'endpoints', ...(webLanes ? ['webFunctions', 'screens'] : [])]
    : [...(webLanes ? ['webFunctions', 'endpoints'] : []), 'services', 'statements', 'tables'];
  // Every lane is on the RESULT, whether or not it is one of THIS answer's:
  // `laneNames` is the authority on what to draw, and a caller that wants a
  // count of something the answer does not draw should not have to test for
  // undefined to get it.
  const lanes = up
    ? { statements, services, endpoints, webFunctions, screens }
    : { webFunctions, endpoints, services, statements, tables, screens };
  return {
    start,
    direction,
    mode,
    laneNames,
    depth: maxDepth,
    walked: best.size - (best.has(start) ? 1 : 0),
    other,
    ...lanes,
    layers,
    beyond,
    byLinkGrade,
    cut,
    emptyReason,
    endLane,
  };
}

/**
 * Display name of a node — the one rule the tools, the walk and the page share:
 * symbol → `Class#method`, statement/column → the last two dotted segments,
 * endpoint → `METHOD path`. Works from the id alone when the node is absent.
 * @param {object|null|undefined} node
 * @param {string} id
 */
export function nodeLabel(node, id) {
  const s = String(id);
  const colon = s.indexOf(':');
  const kind = (node && node.kind) || (colon >= 0 ? s.slice(0, colon) : '');
  const key = s.slice(colon + 1);
  if (kind === 'endpoint') return node && node.httpMethod ? `${node.httpMethod} ${node.path}` : key;
  // A screen's short name is whatever `screenAxis.pathRule` made of its path,
  // and the path itself when the profile declared no rule.
  if (kind === 'screen') return node && typeof node.label === 'string' && node.label !== '' ? node.label : key;
  if (kind === 'symbol') {
    const h = key.lastIndexOf('#');
    // A WEB symbol is keyed by a file PATH, not by a package: shortening it at
    // the last dot before the `#` would leave "js#getOrder", which reads as
    // nothing. The file's own name is the short form there.
    if (key.includes('/')) return h >= 0 ? `${key.slice(key.lastIndexOf('/', h) + 1)}` : key;
    const dot = key.lastIndexOf('.', h);
    return h >= 0 ? key.slice(dot + 1) : key;
  }
  if (kind === 'column' || kind === 'statement') { const p = key.split('.'); return p.slice(-2).join('.'); }
  return key;
}

/**
 * HOW MANY FRONTEND FUNCTIONS CALL THIS ROUTE (RM28).
 *
 * An endpoint's CALLS_HTTP in-edges from a symbol the web lane produced. An
 * UNRESOLVED edge is NOT counted: it is below every mode's floor, so no walk
 * follows it, and a row that counted it would tell a reader a screen depends on
 * a route this analysis could not attach it to.
 *
 * Counted per CALLER, not per edge: a call whose URL is a ternary lands on two
 * routes from one function, and on each of those routes it is one caller.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {string} endpointId
 * @returns {number}
 */
export function frontendCallsOf(graph, endpointId) {
  const callers = new Set();
  for (const e of graph.inEdges(endpointId)) {
    if (e.type !== 'CALLS_HTTP' || e.grade === 'UNRESOLVED') continue;
    const n = graph.nodes.get(e.from);
    if (n && n.lane === 'web') callers.add(e.from);
  }
  return callers.size;
}

/** The weakest grade along a walked path (empty path = nothing weakened it). */
export function weakestOf(path) {
  let g = 'EXACT';
  for (const e of path) if (RANK[e.grade] < RANK[g]) g = e.grade;
  return g;
}

function byHopGradeKey(key) {
  return (a, b) => (a.hops - b.hops) || (RANK[b.grade] - RANK[a.grade]) || cmp(a[key], b[key]);
}
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function weaker(a, b) { return RANK[a] <= RANK[b] ? a : b; }
function strip(id) { return id.slice(id.indexOf(':') + 1); }
function kindOf(id) { const i = String(id).indexOf(':'); return i < 0 ? '' : String(id).slice(0, i); }

export class ChainError extends Error {
  constructor(message) { super(message); this.name = 'ChainError'; }
}
