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
//
// TypeORM also writes columns no call names: the statement an operation sends
// (`sends`, the insert, update, soft delete or restore its query builder
// builds) sets the entity's date and version columns of its own accord. A
// column every statement the operation may send sets is written; one only
// some set (save inserts or updates, as the row it finds decides) MAY be.

import { isPlainObject, namesErrors, unknownKeysAt } from './ts_names.mjs';
import { ARG_ROLES, OPTION_ROLES, SENDS, emptyEffects, readArgument } from './typeorm_operation_read.mjs';

const STATEMENTS = Object.freeze(['select', 'insert', 'update', 'delete', 'upsert']);
const NAME = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const VALUE_KINDS = Object.freeze(['arr', 'obj', 'str', 'num', 'bool']);

function operationErrors(name, op) {
  const where = `params.operations.${name}`;
  if (!NAME.test(name) || !isPlainObject(op)) return [`params.operations has ${JSON.stringify(name)}, which is not an operation`];
  const errors = unknownKeysAt(op, ['statement', 'args', 'wholeRow', 'eager', 'eagerJoined', 'writesEntity', 'deleteDate', 'sends'], where);
  if (!STATEMENTS.includes(op.statement)) errors.push(`${where}.statement must be one of ${STATEMENTS.join(', ')}`);
  if (!Array.isArray(op.args) || !op.args.every((a) => ARG_ROLES.includes(a))) errors.push(`${where}.args must list parts from ${ARG_ROLES.join(', ')}`);
  for (const k of ['wholeRow', 'eager', 'eagerJoined', 'writesEntity', 'deleteDate']) if (op[k] !== undefined && typeof op[k] !== 'boolean') errors.push(`${where}.${k} must be true or false`);
  return [...errors, ...sendsErrors(op.sends, where)];
}

/** The statements an operation sends, each one TypeORM builds a write with. */
const sendsErrors = (sends, where) => (sends === undefined || (Array.isArray(sends) && sends.length > 0 && sends.every((s) => SENDS.includes(s)))
  ? [] : [`${where}.sends must list statements from ${SENDS.join(', ')}`]);

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

const EXPECT_KEYS = Object.freeze(['statement', 'reads', 'writes', 'mayReads', 'mayWrites', 'wholeRow', 'follows', 'relations', 'runtimeOnly', 'notRead', 'eagerJoined']);

function validateExample(example) {
  if (!isPlainObject(example)) return ['an example must be an object'];
  const errors = unknownKeysAt(example, ['operation', 'args', 'fields', 'relations', 'pk', 'deleteDate', 'auto', 'expect', 'why'], 'an example');
  if (typeof example.operation !== 'string') errors.push('an example needs the "operation" it calls');
  if (!Array.isArray(example.args) || !example.args.every((a) => typeof a === 'string')) errors.push('an example needs "args", each argument as TypeScript source');
  if (!Array.isArray(example.fields)) errors.push('an example needs "fields", the entity\'s column properties');
  if (!isPlainObject(example.expect)) return [...errors, `an example needs "expect": {${EXPECT_KEYS.join(', ')}}`];
  return [...errors, ...unknownKeysAt(example.expect, EXPECT_KEYS, 'an example\'s expect')];
}

/** What the operation itself adds once its arguments are read: the whole row, the eager relations, the delete date column. */
function finish(fx, op, entity) {
  const unknownArg = fx.optionsUnknown || fx.runtimeOnly.has('entity');
  if (op.wholeRow) rowOf(fx, op, entity, unknownArg);
  // A find joins the eager relations whole whatever its select names (FindOptionsUtils.joinEagerRelations adds their alias).
  if (op.eager && !fx.noEager) fx.eager = unknownArg || fx.eagerMay ? 'may' : 'exact';
  // count, exists and the aggregates go through setFindOptions in TypeORM 0.3, which joins the eager relations without selecting them; 0.2 does not.
  if (op.eagerJoined && !fx.noEager) fx.eagerJoined = true;
  if (op.deleteDate) writeDeleteDate(fx, entity);
  autoWrites(fx, op, entity);
  softDeleteFilter(fx, op, entity);
  return fx;
}

/**
 * A select on an entity with a delete date column filters out the rows it
 * marks (`deletedAt IS NULL`) unless the find asks for them with withDeleted
 * (0.3.28 QueryBuilder.createWhereExpression): the column is read. Options not
 * written out may ask, so it is then a candidate. `filtered` tells the joins
 * the find makes the same thing.
 */
function softDeleteFilter(fx, op, entity) {
  if (op.statement !== 'select' || fx.withDeleted === true) return;
  fx.filtered = fx.withDeleted === 'may' || fx.optionsUnknown ? 'may' : 'exact';
  if (entity.deleteDate) (fx.filtered === 'may' ? fx.mayReads : fx.reads).add(entity.deleteDate);
}

/**
 * How one statement sets a column of its own accord: null when it does not,
 * or when it is an insert and the column is left out of inserts (`insert:
 * false`, ColumnMetadata.isInsert); `sure` false when that option is not
 * written out.
 */
function setIn(c, send) {
  const how = Object.hasOwn(c.sets, send) ? c.sets[send] : null;
  if (!how || (send === 'insert' && c.insertable === false)) return null;
  return { send, how, sure: !(send === 'insert' && c.insertable === 'may') };
}

/**
 * The columns the statements an operation sends set on their own; a version
 * set to itself plus one is read as well. Since 0.2.34 an update adds one only
 * when the values it is handed do not name the column (0.3.28
 * UpdateQueryBuilder.createUpdateExpression), and before that always: values
 * that name it write it themselves, and whether the old one is read is the
 * installed version's, so the read is a candidate; so it is when the values
 * are not written out, which may name it.
 */
function autoWrites(fx, op, entity) {
  const sends = op.sends ?? [];
  for (const c of entity.auto ?? []) {
    const written = sends.map((s) => setIn(c, s)).filter(Boolean);
    // An entity save hands over is compared with the row first, so whether it names the column is the running program's.
    if (written.length > 0) autoColumn(fx, c, { written, sends, named: !op.writesEntity && fx.writes.has(c.property) });
  }
}

/** One column the statements set on their own: written unless the values name it, and a version read, a candidate where it may not be. */
function autoColumn(fx, c, { written, sends, named }) {
  if (!named) (written.length === sends.length && written.every((w) => w.sure) ? fx.autoWrites : fx.mayAutoWrites).add(c.property);
  const plusOne = written.filter((w) => w.how === 'increment');
  const sure = plusOne.length === sends.length && !named && !fx.runtimeOnly.has('values');
  if (plusOne.length > 0) (sure ? fx.autoReads : fx.mayAutoReads).add(c.property);
  fx.autoWhy.set(c.property, named ? NAMED_WHY(c.role) : `the ${c.role} column, which TypeORM sets itself in the ${written.map((w) => w.send).join(' and the ')} it sends`);
}

const NAMED_WHY = (role) => `the ${role} column the values name: TypeORM from 0.2.34 adds one to it only when they do not, and before that always, so whether the old value is read is the installed version's`;

/** The row an operation that returns one returns: whole with no select; with one, what it names and the primary key too (SelectQueryBuilder.buildEscapedEntityColumnSelects). */
function rowOf(fx, op, entity, unknownArg) {
  if (!fx.hasSelect) fx.wholeRow = unknownArg || op.writesEntity ? 'may' : 'exact';
  else for (const p of entity.pk) fx.reads.add(p);
}

/** softDelete and restore write the delete date column the entity declares; one that declares none is said. */
function writeDeleteDate(fx, entity) {
  if (entity.deleteDate) fx.writes.add(entity.deleteDate);
  else fx.unknownKeys.add('a delete date column');
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
/** An example's auto columns, `{property: {statement: how}}`. */
const exampleAuto = (auto) => Object.entries(auto ?? {}).map(([property, sets]) => ({ property, role: 'auto', sets, insertable: true }));
const both = (a, b) => new Set([...a, ...b]);
const wholeRowOf = (w) => (w === 'exact' ? true : w === 'may' ? 'may' : false);

function shapeOf(fx) {
  return {
    statement: fx.statement, reads: sorted(both(fx.reads, fx.autoReads)), writes: sorted(both(fx.writes, fx.autoWrites)),
    mayReads: sorted(both(fx.mayReads, fx.mayAutoReads)), mayWrites: sorted(both(fx.mayWrites, fx.mayAutoWrites)),
    wholeRow: wholeRowOf(fx.wholeRow), follows: sorted(fx.follows), relations: sorted(fx.relations), runtimeOnly: sorted(fx.runtimeOnly), notRead: sorted(fx.unknownKeys),
    eagerJoined: Boolean(fx.eagerJoined),
  };
}

function runExamples(entries, env) {
  if (!env || typeof env.tsValue !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => {
    const entity = { fields: ex.fields, relations: ex.relations ?? [], pk: ex.pk ?? (ex.fields.includes('id') ? ['id'] : []), deleteDate: ex.deleteDate ?? null, auto: exampleAuto(ex.auto) };
    const fx = entry.compiled.effectsOf(ex.operation, ex.args.map((a) => env.tsValue(a)), entity);
    const got = fx && shapeOf(fx);
    const want = { reads: [], writes: [], mayReads: [], mayWrites: [], wholeRow: false, follows: [], relations: [], runtimeOnly: [], notRead: [], eagerJoined: false, ...ex.expect };
    const norm = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]).sort()));
    return { example: ex, passed: Boolean(got) && norm(got) === norm(want), got };
  })]));
  return { results };
}

export const typeormOperation = Object.freeze({
  name: 'typeorm.operation',
  lane: 'ts',
  stage: 'ts-facts',
  // A property named as a literal key of the call is one the call reads or writes.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
