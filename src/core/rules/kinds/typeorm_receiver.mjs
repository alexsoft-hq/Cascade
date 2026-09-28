// typeorm_receiver.mjs — the `typeorm.receiver` rule kind: which objects a TypeORM call is made on, and which entity it names.
//
// `this.users.findOneBy({ email })` is an operation on the repository of User
// when `users` is a field `@InjectRepository(User)` injects, or a field typed
// `Repository<User>`; `this.em.find(Order, ...)` is one on an entity manager,
// and names Order in its first argument. This kind knows HOW a call is read
// (typeorm_receiver_read.mjs): left to right, through the fields of the class,
// the functions a package exports, the names a method binds, and the chain of
// calls written on a call's result. The rule pack says WHICH types, decorators,
// functions and members play which part (src/core/rules/packs/typeorm.json).

import { isPlainObject, refsErrors, unknownKeysAt } from './ts_names.mjs';
import { readCall, entityRefOf } from './typeorm_receiver_read.mjs';
import { exampleProject } from './ts_example_project.mjs';

const KINDS = Object.freeze(['repository', 'manager', 'data-source']);
const PARAM_KEYS = Object.freeze(['types', 'inject', 'entityRepository', 'functions', 'members', 'transaction']);

function byKindErrors(map, where) {
  if (!isPlainObject(map)) return [`${where} must map ${KINDS.join(', ')} to lists of {module, export}`];
  return [...unknownKeysAt(map, KINDS, where), ...KINDS.flatMap((k) => (map[k] === undefined ? [] : refsErrors(map[k], `${where}.${k}`)))];
}

function validateParams(params) {
  if (!isPlainObject(params)) return ['params must be an object'];
  const errors = unknownKeysAt(params, PARAM_KEYS, 'params');
  errors.push(...byKindErrors(params.types, 'params.types'), ...byKindErrors(params.inject, 'params.inject'), ...byKindErrors(params.functions, 'params.functions'));
  errors.push(...refsErrors(params.entityRepository, 'params.entityRepository'));
  if (!isPlainObject(params.members) || Object.values(params.members).some((v) => !['repository', 'manager'].includes(v))) errors.push('params.members must map a member name to repository or manager');
  if (typeof params.transaction !== 'string' || params.transaction === '') errors.push('params.transaction must be the method a transaction is started with');
  return errors;
}

function validateExample(example) {
  if (!isPlainObject(example)) return ['an example must be an object'];
  const errors = unknownKeysAt(example, ['source', 'expect', 'why'], 'an example');
  if (typeof example.source !== 'string' || example.source.trim() === '') errors.push('an example needs a TypeScript "source"');
  if (!Array.isArray(example.expect)) return [...errors, 'an example needs "expect", the TypeORM calls its source makes'];
  example.expect.forEach((e, i) => {
    if (!isPlainObject(e) || typeof e.call !== 'string' || !KINDS.includes(e.receiver) || !(e.entity === null || typeof e.entity === 'string')) errors.push(`expect[${i}] must be {call, receiver (${KINDS.join(', ')}), entity}`);
  });
  return errors;
}

/** The class a call's member is written in, or null for a function of the module. */
function classOfCall(project, call) {
  const dot = call.in ? call.in.indexOf('.') : -1;
  return dot < 0 ? null : project.files.get(call.file)?.classes.get(call.in.slice(0, dot)) ?? null;
}

/**
 * A transaction's callback parameter, bound as a manager where it is declared:
 * a call is on it when its receiver starts at that declaration, whatever else
 * in the member is spelled the same.
 */
function transactionBinding(call, read) {
  const fn = read.transaction.args.find((a) => a.k === 'fn');
  const at = fn?.paramsAt?.[0] ?? null;
  return at ? { key: `${call.file}|${at}`, line: fn.line, reassigned: false, value: { kind: 'manager', via: `the ${read.transaction.name} callback's ${fn.params[0]}` } } : null;
}

/** A local that holds a repository or a manager, bound where it is declared; one written again anywhere it is in scope may hold anything at a call. */
function holderBinding(call, read) {
  const at = call.chain ? call.chainHolderAt : call.holderAt;
  const reassigned = call.chain ? call.chainHolderReassigned : call.holderReassigned;
  return at && read.value && !read.op ? { key: `${call.file}|${at}`, line: call.line, reassigned: Boolean(reassigned), value: read.value } : null;
}

/** Every binding a pass over the calls finds, given the ones found so far, keyed by the file and the place of the declaration. */
function bindingsOf(project, cfg, known) {
  const out = new Map(known);
  for (const call of project.calls) {
    const read = readCall(project, call, classOfCall(project, call), known, cfg);
    if (!read || read.unreadLocal) continue;
    const b = read.transaction ? transactionBinding(call, read) : holderBinding(call, read);
    if (b && !out.has(b.key)) out.set(b.key, b);
  }
  return out;
}

/** The entity an operation names: the repository's, or, on a manager or a data source, the first argument. */
function siteEntity(read, call) {
  if (read.value.kind === 'repository') return { entity: read.value.entity, argsFrom: 0 };
  const entity = entityRefOf(call.file, read.args[0]);
  return { entity, argsFrom: entity ? 1 : 0 };
}

/** Every operation the calls make, over the bindings found, and the calls on a local written again. */
function sitesUnder(project, cfg, bindings) {
  const sites = [];
  const unreadLocals = [];
  for (const call of project.calls) {
    const read = readCall(project, call, classOfCall(project, call), bindings, cfg);
    if (read?.unreadLocal) unreadLocals.push(call);
    if (!read || !read.op) continue;
    sites.push({ call, op: read.op, receiver: read.value, ...siteEntity(read, call), args: read.args, rest: read.rest, index: read.index, line: read.line, segs: read.segs, cond: Boolean(call.cond) });
  }
  return { sites, bindings, unreadLocals };
}

/**
 * The rule, ready to read a project: `sitesOf(project)` gives every TypeORM
 * operation its calls make, in call order, each `{call, op, receiver, entity,
 * args, argsFrom, rest, index, line, cond}`, and `unreadLocals`, the calls on
 * a local that held a repository or a manager and is written again.
 */
function compile(rule) {
  const cfg = rule.params;
  // Twice: a local may hold a repository taken from a transaction's manager.
  const sitesOf = (project) => sitesUnder(project, cfg, bindingsOf(project, cfg, bindingsOf(project, cfg, new Map())));
  return { rule: rule.id, sitesOf };
}

/** A site as an example writes it: the receiver chain up to the operation, a call on the way shown with its first argument. */
function siteText(site) {
  const argText = (a) => (!a ? '' : a.k === 'id' ? a.v : a.k === 'str' ? `'${a.v}'` : '...');
  return site.segs.slice(0, site.index + 1).map((s, i) => (s.args && i < site.index ? `${s.name}(${argText(s.args[0])})` : s.name)).join('.');
}

function runExamples(entries, env) {
  if (!env || typeof env.tsFacts !== 'function') return { notRun: 'no TypeScript reader was handed in' };
  const results = new Map(entries.map((entry) => [entry.id, entry.rule.examples.map((ex, i) => {
    const project = exampleProject(env.tsFacts(`${entry.id}/example${i}.ts`, ex.source));
    const got = entry.compiled.sitesOf(project).sites.map((s) => ({ call: siteText(s), receiver: s.receiver.kind, entity: s.entity ? s.entity.name ?? s.entity.entityName : null }));
    return { example: ex, passed: JSON.stringify(got) === JSON.stringify(ex.expect.map((e) => ({ call: e.call, receiver: e.receiver, entity: e.entity }))), got };
  })]));
  return { results };
}

export const typeormReceiver = Object.freeze({
  name: 'typeorm.receiver',
  lane: 'ts',
  stage: 'ts-facts',
  gradeCap: null,
  validateParams,
  validateExample,
  compile,
  runExamples,
});
