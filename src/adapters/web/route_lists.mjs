// route_lists.mjs — the routes one file NAMES in another (RM67).
//
// WHAT THIS MODULE OWNS. A router that declares its routes in more than one
// file joins them by NAME. A route loads the list another module exports
// (`loadChildren: () => import('./orders.routes')`); a list holds routes and
// lists bound to names (`[ordersRoute, ...errorRoutes]`); a route's children
// are a list written somewhere else (`children: ORDER_ROUTES`); a module
// registers a list as somebody's children (`RouterModule.forChild(routes)`).
// The worker records each name as it is written (`childrenFrom`, `routeRef`,
// the `list` a route sits in); this module resolves them through the same
// specifier and export rules a call is resolved by, and answers, per route,
// which routes it hangs off in another file. It also reads a route path
// written as a constant another module exports (`pathRef`).
//
// This is code the router reading learns ONCE, for every router: nothing here
// names a framework, and a pack whose records carry none of these fields gets
// nothing from it, which is how a Vue or a React project's screens stay what
// they were.
//
// WHAT IT MUST NEVER KNOW ABOUT: screens, RENDERS, the graph. It answers
// questions about route records and nothing else.

import { topCounts, HOP_LIMIT } from './shared.mjs';

/** How many paths one route may compose to through lists loaded from several places. */
export const MAX_PATHS_PER_ROUTE = 16;

/** Every named list, file by file: the routes it holds and the names it holds. */
function indexLists(routeRecords, fileNames, files) {
  const members = new Map(); // `${file}|${list}` -> {routes:[], refs:[]}
  const slot = (key) => {
    let m = members.get(key);
    if (!m) members.set(key, m = { routes: [], refs: [] });
    return m;
  };
  for (const r of routeRecords) {
    if (r.parent == null && typeof r.list === 'string') slot(`${r.file}|${r.list}`).routes.push(r);
  }
  const childRefs = new Map(); // `${file}|${parent line}` -> refs
  const registered = [];
  for (const file of fileNames) {
    for (const ref of files.get(file).routeRefs ?? []) {
      if (typeof ref.registrar === 'string') registered.push(ref);
      else if (ref.parent != null) {
        const k = `${file}|${ref.parent}`;
        if (!childRefs.has(k)) childRefs.set(k, []);
        childRefs.get(k).push(ref);
      } else if (typeof ref.list === 'string') slot(`${file}|${ref.list}`).refs.push(ref);
    }
  }
  return { members, childRefs, registered };
}

/** The list a NAME in a file stands for: one it declares, or one it imports. */
function resolveListName(ctx, file, name) {
  const own = `${file}|${name}`;
  if (ctx.members.has(own)) return own;
  const imp = ctx.files.get(file)?.importOf.get(name);
  if (!imp || imp.imported === '*') return null;
  return exportedList(ctx, file, imp.source, imp.imported);
}

/** The list a module exports under a name, reached from a file through a specifier. */
function exportedList(ctx, file, source, exported) {
  const r = ctx.resolver.resolveSpecifier(file, source);
  if (!r.file) return null;
  const hit = ctx.resolver.resolveExport(r.file, exported, 0);
  if (!hit || hit.external || !hit.file) return null;
  const key = `${hit.file}|${hit.name}`;
  return ctx.members.has(key) ? key : null;
}

/**
 * A NAME ONE ROUTE OR LIST WRITES, resolved to the list it stands for, and
 * counted once however many times the lists around it are walked.
 */
function followRef(ctx, file, ref) {
  const k = resolveListName(ctx, file, ref.name);
  if (!ctx.counted.has(ref)) {
    ctx.counted.add(ref);
    ctx.stats.refs += 1;
    if (k === null) ctx.miss('ref', `${file}: ${ref.name}`);
  }
  return k;
}

/** Every route a list holds, through the names it holds, cycles cut. */
function flatten(ctx, key, seen = new Set()) {
  if (seen.has(key) || seen.size > HOP_LIMIT * 4) return [];
  seen.add(key);
  const m = ctx.members.get(key);
  if (!m) return [];
  const out = [...m.routes];
  const file = key.slice(0, key.lastIndexOf('|'));
  for (const ref of m.refs) {
    const k = followRef(ctx, file, ref);
    if (k !== null) out.push(...flatten(ctx, k, seen));
  }
  return out;
}

/** The lists one route names as its children in another file: the lazy one, and the named ones. */
function childListsOf(ctx, p) {
  const keys = [];
  if (p.childrenFrom && typeof p.childrenFrom.source === 'string') {
    ctx.stats.lazy += 1;
    const k = exportedList(ctx, p.file, p.childrenFrom.source, p.childrenFrom.export ?? 'default');
    if (k === null) ctx.miss('lazy', `${p.file}: ${p.childrenFrom.source}${p.childrenFrom.export && p.childrenFrom.export !== 'default' ? ` (${p.childrenFrom.export})` : ''}`);
    else keys.push(k);
  }
  for (const ref of ctx.childRefs.get(`${p.file}|${p.line}`) ?? []) {
    const k = followRef(ctx, p.file, ref);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/**
 * What a route path written as a CONSTANT another module exports holds: the
 * text under that path in the exporter's `constant` record, or null. The name
 * is the one the worker spelled (`appPaths.orders.path`), and its root is the
 * import.
 */
function importedPathOf(ctx, rec) {
  const ref = rec.pathRef;
  if (!ref || typeof ref.source !== 'string') return null;
  const parts = String(ref.name).split('.');
  const exported = ref.imported === '*' ? parts[1] : ref.imported;
  const rest = ref.imported === '*' ? parts.slice(2) : parts.slice(1);
  if (typeof exported !== 'string') return null;
  const r = ctx.resolver.resolveSpecifier(rec.file, ref.source);
  if (!r.file) return null;
  const hit = ctx.resolver.resolveExport(r.file, exported, 0);
  const c = hit && !hit.external && hit.file ? ctx.files.get(hit.file)?.constants.get(hit.name) : null;
  if (!c) return null;
  const v = rest.length === 0 ? c.value : rest.length === 1 ? (c.members ?? {})[rest[0]] : (c.nested ?? {})[rest.join('.')];
  return typeof v === 'string' ? v : null;
}

/** The counters this module fills, zeroed. */
export function emptyRouteListStats() {
  return {
    lazy: 0, refs: 0, pathRefs: 0,
    // Each is a route whose path this lane could not compose, and the list
    // under `unresolved` says which name it could not follow.
    pathRefsUnresolved: 0, childListsWithoutParent: 0, pathUnknown: 0,
    groupings: 0, outlets: 0,
    unresolved: [],
  };
}

/**
 * THE CROSS-FILE HALF OF COMPOSING A PATH, for one run.
 *
 * @returns {{parentsOf:Function, childOnly:Function, pathOf:Function, finish:Function}}
 *   `parentsOf(rec)` the routes in other files `rec` hangs off; `childOnly(rec)`
 *   whether a child registrar holds its list and nothing loads it; `pathOf(rec)`
 *   its own path, through an imported constant when it was written as one, or
 *   null; `finish()` writes the list of what could not be followed.
 */
export function makeRouteLists({ routeRecords, fileNames, files, resolver, stats }) {
  const idx = indexLists(routeRecords, fileNames, files);
  const misses = new Map();
  const ctx = {
    ...idx, files, resolver, stats, counted: new Set(),
    miss: (kind, what) => misses.set(`${kind} ${what}`, (misses.get(`${kind} ${what}`) ?? 0) + 1),
  };
  const parents = new Map(); // route record -> parent route records
  for (const p of routeRecords) {
    for (const key of childListsOf(ctx, p)) {
      for (const m of flatten(ctx, key)) {
        if (m === p) continue;
        if (!parents.has(m)) parents.set(m, []);
        if (!parents.get(m).includes(p)) parents.get(m).push(p);
      }
    }
  }
  const childOnly = new Set();
  for (const ref of idx.registered) {
    const key = resolveListName(ctx, ref.file, ref.name);
    if (key === null) { ctx.miss('registered', `${ref.file}: ${ref.name}`); continue; }
    for (const m of flatten(ctx, key)) childOnly.add(m);
  }
  const paths = new Map();
  const pathOf = (rec) => {
    if (typeof rec.path === 'string') return rec.path;
    if (paths.has(rec)) return paths.get(rec);
    stats.pathRefs += 1;
    const v = importedPathOf(ctx, rec);
    if (v === null) {
      stats.pathRefsUnresolved += 1;
      ctx.miss('path', `${rec.file}: ${rec.pathRef ? rec.pathRef.name : '(unreadable)'}`);
    }
    paths.set(rec, v);
    return v;
  };
  return {
    parentsOf: (rec) => parents.get(rec) ?? [],
    childOnly: (rec) => childOnly.has(rec) && !parents.has(rec),
    pathOf,
    finish: () => { stats.unresolved = topCounts(misses, 15, 'name'); },
  };
}
