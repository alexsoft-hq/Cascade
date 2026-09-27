// examples.mjs — every rule's examples, run: the test that a rule still does what it says.
//
// A rule's examples are part of the rule. They are what a person reads to see
// what the rule means, and what this file runs to see that it still means it.
// The repository's own tests run them for every pack the engine carries, and
// `cascade rules test` runs them on any machine.
//
// A kind runs its examples one at a time (`runExample`) or all together
// (`runExamples`, for a kind whose examples go through a worker once). An
// example that could not be run, because the worker it needs is not there, is
// NOT RUN and says why: it is never counted as holding.

/** Whether a registry entry is the one asked about: a rule id, a pack name, or nothing (all). */
const wanted = (entry, only) => !only || entry.id === only || entry.pack === only;

/** One kind's entries, run the way the kind runs them: per rule, the results or why none were run. */
function runKind(kind, entries, env) {
  if (typeof kind.runExamples === 'function') {
    const batch = kind.runExamples(entries, env);
    return new Map(entries.map((e) => [e.id, batch.notRun ? { notRun: batch.notRun } : { results: batch.results.get(e.id) }]));
  }
  return new Map(entries.map((e) => [e.id, {
    results: e.rule.examples.map((example) => ({ example, ...kind.runExample(e.compiled, example) })),
  }]));
}

/**
 * Run the examples of the rules asked about.
 *
 * @param {object} registry  from buildRegistry / builtinRegistry
 * @param {{only?:string, env?:{javaFacts?:Function}}} [opts]  a rule id or a pack name; the workers the examples may need
 * @returns {{id:string, pack:string, kind:string, total:number, failures:{example:object, got:*}[], notRun:(string|null)}[]}
 */
export function testRules(registry, { only, env } = {}) {
  const chosen = [...registry.rules.values()].filter((e) => wanted(e, only));
  const outcome = new Map();
  for (const [kindName, entries] of groupByKind(chosen)) {
    for (const [id, r] of runKind(registry.kinds[kindName], entries, env)) outcome.set(id, r);
  }
  return chosen.map((e) => reportOf(e, outcome.get(e.id)));
}

/** Registry entries grouped by their kind, in the order they came. */
function groupByKind(entries) {
  const byKind = new Map();
  for (const e of entries) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  return byKind;
}

/** One rule's line of the report: what did not hold, or why nothing was run. */
function reportOf(entry, run) {
  const failures = (run.results ?? []).filter((x) => !x.passed).map((x) => ({ example: x.example, got: x.got }));
  return { id: entry.id, pack: entry.pack, kind: entry.kind, total: entry.rule.examples.length, failures, notRun: run.notRun ?? null };
}
