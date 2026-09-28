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
//     one's imports, when that walk is read whole: they are the ones Nest reads;
//   - else EVERY module of the tree, static and dynamic (`X.forRoot()` read
//     from the object it returns): whichever of them the application loads,
//     what it binds is among theirs. nestjs-boilerplate picks its persistence
//     module through a variable, so this is the reading that settles it there.
//
// A set settled either way is complete: the edge says which modules bound it.
// One that is not stays the whole hierarchy, and the edge says why it may be
// short (src/adapters/ts/ts_calls.mjs grades it HEURISTIC): a binding made by a
// factory, a value or another token; a provider or a module this engine cannot
// read; a package's module handed the type; a parameter decorated
// @Inject(token), which is filled by that token; a class made by hand with
// `new`, whose parameter is whatever it is handed. The names these are read by
// are the rule's (src/core/rules/packs/nestjs.json, `nestjs.providers`).

import { fieldOf } from './project.mjs';
import { decoratorsIn, isPackageModule, moduleClassOf, viewsOf } from './nest_routes.mjs';

const MAX_MODULES = 2000;

/** The value names a value mentions, at any depth: a package's module handed one may bind it. */
function namesIn(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (v.k === 'id') out.push(v.v);
  for (const x of [...(Array.isArray(v.v) ? v.v : v.k === 'obj' ? Object.values(v.v) : []), ...(v.args ?? [])]) namesIn(x, out);
  return out;
}

/** Why the imports of one module may hide a binding: a spread, an entry this engine cannot name, a module a static method returns. */
function importGaps(project, mod, decl, queue) {
  const gaps = decl.imports.spread ? [`${mod.key}: its imports spread a list`] : [];
  for (const v of decl.imports.v) {
    const target = moduleClassOf(project, mod.file, v);
    if (target) {
      queue.push(target);
      if (v.k === 'call' && v.callee?.includes('.')) gaps.push(`${mod.key}: ${v.callee}(...) returns a module whose providers are not read`);
    } else if (!isPackageModule(project, mod.file, v)) gaps.push(`${mod.key}: an import this engine cannot name`);
  }
  return gaps;
}

/** Every module the application loads, from its root module through each one's imports, and each reason that list may be short. */
function modulesLoaded(project, routes, viewOf, root) {
  const seen = new Map();
  const gaps = [];
  const queue = [root];
  while (queue.length > 0 && seen.size < MAX_MODULES) {
    const mod = queue.shift();
    if (seen.has(mod.key)) continue;
    seen.set(mod.key, mod);
    const decl = routes.moduleOf(viewOf(mod));
    if (!decl) continue;
    if (!decl.readable) gaps.push(`${mod.key}: its module options are not read`);
    else gaps.push(...importGaps(project, mod, decl, queue));
  }
  return { modules: [...seen.values()], gaps };
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

/** What a module class's static methods return: a dynamic module, whose providers bind as a module's do. */
function addDynamic(project, rules, mod, acc) {
  for (const m of mod.methods.values()) {
    if (!m.static || !Array.isArray(m.returns)) continue;
    const at = { key: `${mod.key}.${m.name}`, file: mod.file };
    for (const r of m.returns) {
      if (r.k === 'none' || r.k === 'undefined' || r.k === 'null') continue;
      if (r.k !== 'obj') acc.gaps.push(`${at.key}: returns a value this engine cannot read, which may be a module that binds a type`);
      else addList(project, at, rules.providers.providersIn(r), acc);
    }
  }
}

/** The types a package's module is handed in the imports of `mod`: it may bind them. */
function addHanded(project, routes, view, mod, acc) {
  for (const v of routes.moduleOf(view)?.imports.v ?? []) {
    if (v.k !== 'call' || !isPackageModule(project, mod.file, v)) continue;
    for (const name of namesIn({ k: 'arr', v: v.args })) {
      const t = project.typeOf(mod.file, name);
      if (t) acc.handed.set(t.key, `${mod.key}: ${v.callee}(...) is handed ${name}`);
    }
  }
}

/** What `modules` bind, the classes Nest makes (each provided class, each registered controller), and each reason the reading may be short. */
function readBindings(project, rules, viewOf, modules, gaps, { dynamic = false } = {}) {
  const acc = { byToken: new Map(), managed: new Set(), gaps: [...gaps], handed: new Map() };
  for (const mod of modules) {
    const view = viewOf(mod);
    const decl = rules.providers.providersOf(view);
    if (!decl) continue;
    addList(project, mod, decl, acc);
    addHanded(project, rules.routes, view, mod, acc);
    if (dynamic) addDynamic(project, rules, mod, acc);
    for (const v of rules.routes.moduleOf(view)?.controllers.v ?? []) {
      const cls = v.k === 'id' ? project.classOf(mod.file, v.v) : null;
      if (cls) acc.managed.add(cls.key);
    }
  }
  return acc;
}

/** Every module class of the tree, loaded or not. */
function treeModules(project, routes, viewOf) {
  return [...project.files.values()].flatMap((f) => [...f.classes.values()]).filter((c) => routes.moduleOf(viewOf(c)));
}

/**
 * Why Nest's binding is not what fills this field: it is not a parameter of
 * the class's own constructor, the parameter names its token, or the code
 * makes the class (or a subclass) with `new` and hands it what it likes.
 */
function notInjected(project, rules, holder, field, madeByHand) {
  if (field.field.kind !== 'ctorParam' || field.cls.key !== holder.key) return 'the field is not a parameter of this class\'s own constructor, which is what Nest fills, so what it holds is set by code this engine does not follow';
  const decorators = decoratorsIn(project, field.cls.file, field.field.decorators ?? [], rules.routes.packages);
  if (decorators.some((d) => d.name === rules.providers.inject)) return 'the parameter is filled by the token its decorator names, not by its type';
  const made = madeByHand(holder);
  return made ? `${made} makes the class with new, handing it whatever it likes` : null;
}

/** What one reading of the modules says of a type: the classes they bind, or why they do not settle it. */
function settle(acc, type, unread) {
  const where = acc.handed.get(type.key);
  if (where) return { reason: `${where}, and a package's module may bind it` };
  if (acc.gaps.length > 0) return { reason: `${acc.gaps[0]}${acc.gaps.length > 1 ? `, and ${acc.gaps.length - 1} more` : ''}, so one may bind the type` };
  const b = acc.byToken.get(type.key);
  if (!b) return { reason: 'no module binds the type' };
  if (b.notRead.length > 0) {
    unread.set(type.key, b.notRead);
    return { reason: `the type is bound by ${b.notRead.join(', ')}, which is not read` };
  }
  return { classes: [...b.classes.values()], modules: [...b.modules].sort() };
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

/**
 * THE BINDINGS of the tree, and of the application whose root module is
 * `root` when there is one: `narrow({holder, field, type})` is `{classes,
 * modules, by}` when the modules settle what a constructor parameter of
 * `holder` typed `type` is handed (`by` says which reading settled it), else
 * `{reason}`; `diagnostics()` names each type whose binding is not read.
 *
 * @param {object} project  readProject's answer
 * @param {{routes:object, providers:object}} rules  the ts.route-decorator and ts.provider-binding rules, compiled
 * @param {object|null} root  the root module class
 * @param {(key:string)=>object[]} subtypesOf  dispatch.mjs's subtype index
 */
export function providerBindings(project, rules, root, subtypesOf) {
  if (!rules.routes || !rules.providers) return null;
  const viewOf = viewsOf(project, rules.routes);
  const loaded = root ? modulesLoaded(project, rules.routes, viewOf, root) : null;
  const loadedAcc = loaded ? readBindings(project, rules, viewOf, loaded.modules, loaded.gaps) : null;
  const treeAcc = readBindings(project, rules, viewOf, treeModules(project, rules.routes, viewOf), [], { dynamic: true });
  const madeByHand = makerOf(project, subtypesOf);
  const unread = new Map();
  const narrow = ({ holder, field, type }) => {
    const why = notInjected(project, rules, holder, field, madeByHand);
    if (why) return { reason: why };
    const byLoaded = loadedAcc && loadedAcc.managed.has(holder.key) ? settle(loadedAcc, type, unread) : null;
    if (byLoaded?.classes) return { ...byLoaded, by: 'loaded' };
    const byTree = settle(treeAcc, type, unread);
    return byTree.classes ? { ...byTree, by: 'tree' } : byTree;
  };
  const diagnostics = () => [...unread.entries()].sort().map(([key, how]) => ({
    kind: 'TS_BINDING_NOT_READ',
    reason: `${key}: bound by ${how.join(', ')}, which this engine does not read, so a call through a constructor parameter of that type reaches every class of the project that extends or implements it, graded HEURISTIC`,
  }));
  return { narrow, diagnostics };
}
