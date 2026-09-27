// java_names.mjs — what a simple type name written in a Java file means, read in the order javac reads it, from the Java worker's records.
//
// `extends BaseMapper<User>` names a type by its simple name, and which type
// that is depends on the file: an import of that one name decides; else a type
// of the file's own package; else a type an on-demand import (`import x.*;`)
// brings in (JLS 6.4.1). Only the worker's records are consulted, so a type in a
// jar is known only by what the imports say about it, and a name the source
// writes fully qualified reads as unknown here.

const NO_IMPORTS = Object.freeze([]);

/**
 * The context names are read in: each file's import records, and every type
 * the project declares.
 *
 * @param {object[]} records  the Java worker's records
 * @returns {{imports:(t:object)=>object[], declared:Set<string>}}
 */
export function javaNames(records) {
  const importsOf = new Map();
  const declared = new Set();
  for (const r of records) {
    if (r?.kind === 'type') declared.add(r.fqn);
    if (r?.kind !== 'import') continue;
    if (!importsOf.has(r.file)) importsOf.set(r.file, []);
    importsOf.get(r.file).push(r);
  }
  return { imports: (t) => importsOf.get(t.file) ?? NO_IMPORTS, declared };
}

/** A context that knows no import and no type, for reading a type record on its own. */
export const NO_NAMES = Object.freeze({ imports: () => NO_IMPORTS, declared: new Set() });

/**
 * What `simple`, written in the file of type record `t`, means.
 *
 * `{fqn}` when the file decides it: an import of that one name, a type of the
 * same package the project declares, or the one type of that name a package it
 * imports whole declares in the project. `{packages}` when only on-demand
 * imports could bring it in from outside the project. null when nothing in the
 * records says.
 */
export function meaningOf(t, simple, names) {
  const imports = names.imports(t);
  const named = imports.find((i) => i.simple === simple);
  if (named) return { fqn: named.fqn };
  const samePackage = t.package ? `${t.package}.${simple}` : simple;
  if (names.declared.has(samePackage)) return { fqn: samePackage };
  const packages = imports.filter((i) => i.simple === '*').map((i) => i.fqn);
  const inProject = packages.map((p) => `${p}.${simple}`).filter((fqn) => names.declared.has(fqn));
  if (inProject.length === 1) return { fqn: inProject[0] };
  return packages.length > 0 ? { packages } : null;
}
