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
// and the name, never guessed into a project class.

import path from 'node:path';

const EXTENSION_TRIES = Object.freeze(['', '.ts', '/index.ts']);
const MAX_HOPS = 16;

/** A class's key: its file and its name. */
export const classKey = (file, name) => `${file}#${name}`;

function emptyFile() {
  return { imports: [], exports: [], classes: new Map(), functions: new Map() };
}

function addClassMember(cls, r) {
  if (r.kind === 'method') cls.methods.set(r.name, r);
  else if (r.kind === 'ctorParam' || r.kind === 'property') cls.fields.set(r.name, r);
}

/** The records of every file, bucketed: the one pass over the stream everything else reads. */
function indexRecords(records) {
  const files = new Map();
  const at = (f) => { if (!files.has(f)) files.set(f, emptyFile()); return files.get(f); };
  const calls = [];
  const pendingMembers = [];
  for (const r of records) {
    if (!r || typeof r.file !== 'string') continue;
    const f = at(r.file);
    switch (r.kind) {
      case 'import': f.imports.push(r); break;
      case 'export': f.exports.push(r); break;
      case 'class': f.classes.set(r.name, { ...r, key: classKey(r.file, r.name), methods: new Map(), fields: new Map() }); break;
      case 'function': f.functions.set(r.name, r); break;
      case 'call': calls.push(r); break;
      case 'method': case 'ctorParam': case 'property': pendingMembers.push(r); break;
      default: break;
    }
  }
  for (const r of pendingMembers) {
    const cls = files.get(r.file)?.classes.get(r.class);
    if (cls) addClassMember(cls, r);
  }
  return { files, calls };
}

/**
 * How module specifiers resolve in this project.
 *
 * @param {Set<string>} known  the project's files, root-relative
 * @param {{baseUrl?:(string|null), paths?:Object<string,string[]>}} tsconfig  root-relative
 */
function makeModuleResolver(known, tsconfig) {
  const firstKnown = (base) => {
    for (const ext of EXTENSION_TRIES) {
      const f = path.posix.normalize(base + ext);
      if (known.has(f)) return f;
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
  if (f.classes.has(name) || f.functions.has(name)) return { file, name };
  for (const e of f.exports) {
    if (e.all && e.source) {
      const target = project.resolveModule(file, e.source);
      const hit = target ? exportedFrom(project, target, name, hops + 1) : null;
      if (hit) return hit;
    } else if (e.name === name) {
      const local = e.local ?? name;
      if (!e.source) return f.classes.has(local) || f.functions.has(local) ? { file, name: local } : null;
      const target = project.resolveModule(file, e.source);
      return target ? exportedFrom(project, target, local, hops + 1) : { external: e.source, name: local };
    }
  }
  return null;
}

/**
 * THE PROJECT: its files, classes and calls, and the three questions every
 * later step asks of it.
 *
 * - `meaning(file, name)`: what a name written in `file` refers to, as
 *   `{file, name}` for a class or function of the project, `{external: source,
 *   name}` for one imported from a package, or null.
 * - `classOf(file, name)`: the project class that name refers to, or null.
 * - `lineage(cls)`: the class and each class it extends in the project, nearest first.
 */
export function readProject(records, tsconfig = {}) {
  const { files, calls } = indexRecords(records);
  const resolveModule = makeModuleResolver(new Set(files.keys()), tsconfig);

  const exported = (file, name) => exportedFrom({ files, resolveModule }, file, name);

  const meaning = (file, name) => {
    const f = files.get(file);
    if (!f || typeof name !== 'string') return null;
    if (f.classes.has(name) || f.functions.has(name)) return { file, name };
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

  const lineage = (cls) => {
    const out = [];
    for (let cur = cls; cur && out.length <= MAX_HOPS && !out.includes(cur); cur = cur.extends ? classOf(cur.file, cur.extends) : null) out.push(cur);
    return out;
  };

  return { files, calls, meaning, classOf, lineage, resolveModule };
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
