// browse_census.mjs — is a browse row the census the impact tools are held to? (RM67-U2i)
//
// `walkAgreement` (src/core/walk_agreement.mjs) holds the impact tools and
// Trace to the whole-pack census it reads with `censusReach`. `browse` counts
// its table and column rows on a census of its own, kept per mode in
// src/mcp/tools.mjs. This reads every table and column row browse gives in one
// mode and names each whose `endpoints` or `screens` is not what `censusReach`
// counts in the same mode, so the list a reader picks from and the impact
// answer it opens are one number.

import { callTool } from '../../src/mcp/catalog.mjs';
import { censusReach } from '../../src/core/walk_agreement.mjs';

const ctxOf = (graph) => ({
  graph, basis: { project: 't', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
  trust: { trustLevel: 'UNCERTIFIED' }, limits: [], pack: { digest: 'd' },
});

/** Every row of one kind in one mode, page by page. */
function allRows(graph, kind, mode) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const r = callTool('browse', { kind, mode, limit: 500, offset }, ctxOf(graph));
    rows.push(...r.answer.items);
    const next = r.truncated.fields.find((f) => f.field === 'items').nextOffset;
    if (next == null) return rows;
    offset = next;
  }
}

/**
 * Where browse and the census part, in one mode: `{rows, differences}`, with
 * `rows` the number of rows compared. A row with no `screens` (a pack with no
 * screen axis) is compared on `endpoints` alone.
 */
export function browseCensusDiff(graph, mode) {
  const census = censusReach(graph, mode);
  const differences = [];
  let rows = 0;
  for (const kind of ['table', 'column']) {
    for (const row of allRows(graph, kind, mode)) {
      rows += 1;
      const id = `${kind}:${row[kind]}`;
      const want = { endpoints: census.endpoints.get(id)?.size ?? 0, screens: census.screens.get(id)?.size ?? 0 };
      for (const field of ['endpoints', 'screens']) {
        if (row[field] !== undefined && row[field] !== want[field]) differences.push({ id, field, browse: row[field], census: want[field] });
      }
    }
  }
  return { rows, differences };
}
