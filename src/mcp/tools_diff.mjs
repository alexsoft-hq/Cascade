// tools_diff.mjs — the `pack_diff` tool: what changed between two served packs of one project.
//
// The comparison is src/core/pack_diff.mjs. A server that serves the same
// project twice (the pack of the main branch and the pack of a pull request,
// registered under two ids) can answer "what does this change touch" without a
// shell. The other pack is loaded through the host's sibling access, under the
// same memory budget as any other project, and named in `basis.siblings`.

import { diffPacks } from '../core/pack_diff.mjs';
import { makeResponse } from './contract.mjs';
import { NO_STATE_TRUST_LEVEL } from '../core/trust.mjs';
import { ToolError } from './tools.mjs';

/** A served project as the comparison reads it: nodes, edges, meta, digest. */
const packOf = (graph, pack) => ({ nodes: [...graph.nodes.values()], edges: graph.edges, meta: pack ?? {}, digest: pack?.digest ?? null });

export function pack_diff(graph, args, ctx) {
  const baseId = args && typeof args.base === 'string' ? args.base : '';
  if (!baseId) throw new ToolError('bad-input', 'name the served project to compare against in `base`');
  const fed = ctx.federation;
  if (!fed) {
    throw new ToolError('bad-input', 'pack_diff compares two projects this server serves, and this server serves one pack. '
      + 'From the shell, `cascade diff --base <pack>` compares any two packs on disk');
  }
  if (baseId === fed.self) throw new ToolError('bad-input', `base names this project (${baseId}); name the other pack's id`);
  const other = fed.ctxFor(baseId);
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
  const d = diffPacks(packOf(other.graph, other.pack), packOf(graph, ctx.pack), { limit });
  const { truncated, ...answer } = d;
  const limits = d.conditions.verdict === 'same' ? [] : [{
    scope: 'pack-diff',
    reason: d.conditions.verdict === 'different'
      ? `the two packs were not analyzed the same way (${d.conditions.differences.map((x) => x.what).join(', ')}), so a difference here may come from the analysis rather than the code`
      : `not every analysis condition is recorded (${d.conditions.unknown.join('; ')}), so it cannot be said that the two packs were analyzed the same way`,
  }];
  return makeResponse({
    answer,
    basis: { ...ctx.basis, siblings: [{ project: baseId, buildDigest: other.basis.buildDigest, freshness: other.basis.freshness }] },
    trust: { trustLevel: ctx.trust?.trustLevel ?? NO_STATE_TRUST_LEVEL, axes: ['code', 'statements', 'catalog'], gatesNotShown: ctx.trust?.gatesNotShown ?? [], knownGaps: ctx.trust?.knownGaps ?? [] },
    limits: [...(ctx.limits ?? []), ...limits],
    truncated,
  });
}
