// prisma_args.mjs — how one Prisma call's argument is read: each key by the part its argument plays, and each relation into the model it reaches.
//
// The rule (prisma_operation.mjs, params from src/core/rules/packs/prisma.json)
// says WHICH argument plays which part and WHICH names are combinators,
// relation filters, the relation count and nested writes; this reads a call's
// argument with it. A key of a filter is a field it reads, a key of a
// projection a field it returns when its value is true, a key of a write a
// field it writes, and a compound key (`@@unique([a, b])`) the fields it joins.
//
// A RELATION IS FOLLOWED into the model it reaches when the caller hands in the
// schema's models: `include: { posts: true }` returns every column of Post,
// `select: { posts: { select: { title: true } } }` returns Post.title, a relation
// filter (`some`, `every`, `none`, `is`, `isNot`, or a to-one filter written
// straight) reads what it filters on, `_count: { select: { posts: true } }`
// counts Post rows, and a nested write (`data: { posts: { create: [...] } }`)
// writes Post, each as an entry of `follow` with its own effects, which the
// bridge turns into the related table's edges and the columns the join reads.
// A relation value only the running program knows (`include: { posts: flag }`,
// `data: { account }`) is followed as one that MAY happen (`may`), and the key
// is named in `runtimeOnly`.
//
// A relation filtered on null (`author: null`, or a key the pack names in
// `relationNullFilters` given null, `{ is: null }`) only asks whether the link
// is there: the entry says so (`nullCheck`), and the bridge decides which side
// that reads. A nested write whose value (or one argument of it) is a literal
// the pack's `idle` list names (`create: []`, `createMany: { data: [] }`,
// `disconnect: false` on a one-to-one, `delete: []`, which still looks the
// rows up) is not followed when it does nothing on every relation, else is
// marked with the entries that apply (`idle`), for the bridge to decide on the
// relation it is; a `replace` link (`set`) handed `[]` only clears. A computed
// field of the client's extension (`computed`, by model) in a projection reads
// the fields it needs; where a spread may add or replace the model's computed
// fields (`open`), what a field it may compute needs is not known, and said.
//
// What it does not follow, it says: a relation whose model it was not handed
// (`relations`), a key it does not know (`unknownKeys`, with the relation path
// it was found under), and an argument held in a variable, spread, or written
// with a computed key (`runtimeOnly`). Nothing here is dropped silently.

/** A model as this reader reads one: its scalar fields, its relations with the model each reaches and which are lists, its compound keys. */
export function fieldIndex(model) {
  const idx = { scalars: new Set(), relations: new Set(), targets: new Map(), lists: new Set(), compounds: model.compounds ?? {} };
  for (const f of model.fields) {
    if (!f.relation) { idx.scalars.add(f.name); continue; }
    idx.relations.add(f.name);
    if (typeof f.type === 'string') idx.targets.set(f.name, f.type);
    if (f.list) idx.lists.add(f.name);
  }
  return idx;
}

/** One model's effects: what the call reads, writes and may read of it, and the relations it follows from it. What could not be read is shared by the whole call. */
function effects(statement, model, shared) {
  return {
    statement, model, idx: fieldIndex(model), reads: new Set(), writes: new Set(), mayReads: new Set(), relations: new Set(), follow: [], wholeRow: false,
    runtimeOnly: shared.runtimeOnly, unknownKeys: shared.unknownKeys, prefix: shared.prefix, cfg: shared.cfg, rule: shared.rule,
  };
}

/** Where in the argument a key sits, for naming it: `select.email`, `include.posts.title`. */
const at = (fx, argKey, key) => `${argKey}.${fx.prefix}${key}`;

/** The scalar fields a key names: the field itself, or the fields a compound key (named, or the default `a_b`) joins. */
function fieldsOfKey(key, idx) {
  if (idx.scalars.has(key)) return [key];
  return Object.hasOwn(idx.compounds, key) ? idx.compounds[key] : [];
}

/** Every key of a value that is an object literal, or an array of them; the rest is only known at run time, under `label`. */
function keysOf(value, fx, label) {
  const pairs = [];
  const walk = (v) => {
    if (!v || v.k === 'bool' || v.k === 'none' || v.k === 'null') return;
    if (v.k === 'arr') { for (const x of v.v) walk(x); if (v.spread) fx.runtimeOnly.add(label); return; }
    if (v.k !== 'obj') { fx.runtimeOnly.add(label); return; }
    if (v.spread || v.computed) fx.runtimeOnly.add(label);
    for (const [key, x] of Object.entries(v.v)) pairs.push([key, x]);
  };
  walk(value);
  return pairs;
}

/** A key whose role is project: `true` reads it, `false` reads nothing, anything else MAY read it at run time. */
function applyProjectField(argKey, key, v, fields, fx) {
  if (v.k === 'bool' && v.v === true) { for (const f of fields) fx.reads.add(f); return; }
  if (v.k === 'bool' && v.v === false) return;
  for (const f of fields) fx.mayReads.add(f);
  fx.runtimeOnly.add(at(fx, argKey, key));
}

/** The model fields a computed field needs, through the computed fields it needs in turn (Prisma resolves them the same way); null when one of them is not written down. */
function neededBy(map, name, seen) {
  if (seen.has(name) || !Object.hasOwn(map, name)) return [name];
  seen.add(name);
  if (map[name] === null) return null;
  const out = [];
  for (const n of map[name]) {
    const r = neededBy(map, n, seen);
    if (r === null) return null;
    out.push(...r);
  }
  return out;
}

/**
 * A computed field of the client in a projection: it reads what it needs, as a
 * field set to that value would. True when it is no field of the model, so the
 * key itself reads nothing more.
 */
function applyComputed(key, v, fx, argKey) {
  const set = fx.cfg.computed?.get(fx.model.name);
  if (!set || (!set.open && !Object.hasOwn(set.fields, key)) || (v.k === 'bool' && !v.v)) return false;
  const own = fx.idx.scalars.has(key) || fx.idx.relations.has(key);
  const needs = set.open ? null : neededBy(set.fields, key, new Set());
  if (needs === null) { fx.runtimeOnly.add(at(fx, argKey, key)); return !own; }
  applyProjectField(argKey, key, v, needs.flatMap((n) => fieldsOfKey(n, fx.idx)), fx);
  return !own;
}

/** One key of an argument object, read by the role its argument plays. */
function applyKeyRole(role, key, v, fx, argKey) {
  if (role === 'filter' && fx.cfg.combinators.includes(key)) { readArgument('filter', v, fx, argKey); return; }
  if (fx.cfg.relationCount && key === fx.cfg.relationCount.key && (role === 'project' || role === 'relations')) { readRelationCount(v, fx, argKey); return; }
  if (role === 'project' && applyComputed(key, v, fx, argKey)) return;
  if (fx.idx.relations.has(key)) { followRelation(role, key, v, fx, argKey); return; }
  const fields = fieldsOfKey(key, fx.idx);
  if (fields.length === 0) { fx.unknownKeys.add(`${fx.prefix}${key}`); return; }
  if (role === 'project') { applyProjectField(argKey, key, v, fields, fx); return; }
  for (const f of fields) (role === 'write' ? fx.writes : fx.reads).add(f);
}

/** `argKey` is the argument key this value was given under (`select`, `where`, ...), carried down for naming a dynamic part; `label` names it when it is only known at run time. */
function readArgument(role, value, fx, argKey, label = `${fx.prefix}${role}`) {
  if (role === 'read' && value && value.k === 'arr' && value.v.every((v) => v.k === 'str')) {
    for (const v of value.v) for (const f of fieldsOfKey(v.v, fx.idx)) fx.reads.add(f);
    return;
  }
  for (const [key, v] of keysOf(value, fx, label)) applyKeyRole(role, key, v, fx, argKey);
}

/** Every key an argument object gives, read by the role `roles` names for it. */
export function readGiven(given, roles, fx) {
  for (const [key, value] of Object.entries(given)) {
    const role = roles[key];
    if (role === undefined) { fx.unknownKeys.add(`${fx.prefix}${key}`); continue; }
    if (role !== 'none') readArgument(role, value, fx, key);
  }
}

/** A relation's effects, as an entry of `fx.follow`: `how` it is reached, the `access` its rows get, and whether a run-time value decides it (`may`). */
function follow(fx, key, target, how, extra = {}) {
  const child = effects(fx.statement, target, { runtimeOnly: fx.runtimeOnly, unknownKeys: fx.unknownKeys, prefix: `${fx.prefix}${key}.`, cfg: fx.cfg, rule: fx.rule });
  fx.follow.push({ relation: key, target: target.name, how, access: 'read', ...extra, fx: child });
  return child;
}

/** A relation in a projection (`include`, or `select`): `true` returns its whole row, an object is a find of its own on it. */
function readProjected(key, v, target, fx, argKey) {
  if (v.k === 'bool') { if (v.v) follow(fx, key, target, 'project').wholeRow = true; return; }
  if (v.k !== 'obj') { fx.runtimeOnly.add(at(fx, argKey, key)); follow(fx, key, target, 'project', { may: true }).wholeRow = true; return; }
  const child = follow(fx, key, target, 'project');
  readGiven(v.v, fx.cfg.roles, child);
  if (v.spread || v.computed) fx.runtimeOnly.add(at(fx, argKey, key));
  child.wholeRow = !v.spread && !v.computed && !Object.keys(v.v).some((k) => fx.cfg.roles[k] === 'project');
}

/** The keys of a relation filter written whole that only check the link for null (`{ is: null }`, `{ isNot: null }`). */
const nullChecks = (v, fx) => (v.spread || v.computed ? [] : Object.keys(v.v).filter((k) => v.v[k].k === 'null' && fx.cfg.relationNullFilters.includes(k)));

/** A relation in a filter: through `some`/`every`/`none`/`is`/`isNot`, or a to-one filter written straight; `null` checks the link alone. */
function readRelationFilter(key, v, target, fx, argKey) {
  if (v.k === 'null') { follow(fx, key, target, 'filter', { nullCheck: true }); return; }
  if (v.k !== 'obj') { fx.runtimeOnly.add(at(fx, argKey, key)); follow(fx, key, target, 'filter', { may: true }); return; }
  const keys = Object.keys(v.v);
  if (keys.length === 0 || !keys.every((k) => fx.cfg.relationFilters.includes(k))) { readArgument('filter', v, follow(fx, key, target, 'filter'), argKey); return; }
  if (v.spread || v.computed) fx.runtimeOnly.add(at(fx, argKey, key));
  const nulls = nullChecks(v, fx);
  if (nulls.length > 0) follow(fx, key, target, 'filter', { nullCheck: true });
  if (nulls.length === keys.length) return;
  const child = follow(fx, key, target, 'filter');
  for (const k of keys.filter((x) => !nulls.includes(x))) readArgument('filter', v.v[k], child, argKey);
}

/** A relation in an ordering: its fields are read, and ordering by its count reads the join alone. */
function readRelationOrder(key, v, target, fx, argKey) {
  const child = follow(fx, key, target, 'read');
  const count = fx.cfg.relationCount?.key;
  if (v.k === 'obj' && count && Object.hasOwn(v.v, count)) {
    const rest = Object.fromEntries(Object.entries(v.v).filter(([k]) => k !== count));
    readArgument('read', { ...v, v: rest }, child, argKey);
    return;
  }
  readArgument('read', v, child, argKey);
}

/** Each object of a value that is one or an array of them, handed to `fn`; anything else is only known at run time. */
function eachObject(x, fx, label, fn) {
  if (x.spread) fx.runtimeOnly.add(label);
  for (const o of x.k === 'arr' ? x.v : [x]) {
    if (o.k !== 'obj') { fx.runtimeOnly.add(label); continue; }
    if (o.spread || o.computed) fx.runtimeOnly.add(label);
    fn(o.v);
  }
}

/** Whether a nested write's value is its arguments (`{ where, data }`) rather than the data itself: every key one of them, and none a field of the model. */
function argumentsForm(spec, x, idx) {
  const objs = x.k === 'arr' ? x.v : [x];
  return objs.length > 0 && objs.every((o) => o.k === 'obj' && Object.keys(o.v).length > 0
    && Object.keys(o.v).every((k) => Object.hasOwn(spec.arguments, k) && !idx.scalars.has(k) && !idx.relations.has(k)));
}

/** One nested write operation's value: `true` touches the link alone, else its arguments or its value, read by the roles the pack gives them. */
function readNestedWrite(spec, x, child, argKey, label) {
  if (x.k === 'bool') return;
  if (spec.arguments && argumentsForm(spec, x, child.idx)) { eachObject(x, child, label, (obj) => readGiven(obj, spec.arguments, child)); return; }
  if (spec.value) { readArgument(spec.value, x, child, argKey, label); return; }
  child.runtimeOnly.add(label);
}

/** A value written as `false` or as an empty array, the literals a nested write's `idle` map can name; null for anything else. */
function literalOf(x) {
  if (x.k === 'bool' && x.v === false) return 'false';
  return x.k === 'arr' && x.v.length === 0 && !x.spread ? '[]' : null;
}

/** Whether an `idle` entry's literal is what a nested write is handed: the whole value, or, with `argument`, that argument of an object written whole. */
function idleMatches(e, x) {
  if (!e.argument) return literalOf(x) === e.value;
  return x.k === 'obj' && !x.spread && !x.computed && Object.hasOwn(x.v, e.argument) && literalOf(x.v[e.argument]) === e.value;
}

/**
 * How one nested write is followed: `null` when the first `idle` entry its
 * value matches leaves it doing nothing on every relation, else its entry's
 * fields, with the entries that match (`idle`, each `{on, drops}`) for the
 * bridge to apply on the relation it is. A `replace` link handed `[]` lists
 * nothing to set, so it only clears.
 */
function nestedEntry(op, spec, x) {
  const idle = (spec.idle ?? []).filter((e) => idleMatches(e, x)).map((e) => ({ on: e.on ?? 'any', drops: e.drops ?? 'all' }));
  if (idle.length > 0 && idle[0].on === 'any' && idle[0].drops === 'all') return null;
  const link = spec.link === 'replace' && literalOf(x) === '[]' ? 'clear' : spec.link;
  return { op, access: spec.rows === 'none' ? 'read' : spec.rows, ...(link ? { link } : {}), ...(idle.length > 0 ? { idle } : {}) };
}

/** A relation in a write: each nested operation (`create`, `connect`, `update`, ...) as the pack describes it; a value held in a variable MAY write it, in a way only the running program knows. */
function readNestedWrites(key, v, target, fx, argKey) {
  if (v.k !== 'obj') { fx.runtimeOnly.add(at(fx, argKey, key)); follow(fx, key, target, 'write', { access: 'write', link: 'set', may: true }); return; }
  if (v.spread || v.computed) fx.runtimeOnly.add(at(fx, argKey, key));
  for (const [op, x] of Object.entries(v.v)) {
    const spec = fx.cfg.nestedWrites[op];
    if (!spec) { fx.unknownKeys.add(`${fx.prefix}${key}.${op}`); continue; }
    const entry = nestedEntry(op, spec, x);
    if (entry) readNestedWrite(spec, x, follow(fx, key, target, 'write', entry), argKey, at(fx, argKey, `${key}.${op}`));
  }
}

/** One relation a `_count` names: the rows it counts, filtered by what its own arguments say. */
function countOne(rel, x, fx, argKey) {
  const count = fx.cfg.relationCount;
  const target = fx.idx.relations.has(rel) ? fx.cfg.models?.get(fx.idx.targets.get(rel)) ?? null : null;
  if (!target) { if (fx.idx.relations.has(rel)) fx.relations.add(rel); else fx.unknownKeys.add(`${fx.prefix}${count.key}.${rel}`); return; }
  if (x.k === 'bool' && !x.v) return;
  if (x.k !== 'bool' && x.k !== 'obj') { fx.runtimeOnly.add(at(fx, argKey, `${count.key}.${rel}`)); follow(fx, rel, target, 'count', { may: true }); return; }
  const child = follow(fx, rel, target, 'count');
  if (x.k === 'obj') readGiven(x.v, count.arguments, child);
}

/** `_count` in a projection: `true` counts every list relation of the model, `{ select: { posts: ... } }` the ones it names. */
function readRelationCount(v, fx, argKey) {
  const key = fx.cfg.relationCount.key;
  if (v.k === 'bool') { if (v.v) for (const r of [...fx.idx.lists].sort()) countOne(r, v, fx, argKey); return; }
  const select = v.k === 'obj' ? v.v.select : undefined;
  if (v.k === 'obj') for (const k of Object.keys(v.v).filter((x) => x !== 'select')) fx.unknownKeys.add(`${fx.prefix}${key}.${k}`);
  if (!select || select.k !== 'obj' || select.spread || select.computed || v.spread || v.computed) fx.runtimeOnly.add(at(fx, argKey, key));
  if (select && select.k === 'obj') for (const [rel, x] of Object.entries(select.v)) countOne(rel, x, fx, argKey);
}

const RELATION_READERS = Object.freeze({
  project: readProjected, relations: readProjected, filter: readRelationFilter, read: readRelationOrder, write: readNestedWrites,
});

/** A relation key, followed into the model it reaches when the caller handed in the models; said as not followed when it did not. */
function followRelation(role, key, v, fx, argKey) {
  const target = fx.cfg.models?.get(fx.idx.targets.get(key)) ?? null;
  if (!target || !RELATION_READERS[role]) { fx.relations.add(key); return; }
  RELATION_READERS[role](key, v, target, fx, argKey);
}

/** Whether the argument itself is known well enough to say "every scalar field" for it: no spread, no computed key, or no argument at all. */
function argIsFullyKnown(arg) {
  return !arg || arg.k === 'none' || (arg.k === 'obj' && !arg.spread && !arg.computed);
}

/**
 * One call's effects: `op` the operation as the pack describes it, `args` its
 * argument summaries, `model` the model its delegate names, and `cfg` the
 * rule's reading (`roles`, `combinators`, `relationFilters`, `relationCount`,
 * `nestedWrites`) with `models`, the schema's models by name, for following a
 * relation (absent, none is followed).
 */
export function readCall(op, args, model, cfg, rule) {
  const fx = effects(op.statement, model, { runtimeOnly: new Set(), unknownKeys: new Set(), prefix: '', cfg, rule });
  const arg = args[0];
  if (arg && arg.k !== 'obj' && arg.k !== 'none') fx.runtimeOnly.add('arguments');
  if (arg && (arg.spread || arg.computed)) fx.runtimeOnly.add('arguments');
  const given = arg && arg.k === 'obj' ? arg.v : {};
  readGiven(given, cfg.roles, fx);
  const hasProjectKey = Object.keys(given).some((k) => cfg.roles[k] === 'project');
  fx.wholeRow = op.wholeRow === true && argIsFullyKnown(arg) && !hasProjectKey;
  return fx;
}
