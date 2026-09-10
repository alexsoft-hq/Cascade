// screens.mjs — the screens a ROUTER declares, and what each one renders.
//
// WHAT THIS MODULE OWNS. A frontend router is a table: this path mounts that
// component. This module turns that table into screen nodes and RENDERS edges:
//   the composed path    a child route's path is joined onto its parents', and
//                        the parent is as often in another file as in this one
//   the name registry    a frontend written before modules resolves nothing by
//                        path — `angular.module(…).component('ownerList', …)` is
//                        a name, and the chain of names IS the resolution (RM47)
//   the screen node      its label, its code, its group, whether it takes a
//                        parameter, and which declarations produced it
//   RENDERS              from a screen to the functions of the component it
//                        mounts, and to the components that component imports
//
// It also owns the two constants of the server-driven rule, because that rule is
// about screens this lane CANNOT see: a frontend that fetches its own menu has
// screens no router table holds.
//
// WHAT IT MUST NEVER KNOW ABOUT: how a call was traced, what a prefix is, or
// what a template engine did. A server-rendered page is a screen too, and it is
// pages.mjs that builds it: the two kinds meet only in the map of screen nodes
// they both write into.

import {
  cmp, normalizeUrl, topCounts, HOP_LIMIT, RENDERS_DEPTH,
} from './shared.mjs';
import { nodeId } from '../../core/graph.mjs';
import { isComponentFile, registryNameOf, webScreenId } from './symbols.mjs';

/**
 * The route paths that mean "this router is filled in by the server".
 *
 * A frontend whose menu comes from an API declares some routes in the source and
 * fetches the rest at run time, so the screens this lane can see are not the app.
 * THE RULE IS THE CALL: a call, resolved to a route this pack serves, whose path
 * ends in one of these. A frontend that really asks the server for its own menu
 * has screens this pack cannot hold, and how many routes it also declares in the
 * source does not change that.
 *
 * It used to need a second half, fewer than THIRTY declared routes, and a big
 * frontend that fetches its menu is server driven exactly as a small one is, so
 * the ceiling survives as the WORDING switch and nothing else: under it, most of
 * the app arrives at run time; over it, what arrives is whatever is beyond the
 * ones declared.
 *
 * WHAT THIS STILL DOES NOT CATCH, measured and left alone: a product whose menu
 * rides on an endpoint that is not spelled like one. The largest frontend in the
 * corpus declares 173 routes, 87 of them the framework's own demo pages, and
 * fetches every business screen at run time from a route named after PERMISSIONS
 * rather than after menus. No suffix here matches it, and adding that project's
 * spelling would be a rule that works on that project (SPEC §3.4).
 */
const SERVER_MENU_SUFFIXES = Object.freeze(['/getRouters', '/menu', '/menus', '/routes', '/nav']);

/** The line between "most screens arrive at run time" and "the ones beyond these do". */
export const SERVER_MENU_ROUTE_CEILING = 30;

/** The group of a screen whose path has no first segment (`/`). */
export const SCREEN_ROOT_GROUP = '(root)';

/** Past this share of unresolved components, the screen axis is degraded. */
export const SCREEN_UNRESOLVED_SHARE = 0.2;

/**
 * What each RENDERS edge rested on, in one sentence, for `evidence.basis`.
 *
 * ONE KEY PER RULE, and that is the point of the `page` key rather than a sixth
 * shade of `own`. RM48 added its page sentence to this literal under the name
 * `own` was already using, so from 0.5.0 a `route-component` edge — a router
 * declaration naming a file as the screen's component — carried the sentence
 * about a server-rendered page's inline scripts, which is a claim about a file
 * no router ever named. The router sentence is restored below; the page keeps
 * its own, under its own name; and `test/web_modules.test.mjs` now asserts the
 * basis each rule emits, so a rule and a sentence cannot drift apart again.
 */
export const SCREEN_RENDERS_BASIS = Object.freeze({
  own: 'the route declaration names this file as the screen\'s component, and this function is declared in that file. Nothing was matched by name',
  child: 'the screen\'s component imports this file, directly or through other components, and this function is declared in it. Which of an imported component\'s functions a screen really runs is a run-time question, so the edge is a candidate',
  // RM47. A frontend written before modules resolves nothing by path: the
  // framework keeps a registry of names, and a name is how one thing finds
  // another. So the chain of names IS the resolution, and it is on the edge.
  registry: 'the route names a component, and the framework resolves that name through its own registry to the file that registers it. The chain of names is on the edge, and each link is a string the framework matches exactly, the same way an import names a file',
  ambiguous: 'the same chain of names, with one name registered more than once. Which registration the framework really uses depends on the order the modules load, which is not in the source, so every file that registers the name is a candidate',
  // RM48: a SERVER-RENDERED page's own scripts, and the fragments it pulls in.
  page: 'the inline `<script>` blocks of this page. They are the page: nothing imports them, nothing else runs them, and the file they sit in is the file the handler named',
  include: 'the page pulls this template in (`<%@ include%>`, `<#include>`, `th:replace`), so whatever the fragment does, this page does too. Which branch of the page really reaches the include is a run-time question, so it is a candidate',
});

/**
 * The screen axis as the profile declares it, read once.
 *
 * A NAME SOURCE THIS ENGINE DOES NOT READ IS REFUSED, not quietly ignored.
 * `route-meta` is the route's own `meta.title`, which the worker records;
 * `jsdoc-comment` would need the comment above the component, which no lane
 * reads, so asking for it leaves every title null and says why.
 */
export function readScreenAxis({ opts, stats }) {
  const screenAxis = opts.screenAxis && typeof opts.screenAxis === 'object' ? opts.screenAxis : {};
  const screenEnabled = screenAxis.enabled === true;
  const askedNameSource = typeof screenAxis.nameSource === 'string' ? screenAxis.nameSource : 'none';
  const pathRule = typeof screenAxis.pathRule === 'string' && screenAxis.pathRule !== '' ? screenAxis.pathRule : null;
  const codeLength = Number.isInteger(opts.codeLength) && opts.codeLength > 0 ? opts.codeLength : null;
  let codeRegex = null;
  if (typeof screenAxis.codeRegex === 'string' && screenAxis.codeRegex !== '') {
    try { codeRegex = new RegExp(screenAxis.codeRegex); } catch { codeRegex = null; }
  }
  const nameSource = askedNameSource === 'route-meta' ? 'route-meta' : 'none';
  const nameSourceRefused = askedNameSource === 'jsdoc-comment'
    ? 'screenAxis.nameSource asks for jsdoc-comment, and no lane here reads the comment above a component, so every screen title is null'
    : null;
  stats.screens.enabled = screenEnabled;
  stats.screens.nameSource = { asked: askedNameSource, used: nameSource, refused: nameSourceRefused };
  stats.screens.pathRule = pathRule;
  stats.screens.codeRegex = typeof screenAxis.codeRegex === 'string' ? screenAxis.codeRegex : null;
  stats.screens.codeLength = codeLength;
  return { screenEnabled, nameSource, pathRule, codeRegex, codeLength };
}

/**
 * Every route declaration, in (file, line) order, and the server-driven verdict
 * the calls above already decided.
 */
export function readRouteRecords({ fileNames, files, matchedRoutePaths, stats }) {
  const routeRecords = [];
  for (const file of fileNames) for (const r of files.get(file).routes) routeRecords.push(r);
  routeRecords.sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
  stats.screens.declared = routeRecords.length;
  stats.screens.serverDriven.routes = routeRecords.length;
  const menuEndpoints = [...matchedRoutePaths]
    .filter((p) => SERVER_MENU_SUFFIXES.some((s) => p.endsWith(s))).sort();
  stats.screens.serverDriven.menuEndpoints = menuEndpoints;
  // THE CALL ALONE DECIDES. A frontend that fetches its own menu has screens
  // this pack cannot hold, however many it also writes down.
  stats.screens.serverDriven.detected = menuEndpoints.length > 0;
  stats.screens.serverDriven.detectedBy = menuEndpoints.length > 0 ? 'menu-call' : null;
  return routeRecords;
}

/**
 * THE PATH IS COMPOSED, not read.
 *
 * The parent of a route declaration is a LINE in the same file (the worker
 * resolves nothing across files), or a NAME, and a named parent is as often in
 * another file (`app.js` declares `app`, `owner-list.js` declares `owners`
 * under it). Both are looked up here, which is the only place that has every
 * file's records at once.
 */
function makeComposedPath(routeRecords) {
  const routeAt = new Map();
  for (const r of routeRecords) {
    const k = `${r.file}|${r.line}`;
    if (!routeAt.has(k)) routeAt.set(k, r);
  }
  // The first declaration in (file, line) order wins a name, the same rule two
  // declarations of one path follow.
  const routeByName = new Map();
  for (const r of routeRecords) {
    if (typeof r.name !== 'string' || r.name === '') continue;
    if (!routeByName.has(r.name)) routeByName.set(r.name, r);
  }
  const parentChain = (rec) => {
    const chain = [];
    const seen = new Set();
    let cur = rec;
    for (let i = 0; i < HOP_LIMIT && cur; i += 1) {
      const k = `${cur.file}|${cur.line}`;
      if (seen.has(k)) break;
      seen.add(k);
      chain.push(cur);
      if (typeof cur.parentName === 'string' && cur.parentName !== '') {
        cur = routeByName.get(cur.parentName) ?? null;
        continue;
      }
      cur = cur.parent == null ? null : (routeAt.get(`${cur.file}|${cur.parent}`) ?? null);
    }
    chain.reverse();
    return chain;
  };
  // A child path that starts with `/` is ABSOLUTE and replaces everything above
  // it; a parent whose path is `''` contributes nothing; everything else is
  // joined with one slash.
  return (rec) => {
    let out = '';
    for (const part of parentChain(rec)) {
      const p = String(part.path ?? '');
      if (p.startsWith('/')) out = p;
      else if (p === '') continue;
      else out = `${out}/${p}`;
    }
    return normalizeUrl(out);
  };
}

/**
 * The framework's own name registry (RM47).
 *
 * `angular.module('ownerList').component('ownerList', {controller:
 * 'OwnerListController'})` is a frontend written before modules saying what a
 * name means. Two indexes, one per kind, each holding EVERY file that registers
 * a name: a name registered twice is a real ambiguity, and the grade says so
 * rather than the first one winning silently.
 *
 * @typedef {{registryOf:Map, noteMissingName:Function}} RegistryCtx
 */

/** Every name the route itself puts forward, in a fixed order. */
function registrySeeds(rec) {
  const seeds = [];
  if (typeof rec.componentName === 'string' && rec.componentName !== '') {
    seeds.push({ what: 'component', name: rec.componentName, rule: 'angular-component', chain: [rec.componentName] });
  }
  if (typeof rec.componentTag === 'string' && rec.componentTag !== '') {
    const name = registryNameOf(rec.componentTag);
    seeds.push({ what: 'component', name, rule: 'angular-component', chain: [rec.componentTag, name] });
  }
  for (const tag of rec.templateTags ?? []) {
    const name = registryNameOf(tag);
    seeds.push({ what: 'component', name, rule: 'angular-template-tag', chain: [rec.templateFile ?? rec.templateUrl ?? '(template)', tag, name] });
  }
  if (typeof rec.controllerName === 'string' && rec.controllerName !== '') {
    seeds.push({ what: 'controller', name: rec.controllerName, rule: 'angular-controller', chain: [rec.controllerName] });
  }
  return seeds;
}

/** What ONE registration leads on to: its controller, and the tags in its template. */
function hopsFrom(hit, hop, grade) {
  const next = [];
  if (typeof hit.controller === 'string' && hit.controller !== '') {
    next.push({
      what: 'controller', name: hit.controller, rule: 'angular-controller',
      chain: [...hop.chain, hit.controller], grade,
    });
  }
  for (const tag of hit.templateTags ?? []) {
    const name = registryNameOf(tag);
    next.push({
      what: 'component', name, rule: 'angular-template-tag',
      chain: [...hop.chain, hit.templateFile ?? hit.templateUrl ?? '(template)', tag, name], grade,
    });
  }
  return next;
}

/**
 * The RENDERS edges one route earns through the name registry, and the names
 * that led nowhere.
 *
 * The walk is over NAMES, not over files: a route names a component, the
 * component names a controller and a template, and the template names more
 * components by their tags. Each hop is a string the framework matches
 * exactly, so a hop that lands on exactly one registration is EXACT; a name
 * registered twice makes every edge below it HEURISTIC, because which one
 * loads last is not in the source.
 *
 * @param {RegistryCtx} ctx
 * @param {Object} rec  a route record carrying registry names
 * @returns {{targets:{file:string, rule:string, chain:string[], grade:string}[], primary:(string|null)}}
 */
function attachByRegistry(ctx, rec) {
  const targets = [];
  const placed = new Set();
  const seenNames = new Set();
  const add = (file, rule, chain, grade) => {
    const key = `${file}|${rule}|${chain.join('>')}`;
    if (placed.has(key)) return;
    placed.add(key);
    targets.push({ file, rule, chain: [...chain], grade });
  };
  let frontier = registrySeeds(rec).map((s) => ({ ...s, grade: 'EXACT' }));
  for (let depth = 0; depth < RENDERS_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const hop of frontier.slice().sort((a, b) => cmp(a.name, b.name) || cmp(a.rule, b.rule))) {
      const nameKey = `${hop.what}:${hop.name}`;
      if (seenNames.has(nameKey)) continue; // a cycle in the registry, cut here
      seenNames.add(nameKey);
      // A COMPONENT, OR THE DIRECTIVE THAT IS ONE. Before components existed
      // the same job was done by a directive with a controller, and the
      // framework mounts both by writing the element. The component registry
      // is asked first, because that is the one a modern file registers in.
      let hits = ctx.registryOf.get(nameKey) ?? [];
      if (hits.length === 0 && hop.what === 'component') hits = ctx.registryOf.get(`directive:${hop.name}`) ?? [];
      if (hits.length === 0) { ctx.noteMissingName(hop.what, hop.name); continue; }
      const grade = hits.length > 1 ? 'HEURISTIC' : hop.grade;
      for (const hit of hits) {
        add(hit.file, hop.rule, hop.chain, grade);
        if (hop.what !== 'component') continue;
        next.push(...hopsFrom(hit, hop, grade));
      }
    }
    frontier = next;
  }
  // The file a reader would call "the screen's component": the first target of
  // the first seed, in the order above.
  return { targets, primary: targets.length > 0 ? targets[0].file : null };
}

/** Whether a route names its component through a registry rather than a path. */
function namesByRegistry(rec) {
  return typeof rec.componentName === 'string'
    || typeof rec.componentTag === 'string'
    || typeof rec.controllerName === 'string'
    || (rec.templateTags ?? []).length > 0;
}

/** The registry for one run: every registration, indexed by what it names. */
export function makeNameRegistry({ fileNames, files }) {
  const registryOf = new Map(); // `${what}:${name}` -> registration records
  for (const file of fileNames) {
    for (const r of files.get(file).registrations) {
      if (typeof r.name !== 'string' || r.name === '' || typeof r.what !== 'string') continue;
      const key = `${r.what}:${r.name}`;
      let arr = registryOf.get(key);
      if (!arr) registryOf.set(key, arr = []);
      arr.push(r);
    }
  }
  const unresolvedNames = new Map();
  const noteMissingName = (what, name) => {
    const key = `${what} ${name}`;
    unresolvedNames.set(key, (unresolvedNames.get(key) ?? 0) + 1);
  };
  const ctx = { registryOf, noteMissingName };
  return { attachByRegistry: (rec) => attachByRegistry(ctx, rec), namesByRegistry, unresolvedNames };
}

/** The screen node one route declaration produces: its label, its code, its group. */
function screenNodeOf(rec, full, componentFile, { nameSource, pathRule, codeRegex, codeLength }) {
  const title = nameSource === 'route-meta' ? (rec.metaTitle ?? null) : null;
  const segments = full.split('/').filter((s) => s !== '');
  const label = pathRule === 'last-segment' ? (segments[segments.length - 1] ?? full) : full;
  let code = null;
  if (codeRegex) {
    for (const hay of [rec.name ?? null, title, full]) {
      if (typeof hay !== 'string') continue;
      const m = codeRegex.exec(hay);
      if (m) { code = m[1] ?? m[0]; break; }
    }
  }
  // The GROUP a screen belongs to: the leading characters of its code when the
  // project declares both, and otherwise the first path segment, which is a
  // naming habit rather than a boundary anybody declared.
  const group = code !== null && codeLength !== null
    ? code.slice(0, codeLength)
    : (segments[0] ?? SCREEN_ROOT_GROUP);
  return {
    id: webScreenId(full),
    path: full,
    name: rec.name ?? null,
    title,
    label,
    code,
    group,
    component: componentFile,
    file: rec.file,
    line: rec.line ?? null,
    pack: rec.pack ?? null,
    // `{id}` is the third spelling of a parameter this engine reads: `:id` is
    // a declared router's, `*` a wildcard's, and `{id}` the one a file-tree
    // route writes (RM56) and the one every backend route is written in.
    params: /[:*{]/.test(full),
    lane: 'web',
    source: 'router',
    declaredAt: [{ file: rec.file, line: rec.line }],
  };
}

/**
 * B7b: the screens the router declares.
 *
 * @returns {{screenNodes:Map, registryTargets:Map, unresolvedSpecifiers:Map}}
 */
export function buildRouterScreens({
  routeRecords, screenEnabled, axis, registry, resolver, stats,
}) {
  const composedPath = makeComposedPath(routeRecords);
  const unresolvedSpecifiers = new Map();
  const screenNodes = new Map(); // screen id -> node
  const registryTargets = new Map(); // screen id -> what attachByRegistry found
  if (!screenEnabled) return { screenNodes, registryTargets, unresolvedSpecifiers, composedPath };
  for (const rec of routeRecords) {
    const hasComponent = typeof rec.componentSource === 'string' || typeof rec.componentLocal === 'string'
      || rec.componentSelf === true || namesByRegistry(rec);
    // A REDIRECT IS NOT A SCREEN. `{path:'/', redirect:'/home'}` mounts
    // nothing and shows nothing; it is a rule about where to go next.
    if (!hasComponent && (rec.children ?? 0) === 0 && rec.redirect != null) continue;
    // AN ABSTRACT STATE IS NOT A SCREEN EITHER, and it is not nothing: it is
    // the path its children hang off, so it composes and it does not mount.
    if (rec.abstract === true) continue;
    const full = composedPath(rec);
    const id = webScreenId(full);
    const existing = screenNodes.get(id);
    if (existing) {
      // TWO DECLARATIONS, ONE PATH. The first in (file, line) order is the
      // node; every declaration is listed, because which one a reader is
      // looking at is a real question.
      existing.declaredAt.push({ file: rec.file, line: rec.line });
      stats.screens.duplicatePaths += 1;
      continue;
    }
    let componentFile = null;
    let componentSpec = null;
    let registryHit = null;
    // A FILE-TREE ROUTE (RM56): the page IS its own component, so there is
    // nothing to resolve and nothing that can fail to resolve.
    if (rec.componentSelf === true) componentFile = rec.file;
    else if (namesByRegistry(rec)) {
      // A NAME, NOT A PATH. Nothing imports anything here, so the file comes
      // from the framework's registry and a name nobody registered is the
      // same gap an unresolvable specifier is.
      registryHit = registry.attachByRegistry(rec);
      componentFile = registryHit.primary;
      if (componentFile === null) stats.screens.componentUnresolved += 1;
    } else if (typeof rec.componentSource === 'string' && rec.componentSource !== '') {
      componentSpec = rec.componentSource;
      const r = resolver.resolveSpecifier(rec.file, rec.componentSource);
      if (r.file) componentFile = r.file;
    } else if (typeof rec.componentLocal === 'string' && rec.componentLocal !== '') {
      componentSpec = `(declared in ${rec.file} as ${rec.componentLocal})`;
    }
    if (componentSpec !== null && componentFile === null) {
      stats.screens.componentUnresolved += 1;
      unresolvedSpecifiers.set(componentSpec, (unresolvedSpecifiers.get(componentSpec) ?? 0) + 1);
    }
    const node = screenNodeOf(rec, full, componentFile, axis);
    if (rec.hidden === true) { node.hidden = true; stats.screens.hidden += 1; }
    if (node.params) stats.screens.withParams += 1;
    if (componentFile !== null) stats.screens.withComponent += 1;
    screenNodes.set(id, node);
    if (registryHit !== null) registryTargets.set(id, registryHit.targets);
  }
  stats.screens.byKind.router = screenNodes.size;
  return { screenNodes, registryTargets, unresolvedSpecifiers, composedPath };
}

/** The component files one component imports, directly, in a fixed order. */
function makeComponentChildren({ files, resolver }) {
  const componentImports = new Map();
  return (file) => {
    let out = componentImports.get(file);
    if (out) return out;
    out = [];
    const f = files.get(file);
    for (const imp of f ? f.imports : []) {
      const r = resolver.resolveSpecifier(file, imp.source);
      if (!r.file || !isComponentFile(r.file) || r.file === file) continue;
      out.push(r.file);
    }
    out = [...new Set(out)].sort();
    componentImports.set(file, out);
    return out;
  };
}

/**
 * A SERVER-RENDERED page's RENDERS edges (RM48).
 *
 * A PAGE'S OWN CODE IS ITS OWN FILE. Nothing imports a template and nothing
 * imports out of one: what the page runs is the scripts written in it, and what
 * it also runs is whatever the templates it INCLUDES do. So the walk is over
 * the include graph and over nothing else.
 */
function pageRenders(id, node, ctx) {
  const { symbolsByFile, includeClosure, templatesByFile, nodesToAdd, edges, stats } = ctx;
  for (const sym of symbolsByFile.get(node.template) ?? []) {
    stats.screens.renders.EXACT += 1;
    edges.push({
      from: id, to: sym, type: 'RENDERS', grade: 'EXACT',
      evidence: { rule: 'template-own', component: node.template, basis: SCREEN_RENDERS_BASIS.page },
    });
  }
  for (const [child, depth] of [...includeClosure(node.template).entries()].sort((a, b) => cmp(a[0], b[0]))) {
    // The fragment itself, as one node: a reader asking "what does this page
    // pull in?" gets one answer per include, whether or not it holds code.
    const childId = nodeId('symbol', child);
    if (!nodesToAdd.has(childId)) {
      nodesToAdd.set(childId, {
        id: childId, symbol: child, file: child, line: 1, lane: 'web',
        exported: null, template: true, engine: templatesByFile.get(child)?.engine ?? null,
      });
    }
    const evidence = { rule: 'template-include', component: child, depth, basis: SCREEN_RENDERS_BASIS.include };
    stats.screens.renders.SOUND_SET += 1;
    edges.push({ from: id, to: childId, type: 'RENDERS', grade: 'SOUND_SET', evidence });
    for (const sym of symbolsByFile.get(child) ?? []) {
      stats.screens.renders.SOUND_SET += 1;
      edges.push({ from: id, to: sym, type: 'RENDERS', grade: 'SOUND_SET', evidence });
    }
  }
}

/**
 * A SCREEN THAT RESOLVED BY NAME took a different road here (RM47): the
 * registry walk already knows every file, and following imports out of those
 * files would be following imports a frontend written before modules does not
 * have.
 */
function registryRenders(id, byRegistry, { symbolsByFile, edges, stats }) {
  const order = byRegistry.slice()
    .sort((a, b) => cmp(a.file, b.file) || cmp(a.rule, b.rule) || cmp(a.chain.join('>'), b.chain.join('>')));
  for (const t of order) {
    for (const sym of symbolsByFile.get(t.file) ?? []) {
      stats.screens.renders[t.grade] += 1;
      edges.push({
        from: id, to: sym, type: 'RENDERS', grade: t.grade,
        evidence: {
          rule: t.rule,
          component: t.file,
          names: t.chain,
          basis: t.grade === 'HEURISTIC' ? SCREEN_RENDERS_BASIS.ambiguous : SCREEN_RENDERS_BASIS.registry,
        },
      });
    }
  }
}

/**
 * The ordinary road: the file the route declares is the screen's own component
 * (EXACT), and every component that one IMPORTS, however deep, is a candidate
 * child (SOUND_SET, with the import chain on the edge).
 */
function componentRenders(id, root, ctx) {
  const { symbolsByFile, componentChildrenOf, edges, stats } = ctx;
  for (const sym of symbolsByFile.get(root) ?? []) {
    stats.screens.renders.EXACT += 1;
    edges.push({
      from: id, to: sym, type: 'RENDERS', grade: 'EXACT',
      evidence: { rule: 'route-component', component: root, basis: SCREEN_RENDERS_BASIS.own },
    });
  }
  const seen = new Set([root]);
  let frontier = [[root]];
  for (let depth = 0; depth < RENDERS_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const via of frontier) {
      for (const child of componentChildrenOf(via[via.length - 1])) {
        if (seen.has(child)) continue; // a cycle, cut here
        seen.add(child);
        const chain = [...via, child];
        next.push(chain);
        for (const sym of symbolsByFile.get(child) ?? []) {
          stats.screens.renders.SOUND_SET += 1;
          edges.push({
            from: id, to: sym, type: 'RENDERS', grade: 'SOUND_SET',
            evidence: { rule: 'component-import', component: child, via: chain, basis: SCREEN_RENDERS_BASIS.child },
          });
        }
      }
    }
    frontier = next;
  }
}

/**
 * B7c: RENDERS.
 *
 * NOTHING HERE IS GUESSED FROM A NAME. Three roads, one per kind of screen: a
 * page renders its own scripts and its includes; a screen that resolved by name
 * renders what the registry walk found; and a screen with a component file
 * renders that file and the components it imports.
 */
export function placeRendersEdges({
  screenNodes, registryTargets, symbolsByFile, files, resolver,
  templatesByFile, includeClosure, nodesToAdd, edges, stats,
}) {
  const ctx = {
    symbolsByFile,
    componentChildrenOf: makeComponentChildren({ files, resolver }),
    includeClosure,
    templatesByFile,
    nodesToAdd,
    edges,
    stats,
  };
  for (const id of [...screenNodes.keys()].sort()) {
    const node = screenNodes.get(id);
    nodesToAdd.set(id, node);
    // A page and a Nexacro form take the same road: what the screen runs is its
    // OWN file's scripts, plus whatever the files it pulls in do (RM48, RM56).
    if (node.source === 'view' || node.source === 'nexacro') { pageRenders(id, node, ctx); continue; }
    const byRegistry = registryTargets.get(id);
    if (byRegistry !== undefined) { registryRenders(id, byRegistry, ctx); continue; }
    if (node.component !== null) componentRenders(id, node.component, ctx);
  }
}

/** The three "what did we fail to resolve" lists, in the order a reader reads them. */
export function summariseScreens({ stats, screenNodes, unresolvedSpecifiers, unresolvedNames }) {
  stats.screens.screens = screenNodes.size;
  stats.screens.unresolvedSpecifiers = topCounts(unresolvedSpecifiers, 10, 'specifier');
  stats.screens.unresolvedNames = topCounts(unresolvedNames, 10, 'name');
}
