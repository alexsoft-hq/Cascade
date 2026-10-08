// typeorm_query_builder.mjs — the `typeorm.query-builder` rule kind: what a TypeORM query builder reads and writes, step by step.
//
// `repo.createQueryBuilder('user').where('user.email = :email').getOne()`
// reads User.email to filter and returns every column of User. This kind
// knows HOW each part a step plays is read: the aliases a query names (from
// createQueryBuilder, from, update, a join), a condition's text
// (typeorm_builder_read.mjs), what select narrows and a join adds, which
// steps make it an update, a delete or an insert, and what the getters return.
// The rule pack says WHICH method plays which part, and which words of a
// condition are SQL's (src/core/rules/packs/typeorm.json).
//
// TypeORM builds the SQL when the query runs, so the order the steps are
// written in does not decide which alias means what: aliases are read first.
// A step written under a condition MAY run, so what it reads MAY be read, and
// a select under one MAY replace the selection: what was selected before stays
// a candidate. The rows a query returns are what is selected WHEN it runs, so a
// builder run twice with two selections returns both. A step this kind cannot
// read (a condition built with Brackets, a value not written out, a method the
// pack does not name) is said in `notRead`.
//
// update, insert, softDelete and restore also set the main entity's date and
// version columns of their own accord (`auto` on its view): an insert those
// into's column list names, when it has one.

import { isPlainObject, namesErrors, unknownKeysAt } from './ts_names.mjs';
import { columnsInText, columnsOfProperty } from './typeorm_builder_read.mjs';
import { exampleProject } from './ts_example_project.mjs';

export const STEP_ROLES = Object.freeze(['select', 'add-select', 'condition', 'ids', 'order', 'join', 'join-select', 'join-map', 'from', 'into', 'clone',
  'update', 'delete', 'insert', 'soft-delete', 'restore', 'values', 'with-deleted', 'rows', 'count', 'none']);
const ALIAS_ROLES = new Set(['join', 'join-select', 'join-map', 'from', 'into', 'update']);
const STATEMENT_OF = Object.freeze({ update: 'update', delete: 'delete', insert: 'insert', 'soft-delete': 'update', restore: 'update' });

function validateParams(params) {
  if (!isPlainObject(params)) return ['params must be an object'];
  const errors = unknownKeysAt(params, ['start', 'methods', 'sqlWords'], 'params');
  if (typeof params.start !== 'string' || params.start === '') errors.push('params.start must be the method a builder is made with');
  if (!isPlainObject(params.methods) || Object.values(params.methods).some((r) => !STEP_ROLES.includes(r))) errors.push(`params.methods must map each method to one of ${STEP_ROLES.join(', ')}`);
  return [...errors, ...namesErrors(params.sqlWords, 'params.sqlWords')];
}

const EXPECT_KEYS = Object.freeze(['statement', 'reads', 'mayReads', 'writes', 'mayWrites', 'wholeRow', 'follows', 'notRead']);

function validateExample(example) {
  if (!isPlainObject(example)) return ['an example must be an object'];
  const errors = unknownKeysAt(example, ['chain', 'entities', 'entity', 'expect', 'why'], 'an example');
  if (typeof example.chain !== 'string') errors.push('an example needs "chain", the builder as TypeScript source');
  if (!isPlainObject(example.entities) || typeof example.entity !== 'string') errors.push('an example needs "entities" and the "entity" its builder starts from');
  if (!isPlainObject(example.expect)) return [...errors, `an example needs "expect": {${EXPECT_KEYS.join(', ')}}`];
  return [...errors, ...unknownKeysAt(example.expect, EXPECT_KEYS, 'an example\'s expect')];
}

function newState(start) {
  const aliases = new Map();
  if (start.view) aliases.set(start.alias ?? start.view.name, start.view);
  return {
    aliases, main: start.view ?? null, statement: 'select', selection: start.view ? [{ view: start.view, whole: true, may: false }] : [],
    reads: [], mayReads: [], writes: [], mayWrites: [], follows: [], tables: [], notRead: [], wholeRow: [], ran: false,
    autoWrites: [], autoReads: [], insertColumns: null,
  };
}

const strArg = (v) => (v && v.k === 'str' ? v.v : null);
/** Selection items, each marked as one that MAY be selected when `may`. */
const mayBe = (items, may) => items.map((i) => ({ ...i, may: Boolean(i.may || may) }));
const record = (st, hits, may, write = false) => { for (const h of hits) (write ? (may ? st.mayWrites : st.writes) : (may ? st.mayReads : st.reads)).push(h); };

function readText(st, text, may, words) {
  const { hits, notRead } = columnsInText(text, st.aliases, words);
  record(st, hits, may);
  st.notRead.push(...notRead);
}

/** What select or addSelect names: an alias whole, or the columns its text names. */
function selectionOf(st, arg, words) {
  const texts = arg && arg.k === 'arr' && !arg.spread ? arg.v.map(strArg) : [strArg(arg)];
  if (texts.includes(null)) { st.notRead.push('select'); return []; }
  return texts.flatMap((t) => {
    if (/^\w+$/.test(t) && st.aliases.has(t)) return [{ view: st.aliases.get(t), whole: true }];
    const { hits, notRead } = columnsInText(t, st.aliases, words);
    st.notRead.push(...notRead);
    return hits;
  });
}

/** A where object on the main entity: each key a property. */
function readObject(st, v, may, write, label) {
  if (!st.main || !v || v.k !== 'obj') { st.notRead.push(label); return; }
  if (v.spread || v.computed) st.notRead.push(label);
  for (const key of Object.keys(v.v)) {
    const cols = columnsOfProperty(st.main, key);
    if (cols.length === 0) st.notRead.push(`${label}(${key})`);
    record(st, cols.map((column) => ({ view: st.main, column })), may, write);
  }
}

/** A join by a relation path (`article.author`) or by an entity, registering its alias. */
function registerJoin(st, s, ctx, role) {
  const a = role === 'join-map' ? s.args.slice(1) : s.args;
  const target = strArg(a[0]);
  const alias = strArg(a[1]);
  let view;
  const path = target && /^\w+\.\w+$/.test(target) ? target.split('.') : null;
  if (path && st.aliases.has(path[0])) {
    const rel = ctx.relationOf(st.aliases.get(path[0]), path[1]);
    view = rel ? rel.target : null;
    if (view) st.follows.push({ view: st.aliases.get(path[0]), property: path[1], target: view, may: Boolean(s.cond) });
  } else {
    view = ctx.entityOf(a[0]);
    if (view) st.tables.push({ view, may: Boolean(s.cond) });
  }
  if (!view) { st.notRead.push(target ?? s.name); return; }
  if (alias) st.aliases.set(alias, view);
}

/** from, into and update name the entity a builder made with no entity works on. */
function registerTarget(st, s, ctx) {
  const view = ctx.entityOf(s.args[0]);
  if (!view || st.main) return;
  st.main = view;
  st.aliases.set(strArg(s.args[1]) ?? view.name, view);
  if (s.name !== 'update') st.selection = [{ view, whole: true, may: false }];
}

function aliasPass(st, steps, methods, ctx) {
  for (const s of steps) {
    const role = methods[s.name];
    if (role === 'join' || role === 'join-select' || role === 'join-map') registerJoin(st, s, ctx, role);
    else if (ALIAS_ROLES.has(role) && s.args[0]) registerTarget(st, s, ctx);
    // into(target, columns): an insert lists those columns alone (InsertQueryBuilder.getInsertedColumns).
    if (role === 'into' && s.args[1]) st.insertColumns = columnListOf(s.args[1]);
  }
}

const columnListOf = (v) => (v.k === 'arr' && !v.spread && v.v.every((x) => x.k === 'str') ? v.v.map((x) => x.v) : 'unknown');

/** Whether an insert lists a column: into's list when it has one, else whether the column is left out of inserts. */
function insertedBy(st, c) {
  if (st.insertColumns === null) return c.insertable;
  return st.insertColumns === 'unknown' ? 'may' : st.insertColumns.includes(c.property);
}

/** What the statement a step makes sets on its own: each auto column of the main entity it sets, and a version it adds one to, read. */
function autoStep(st, send, may) {
  for (const c of st.main?.auto ?? []) {
    const how = Object.hasOwn(c.sets, send) ? c.sets[send] : null;
    const listed = send === 'insert' ? insertedBy(st, c) : true;
    if (!how || listed === false) continue;
    const hit = { view: st.main, column: c.column, may: may || listed === 'may', why: `the ${c.role} column, which TypeORM sets itself in the ${send} it sends` };
    st.autoWrites.push(hit);
    if (how === 'increment') st.autoReads.push(hit);
  }
}

/**
 * Since 0.2.34 an update sets a date or version column on its own only when
 * its values do not name it (0.3.28 UpdateQueryBuilder.createUpdateExpression),
 * and before that always: a column the values name is theirs to write, and
 * whether the old version is read is the installed version's, a candidate; so
 * is one they may name (values not written out, a set under a condition).
 */
function settleAuto(st) {
  softDeleteFilter(st);
  if (st.statement !== 'update') return;
  const named = (list, h) => list.some((w) => w.view === h.view && w.column === h.column);
  st.autoReads = st.autoReads.map((h) => (named(st.writes, h) || named(st.mayWrites, h) ? { ...h, may: true } : h));
  st.autoWrites = st.autoWrites.filter((h) => !named(st.writes, h));
}

function joinStep(st, s, role, words) {
  const a = role === 'join-map' ? s.args.slice(1) : s.args;
  const alias = strArg(a[1]);
  if (role !== 'join' && alias && st.aliases.has(alias)) st.selection.push({ view: st.aliases.get(alias), whole: true, may: Boolean(s.cond) });
  if (strArg(a[2])) readText(st, strArg(a[2]), Boolean(s.cond), words);
  // The join's condition reads the delete date of an entity that has one, unless withDeleted came before it (SelectQueryBuilder.join).
  const joined = alias ? st.aliases.get(alias) : null;
  if (joined?.deleteDate && st.withDeleted !== true) record(st, [{ view: joined, column: joined.deleteDate }], Boolean(s.cond) || st.withDeleted === 'may');
}

/**
 * A select filters out the rows the main entity's delete date column marks
 * unless withDeleted asks for them (0.3.28 QueryBuilder.createWhereExpression):
 * the column is read, a candidate when withDeleted may have run.
 */
function softDeleteFilter(st) {
  const col = st.main?.deleteDate;
  if (st.statement !== 'select' || !col || st.withDeleted === true) return;
  record(st, [{ view: st.main, column: col }], st.withDeleted === 'may');
}

/** select replaces the selection, addSelect adds to it; under a condition, select may leave what it replaces in place. */
function selectStep(st, s, role, words) {
  const may = Boolean(s.cond);
  const named = selectionOf(st, s.args[0], words);
  if (role === 'add-select') st.selection.push(...mayBe(named, may));
  else st.selection = may ? [...mayBe(st.selection, true), ...mayBe(named, true)] : mayBe(named, false);
}

/** A step that makes the builder an update, a delete, an insert, a soft delete or a restore, and what that statement writes. */
function statementStep(st, s, role, may) {
  st.statement = STATEMENT_OF[role];
  if ((role === 'soft-delete' || role === 'restore') && st.main?.deleteDate) record(st, [{ view: st.main, column: st.main.deleteDate }], may, true);
  if (role === 'update' && s.args[1]) readObject(st, s.args[1], may, true, 'update');
  autoStep(st, role, may);
}

/** One step, read by the part its method plays. */
function readStep(st, s, role, ctx) {
  const may = Boolean(s.cond);
  const words = ctx.sqlWords;
  if (role === 'select' || role === 'add-select') selectStep(st, s, role, words);
  else if (role === 'condition' || role === 'order') {
    const a0 = s.args[0];
    if (strArg(a0) !== null) readText(st, a0.v, may, words);
    else if (a0 && a0.k === 'obj' && role === 'order') for (const k of Object.keys(a0.v)) readText(st, k, may, words);
    else if (a0 && a0.k === 'obj') readObject(st, a0, may, false, s.name);
    else st.notRead.push(s.name);
  } else if (role === 'ids') record(st, (st.main?.pk ?? []).map((column) => ({ view: st.main, column })), may);
  else if (role === 'join' || role === 'join-select' || role === 'join-map') joinStep(st, s, role, words);
  else if (STATEMENT_OF[role]) statementStep(st, s, role, may);
  else if (role === 'values') readValues(st, s.args[0], may);
  else runStep(st, role, may);
}

/** A step that runs the query, or asks for soft-deleted rows (under a condition, it may). */
function runStep(st, role, may) {
  if (role === 'with-deleted') st.withDeleted = may && st.withDeleted !== true ? 'may' : true;
  else if (role === 'rows') returnRows(st, may);
  else if (role === 'count') st.ran = true;
}

function readValues(st, v, may) {
  if (v && v.k === 'arr' && !v.spread) { for (const x of v.v) readValues(st, x, may); return; }
  if (v && v.k === 'obj' && !v.spread && !v.computed) { readObject(st, v, may, true, 'values'); return; }
  if (st.main) record(st, st.main.columns.map((c) => ({ view: st.main, column: c.column })), true, true);
  st.notRead.push('values');
}

/**
 * One run of the query: a select returns what is selected at that step, every
 * alias it selects whole and the columns it names, each MAY be when the item
 * or the run may not happen.
 */
function returnRows(st, may) {
  st.ran = true;
  if (st.statement !== 'select') return;
  for (const item of st.selection) {
    const m = item.may || may;
    if (item.whole) st.wholeRow.push({ view: item.view, grade: m ? 'may' : 'exact' });
    else record(st, [item], m);
  }
}

/** Each alias returned whole, once, at the surest any run returned it. */
function wholeRowOf(st) {
  const best = new Map();
  for (const w of st.wholeRow) if (!best.has(w.view) || w.grade === 'exact') best.set(w.view, w);
  return [...best.values()];
}

/** Every step, read by the part its method plays, then what the statement does on its own. */
function readSteps(st, steps, methods, ctx) {
  for (const s of steps) {
    const role = Object.hasOwn(methods, s.name) ? methods[s.name] : null;
    if (role === null) st.notRead.push(s.name);
    else readStep(st, s, role, ctx);
  }
  settleAuto(st);
}

/**
 * The rule, ready to read a builder: `effectsOf(start, steps, ctx)`, `start`
 * `{view, alias}` for the entity the builder was made on (view null when it
 * was made on none), `steps` `[{name, args, cond}]`, and `ctx` how an entity
 * argument or a relation of a view is found (`entityOf(value)`,
 * `relationOf(view, property)`).
 */
function compile(rule) {
  const { methods, sqlWords, start: startMethod } = rule.params;
  const effectsOf = (start, steps, ctx) => {
    const st = newState(start);
    aliasPass(st, steps, methods, ctx);
    readSteps(st, steps, methods, { ...ctx, sqlWords });
    return {
      statement: st.statement, main: st.main, reads: st.reads, mayReads: st.mayReads, writes: st.writes, mayWrites: st.mayWrites, wholeRow: wholeRowOf(st),
      follows: st.follows, tables: st.tables, notRead: [...new Set(st.notRead)], terminal: st.ran, rule: rule.id, autoWrites: st.autoWrites, autoReads: st.autoReads,
    };
  };
  const roleOf = (name) => (Object.hasOwn(methods, name) ? methods[name] : null);
  return { rule: rule.id, start: startMethod, effectsOf, roleOf };
}

/** The views of an example's entities, each column named as its property. */
function exampleViews(entities) {
  const views = Object.fromEntries(Object.entries(entities).map(([name, e]) => [name, {
    name, columns: e.fields.map((f) => ({ property: f, column: f })), pk: e.fields.includes('id') ? ['id'] : [], deleteDate: null, relationTargets: e.relations ?? {},
    auto: Object.entries(e.auto ?? {}).map(([p, sets]) => ({ property: p, column: p, role: 'auto', sets, insertable: true })),
  }]));
  return {
    views,
    ctx: {
      relationOf: (view, prop) => (Object.hasOwn(view.relationTargets, prop) ? { target: views[view.relationTargets[prop]] } : null),
      entityOf: (v) => (v && (v.k === 'id' || v.k === 'str') ? views[v.v] ?? null : null),
    },
  };
}

function runOne(entry, ex, i, env) {
  const source = `export class Example {\n  run() {\n    return ${ex.chain};\n  }\n}\n`;
  const project = exampleProject(env.tsFacts(`${entry.id}/example${i}.ts`, source));
  const call = project.calls.find((c) => c.callee.endsWith(`.${entry.compiled.start}`));
  const { views, ctx } = exampleViews(ex.entities);
  const fx = entry.compiled.effectsOf({ view: views[ex.entity], alias: strArg(call?.args[0]) }, (call?.chain ?? []).map((s) => ({ ...s, cond: false })), ctx);
  const cols = (list) => [...new Set(list.map((h) => `${h.view.name}.${h.column}`))].sort();
  const sure = (list, may) => list.filter((h) => h.may === may);
  const got = {
    statement: fx.statement, reads: cols([...fx.reads, ...sure(fx.autoReads, false)]), mayReads: cols([...fx.mayReads, ...sure(fx.autoReads, true)]),
    writes: cols([...fx.writes, ...sure(fx.autoWrites, false)]), mayWrites: cols([...fx.mayWrites, ...sure(fx.autoWrites, true)]),
    wholeRow: [...new Set(fx.wholeRow.map((w) => w.view.name))].sort(), follows: fx.follows.map((f) => f.property).sort(), notRead: [...fx.notRead].sort(),
  };
  const want = { reads: [], mayReads: [], writes: [], mayWrites: [], wholeRow: [], follows: [], notRead: [], ...ex.expect };
  const norm = (s) => JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]).sort()));
  return { example: ex, passed: norm(got) === norm(want), got };
}

function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  return { results: new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => runOne(entry, ex, i, env))])) };
}

export const typeormQueryBuilder = Object.freeze({
  name: 'typeorm.query-builder',
  lane: 'ts',
  stage: 'ts-facts',
  // A column a step's text names by its alias is one the query reads.
  gradeCap: 'EXACT',
  validateParams,
  validateExample,
  compile,
  runExamples,
});
