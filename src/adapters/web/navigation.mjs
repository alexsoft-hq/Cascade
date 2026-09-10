// navigation.mjs — where a screen goes when the browser never asks the server.
//
// WHAT THIS MODULE OWNS: everything between "the worker saw a call on a router"
// and "this screen says which screens it leads to". A navigation places NO edge:
// it is data on the screen node, because a screen change is a fact about the
// frontend's own shape and not a hop on the round trip from a screen to a
// column. Adding an edge type for it would put it in every walk that follows
// edges, which is not what it is.
//
// WHY IT IS HERE AT ALL. `router.push('/auth/login')` used to be read as an
// HTTP call: the argument is path-shaped, so every rule in `calls.mjs` saw a
// request. It produced a route nothing serves, graded UNRESOLVED, and since
// RM44 such a false call could try to cross into a sibling project. The worker
// now tells the two apart by the SINK (adapters/web/packs/navigation.json), and
// this module answers the one question a single file cannot: is the path this
// navigation names a screen this project declares?
//
// WHAT IT MUST NEVER KNOW ABOUT: the endpoints, the prefixes, the client
// libraries. A navigation has no prefix and no method — it is not a request.

import { cmp, normalizeUrl, topCounts } from './shared.mjs';
import { routeMatches } from '../http_routes.mjs';

/** The evidence rule every entry carries, the same word the worker stamped. */
export const NAVIGATION_RULE = 'router-navigation';

// WHY A `navigatesTo` ENTRY CARRIES NO `basis` SENTENCE, when every edge does.
// A basis explains a GRADE, and a navigation has none: it places no edge, so
// there is nothing to be more or less sure about. What the entry carries instead
// is the sink that was called and the place it is written, which is the whole of
// the evidence. docs/setup/web-lane.md says the rest.

/**
 * A screen path with its parameters written the way every other path here is.
 *
 * A router declares one three ways: `:rowId` is a declared router's spelling,
 * `{rowId}` is a file-tree route's and a backend route's, and `*` is a wildcard.
 * The matcher reads the second, so the first is spelled over before anything is
 * compared. The NODE keeps the path as the project wrote it; only the lookup
 * key is rewritten.
 */
const screenMatchPath = (p) => normalizeUrl(p).split('/')
  .map((seg) => (seg.startsWith(':') ? `{${seg.slice(1)}}` : seg)).join('/');

/**
 * The screens of this pack, indexed the two ways a navigation is matched
 * against them — exactly, and by template.
 *
 * A screen path and a navigation path have holes of different kinds (`/user/{id}`
 * against `/user/{*}`), which is the same mismatch a call has against a route,
 * so it is the same rule that settles it.
 *
 * @param {Map<string,object>} screenNodes
 * @returns {{byPath:Map<string,string[]>, paths:string[], byComponent:Map<string,string[]>}}
 */
export function buildScreenIndex(screenNodes) {
  const byPath = new Map();
  const byComponent = new Map();
  for (const id of [...screenNodes.keys()].sort()) {
    const node = screenNodes.get(id);
    if (typeof node.path === 'string') {
      const p = screenMatchPath(node.path);
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(id);
    }
    // WHICH SCREEN A NAVIGATION IS WRITTEN IN: the one whose component is this
    // file. A navigation in a shared component belongs to no screen by that
    // rule, and is counted without being recorded anywhere — saying it belongs
    // to every screen that mounts the component would be a guess.
    const file = typeof node.component === 'string' ? node.component : null;
    if (file !== null) {
      if (!byComponent.has(file)) byComponent.set(file, []);
      byComponent.get(file).push(id);
    }
  }
  return { byPath, paths: [...byPath.keys()].sort(), byComponent };
}

/** Every screen one navigation path names, exactly or by template. */
function screensFor(index, path) {
  const p = normalizeUrl(path);
  const exact = index.byPath.get(p);
  if (exact !== undefined) return { how: 'exact', ids: exact };
  const ids = [];
  for (const sp of index.paths) {
    if (sp === p || !routeMatches(sp, p)) continue;
    for (const id of index.byPath.get(sp)) ids.push(id);
  }
  return ids.length > 0 ? { how: 'template', ids } : { how: null, ids: [] };
}

/** One navigation's target paths, or an empty list when this file could not say. */
function targetsOf(rec) {
  const to = rec.to ?? null;
  if (to === null || !Array.isArray(to.resolved)) return [];
  return to.resolved.map((r) => r.template).filter((t) => typeof t === 'string');
}

/**
 * WHERE EACH SCREEN LEADS, recorded on the screen the navigation is written in.
 *
 * One entry per (screen it leads to, place it is written), sorted, so two runs
 * over the same tree write the same bytes. The site is counted ONCE however
 * many screens its path matches: a navigation whose path is `/user/{*}` names
 * one act, not one act per screen it could land on.
 *
 * @returns {{unmatched:Map<string,number>}} the paths that name no screen
 */
export function placeNavigations({ fileNames, files, screenNodes, stats }) {
  const index = buildScreenIndex(screenNodes);
  const entries = new Map(); // screen id -> entry key -> entry
  const unmatched = new Map();
  for (const file of fileNames) {
    for (const rec of files.get(file).navigations ?? []) {
      stats.navigation.navigations += 1;
      const framework = rec.framework ?? 'unknown';
      stats.navigation.byFramework[framework] = (stats.navigation.byFramework[framework] ?? 0) + 1;
      const found = [];
      for (const path of targetsOf(rec)) {
        const hit = screensFor(index, path);
        if (hit.how === null) {
          const key = normalizeUrl(path);
          unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
          continue;
        }
        for (const id of hit.ids) found.push({ id, path: normalizeUrl(path), how: hit.how });
      }
      if (found.length === 0) { stats.navigation.navigationsUnmatched += 1; continue; }
      stats.navigation.navigationsToScreen += 1;
      for (const from of index.byComponent.get(file) ?? []) {
        if (!entries.has(from)) entries.set(from, new Map());
        const mine = entries.get(from);
        for (const f of found) {
          const entry = {
            to: f.id, path: f.path, match: f.how, rule: NAVIGATION_RULE,
            framework, sink: rec.sink ?? null, file, line: rec.line ?? null,
          };
          const key = JSON.stringify(entry);
          if (!mine.has(key)) mine.set(key, entry);
        }
      }
    }
  }
  for (const [id, mine] of entries) {
    const node = screenNodes.get(id);
    if (node === undefined) continue;
    node.navigatesTo = [...mine.values()].sort((a, b) => cmp(a.to, b.to) || cmp(a.file, b.file)
      || (a.line ?? 0) - (b.line ?? 0) || cmp(a.sink ?? '', b.sink ?? ''));
  }
  stats.navigation.screensWithNavigation = entries.size;
  stats.navigation.unmatchedPaths = topCounts(unmatched, 15, 'path');
  return { unmatched };
}
