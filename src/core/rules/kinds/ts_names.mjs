// ts_names.mjs — what a name written in a TypeScript file means as a package's export, for the kinds that match names by the package that exports them.
//
// A rule names a type, a decorator or a function by the module it is imported
// from and the name that module exports (`{module: 'typeorm', export:
// 'Repository'}`), never by the local name alone: an import can rename it, and
// a class of the project's own may share the name. `ns.Entity` through
// `import * as ns from 'typeorm'` is typeorm's Entity too.

const isText = (v) => typeof v === 'string' && v.trim() !== '';

/** `{module, name}` for a name written in `file` that a package exports, or null (a name of the project, or one nothing imports). */
export function externalOf(project, file, written) {
  if (typeof written !== 'string' || written === '') return null;
  const [head, ...rest] = written.split('.');
  const ns = project.files.get(file)?.imports.find((i) => i.namespace === head);
  if (ns) return rest.length === 1 ? { module: ns.source, name: rest[0] } : null;
  if (rest.length > 0) return null;
  const m = project.meaning(file, head);
  return m && m.external ? { module: m.external, name: m.name } : null;
}

/**
 * The items a list written in the source holds, with those of each list it
 * spreads when that list is written out too (`...(on ? [A] : [])` may hold
 * A): `whole` is false when a spread is anything else (a name, a call), which
 * may hold anything.
 */
export function itemsOf(list, depth = 0) {
  if (!list || list.k !== 'arr' || depth > 8) return { items: [], whole: false };
  const inner = (list.spreads ?? []).map((leaf) => itemsOf(leaf, depth + 1));
  const whole = (!list.spread || Array.isArray(list.spreads)) && inner.every((x) => x.whole);
  return { items: [...list.v, ...inner.flatMap((x) => x.items)], whole };
}

/** Whether a package export is one of the refs a rule lists. */
export const isOneOf = (ext, refs) => Boolean(ext && refs.some((r) => r.module === ext.module && r.export === ext.name));

/** Whether the name written in `file` means one of the refs. */
export const means = (project, file, written, refs) => isOneOf(externalOf(project, file, written), refs);

/** Everything wrong with a list of `{module, export}` refs at `where` in the params. */
export function refsErrors(list, where, extraKeys = []) {
  if (!Array.isArray(list) || list.length === 0) return [`${where} must list at least one {module, export}`];
  return list.flatMap((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return [`${where}[${i}] must be {module, export}`];
    const unknown = Object.keys(r).filter((k) => !['module', 'export', ...extraKeys].includes(k)).map((k) => `${where}[${i}] has an unknown key "${k}"`);
    return isText(r.module) && isText(r.export) ? unknown : [...unknown, `${where}[${i}] needs the module a name is imported from and the name it exports`];
  });
}

/** Everything wrong with a list of names at `where`. */
export function namesErrors(list, where, { allowEmpty = false } = {}) {
  if (!Array.isArray(list) || (!allowEmpty && list.length === 0) || !list.every(isText)) return [`${where} must be a list of names`];
  return [];
}

/** The keys of `obj` that `allowed` does not list, each said at `where`. */
export const unknownKeysAt = (obj, allowed, where) => Object.keys(obj).filter((k) => !allowed.includes(k)).map((k) => `${where} has an unknown key "${k}"`);

export const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
