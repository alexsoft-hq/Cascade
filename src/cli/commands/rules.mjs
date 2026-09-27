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
// example does not hold, and 2 when an example could not be run at all (a Java
// example needs a JDK): an example nobody ran is not one that holds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinRegistry } from '../../core/rules/registry.mjs';
import { testRules } from '../../core/rules/examples.mjs';
import { findJdk } from '../env.mjs';
import { runJavaLane } from '../lanes_run.mjs';

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

/**
 * The Java worker, run over example sources written to a scratch tree that is
 * removed after; null when there is no JDK, so the examples are reported not run.
 */
function javaWorkerForExamples() {
  const jdk = findJdk();
  if (!jdk) return null;
  return (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-rule-examples-'));
    try {
      writeSources(dir, files);
      return runJavaLane(jdk, dir, [dir], { quiet: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Each example source written under `dir` at its own relative name. */
function writeSources(dir, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.name)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.name), f.text);
  }
}

function statusOf(r) {
  if (r.notRun) return 'SKIP';
  return r.failures.length === 0 ? 'ok  ' : 'FAIL';
}

function printResults(results, only) {
  for (const r of results) {
    const counted = r.notRun ? `not run: ${r.notRun}` : `${r.total - r.failures.length}/${r.total} example(s) hold`;
    print(`${statusOf(r)}  ${r.id}  ${counted}`);
    for (const f of r.failures) print(`        ${JSON.stringify(f.example)} gave ${JSON.stringify(f.got)}`);
  }
  const held = results.filter((r) => !r.notRun && r.failures.length === 0).length;
  print(results.length === 0 ? `no rule or pack ${JSON.stringify(only)}` : `${held} of ${results.length} rule(s) hold every example`);
}

function test(registry, only, asJson) {
  const javaFacts = javaWorkerForExamples();
  const results = testRules(registry, { only, env: javaFacts ? { javaFacts } : {} });
  if (asJson) print(JSON.stringify(results, null, 2));
  else printResults(results, only);
  const failed = results.length === 0 || results.some((r) => r.failures.length > 0);
  process.exit(failed ? 1 : results.some((r) => r.notRun) ? 2 : 0);
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
