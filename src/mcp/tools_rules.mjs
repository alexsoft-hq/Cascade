// tools_rules.mjs — the `rules` tool: the rule packs this engine runs, and what each rule gave in the pack at hand.
//
// The packs themselves are src/core/rules/packs/*.json, read through the
// registry; what a rule GAVE is src/core/rules/applied.mjs. This answers three
// questions a reader has about a link's evidence (`evidence.rule`): which rules
// are there, which of them did anything in THIS project, and which links did
// this one give. `cascade rules` prints the same packs; whether a rule's
// examples still hold is `cascade rules test`, because running them needs the
// workers, and an answer here must not depend on which machine asked.

import { builtinRegistry } from '../core/rules/registry.mjs';
import { appliedIndex, tally } from '../core/rules/applied.mjs';
import { nodeLabel } from '../core/chain.mjs';
import { NO_STATE_TRUST_LEVEL } from '../core/trust.mjs';
import { makeResponse } from './contract.mjs';
import { ToolError } from './tools.mjs';

const LIMIT = { default: 50, max: 500 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A whole number from `v` within [lo, hi], or `dflt` when it is not given. */
function intArg(v, lo, hi, dflt, name) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < lo || v > hi) throw new ToolError('bad-input', `${name} must be a whole number from ${lo} to ${hi}`);
  return v;
}

function readArgs(args, registry) {
  const text = (k) => (args[k] == null || args[k] === '' ? null : String(args[k]));
  const out = {
    rule: text('rule'), query: text('query'), kind: text('kind'), lane: text('lane'),
    here: args.here === true,
    limit: intArg(args.limit, 1, LIMIT.max, LIMIT.default, 'limit'),
    offset: intArg(args.offset, 0, Number.MAX_SAFE_INTEGER, 0, 'offset'),
  };
  if (out.kind && !Object.hasOwn(registry.kinds, out.kind)) {
    throw new ToolError('bad-input', `kind must be one of ${Object.keys(registry.kinds).join(', ')}`);
  }
  if (out.rule && !registry.rules.has(out.rule)) {
    throw new ToolError('unknown-key', `no rule ${JSON.stringify(out.rule)}; the rules tool with no \`rule\` lists every rule, and so does \`cascade rules list\``);
  }
  return out;
}

/** What a kind says about itself, and whether a rule of it can leave a mark in a pack. */
const kindRow = (k) => ({ name: k.name, lane: k.lane ?? null, stage: k.stage, gradeCap: k.gradeCap, draws: k.gradeCap === null ? 'classifies' : 'links' });

/**
 * What one rule gave here: its edges by type and grade, and its nodes by kind.
 * Null for a kind that only classifies (a database read from a path) and whose
 * conclusions this pack names nowhere: there is nothing to count, and a zero
 * would read as "unused". A classifying rule a lane does name (TypeORM's
 * receivers, on the statement link they typed) is counted like any other.
 */
function gaveOf(graph, entry, kind, index) {
  if (kind.gradeCap === null && !index.has(entry.id)) return null;
  const hit = index.get(entry.id) ?? { edges: [], nodes: [] };
  return {
    edges: hit.edges.length, nodes: hit.nodes.length,
    byType: tally(hit.edges, (e) => e.type), byGrade: tally(hit.edges, (e) => e.grade),
    byKind: tally(hit.nodes, (id) => graph.nodes.get(id)?.kind ?? 'unknown'),
  };
}

const gaveTotal = (g) => (g ? g.edges + g.nodes : 0);

/** One rule, as a row of the list. */
function ruleRow(graph, entry, registry, index) {
  const kind = registry.kinds[entry.kind];
  const gave = gaveOf(graph, entry, kind, index);
  return {
    id: entry.id, pack: entry.pack, kind: entry.kind, lane: kind.lane ?? null,
    grade: entry.rule.grade ?? kind.gradeCap,
    description: entry.rule.description, examples: entry.rule.examples.length,
    gave, here: gaveTotal(gave) > 0,
  };
}

/** Whether a row passes the list's filters. */
function wanted(row, a) {
  if (a.kind && row.kind !== a.kind) return false;
  if (a.lane && row.lane !== a.lane) return false;
  if (a.here && !row.here) return false;
  if (!a.query) return true;
  return `${row.id} ${row.pack} ${row.kind} ${row.description}`.toLowerCase().includes(a.query.toLowerCase());
}

/**
 * THE LIST: every pack, every rule, what applies HERE first. A rule that gave
 * something in this pack sorts before one that gave nothing, the biggest
 * first; the rest keep their id order, so the list reads the same every time.
 */
function listAnswer(graph, registry, index, a) {
  const all = [...registry.rules.values()].map((e) => ruleRow(graph, e, registry, index));
  const rows = all.filter((r) => wanted(r, a))
    .sort((x, y) => (gaveTotal(y.gave) - gaveTotal(x.gave)) || cmp(x.id, y.id));
  const packs = registry.packs.map((p) => {
    const mine = all.filter((r) => r.pack === p.name);
    const sum = (k) => mine.reduce((n, r) => n + (r.gave ? r.gave[k] : 0), 0);
    return { name: p.name, version: p.version, description: p.description, file: p.where, rules: mine.length, gave: { edges: sum('edges'), nodes: sum('nodes') } };
  });
  const answer = {
    kinds: Object.values(registry.kinds).map(kindRow),
    packs,
    rules: rows,
    totals: { packs: packs.length, rules: all.length, here: all.filter((r) => r.here).length },
  };
  if (rows.length === 0) answer.empty = { rules: all.length === 0 ? 'none' : 'not-in-this-axis' };
  const fields = [{ field: 'rules', shown: rows.length, total: rows.length, order: 'what it gave here desc, id asc', nextOffset: null }];
  return { answer, fields, limits: [] };
}

/** A node as a link's end: its id, kind and the short name the lanes use. */
function endOf(graph, id) {
  const n = graph.nodes.get(id);
  return { id, kind: n?.kind ?? id.slice(0, id.indexOf(':')), label: nodeLabel(n, id) };
}

/** A page of a list, and its `truncated` field. */
function page(list, a, field, order) {
  const shown = list.slice(a.offset, a.offset + a.limit);
  const more = a.offset + shown.length < list.length;
  return { shown, field: { field, shown: shown.length, total: list.length, order, nextOffset: more ? a.offset + shown.length : null } };
}

/** The rule whole, as its pack writes it, with where the pack is. */
function ruleWhole(entry, kind) {
  const { description, why = null, grade = null, params, examples } = entry.rule;
  return { id: entry.id, pack: entry.pack, file: entry.where, kind: entry.kind, lane: kind.lane ?? null, grade: grade ?? kind.gradeCap, description, why, params, examples };
}

/**
 * ONE RULE: the rule whole, and the links and nodes it gave in this pack, a page
 * at a time. Every edge carries its own grade and the sentence its lane wrote.
 */
function oneAnswer(graph, registry, index, a) {
  const entry = registry.rules.get(a.rule);
  const kind = registry.kinds[entry.kind];
  const hit = index.get(entry.id) ?? { edges: [], nodes: [] };
  const edges = page(hit.edges, a, 'edges', 'pack order');
  const nodes = page(hit.nodes, a, 'nodes', 'pack order');
  const gave = gaveOf(graph, entry, kind, index);
  const answer = {
    rule: ruleWhole(entry, kind),
    gave,
    edges: edges.shown.map((e) => ({ from: endOf(graph, e.from), to: endOf(graph, e.to), type: e.type, grade: e.grade, basis: e.evidence?.basis ?? null })),
    nodes: nodes.shown.map((id) => endOf(graph, id)),
  };
  const why = gave ? (a.offset > 0 ? 'not-in-this-axis' : 'none') : 'not-shipped';
  const empty = {};
  if (answer.edges.length === 0) empty.edges = why;
  if (answer.nodes.length === 0) empty.nodes = why;
  if (Object.keys(empty).length) answer.empty = empty;
  const limits = gave ? [] : [{ scope: 'rules', reason: `${entry.id} is a ${entry.kind} rule: it classifies, and draws no link. The pack does not record what it concluded, so nothing here can be counted for it; \`cascade rules test ${entry.id}\` runs its examples` }];
  return { answer, fields: [edges.field, nodes.field], limits };
}

/**
 * rules: every rule pack and rule this engine runs, sorted by what each gave in
 * this pack; or, with `rule`, one rule whole and the links and nodes it gave.
 */
export function rules(graph, args, ctx) {
  const registry = builtinRegistry();
  const a = readArgs(args || {}, registry);
  const index = appliedIndex(graph);
  const r = a.rule ? oneAnswer(graph, registry, index, a) : listAnswer(graph, registry, index, a);
  return makeResponse({
    answer: r.answer,
    basis: ctx.basis,
    trust: { trustLevel: ctx.trust?.trustLevel ?? NO_STATE_TRUST_LEVEL, axes: ['rules'], gatesNotShown: ctx.trust?.gatesNotShown ?? [], knownGaps: ctx.trust?.knownGaps ?? [] },
    limits: [...(ctx.limits ?? []), ...r.limits],
    truncated: { any: r.fields.some((f) => f.nextOffset != null), fields: r.fields },
  });
}
