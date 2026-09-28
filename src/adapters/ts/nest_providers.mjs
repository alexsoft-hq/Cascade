// nest_providers.mjs — what a NestJS application injects for a type: the classes the modules bind to it.
//
// Nest fills a constructor parameter with what the modules bind to its type:
// `providers: [UsersService]` binds the class to itself, and
// `{ provide: UserRepository, useClass: UsersRelationalRepository }` binds an
// abstract class to the class Nest makes for it. So a call through such a
// parameter runs a method of a class some module binds to the type, and the
// call's candidate set (src/adapters/ts/dispatch.mjs) is those classes, when
// the modules that could bind it are all read:
//
//   - the modules the application LOADS, from its root module through each
//     one's imports (a module class, a constant the file says holds one of
//     several, `X.forRoot()` read from the object it returns), when that walk
//     is read whole: they are the ones Nest reads;
//   - else EVERY module of the tree, static and dynamic, when every one of them
//     is read whole: whichever of them the application loads, what it binds is
//     among theirs. A module an import this engine cannot name may be one that
//     binds the type another way (a module an ordinary function builds), so one
//     such import anywhere in the tree leaves the set unsettled.
//
// A set settled either way is complete: the edge says which modules bound it.
// One that is not stays the whole hierarchy, and the edge says why it may be
// short (src/adapters/ts/ts_calls.mjs grades it HEURISTIC): a binding made by a
// factory, a value or another token; a provider, an import or a module this
// engine cannot read; a package's module handed the type; a parameter
// decorator that fills it by a token, or one the rule does not name; a class
// made by hand with `new`, whose parameter is whatever it is handed. The names
// these are read by are the rule's (src/core/rules/packs/nestjs.json,
// `nestjs.providers`).

import { fieldOf } from './project.mjs';
import { frameworkName, isPackageModule, moduleClassOf, viewsOf } from './nest_routes.mjs';

const MAX_MODULES = 2000;
const MAX_ALIAS_DEPTH = 4;
const LITERAL = new Set(['str', 'num', 'bool', 'null', 'undefined', 'none', 'tpl']);

/**
 * The value names a value mentions, at any depth: a package's module handed
 * one may bind it. What sits under a key in `skip` is read by the package and
 * bound by it to nothing else (the modules it imports, the tokens its factory
 * is handed), so it is not counted.
 */
function namesIn(v, skip, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (v.k === 'id') out.push(v.v);
  const inner = Array.isArray(v.v) ? v.v : v.k === 'obj' ? Object.entries(v.v).filter(([k]) => !skip.has(k)).map(([, x]) => x) : [];
  for (const x of [...inner, ...(v.args ?? [])]) namesIn(x, skip, out);
  return out;
}

const merge = (parts) => ({
  modules: parts.flatMap((p) => p.modules ?? []), dynamic: parts.flatMap((p) => p.dynamic ?? []), packages: parts.flatMap((p) => p.packages ?? []),
  unread: parts.map((p) => p.unread).find(Boolean) ?? null,
});

/** Why an import is one this engine cannot name, in its words. */
function unreadImport(v) {
  if (v?.k === 'call') return `${v.callee ?? 'a call'}(...), which may build a module a way this engine does not read`;
  return v?.k === 'id' ? `${v.v}, a value this engine cannot name` : 'an import this engine cannot name';
}

/** A module class an import names: the class, and the static method whose module it is when one is called (`X.forRoot()`). */
function moduleImport(cls, v) {
  const method = v.k === 'call' && v.callee?.includes('.') ? v.callee.split('.').slice(1).join('.') : null;
  return { modules: [cls], ...(method ? { dynamic: [{ cls, method }] } : {}) };
}

/**
 * What one entry of a module's `imports` loads: module classes (a class,
 * `forwardRef(() => X)`, a constant of the file that holds one or another),
 * the module a static method of one returns (`X.forRoot()`), a package's
 * module, or `unread` with why.
 */
function importsOf(project, file, v, depth = 0) {
  if (!v) return { unread: unreadImport(v) };
  if (v.k === 'call' && isPackageModule(project, file, v)) return { packages: [v] };
  const alias = v.k === 'id' ? project.aliasOf(file, v.v) : null;
  if (alias && depth < MAX_ALIAS_DEPTH) return merge(alias.values.map((x) => importsOf(project, alias.file, x, depth + 1)));
  const cls = moduleClassOf(project, file, v);
  if (cls) return moduleImport(cls, v);
  return v.k === 'id' && project.meaning(file, v.v)?.external ? { packages: [v] } : { unread: unreadImport(v) };
}

/**
 * The objects a static method returns, read as dynamic modules; `gaps` for a
 * return this engine cannot read (a variable, a call), which may be a module
 * that binds a type. A literal cannot be one.
 */
function dynamicModules(d) {
  const m = d.cls.methods.get(d.method);
  const at = `${d.cls.key}.${d.method}`;
  if (!m || !m.static) return { objs: [], gaps: [`${at}: a module this engine does not read, because the method is not the class's own`] };
  const objs = [];
  const gaps = [];
  for (const r of m.returns ?? []) {
    if (r.k === 'obj') objs.push({ at, file: d.cls.file, value: r });
    else if (!LITERAL.has(r.k)) gaps.push(`${at}: returns a value this engine cannot read, which may be a module that binds a type`);
  }
  return { objs, gaps };
}

/** A module's imports into the walk: what to walk next, which dynamic modules to read, and each gap. */
function takeImports(project, at, file, list, sink) {
  if (!list) return;
  if (list.k !== 'arr' || list.spread) sink.gaps.push(`${at}: its imports are not a list this engine can read whole`);
  for (const v of list.k === 'arr' ? list.v : []) {
    const r = importsOf(project, file, v);
    sink.modules.push(...(r.modules ?? []));
    sink.dynamic.push(...(r.dynamic ?? []));
    sink.packages.push(...(r.packages ?? []).map((p) => ({ at, file, value: p })));
    if (r.unread) sink.gaps.push(`${at}: ${r.unread}`);
  }
}

/** One dynamic module into the walk: its imports taken, the objects it returns kept for their providers. */
function takeDynamic(project, d, sink, seen) {
  const key = `${d.cls.key}.${d.method}`;
  if (seen.has(key)) return;
  seen.add(key);
  const { objs, gaps } = dynamicModules(d);
  sink.gaps.push(...gaps);
  for (const o of objs) {
    sink.objs.push(o);
    if (o.value.spread || o.value.computed) sink.gaps.push(`${o.at}: returns a module this engine cannot read whole`);
    takeImports(project, o.at, o.file, o.value.v.imports, sink);
  }
}

/** Whether a class returns a dynamic module from a static method of its own: `X.forRoot()` loads X through it. */
const holdsDynamicModules = (cls) => [...cls.methods.values()].some((m) => m.static && (m.returns ?? []).some((r) => r.k === 'obj'));

/**
 * One module's own declaration into the walk. A class loaded as a module that
 * no @Module this engine reads decorates (a project's own wrapper of it) binds
 * what it likes, unless it only holds the dynamic modules its static methods
 * return, which are read from what those return.
 */
function takeModule(project, mod, decl, sink) {
  if (!decl) {
    if (!holdsDynamicModules(mod)) sink.gaps.push(`${mod.key}: loaded as a module, and no module decorator this engine reads is on it`);
  } else if (!decl.readable) sink.gaps.push(`${mod.key}: its module options are not read`);
  else takeImports(project, mod.key, mod.file, decl.imports, sink);
}

/**
 * Every module `start` leads to through imports, the dynamic modules among
 * them read from what their method returns, and each reason the list may be
 * short. With `all`, every module class of the tree and every static method
 * of one is read as well, loaded or not.
 */
function modulesFrom(project, rules, viewOf, start, all = false) {
  const sink = { modules: [...start], dynamic: [], packages: [], gaps: [], objs: [] };
  const seen = new Map();
  const seenDynamic = new Set();
  while ((sink.modules.length > 0 || sink.dynamic.length > 0) && seen.size < MAX_MODULES) {
    if (sink.dynamic.length > 0) { takeDynamic(project, sink.dynamic.shift(), sink, seenDynamic); continue; }
    const mod = sink.modules.shift();
    if (seen.has(mod.key)) continue;
    seen.set(mod.key, mod);
    takeModule(project, mod, rules.routes.moduleOf(viewOf(mod)), sink);
    if (all) for (const m of mod.methods.values()) if (m.static && Array.isArray(m.returns)) sink.dynamic.push({ cls: mod, method: m.name });
  }
  return { modules: [...seen.values()], objs: sink.objs, packages: sink.packages, gaps: sink.gaps };
}

function bindingOf(byToken, key) {
  if (!byToken.has(key)) byToken.set(key, { classes: new Map(), modules: new Set(), notRead: [] });
  return byToken.get(key);
}

/** One providers entry into the bindings: the class Nest makes, the token it is bound to, or why it is not read. */
function addEntry(project, mod, e, acc) {
  if (e.unread) { acc.gaps.push(`${mod.key}: a provider this engine cannot read`); return; }
  const cls = e.useClass ? project.classOf(mod.file, e.useClass) : null;
  if (cls) acc.managed.add(cls.key);
  const shorthand = e.useClass && e.useClass === e.token;
  // A name alone that is neither a class of the project nor a package's may hold a provider object.
  if (shorthand && !cls && !project.meaning(mod.file, e.token)?.external) { acc.gaps.push(`${mod.key}: the provider ${e.token} is not a class this engine can name`); return; }
  const token = e.token ? project.typeOf(mod.file, e.token) : null;
  if (!token) return;
  const b = bindingOf(acc.byToken, token.key);
  b.modules.add(mod.key);
  if (cls) b.classes.set(cls.key, cls);
  else b.notRead.push(e.notRead ? `${e.notRead} in ${mod.key}` : `${e.useClass} in ${mod.key}, a class this engine does not read`);
}

/** A providers list into the bindings, with a gap when it is not read whole. */
function addList(project, mod, decl, acc) {
  if (!decl.readable) acc.gaps.push(`${mod.key}: its providers are not read`);
  if (decl.spread) acc.gaps.push(`${mod.key}: its providers are not a list this engine can read whole`);
  for (const e of decl.entries) addEntry(project, mod, e, acc);
}

/** What a reading's modules bind, the classes Nest makes (each provided class, each registered controller), and each reason it may be short. */
function readBindings(project, rules, viewOf, reading) {
  const acc = { byToken: new Map(), managed: new Set(), gaps: [...reading.gaps], handed: new Map() };
  for (const mod of reading.modules) {
    const view = viewOf(mod);
    const decl = rules.providers.providersOf(view);
    if (!decl) continue;
    addList(project, mod, decl, acc);
    for (const v of rules.routes.moduleOf(view)?.controllers.v ?? []) {
      const cls = v.k === 'id' ? project.classOf(mod.file, v.v) : null;
      if (cls) acc.managed.add(cls.key);
    }
  }
  for (const o of reading.objs) addList(project, { key: o.at, file: o.file }, rules.providers.providersIn(o.value), acc);
  const skip = new Set(rules.providers.consumed);
  for (const p of reading.packages) {
    for (const name of namesIn({ k: 'arr', v: p.value.args ?? [] }, skip)) {
      const t = project.typeOf(p.file, name);
      if (t) acc.handed.set(t.key, `${p.at}: ${p.value.callee}(...) is handed ${name}`);
    }
  }
  return acc;
}

/** Every module class of the tree, loaded or not. */
function treeModules(project, routes, viewOf) {
  return [...project.files.values()].flatMap((f) => [...f.classes.values()]).filter((c) => routes.moduleOf(viewOf(c)));
}

/** The class a token argument names: a class, or the one `forwardRef(() => X)` returns. */
function tokenClassOf(project, file, arg) {
  if (!arg) return null;
  if (arg.k === 'id') return project.typeOf(file, arg.v);
  const back = arg.k === 'call' && arg.args?.length === 1 && arg.args[0].k === 'fn' ? arg.args[0].returns : null;
  return back && back.k === 'id' ? project.typeOf(file, back.v) : null;
}

/**
 * Why a parameter's decorators leave what fills it unsettled: one that fills
 * it by a token other than its type, or one the rule does not name (a
 * project's own, another package's). Null when none does.
 */
function decoratorReason(project, rules, field, type) {
  for (const d of field.field.decorators ?? []) {
    const name = frameworkName(project, field.cls.file, d.name, rules.routes.packages);
    const what = name ? rules.providers.parameterDecorator(name) : 'unknown';
    if (what === 'harmless') continue;
    if (what === 'token' && tokenClassOf(project, field.cls.file, d.args[0])?.key === type.key) continue;
    return what === 'token' ? `the parameter is filled by the token @${d.name} names, not by its type`
      : `the parameter's decorator @${d.name} is not one the nestjs pack names, and may fill it by a token`;
  }
  return null;
}

/**
 * Why Nest's binding is not what fills this field: it is not a parameter of
 * the class's own constructor, its decorators say otherwise, or the code
 * makes the class (or a subclass) with `new` and hands it what it likes.
 */
function notInjected(project, rules, holder, field, type, madeByHand) {
  if (field.field.kind !== 'ctorParam' || field.cls.key !== holder.key) return { reason: 'the field is not a parameter of this class\'s own constructor, which is what Nest fills, so what it holds is set by code this engine does not follow' };
  const byDecorator = decoratorReason(project, rules, field, type);
  if (byDecorator) return { reason: byDecorator, decorator: true };
  const made = madeByHand(holder);
  return made ? { reason: `${made} makes the class with new, handing it whatever it likes` } : null;
}

/**
 * What one reading of the modules says of a type: the classes they bind, or
 * why they do not settle it, with the classes they were read to bind (`partial`)
 * and whether any binding names something other than the type (`rebound`).
 */
function settle(acc, type, unread) {
  const b = acc.byToken.get(type.key);
  const rebound = Boolean(b && (b.notRead.length > 0 || [...b.classes.keys()].some((k) => k !== type.key)));
  const partial = b ? [...b.classes.values()] : [];
  const where = acc.handed.get(type.key);
  if (where) return { reason: `${where}, and a package's module may bind it`, rebound: true, partial };
  if (acc.gaps.length > 0) return { reason: `${acc.gaps[0]}${acc.gaps.length > 1 ? `, and ${acc.gaps.length - 1} more` : ''}, so one may bind the type`, rebound, partial };
  if (!b) return { reason: 'no module binds the type', rebound, partial };
  if (b.notRead.length > 0) {
    unread.set(type.key, b.notRead);
    return { reason: `the type is bound by ${b.notRead.join(', ')}, which is not read`, rebound, partial };
  }
  return { classes: partial, modules: [...b.modules].sort(), rebound };
}

/**
 * Whether a `new` may make a class this engine cannot name: one through a local
 * (`new C()` after `const C = UsersService`), or through a field (`new
 * this.kind()`), unless the field is declared with a package's type
 * (mongoose's `Model<T>`), whose objects are the package's.
 */
function makesAnyClass(project, n) {
  if (n.rootAt) return true;
  const [head, field, ...rest] = n.callee.split('.');
  if (head !== 'this') return false;
  const cls = rest.length === 0 && n.in ? project.files.get(n.file)?.classes.get(n.in.split('.')[0]) : null;
  const hit = cls ? fieldOf(project, cls, field) : null;
  return !(hit?.field.type && project.meaning(hit.cls.file, hit.field.type)?.external);
}

/**
 * Where the code makes `holder`, or a class extending it, with `new`: the
 * first such place, or null. A `new` that may make a class this engine cannot
 * name is taken to make this one too.
 */
function makerOf(project, subtypesOf) {
  const byClass = new Map();
  let anyClass = null;
  for (const n of project.news ?? []) {
    const cls = n.rootAt ? null : project.classOf(n.file, n.callee);
    if (cls && !byClass.has(cls.key)) byClass.set(cls.key, `${n.file}:${n.line}`);
    if (!anyClass && makesAnyClass(project, n)) anyClass = `${n.file}:${n.line}, through ${n.callee}, which may hold any class,`;
  }
  return (holder) => [holder, ...subtypesOf(holder.key)].map((c) => byClass.get(c.key)).find(Boolean) ?? anyClass;
}

/** The two readings: the modules the application loads, and every module of the tree. */
function readings(project, rules, viewOf, { root, rootUnread }) {
  const loaded = root ? readBindings(project, rules, viewOf, modulesFrom(project, rules, viewOf, [root])) : null;
  const tree = readBindings(project, rules, viewOf, modulesFrom(project, rules, viewOf, treeModules(project, rules.routes, viewOf), true));
  // A root module the bootstrap does not name may be one that binds any type.
  if (rootUnread) tree.gaps.unshift('the module the application is created with is not one this engine can name');
  return { loaded, tree };
}

/**
 * THE BINDINGS of the tree, and of the application whose root module is
 * `root` when there is one: `narrow({holder, field, type})` is `{classes,
 * modules, by}` when the modules settle what a constructor parameter of
 * `holder` typed `type` is handed (`by` says which reading settled it), else
 * `{reason, rebound, partial, decorator}`; `diagnostics()` names each type
 * whose binding is not read.
 *
 * @param {object} project  readProject's answer
 * @param {{routes:object, providers:object}} rules  the ts.route-decorator and ts.provider-binding rules, compiled
 * @param {{root:(object|null), rootUnread:boolean}} app  the root module class, and whether the bootstrap names none
 * @param {(key:string)=>object[]} subtypesOf  dispatch.mjs's subtype index
 */
export function providerBindings(project, rules, app, subtypesOf) {
  if (!rules.routes || !rules.providers) return null;
  const viewOf = viewsOf(project, rules.routes);
  const { loaded, tree } = readings(project, rules, viewOf, app);
  const madeByHand = makerOf(project, subtypesOf);
  const unread = new Map();
  const narrow = ({ holder, field, type }) => {
    const byTree = settle(tree, type, unread);
    const why = notInjected(project, rules, holder, field, type, madeByHand);
    if (why) return { ...why, rebound: byTree.rebound, partial: byTree.partial ?? byTree.classes };
    const byLoaded = loaded && loaded.managed.has(holder.key) ? settle(loaded, type, unread) : null;
    if (byLoaded?.classes) return { ...byLoaded, by: 'loaded' };
    return byTree.classes ? { ...byTree, by: 'tree' } : byTree;
  };
  const diagnostics = () => [...unread.entries()].sort().map(([key, how]) => ({
    kind: 'TS_BINDING_NOT_READ',
    reason: `${key}: bound by ${how.join(', ')}, which this engine does not read, so a call through a constructor parameter of that type reaches the classes it may be, graded HEURISTIC`,
  }));
  return { narrow, diagnostics };
}
