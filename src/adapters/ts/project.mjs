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

/** A class, an interface, a module function or a constant naming another value, into its file; any other record is not one. */
function addDeclaration(f, r) {
  if (r.kind === 'class') f.classes.set(r.name, { ...r, key: classKey(r.file, r.name), methods: new Map(), fields: new Map(), fnProps: new Map() });
  else if (r.kind === 'interface') f.interfaces.set(r.name, { ...r, key: classKey(r.file, r.name) });
  else if (r.kind === 'function') f.functions.set(r.name, r);
  else if (r.kind === 'alias') f.aliases.set(r.name, r);
}

/** The records of every file, bucketed: the one pass over the stream everything else reads. */
function indexRecords(records) {
  const files = new Map();
  const at = (f) => { if (!files.has(f)) files.set(f, emptyFile()); return files.get(f); };
  // The records a later step reads as they come, in the order the worker wrote them.
  const lists = { call: [], new: [], bind: [], const: [] };
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
  return { files, calls: lists.call, news: lists.new, binds: lists.bind, consts: lists.const };
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
 * constants alone is not taken for a package.
 */
export function readProject(records, tsconfig = {}) {
  const { files, calls, news, binds, consts } = indexRecords(records);
  const resolveModule = makeModuleResolver((f) => files.has(f), tsconfig);

  const exported = (file, name) => exportedFrom({ files, resolveModule }, file, name);

  const meaning = (file, name) => {
    const f = files.get(file);
    if (!f || typeof name !== 'string') return null;
    if (declares(f, name)) return { file, name };
    for (const imp of f.imports) {
      const named = imp.names.find((n) => n.local === name);
      const imported = named ? named.imported : imp.default === name ? 'default' : null;
      if (imported === null) continue;
      const target = resolveModule(file, imp.source);
      return target ? exported(target, imported) : { external: imp.source, name: imported };
    }
    return null;
  };

  const classOf = (file, name) => {
    const m = meaning(file, name);
    return m && !m.external ? files.get(m.file)?.classes.get(m.name) ?? null : null;
  };
  const { mixinOf, aliasOf } = namesOf(files, meaning);
  const step = { classOf, mixinOf };
  return {
    files, calls, news, binds, consts, meaning, classOf, typeOf: (file, name) => typeIn(files, meaning(file, name)), resolveModule, aliasOf,
    lineage: (cls) => lineageOf(step, cls).classes,
    // Where a class's chain of what it extends stops at a call this engine cannot follow, or null.
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
 * What `cur` extends: a class it names, the class a mixin it calls returns
 * (`extends Loud(Base)`, handing Base on to it), or what a mixin's class was
 * handed. `open` when it is a call this engine cannot follow.
 */
function parentOf({ classOf, mixinOf }, cur, handed) {
  if (cur.extends) return { cls: classOf(cur.file, cur.extends) };
  const call = cur.extendsCall ?? (cur.mixinParam !== undefined && handed ? handed.args[cur.mixinParam] : null);
  const file = cur.extendsCall ? cur.file : handed?.file;
  if (!call) return { cls: null };
  if (call.k === 'id') return { cls: classOf(file, call.v) };
  const mixin = call.callee ? mixinOf(file, call.callee) : null;
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
 * What `this.name()` runs on an object of `cls`: a property of the chain that
 * holds a function (the most derived one: each is set on the object, over any
 * method), else the nearest method; with the class that declares it.
 */
export function runsOn(project, cls, name) {
  for (const c of project.lineage(cls)) if (c.fnProps?.has(name)) return { cls: c, method: c.fnProps.get(name) };
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
