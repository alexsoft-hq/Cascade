// prisma_operation.mjs — the `prisma.operation` rule kind: what one Prisma client call reads and writes, from its operation and its argument object.
//
// `prisma.user.findMany({ where: { email }, select: { id: true } })` reads
// `User.email` to filter and `User.id` to return. This kind knows HOW an
// argument object is read: the keys of a filter are fields it reads (through
// the combinators the pack names, AND / OR / NOT), the keys of a projection are
// fields it returns when their value is true, the keys of a write are fields it
// writes. A key that is a named or default compound (`@@unique([a, b], name:
// "x")`, or `a_b` with no name) is read through the model's `compounds`, never
// by splitting the key on `_`. The rule pack says WHICH argument plays which
// part, WHAT each operation is, WHICH names are filter combinators, and how an
// interactive transaction's client parameter is found
// (src/core/rules/packs/prisma.json).
//
// What it does not follow, it says: a key that is a relation reaches another
// table this call does not name (`relations`), an argument that is not an
// object literal, spreads one, or has a computed key has keys only the running
// program knows (`runtimeOnly`), and a projection value that is not a literal
// `true`/`false` MAY read its field: that field goes to `mayReads`, not
// `reads`, and the key that made it uncertain is named in `runtimeOnly` too.
// Nothing here is dropped silently.

const ROLES = Object.freeze(['project', 'relations', 'filter', 'read', 'write', 'none']);
const STATEMENTS = Object.freeze(['select', 'insert', 'update', 'delete', 'upsert']);
const NAME = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));

function operationErrors(name, op) {
  if (!NAME.test(name) || !op || typeof op !== 'object') return [`params.operations has ${JSON.stringify(name)}, which is not an operation`];
  const errors = unknownKeys(op, ['statement', 'wholeRow']).map((k) => `params.operations.${name} has an unknown key "${k}"`);
  if (!STATEMENTS.includes(op.statement)) errors.push(`params.operations.${name}.statement must be one of ${STATEMENTS.join(', ')}`);
  if (op.wholeRow !== undefined && typeof op.wholeRow !== 'boolean') errors.push(`params.operations.${name}.wholeRow must be true or false`);
  return errors;
}

/** params.combinators: the names a filter's keys are read through (AND, OR, NOT), each a step into the same filter. */
function combinatorsErrors(combinators) {
  if (combinators === undefined) return [];
  if (Array.isArray(combinators) && combinators.every((c) => typeof c === 'string' && NAME.test(c))) return [];
  return ['params.combinators must be an array of names'];
}

/** params.transaction: the interactive-transaction call, and which of its function's parameters is the client. */
function transactionErrors(t) {
  if (t === undefined) return [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['params.transaction must be an object'];
  const errors = unknownKeys(t, ['method', 'clientParam']).map((k) => `params.transaction has an unknown key "${k}"`);
  if (!NAME.test(t.method ?? '')) errors.push('params.transaction.method must be a name as the source calls it');
  if (!Number.isInteger(t.clientParam) || t.clientParam < 0) errors.push('params.transaction.clientParam must be a whole number from 0');
  return errors;
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const errors = unknownKeys(params, ['arguments', 'operations', 'combinators', 'transaction']).map((k) => `params has an unknown key "${k}"`);
  for (const [arg, role] of Object.entries(params.arguments ?? {})) {
    if (!ROLES.includes(role)) errors.push(`params.arguments.${arg} must be one of ${ROLES.join(', ')}`);
  }
  errors.push(...combinatorsErrors(params.combinators), ...transactionErrors(params.transaction));
  if (!params.operations || typeof params.operations !== 'object' || Object.keys(params.operations).length === 0) return [...errors, 'params.operations must name at least one operation'];
  return [...errors, ...Object.entries(params.operations).flatMap(([name, op]) => operationErrors(name, op))];
}

function validateExample(example) {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['operation', 'args', 'fields', 'relations', 'compounds', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.operation !== 'string') errors.push('an example needs the "operation" it calls');
  if (typeof example.args !== 'string') errors.push('an example needs "args", the argument as TypeScript source');
  if (!Array.isArray(example.fields)) errors.push('an example needs "fields", the model\'s scalar fields');
  if (!example.expect || typeof example.expect !== 'object') errors.push('an example needs "expect": {reads, writes, wholeRow, relations, runtimeOnly, mayReads}');
  return errors;
}

/** A model as this kind reads one: which of its keys are scalar fields, which relations, and its named compound keys. */
function fieldIndex(model) {
  const scalars = new Set(model.fields.filter((f) => !f.relation).map((f) => f.name));
  const relations = new Set(model.fields.filter((f) => f.relation).map((f) => f.name));
  return { scalars, relations, compounds: model.compounds ?? {} };
}

/** The scalar fields a key names: the field itself, or the fields a compound key (named, or the default `a_b`) joins. */
function fieldsOfKey(key, idx) {
  if (idx.scalars.has(key)) return [key];
  return Object.hasOwn(idx.compounds, key) ? idx.compounds[key] : [];
}

/** Every key of a value that is an object literal, or an array of them; the rest is only known at run time. */
function keysOf(value, out, role) {
  if (!value || value.k === 'bool' || value.k === 'none') return;
  if (value.k === 'arr') { for (const v of value.v) keysOf(v, out, role); if (value.spread) out.runtimeOnly.add(role); return; }
  if (value.k !== 'obj') { out.runtimeOnly.add(role); return; }
  if (value.spread || value.computed) out.runtimeOnly.add(role);
  for (const [key, v] of Object.entries(value.v)) out.pairs.push([key, v]);
}

/** A key whose role is project: `true` reads it, `false` reads nothing, anything else MAY read it at run time. */
function applyProjectField(argKey, key, v, fields, fx) {
  if (v.k === 'bool' && v.v === true) { for (const f of fields) fx.reads.add(f); return; }
  if (v.k === 'bool' && v.v === false) return;
  for (const f of fields) fx.mayReads.add(f);
  fx.runtimeOnly.add(`${argKey}.${key}`);
}

/** One key of an argument object, read by the role its argument plays. */
function applyKeyRole(role, key, v, idx, fx, argKey) {
  if (role === 'filter' && fx.combinators.includes(key)) { readArgument('filter', v, idx, fx, argKey); return; }
  if (idx.relations.has(key)) { fx.relations.add(key); return; }
  const fields = fieldsOfKey(key, idx);
  if (fields.length === 0) { fx.unknownKeys.add(key); return; }
  if (role === 'project') { applyProjectField(argKey, key, v, fields, fx); return; }
  for (const f of fields) (role === 'write' ? fx.writes : fx.reads).add(f);
}

/** `argKey` is the top-level argument key this value was given under (`select`, `where`, ...), carried down for naming a dynamic projection. */
function readArgument(role, value, idx, fx, argKey) {
  const found = { pairs: [], runtimeOnly: fx.runtimeOnly };
  if (role === 'read' && value && value.k === 'arr' && value.v.every((v) => v.k === 'str')) {
    for (const v of value.v) for (const f of fieldsOfKey(v.v, idx)) fx.reads.add(f);
    return;
  }
  keysOf(value, found, role);
  for (const [key, v] of found.pairs) applyKeyRole(role, key, v, idx, fx, argKey);
}

/** Every top-level key the argument gives, read by the role the pack names for it. */
function readGiven(given, roles, idx, fx) {
  for (const [key, value] of Object.entries(given)) {
    const role = roles[key];
    if (role === undefined) { fx.unknownKeys.add(key); continue; }
    if (role !== 'none') readArgument(role, value, idx, fx, key);
  }
}

/** Whether the argument itself is known well enough to say "every scalar field" for it: no spread, no computed key, or no argument at all. */
function argIsFullyKnown(arg) {
  return !arg || arg.k === 'none' || (arg.k === 'obj' && !arg.spread && !arg.computed);
}

function fxOf(op, ruleId, combinators) {
  return {
    statement: op.statement, reads: new Set(), writes: new Set(), mayReads: new Set(), relations: new Set(),
    runtimeOnly: new Set(), unknownKeys: new Set(), wholeRow: false, rule: ruleId, combinators,
  };
}

/**
 * The rule, ready to read one call: `effectsOf(operation, args, model)` gives
 * the statement kind, the fields read, maybe read, and written, whether the
 * whole row is returned, and what could not be followed; null for an operation
 * the rule does not name.
 */
function compile(rule) {
  const { operations, arguments: roles = {}, combinators = [], transaction = null } = rule.params;
  const effectsOf = (operation, args, model) => {
    const op = operations[operation];
    if (!op) return null;
    const idx = fieldIndex(model);
    const fx = fxOf(op, rule.id, combinators);
    const arg = args[0];
    if (arg && arg.k !== 'obj' && arg.k !== 'none') fx.runtimeOnly.add('arguments');
    if (arg && (arg.spread || arg.computed)) fx.runtimeOnly.add('arguments');
    const given = arg && arg.k === 'obj' ? arg.v : {};
    readGiven(given, roles, idx, fx);
    const hasProjectKey = Object.keys(given).some((k) => roles[k] === 'project');
    fx.wholeRow = op.wholeRow === true && argIsFullyKnown(arg) && !hasProjectKey;
    return fx;
  };
  return { effectsOf, operations: Object.keys(operations), transaction };
}

const sorted = (set) => [...set].sort();

/** The comparable shape of an effectsOf result, or of an example's "expect" filled with the same defaults. */
function effectsShape(fx) {
  return {
    reads: sorted(fx.reads), writes: sorted(fx.writes), wholeRow: fx.wholeRow,
    relations: sorted(fx.relations), runtimeOnly: sorted(fx.runtimeOnly), mayReads: sorted(fx.mayReads),
  };
}

function runOneExample(entry, ex, env) {
  const model = {
    fields: [...ex.fields.map((name) => ({ name, relation: false })), ...(ex.relations ?? []).map((name) => ({ name, relation: true }))],
    compounds: ex.compounds ?? {},
  };
  const fx = entry.compiled.effectsOf(ex.operation, [env.tsValue(ex.args)], model);
  const got = fx && effectsShape(fx);
  const want = { reads: [], writes: [], wholeRow: false, relations: [], runtimeOnly: [], mayReads: [], ...ex.expect };
  const asFx = { ...want, reads: new Set(want.reads), writes: new Set(want.writes), relations: new Set(want.relations), runtimeOnly: new Set(want.runtimeOnly), mayReads: new Set(want.mayReads) };
  return { example: ex, passed: JSON.stringify(got) === JSON.stringify(effectsShape(asFx)), got };
}

function runExamples(entries, env) {
  if (!env || typeof env.tsValue !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => runOneExample(entry, ex, env))]));
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
