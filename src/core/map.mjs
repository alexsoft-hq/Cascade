// map.mjs — the WHOLE-PACK relation map: "show me the system".
//
// One picture of everything the pack knows how to relate: the API groups, the
// endpoints under them, the tables those endpoints end at, and the joins the
// mapper SQL witnesses between those tables. It is the map you open BEFORE you
// have a question — the neighbourhood view (`neighborhood`) is what you drill
// into once you have one.
//
// It runs the SAME per-endpoint forward walk as `coupling` (core/walks.mjs),
// projected differently: coupling asks "which GROUPS reach this statement",
// this asks "which TABLES does this endpoint end at". One walk, two views, so
// the map and the matrix can never disagree about what an endpoint reaches.
//
// Honesty rules baked in here, not left to the caller:
//  - A group is an API PATH PREFIX. That is a naming convention, not a declared
//    module boundary, and the caller says so in `limits`.
//  - A `touches` link's grade is the STRONGEST of the paths that produce it,
//    each path graded by its own WEAKEST link: endpoint →…→ statement (the
//    walk's path grade) then statement --EXECUTES--> table. That is the
//    engine's rule everywhere — weakest-link within a path, strongest across
//    the alternatives (Graph.reach, chainWalk's tables lane) — so the same
//    endpoint→table relation can never read SOUND_SET here and EXACT in Flow.
//    A table an endpoint can ONLY reach through a candidate call is still a
//    candidate touch: nothing promotes a lone SOUND_SET path.
//  - `tables` is every table in the pack; `tablesTouched` is how many of them
//    any endpoint reaches. The map draws the touched ones — the difference is
//    reported, never silently dropped.
//  - layers:["screens"] adds the OTHER end of the round trip: one node per
//    screen that reaches a route this pack serves, and one line per (screen,
//    route) the same `walkScreens` census the overview counts found. A screen
//    that reaches no drawn route is not on the picture, and `summary.screens`
//    against `summary.screensTotal` says how many those are.
//  - The node cap cuts BY KIND (statements, then endpoints, then screens, then
//    tables; groups never), keeping the best-connected nodes of the kind being
//    cut, and the caller is told exactly how many of each kind survived.
//
// Pure: graph in, plain view model out — no contract, no paging, no DOM.

import { walkEndpoints, walkScreens, groupOfPath, primaryHandlerOf } from './walks.mjs';
import { nodeLabel } from './chain.mjs';
import { GRADE_SETS } from './graph.mjs';

/** The `layers` values this view recognises. */
export const LAYERS = Object.freeze(['statements', 'screens']);
/** Default node cap. */
export const DEFAULT_LIMIT = 6000;
/**
 * How many measure-and-cut passes the byte budget may take. Three is enough in
 * practice (the first pass knows the real bytes per element); the bound is here
 * so a pathological node-size distribution cannot loop.
 */
const MAX_BYTE_ROUNDS = 4;

// Grade rank for weakest-link math (mirrors the policy lattice in chain.mjs).
const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
// Deterministic ordering. The node order is also the CUT order's frame of
// reference, so it is written once, here.
// `project` is the skeleton a picture that reaches into ANOTHER pack hangs
// that pack's nodes off (RM45). It is drawn like a group and, like a group, it
// is never cut: a map with the skeleton gone has nothing left to read.
const KIND_RANK = Object.freeze({ group: 0, project: 1, screen: 2, endpoint: 3, table: 4, statement: 5 });
const LINK_RANK = Object.freeze({ member: 0, calls: 1, touches: 2, executes: 3, joins: 4 });
// Which kind gives way first when the node cap bites. Groups are absent on
// purpose: a map with no groups has no skeleton left to read.
//
// SCREENS GIVE WAY LAST, with the tables. Measured on jeecg: the byte budget
// bites at 969 endpoints, and with screens ahead of endpoints in this queue all
// 19 of the screens that reach a route went before the first endpoint did — so
// a reader who had turned the layer ON got a map with no screen on it, having
// spent a whole extra walk to build one. They are few (a screen that reaches no
// route is not on the map at all) and they are a TOP of the chain, like a
// table, rather than detail under the skeleton, like a statement.
const CUT_ORDER = Object.freeze(['statement', 'endpoint', 'screen', 'table']);
// The separator inside a composite Map key. Written as an ESCAPE, never as a
// literal NUL byte in the source: a raw control character in a .mjs file is
// invisible in every diff and every review.
const KEY_SEP = '\u0000';

/**
 * Build the whole-pack relation map.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:'strict'|'conservative'|'heuristic', depth?:number,
 *          layers?:string[], limit?:number, maxBytes?:number|null,
 *          packageDepth?:number|null, only?:string[],
 *          extra?:{nodes:object[], links:object[]}}} [opts]
 *        maxBytes (null = unbounded) caps the MEASURED size of the nodes+links
 *        payload; see the byte budget in step 5b.
 *        `only` draws the picture of THOSE endpoints alone (step 0 below).
 *        `extra` is nodes and links from outside this graph, put on the same
 *        picture so that one node cap and one byte budget bound the whole of
 *        it (step 3b below).
 * @returns {{mode:string, depth:number, layers:{statements:boolean, screens:boolean},
 *            nodes:object[], links:object[], summary:object, limit:number}}
 */
export function buildMap(graph, opts = {}) {
  const mode = opts.mode ?? 'conservative';
  if (!GRADE_SETS[mode]) throw new MapError(`unknown mode: ${JSON.stringify(mode)}`);
  const depth = opts.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1) throw new MapError(`depth must be a positive integer, got ${depth}`);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new MapError(`limit must be a positive integer, got ${limit}`);
  const asked = opts.layers ?? [];
  if (!Array.isArray(asked)) throw new MapError('layers must be an array of strings');
  for (const l of asked) if (!LAYERS.includes(l)) throw new MapError(`unknown layer: ${JSON.stringify(l)} (known: ${LAYERS.join(', ')})`);
  const withStatements = asked.includes('statements');
  const withScreens = asked.includes('screens');

  // ---- 0. whose picture this is ------------------------------------------
  // `only` draws the endpoints it names and nothing else. The caller that needs
  // it already knows which route it is asking about — a map that crosses into
  // another project asks that project for the route it called — and there is no
  // honest way to fake it afterwards: filtering a whole-pack map down to one
  // route would leave that route's `touches` grades computed against endpoints
  // that are no longer on the picture.
  if (opts.only != null && !Array.isArray(opts.only)) throw new MapError('only must be an array of endpoint node ids');

  // NODES FROM OUTSIDE THIS GRAPH. A caller with a second picture to put on
  // this one hands it in here rather than merging afterwards, because ONE node
  // cap and ONE byte budget have to bound the whole drawing: two pictures each
  // cut to the budget make an answer twice the size the caller asked for. They
  // are drawn, they are the FIRST to give way inside their own kind, and they
  // are counted in `summary.extra` rather than in the totals, which are
  // censuses of THIS pack and must stay that.
  const extraNodes = Array.isArray(opts.extra && opts.extra.nodes) ? opts.extra.nodes : [];
  const extraLinks = Array.isArray(opts.extra && opts.extra.links) ? opts.extra.links : [];
  const fromOutside = new Set(extraNodes.map((n) => n.id));
  const outsideLinks = new Set(extraLinks);

  const { endpoints, walk } = walkEndpoints(graph, {
    mode, depth, packageDepth: opts.packageDepth ?? null,
    ...(opts.only != null ? { only: opts.only } : {}),
  });

  // ---- 1. groups (API path prefixes) and their endpoints -------------------
  const groupOf = new Map(); // group name -> endpoint node ids
  for (const ep of endpoints) {
    let list = groupOf.get(ep.group);
    if (!list) { list = []; groupOf.set(ep.group, list); }
    list.push(ep.id);
  }

  // ---- 2. what each endpoint ends at --------------------------------------
  // `touches` is the SHORTCUT link endpoint→table, with the statements folded
  // into it; the `statements` layer replaces it with the two real steps
  // (endpoint --executes--> statement --executes--> table) so the SQL that
  // carried the touch is on screen rather than summarised.
  const touches = new Map();   // (endpoint, table) -> {source,target,access:Set,grade,statements}
  const epToStmt = new Map();  // (endpoint, statement) -> {source,target,grade}
  const stmtToTable = new Map(); // (statement, table) -> {source,target,access:Set,grade}
  const stmtGrade = new Map(); // statement node id -> weakest grade over the endpoints that reach it
  const touchedTables = new Set();
  for (const ep of endpoints) {
    for (const s of ep.statements) {
      const prev = stmtGrade.get(s.id);
      if (prev === undefined || RANK[s.grade] > RANK[prev]) stmtGrade.set(s.id, s.grade);
      if (withStatements) {
        const k = ep.id + KEY_SEP + s.id;
        const cur = epToStmt.get(k);
        if (!cur) epToStmt.set(k, { source: ep.id, target: s.id, kind: 'executes', grade: s.grade });
        else if (RANK[s.grade] > RANK[cur.grade]) cur.grade = s.grade;
      }
      for (const e of graph.outEdges(s.id)) {
        if (e.type !== 'EXECUTES') continue;
        const access = graph.edgeAt(e.idx)?.evidence?.access ?? 'read';
        touchedTables.add(e.to);
        if (withStatements) {
          const k = s.id + KEY_SEP + e.to;
          let link = stmtToTable.get(k);
          if (!link) { link = { source: s.id, target: e.to, kind: 'executes', access: new Set(), grade: e.grade }; stmtToTable.set(k, link); }
          link.access.add(access);
          if (RANK[e.grade] > RANK[link.grade]) link.grade = e.grade;
          continue;
        }
        const k = ep.id + KEY_SEP + e.to;
        let link = touches.get(k);
        // WITHIN this path, the weakest link: the walk's path grade to the
        // statement, then the statement's own SQL edge.
        const pathGrade = RANK[s.grade] <= RANK[e.grade] ? s.grade : e.grade;
        if (!link) { link = { source: ep.id, target: e.to, kind: 'touches', access: new Set(), grade: pathGrade, statements: 0 }; touches.set(k, link); }
        link.access.add(access);
        link.statements += 1;
        // ACROSS the paths, the strongest: one confirmed route to this table is
        // a confirmed touch, however many candidate routes also reach it.
        if (RANK[pathGrade] > RANK[link.grade]) link.grade = pathGrade;
      }
    }
  }

  // ---- 2b. the screens layer, when it was asked for ------------------------
  // The other end of the round trip (SPEC §1.1), on the same picture: one node
  // per SCREEN that reaches a route this pack serves, and one line per (screen,
  // route) the forward walk found. It is the same `walkScreens` census the
  // overview counts and `browse kind=screen` lists, so the map cannot disagree
  // with either about what a screen reaches.
  //
  // A screen that reaches NO drawn route is not on the map: it would be a dot
  // with no line, which says "this screen calls nothing" where the truth is
  // that nothing we could follow leaves it. The count of those is in `summary`.
  const servedEndpoints = new Set(endpoints.map((ep) => ep.id));
  const screenRows = [];       // {node, links:[…]}
  let screensReaching = 0;
  let screensTotal = 0;
  if (withScreens) {
    const sw = walkScreens(graph, { mode, depth });
    screensTotal = sw.screens.length;
    for (const s of sw.screens) {
      const out = s.endpoints.filter((e) => servedEndpoints.has(e.id));
      if (out.length === 0) continue;
      screensReaching += 1;
      const n = graph.nodes.get(s.id) ?? {};
      screenRows.push({
        node: {
          id: s.id, kind: 'screen', label: nodeLabel(n, s.id), degree: 0,
          path: s.path, title: s.title, group: s.group, component: s.component,
          endpoints: out.length, tables: s.tables.length,
          // A recording says the browser really was here. It is a MARKER, never
          // a grade: no line on this map was drawn from one.
          observed: s.observed === true,
          source: s.source ?? null,
        },
        links: out.map((e) => ({ source: s.id, target: e.id, kind: 'calls', grade: e.grade })),
      });
    }
  }

  // ---- 3. the node set ----------------------------------------------------
  const tableFacts = tableCensus(graph);
  const nodes = [];
  for (const [name, eps] of groupOf) {
    nodes.push({ id: `group:${name}`, kind: 'group', label: name, degree: 0, endpoints: eps.length });
  }
  for (const s of screenRows) nodes.push(s.node);
  for (const ep of endpoints) {
    const n = graph.nodes.get(ep.id) ?? {};
    nodes.push({
      id: ep.id, kind: 'endpoint', label: nodeLabel(n, ep.id), group: ep.group, degree: 0,
      httpMethod: ep.httpMethod, path: ep.path, handlerShort: handlerShortOf(graph, ep.id, n),
      // How many controller methods declare this route. 1 almost always; 2+ when
      // two modules use the same route string, and then `handlerShort` names the
      // primary one and the map still walked ALL of them.
      handlers: ep.handlers,
    });
  }
  for (const tid of touchedTables) {
    const f = tableFacts.get(tid) ?? { comment: null, columnCount: 0 };
    nodes.push({ id: tid, kind: 'table', label: strip(tid), degree: 0, comment: f.comment, columnCount: f.columnCount });
  }
  if (withStatements) {
    for (const sid of stmtGrade.keys()) {
      const n = graph.nodes.get(sid) ?? {};
      nodes.push({ id: sid, kind: 'statement', label: nodeLabel(n, sid), degree: 0, statementType: n.statementType ?? null });
    }
  }

  // ---- 3b. what the caller brought with it --------------------------------
  for (const n of extraNodes) nodes.push(n);

  // ---- 4. the link set ----------------------------------------------------
  const links = [];
  for (const [name, eps] of groupOf) for (const epId of eps) {
    // Definitional: the group IS the endpoint's first path segment — or, when
    // the profile declares moduleAttribution.packageDepth, its handler's own
    // truncated package. Either way nothing was inferred, so the membership is
    // EXACT even where the chain below it is not.
    links.push({ source: `group:${name}`, target: epId, kind: 'member', grade: 'EXACT' });
  }
  for (const s of screenRows) for (const l of s.links) links.push(l);
  for (const l of touches.values()) links.push({ ...l, access: joinAccess(l.access) });
  for (const l of epToStmt.values()) links.push(l);
  for (const l of stmtToTable.values()) links.push({ ...l, access: joinAccess(l.access) });
  // Joins between DRAWN tables, undirected and once. A JOINS edge recorded in
  // both directions is one relationship, not two: keyed by the sorted pair, with
  // the strongest witness count and the strongest grade of the pair.
  const joins = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'JOINS') continue;
    if (!touchedTables.has(e.from) || !touchedTables.has(e.to)) continue;
    const [a, b] = e.from <= e.to ? [e.from, e.to] : [e.to, e.from];
    const k = a + KEY_SEP + b;
    const witness = e.evidence?.count ?? 1;
    let link = joins.get(k);
    if (!link) { link = { source: a, target: b, kind: 'joins', grade: e.grade, witness }; joins.set(k, link); }
    else {
      if (RANK[e.grade] > RANK[link.grade]) link.grade = e.grade;
      if (witness > link.witness) link.witness = witness;
    }
  }
  for (const l of joins.values()) links.push(l);
  for (const l of extraLinks) links.push(l);

  // ---- 5. the node cap ----------------------------------------------------
  // Degree over the FULL link set decides who survives: cutting the map must
  // keep the hubs, not whichever ids sort first.
  const fullDegree = degreeOf(nodes, links);
  const totals = { group: 0, screen: 0, endpoint: 0, table: 0, statement: 0 };
  for (const n of nodes) if (!fromOutside.has(n.id) && totals[n.kind] !== undefined) totals[n.kind] += 1;
  // The cut ORDER, written once: the least-connected node of the first kind that
  // still has members, then the next kind. Used by both budgets below.
  const cutQueue = [];
  for (const kind of CUT_ORDER) {
    // Inside one kind, what the caller BROUGHT gives way before what this pack
    // drew. This pack's picture is the answer; the second picture laid over it
    // is the first thing a budget takes back.
    for (const outside of [true, false]) {
      const of = nodes.filter((n) => n.kind === kind && fromOutside.has(n.id) === outside)
        .sort((a, b) => (fullDegree.get(a.id) - fullDegree.get(b.id)) || cmp(b.id, a.id));
      cutQueue.push(...of.map((n) => n.id));
    }
  }
  const dropFirst = (howMany) => {
    const out = new Set();
    for (let i = 0; i < howMany && i < cutQueue.length; i++) out.add(cutQueue[i]);
    return out;
  };
  const apply = (dropSet) => {
    const keptNodes = dropSet.size ? nodes.filter((n) => !dropSet.has(n.id)) : nodes;
    const ids = new Set(keptNodes.map((n) => n.id));
    const keptLinks = dropSet.size ? links.filter((l) => ids.has(l.source) && ids.has(l.target)) : links;
    if (!fromOutside.size) return { keptNodes, keptLinks };
    // A NODE FROM OUTSIDE THAT LOST EVERY LINE IS NOT DRAWN. The picture it
    // came on was a route and the things that route reaches; cut the route and
    // what is left is a disc floating beside this pack's map with nothing
    // saying why it is there. This pack's own nodes keep the old behaviour: a
    // group whose endpoints all went is still the group this pack has.
    // An orphan has no line by definition, so removing it removes no line and
    // one pass is enough.
    const linked = new Set();
    for (const l of keptLinks) { linked.add(l.source); linked.add(l.target); }
    const orphaned = keptNodes.some((n) => fromOutside.has(n.id) && !linked.has(n.id));
    if (!orphaned) return { keptNodes, keptLinks };
    return { keptNodes: keptNodes.filter((n) => !fromOutside.has(n.id) || linked.has(n.id)), keptLinks };
  };

  // HOW MANY THE CAP REALLY COSTS. Without outside nodes it is arithmetic: one
  // node dropped is one node fewer. With them it is not, because dropping a
  // portal takes the cluster hanging off it too, so the smallest prefix that
  // fits is SEARCHED rather than computed. The predicate is monotone (a longer
  // prefix never leaves more nodes), so a binary search finds it in a dozen
  // passes, and the answer is still the least this budget can take.
  let dropCount = Math.max(0, nodes.length - limit);
  if (fromOutside.size && dropCount > 0) {
    let lo = 0, hi = cutQueue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (apply(dropFirst(mid)).keptNodes.length <= limit) hi = mid; else lo = mid + 1;
    }
    dropCount = lo;
  }
  let drop = dropFirst(dropCount);
  let cutBy = drop.size ? 'node-cap' : null;
  let applied = apply(drop);

  // ---- 5b. the BYTE budget (SPEC §13) ------------------------------------
  // The node cap is in the wrong unit for the promise §13 makes. Measured on a
  // 400-table / 3 800-endpoint pack: 4 227 nodes — comfortably UNDER the default
  // cap of 6 000 — carry 12 200 links and serialise to 2.5 MB, and the answer
  // called itself complete. A picture that large is neither drawable nor
  // returnable, and "no cut" was a true statement about nodes and a false one
  // about the answer.
  //
  // So the map is also cut to fit `maxBytes` OF ITS OWN MEASURED SERIALISATION —
  // not an estimate, the real JSON.stringify of the nodes and links. The first
  // pass computes the true bytes-per-element and cuts to the target directly;
  // at most MAX_BYTE_ROUNDS passes run, and the last one is allowed to be a
  // little under rather than a little over. The cut uses the SAME order as the
  // node cap (least-connected of statements, then endpoints, then tables;
  // groups never), so a byte-cut map and a node-cut map are the same picture at
  // different sizes. `summary.shown` and the caller's `truncated` say exactly
  // what went.
  const maxBytes = opts.maxBytes ?? null;
  if (maxBytes != null && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new MapError(`maxBytes must be a positive integer or null, got ${maxBytes}`);
  }
  let bytes;
  if (maxBytes != null) {
    // How many ELEMENTS (nodes + links) survive each prefix of the cut queue.
    // Dropping one node also drops every link touching it, so the two cannot be
    // traded one for one — computed exactly, once, in O(links): walking the
    // queue and counting each link the first time either of its ends goes.
    const incident = new Map();
    links.forEach((l, i) => {
      for (const end of [l.source, l.target]) {
        const arr = incident.get(end);
        if (arr) arr.push(i); else incident.set(end, [i]);
      }
    });
    const gone = new Uint8Array(links.length);
    // elementsAfter[i] = elements left after dropping the first i queue entries.
    const elementsAfter = new Array(cutQueue.length + 1);
    elementsAfter[0] = nodes.length + links.length;
    let linksLeft = links.length;
    for (let i = 0; i < cutQueue.length; i += 1) {
      for (const li of incident.get(cutQueue[i]) ?? []) {
        if (!gone[li]) { gone[li] = 1; linksLeft -= 1; }
      }
      elementsAfter[i + 1] = (nodes.length - (i + 1)) + linksLeft;
    }
    const dropForTarget = (target) => {
      // The SMALLEST prefix that fits — cut as little as the budget allows.
      for (let i = 0; i <= cutQueue.length; i += 1) if (elementsAfter[i] <= target) return i;
      return cutQueue.length;
    };
    for (let round = 0; round < MAX_BYTE_ROUNDS; round += 1) {
      bytes = sizeOf(applied.keptNodes, applied.keptLinks);
      const elements = applied.keptNodes.length + applied.keptLinks.length;
      if (bytes <= maxBytes || elements === 0) break;
      // The MEASURED bytes per element of what is on the table right now; aim a
      // little under the budget so the next measurement is not a coin flip.
      const target = Math.max(1, Math.floor(elements * (maxBytes / bytes) * 0.95));
      const dropCount = Math.max(drop.size + 1, dropForTarget(target));
      drop = dropFirst(dropCount);
      cutBy = 'byte-budget';
      applied = apply(drop);
    }
  }
  const kept = applied.keptNodes;
  const keptLinks = applied.keptLinks;

  // ---- 6. degrees, order, summary ----------------------------------------
  const degree = degreeOf(kept, keptLinks);
  for (const n of kept) n.degree = degree.get(n.id);
  kept.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || cmp(a.id, b.id));
  keptLinks.sort((a, b) => (LINK_RANK[a.kind] - LINK_RANK[b.kind]) || cmp(a.source, b.source) || cmp(a.target, b.target));

  const shown = { group: 0, screen: 0, endpoint: 0, table: 0, statement: 0 };
  for (const n of kept) if (!fromOutside.has(n.id) && shown[n.kind] !== undefined) shown[n.kind] += 1;
  const summary = {
    groups: totals.group,
    endpoints: totals.endpoint,
    tables: tableFacts.size,
    tablesTouched: touchedTables.size,
    links: keptLinks.length,
    linksTotal: links.length,
    nodesTotal: nodes.length,
    shown: { groups: shown.group, endpoints: shown.endpoint, tables: shown.table, statements: shown.statement, screens: shown.screen },
    // What (if anything) cut this map, and how big the answer's own node+link
    // payload actually is — measured, never estimated. `bytes` is null when no
    // byte budget was asked for.
    cutBy,
    bytes: maxBytes == null ? null : sizeOf(kept, keptLinks),
    maxBytes,
    walk,
  };
  // How much of what the caller brought survived. Counted apart from `shown`,
  // because `shown` answers "how much of THIS pack is on the picture" and an
  // extra node is not part of this pack.
  if (extraNodes.length || extraLinks.length) {
    summary.extra = {
      nodes: kept.reduce((n, x) => n + (fromOutside.has(x.id) ? 1 : 0), 0),
      nodesGiven: extraNodes.length,
      links: keptLinks.reduce((n, l) => n + (outsideLinks.has(l) ? 1 : 0), 0),
      linksGiven: extraLinks.length,
    };
  }
  if (withStatements) summary.statements = totals.statement;
  if (withScreens) {
    // Two numbers, because they answer two different questions: how many screens
    // the pack HAS, and how many of them reach a route this map draws. The
    // difference is the screens that are not on the picture, and it is reported
    // rather than left as a silence.
    summary.screens = screensReaching;
    summary.screensTotal = screensTotal;
  }

  return { mode, depth, layers: { statements: withStatements, screens: withScreens }, limit, nodes: kept, links: keptLinks, summary };
}

/** The measured size of the answer's payload: the real serialisation, not a guess. */
function sizeOf(nodes, links) {
  return Buffer.byteLength(JSON.stringify({ nodes, links }), 'utf8');
}

/** Every table in the pack with its comment and how many columns the catalog declared. */
function tableCensus(graph) {
  const facts = new Map();
  for (const n of graph.nodes.values()) if (n.kind === 'table') facts.set(n.id, { comment: n.comment ?? null, columnCount: 0 });
  for (const e of graph.edges) {
    if (e.type !== 'DECLARES') continue;
    const f = facts.get(e.from);
    if (f) f.columnCount += 1;
  }
  return facts;
}

/**
 * The short name of the method a route runs. ONE label for a node that may run
 * two methods: the primary handler under the shared rule (core/walks.mjs), which
 * is the same method `flow` draws its picture from — so the map and the Flow tab
 * never name different methods for the same route. How many handlers there
 * really are travels with the node (`handlers`), and the count of such routes is
 * in `summary.walk.multiHandlerEndpoints`.
 *
 * The endpoint node's own `handler` fqn is the fallback when the code axis
 * recorded the name but no edge.
 */
function handlerShortOf(graph, epId, node) {
  const primary = primaryHandlerOf(graph, epId);
  if (primary) return nodeLabel(graph.nodes.get(primary), primary);
  return node.handler ? nodeLabel({ kind: 'symbol' }, `symbol:${node.handler}`) : null;
}

function degreeOf(nodes, links) {
  const d = new Map(nodes.map((n) => [n.id, 0]));
  for (const l of links) {
    if (d.has(l.source)) d.set(l.source, d.get(l.source) + 1);
    if (d.has(l.target)) d.set(l.target, d.get(l.target) + 1);
  }
  return d;
}

/** The access a link carries, aggregated the way core/chain.mjs aggregates a table's. */
function joinAccess(set) { return [...set].sort().join('+'); }

function strip(id) { return id.slice(id.indexOf(':') + 1); }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export { groupOfPath };

export class MapError extends Error {
  constructor(message) { super(message); this.name = 'MapError'; }
}
