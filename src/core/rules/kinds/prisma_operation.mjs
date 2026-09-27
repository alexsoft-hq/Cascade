// prisma_operation.mjs — the `prisma.operation` rule kind: what one Prisma client call reads and writes, from its operation and its argument object.
//
// `prisma.user.findMany({ where: { email }, select: { id: true } })` reads
// `User.email` to filter and `User.id` to return. This kind knows HOW an
// argument object is read: the keys of a filter are fields it reads (through
// AND / OR / NOT), the keys of a projection are fields it returns when their
// value is true, the keys of a write are fields it writes. The rule pack says
// WHICH argument plays which part and WHAT each operation is
// (src/core/rules/packs/prisma.json).
//
// What it does not follow, it says: a key that is a relation reaches another
// table this call does not name (`relations`), and an argument that is not an
// object literal, or spreads one, has keys only the running program knows
// (`runtimeOnly`). Neither is dropped silently.

const ROLES = Object.freeze(['project', 'relations', 'filter', 'read', 'write', 'none']);
const STATEMENTS = Object.freeze(['select', 'insert', 'update', 'delete', 'upsert']);
const LOGICAL = Object.freeze(['AND', 'OR', 'NOT']);
const NAME = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

function operationErrors(name, op) {
  if (!NAME.test(name) || !op || typeof op !== 'object') return [`params.operations has ${JSON.stringify(name)}, which is not an operation`];
  const errors = unknownKeys(op, ['statement', 'wholeRow']).map((k) => `params.operations.${name} has an unknown key "${k}"`);
  if (!STATEMENTS.includes(op.statement)) errors.push(`params.operations.${name}.statement must be one of ${STATEMENTS.join(', ')}`);
  if (op.wholeRow !== undefined && typeof op.wholeRow !== 'boolean') errors.push(`params.operations.${name}.wholeRow must be true or false`);
  return errors;
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['arguments', 'operations']).map((k) => `params has an unknown key "${k}"`);
  for (const [arg, role] of Object.entries(params.arguments ?? {})) {
    if (!ROLES.includes(role)) errors.push(`params.arguments.${arg} must be one of ${ROLES.join(', ')}`);
  }
  if (!params.operations || typeof params.operations !== 'object' || Object.keys(params.operations).length === 0) return [...errors, 'params.operations must name at least one operation'];
  return [...errors, ...Object.entries(params.operations).flatMap(([name, op]) => operationErrors(name, op))];
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['operation', 'args', 'fields', 'relations', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.operation !== 'string') errors.push('an example needs the "operation" it calls');
  if (typeof example.args !== 'string') errors.push('an example needs "args", the argument as TypeScript source');
  if (!Array.isArray(example.fields)) errors.push('an example needs "fields", the model\'s scalar fields');
  if (!example.expect || typeof example.expect !== 'object') errors.push('an example needs "expect": {reads, writes, wholeRow, relations, runtimeOnly}');
  return errors;
}

/** A model as this kind reads one: which of its keys are scalar fields, and which relations. */
function fieldIndex(model) {
  const scalars = new Set(model.fields.filter((f) => !f.relation).map((f) => f.name));
  const relations = new Set(model.fields.filter((f) => f.relation).map((f) => f.name));
  return { scalars, relations };
}

/** The scalar fields a filter key names: the field itself, or the fields a compound unique key joins with `_`. */
function fieldsOfKey(key, idx) {
  if (idx.scalars.has(key)) return [key];
  const parts = key.split('_');
  return parts.length > 1 && parts.every((p) => idx.scalars.has(p)) ? parts : [];
}

/** Every key of a value that is an object literal, or an array of them; the rest is only known at run time. */
function keysOf(value, out, role) {
  if (!value || value.k === 'bool' || value.k === 'none') return;
  if (value.k === 'arr') { for (const v of value.v) keysOf(v, out, role); if (value.spread) out.runtimeOnly.add(role); return; }
  if (value.k !== 'obj') { out.runtimeOnly.add(role); return; }
  if (value.spread || value.computed) out.runtimeOnly.add(role);
  for (const [key, v] of Object.entries(value.v)) out.pairs.push([key, v]);
}

function readArgument(role, value, idx, fx) {
  const found = { pairs: [], runtimeOnly: fx.runtimeOnly };
  if (role === 'read' && value && value.k === 'arr' && value.v.every((v) => v.k === 'str')) {
    for (const v of value.v) for (const f of fieldsOfKey(v.v, idx)) fx.reads.add(f);
    return;
  }
  keysOf(value, found, role);
  for (const [key, v] of found.pairs) {
    if (role === 'filter' && LOGICAL.includes(key)) { readArgument('filter', v, idx, fx); continue; }
    if (idx.relations.has(key)) { fx.relations.add(key); continue; }
    const fields = fieldsOfKey(key, idx);
    if (fields.length === 0) { fx.unknownKeys.add(key); continue; }
    if (role === 'project' && !(v.k === 'bool' && v.v === true)) continue;
    for (const f of fields) (role === 'write' ? fx.writes : fx.reads).add(f);
  }
}

/**
 * The rule, ready to read one call: `effectsOf(operation, args, model)` gives
 * the statement kind, the fields read and written, whether the whole row is
 * returned, and what could not be followed; null for an operation the rule
 * does not name.
 */
function compile(rule) {
  const { operations, arguments: roles = {} } = rule.params;
  const effectsOf = (operation, args, model) => {
    const op = operations[operation];
    if (!op) return null;
    const idx = fieldIndex(model);
    const fx = { statement: op.statement, reads: new Set(), writes: new Set(), relations: new Set(), runtimeOnly: new Set(), unknownKeys: new Set(), wholeRow: false, rule: rule.id };
    const arg = args[0];
    if (arg && arg.k !== 'obj' && arg.k !== 'none') fx.runtimeOnly.add('arguments');
    const given = arg && arg.k === 'obj' ? arg.v : {};
    if (arg && arg.spread) fx.runtimeOnly.add('arguments');
    for (const [key, value] of Object.entries(given)) {
      const role = roles[key];
      if (role === undefined) { fx.unknownKeys.add(key); continue; }
      if (role !== 'none') readArgument(role, value, idx, fx);
    }
    fx.wholeRow = op.wholeRow === true && given.select === undefined && !fx.runtimeOnly.has('arguments');
    return fx;
  };
  return { effectsOf, operations: Object.keys(operations) };
}

const sorted = (set) => [...set].sort();

function runExamples(entries, env) {
  if (!env || typeof env.tsValue !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => {
    const model = { fields: [...ex.fields.map((name) => ({ name, relation: false })), ...(ex.relations ?? []).map((name) => ({ name, relation: true }))] };
    const fx = entry.compiled.effectsOf(ex.operation, [env.tsValue(ex.args)], model);
    const got = fx && {
      reads: sorted(fx.reads), writes: sorted(fx.writes), wholeRow: fx.wholeRow, relations: sorted(fx.relations), runtimeOnly: sorted(fx.runtimeOnly),
    };
    const want = { reads: [], writes: [], wholeRow: false, relations: [], runtimeOnly: [], ...ex.expect };
    return { example: ex, passed: JSON.stringify(got) === JSON.stringify({ reads: sorted(want.reads), writes: sorted(want.writes), wholeRow: want.wholeRow, relations: sorted(want.relations), runtimeOnly: sorted(want.runtimeOnly) }), got };
  })]));
  return { results };
}

export const prismaOperation = Object.freeze({
  name: 'prisma.operation',
  stage: 'ts-facts',
  // A field named as a literal key of the call is one the call reads or writes.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
