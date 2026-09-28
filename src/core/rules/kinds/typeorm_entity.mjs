// typeorm_entity.mjs — the `typeorm.entity` rule kind: which classes are TypeORM entities, and the tables, columns and join tables they map, named as the application's naming strategy names them.
//
// `@Entity('user') class UserEntity { @Column() email }` maps the table `user`
// with the column `email`. This kind knows HOW TypeORM reads an entity (its
// decorators, the classes it extends, which side of a relation owns the join
// column, what each part of a name is built from) and HOW the DataSource
// options are found and read. The rule pack says WHICH decorators mean what,
// WHERE an application writes its options, and WHAT each naming strategy does
// (src/core/rules/packs/typeorm.json).
//
// A name the source writes is EXACT. A name a strategy derives is EXACT only
// when the options name the strategy (or name none, which is the default) and
// every TypeORM version spells it the same; else HEURISTIC, with why.

import { isPlainObject, namesErrors, unknownKeysAt } from './ts_names.mjs';
import { namingErrors, compileNaming } from './typeorm_naming.mjs';
import { optionsErrors, readNaming, declaredNaming } from './typeorm_options.mjs';
import { entityClasses } from './typeorm_mapping.mjs';
import { buildModel, weakestOfEntity } from './typeorm_model.mjs';
import { exampleProject } from './ts_example_project.mjs';

const PARAM_KEYS = Object.freeze(['packages', 'entity', 'notRead', 'columns', 'relations', 'joinColumn', 'joinTable', 'eagerKey', 'options', 'strategies', 'defaultStrategy', 'snakeCase', 'joinTableNameLimit']);
const COLUMN_ROLES = Object.freeze(['column', 'primary', 'delete-date']);
const RELATION_KINDS = Object.freeze(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many']);

function mapErrors(map, where, allowed) {
  if (!isPlainObject(map) || Object.keys(map).length === 0) return [`${where} must map decorator names to one of ${allowed.join(', ')}`];
  return Object.entries(map).filter(([, v]) => !allowed.includes(v)).map(([k, v]) => `${where}.${k} is ${JSON.stringify(v)}, not one of ${allowed.join(', ')}`);
}

function validateParams(params) {
  if (!isPlainObject(params)) return ['params must be an object'];
  const errors = unknownKeysAt(params, PARAM_KEYS, 'params');
  errors.push(...namesErrors(params.packages, 'params.packages'), ...namesErrors(params.entity, 'params.entity'), ...namesErrors(params.notRead, 'params.notRead', { allowEmpty: true }));
  errors.push(...mapErrors(params.columns, 'params.columns', COLUMN_ROLES), ...mapErrors(params.relations, 'params.relations', RELATION_KINDS));
  for (const k of ['joinColumn', 'joinTable', 'eagerKey']) if (typeof params[k] !== 'string' || params[k] === '') errors.push(`params.${k} must be a name as the source writes it`);
  return [...errors, ...optionsErrors(params.options), ...namingErrors(params)];
}

function validateExample(example) {
  if (!isPlainObject(example)) return ['an example must be an object'];
  const errors = unknownKeysAt(example, ['source', 'expect', 'why'], 'an example');
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a TypeScript "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the tables its source maps'];
  example.expect.forEach((e, i) => {
    const ok = isPlainObject(e) && typeof e.table === 'string' && (e.entity === null || typeof e.entity === 'string')
      && ['EXACT', 'HEURISTIC'].includes(e.grade) && Array.isArray(e.columns) && unknownKeysAt(e, ['table', 'entity', 'grade', 'columns'], '').length === 0;
    if (!ok) errors.push(`expect[${i}] must be {table, entity (null for a join table), grade (EXACT or HEURISTIC), columns}`);
  });
  return errors;
}

/**
 * The rule, ready to read a project: `readModel(project, {declared})` gives the
 * entity model (typeorm_model.mjs) with the decision it was built under: the
 * naming strategy, entityPrefix and schema the profile declares
 * (`{namingStrategy, entityPrefix, schema}`, null for one it does not), else
 * what the options say.
 */
function compile(rule) {
  const naming = compileNaming(rule.params);
  const cfg = rule.params;
  return {
    rule: rule.id,
    readModel: (project, { declared = null } = {}) => {
      const decision = declared ? declaredNaming(project, cfg.options, naming, declared) : readNaming(project, cfg.options, naming);
      return { ...buildModel(project, entityClasses(project, cfg), decision, naming), rule: rule.id };
    },
  };
}

const tableKeyOf = (schema, table) => (schema ? `${schema}.${table}` : table);

/** What an example's source maps, in the shape its "expect" is written in. */
function tablesOfExample(model) {
  const out = [...model.entities.values()].map((e) => ({
    table: tableKeyOf(e.schema, e.table), entity: e.name, grade: weakestOfEntity(e), columns: e.columns.map((c) => c.column).sort(),
  }));
  for (const j of model.junctions) {
    out.push({ table: tableKeyOf(j.schema, j.table), entity: null, grade: [j.grade, ...j.ownerColumns.map((c) => c.grade), ...j.inverseColumns.map((c) => c.grade)].includes('HEURISTIC') ? 'HEURISTIC' : 'EXACT', columns: [...j.ownerColumns, ...j.inverseColumns].map((c) => c.column).sort() });
  }
  return out;
}

const canonical = (list) => JSON.stringify(list.map((e) => JSON.stringify({ ...e, columns: [...e.columns].sort() }, ['table', 'entity', 'grade', 'columns'])).sort());

function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
    const project = exampleProject(env.tsFacts(`${entry.id}/example${i}.ts`, ex.source));
    const got = tablesOfExample(entry.compiled.readModel(project));
    return { example: ex, passed: canonical(got) === canonical(ex.expect), got };
  })]));
  return { results };
}

export const typeormEntity = Object.freeze({
  name: 'typeorm.entity',
  lane: 'ts',
  stage: 'ts-facts',
  // A name the decorator writes is a fact; a derived one is graded where it is used.
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
