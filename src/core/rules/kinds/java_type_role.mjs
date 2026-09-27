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

/** A supertype's simple name, as the worker records it; it goes into no pattern, but the shape is still closed. */
const SIMPLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

const argAt = (args, i) => (Number.isInteger(i) && Array.isArray(args) && typeof args[i] === 'string' ? args[i] : null);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

/** A type record's direct supertypes, in the order the worker reads them. */
function supertypesOf(t) {
  const out = (t.implements ?? []).map((simple, i) => ({ simple, args: (t.implementsArgs ?? [])[i] ?? [] }));
  if (t.extends) out.push({ simple: t.extends, args: t.extendsArgs ?? [] });
  return out;
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const role = ROLES[params.role];
  if (!role) return [`params.role must be one of ${Object.keys(ROLES).join(', ')}, got ${JSON.stringify(params.role)}`];
  const errors = unknownKeys(params, ['role', 'supertypes', ...role.args]).map((k) => `params has a key "${k}" that a ${params.role} rule does not take`);
  if (!Array.isArray(params.supertypes) || params.supertypes.length === 0) errors.push('params.supertypes must be a non-empty list');
  else for (const s of params.supertypes) if (typeof s !== 'string' || !SIMPLE_NAME.test(s)) errors.push(`params.supertypes has ${JSON.stringify(s)}, which is not a simple Java type name`);
  for (const a of role.args) if (params[a] !== undefined && !(Number.isInteger(params[a]) && params[a] >= 0)) errors.push(`params.${a} must be a type argument position from 0`);
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

/** The rule, ready to read type records: a function from one type record to the records of the roles it plays. */
function compile(rule) {
  const { role, supertypes } = rule.params;
  const wanted = new Set(supertypes);
  return (t) => supertypesOf(t).filter((sup) => wanted.has(sup.simple)).map((sup) => ({ ...ROLES[role].record(t, sup, rule.params), rule: rule.id }));
}

/** The key a derived record is known by: the same the worker's records were sorted and de-duplicated by. */
const recordKey = (r) => (r.kind === 'mpMapper' ? `${r.kind}|${r.fqn}` : `${r.kind}|${r.fqn}|${r.base}`);

/**
 * The role records every `java.type-role` rule gives the type records among
 * `javaFacts`, one per key, in rule order. Two rules that write one key with
 * different contents are a conflict in the packs and are refused.
 *
 * @param {object[]} javaFacts  the assembled worker records
 * @param {{id:string, compiled:Function}[]} rules
 * @returns {object[]}
 */
export function deriveTypeRoles(javaFacts, rules) {
  const byKey = new Map();
  for (const t of javaFacts) {
    if (!t || t.kind !== 'type') continue;
    for (const r of rules.flatMap((entry) => entry.compiled(t))) {
      const k = recordKey(r);
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, r);
      else if (JSON.stringify({ ...prev, rule: null }) !== JSON.stringify({ ...r, rule: null })) {
        throw new Error(`the rules ${prev.rule} and ${r.rule} give ${t.fqn} two different ${r.kind} records`);
      }
    }
  }
  return [...byKey.values()];
}

/** What an example's type records give under one rule, in the example's own words. */
const asExpect = (r) => ({
  type: r.fqn, role: r.kind === 'mpMapper' ? 'mybatis-plus-mapper' : 'mybatis-plus-service',
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
  const results = new Map();
  for (const entry of entries) {
    results.set(entry.id, entry.rule.examples.map((ex, i) => {
      const types = facts.filter((r) => r.kind === 'type' && r.file === `${entry.id}/example${i}.java`);
      const got = types.flatMap((t) => entry.compiled(t)).map(asExpect);
      return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
    }));
  }
  return { results };
}

export const javaTypeRole = Object.freeze({
  name: 'java.type-role',
  stage: 'java-facts',
  // A role read from a supertype the source writes down.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
