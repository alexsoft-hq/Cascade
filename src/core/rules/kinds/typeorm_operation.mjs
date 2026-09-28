// typeorm_operation.mjs — the `typeorm.operation` rule kind: what one TypeORM Repository or EntityManager operation reads and writes, from its name and its arguments.
//
// `this.users.findOne({ where: { email }, select: { id: true } })` reads
// User.email to filter and User.id to return. This kind knows HOW each part an
// argument plays is read (typeorm_operation_read.mjs), and how an operation's
// own facts combine with them: a find with no select returns the whole row
// and loads the relations marked eager, softDelete writes the delete date
// column. The rule pack says WHICH operations there are, WHAT statement each
// sends and WHICH part each of its arguments plays, and how a find's options
// are told from its conditions in TypeORM 0.2 (src/core/rules/packs/typeorm.json).
//
// An argument not written out leaves what it names to the running program: it
// is said (`runtimeOnly`), and where the operation returns or writes the row
// whole or in part, every column MAY be read or written: a candidate set that
// holds the truth, graded SOUND_SET where it is drawn.

import { isPlainObject, namesErrors, unknownKeysAt } from './ts_names.mjs';
import { ARG_ROLES, OPTION_ROLES, emptyEffects, readArgument } from './typeorm_operation_read.mjs';

const STATEMENTS = Object.freeze(['select', 'insert', 'update', 'delete', 'upsert']);
const NAME = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const VALUE_KINDS = Object.freeze(['arr', 'obj', 'str', 'num', 'bool']);

function operationErrors(name, op) {
  const where = `params.operations.${name}`;
  if (!NAME.test(name) || !isPlainObject(op)) return [`params.operations has ${JSON.stringify(name)}, which is not an operation`];
  const errors = unknownKeysAt(op, ['statement', 'args', 'wholeRow', 'eager', 'writesEntity', 'deleteDate'], where);
  if (!STATEMENTS.includes(op.statement)) errors.push(`${where}.statement must be one of ${STATEMENTS.join(', ')}`);
  if (!Array.isArray(op.args) || !op.args.every((a) => ARG_ROLES.includes(a))) errors.push(`${where}.args must list parts from ${ARG_ROLES.join(', ')}`);
  for (const k of ['wholeRow', 'eager', 'writesEntity', 'deleteDate']) if (op[k] !== undefined && typeof op[k] !== 'boolean') errors.push(`${where}.${k} must be true or false`);
  return errors;
}

function validateParams(params) {
  if (!isPlainObject(params)) return ['params must be an object'];
  const errors = unknownKeysAt(params, ['operations', 'noSql', 'raw', 'findOptions', 'legacyFindOptions'], 'params');
  if (!isPlainObject(params.operations) || Object.keys(params.operations).length === 0) errors.push('params.operations must name at least one operation');
  else errors.push(...Object.entries(params.operations).flatMap(([n, op]) => operationErrors(n, op)));
  errors.push(...namesErrors(params.noSql, 'params.noSql'), ...namesErrors(params.raw, 'params.raw'));
  if (!isPlainObject(params.findOptions) || Object.values(params.findOptions).some((r) => !OPTION_ROLES.includes(r))) errors.push(`params.findOptions must map each option key to one of ${OPTION_ROLES.join(', ')}`);
  if (!isPlainObject(params.legacyFindOptions) || Object.values(params.legacyFindOptions).some((l) => !Array.isArray(l) || !l.every((k) => VALUE_KINDS.includes(k)))) {
    errors.push(`params.legacyFindOptions must map each option key to the kinds of value (${VALUE_KINDS.join(', ')}) that make an object find options`);
  }
  return errors;
}

const EXPECT_KEYS = Object.freeze(['statement', 'reads', 'writes', 'mayReads', 'mayWrites', 'wholeRow', 'follows', 'relations', 'runtimeOnly', 'notRead']);

function validateExample(example) {
  if (!isPlainObject(example)) return ['an example must be an object'];
  const errors = unknownKeysAt(example, ['operation', 'args', 'fields', 'relations', 'pk', 'deleteDate', 'expect', 'why'], 'an example');
  if (typeof example.operation !== 'string') errors.push('an example needs the "operation" it calls');
  if (!Array.isArray(example.args) || !example.args.every((a) => typeof a === 'string')) errors.push('an example needs "args", each argument as TypeScript source');
  if (!Array.isArray(example.fields)) errors.push('an example needs "fields", the entity\'s column properties');
  if (!isPlainObject(example.expect)) return [...errors, `an example needs "expect": {${EXPECT_KEYS.join(', ')}}`];
  return [...errors, ...unknownKeysAt(example.expect, EXPECT_KEYS, 'an example\'s expect')];
}

/** What the operation itself adds once its arguments are read: the whole row, the eager relations, the delete date column. */
function finish(fx, op, entity) {
  const unknownArg = fx.optionsUnknown || fx.runtimeOnly.has('entity');
  if (op.wholeRow && !fx.hasSelect) fx.wholeRow = unknownArg || op.writesEntity ? 'may' : 'exact';
  // An entity query that selects some columns selects the primary key too (SelectQueryBuilder.buildEscapedEntityColumnSelects).
  if (op.wholeRow && fx.hasSelect) for (const p of entity.pk) fx.reads.add(p);
  if (op.eager && fx.wholeRow && !fx.noEager) fx.eager = fx.wholeRow === 'may' || fx.eagerMay ? 'may' : 'exact';
  if (op.deleteDate) {
    if (entity.deleteDate) fx.writes.add(entity.deleteDate);
    else fx.unknownKeys.add('a delete date column');
  }
  return fx;
}

/**
 * The rule, ready to read one call: `effectsOf(operation, args, entity)`, the
 * entity as `{fields, relations, pk, deleteDate}` in property names, gives the
 * statement and what it reads and writes; null for an operation the rule does
 * not name. `kindOf(name)` says whether a name is an operation, no SQL at all,
 * or raw SQL this rule does not read.
 */
function compile(rule) {
  const params = rule.params;
  const effectsOf = (operation, args, entity) => {
    const op = Object.hasOwn(params.operations, operation) ? params.operations[operation] : null;
    if (!op) return null;
    const fx = emptyEffects(op, rule.id);
    op.args.forEach((role, i) => readArgument(role, args[i], entity, fx, params, op));
    // An argument past the parts the pack names is said, never dropped.
    for (let i = op.args.length; i < args.length; i += 1) fx.unknownKeys.add(`argument ${i + 1}`);
    return finish(fx, op, entity);
  };
  const kindOf = (name) => (Object.hasOwn(params.operations, name) ? 'operation' : params.noSql.includes(name) ? 'no-sql' : params.raw.includes(name) ? 'raw' : null);
  return { rule: rule.id, effectsOf, kindOf };
}

const sorted = (set) => [...set].sort();
const wholeRowOf = (w) => (w === 'exact' ? true : w === 'may' ? 'may' : false);

function shapeOf(fx) {
  return {
    statement: fx.statement, reads: sorted(fx.reads), writes: sorted(fx.writes), mayReads: sorted(fx.mayReads), mayWrites: sorted(fx.mayWrites),
    wholeRow: wholeRowOf(fx.wholeRow), follows: sorted(fx.follows), relations: sorted(fx.relations), runtimeOnly: sorted(fx.runtimeOnly), notRead: sorted(fx.unknownKeys),
  };
}

function runExamples(entries, env) {
  if (!env || typeof env.tsValue !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => {
    const entity = { fields: ex.fields, relations: ex.relations ?? [], pk: ex.pk ?? (ex.fields.includes('id') ? ['id'] : []), deleteDate: ex.deleteDate ?? null };
    const fx = entry.compiled.effectsOf(ex.operation, ex.args.map((a) => env.tsValue(a)), entity);
    const got = fx && shapeOf(fx);
    const want = { reads: [], writes: [], mayReads: [], mayWrites: [], wholeRow: false, follows: [], relations: [], runtimeOnly: [], notRead: [], ...ex.expect };
    const norm = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]).sort()));
    return { example: ex, passed: Boolean(got) && norm(got) === norm(want), got };
  })]));
  return { results };
}

export const typeormOperation = Object.freeze({
  name: 'typeorm.operation',
  stage: 'ts-facts',
  // A property named as a literal key of the call is one the call reads or writes.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
