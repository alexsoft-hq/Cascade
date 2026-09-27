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
// a client for the calls made through it from that line on, in that member.
// How sure such a call is depends on the extension: one written as an object
// (there, or handed to the define call, `Prisma.defineExtension`, whose result
// a local of the same member holds) with no component the rule names as
// rewriting (`query`, which intercepts an operation and may change what it
// sends, or send something else) leaves the call as sure as its client; one
// this engine cannot read, or one with such a component, makes it HEURISTIC,
// since what the call sends is then the extension's to decide.

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
  return { role, grade: sure ? role.grade : weakest(role.grade, 'HEURISTIC'), extension: { method, read, components, ...(rewriting.length > 0 ? { rewriting } : {}) } };
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
 * A name the same member holds, once, from the define call is the object that
 * call is handed, or, for a function `(client) => client.$extends({...})`, the
 * object that inner `$extends` is handed: what the extension does is read
 * there. Anything else is the argument as it stands, which is not read.
 */
function extensionArg(project, ctx, call) {
  const arg = call.args[0];
  const define = ctx.ext.define;
  if (!arg || arg.k !== 'id' || !define) return arg;
  const held = ctx.callsIn(call.file, call.in).filter((c) => c.holder === arg.v);
  if (held.length !== 1 || held[0].line > call.line || !isDefineCall(project, define, held[0])) return arg;
  const x = held[0].args[0];
  if (!x || x.k !== 'fn' || !x.params[0]) return x;
  const inner = ctx.callsIn(call.file, call.in).filter((c) => c.line >= x.line && c.line <= x.endLine && ctx.ext.methods.some((m) => c.callee === `${x.params[0]}.${m}`));
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
  return { ...weakestMade, returnedBy: `${hit.cls.name}.${name}` };
}

/** The client a call expression makes, in class `cls`, or null. */
function clientMadeBy(project, ctx, call, cls) {
  const parts = call.callee.split('.');
  if (parts.length === 2 && parts[0] === 'this') return methodClient(project, ctx, cls, parts[1]);
  return extendsCall(project, ctx, call, cls);
}

/**
 * Every local a member holds a client in, keyed `file|member|name`, each with
 * the line it is held from. A name held more than once in a member is a client
 * only where every value it holds is one: one that holds something else as
 * well is not read, and its calls stay unread.
 */
function holderBindings(project, ctx) {
  const byKey = new Map();
  for (const call of project.calls) {
    if (!call.holder) continue;
    const caller = callerOf(project, call);
    const made = caller?.cls ? clientMadeBy(project, ctx, call, caller.cls) : null;
    const key = `${call.file}|${call.in}|${call.holder}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(made ? { ...made, line: call.line } : null);
  }
  const out = new Map();
  for (const [key, list] of byKey) if (list.every(Boolean)) out.set(key, list.sort((a, b) => a.line - b.line));
  return out;
}

/** A call `this.<field>.$transaction(fn, ...)`, `fn` the first function-valued argument, whose parameter at `clientParam` names a client too. */
function transactionBinding(project, rules, call, caller, txConfig) {
  const parts = call.callee.split('.');
  if (parts.length !== 3 || parts[0] !== 'this' || parts[2] !== txConfig.method) return null;
  const role = clientFieldRole(project, rules, caller.cls, parts[1]);
  const fn = call.args.find((a) => a.k === 'fn');
  const param = fn ? fn.params[txConfig.clientParam] : null;
  if (!role || !fn || !param) return null;
  return { role, param, method: txConfig.method, file: call.file, member: call.in, from: fn.line, to: fn.endLine };
}

/** Every interactive-transaction callback whose client parameter is bound, across the project. */
function transactionBindings(project, rules, txConfig) {
  if (!txConfig) return [];
  const out = [];
  for (const call of project.calls) {
    const caller = callerOf(project, call);
    const b = caller ? transactionBinding(project, rules, call, caller, txConfig) : null;
    if (b) out.push(b);
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
 * is `{role, grade, delegate, operation, transaction, extension}`, or null:
 * `this.<field>.<delegate>.<operation>(...)` on a client field;
 * `<param>.<delegate>.<operation>(...)` inside a transaction callback; and
 * `<local>.<delegate>.<operation>(...)` through a client `$extends` made.
 *
 * @param {object} project  readProject's answer
 * @param {{clientRules:object[], transaction:(object|null), extensions:(object|null)}} rules
 */
export function clientReader(project, { clientRules, transaction, extensions }) {
  const ctx = { rules: clientRules, ext: extensions ?? { methods: [], rewriting: [] }, callsIn: callsByMember(project) };
  const bindings = transactionBindings(project, clientRules, transaction);
  const holders = ctx.ext.methods.length > 0 ? holderBindings(project, ctx) : new Map();
  return (call, caller) => {
    const parts = call.callee.split('.');
    if (parts.length === 4 && parts[0] === 'this') {
      const role = clientFieldRole(project, clientRules, caller.cls, parts[1]);
      return role ? { ...plainClient(role), delegate: parts[2], operation: parts[3], transaction: null } : null;
    }
    if (parts.length !== 3) return null;
    const b = bindings.find((x) => x.file === call.file && x.member === call.in && x.param === parts[0] && call.line >= x.from && call.line <= x.to);
    if (b) return { ...plainClient(b.role), delegate: parts[1], operation: parts[2], transaction: b.method };
    const held = (holders.get(`${call.file}|${call.in}|${parts[0]}`) ?? []).filter((h) => h.line <= call.line).pop();
    if (!held) return null;
    const { role, grade, extension, returnedBy } = held;
    return { role, grade, extension, ...(returnedBy ? { returnedBy } : {}), heldIn: parts[0], delegate: parts[1], operation: parts[2], transaction: null };
  };
}
