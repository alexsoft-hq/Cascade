// project.mjs — the TypeScript project as the bridge reads it: which file an import names, which class a name means, what a class inherits.
//
// The worker read each file alone (adapters/ts/tsfacts.mjs); everything that
// crosses a file is decided here, over the whole project's records, so a cached
// file's records never hold a conclusion about another file.
//
// A MODULE SPECIFIER is resolved the way the TypeScript compiler resolves one
// for a project like this: a relative path against the importing file, else a
// `paths` pattern of the tsconfig, else the `baseUrl`, trying the file itself,
// `.ts`, and `index.ts`. A specifier none of them finds in the project is a
// package, and a name imported from a package is external: known by the package
// and the name, never guessed into a project class. The run that decides which
// files to read resolves with the same function (src/cli/ts_inputs.mjs), so a
// file it reads for an import is the file the import means here.

import path from 'node:path';

const EXTENSION_TRIES = Object.freeze(['', '.ts', '/index.ts']);
const MAX_HOPS = 16;

/** A class's key: its file and its name. */
export const classKey = (file, name) => `${file}#${name}`;

function emptyFile() {
  return { imports: [], exports: [], classes: new Map(), interfaces: new Map(), functions: new Map(), aliases: new Map() };
}

/** Whether a file declares a class, an interface, a function or a constant naming another value by that name. */
const declares = (f, name) => f.classes.has(name) || f.interfaces.has(name) || f.functions.has(name) || f.aliases.has(name);

function addClassMember(cls, r) {
  if (r.kind === 'method') cls.methods.set(r.name, r);
  else if (r.kind === 'ctorParam' || r.kind === 'property') cls.fields.set(r.name, r);
  // A property holding a function runs as a method does, and over any method of its name.
  if (r.kind === 'property' && r.fn && !r.static) cls.fnProps.set(r.name, r);
}

/** A member written on a class's objects (`this.x = …`) or on its prototype, by name (null: any name), into the class. */
function addWrite(cls, w) {
  if (!cls) return;
  if (!cls.writes.has(w.name)) cls.writes.set(w.name, []);
  cls.writes.get(w.name).push(w);
}

/** A class, an interface, a module function or a constant naming another value, into its file; any other record is not one. */
function addDeclaration(f, r) {
  if (r.kind === 'class') f.classes.set(r.name, { ...r, key: classKey(r.file, r.name), methods: new Map(), fields: new Map(), fnProps: new Map(), writes: new Map() });
  else if (r.kind === 'interface') f.interfaces.set(r.name, { ...r, key: classKey(r.file, r.name) });
  else if (r.kind === 'function') f.functions.set(r.name, r);
  else if (r.kind === 'alias') f.aliases.set(r.name, r);
}

/** The records of every file, bucketed: the one pass over the stream everything else reads. */
function indexRecords(records) {
  const files = new Map();
  const at = (f) => { if (!files.has(f)) files.set(f, emptyFile()); return files.get(f); };
  // The records a later step reads as they come, in the order the worker wrote them.
  const lists = { call: [], new: [], bind: [], const: [], write: [], use: [] };
  const pendingMembers = [];
  for (const r of records) {
    if (!r || typeof r.file !== 'string') continue;
    const f = at(r.file);
    switch (r.kind) {
      case 'import': f.imports.push(r); break;
      case 'export': f.exports.push(r); break;
      case 'method': case 'ctorParam': case 'property': pendingMembers.push(r); break;
      default: if (Object.hasOwn(lists, r.kind)) lists[r.kind].push(r); else addDeclaration(f, r); break;
    }
  }
  for (const r of pendingMembers) {
    const cls = files.get(r.file)?.classes.get(r.class);
    if (cls) addClassMember(cls, r);
  }
  return { files, calls: lists.call, news: lists.new, binds: lists.bind, consts: lists.const, writes: lists.write, uses: lists.use };
}

/**
 * How module specifiers resolve in this project: `(fromFile, spec)` to the
 * root-relative file it names, or null for a package.
 *
 * @param {(file:string)=>boolean} isKnown  whether a root-relative file is one of the project's
 * @param {{baseUrl?:(string|null), paths?:Object<string,string[]>}} tsconfig  root-relative
 */
export function makeModuleResolver(isKnown, tsconfig) {
  const firstKnown = (base) => {
    for (const ext of EXTENSION_TRIES) {
      const f = path.posix.normalize(base + ext);
      if (isKnown(f)) return f;
    }
    return null;
  };
  const viaPaths = (spec) => {
    for (const [pattern, targets] of Object.entries(tsconfig.paths ?? {})) {
      const star = pattern.indexOf('*');
      const matches = star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
      if (!matches) continue;
      const hole = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const t of targets) {
        const hit = firstKnown(t.replace('*', hole).replace(/\.js$/, ''));
        if (hit) return hit;
      }
    }
    return null;
  };
  return (fromFile, spec) => {
    if (spec.startsWith('.')) return firstKnown(path.posix.join(path.posix.dirname(fromFile), spec).replace(/\.js$/, ''));
    return viaPaths(spec) ?? (tsconfig.baseUrl != null ? firstKnown(path.posix.join(tsconfig.baseUrl, spec)) : null);
  };
}

/**
 * What the name `file` exports as `name` is: a class or function of the
 * project, found through every re-export (`export *`, `export { X as Y } from`),
 * or `{external: source, name}` when a re-export names a package.
 */
function exportedFrom(project, file, name, hops = 0) {
  const f = project.files.get(file);
  if (!f || hops > MAX_HOPS) return null;
  if (declares(f, name)) return { file, name };
  for (const e of f.exports) {
    if (e.all && e.source) {
      const target = project.resolveModule(file, e.source);
      const hit = target ? exportedFrom(project, target, name, hops + 1) : null;
      if (hit) return hit;
    } else if (e.name === name) {
      const local = e.local ?? name;
      if (!e.source) return declares(f, local) ? { file, name: local } : null;
      const target = project.resolveModule(file, e.source);
      return target ? exportedFrom(project, target, local, hops + 1) : { external: e.source, name: local };
    }
  }
  return null;
}

/**
 * The import a name written in a file comes through, and the name its module
 * exports it as: a named import, a default one, or `ns.Name` through `import *
 * as ns`. Null when the file imports no such name.
 */
function importNamed(f, name) {
  if (!f) return null;
  const dot = name.indexOf('.');
  if (dot > 0) {
    const ns = f.imports.find((i) => i.namespace === name.slice(0, dot));
    return ns && name.indexOf('.', dot + 1) < 0 ? { imp: ns, as: name.slice(dot + 1) } : null;
  }
  for (const imp of f.imports) {
    const named = imp.names.find((n) => n.local === name);
    const as = named ? named.imported : imp.default === name ? 'default' : null;
    if (as !== null) return { imp, as };
  }
  return null;
}

/**
 * THE PROJECT: its files, classes, calls and `new`s, and the questions every
 * later step asks of it.
 *
 * - `meaning(file, name)`: what a name written in `file` refers to, as
 *   `{file, name}` for a class, interface or function of the project,
 *   `{external: source, name}` for one imported from a package, or null.
 * - `classOf(file, name)`: the project class that name refers to, or null.
 * - `typeOf(file, name)`: the project class or interface it refers to, or null.
 * - `lineage(cls)`: the class and each class it extends in the project, nearest first.
 *
 * A file is the project's when a record says it was read, so a file of
 * constants alone is not taken for a package. A file the run left out
 * (`leftOut`: test support no read file imports, a link out of the root) is
 * not a package either: a name imported from it means nothing here, like a
 * constant of a file of the project, and `importsFromProject(file, name)`
 * tells either from a global the file never imports.
 *
 * @param {object[]} records
 * @param {{baseUrl?:(string|null), paths?:object}} [tsconfig]
 * @param {{leftOut?:Set<string>}} [opts]  root-relative files the run did not read
 */
export function readProject(records, tsconfig = {}, { leftOut = new Set() } = {}) {
  const { files, calls, news, binds, consts, writes, uses } = indexRecords(records);
  const resolveModule = makeModuleResolver((f) => files.has(f) || leftOut.has(f), tsconfig);
  const exported = (file, name) => exportedFrom({ files, resolveModule }, file, name);
  const importOf = (file, name) => importNamed(files.get(file), name);
  const meaning = (file, name) => {
    const f = files.get(file);
    if (!f || typeof name !== 'string') return null;
    if (declares(f, name)) return { file, name };
    const hit = importOf(file, name);
    if (!hit) return null;
    const target = resolveModule(file, hit.imp.source);
    return target ? exported(target, hit.as) : { external: hit.imp.source, name: hit.as };
  };
  const importsFromProject = (file, name) => { const hit = importOf(file, name); return Boolean(hit && resolveModule(file, hit.imp.source)); };
  const classOf = (file, name) => {
    const m = meaning(file, name);
    return m && !m.external ? files.get(m.file)?.classes.get(m.name) ?? null : null;
  };
  const { mixinOf, aliasOf } = namesOf(files, meaning);
  for (const w of writes) addWrite(w.on === 'this' ? files.get(w.file)?.classes.get(w.class) : classOf(w.file, w.of), w);
  const step = { classOf, mixinOf, meaning, aliasOf, importsFromProject };
  return {
    files, calls, news, binds, consts, uses, meaning, classOf, typeOf: (file, name) => typeIn(files, meaning(file, name)), resolveModule, aliasOf,
    lineage: (cls) => lineageOf(step, cls).classes,
    // Where a class's chain of what it extends stops at something this engine cannot follow to a class, or null.
    openEnd: (cls) => lineageOf(step, cls).open,
  };
}

/**
 * Two more things a name may mean: the class a mixin function of the project
 * returns (`Loud()` of `function Loud(B)`), and a constant of a file that
 * names another value. Each null when it is not one.
 */
function namesOf(files, meaning) {
  const found = (file, name) => {
    const m = name ? meaning(file, name) : null;
    return m && !m.external ? { m, f: files.get(m.file) } : null;
  };
  return {
    mixinOf: (file, callee) => {
      const hit = found(file, callee);
      return hit?.f?.functions.has(hit.m.name) ? hit.f.classes.get(`${hit.m.name}()`) ?? null : null;
    },
    aliasOf: (file, name) => { const hit = found(file, name); return hit?.f?.aliases.get(hit.m.name) ?? null; },
  };
}

/**
 * The class a name `cur` extends means: a class of the project, one a constant
 * names alone (`const Base2 = Base`), or none when it is a package's or a
 * global the file does not declare (`Error`). `open` when it may be a class of
 * the project this engine cannot name: a value the file gives the name
 * (`const B = makeBase()`, `bound`), a constant that names one of several,
 * something of the project that is not a class, or a name from a file the run
 * did not read.
 */
function namedParent({ classOf, meaning, aliasOf, importsFromProject }, cur, file, name, bound) {
  const cls = classOf(file, name);
  if (cls) return { cls };
  const alias = aliasOf(file, name);
  const one = alias && alias.values.length === 1 && alias.values[0].k === 'id' ? classOf(alias.file, alias.values[0].v) : null;
  if (one) return { cls: one };
  const m = meaning(file, name);
  if (m?.external || (!m && !bound && !importsFromProject(file, name))) return { cls: null };
  return { cls: null, open: { cls: cur, callee: name, args: [], file, name: true } };
}

/**
 * What `cur` extends: a class it names, the class a mixin it calls returns
 * (`extends Loud(Base)`, handing Base on to it), or what a mixin's class was
 * handed. `open` when it is something this engine cannot follow to a class: a
 * call it cannot follow, an expression (`extends (on ? A : B)`), or a name
 * `namedParent` cannot settle.
 */
function parentOf(step, cur, handed) {
  if (cur.extends) return namedParent(step, cur, cur.file, cur.extends, Boolean(cur.extendsBound));
  if (cur.extendsExpr) return { cls: null, open: { cls: cur, callee: 'an expression', args: [], file: cur.file } };
  const call = cur.extendsCall ?? (cur.mixinParam !== undefined && handed ? handed.args[cur.mixinParam] : null);
  const file = cur.extendsCall ? cur.file : handed?.file;
  if (!call) return { cls: null };
  if (call.k === 'id') return namedParent(step, cur, file, call.v, Boolean(call.at));
  const mixin = call.callee ? step.mixinOf(file, call.callee) : null;
  return mixin ? { cls: mixin, handed: { file, args: call.args ?? [] } } : { cls: null, open: { cls: cur, callee: call.callee ?? 'an expression', args: call.args ?? [], file } };
}

/** The class and each class it extends in the project, nearest first, through mixins; where the chain stops at a call not followed. */
function lineageOf(step, cls) {
  const classes = [];
  let open = null;
  for (let cur = cls, handed = null; cur && classes.length <= MAX_HOPS && !classes.includes(cur);) {
    classes.push(cur);
    const next = parentOf(step, cur, handed);
    open = next.open ?? null;
    [cur, handed] = [next.cls, next.handed ?? null];
  }
  return { classes, open };
}

/** The class, else the interface, a meaning names in the project. */
function typeIn(files, m) {
  if (!m || m.external) return null;
  const f = files.get(m.file);
  return f ? f.classes.get(m.name) ?? f.interfaces.get(m.name) ?? null : null;
}

/**
 * Why a class of the chain may give its objects a `name` this engine does not
 * link, or null: a member written with a value it does not read as a method
 * (`step = this.fast.bind(this)`, `this.step = () => 2` in a constructor, a
 * constructor parameter of that name), one written on the prototype, a write
 * that may name any member (`Object.assign(this, …)`), or a member whose name
 * is computed. `this.step = this.step.bind(this)` runs the same method and is
 * none of these.
 */
export function replacedBy(c, name) {
  if (c.computedMembers) return `${c.key} has a member whose name is computed, which may be ${name}`;
  const field = c.fields?.get(name);
  if (field && !field.static && !field.fn && !field.bindsSelf) return `${c.key}.${name} is ${field.kind === 'ctorParam' ? 'a constructor parameter property' : 'a property'} whose value this engine does not read as a method`;
  const w = [...(c.writes?.get(name) ?? []), ...(c.writes?.get(null) ?? [])].find((x) => !x.bindsSelf);
  if (!w) return null;
  const on = w.on === 'this' ? 'its objects' : 'its prototype';
  return `${w.file}:${w.line} writes ${w.name === null ? 'members it does not name' : name} on ${on} of ${c.key}, with a value this engine does not link`;
}

/**
 * What `this.name()` runs on an object of `cls`: a property of the chain that
 * holds a function (the most derived one: each is set on the object, over any
 * method), else the nearest method; with the class that declares it. `{cls,
 * replaced}` with why when a class of the chain may replace it with something
 * this engine does not link.
 */
export function runsOn(project, cls, name) {
  const lineage = project.lineage(cls);
  const replaced = lineage.map((c) => replacedBy(c, name)).find(Boolean);
  if (replaced) return { cls, replaced };
  for (const c of lineage) if (c.fnProps?.has(name)) return { cls: c, method: c.fnProps.get(name) };
  return methodOf(project, cls, name);
}

/** The method `name` of `cls` or of the nearest class it extends in the project, with the class that declares it. */
export function methodOf(project, cls, name) {
  for (const c of project.lineage(cls)) if (c.methods.has(name)) return { cls: c, method: c.methods.get(name) };
  return null;
}

/** The field `name` of `cls` (a constructor parameter property or a property), searching the classes it extends. */
export function fieldOf(project, cls, name) {
  for (const c of project.lineage(cls)) if (c.fields.has(name)) return { cls: c, field: c.fields.get(name) };
  return null;
}
