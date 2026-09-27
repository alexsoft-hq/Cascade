// explain.mjs — why a Java type has a role, or has none: each supertype its declaration names, read against every java.type-role rule the way the rules read it.
//
// `cascade rules explain <type>` answers from this. Each supertype is told
// apart three ways: a rule reads it and gives a role; a rule names it but the
// file means another type by that name (tk.mybatis's BaseMapper, a project's
// own); or no rule names it, and then, when it is a type of the project, the
// MyBatis-Plus bridge follows it down to what it extends. The rules are read
// through the same functions the analysis runs (readingOf), so the
// explanation cannot say other than the analysis did.

import { javaNames, meaningOf, meaningSaid } from './java_names.mjs';
import { readingOf, supertypesOf } from './kinds/java_type_role.mjs';

/** What one rule concludes about one supertype of `t`, and why. */
function ruleVerdict(entry, t, sup, names) {
  const record = entry.compiled(t, names).find((r) => r.base === sup.simple) ?? null;
  const stands = readingOf(entry.rule).wanted.get(sup.simple);
  const why = record
    ? `reads ${sup.simple} as ${stands ?? `the name ${sup.simple}`}`
    : `${sup.simple} here is not ${stands}`;
  return { rule: entry.id, gives: record, why };
}

function supertypeReading(t, sup, rules, names) {
  const meaning = meaningOf(t, sup, names);
  const inProject = Boolean(meaning?.fqn && names.declared.has(meaning.fqn));
  const verdicts = rules.filter((e) => readingOf(e.rule).wanted.has(sup.simple)).map((e) => ruleVerdict(e, t, sup, names));
  return { supertype: sup.simple, args: sup.args, meaning: meaningSaid(meaning), inProject, rules: verdicts };
}

/**
 * Every type whose full name is `name`, or ends in `.name`, with each of its
 * supertypes read against every rule.
 *
 * @param {object[]} javaFacts  the project's Java worker records
 * @param {{id:string, rule:object, compiled:Function}[]} rules  the java.type-role rules
 * @param {string} name  a full or simple type name
 */
export function explainTypeRoles(javaFacts, rules, name) {
  const names = javaNames(javaFacts);
  return javaFacts
    .filter((r) => r?.kind === 'type' && (r.fqn === name || r.fqn.endsWith(`.${name}`)))
    .map((t) => ({ fqn: t.fqn, file: t.file ?? null, supertypes: supertypesOf(t).map((sup) => supertypeReading(t, sup, rules, names)) }));
}
