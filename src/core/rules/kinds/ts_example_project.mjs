// ts_example_project.mjs — one example file's tsfacts records, read as the project a TypeScript kind reads.
//
// A kind whose rule reads a whole project (which class an entity is, which
// field a repository) is handed the project the TypeScript bridge builds
// (src/adapters/ts/project.mjs). A rule's example is one file, so this reads
// that one file the same way: its classes with their members, its calls and
// its `new`s, and what a name written in it means. A name imported from any
// module is that module's, as the bridge reads a module it cannot find in the
// project. Kept here so a kind needs nothing from a lane to run its examples.

const MAX_HOPS = 16;

function indexOne(records) {
  const f = { imports: [], exports: [], classes: new Map(), functions: new Map() };
  const calls = [];
  const news = [];
  const binds = [];
  const consts = [];
  for (const r of records) {
    if (r.kind === 'import') f.imports.push(r);
    else if (r.kind === 'class') f.classes.set(r.name, { ...r, key: `${r.file}#${r.name}`, methods: new Map(), fields: new Map() });
    else if (r.kind === 'function') f.functions.set(r.name, r);
    else if (r.kind === 'call') calls.push(r);
    else if (r.kind === 'new') news.push(r);
    else if (r.kind === 'bind') binds.push(r);
    else if (r.kind === 'const') consts.push(r);
  }
  for (const r of records) {
    const cls = f.classes.get(r.class);
    if (!cls) continue;
    if (r.kind === 'method') cls.methods.set(r.name, r);
    else if (r.kind === 'ctorParam' || r.kind === 'property') cls.fields.set(r.name, r);
  }
  return { f, calls, news, binds, consts };
}

/** The project view of one file: `files`, `calls`, `news`, `binds`, `consts`, `meaning`, `classOf`, `lineage`, as readProject gives them. */
export function exampleProject(records) {
  const file = records.find((r) => typeof r.file === 'string')?.file ?? 'example.ts';
  const { f, calls, news, binds, consts } = indexOne(records.filter((r) => r.file === file));
  const meaning = (at, name) => {
    if (at !== file || typeof name !== 'string') return null;
    if (f.classes.has(name) || f.functions.has(name)) return { file, name };
    for (const imp of f.imports) {
      const named = imp.names.find((n) => n.local === name);
      const imported = named ? named.imported : imp.default === name ? 'default' : null;
      if (imported !== null) return { external: imp.source, name: imported };
    }
    return null;
  };
  const classOf = (at, name) => {
    const m = meaning(at, name);
    return m && !m.external ? f.classes.get(m.name) ?? null : null;
  };
  const lineage = (cls) => {
    const out = [];
    for (let cur = cls; cur && out.length <= MAX_HOPS && !out.includes(cur); cur = cur.extends ? classOf(cur.file, cur.extends) : null) out.push(cur);
    return out;
  };
  return { files: new Map([[file, f]]), calls, news, binds, consts, meaning, classOf, lineage };
}
