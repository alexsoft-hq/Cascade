// impact.mjs — assemble an honest impact answer from the graph.
//
// This is the seam where the knowledge graph (core/graph) meets the response
// contract (mcp/contract): "if I change `target`, what is affected?" answered
// with a confidence grade per item, deterministic ordering, truncation
// disclosed, and an empty-reason when nothing is found — so an AI consumer
// never reads a cut list as complete or 0 results as "safe" (SPEC §9, §13).
//
// The grade on each affected item is the WEAKEST link of the path from the
// target to it (via graph.reach), so an item reachable only through a candidate
// edge is reported at SOUND_SET, never as confirmed.

import { FLOW_EDGE_TYPES } from '../core/graph.mjs';
import { makeResponse } from './contract.mjs';

/**
 * @param {import('../core/graph.mjs').Graph} graph
 * @param {Object} opts
 * @param {string} opts.target                node id to assess impact of
 * @param {'strict'|'conservative'|'heuristic'} [opts.mode='conservative']
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @param {Object} opts.basis                 caller-supplied (pack meta + freshness)
 * @param {Object} opts.trust                 caller-supplied (gate axes this answer leans on)
 * @param {Array}  [opts.limits=[]]           applicable limits (may be empty deliberately)
 * @returns {Object} a contract-valid response (throws via assertContract if not)
 */
export function impactAnswer(graph, opts) {
  const { target, mode = 'conservative', limit = 25, offset = 0, basis, trust, limits = [] } = opts || {};
  if (!graph || typeof graph.impactOf !== 'function') throw new ImpactError('graph is required');
  if (!target) throw new ImpactError('target node id is required');
  clampInt('limit', limit, 1, 1000);
  clampInt('offset', offset, 0, Number.MAX_SAFE_INTEGER);

  // Backward reach over EXECUTION/DATA flow only — a schema hop (column ←
  // DECLARES ← table) would list code that touches the table, not the target.
  const reached = graph.impactOf(target, { mode, edgeTypes: FLOW_EDGE_TYPES });
  // Deterministic order (SPEC §2.1): confirmed first, then by kind, then by id.
  const all = [...reached.entries()]
    .map(([id, v]) => ({ id, kind: id.slice(0, id.indexOf(':')), hops: v.hops, grade: v.pathGrade }))
    .sort(order);

  const total = all.length;
  const shown = all.slice(offset, offset + limit);
  const cut = offset + shown.length < total;

  const answer = { affected: shown };
  if (shown.length === 0) {
    // Distinguish "truly nothing depends on it" from "you paged past the end".
    answer.empty = { affected: total === 0 ? emptyReason(mode) : 'not-in-this-axis' };
  }

  const truncated = {
    any: cut,
    fields: [{
      field: 'affected',
      shown: shown.length,
      total,
      order: 'grade desc, kind asc, id asc',
      nextOffset: cut ? offset + shown.length : null,
    }],
  };

  return makeResponse({ answer, basis, trust, limits, truncated });
}

// Rank for "confirmed first" ordering.
const RANK = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };

function order(a, b) {
  if (RANK[b.grade] !== RANK[a.grade]) return RANK[b.grade] - RANK[a.grade];
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// In strict mode an empty result specifically means "no confirmed path" — still
// `none` on this axis, but the caller's `limits` should carry the strict note.
function emptyReason(mode) {
  void mode;
  return 'none';
}

function clampInt(name, v, lo, hi) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    throw new ImpactError(`${name} must be an integer in [${lo}, ${hi}], got ${v}`);
  }
}

export class ImpactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImpactError';
  }
}
