// ts_type_role.mjs — the `ts.type-role` rule kind: which role a TypeScript type plays, read from the package and the name it is imported by.
//
// `import { PrismaClient } from '@prisma/client'` names Prisma's client, and a
// field typed with it, or with a project class that extends it, is a client of
// the database. This kind knows HOW a TypeScript name is matched: by the module
// it is imported from and the name that module exports, never by the local name
// alone (an import can rename it). The rule packs say WHICH (module, export)
// plays WHICH role (src/core/rules/packs/prisma.json).
//
// A project class that extends such a type plays the role too; the bridge
// follows `extends` inside the project (src/adapters/ts/prisma.mjs). A package
// type that extends one, `PrismaService` of nestjs-prisma, is a library's own
// declaration: a rule for it names it in `params.library` and is graded below
// EXACT, as `java.type-role` does for mybatis-plus-join.

const ROLES = Object.freeze(['prisma-client']);
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isText = (v) => typeof v === 'string' && v.trim() !== '';

function libraryErrors(lib, grade) {
  if (lib === undefined) return grade === 'EXACT' ? [] : [`gives ${grade}, which only a rule relying on a library's declaration does: name it in params.library`];
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) return ['params.library must be an object'];
  const errors = unknownKeys(lib, ['declares', 'source']).map((k) => `params.library has an unknown key "${k}"`);
  if (!isText(lib.declares)) errors.push('params.library.declares must say what the library\'s type is declared as');
  if (!isText(lib.source)) errors.push('params.library.source must say where that declaration is written');
  if (grade === 'EXACT') errors.push('a rule relying on a library\'s declaration is graded below EXACT');
  return errors;
}

function validateParams(params, rule = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['role', 'module', 'export', 'library']).map((k) => `params has an unknown key "${k}"`);
  if (!ROLES.includes(params.role)) errors.push(`params.role must be one of ${ROLES.join(', ')}, got ${JSON.stringify(params.role)}`);
  if (!isText(params.module)) errors.push('params.module must be the package the type is imported from');
  if (!isText(params.export)) errors.push('params.export must be the name that package exports');
  return [...errors, ...libraryErrors(params.library, rule.grade ?? 'EXACT')];
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['source', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a TypeScript "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the classes its source makes play the role (empty for none)'];
  example.expect.forEach((e, i) => {
    if (!e || typeof e.class !== 'string' || typeof e.role !== 'string' || unknownKeys(e, ['class', 'role']).length > 0) errors.push(`expect[${i}] must be {class, role}`);
  });
  return errors;
}

/**
 * The rule, ready to read a name's meaning: `means(meaning)` says whether a
 * name imported from a package (`{external: module, name}`) is the rule's type,
 * and `role`, `grade` and `library` are what it gives.
 */
function compile(rule) {
  const { role, module, library } = rule.params;
  return {
    role, rule: rule.id, grade: rule.grade ?? 'EXACT', library: library ? `${module}.${rule.params.export}` : null,
    means: (meaning) => Boolean(meaning && meaning.external === module && meaning.name === rule.params.export),
  };
}

/** Within one example file: a class whose `extends` is imported as the rule's type plays its role. */
function rolesOfExample(compiled, records) {
  const imported = new Map();
  for (const r of records) {
    if (r.kind !== 'import') continue;
    for (const n of r.names) imported.set(n.local, { external: r.source, name: n.imported });
  }
  return records.filter((r) => r.kind === 'class' && r.extends && compiled.means(imported.get(r.extends)))
    .map((r) => ({ class: r.name, role: compiled.role }));
}

const canonical = (list) => JSON.stringify([...list].map((e) => JSON.stringify(e, Object.keys(e).sort())).sort());

function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
    const got = rolesOfExample(entry.compiled, env.tsFacts(`${entry.id}/example${i}.ts`, ex.source));
    return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
  })]));
  return { results };
}

export const tsTypeRole = Object.freeze({
  name: 'ts.type-role',
  stage: 'ts-facts',
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
