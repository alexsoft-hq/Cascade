// prisma_operation.mjs — the `prisma.operation` rule kind: what one Prisma client call reads and writes, from its operation and its argument object.
//
// `prisma.user.findMany({ where: { email }, select: { id: true } })` reads
// `User.email` to filter and `User.id` to return. This kind knows HOW an
// argument object is read (prisma_args.mjs): the keys of a filter are fields it
// reads (through the combinators the pack names, AND / OR / NOT), the keys of a
// projection are fields it returns when their value is true, the keys of a
// write are fields it writes, a compound key (`@@unique([a, b], name: "x")`, or
// `a_b` with no name) is read through the model's `compounds`, never by
// splitting the key on `_`, and a relation is followed into the model it
// reaches. The rule pack says WHICH argument plays which part, WHAT each
// operation is, WHICH names are filter combinators and relation filters (and
// which of them, given null, only check the link), what `_count` and each
// nested write do (and which literal values leave a nested write idle), how an
// interactive transaction's client parameter is found, which calls make a
// client of a client (`$extends`), and where an extension declares the fields
// it computes (src/core/rules/packs/prisma.json).
//
// What it does not follow, it says: a relation into a model it was not handed
// (`relations`), an argument that is not an object literal, spreads one, or has
// a computed key (`runtimeOnly`), and a projection value that is not a literal
// `true`/`false`, which MAY read its field: that field goes to `mayReads`, not
// `reads`, and the key that made it uncertain is named in `runtimeOnly` too.
// Nothing here is dropped silently.

import { readCall } from './prisma_args.mjs';

const ROLES = Object.freeze(['project', 'relations', 'filter', 'read', 'write', 'none']);
const STATEMENTS = Object.freeze(['select', 'insert', 'update', 'delete', 'upsert']);
const ROWS = Object.freeze(['write', 'delete', 'none']);
// `replace` clears what is linked, then sets what the value lists (`set`).
const LINKS = Object.freeze(['set', 'clear', 'replace']);
// An `idle` entry: the literal value that makes a nested write do less (the whole
// value, or one `argument` of it), the relations it does so on, and what it drops:
// every edge, or only the writes (the rows are still looked up).
const IDLE_LITERALS = Object.freeze(['false', '[]']);
const IDLE_ON = Object.freeze(['any', 'one-to-one', 'many-to-many']);
const IDLE_DROPS = Object.freeze(['all', 'writes']);
// The kinds of relation a nested write's `lookup` list names, as seen from the
// model it is written on: the list side of a one-to-many, its to-one side (the
// key in this model), a one-to-one with the key here or in the other model, and
// an implicit many-to-many.
const RELATION_KINDS = Object.freeze(['one-to-many-list', 'one-to-many-one', 'one-to-one-here', 'one-to-one-there', 'many-to-many']);
const NAME = /^[$_A-Za-z][$_A-Za-z0-9]*$/;
const unknownKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k));
const isObject = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const namesOrErrors = (x, at) => (x === undefined || (Array.isArray(x) && x.every((c) => typeof c === 'string' && NAME.test(c))) ? [] : [`${at} must be an array of names`]);

function operationErrors(name, op) {
  if (!NAME.test(name) || !op || typeof op !== 'object') return [`params.operations has ${JSON.stringify(name)}, which is not an operation`];
  const errors = unknownKeys(op, ['statement', 'wholeRow']).map((k) => `params.operations.${name} has an unknown key "${k}"`);
  if (!STATEMENTS.includes(op.statement)) errors.push(`params.operations.${name}.statement must be one of ${STATEMENTS.join(', ')}`);
  if (op.wholeRow !== undefined && typeof op.wholeRow !== 'boolean') errors.push(`params.operations.${name}.wholeRow must be true or false`);
  return errors;
}

/** An argument map (`{ where: "filter" }`): each value a role this kind knows. */
function rolesErrors(roles, at) {
  if (!isObject(roles)) return [`${at} must be an object`];
  return Object.entries(roles).filter(([, role]) => !ROLES.includes(role)).map(([arg]) => `${at}.${arg} must be one of ${ROLES.join(', ')}`);
}

/** params.transaction: the interactive-transaction call, and which of its function's parameters is the client. */
function transactionErrors(t) {
  if (t === undefined) return [];
  if (!isObject(t)) return ['params.transaction must be an object'];
  const errors = unknownKeys(t, ['method', 'clientParam']).map((k) => `params.transaction has an unknown key "${k}"`);
  if (!NAME.test(t.method ?? '')) errors.push('params.transaction.method must be a name as the source calls it');
  if (!Number.isInteger(t.clientParam) || t.clientParam < 0) errors.push('params.transaction.clientParam must be a whole number from 0');
  return errors;
}

/** params.relationCount: the key that counts a relation's rows in a projection, and the roles of its own arguments. */
function relationCountErrors(c) {
  if (c === undefined) return [];
  if (!isObject(c)) return ['params.relationCount must be an object'];
  const errors = unknownKeys(c, ['key', 'arguments']).map((k) => `params.relationCount has an unknown key "${k}"`);
  if (!NAME.test(c.key ?? '')) errors.push('params.relationCount.key must be a name');
  return [...errors, ...rolesErrors(c.arguments, 'params.relationCount.arguments')];
}

/** One `idle` entry: `{value, argument?, on?, drops?}`. */
function idleEntryErrors(at, e) {
  if (!isObject(e)) return [`${at} must be an object`];
  const errors = unknownKeys(e, ['value', 'argument', 'on', 'drops']).map((k) => `${at} has an unknown key "${k}"`);
  if (!IDLE_LITERALS.includes(e.value)) errors.push(`${at}.value must be one of ${IDLE_LITERALS.join(', ')}`);
  if (e.argument !== undefined && !NAME.test(e.argument)) errors.push(`${at}.argument must be a name`);
  if (e.on !== undefined && !IDLE_ON.includes(e.on)) errors.push(`${at}.on must be one of ${IDLE_ON.join(', ')}`);
  if (e.drops !== undefined && !IDLE_DROPS.includes(e.drops)) errors.push(`${at}.drops must be one of ${IDLE_DROPS.join(', ')}`);
  return errors;
}

/** A nested write's `idle` list: the literal values that make it do nothing, or write nothing, and on which relations; the first that applies wins. */
function idleErrors(at, idle) {
  if (idle === undefined) return [];
  if (!Array.isArray(idle)) return [`${at}.idle must be a list`];
  return idle.flatMap((e, i) => idleEntryErrors(`${at}.idle[${i}]`, e));
}

// Whether the rows a write hangs its nested writes from are made by it, or were there before.
const ROW_STATES = Object.freeze(['new', 'existing']);
const kindsOrErrors = (x, at) => (x === undefined || (Array.isArray(x) && x.every((k) => RELATION_KINDS.includes(k))) ? [] : [`${at} must list kinds from ${RELATION_KINDS.join(', ')}`]);

/** A nested write's `lookup`: the kinds of relation on which it first finds the rows its value names (`named`), and the rows linked to the one it hangs from (`linked`); and whether the rows it writes nested writes under are new (`nests`). */
function lookupErrors(at, w) {
  const errors = w.nests === undefined || ROW_STATES.includes(w.nests) ? [] : [`${at}.nests must be one of ${ROW_STATES.join(', ')}`];
  if (w.lookup === undefined) return errors;
  if (!isObject(w.lookup)) return [...errors, `${at}.lookup must be an object`];
  const keys = unknownKeys(w.lookup, ['named', 'linked']).map((k) => `${at}.lookup has an unknown key "${k}"`);
  return [...errors, ...keys, ...kindsOrErrors(w.lookup.named, `${at}.lookup.named`), ...kindsOrErrors(w.lookup.linked, `${at}.lookup.linked`)];
}

/** params.argumentRows: the arguments whose rows are new or were there before, for the nested writes under them. */
function argumentRowsErrors(x) {
  if (x === undefined) return [];
  if (!isObject(x) || !Object.values(x).every((v) => ROW_STATES.includes(v))) return [`params.argumentRows must map an argument to one of ${ROW_STATES.join(', ')}`];
  return [];
}

/** One nested write: what it does to the related rows, whether it sets or clears the link, how its value is read, which literal values leave it idle, and where it looks rows up first. */
function nestedWriteErrors(name, w) {
  const at = `params.nestedWrites.${name}`;
  if (!NAME.test(name) || !isObject(w)) return [`params.nestedWrites has ${JSON.stringify(name)}, which is not a nested write`];
  const errors = [...unknownKeys(w, ['rows', 'link', 'value', 'arguments', 'idle', 'lookup', 'nests']).map((k) => `${at} has an unknown key "${k}"`), ...idleErrors(at, w.idle), ...lookupErrors(at, w)];
  if (!ROWS.includes(w.rows)) errors.push(`${at}.rows must be one of ${ROWS.join(', ')}`);
  if (w.link !== undefined && !LINKS.includes(w.link)) errors.push(`${at}.link must be one of ${LINKS.join(', ')}`);
  if (w.value !== undefined && !ROLES.includes(w.value)) errors.push(`${at}.value must be one of ${ROLES.join(', ')}`);
  if (w.value === undefined && w.arguments === undefined) errors.push(`${at} must say how its value is read: value, arguments, or both`);
  return [...errors, ...(w.arguments === undefined ? [] : rolesErrors(w.arguments, `${at}.arguments`))];
}

/** params.extensions.define: the call that makes an extension to hand `$extends` later, by the package, export and method it is. */
function defineErrors(d) {
  if (d === undefined) return [];
  if (!isObject(d)) return ['params.extensions.define must be an object'];
  const errors = unknownKeys(d, ['module', 'export', 'method']).map((k) => `params.extensions.define has an unknown key "${k}"`);
  if (typeof d.module !== 'string' || d.module === '') errors.push('params.extensions.define.module must name a package');
  if (!NAME.test(d.export ?? '') || !NAME.test(d.method ?? '')) errors.push('params.extensions.define.export and .method must be names');
  return errors;
}

/** params.extensions.computed: the component that declares computed fields, the key of what each needs, and the key that means every model. */
function computedErrors(c) {
  if (c === undefined) return [];
  if (!isObject(c)) return ['params.extensions.computed must be an object'];
  const errors = unknownKeys(c, ['component', 'needs', 'allModels']).map((k) => `params.extensions.computed has an unknown key "${k}"`);
  if (!['component', 'needs', 'allModels'].every((k) => NAME.test(c[k] ?? ''))) errors.push('params.extensions.computed.component, .needs and .allModels must be names');
  return errors;
}

/** params.extensions: the client methods that make a client of a client, the extension components that may change what a call sends, the define call, and computed fields. */
function extensionsErrors(x) {
  if (x === undefined) return [];
  if (!isObject(x)) return ['params.extensions must be an object'];
  const errors = unknownKeys(x, ['methods', 'rewriting', 'define', 'computed']).map((k) => `params.extensions has an unknown key "${k}"`);
  return [...errors, ...namesOrErrors(x.methods ?? null, 'params.extensions.methods'), ...namesOrErrors(x.rewriting ?? null, 'params.extensions.rewriting'), ...defineErrors(x.define), ...computedErrors(x.computed)];
}

function relationParamErrors(params) {
  const nested = params.nestedWrites === undefined ? [] : isObject(params.nestedWrites)
    ? Object.entries(params.nestedWrites).flatMap(([name, w]) => nestedWriteErrors(name, w)) : ['params.nestedWrites must be an object'];
  const filters = [...namesOrErrors(params.relationFilters, 'params.relationFilters'), ...namesOrErrors(params.relationNullFilters, 'params.relationNullFilters')];
  return [...filters, ...relationCountErrors(params.relationCount), ...nested, ...extensionsErrors(params.extensions), ...argumentRowsErrors(params.argumentRows)];
}

function validateParams(params) {
  if (!isObject(params)) return ['params must be an object'];
  const known = ['arguments', 'argumentRows', 'operations', 'combinators', 'transaction', 'relationFilters', 'relationNullFilters', 'relationCount', 'nestedWrites', 'extensions'];
  const errors = unknownKeys(params, known).map((k) => `params has an unknown key "${k}"`);
  errors.push(...rolesErrors(params.arguments ?? {}, 'params.arguments'), ...namesOrErrors(params.combinators, 'params.combinators'));
  errors.push(...transactionErrors(params.transaction), ...relationParamErrors(params));
  if (!isObject(params.operations) || Object.keys(params.operations).length === 0) return [...errors, 'params.operations must name at least one operation'];
  return [...errors, ...Object.entries(params.operations).flatMap(([name, op]) => operationErrors(name, op))];
}

function validateExample(example) {
  if (!isObject(example)) return ['an example must be an object'];
  const errors = unknownKeys(example, ['operation', 'model', 'args', 'fields', 'relations', 'compounds', 'models', 'computed', 'expect', 'why']).map((k) => `an example has an unknown key "${k}"`);
  if (typeof example.operation !== 'string') errors.push('an example needs the "operation" it calls');
  if (typeof example.args !== 'string') errors.push('an example needs "args", the argument as TypeScript source');
  if (!Array.isArray(example.fields)) errors.push('an example needs "fields", the model\'s scalar fields');
  if (!isObject(example.expect)) errors.push('an example needs "expect": {reads, writes, wholeRow, relations, runtimeOnly, mayReads, follow}');
  return [...errors, ...exampleMapErrors(example)];
}

/** An example's optional maps: the other models it names, and the fields its model's client computes. */
function exampleMapErrors(example) {
  const errors = [];
  if (example.models !== undefined && !isObject(example.models)) errors.push('an example\'s "models" must map a model name to its fields and relations');
  if (example.computed !== undefined && !isObject(example.computed)) errors.push('an example\'s "computed" must map a computed field of its model to the fields it needs');
  return errors;
}

/** How the rule reads an argument, with every param it leaves out read as the empty one. */
function readingOf(p) {
  return {
    roles: p.arguments ?? {}, combinators: p.combinators ?? [], relationFilters: p.relationFilters ?? [], relationNullFilters: p.relationNullFilters ?? [],
    relationCount: p.relationCount ? { key: p.relationCount.key, arguments: p.relationCount.arguments ?? {} } : null, nestedWrites: p.nestedWrites ?? {},
    argumentRows: p.argumentRows ?? {},
  };
}

/** Which calls make a client of a client, and where an extension declares computed fields; null when the rule names none. */
function extensionsOf(p) {
  const x = p.extensions;
  return x ? { methods: x.methods ?? [], rewriting: x.rewriting ?? [], define: x.define ?? null, computed: x.computed ?? null } : null;
}

/**
 * The rule, ready to read one call: `effectsOf(operation, args, model, models,
 * computed)` gives the statement kind, the fields read, maybe read, and
 * written, whether the whole row is returned, the relations it follows
 * (`follow`, when the schema's `models` are handed in) and what could not be
 * followed; null for an operation the rule does not name. `computed` is the
 * client's computed fields by model name, each with the fields it needs.
 */
function compile(rule) {
  const p = rule.params;
  const base = readingOf(p);
  const effectsOf = (operation, args, model, models = null, computed = null) => {
    const op = Object.hasOwn(p.operations, operation) ? p.operations[operation] : null;
    return op ? readCall(op, args, model, { ...base, models, computed }, rule.id) : null;
  };
  return { effectsOf, operations: Object.keys(p.operations), transaction: p.transaction ?? null, extensions: extensionsOf(p) };
}

const sorted = (xs) => [...(xs ?? [])].sort();

/** The comparable shape of one model's effects (a call's own, or a relation's), from effectsOf or from an example's "expect". */
function shapeOf(x) {
  return {
    reads: sorted(x.reads), writes: sorted(x.writes), wholeRow: x.wholeRow === true, relations: sorted(x.relations), mayReads: sorted(x.mayReads),
    follow: (x.follow ?? []).map((f) => ({
      relation: f.relation, target: f.target, how: f.how, access: f.access ?? 'read', op: f.op ?? null, link: f.link ?? null, may: f.may === true,
      nullCheck: f.nullCheck === true, idle: f.idle ?? null, ...shapeOf(f.fx ?? f),
    })),
  };
}

/** A model an example describes: its scalar fields, and its relations, a list of names (not followed) or a map to the model each reaches (`"Post[]"` for a list). */
function exampleModel(name, spec) {
  const rel = spec.relations ?? [];
  const relations = Array.isArray(rel)
    ? rel.map((r) => ({ name: r, relation: true }))
    : Object.entries(rel).map(([r, t]) => ({ name: r, relation: true, type: String(t).replace(/\[\]$/, ''), list: String(t).endsWith('[]') }));
  return { name, fields: [...(spec.fields ?? []).map((f) => ({ name: f, relation: false })), ...relations], compounds: spec.compounds ?? {} };
}

function runOneExample(entry, ex, env) {
  const model = exampleModel(ex.model ?? 'Model', ex);
  const models = ex.models ? new Map([[model.name, model], ...Object.entries(ex.models).map(([n, spec]) => [n, exampleModel(n, spec)])]) : null;
  const computed = ex.computed ? new Map([[model.name, { open: false, fields: ex.computed }]]) : null;
  const fx = entry.compiled.effectsOf(ex.operation, [env.tsValue(ex.args)], model, models, computed);
  const got = fx && { ...shapeOf(fx), runtimeOnly: sorted(fx.runtimeOnly) };
  const want = { ...shapeOf(ex.expect), runtimeOnly: sorted(ex.expect.runtimeOnly) };
  return { example: ex, passed: JSON.stringify(got) === JSON.stringify(want), got };
}

function runExamples(entries, env) {
  if (!env || typeof env.tsValue !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex) => runOneExample(entry, ex, env))]));
  return { results };
}

export const prismaOperation = Object.freeze({
  name: 'prisma.operation',
  lane: 'ts',
  stage: 'ts-facts',
  // A field named as a literal key of the call is one the call reads or writes.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
