// rules.mjs — `cascade rules`: the rule packs this engine reads, what each rule says, and whether its examples still hold.
//
// The engine's knowledge of frameworks (which words name which database, which
// base types make a mapper) is moving out of its code and into rule packs a
// person can read, and a person and an AI agent read them here:
//
//   list          every pack and rule, with how many examples each carries
//   show <id>     one rule whole: what it means, why it is there, its params and examples
//   test [<id>]   run the examples of every rule, or of one rule or one pack
//
// `--json` prints the same thing for a program to read. `test` exits 1 when an
// example does not hold, so it can stand in a CI job.

import { builtinRegistry } from '../../core/rules/registry.mjs';
import { testRules } from '../../core/rules/examples.mjs';

const USAGE = 'usage: cascade rules list [--json]\n'
  + '       cascade rules show <rule id> [--json]\n'
  + '       cascade rules test [<rule id> | <pack>] [--json]';

const firstSentence = (text) => String(text).split(/(?<=\.)\s/)[0];
const print = (text) => process.stdout.write(`${text}\n`);

function list(registry, asJson) {
  if (asJson) {
    print(JSON.stringify(registry.packs.map((p) => ({ ...p, rules: p.ruleIds.map((id) => ruleSummary(registry.rules.get(id))) })), null, 2));
    return;
  }
  print(`${registry.packs.length} pack(s), ${registry.rules.size} rule(s), carried by the engine`);
  for (const p of registry.packs) {
    print(`\n${p.name}@${p.version}  ${p.description}`);
    for (const id of p.ruleIds) {
      const e = registry.rules.get(id);
      print(`  ${id}  ${e.kind}  ${e.rule.examples.length} example(s)  ${firstSentence(e.rule.description)}`);
    }
  }
}

const ruleSummary = (e) => ({ id: e.id, kind: e.kind, examples: e.rule.examples.length, description: e.rule.description });

function show(registry, id, asJson, die) {
  const e = registry.rules.get(id);
  if (!e) die(`no rule ${JSON.stringify(id ?? '')}; \`cascade rules list\` names every rule\n${USAGE}`);
  if (asJson) { print(JSON.stringify({ pack: e.pack, file: e.where, ...e.rule }, null, 2)); return; }
  print(`${e.id}  (${e.kind}, pack ${e.pack}, ${e.where})`);
  print(`\n${e.rule.description}`);
  if (e.rule.why) print(`\nWhy: ${e.rule.why}`);
  print(`\nParams:\n${JSON.stringify(e.rule.params, null, 2)}`);
  print(`\nExamples (${e.rule.examples.length}):`);
  for (const ex of e.rule.examples) print(`  ${JSON.stringify(ex)}`);
}

function test(registry, only, asJson) {
  const results = testRules(registry, { only });
  const failed = results.filter((r) => r.failures.length > 0);
  if (asJson) print(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      print(`${r.failures.length === 0 ? 'ok  ' : 'FAIL'}  ${r.id}  ${r.total - r.failures.length}/${r.total} example(s) hold`);
      for (const f of r.failures) print(`        ${JSON.stringify(f.example)} gave ${JSON.stringify(f.got)}`);
    }
    print(results.length === 0 ? `no rule or pack ${JSON.stringify(only)}` : `${results.length - failed.length} of ${results.length} rule(s) hold every example`);
  }
  process.exit(results.length === 0 || failed.length > 0 ? 1 : 0);
}

export function run(ctx) {
  const { argv, flag, die } = ctx;
  const sub = argv[1];
  const target = argv.slice(2).find((a) => !a.startsWith('--'));
  const registry = builtinRegistry();
  if (sub === 'list') return list(registry, flag('json'));
  if (sub === 'show') return show(registry, target, flag('json'), die);
  if (sub === 'test') return test(registry, target, flag('json'));
  return die(USAGE);
}
