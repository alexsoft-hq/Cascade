// java_type_role.mjs — the `java.type-role` rule kind: which role a Java type plays, read from the supertypes its own declaration names.
//
// `interface UserMapper extends BaseMapper<User>` makes UserMapper a MyBatis-Plus
// mapper of User, and the only thing that says so is the name in its own
// extends or implements clause. This kind knows HOW such a clause is read: the
// simple name of each direct supertype, in the order the declaration writes
// them (implements first, as javac lists an interface's extends there, then
// extends), and which type argument of it is the entity or the mapper. The rule
// packs say WHICH supertypes give WHICH role (src/core/rules/packs/).
//
// A type that reaches such a supertype through a type of the project's own
// (`UserMapper extends BaseMapperX<User>`, `BaseMapperX<T> extends BaseMapper<T>`)
// is not matched here: the MyBatis-Plus bridge follows each clause down to a type
// that plays a role and binds the type arguments on the way
// (src/adapters/mp_bridge.mjs, roleOf). This kind only says which types are the
// roots of those chains.
//
// The records it writes are the ones the bridge has always read (`mpMapper`,
// `mpService`), so moving this knowledge out of the Java worker changed where it
// lives and nothing it concludes.
//
// A library can put its own base type in between. mybatis-plus-join's
// `MPJBaseMapper<T>` extends `BaseMapper<T>`, and a project whose mappers extend
// `MPJBaseMapper` never writes `BaseMapper` anywhere; the bridge cannot follow
// the chain into a jar. A rule for such a type names it in `params.library`: its
// full name, the declaration the rule relies on, and where that is written. The
// source shows only that the project extends the library's type, not what that
// type extends, so such a rule is graded below EXACT and its records carry the
// grade. And only a supertype the file really means as that type is read as it:
// imported by name, or through its package.

import { GRADE_RANK } from '../../graph.mjs';

/** A supertype's simple name, as the worker records it; it goes into no pattern, but the shape is still closed. */
const SIMPLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const QUALIFIED_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The roles this kind can give, and the record each one writes. A new role is
 * new code, because a new record is something a bridge has to read.
 */
const ROLES = Object.freeze({
  'mybatis-plus-mapper': Object.freeze({ args: ['entityArg'], record: (t, sup, p) => ({
    kind: 'mpMapper', fqn: t.fqn, base: sup.simple, entityTypeSimple: argAt(sup.args, p.entityArg), file: t.file ?? null,
  }) }),
  'mybatis-plus-service': Object.freeze({ args: ['entityArg', 'mapperArg'], record: (t, sup, p) => ({
    kind: 'mpService', fqn: t.fqn, base: sup.simple, mapperTypeSimple: argAt(sup.args, p.mapperArg),
    entityTypeSimple: argAt(sup.args, p.entityArg), file: t.file ?? null,
  }) }),
});

/** The role a record of each kind stands for, in the words a rule and its examples use. */
const ROLE_OF_KIND = Object.freeze({ mpMapper: 'mybatis-plus-mapper', mpService: 'mybatis-plus-service' });

const argAt = (args, i) => (Number.isInteger(i) && Array.isArray(args) && typeof args[i] === 'string' ? args[i] : null);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const simpleOf = (fqn) => fqn.slice(fqn.lastIndexOf('.') + 1);
const packageOf = (fqn) => fqn.slice(0, fqn.lastIndexOf('.'));

/** A type record's direct supertypes, in the order the worker reads them. */
function supertypesOf(t) {
  const out = (t.implements ?? []).map((simple, i) => ({ simple, args: (t.implementsArgs ?? [])[i] ?? [] }));
  if (t.extends) out.push({ simple: t.extends, args: t.extendsArgs ?? [] });
  return out;
}

function validateParams(params, rule = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const role = ROLES[params.role];
  if (!role) return [`params.role must be one of ${Object.keys(ROLES).join(', ')}, got ${JSON.stringify(params.role)}`];
  const errors = unknownKeys(params, ['role', 'supertypes', 'library', ...role.args]).map((k) => `params has a key "${k}" that a ${params.role} rule does not take`);
  for (const a of role.args) if (params[a] !== undefined && !(Number.isInteger(params[a]) && params[a] >= 0)) errors.push(`params.${a} must be a type argument position from 0`);
  return [...errors, ...supertypeErrors(params.supertypes), ...libraryErrors(params, rule.grade ?? 'EXACT')];
}

function supertypeErrors(supertypes) {
  if (!Array.isArray(supertypes) || supertypes.length === 0) return ['params.supertypes must be a non-empty list'];
  return supertypes.filter((s) => typeof s !== 'string' || !SIMPLE_NAME.test(s))
    .map((s) => `params.supertypes has ${JSON.stringify(s)}, which is not a simple Java type name`);
}

/**
 * A rule that relies on a library's own declaration names it and where it is
 * written, and is graded as a claim about that library; a rule graded below
 * EXACT for any other reason has nothing to say why.
 */
function libraryErrors(params, grade) {
  const lib = params.library;
  if (lib === undefined) return grade === 'EXACT' ? [] : [`gives ${grade}, which only a rule relying on a library's declaration does: name it in params.library`];
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) return ['params.library must be an object'];
  const errors = unknownKeys(lib, ['type', 'declares', 'source']).map((k) => `params.library has an unknown key "${k}"`);
  if (typeof lib.type !== 'string' || !QUALIFIED_NAME.test(lib.type)) errors.push('params.library.type must be the full name of the library\'s type');
  else if (params.supertypes?.length !== 1 || params.supertypes[0] !== simpleOf(lib.type)) errors.push(`params.supertypes must be the one simple name of params.library.type, ${simpleOf(lib.type)}`);
  if (!isText(lib.declares)) errors.push('params.library.declares must say what the library\'s type is declared as');
  if (!isText(lib.source)) errors.push('params.library.source must say where that declaration is written');
  if (grade === 'EXACT') errors.push('a rule relying on a library\'s declaration is graded below EXACT: the source shows the project extends the library\'s type, not what that type extends');
  return errors;
}

function expectErrors(expect) {
  if (!Array.isArray(expect)) return ['an example needs "expect", the list of roles its source should give (empty for none)'];
  return expect.flatMap((e, i) => (e && typeof e.type === 'string' && typeof e.role === 'string'
    && unknownKeys(e, ['type', 'role', 'entity', 'mapper']).length === 0 ? [] : [`expect[${i}] must be {type, role} with an optional entity and mapper`]));
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a Java "source"');
  return [...errors, ...expectErrors(example.expect)];
}

/**
 * The rule, ready to read type records: a function from one type record, and
 * the imports of its file, to the records of the roles it plays.
 */
function compile(rule) {
  const { role, supertypes, library } = rule.params;
  const wanted = new Set(supertypes);
  const means = library ? (t, sup, imports) => meansType(t, sup.simple, library.type, imports) : () => true;
  const claim = library ? { grade: rule.grade, library: library.type } : {};
  return (t, imports = []) => supertypesOf(t)
    .filter((sup) => wanted.has(sup.simple) && means(t, sup, imports))
    .map((sup) => ({ ...ROLES[role].record(t, sup, rule.params), ...claim, rule: rule.id }));
}

/**
 * Whether the file of `t` means `fqn` by the simple name it writes: as Java
 * reads it, an import of that one name decides, else an import of its whole
 * package, or the type sitting in that package itself.
 */
function meansType(t, simple, fqn, imports) {
  const named = imports.find((i) => i.simple === simple);
  if (named) return named.fqn === fqn;
  return t.package === packageOf(fqn) || imports.some((i) => i.simple === '*' && i.fqn === packageOf(fqn));
}

/** Each file's import records, which is where Java reads a simple name's meaning. */
function importsByFile(records) {
  const byFile = new Map();
  for (const r of records) {
    if (!r || r.kind !== 'import') continue;
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  return byFile;
}

/** The key a derived record is known by, within one type: the worker wrote one mapper record per type, and one service record per base. */
const recordKey = (r) => (r.kind === 'mpMapper' ? r.kind : `${r.kind}|${r.base}`);
/** What a record answers, apart from which rule gave it, how sure that rule is, and (for a mapper) which base it was read from. */
const ASIDE = Object.freeze(['rule', 'grade', 'library']);
const answerOf = (r) => JSON.stringify(Object.keys(r)
  .filter((k) => !ASIDE.includes(k) && !(k === 'base' && r.kind === 'mpMapper'))
  .sort().map((k) => [k, r[k]]));
const rankOf = (r) => GRADE_RANK[r.grade ?? 'EXACT'];

/**
 * The role records every `java.type-role` rule gives the type records among
 * `javaFacts`, in type order and, within a type, in rule order.
 *
 * Each type record is one input, read on its own. Two modules may declare a
 * class of the same name, and each is given its roles as the worker once gave
 * them; which of the two a bridge reads is the bridge's question. What is
 * refused is two rules answering one type two ways: one mapper record with
 * different contents, or the roles of a mapper and a service at once, which a
 * reader would otherwise settle by the order it happens to look them up in.
 *
 * @param {object[]} javaFacts  the assembled worker records
 * @param {{id:string, compiled:Function}[]} rules
 * @returns {object[]}
 */
export function deriveTypeRoles(javaFacts, rules) {
  const imports = importsByFile(javaFacts);
  return javaFacts.filter((t) => t && t.kind === 'type').flatMap((t) => rolesOfType(t, rules, imports.get(t.file) ?? []));
}

/**
 * One type's role records. Two rules that give it the same answer give one
 * record, as sure as the surer of them: a mapper that extends both `BaseMapper`
 * and a library's base of it is a mapper the source shows.
 */
function rolesOfType(t, rules, imports) {
  const byKey = new Map();
  for (const r of rules.flatMap((entry) => entry.compiled(t, imports))) {
    const prev = byKey.get(recordKey(r));
    if (!prev || (answerOf(prev) === answerOf(r) && rankOf(r) > rankOf(prev))) byKey.set(recordKey(r), r);
    else if (answerOf(prev) !== answerOf(r)) throw new Error(`the rules ${prev.rule} and ${r.rule} give ${t.fqn} two different ${r.kind} records`);
  }
  const records = [...byKey.values()];
  const roles = [...new Set(records.map((r) => ROLE_OF_KIND[r.kind]))];
  if (roles.length > 1) throw new Error(`the rules ${records.map((r) => r.rule).join(' and ')} give ${t.fqn} two roles, ${roles.join(' and ')}`);
  return records;
}

/** What an example's type records give under one rule, in the example's own words. */
const asExpect = (r) => ({
  type: r.fqn, role: ROLE_OF_KIND[r.kind],
  ...(r.entityTypeSimple ? { entity: r.entityTypeSimple } : {}), ...(r.mapperTypeSimple ? { mapper: r.mapperTypeSimple } : {}),
});
const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

/**
 * Every example of every rule of this kind, run through the real Java worker
 * once: `env.javaFacts(files)` parses the sources and returns the records.
 * Without it (no JDK) the examples are NOT RUN, which is reported as such and
 * is not a pass.
 */
function runExamples(entries, env) {
  const files = entries.flatMap((entry) => entry.rule.examples.map((ex, i) => ({ name: `${entry.id}/example${i}.java`, text: ex.source })));
  const facts = env && typeof env.javaFacts === 'function' ? env.javaFacts(files) : null;
  if (facts === null) return { notRun: 'no Java worker: a JDK is needed to parse the examples (see docs/setup/java-lane.md)' };
  const imports = importsByFile(facts);
  return { results: new Map(entries.map((entry) => [entry.id, exampleResults(entry, facts, imports)])) };
}

/** One rule's examples against the records the worker read from them. */
function exampleResults(entry, facts, imports) {
  return entry.rule.examples.map((ex, i) => {
    const types = facts.filter((r) => r.kind === 'type' && r.file === `${entry.id}/example${i}.java`);
    const got = types.flatMap((t) => entry.compiled(t, imports.get(t.file) ?? [])).map(asExpect);
    return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
  });
}

export const javaTypeRole = Object.freeze({
  name: 'java.type-role',
  stage: 'java-facts',
  // A role read from a supertype the source writes down; a rule relying on a
  // library's declaration is graded below it (see libraryErrors).
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
