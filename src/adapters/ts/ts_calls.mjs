// ts_calls.mjs — the TypeScript lane's symbols and the calls between them.
//
// A symbol is a method of a class, `symbol:<file>#<Class.method>`, or a module
// function, `symbol:<file>#<name>`: the web lane's shape, so a file never gets
// two ids. A call is linked when the project says what it reaches:
//
//   this.m()        a method of the class, or of a class it extends
//   this.dep.m()    a method of the class `dep` is typed with, where `dep` is
//                   a constructor parameter property or a property of the class
//   f(), Cls.m()    a function or a static method a name of the file means
//
// Each is MAY_CALL at SOUND_SET, the Java lane's grade for a call through a
// field: a provider can be swapped (`useClass`) and a subclass can override, so
// the target is in the set named, not proven to be the only one. Anything else
// (a local variable, a callback parameter, a package) is counted, not guessed.
//
// When a class of the project extends or implements the type a call goes
// through, the call reaches that class's method as well (dispatch.mjs): a call
// through an abstract class or an interface reaches the classes that implement
// it, and `this.m()` reaches each override. What a Nest module binds to the
// type narrows that set (nest_providers.mjs), and the edges say so.

import { nodeId } from '../../core/graph.mjs';
import { fieldOf, methodOf } from './project.mjs';
import { methodsRunBy, typeTargets } from './dispatch.mjs';

export const methodSymbolId = (file, cls, method) => nodeId('symbol', `${file}#${cls}.${method}`);
export const functionSymbolId = (file, name) => nodeId('symbol', `${file}#${name}`);

/** Every method and module function of the project as a symbol node. */
export function addSymbols(g, project) {
  let count = 0;
  for (const [file, f] of project.files) {
    for (const cls of f.classes.values()) {
      for (const m of cls.methods.values()) {
        g.addNode({ id: methodSymbolId(file, cls.name, m.name), symbol: `${file}#${cls.name}.${m.name}`, owner: cls.key, file, line: m.line ?? null, lane: 'ts' });
        count += 1;
      }
    }
    for (const fn of f.functions.values()) {
      g.addNode({ id: functionSymbolId(file, fn.name), symbol: `${file}#${fn.name}`, file, line: fn.line ?? null, lane: 'ts', exported: fn.exported });
      count += 1;
    }
  }
  return count;
}

/** The symbol a call is written in, or null for a call at module level. */
export function callerOf(project, call) {
  if (call.in === null) return null;
  const dot = call.in.indexOf('.');
  if (dot < 0) return project.files.get(call.file)?.functions.has(call.in) ? { id: functionSymbolId(call.file, call.in) } : null;
  const cls = project.files.get(call.file)?.classes.get(call.in.slice(0, dot));
  return cls ? { id: methodSymbolId(call.file, cls.name, call.in.slice(dot + 1)), cls } : null;
}

/** The class a field of `cls` is typed with, when the project has it. */
export function fieldClassOf(project, cls, name) {
  const hit = fieldOf(project, cls, name);
  return hit && hit.field.type ? project.classOf(hit.cls.file, hit.field.type) : null;
}

const idOf = (hit) => methodSymbolId(hit.cls.file, hit.cls.name, hit.method.name);

const methodTarget = (project, cls, name) => {
  const hit = cls ? methodOf(project, cls, name) : null;
  return hit ? { to: [idOf(hit)] } : null;
};

/**
 * What the modules' bindings say of the set, as the edge says it: the modules
 * that bound it and which reading settled it, or why the set may be short.
 */
const bindingSaid = (bound, all) => (bound.classes
  ? { bound: bound.modules, boundBy: bound.by === 'loaded' ? 'the modules the application loads' : 'every module of the tree', narrowedFrom: all }
  : { incomplete: bound.reason });

/**
 * A call through a value of `type`: the type's own method as it always was
 * when no class of the project changes the answer, else every method the
 * value may run, each edge carrying the set. `narrowed` is what the modules'
 * bindings make of the set, when one is asked. The set is SOUND_SET when it is
 * complete: `this` is always an instance of a class of the tree unless the
 * type's package may be published, and a field holds what the bindings settle.
 * Otherwise it is HEURISTIC, and the edge says why it may be short.
 */
function throughType(ctx, type, name, rules, narrowed = null) {
  const t = typeTargets(ctx.project, ctx.subtypesOf, type, name);
  if (t.plain) return { to: [idOf(t.own)], rule: rules[0] };
  const bound = narrowed ? narrowed() : null;
  const set = bound?.classes ? methodsRunBy(ctx.project, bound.classes, name) : t.all;
  if (set.length === 0) return null;
  const said = bound ? bindingSaid(bound, t.all.length) : {};
  const published = ctx.published(type.file);
  const incomplete = said.incomplete ?? published;
  const dispatch = { type: type.key, candidates: set.length, ...said, ...(incomplete ? { incomplete } : {}) };
  return { to: set.map(idOf), rule: rules[1], dispatch, grade: incomplete ? 'HEURISTIC' : 'SOUND_SET', narrowed: Boolean(bound?.classes) };
}

/** `this.dep.m()`: through the type of the field `dep`, which the modules may say more about. */
function fieldCall(ctx, caller, fieldName, name) {
  const hit = fieldOf(ctx.project, caller.cls, fieldName);
  const type = hit && hit.field.type ? ctx.project.typeOf(hit.cls.file, hit.field.type) : null;
  if (!type) return null;
  const narrowed = () => (ctx.bindings ? ctx.bindings.narrow({ holder: caller.cls, field: hit, type }) : { reason: 'no NestJS module rule is read, so what fills the field is not known' });
  return throughType(ctx, type, name, ['ts-injected-field', 'ts-field-dispatch'], narrowed);
}

/** What one call reaches, as `{to: [ids], rule, dispatch?}`, or null. */
function targetOf(ctx, call, caller) {
  const { project } = ctx;
  const parts = call.callee.split('.');
  if (parts[0] === 'this' && parts.length === 2) return caller.cls ? throughType(ctx, caller.cls, parts[1], ['ts-this-method', 'ts-this-dispatch']) : null;
  if (parts[0] === 'this' && parts.length === 3) return caller.cls ? fieldCall(ctx, caller, parts[1], parts[2]) : null;
  if (parts.length === 1) {
    const m = project.meaning(call.file, parts[0]);
    const fn = m && !m.external ? project.files.get(m.file)?.functions.get(m.name) : null;
    return fn ? { to: [functionSymbolId(m.file, m.name)], rule: 'ts-function' } : null;
  }
  if (parts.length === 2) {
    const to = methodTarget(project, project.classOf(call.file, parts[0]), parts[1]);
    return to && { ...to, rule: 'ts-static-method' };
  }
  return null;
}

const CALL_BASIS = Object.freeze({
  'ts-this-method': 'a method of the same class, or of a class it extends; a subclass may override it',
  'ts-injected-field': 'a method of the class a constructor-injected field is typed with; the provider may be another class of that type',
  'ts-function': 'a function the file declares or imports by name',
  'ts-static-method': 'a static method of a class the file names',
  'ts-this-dispatch': 'this may be an instance of any class of the project that extends this one, so the call runs the nearest declaration of the method for each of them',
  'ts-field-dispatch': 'the field may hold any class the modules bind to the type it is declared with, or, where they do not settle it, any class of the project that extends or implements that type; the call runs the nearest declaration of the method for each',
});

/**
 * Whether a call goes into a package: a function or a class the file imports
 * from one, or a method of a field typed with one. Its code is not read, so it
 * is no gap in this project's links.
 */
function intoPackage(project, call, caller) {
  const parts = call.callee.split('.');
  if (parts[0] !== 'this') return Boolean(project.meaning(call.file, parts[0])?.external);
  const hit = parts.length >= 3 && caller.cls ? fieldOf(project, caller.cls, parts[1]) : null;
  return Boolean(hit?.field.type && project.meaning(hit.cls.file, hit.field.type)?.external);
}

/** The edges of one linked call, one per target this graph holds; the count of them. */
function linkCall(g, call, caller, target, seen) {
  let edges = 0;
  for (const to of target.to) {
    const key = `${caller.id}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // An evidence object of its own for each edge, so nothing said of one edge is said of its siblings.
    const evidence = { rule: target.rule, basis: CALL_BASIS[target.rule], line: call.line, ...(target.dispatch ? { dispatch: { ...target.dispatch } } : {}) };
    g.addEdge({ from: caller.id, to, type: 'MAY_CALL', grade: target.grade ?? 'SOUND_SET', evidence });
    edges += 1;
  }
  return edges;
}

const fileOfSymbol = (id) => id.slice('symbol:'.length, id.indexOf('#'));
const bump = (stats, key, n = 1) => { stats[key] = (stats[key] ?? 0) + n; };

/** A call's count: linked (into a file outside the application, through a type the project extends); into a package; or on a receiver this lane does not type. */
function countCall(stats, target, call, caller, ctx, edges) {
  if (!target) { stats[intoPackage(ctx.project, call, caller) ? 'external' : 'unresolved'] += 1; return; }
  stats.resolved += 1;
  if (ctx.outside && target.to.some((to) => ctx.outside(fileOfSymbol(to)))) bump(stats, 'intoReached');
  if (!target.dispatch) return;
  bump(stats, 'dispatched');
  bump(stats, 'dispatchEdges', edges);
  if (target.narrowed) bump(stats, 'narrowed');
  if (target.grade === 'HEURISTIC') bump(stats, 'dispatchHeuristic');
}

/**
 * Every call the project resolves, as MAY_CALL edges. The rest are counted:
 * `external` goes into a package, `unresolved` is a receiver this lane does not
 * type (a local variable, a parameter, a chain through a field). Of the linked
 * ones, a call through a type the project extends or implements counts once
 * in `dispatched`, and its edges in `dispatchEdges`; `narrowed` counts those a
 * module's binding narrowed; `dispatchHeuristic` those graded HEURISTIC, whose
 * set may be short; `intoReached` those that reach a file outside the
 * application. Each is absent when it would be zero.
 *
 * @param {{subtypesOf:Function, bindings:(object|null), outside:((file:string)=>boolean)|null, published:((file:string)=>(string|null))}} opts
 *   dispatch.mjs's subtype index, nest_providers.mjs's bindings, which files are outside the application,
 *   and why a file's package may be published (null when it is not)
 */
export function addCalls(g, project, { subtypesOf, bindings = null, outside = null, published = () => null }) {
  const stats = { resolved: 0, external: 0, unresolved: 0 };
  const ctx = { project, subtypesOf, bindings, outside, published };
  const seen = new Set();
  for (const call of project.calls) {
    const caller = callerOf(project, call);
    if (!caller) continue;
    const found = targetOf(ctx, call, caller);
    const target = found && found.to.some((to) => g.nodes.has(to)) ? { ...found, to: found.to.filter((to) => g.nodes.has(to)) } : null;
    const edges = target ? linkCall(g, call, caller, target, seen) : 0;
    countCall(stats, target, call, caller, ctx, edges);
  }
  return stats;
}
