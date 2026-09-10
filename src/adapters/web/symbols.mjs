// symbols.mjs — the files, the names in them, and what each name IS.
//
// WHAT THIS MODULE OWNS. Three questions, and they are one question asked three
// times:
//   1. which file does this fact belong to, and in what order  (`indexWebFacts`)
//   2. which file does this specifier / this exported name lead to  (`makeResolver`)
//   3. what does this name HOLD — an HTTP client, an instance of a class the
//      project wrote, a function, or a module nobody here read  (the same
//      resolver's `valueOf` / `initValue` / `collectInstances`)
// It also owns the two node-id rules a web fact turns into (`webSymbolId`,
// `webScreenId`) and the extension rule that makes a file a component.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the routes, the prefix rules, the
// screens, the statistics. Every question above is answered from the fact
// stream and from the package configuration it is handed, and the answer is the
// same whether or not a single edge is ever placed. The one thing it takes from
// outside is `packageOf` / `configFor` — where a file's aliases come from — and
// it takes them as functions rather than importing prefix.mjs, so the two
// modules stay independent of each other.

import { nodeId } from '../../core/graph.mjs';
import { cmp, dirOf, joinPosix, normalizePosix, packageNameOf, HOP_LIMIT } from './shared.mjs';

/** The extensions a specifier is tried with, in the order a bundler tries them. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];

/**
 * The file extensions that make a file a COMPONENT, so a function in it is a
 * function in a screen rather than an api function.
 *
 * A `.ts` / `.js` module that exports a function returning JSX is a component
 * too, and this list does not catch it: the fact stream carries no JSX marker,
 * and inventing one is a change to the worker's schema. The gap is stated in
 * docs/setup/web-lane.md rather than papered over with a name rule.
 */
const COMPONENT_EXTENSIONS = Object.freeze(['.vue', '.tsx', '.jsx']);

/** Whether a root-relative file is a component by its extension. */
export function isComponentFile(file) {
  return COMPONENT_EXTENSIONS.some((e) => String(file).endsWith(e));
}

/** symbol node id for a web function "file#enclosing" (position-independent). */
export function webSymbolId(file, enclosing) {
  return nodeId('symbol', `${file}#${enclosing}`);
}

/** screen node id, keyed by the COMPOSED route path (SPEC §8.1). */
export function webScreenId(pathStr) {
  return nodeId('screen', pathStr);
}

/** endpoint node id, keyed by "METHOD path", the same key the Java bridge uses. */
export function webEndpointId(httpMethod, pathStr) {
  return nodeId('endpoint', `${httpMethod} ${pathStr}`);
}

/**
 * A kebab-case element tag as the name a framework registry holds.
 * `owner-list` -> `ownerList`, `visits` -> `visits`.
 * @param {string} tag
 * @returns {string}
 */
export function registryNameOf(tag) {
  return String(tag ?? '').replace(/-+([a-zA-Z0-9])/g, (m, c) => c.toUpperCase());
}

/** The ordering key inside one file's bucket: line first, then the record itself. */
export const sortKey = (r) => `${String(r.line ?? 0).padStart(9, '0')}|${JSON.stringify(r)}`;

/**
 * ONE FILE'S BUCKETS SORTED, and the import table built from them.
 *
 * The LAST import of a local name is the one in scope, and imports are in line
 * order by then, so a later one legitimately shadows an earlier one.
 */
function sortOneFile(f) {
  f.imports.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.exports.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.assigns.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.calls.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.navigations.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.routes.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  f.registrations.sort((a, b) => cmp(sortKey(a), sortKey(b)));
  // The LAST import of a local name is the one in scope, and imports are now
  // in line order, so a later one legitimately shadows an earlier one.
  for (const imp of f.imports) {
    for (const s of imp.specifiers ?? []) f.importOf.set(s.local, { source: imp.source, imported: s.imported });
  }
}

/**
 * B1: bucket the whole fact stream by FILE and sort inside every bucket.
 *
 * That is not a nicety: an incremental run assembles the stream from shards, and
 * two assemblies of the same shards must produce the same edges. Sorting here is
 * what makes the rest of this lane independent of the order records arrived in.
 *
 * @param {object[]} records  the cascade:webfacts:1 stream
 * @returns {{files:Map, configs:object[], parsed:Set<string>, fileNames:string[]}}
 */
export function indexWebFacts(records) {
  const files = new Map();
  const configs = [];
  const parsed = new Set();
  const fileOf = (name) => {
    let f = files.get(name);
    if (!f) {
      f = {
        imports: [], exports: [], functions: new Map(), constants: new Map(),
        bindings: new Map(), classes: new Map(), assigns: [], calls: [], routes: [],
        registrations: [],
        // The calls that change the SCREEN rather than send a request (RM59).
        navigations: [],
        // The one record a server-rendered page carries about itself (RM48).
        template: null,
        importOf: new Map(),
      };
      files.set(name, f);
    }
    return f;
  };
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.kind !== 'string') continue;
    if (r.kind === 'header' || r.kind === 'summary' || r.kind === 'parse_error') continue;
    if (r.kind === 'config') { configs.push(r); continue; }
    if (typeof r.file !== 'string') continue;
    if (r.kind === 'file') { parsed.add(r.file); fileOf(r.file); continue; }
    const f = fileOf(r.file);
    switch (r.kind) {
      case 'import': f.imports.push(r); break;
      case 'export': f.exports.push(r); break;
      case 'function': f.functions.set(r.name, r); break;
      case 'constant': f.constants.set(r.name, r); break;
      case 'binding': f.bindings.set(r.name, r); break;
      case 'class': f.classes.set(r.name, r); break;
      case 'assign': f.assigns.push(r); break;
      case 'call': f.calls.push(r); break;
      case 'navigation': f.navigations.push(r); break;
      case 'route': f.routes.push(r); break;
      case 'registration': f.registrations.push(r); break;
      case 'template': f.template = r; break;
      default: break;
    }
  }
  for (const f of files.values()) sortOneFile(f);
  return { files, configs, parsed, fileNames: [...files.keys()].sort() };
}

/**
 * THE FUNCTIONS WRITTEN INSIDE A NAMED OBJECT LITERAL, across the whole tree,
 * keyed the way a caller in another file spells one: `<file>#<owner>.<key>`
 * (RM57). `export const contentService = { get: … }` is the ordinary way a
 * TypeScript frontend keeps its API calls, and the key alone (`get`) does not
 * say which object it belongs to — two objects in one file can both have one.
 * The worker records the owner, and this is that record turned into a lookup.
 *
 * @param {Map<string,object>} files  the fact index's files
 * @returns {Map<string,object>} the function record for each member
 */
export function memberIndex(files) {
  const out = new Map();
  for (const [file, f] of files) {
    for (const r of f.functions.values()) {
      if (typeof r.member !== 'string') continue;
      const key = `${file}#${r.member}`;
      if (!out.has(key)) out.set(key, r);
    }
  }
  return out;
}

/**
 * B2 and B4: module resolution, and what a name holds.
 *
 * The seven functions below are mutually recursive — a specifier leads to a
 * file, a file's export leads to a local name, a local name's initializer leads
 * to another specifier — so they take one CONTEXT between them: the fact index,
 * the package configuration, the client vocabulary, and the two memos. Each is
 * written on its own, at module level, so a reader can read one without holding
 * the other six.
 *
 * @typedef {{files:Map, parsed:Set<string>, packageOf:Function, configFor:Function,
 *            libraries:Map, VALUE:Map, FIELD:Map}} ResolveCtx
 */

/** Which FILE a specifier names, or which package it leaves this project for. */
function resolveSpecifier(ctx, fromFile, spec) {
  if (typeof spec !== 'string' || spec === '') return { unresolved: 'empty-specifier' };
  let target = null;
  let assumed = false;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    target = joinPosix(dirOf(fromFile), spec);
  } else {
    const pkgDir = ctx.packageOf(fromFile);
    for (const a of ctx.configFor(pkgDir).aliases) {
      const from = a.from.endsWith('/') ? a.from.slice(0, -1) : a.from;
      if (spec !== from && !spec.startsWith(`${from}/`)) continue;
      const rest = spec.slice(from.length);
      target = normalizePosix(`${joinPosix(pkgDir, a.to)}${rest}`);
      assumed = a.assumed === true;
      break;
    }
    if (target === null) return { external: packageNameOf(spec) };
  }
  const candidates = [target];
  for (const e of EXTENSIONS) candidates.push(`${target}${e}`);
  for (const e of EXTENSIONS) candidates.push(`${target}/index${e}`);
  for (const c of candidates) if (ctx.parsed.has(c)) return { file: c, assumed };
  return { unresolved: 'not-a-file-this-lane-read', assumed };
}

/**
 * WHERE A LOCAL NAME COMES FROM: the file that declares it, or the package it
 * is imported from. `assumed` rides along when an assumed alias was on the
 * path, because everything that rests on a guessed alias is graded down.
 */
function resolveExport(ctx, file, name, depth) {
  if (depth > HOP_LIMIT) return null;
  const f = ctx.files.get(file);
  if (!f) return null;
  let assumed = false;
  for (const e of f.exports) {
    if (e.name !== name) continue;
    if (e.of === 'reexport' && e.source) {
      const r = resolveSpecifier(ctx, file, e.source);
      assumed = assumed || r.assumed === true;
      if (r.external) return { external: r.external, assumed };
      if (!r.file) continue;
      const hit = resolveExport(ctx, r.file, name, depth + 1);
      if (hit) return { ...hit, assumed: assumed || hit.assumed };
      continue;
    }
    const local = e.local ?? name;
    const hit = resolveLocal(ctx, file, local, depth + 1);
    if (hit) return { ...hit, assumed: assumed || hit.assumed };
    return { file, name: local, assumed, viaStar: false };
  }
  return throughStars(ctx, f, file, name, depth, assumed);
}

/**
 * `export * from './x'`: every named target is followed, first hit in path
 * order. Which one it was is a real decision, so it is DISCLOSED on the edge.
 */
function throughStars(ctx, f, file, name, depth, assumed) {
  const stars = f.exports.filter((e) => e.of === 'reexport' && e.name === '*' && e.source)
    .map((e) => e.source).sort();
  for (const src of stars) {
    const r = resolveSpecifier(ctx, file, src);
    if (!r.file) continue;
    const hit = resolveExport(ctx, r.file, name, depth + 1);
    if (hit) return { ...hit, assumed: assumed || hit.assumed || r.assumed === true, viaStar: true };
  }
  return null;
}

/** A name as this file sees it: declared here, or imported from somewhere. */
function resolveLocal(ctx, file, name, depth) {
  if (depth > HOP_LIMIT) return null;
  const f = ctx.files.get(file);
  if (!f) return null;
  if (f.bindings.has(name) || f.functions.has(name) || f.classes.has(name) || f.constants.has(name)) {
    return { file, name, assumed: false, viaStar: false };
  }
  const imp = f.importOf.get(name);
  if (!imp) return null;
  const r = resolveSpecifier(ctx, file, imp.source);
  if (r.external) return { external: r.external, assumed: r.assumed === true, viaStar: false };
  if (!r.file) return null;
  if (imp.imported === '*') return { file: r.file, namespace: true, assumed: r.assumed === true, viaStar: false };
  const hit = resolveExport(ctx, r.file, imp.imported, depth + 1);
  if (!hit) return null;
  return { ...hit, assumed: hit.assumed || r.assumed === true };
}

/**
 * B4: WHAT A NAME IS — an HTTP client instance, an instance of a class the
 * project wrote, a function, or a module this analysis never read.
 *
 * The memo is keyed by `file#name`, and a name being resolved already is a
 * cycle, so it answers null.
 */
function valueOf(ctx, file, name, depth) {
  const key = `${file}#${name}`;
  if (ctx.VALUE.has(key)) return ctx.VALUE.get(key);
  if (depth > HOP_LIMIT) return null;
  ctx.VALUE.set(key, null);
  const f = ctx.files.get(file);
  let out = null;
  if (f) {
    if (f.classes.has(name)) out = { kind: 'class', key, file, name, assumed: false, viaStar: false };
    else if (f.bindings.has(name)) {
      const v = initValue(ctx, file, f.bindings.get(name).init, depth + 1);
      if (v && v.kind === 'sink-instance') out = { ...v, id: key };
      else out = v;
    } else if (f.functions.has(name)) out = { kind: 'function', key, file, name, assumed: false, viaStar: false };
  }
  ctx.VALUE.set(key, out);
  return out;
}

/** The value a `this.<field>` names inside a class: the field's last assignment. */
function fieldValue(ctx, file, className, field, depth) {
  const key = `${file}#${className}.${field}`;
  if (ctx.FIELD.has(key)) return ctx.FIELD.get(key);
  ctx.FIELD.set(key, null);
  const f = ctx.files.get(file);
  let out = null;
  if (f) {
    for (const a of f.assigns) {
      if (a.class !== className || a.field !== field) continue;
      const v = initValue(ctx, file, a.init, depth + 1);
      if (v && v.kind === 'sink-instance') out = { ...v, id: key };
      else if (v) out = v;
    }
  }
  ctx.FIELD.set(key, out);
  return out;
}

/** What the ROOT of a callee names, before the member path is applied. */
function rootValue(ctx, file, callee, binding, depth) {
  if (!callee || typeof callee.root !== 'string') return null;
  if (binding && binding.kind === 'this') return { kind: 'this', className: binding.class ?? null };
  if (binding && binding.kind === 'global') return null;
  const r = resolveLocal(ctx, file, callee.root, depth);
  if (!r) return null;
  if (r.external) return { kind: 'external', module: r.external, assumed: r.assumed === true, viaStar: false };
  if (r.namespace) return { kind: 'namespace', file: r.file, assumed: r.assumed === true, viaStar: r.viaStar === true };
  const v = valueOf(ctx, r.file, r.name, depth + 1);
  if (!v) return null;
  return {
    ...v,
    assumed: (v.assumed === true) || r.assumed === true,
    viaStar: (v.viaStar === true) || r.viaStar === true,
  };
}

/** An init whose root left this project: a client factory call, or a plain external. */
function externalInit(ctx, root, init, last, carry) {
  const module = root.kind === 'external' ? root.module : null;
  const lib = module ? ctx.libraries.get(module) : null;
  if (lib && init.shape === 'call' && last && (lib.instanceFactories ?? []).includes(last)) {
    return carry({ kind: 'sink-instance', module: lib.module, baseURL: init.baseURL ?? null });
  }
  return carry({ kind: 'external', module });
}

/** What an `init` record (a const, a class field, a return) evaluates to. */
function initValue(ctx, file, init, depth) {
  if (!init || !init.callee || depth > HOP_LIMIT) return null;
  const root = rootValue(ctx, file, init.callee, init.binding, depth);
  if (root === null) return null;
  const pathParts = init.callee.path ?? [];
  const last = pathParts.length > 0 ? pathParts[pathParts.length - 1] : null;
  const carry = (v) => ({
    ...v,
    assumed: (v.assumed === true) || (root.assumed === true),
    viaStar: (v.viaStar === true) || (root.viaStar === true),
  });
  if (root.kind === 'external' || root.kind === 'namespace') return externalInit(ctx, root, init, last, carry);
  if (root.kind === 'this') {
    if (pathParts.length !== 1 || !root.className) return null;
    const v = fieldValue(ctx, file, root.className, pathParts[0], depth + 1);
    return v ? carry(v) : null;
  }
  if (init.shape === 'new') {
    return root.kind === 'class' ? carry({ kind: 'class-instance', key: root.key }) : null;
  }
  if (init.shape === 'call') {
    // A FACTORY: the value is whatever the function it calls hands back.
    if (root.kind !== 'function') return null;
    const fn = ctx.files.get(root.file)?.functions.get(root.name);
    if (!fn || !fn.returns) return null;
    const v = initValue(ctx, root.file, fn.returns, depth + 1);
    return v && (v.kind === 'class-instance' || v.kind === 'sink-instance') ? carry(v) : null;
  }
  // `const a = b` / `const a = b.c`: a is whatever b already was.
  if (pathParts.length === 0) return carry(root);
  if (root.kind === 'class-instance') return null;
  return null;
}

/**
 * The seven above, bound to ONE run's context and its two memos, so a caller
 * writes `resolver.resolveSpecifier(file, spec)` and never carries the context.
 * @param {{files:Map, parsed:Set<string>, packageOf:Function, configFor:Function, libraries:Map}} deps
 */
export function makeResolver({ files, parsed, packageOf, configFor, libraries }) {
  const ctx = { files, parsed, packageOf, configFor, libraries, VALUE: new Map(), FIELD: new Map() };
  return {
    resolveSpecifier: (file, spec) => resolveSpecifier(ctx, file, spec),
    resolveExport: (file, name, depth) => resolveExport(ctx, file, name, depth),
    resolveLocal: (file, name, depth) => resolveLocal(ctx, file, name, depth),
    valueOf: (file, name, depth) => valueOf(ctx, file, name, depth),
    fieldValue: (file, className, field, depth) => fieldValue(ctx, file, className, field, depth),
    rootValue: (file, callee, binding, depth) => rootValue(ctx, file, callee, binding, depth),
    initValue: (file, init, depth) => initValue(ctx, file, init, depth),
  };
}

/**
 * The HTTP client instances this project builds, found by walking every binding
 * and every class-field assignment once.
 *
 * `noteInstance` is handed back because the call pass finds one more kind: an
 * instance reached through a callee rather than through a binding, which is the
 * same instance and must land in the same table.
 *
 * @returns {{instanceOf:Map, noteInstance:Function}}
 */
export function collectInstances({ fileNames, files, packageOf, resolver }) {
  const instanceOf = new Map(); // instance id -> {id, module, baseURL, package}
  const noteInstance = (v, pkg) => {
    if (!v || v.kind !== 'sink-instance' || !v.id) return v;
    if (!instanceOf.has(v.id)) {
      instanceOf.set(v.id, { id: v.id, module: v.module, baseURL: v.baseURL ?? null, package: pkg });
    }
    return v;
  };
  for (const file of fileNames) {
    const f = files.get(file);
    const pkg = packageOf(file);
    for (const name of [...f.bindings.keys()].sort()) noteInstance(resolver.valueOf(file, name, 0), pkg);
    for (const a of f.assigns) noteInstance(resolver.fieldValue(file, a.class, a.field, 0), pkg);
  }
  return { instanceOf, noteInstance };
}
