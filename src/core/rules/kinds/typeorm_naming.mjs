// typeorm_naming.mjs — the names a TypeORM naming strategy gives a table, a column, a join column and a join table.
//
// WHAT GOES INTO EACH NAME is TypeORM's, and is here: its metadata builders
// hand a strategy the class name and the name the decorator gave (table), the
// property and the given name (column), the relation and the referenced
// property (join column), the owner table, the property and the inverse table
// (join table), and the table and the referenced column (join table column).
// WHAT A STRATEGY DOES WITH IT is the rule pack's: for each of those five, one
// of three transforms (none, snake, camel), and snakeCase as each TypeORM
// version wrote it (src/core/rules/packs/typeorm.json).
//
// A name the TypeORM versions spell differently is not known from the source:
// the installed version decides it. Such a name is returned with `varies`, the
// versions that disagree, and the caller grades it HEURISTIC. The name given
// is the newest version's.

import { isPlainObject, unknownKeysAt } from './ts_names.mjs';

export const TRANSFORMS = Object.freeze(['none', 'snake', 'camel']);
export const SLOTS = Object.freeze(['table', 'column', 'joinColumn', 'joinTable', 'joinTableColumn']);
const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * TypeORM's camelCase (src/util/StringUtils.ts): a first capital is lowered,
 * and a character after a space, a hyphen or an underscore is raised with that
 * separator dropped. The same in every version this pack reads, called as the
 * naming strategies call it (firstCapital false).
 */
export const camelCase = (s) => s.replace(/^([A-Z])|[\s-_](\w)/g, (m, p1, p2) => (p2 ? p2.toUpperCase() : p1.toLowerCase()));

function snakeVariantErrors(v, i) {
  const where = `params.snakeCase[${i}]`;
  if (!isPlainObject(v)) return [`${where} must be {versions, steps}`];
  const errors = unknownKeysAt(v, ['versions', 'steps'], where);
  if (typeof v.versions !== 'string' || v.versions === '') errors.push(`${where}.versions must say which versions wrote it`);
  if (!Array.isArray(v.steps) || v.steps.length === 0) return [...errors, `${where}.steps must list [pattern, replacement] pairs`];
  v.steps.forEach((st, j) => {
    if (!Array.isArray(st) || st.length !== 2 || !st.every((x) => typeof x === 'string')) { errors.push(`${where}.steps[${j}] must be [pattern, replacement]`); return; }
    try { void new RegExp(st[0], 'g'); } catch (e) { errors.push(`${where}.steps[${j}] is not a pattern this engine can compile: ${e.message}`); }
  });
  return errors;
}

function strategyErrors(s, i) {
  const where = `params.strategies[${i}]`;
  if (!isPlainObject(s)) return [`${where} must be an object`];
  const errors = unknownKeysAt(s, ['name', 'module', 'export', ...SLOTS], where);
  if (typeof s.name !== 'string' || !NAME.test(s.name)) errors.push(`${where}.name must be a lower-case name`);
  if (typeof s.module !== 'string' || typeof s.export !== 'string') errors.push(`${where} needs the module the strategy class is imported from and the name it exports`);
  for (const slot of SLOTS) if (!TRANSFORMS.includes(s[slot])) errors.push(`${where}.${slot} must be one of ${TRANSFORMS.join(', ')}`);
  return errors;
}

/** Everything wrong with the naming half of a typeorm.entity rule's params. */
export function namingErrors(params) {
  const errors = [];
  if (!Array.isArray(params.snakeCase) || params.snakeCase.length === 0) errors.push('params.snakeCase must list how each TypeORM version writes snakeCase');
  else errors.push(...params.snakeCase.flatMap(snakeVariantErrors));
  if (!Array.isArray(params.strategies) || params.strategies.length === 0) return [...errors, 'params.strategies must list at least one naming strategy'];
  errors.push(...params.strategies.flatMap(strategyErrors));
  if (!params.strategies.some((s) => s && s.name === params.defaultStrategy)) errors.push('params.defaultStrategy must name one of params.strategies');
  if (!Number.isInteger(params.joinTableNameLimit) || params.joinTableNameLimit < 1) errors.push('params.joinTableNameLimit must be a whole number of characters');
  return errors;
}

/** One transform over one input: `{name, varies}`, `varies` the versions that disagree, or null. */
function transformer(snakeVariants) {
  const variants = snakeVariants.map((v) => {
    const steps = v.steps.map(([m, r]) => [new RegExp(m, 'g'), r]);
    return { versions: v.versions, fn: (s) => steps.reduce((acc, [re, r]) => acc.replace(re, r), s).toLowerCase() };
  });
  return (transform, text) => {
    if (transform === 'none') return { name: text, varies: null };
    if (transform === 'camel') return { name: camelCase(text), varies: null };
    const names = variants.map((v) => v.fn(text));
    const newest = names[names.length - 1];
    const differ = variants.map((v, i) => ({ versions: v.versions, name: names[i] })).filter((v) => v.name !== newest);
    return { name: newest, varies: differ.length > 0 ? differ.map((v) => `TypeORM ${v.versions} spells it ${v.name}`).join('; ') : null };
  };
}

/**
 * The names a strategy gives, as TypeORM's metadata builders ask for them.
 * Each returns `{name, given, varies}`: `given` when the source wrote the name,
 * so no strategy was asked.
 */
export function compileNaming(params) {
  const apply = transformer(params.snakeCase);
  const derive = (s, slot, text) => ({ ...apply(s[slot], text), given: false });
  return {
    strategies: params.strategies,
    defaultStrategy: params.strategies.find((s) => s.name === params.defaultStrategy),
    joinTableNameLimit: params.joinTableNameLimit,
    table: (s, className, given) => (typeof given === 'string' && given !== '' ? { name: given, given: true, varies: null } : derive(s, 'table', className)),
    column: (s, property, given) => (typeof given === 'string' && given !== '' ? { name: given, given: true, varies: null } : derive(s, 'column', property)),
    joinColumn: (s, relation, referencedProperty) => derive(s, 'joinColumn', `${relation}_${referencedProperty}`),
    joinTable: (s, ownerTable, propertyPath, inverseTable) => derive(s, 'joinTable', `${ownerTable}_${propertyPath.replace(/\./g, '_')}_${inverseTable}`),
    joinTableColumn: (s, table, referencedColumn) => derive(s, 'joinTableColumn', `${table}_${referencedColumn}`),
  };
}
