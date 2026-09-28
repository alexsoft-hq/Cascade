// catalog.mjs — the rule packs as one read-only answer: what each rule says, why, its examples, and where it left its mark in a pack.
//
// `GET /api/rules` answers this, so a person sees the same rules `cascade
// rules show` prints and the engine runs; the viewer's Rules tab now reads the
// `rules` tool, which says the same with a contract around it. A rule whose
// kind draws edges names itself in the evidence of each edge it gave
// (`evidence.rule`), or in a node's own evidence block for a node it decided
// (src/core/rules/applied.mjs), and the count of both in the pack at hand is
// what "applied here" means. A kind that only classifies (a database read from
// a path) draws no edge, and its count is null rather than a zero that would
// read as "never used".

import { appliedIndex } from './applied.mjs';

/** How many edges and nodes of `graph` name each rule in their evidence. */
function appliedCounts(graph) {
  const index = appliedIndex({ edges: graph.edges.filter(Boolean), nodes: graph.nodes ?? new Map() });
  return new Map([...index].map(([rule, hit]) => [rule, hit.edges.length + hit.nodes.length]));
}

/**
 * How many things of this pack name the rule: null with no pack, and null for a
 * classifying kind the pack names nowhere; a count where a lane does name it
 * (the link a TypeORM receiver rule typed).
 */
const countable = (id, kind, counts) => kind.gradeCap !== null || counts.has(id);
function appliedHereOf(id, kind, counts) {
  if (!counts || !countable(id, kind, counts)) return null;
  return counts.get(id) ?? 0;
}

function ruleEntry(entry, kind, counts) {
  const { description, why = null, grade = null, params, examples } = entry.rule;
  return {
    id: entry.id, kind: entry.kind, description, why, grade, params, examples,
    appliedHere: appliedHereOf(entry.id, kind, counts),
  };
}

/**
 * Every kind and every pack of `registry`, each rule whole, and, when a pack's
 * graph is given, how many of its edges each rule gave.
 *
 * @param {{packs:object[], rules:Map<string,object>, kinds:object}} registry
 * @param {{edges:object[]}|null} [graph]
 */
export function rulesCatalog(registry, graph = null) {
  const counts = graph ? appliedCounts(graph) : null;
  return {
    kinds: Object.values(registry.kinds).map((k) => ({ name: k.name, stage: k.stage, gradeCap: k.gradeCap })),
    packs: registry.packs.map((p) => ({
      name: p.name, version: p.version, description: p.description, file: p.where,
      rules: p.ruleIds.map((id) => {
        const entry = registry.rules.get(id);
        return ruleEntry(entry, registry.kinds[entry.kind], counts);
      }),
    })),
  };
}
