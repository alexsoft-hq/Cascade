// tools_summary.mjs — the `summary` tool: the whole pack as a dozen boxes a side.
//
// The grouping is src/core/summary.mjs. What this adds is the sentence every
// answer owes its reader: which rule made the groups and the table families,
// that a group nobody declared is where code sits and not a business boundary,
// and when one box still holds most of the routes.

import { buildSummary, SUMMARY_LIMIT } from '../core/summary.mjs';
import { NO_STATE_TRUST_LEVEL } from '../core/trust.mjs';
import { makeResponse } from './contract.mjs';
import { ToolError } from './tools.mjs';

const MODES = ['strict', 'conservative', 'heuristic'];
const LIMIT_MAX = 30;

/** The sentence for the rule that made the groups. */
function groupLimit(rule) {
  if (rule.kind === 'declared') {
    return `a group is the handler's package cut to ${rule.packageDepth} segment(s), as the profile declares in moduleAttribution.packageDepth`;
  }
  if (rule.kind === 'code-path') {
    return `a group is where the handler code sits, read below the package every handler shares (${rule.commonPrefix || 'none'}). Nobody declared it a module, so it is often a business area and not always one. Declare moduleAttribution.packageDepth to set the groups yourself`;
  }
  return `a group is the route path's segment below ${rule.commonPath}`
    + (rule.onePackage ? `, because every handler sits in the one package ${rule.onePackage}` : ', because no route here has a handler')
    + '. It is how the routes are named, not a module anyone declared';
}

/** The sentence for the rule that made the table families. */
function familyLimit(rule) {
  const under = rule.commonPrefix ? ` below the shared ${JSON.stringify(rule.commonPrefix)}` : '';
  return rule.kind === 'name-words'
    ? `a table family is the tables whose names start with the same word${under}. It is a naming pattern, not a schema`
    : `a table family is the tables whose names start with the same letters${under}, because the names here carry no underscore. It is a naming pattern, not a schema`;
}

function readArgs(args) {
  const mode = args.mode ?? 'conservative';
  if (!MODES.includes(mode)) throw new ToolError('bad-input', `mode must be ${MODES.join(', ')}`);
  const depth = args.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1 || depth > 12) throw new ToolError('bad-input', 'depth must be a whole number from 1 to 12');
  const limit = args.limit ?? SUMMARY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new ToolError('bad-input', `limit must be a whole number from 1 to ${LIMIT_MAX}`);
  return { mode, depth, limit };
}

export function summary(graph, args, ctx) {
  const { mode, depth, limit } = readArgs(args || {});
  const packageDepth = ctx.profile?.moduleAttribution?.packageDepth ?? null;
  const s = buildSummary(graph, { mode, depth, limit, packageDepth });
  const own = [
    { scope: 'summary:groups', reason: groupLimit(s.rule.groups) },
    { scope: 'summary:families', reason: familyLimit(s.rule.tables) },
  ];
  if (s.lopsided) {
    own.push({ scope: 'summary:lopsided', reason: `one group, ${s.lopsided.group}, holds ${s.lopsided.share}% of the routes, so this picture says little about how the code is divided` });
  }
  const answer = { mode, depth, limit, ...s };
  const empty = {};
  for (const k of ['groups', 'families', 'links']) if (answer[k].length === 0) empty[k] = s.totals.endpoints === 0 ? 'not-shipped' : 'none';
  if (Object.keys(empty).length) answer.empty = empty;
  const fields = [
    { field: 'groups', shown: s.groups.length, total: s.totals.groups, order: 'routes desc, name asc', nextOffset: null },
    { field: 'families', shown: s.families.length, total: s.totals.families, order: 'tables desc, name asc', nextOffset: null },
  ];
  return makeResponse({
    answer,
    basis: ctx.basis,
    trust: { trustLevel: ctx.trust?.trustLevel ?? NO_STATE_TRUST_LEVEL, axes: ['code', 'statements'], gatesNotShown: ctx.trust?.gatesNotShown ?? [], knownGaps: ctx.trust?.knownGaps ?? [] },
    limits: [...(ctx.limits ?? []), ...own],
    truncated: { any: false, fields },
  });
}
