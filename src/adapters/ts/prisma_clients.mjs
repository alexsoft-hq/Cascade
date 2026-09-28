// prisma_clients.mjs — which receivers are Prisma clients: a field typed with one, a transaction callback's parameter, and a client `$extends` makes of either.
//
// A field is a client when it is typed with a type the `ts.type-role` rules
// name, or with a project class that extends one. Inside an interactive
// transaction, `this.<field>.$transaction(async (tx) => {...})`, the callback's
// client parameter is a client too, for the calls written inside it.
//
// `$extends` (the rule's `extensions.methods`) returns a client of the same
// database. A local that holds one, `const x = this.prisma.$extends({...})`, or
// one a method of the class hands back, `const x = this.client()` where every
// return of `client()` is `this.<field>.$extends(...)` or the field itself, is
// a client for the calls made through it from that line on.
// How sure such a call is depends on the extension: one written as an object
// (there, or handed to the define call, `Prisma.defineExtension`, whose result
// a local of the same member holds) with no component the rule names as
// rewriting (`query`, which intercepts an operation and may change what it
// sends, or send something else) leaves the call as sure as its client; one
// this engine cannot read, or one with such a component, makes it HEURISTIC,
// since what the call sends is then the extension's to decide. The fields its
// result component computes (the rule's `extensions.computed`) are read here
// too, each with the fields it needs, for the operation rule to read a select
// of one as those fields.
//
// A LOCAL IS A DECLARATION, NOT A NAME. The worker says which local a call's
// receiver is (`rootAt`, where the file declares it): the same name declared
// again in an inner block, or a parameter of an inner function that shadows
// the transaction's, is another local, and a call on it is not a client call.
// A local written again anywhere it is in scope (`x = other`) may hold anything
// by the time of a call, so it holds a client nowhere; its calls stay unread,
// with that reason.

import { callerOf } from './ts_calls.mjs';
import { fieldOf, methodOf } from './project.mjs';

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weakest = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** The client role a meaning plays under the rules, or null. */
function roleOfMeaning(rules, meaning) {
  const hit = rules.find((r) => r.compiled.means(meaning));
  return hit ? { grade: hit.compiled.grade, rule: hit.id, library: hit.compiled.library } : null;
}

/** The client role of a type named in `file`: the type itself, or a project class whose lineage extends one. */
function clientRoleOf(project, rules, file, typeName) {
  const meaning = project.meaning(file, typeName);
  if (!meaning) return null;
  if (meaning.external) return roleOfMeaning(rules, meaning);
  const cls = project.files.get(meaning.file)?.classes.get(meaning.name);
  for (const c of cls ? project.lineage(cls) : []) {
    const role = c.extends ? roleOfMeaning(rules, project.meaning(c.file, c.extends.split('.')[0])) : null;
    if (role) return role;
  }
  return null;
}

/** The client role of a field of `cls`, or null: a client field is always read off `this`, so a caller with no class has none. */
function clientFieldRole(project, rules, cls, fieldName) {
  if (!cls) return null;
  const hit = fieldOf(project, cls, fieldName);
  return hit && hit.field.type ? clientRoleOf(project, rules, hit.cls.file, hit.field.type) : null;
}

/** A client as a call site uses it: its role, the grade its calls are capped at, and the extension it came through, if any. */
const plainClient = (role) => ({ role, grade: role.grade, extension: null });

/** The client `$extends(arg)` makes of one with `role`: as sure as it when the extension is read whole and rewrites nothing, else HEURISTIC. */
function extendedClient(role, method, arg, ext) {
  const read = Boolean(arg) && arg.k === 'obj' && !arg.spread && !arg.computed;
  const components = read ? Object.keys(arg.v).sort() : [];
  const rewriting = components.filter((c) => ext.rewriting.includes(c));
  const sure = read && rewriting.length === 0;
  return {
    role, grade: sure ? role.grade : weakest(role.grade, 'HEURISTIC'), extension: { method, read, components, ...(rewriting.length > 0 ? { rewriting } : {}) },
    computed: read ? computedFields(arg, ext.computed) : null,
  };
}

/**
 * What one computed field needs, as its extension writes it: the fields its
 * `needs` object sets to true, none when it writes no `needs`, and null when
 * the source does not say (a `needs` that is not an object literal of true and
 * false).
 */
function needsOf(field, key) {
  if (field.k !== 'obj' || field.spread || field.computed) return null;
  const needs = field.v[key];
  if (!needs) return [];
  if (needs.k !== 'obj' || needs.spread || needs.computed || Object.values(needs.v).some((v) => v.k !== 'bool')) return null;
  return Object.entries(needs.v).filter(([, v]) => v.v === true).map(([name]) => name).sort();
}

/**
 * The fields an extension's result component (the rule's `extensions.computed`)
 * computes: `{open, all, byModel}`, the set it names for every model and the
 * set under each model key, each `{open, fields}`, every field with what it
 * needs. A set is OPEN where a spread or a computed key may add fields to it or
 * replace the ones written (the worker keeps no order, so a spread before a
 * field and one after it read the same): what a field of an open set needs is
 * not known. A spread in the component itself opens every model's set, and a
 * model key whose value is not written out opens that model's.
 */
function computedFields(arg, cfg) {
  const comp = cfg ? arg.v[cfg.component] : null;
  if (!comp) return null;
  if (comp.k !== 'obj') return { open: true, all: null, byModel: {} };
  const open = Boolean(comp.spread || comp.computed);
  const out = { open, all: null, byModel: {} };
  for (const [key, fields] of Object.entries(comp.v)) {
    const set = fields.k === 'obj'
      ? { open: open || Boolean(fields.spread || fields.computed), fields: Object.fromEntries(Object.entries(fields.v).map(([name, f]) => [name, needsOf(f, cfg.needs)])) }
      : { open: true, fields: {} };
    if (key === cfg.allModels) out.all = set;
    else out.byModel[key] = set;
  }
  return out;
}

/** Whether a call is the pack's define call (`Prisma.defineExtension`), by the package and export its receiver is imported as. */
function isDefineCall(project, define, call) {
  const parts = call.callee.split('.');
  if (parts.length !== 2 || parts[1] !== define.method) return false;
  const meaning = project.meaning(call.file, parts[0]);
  return Boolean(meaning?.external) && meaning.external === define.module && meaning.name === define.export;
}

/**
 * The extension an `$extends` argument is. An object written there is itself.
 * A local of the same member that holds the define call's result, and is not
 * written again, is the object that call is handed, or, for a function
 * `(client) => client.$extends({...})`, the object `$extends` is handed on that
 * function's own parameter: what the extension does is read there. Anything
 * else is the argument as it stands, which is not read.
 */
function extensionArg(project, ctx, call) {
  const arg = call.args[0];
  const define = ctx.ext.define;
  if (!arg || arg.k !== 'id' || !define || !arg.at || arg.reassigned) return arg;
  const held = ctx.callsIn(call.file, call.in).filter((c) => c.holderAt === arg.at);
  if (held.length !== 1 || held[0].line > call.line || !isDefineCall(project, define, held[0])) return arg;
  const x = held[0].args[0];
  const param = x && x.k === 'fn' ? x.paramsAt?.[0] : null;
  if (!param) return x;
  const inner = ctx.callsIn(call.file, call.in).filter((c) => c.rootAt === param && !c.rootReassigned && ctx.ext.methods.some((m) => c.callee === `${x.params[0]}.${m}`));
  return inner.length === 1 ? inner[0].args[0] : arg;
}

/** The client a `this.<field>.<extends>(...)` call makes, in class `cls`, or null. */
function extendsCall(project, ctx, call, cls) {
  const parts = call.callee.split('.');
  if (parts.length !== 3 || parts[0] !== 'this' || !ctx.ext.methods.includes(parts[2])) return null;
  const role = clientFieldRole(project, ctx.rules, cls, parts[1]);
  return role ? extendedClient(role, parts[2], extensionArg(project, ctx, call), ctx.ext) : null;
}

/** What one `return` of a method of `cls` hands back, as a client: the client field itself, or a client `$extends` made of it. */
function returnedClient(project, ctx, cls, member, r) {
  const parts = r.k === 'member' || r.k === 'call' ? (r.v ?? r.callee).split('.') : [];
  if (r.k === 'member' && parts.length === 2 && parts[0] === 'this') {
    const role = clientFieldRole(project, ctx.rules, cls, parts[1]);
    return role ? plainClient(role) : null;
  }
  if (r.k !== 'call') return null;
  const call = ctx.callsIn(cls.file, member).find((c) => c.line === r.line && c.callee === r.callee);
  return call ? extendsCall(project, ctx, call, cls) : null;
}

/** The client `this.<method>()` hands back, when every return of the method (as the class or one it extends declares it) is one. */
function methodClient(project, ctx, cls, name) {
  const hit = cls ? methodOf(project, cls, name) : null;
  const returns = hit?.method.returns ?? [];
  if (returns.length === 0) return null;
  const made = returns.map((r) => returnedClient(project, ctx, hit.cls, `${hit.cls.name}.${name}`, r));
  if (made.some((m) => !m)) return null;
  const weakestMade = made.reduce((a, b) => (RANK[b.grade] < RANK[a.grade] ? b : a));
  // A field only some of the returned clients compute is not known to be computed.
  const computed = made.every((m) => JSON.stringify(m.computed ?? null) === JSON.stringify(made[0].computed ?? null)) ? made[0].computed ?? null : null;
  return { ...weakestMade, computed, returnedBy: `${hit.cls.name}.${name}` };
}

/** The client a call expression makes, in class `cls`, or null. */
function clientMadeBy(project, ctx, call, cls) {
  const parts = call.callee.split('.');
  if (parts.length === 2 && parts[0] === 'this') return methodClient(project, ctx, cls, parts[1]);
  return extendsCall(project, ctx, call, cls);
}

/** The local a call's result is held in, as a client, keyed `file|place`: from the line it is held on, what made it. */
function holderBinding(project, ctx, call, caller) {
  if (!call.holder || !call.holderAt || !caller?.cls) return null;
  const made = clientMadeBy(project, ctx, call, caller.cls);
  if (!made) return null;
  const { role, grade, extension, computed, returnedBy } = made;
  const answer = { role, grade, extension, computed: computed ?? null, ...(returnedBy ? { returnedBy } : {}), heldIn: call.holder, transaction: null };
  return { key: `${call.file}|${call.holderAt}`, line: call.line, answer };
}

/** A call `this.<field>.$transaction(fn, ...)`, `fn` the first function-valued argument, whose parameter at `clientParam` is a client inside it. */
function transactionBinding(project, rules, call, caller, txConfig) {
  const parts = call.callee.split('.');
  if (!txConfig || !caller || parts.length !== 3 || parts[0] !== 'this' || parts[2] !== txConfig.method) return null;
  const role = clientFieldRole(project, rules, caller.cls, parts[1]);
  const fn = call.args.find((a) => a.k === 'fn');
  const at = fn?.paramsAt?.[txConfig.clientParam] ?? null;
  if (!role || !at) return null;
  return { key: `${call.file}|${at}`, line: fn.line, answer: { ...plainClient(role), computed: null, transaction: txConfig.method } };
}

/**
 * Every local that is a client, keyed `file|place` (where the file declares
 * it): a local holding a client that `$extends` or a method of the class made,
 * and a transaction callback's client parameter.
 */
function localBindings(project, ctx, txConfig) {
  const out = new Map();
  const holders = ctx.ext.methods.length > 0;
  for (const call of project.calls) {
    const caller = callerOf(project, call);
    const b = (holders ? holderBinding(project, ctx, call, caller) : null) ?? transactionBinding(project, ctx.rules, call, caller, txConfig);
    if (b && !out.has(b.key)) out.set(b.key, b);
  }
  return out;
}

/** The calls of one member, indexed once. */
function callsByMember(project) {
  const index = new Map();
  for (const c of project.calls) {
    const key = `${c.file}|${c.in}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(c);
  }
  return (file, member) => index.get(`${file}|${member}`) ?? [];
}

/**
 * How this project's calls are read as client calls. The answer for one call
 * is `{role, grade, delegate, operation, transaction, extension, computed}`,
 * or null: `this.<field>.<delegate>.<operation>(...)` on a client field;
 * `<param>.<delegate>.<operation>(...)` on a transaction callback's own client
 * parameter; and `<local>.<delegate>.<operation>(...)` on a local holding a
 * client `$extends` made. `whyNot(call)` says why a call on a local that held
 * a client is not read: the local is written again.
 *
 * @param {object} project  readProject's answer
 * @param {{clientRules:object[], transaction:(object|null), extensions:(object|null)}} rules
 */
export function clientReader(project, { clientRules, transaction, extensions }) {
  const ctx = { rules: clientRules, ext: extensions ?? { methods: [], rewriting: [] }, callsIn: callsByMember(project) };
  const locals = localBindings(project, ctx, transaction);
  const localOf = (call) => (call.rootAt ? locals.get(`${call.file}|${call.rootAt}`) ?? null : null);
  const read = (call, caller) => {
    const parts = call.callee.split('.');
    if (parts.length === 4 && parts[0] === 'this') {
      const role = clientFieldRole(project, clientRules, caller.cls, parts[1]);
      return role ? { ...plainClient(role), computed: null, delegate: parts[2], operation: parts[3], transaction: null } : null;
    }
    const b = parts.length === 3 && !call.rootReassigned ? localOf(call) : null;
    return b && b.line <= call.line ? { ...b.answer, delegate: parts[1], operation: parts[2] } : null;
  };
  read.whyNot = (call) => (call.rootReassigned && localOf(call) ? `${call.callee.split('.')[0]} held a Prisma client and is assigned again, so what it holds at this call is not known` : null);
  return read;
}
