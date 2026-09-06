// pack.mjs — persist a Graph as a pack, and load it back.
//
// Analysis runs once and projects the graph into a static pack (SPEC §5); the
// MCP server then reads the pack and answers queries fast, without re-running
// the lanes. The pack is content-addressed: identical graph → identical digest
// (§2.1). Execution metadata (builtAt etc.) lives in `meta`, OUTSIDE the digest.

import { Graph } from './graph.mjs';
import { digest12 } from './canonical.mjs';

export const PACK_SCHEMA = 'cascade:pack:1';

/**
 * Project a Graph into a serializable pack.
 * @param {Graph} graph
 * @param {object} [meta]  project/basis/builtAt — carried but NOT digested
 * @returns {{schema:string, meta:object, nodes:object[], edges:object[], digest:string, counts:object}}
 */
export function projectPack(graph, meta = {}) {
  if (!(graph instanceof Graph)) throw new PackError('projectPack requires a Graph');
  const nodes = [...graph.nodes.values()]
    .map((n) => ({ ...n }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = graph.edges
    .map((e) => ({ from: e.from, to: e.to, type: e.type, grade: e.grade, ...(e.evidence ? { evidence: e.evidence } : {}) }))
    .sort(edgeOrder);
  const counts = { nodes: nodes.length, edges: edges.length };
  return { schema: PACK_SCHEMA, meta, nodes, edges, counts, digest: digest12({ nodes, edges }) };
}

/**
 * Rebuild a queryable Graph from a pack. Verifies the schema and (optionally)
 * the content digest.
 * @param {object} pack
 * @param {{verifyDigest?:boolean}} [opts]
 * @returns {Graph}
 */
export function loadPack(pack, opts = {}) {
  if (!pack || pack.schema !== PACK_SCHEMA) {
    throw new PackError(`unknown pack schema: ${pack && pack.schema} (expected ${PACK_SCHEMA})`);
  }
  if (!Array.isArray(pack.nodes) || !Array.isArray(pack.edges)) throw new PackError('pack.nodes and pack.edges must be arrays');
  if (opts.verifyDigest) {
    const d = digest12({ nodes: pack.nodes, edges: pack.edges });
    if (d !== pack.digest) throw new PackError(`pack digest mismatch: computed ${d} != stored ${pack.digest} (tampered or stale)`);
  }
  const g = new Graph();
  for (const n of pack.nodes) g.addNode(n);
  for (const e of pack.edges) g.addEdge(e);
  return g;
}

function edgeOrder(a, b) {
  return a.from < b.from ? -1 : a.from > b.from ? 1
    : a.to < b.to ? -1 : a.to > b.to ? 1
      : a.type < b.type ? -1 : a.type > b.type ? 1 : 0;
}

export class PackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackError';
  }
}
