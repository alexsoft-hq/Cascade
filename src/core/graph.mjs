// graph.mjs — the knowledge graph. Nodes + graded edges, built from worker
// facts, with reachability / impact queries. This is what turns isolated facts
// into "code → column" answers (SPEC §8, and the round-trip of §1.1).
//
// Pure: depends only on core/policy.mjs (grade lattice) and node built-ins.
// The graph is a query-side structure (SPEC ADR A-03) — it is NOT the SSA
// compute IR. Consumers (MCP tools, viewer) read projections of it.
//
// Invariants enforced here:
//  - Edge grades come from central policy (I-1). A call fact is classified;
//    a candidate set of one never becomes CALLS/EXACT.
//  - Node/edge types are additive; unknown types are rejected at ingest so a
//    typo cannot silently create a phantom relation (fail-closed, §3.3).
//  - Reachability answers carry a path grade = the WEAKEST link on the path,
//    so a chain that used one candidate edge is never reported as confirmed.

import { classify, GRADES } from './policy.mjs';

/** Node kinds (SPEC §8.2). Additive: append only. */
export const NODE_KINDS = Object.freeze([
  'module', 'screen', 'endpoint', 'symbol', 'type', 'statement', 'table', 'column', 'domain',
]);

/** Edge types (SPEC §8.2). Additive: append only. */
export const EDGE_TYPES = Object.freeze([
  'HANDLES', 'CALLS', 'MAY_CALL', 'OVERRIDES', 'INJECTS', 'MAY_INJECT',
  'IMPLEMENTS_STMT', 'EXECUTES', 'READS', 'WRITES', 'DECLARES', 'JOINS',
  'CALLS_HTTP', 'RENDERS', 'IN_DOMAIN', 'AFFECTS',
]);

/**
 * Execution/data-flow edges — what an impact or chain walk may traverse;
 * schema/ownership relations (DECLARES, JOINS, IN_DOMAIN, AFFECTS) are not flow.
 *
 * `reach` itself stays generic (it follows whatever you ask for); the impact
 * questions pass this set, because climbing table --DECLARES--> column would
 * report code that touches only the TABLE as if it touched the column, and a
 * JOINS hop would report a joined table as if this call read it.
 */
export const FLOW_EDGE_TYPES = Object.freeze([
  'HANDLES', 'CALLS', 'MAY_CALL', 'OVERRIDES', 'INJECTS', 'MAY_INJECT',
  'IMPLEMENTS_STMT', 'EXECUTES', 'READS', 'WRITES', 'CALLS_HTTP', 'RENDERS',
]);

// Grade rank for "weakest link" path grading (mirrors policy lattice).
const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });

// Query grade sets (SPEC §3.3).
export const GRADE_SETS = Object.freeze({
  strict: new Set(['EXACT']),
  conservative: new Set(['EXACT', 'SOUND_SET']),
  heuristic: new Set(['EXACT', 'SOUND_SET', 'HEURISTIC']),
});

/**
 * Canonical, position-independent node ID (SPEC §8.1).
 * @param {typeof NODE_KINDS[number]} kind
 * @param {string} key  already-canonical key within the kind
 * @returns {string} e.g. "column:main.MD_PRSC.PRSC_NB"
 */
export function nodeId(kind, key) {
  if (!NODE_KINDS.includes(kind)) throw new GraphError(`unknown node kind: ${JSON.stringify(kind)}`);
  if (typeof key !== 'string' || key.length === 0) throw new GraphError('node key must be a non-empty string');
  return `${kind}:${key}`;
}

export class Graph {
  constructor() {
    /** @type {Map<string, object>} */ this.nodes = new Map();
    /** @type {object[]} */ this.edges = [];
    /** id -> [{to,type,grade,idx}] */ this._out = new Map();
    /** id -> [{from,type,grade,idx}] */ this._in = new Map();
  }

  /** Add or merge a node. Idempotent by id. */
  addNode(node) {
    if (!node || typeof node.id !== 'string') throw new GraphError('node.id (string) is required');
    const [kind] = node.id.split(':', 1);
    if (!NODE_KINDS.includes(kind)) throw new GraphError(`node id has unknown kind: ${node.id}`);
    const existing = this.nodes.get(node.id);
    if (existing) Object.assign(existing, node);
    else this.nodes.set(node.id, { ...node, kind });
    return this;
  }

  /**
   * Add a graded edge. `grade` MUST be a lattice grade. Endpoints are
   * auto-created as bare nodes if absent (so ingest order does not matter).
   * @param {{from:string,to:string,type:string,grade:string,evidence?:object}} e
   */
  addEdge(e) {
    if (!e || !e.from || !e.to) throw new GraphError('edge requires from and to');
    if (!EDGE_TYPES.includes(e.type)) throw new GraphError(`unknown edge type: ${JSON.stringify(e.type)}`);
    if (!GRADES.includes(e.grade)) throw new GraphError(`unknown edge grade: ${JSON.stringify(e.grade)}`);
    this._ensure(e.from);
    this._ensure(e.to);
    const idx = this.edges.length;
    const rec = { from: e.from, to: e.to, type: e.type, grade: e.grade, evidence: e.evidence ?? null };
    this.edges.push(rec);
    push(this._out, e.from, { to: e.to, type: e.type, grade: e.grade, idx });
    push(this._in, e.to, { from: e.from, type: e.type, grade: e.grade, idx });
    return this;
  }

  _ensure(id) {
    if (!this.nodes.has(id)) {
      const [kind] = id.split(':', 1);
      if (!NODE_KINDS.includes(kind)) throw new GraphError(`edge endpoint has unknown kind: ${id}`);
      this.nodes.set(id, { id, kind, stub: true });
    }
  }

  /**
   * Out-adjacency of a node: [{to, type, grade, idx}], empty array if none.
   * Returned as-is (not copied) so a walker can scan it without allocating —
   * treat it as READ-ONLY; mutating it corrupts the graph.
   * @param {string} id
   */
  outEdges(id) { return this._out.get(id) ?? EMPTY_ADJ; }

  /** In-adjacency of a node: [{from, type, grade, idx}]. Read-only (see outEdges). */
  inEdges(id) { return this._in.get(id) ?? EMPTY_ADJ; }

  /** The full edge record behind an adjacency entry's `idx` (carries evidence). */
  edgeAt(idx) { return this.edges[idx]; }

  /**
   * Reachability from `start`. Returns a Map of reached id -> {hops, pathGrade, via}.
   * pathGrade is the weakest link along the discovered path (I: a chain through
   * a SOUND_SET edge is at best SOUND_SET, never EXACT). `via` is the index of
   * the edge that produced this node's current best record.
   *
   * CAUTION: `via` is ONE edge, not a path. Do not rebuild a path by reading the
   * `via` of each ancestor in turn — an ancestor's record can be REPLACED later
   * (a stronger-but-longer path wins on grade), and the chain you would read
   * back was then never walked as a whole: longer than the node's own `hops` and
   * graded better than any path that exists. A walker that needs the real path
   * must carry the parent record it came from; core/chain.mjs does exactly that.
   * GENERATED CODE: a step from one `generated:true` node to another is not
   * taken (core/chain.mjs states the rule in full — a generated node a real
   * caller reaches IS walked; only the machine-written interior is skipped).
   * `walkGenerated: true` turns it off. The count of skipped steps is not
   * returned here — `reach` answers a set, not a census; the walk that has to
   * disclose a cut is chainWalk.
   * @param {string} start
   * @param {{direction?:'out'|'in', mode?:'strict'|'conservative'|'heuristic', maxHops?:number,
   *          edgeTypes?:string[], walkGenerated?:boolean}} [opts]
   */
  reach(start, opts = {}) {
    const direction = opts.direction ?? 'out';
    const allow = GRADE_SETS[opts.mode ?? 'conservative'];
    if (!allow) throw new GraphError(`unknown mode: ${opts.mode}`);
    const maxHops = opts.maxHops ?? Infinity;
    const typeFilter = opts.edgeTypes ? new Set(opts.edgeTypes) : null;
    const adj = direction === 'in' ? this._in : this._out;
    if (!this.nodes.has(start)) throw new GraphError(`start node not in graph: ${start}`);
    const skipGenerated = opts.walkGenerated !== true;
    const isGenerated = (id) => this.nodes.get(id)?.generated === true;

    const best = new Map(); // id -> {hops, pathGrade, via, http}
    // BFS; revisit a node if we found a stronger path grade or fewer hops.
    // `http` rides along like `hops`: how many INTERNAL HTTP HOPS the winning
    // path crossed (SPEC §1.1 — a @FeignClient method calling a route another
    // module in this pack serves). It is carried, not derived, because the
    // record holds ONE edge and not the path (see the CAUTION above), and a
    // reader must be told when an "affected endpoint" is affected only through
    // another deployable.
    const queue = [{ id: start, hops: 0, pathGrade: 'EXACT', http: 0, generated: skipGenerated && isGenerated(start) }];
    while (queue.length) {
      const cur = queue.shift();
      if (cur.hops >= maxHops) continue;
      for (const edge of adj.get(cur.id) ?? []) {
        if (!allow.has(edge.grade)) continue;
        if (typeFilter && !typeFilter.has(edge.type)) continue;
        const next = direction === 'in' ? edge.from : edge.to;
        if (cur.generated && isGenerated(next)) continue;
        const pathGrade = weaker(cur.pathGrade, edge.grade);
        const hops = cur.hops + 1;
        const http = cur.http + (edge.type === 'CALLS_HTTP' ? 1 : 0);
        const prev = best.get(next);
        if (!prev || RANK[pathGrade] > RANK[prev.pathGrade] || (RANK[pathGrade] === RANK[prev.pathGrade] && hops < prev.hops)) {
          best.set(next, { hops, pathGrade, via: edge.idx, http });
          queue.push({ id: next, hops, pathGrade, http, generated: skipGenerated && isGenerated(next) });
        }
      }
    }
    return best;
  }

  /**
   * Impact of a node: what depends on it (backward reach). The core "if I
   * change this, what breaks" query.
   * @param {string} id
   * @param {object} [opts] same as reach (direction is forced to 'in')
   */
  impactOf(id, opts = {}) {
    return this.reach(id, { ...opts, direction: 'in' });
  }

  /** Convenience: reached node ids as a sorted array. */
  static ids(reachMap) {
    return [...reachMap.keys()].sort();
  }
}

/**
 * Build a graph from worker facts. Two fact shapes:
 *  - node: { fact:'node', id, ...attrs }
 *  - edge: { fact:'edge', from, to, type, grade }           (structural; grade asserted)
 *  - call: { fact:'call', from, to, evidence }              (classified via policy)
 * A 'call' fact's edge type is CALLS when EXACT, else MAY_CALL (SPEC §8.2/§8.3).
 * @param {object[]} facts
 * @param {{mode?:string}} [opts]  analysis mode passed to policy.classify
 * @returns {Graph}
 */
export function buildGraph(facts, opts = {}) {
  const g = new Graph();
  if (!Array.isArray(facts)) throw new GraphError('facts must be an array');
  for (const f of facts) {
    if (!f || typeof f !== 'object') throw new GraphError('fact must be an object');
    if (f.fact === 'node') {
      // Drop the discriminant cleanly — a lingering `fact:undefined` would
      // canonicalize to "fact":null and pollute node digests (§2.1).
      const { fact, ...attrs } = f;
      void fact;
      g.addNode(attrs);
    } else if (f.fact === 'edge') {
      g.addEdge({ from: f.from, to: f.to, type: f.type, grade: f.grade, evidence: f.evidence });
    } else if (f.fact === 'call') {
      const c = classify(f.evidence ?? {}, opts.mode ?? 'RESOLVED_SOURCE');
      const type = c.grade === 'EXACT' ? 'CALLS' : 'MAY_CALL';
      g.addEdge({ from: f.from, to: f.to, type, grade: c.grade, evidence: { ...(f.evidence ?? {}), rule: c.rule } });
    } else {
      throw new GraphError(`unknown fact shape: ${JSON.stringify(f.fact)}`);
    }
  }
  return g;
}

// Shared empty adjacency — returned for a node with no edges in that direction.
const EMPTY_ADJ = Object.freeze([]);

function weaker(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}
function push(map, key, val) {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

export class GraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphError';
  }
}
