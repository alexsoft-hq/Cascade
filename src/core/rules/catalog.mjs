// catalog.mjs — the rule packs as one read-only answer: what each rule says, why, its examples, and where it left its mark in a pack.
//
// The viewer's Rules tab reads this, so a person sees the same rules
// `cascade rules show` prints and the engine runs. A rule whose kind draws
// edges names itself in the evidence of each edge it gave (`evidence.rule`), and
// the count of those edges in the pack at hand is what "applied here" means. A
// kind that only classifies (a database read from a path) draws no edge, and
// its count is null rather than a zero that would read as "never used".

/** How many edges of `graph` name each rule in their evidence. */
function appliedCounts(graph) {
  const counts = new Map();
  for (const e of graph.edges) {
    const rule = e?.evidence?.rule;
    if (typeof rule === 'string') counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return counts;
}

function ruleEntry(entry, kind, counts) {
  const { description, why = null, grade = null, params, examples } = entry.rule;
  const drawsEdges = kind.gradeCap !== null;
  return {
    id: entry.id, kind: entry.kind, description, why, grade, params, examples,
    appliedHere: counts && drawsEdges ? (counts.get(entry.id) ?? 0) : null,
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
