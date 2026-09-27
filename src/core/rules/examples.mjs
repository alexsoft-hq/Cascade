// examples.mjs — every rule's examples, run: the test that a rule still does what it says.
//
// A rule's examples are part of the rule. They are what a person reads to see
// what the rule means, and what this file runs to see that it still means it.
// The repository's own tests run them for every pack the engine carries, and
// `cascade rules test` runs them on any machine.

/** Whether a registry entry is the one asked about: a rule id, a pack name, or nothing (all). */
const wanted = (entry, only) => !only || entry.id === only || entry.pack === only;

/**
 * Run the examples of the rules asked about.
 *
 * @param {object} registry  from buildRegistry / builtinRegistry
 * @param {{only?:string}} [opts]  a rule id or a pack name; every rule when absent
 * @returns {{id:string, pack:string, kind:string, total:number, failures:{example:object, got:*}[]}[]}
 */
export function testRules(registry, { only } = {}) {
  const out = [];
  for (const entry of registry.rules.values()) {
    if (!wanted(entry, only)) continue;
    const kind = registry.kinds[entry.kind];
    const failures = [];
    for (const example of entry.rule.examples) {
      const result = kind.runExample(entry.compiled, example);
      if (!result.passed) failures.push({ example, got: result.got });
    }
    out.push({ id: entry.id, pack: entry.pack, kind: entry.kind, total: entry.rule.examples.length, failures });
  }
  return out;
}
