// tools_diff.mjs — the `pack_diff` tool: what changed between two packs of ONE project.
//
// The comparison is src/core/pack_diff.mjs. The base is one of two things:
//
//   base_history / base_commit   an earlier build of THIS project, kept in its
//                                pack history (src/cli/pack_history.mjs). This is
//                                the ordinary case: the project as it is, against
//                                the project as it was.
//   base                         another project this server serves, for a pack
//                                of the same repository registered under a second
//                                id. It is loaded through the host's sibling
//                                access and named in `basis.siblings`.
//
// Two packs of DIFFERENT repositories are refused, by the rule in
// src/core/repo_identity.mjs: their difference is everything, and a list of a
// thousand added routes would read like a review while meaning nothing.

import { diffPacks } from '../core/pack_diff.mjs';
import { differentRepositorySentence, sameRepository } from '../core/repo_identity.mjs';
import { makeResponse } from './contract.mjs';
import { NO_STATE_TRUST_LEVEL } from '../core/trust.mjs';
import { ToolError } from './tools.mjs';

/** The source pack has exact JSON distinctions Graph deliberately does not retain. */
function rawPackOf(ctx) {
  const raw = ctx?.packJson;
  const digest = ctx?.pack?.digest ?? ctx?.basis?.buildDigest ?? null;
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  return !digest || raw.digest === digest ? raw : null;
}

/** A served project as the comparison reads it: raw when available, else graph. */
const packOf = (graph, ctx) => rawPackOf(ctx)
  ?? { nodes: [...graph.nodes.values()], edges: graph.edges, meta: ctx?.pack ?? {}, digest: ctx?.pack?.digest ?? null };

/** The base pack the arguments name, and the sibling basis when it is another served project. */
function baseOf(args, ctx) {
  const historyId = typeof args.base_history === 'string' ? args.base_history : null;
  const commit = typeof args.base_commit === 'string' ? args.base_commit : null;
  const baseId = typeof args.base === 'string' ? args.base : null;
  if ([historyId, commit, baseId].filter(Boolean).length !== 1) {
    throw new ToolError('bad-input', 'name exactly one base: `base_commit` or `base_history` (an earlier build of this project), or `base` (another served pack of the same repository)');
  }
  if (historyId || commit) {
    const kept = ctx.history ? ctx.history.load(historyId ? { id: historyId } : { commit }) : null;
    if (!kept) {
      throw new ToolError('unknown-key', `this project's pack history holds no build ${historyId ? `with id ${historyId}` : `at commit ${commit}`}. `
        + 'A certified analyze keeps the pack it replaces; `cascade diff --base-commit <rev>` builds one from any commit');
    }
    return { pack: kept.pack, siblings: null };
  }
  const fed = ctx.federation;
  if (!fed) throw new ToolError('bad-input', 'this server serves one pack, so `base` has no other project to name. Use `base_commit` for an earlier build of this one');
  if (baseId === fed.self) throw new ToolError('bad-input', `base names this project (${baseId}); name the other pack's id`);
  const other = fed.ctxFor(baseId);
  return { pack: packOf(other.graph, other), siblings: [{ project: baseId, buildDigest: other.basis.buildDigest, freshness: other.basis.freshness }] };
}

export function pack_diff(graph, args, ctx) {
  const base = baseOf(args || {}, ctx);
  const head = packOf(graph, ctx);
  const repo = sameRepository(base.pack, head);
  if (repo.verdict === 'different') throw new ToolError('bad-input', differentRepositorySentence(repo));
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined;
  const d = diffPacks(base.pack, head, { limit });
  const { truncated, ...answer } = d;
  const repoLimit = repo.verdict === 'unknown'
    ? [{ scope: 'pack-diff:repository', reason: 'neither pack records which repository it was built from, so it cannot be said they are one codebase' }] : [];
  const limits = d.conditions.verdict === 'same' ? repoLimit : [...repoLimit, {
    scope: 'pack-diff',
    reason: d.conditions.verdict === 'different'
      ? `the two packs were not analyzed the same way (${d.conditions.differences.map((x) => x.what).join(', ')}), so a difference here may come from the analysis rather than the code`
      : `not every analysis condition is recorded (${d.conditions.unknown.join('; ')}), so it cannot be said that the two packs were analyzed the same way`,
  }];
  return makeResponse({
    answer,
    basis: base.siblings ? { ...ctx.basis, siblings: base.siblings } : ctx.basis,
    trust: { trustLevel: ctx.trust?.trustLevel ?? NO_STATE_TRUST_LEVEL, axes: ['code', 'statements', 'catalog'], gatesNotShown: ctx.trust?.gatesNotShown ?? [], knownGaps: ctx.trust?.knownGaps ?? [] },
    limits: [...(ctx.limits ?? []), ...limits],
    truncated,
  });
}
