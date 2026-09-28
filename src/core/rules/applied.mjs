// applied.mjs — what each rule GAVE in one pack: the links whose evidence names it, and the nodes a lane marked with it.
//
// A rule that draws a link names itself on it (`evidence.rule`). A rule can also
// decide what a NODE is without drawing a line: a Prisma operation rule decides
// what one call site's statement reads and writes, and the lane marks that
// statement with it in its own evidence block (`prismaEvidence.rule`). Counting
// only the links said "0 links" for a rule that made 151 statements.
//
// Both are read the same way for every lane, by shape rather than by name: an
// attribute called `evidence`, or ending in `Evidence`, whose `rule` is a
// string. A lane that marks its nodes that way is counted with no change here.

/**
 * The rule ids a node's evidence blocks name, in attribute order, each once: two
 * blocks that name one rule are one node that rule marked, not two.
 */
function nodeRules(n) {
  const out = new Set();
  for (const [k, v] of Object.entries(n)) {
    if ((k === 'evidence' || k.endsWith('Evidence')) && v && typeof v.rule === 'string') out.add(v.rule);
  }
  return [...out];
}

/**
 * THE INDEX: for each rule id a pack names, the edges whose evidence names it
 * and the ids of the nodes marked with it, both in pack order.
 *
 * @param {{nodes:Map<string,object>, edges:object[]}} graph
 * @returns {Map<string,{edges:object[], nodes:string[]}>}
 */
export function appliedIndex(graph) {
  const index = new Map();
  const at = (id) => {
    if (!index.has(id)) index.set(id, { edges: [], nodes: [] });
    return index.get(id);
  };
  for (const e of graph.edges) {
    const rule = e?.evidence?.rule;
    if (typeof rule === 'string') at(rule).edges.push(e);
  }
  for (const n of graph.nodes.values()) {
    for (const rule of nodeRules(n)) at(rule).nodes.push(n.id);
  }
  return index;
}

/** How many of each thing a list holds, by `key`, sorted by name. */
export function tally(items, key) {
  const counts = new Map();
  for (const it of items) counts.set(key(it), (counts.get(key(it)) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
