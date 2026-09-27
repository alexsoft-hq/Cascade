// rules.mjs — `cascade rules`: the rule packs this engine reads, what each rule says, and whether its examples still hold.
//
// The engine's knowledge of frameworks (which words name which database, which
// base types make a mapper) is moving out of its code and into rule packs a
// person can read, and a person and an AI agent read them here:
//
//   list          every pack and rule, with how many examples each carries
//   show <id>     one rule whole: what it means, why it is there, its params and examples
//   test [<id>]   run the examples of every rule, or of one rule or one pack
//   explain <type>  why a Java type of this project has a role, or has none
//
// `--json` prints the same thing for a program to read. `test` exits 1 when an
// example does not hold, and 2 when an example could not be run at all (a Java
// example needs a JDK): an example nobody ran is not one that holds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinRegistry } from '../../core/rules/registry.mjs';
import { testRules } from '../../core/rules/examples.mjs';
import { explainTypeRoles } from '../../core/rules/explain.mjs';
import { withTypeRoles } from '../../core/java_roles.mjs';
import { FactsStoreError } from '../../core/facts_store.mjs';
import { readEntityModel } from '../../adapters/mp_bridge.mjs';
import { readOpenApiDocument } from '../../adapters/openapi_bridge.mjs';
import { findJdk } from '../env.mjs';
import { runJavaLane } from '../lanes_run.mjs';
import { cachedJavaFacts, CachedFactsError } from '../cached_facts.mjs';
import { factsOfFile, valueOfSource } from '../../../adapters/ts/tsfacts.mjs';

const USAGE = 'usage: cascade rules list [--json]\n'
  + '       cascade rules show <rule id> [--json]\n'
  + '       cascade rules test [<rule id> | <pack>] [--json]\n'
  + '       cascade rules explain <type> [--root <dir> | --project <id>] [--json]';

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

/**
 * The readers that run in process: a TypeScript example needs nothing but the
 * engine, and neither does an OpenAPI document.
 */
const IN_PROCESS_READERS = Object.freeze({ tsFacts: factsOfFile, tsValue: valueOfSource, openApiDocument: readOpenApiDocument });

function test(registry, only, asJson) {
  const javaFacts = javaWorkerForExamples();
  const results = testRules(registry, { only, env: { ...IN_PROCESS_READERS, ...(javaFacts ? { javaFacts } : {}) } });
  if (asJson) print(JSON.stringify(results, null, 2));
  else printResults(results, only);
  const failed = results.length === 0 || results.some((r) => r.failures.length > 0);
  process.exit(failed ? 1 : results.some((r) => r.notRun) ? 2 : 0);
}

/** The role the MyBatis-Plus bridge gives `fqn` once it follows the whole chain, or null when it gives none. */
function chainRoleOf(javaFacts, fqn) {
  const model = readEntityModel(withTypeRoles(javaFacts));
  return model.empty ? null : model.roleOf(fqn);
}

function chainSaid(role) {
  if (!role) return 'no role: nothing in the chain reaches a MyBatis-Plus base type a rule reads';
  const entity = role.entity?.concrete ?? (role.entity ? `its own type parameter ${role.entity.param}` : 'no entity');
  const relied = (role.claims ?? []).map((c) => `${c.rule} (${c.library})`).join(', ');
  return `${role.role} of ${entity}, ${role.grade}${relied ? `, relying on ${relied}` : ''}`;
}

function verdictSaid(v) {
  if (!v.gives) return `${v.rule}: no role, ${v.why}`;
  const g = v.gives;
  const detail = [g.entityTypeSimple && `entity ${g.entityTypeSimple}`, g.mapperTypeSimple && `mapper ${g.mapperTypeSimple}`, g.grade].filter(Boolean).join(', ');
  return `${v.rule}: ${g.kind === 'mpMapper' ? 'mapper' : 'service'}${detail ? ` (${detail})` : ''}, ${v.why}`;
}

const noRuleSaid = (s) => `no rule names ${s.supertype}${s.inProject ? '; a type of the project, so the MyBatis-Plus bridge follows it to what it extends' : ''}`;

/** One supertype as printed: how the file reads its name, then what each rule concludes. */
function supertypeLines(s) {
  const args = s.args.length > 0 ? `<${s.args.map((a) => a ?? '?').join(', ')}>` : '';
  const verdicts = s.rules.length > 0 ? s.rules.map(verdictSaid) : [noRuleSaid(s)];
  return [`  ${s.supertype}${args}: ${s.meaning}`, ...verdicts.map((v) => `    ${v}`)];
}

function printExplained(types) {
  for (const t of types) {
    print(`${t.fqn}  (${t.file})`);
    for (const line of t.supertypes.flatMap(supertypeLines)) print(line);
    print(`  as the MyBatis-Plus bridge reads the whole chain: ${chainSaid(t.chain)}`);
  }
}

/** The project's Java records from its pack's fact cache, or the reason there are none and the cure. */
function projectJavaFacts({ die, resolveOrDie }) {
  try { return cachedJavaFacts(resolveOrDie().packDir); } catch (e) {
    if (e instanceof CachedFactsError || e instanceof FactsStoreError) return die(e.message);
    throw e;
  }
}

function explain(ctx, name, asJson) {
  const { die } = ctx;
  if (!name) die(`explain needs a type, by its full or simple name\n${USAGE}`);
  const javaFacts = projectJavaFacts(ctx);
  const types = explainTypeRoles(javaFacts, builtinRegistry().ofKind('java.type-role'), name)
    .map((t) => ({ ...t, chain: chainRoleOf(javaFacts, t.fqn) }));
  if (types.length === 0) die(`no type named ${JSON.stringify(name)} in this pack`);
  if (asJson) print(JSON.stringify(types, null, 2));
  else printExplained(types);
}

export function run(ctx) {
  const { argv, flag, die } = ctx;
  const sub = argv[1];
  const target = argv.slice(2).find((a) => !a.startsWith('--'));
  const registry = builtinRegistry();
  if (sub === 'list') return list(registry, flag('json'));
  if (sub === 'show') return show(registry, target, flag('json'), die);
  if (sub === 'test') return test(registry, target, flag('json'));
  if (sub === 'explain') return explain(ctx, target, flag('json'));
  return die(USAGE);
}
