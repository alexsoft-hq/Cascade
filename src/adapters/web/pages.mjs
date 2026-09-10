// pages.mjs — the OTHER kind of screen: the one the server renders (RM48).
//
// WHAT THIS MODULE OWNS. A router declares a path and mounts a component; a
// `@Controller` answers a path and returns a VIEW NAME, and a view resolver
// turns that name into a template file. Both are a screen. This module owns the
// second kind end to end:
//   the template index   which file each view name resolves to, what each page
//                        INCLUDES, and which templates are rendered at all
//   the context path     the JavaScript names a page's own scripts use for
//                        "where this deployment is mounted"
//   the page screen      one node per rendered view name, carrying every route
//                        whose handler returns it
//   RENDERS_PAGE         handler --RENDERS_PAGE--> screen, EXACT: the literal
//                        the handler returned IS the resolver's input
//   the redirect         `return "redirect:/catalog"` is not a page, it is a
//                        CALL onto another route of this same application
//
// A template nobody renders is DEAD MARKUP: it is counted and its links are
// nobody's calls. That decision is made here and read by calls.mjs, which is
// why the template index is built before a single call is classified.
//
// WHAT IT MUST NEVER KNOW ABOUT: the router, the prefix rules, the wrapper
// fixpoint. It is handed `matchUrl` for the redirect, because a redirect is
// matched against the route table exactly like any other call.

import { nodeId } from '../../core/graph.mjs';
import { cmp, normalizeUrl, topCounts, RENDERS_DEPTH } from './shared.mjs';
import { webEndpointId } from './symbols.mjs';
import { namesARoute } from './calls.mjs';
import { SCREEN_ROOT_GROUP } from './screens.mjs';

/** What a RENDERS_PAGE edge and a redirect rest on, in one sentence. */
export const PAGE_RENDERS_BASIS = Object.freeze({
  view: 'the handler returns this view NAME as a literal, and the view resolver joins its configured prefix and suffix onto that literal to find the file. The name is the resolver\'s exact input, so nothing here was matched or guessed',
  constant: 'the handler returns a `static final String` its own class declares, and the field is initialised with this literal on the line above. Both are in one file, so the name is read rather than resolved, and it is the resolver\'s exact input like any other literal',
  helper: 'the handler returns a call to a private method of its own class, and every return of that method is a literal or one of the class\'s own constants. Both are in one file and the method is read one level deep, so a return inside it that is itself a call would have left the page unnamed rather than guessed',
  redirect: 'the handler returns `redirect:` or `forward:` with a path, which sends the browser (or the container) to another route of this same application. It is a call onto that route, matched against the routes this pack serves like any other call',
});

/** The template files one template pulls in, directly, in a fixed order. */
function makeIncludedBy(templatesByFile) {
  return (file) => {
    const t = templatesByFile.get(file);
    if (!t) return [];
    return [...new Set((t.includes ?? [])
      .map((i) => (i && typeof i.file === 'string' ? i.file : null))
      .filter((f) => f !== null && f !== file && templatesByFile.has(f)))].sort();
  };
}

/** Every template reachable from one, includes followed, with the depth each was found at. */
function makeIncludeClosure(includedBy) {
  return (file) => {
    const out = new Map();
    let frontier = [file];
    const seen = new Set([file]);
    for (let depth = 1; depth <= RENDERS_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const cur of frontier) {
        for (const child of includedBy(cur)) {
          if (seen.has(child)) continue;
          seen.add(child);
          out.set(child, depth);
          next.push(child);
        }
      }
      frontier = next;
    }
    return out;
  };
}

/**
 * The JavaScript names that hold the CONTEXT PATH for one page: the ones its
 * own scripts assign, plus the ones every template it includes assigns. A
 * layout writes `var base_url = '${request.contextPath}'` once and every page
 * that includes it is written against that name.
 */
function makeContextVarsFor(templatesByFile, includeClosure) {
  const cache = new Map();
  return (file) => {
    let out = cache.get(file);
    if (out) return out;
    out = new Set(templatesByFile.get(file)?.contextVars ?? []);
    for (const other of includeClosure(file).keys()) {
      for (const n of templatesByFile.get(other)?.contextVars ?? []) out.add(n);
    }
    cache.set(file, out);
    return out;
  };
}

/**
 * Every template a handler NAMES, and every template one of those includes.
 *
 * A template outside that set is a fragment nobody pulls in or a page nobody
 * serves: it is COUNTED, and its links are not somebody's calls.
 */
function renderedTemplatesOf(viewRecords, templateByName, includeClosure) {
  const rendered = new Set();
  for (const v of viewRecords) {
    for (const view of v.views ?? []) {
      if (!view || view.kind !== 'view') continue;
      const file = templateByName.get(String(view.name ?? '').replace(/^\/+/, ''));
      if (file === undefined) continue;
      rendered.add(file);
      for (const other of includeClosure(file).keys()) rendered.add(other);
    }
  }
  return rendered;
}

/**
 * B1b: the templates, indexed, BEFORE anything reads a call.
 *
 * It runs first because it decides two things the call pass needs: a template's
 * URLs are written from the app root, and a template nobody renders is dead
 * markup whose links are nobody's calls.
 *
 * @returns {{templatesByFile:Map, templateByName:Map, includedBy:Function,
 *            includeClosure:Function, contextVarsFor:Function,
 *            renderedTemplates:Set<string>, viewRecords:object[]}}
 */
export function indexTemplates({ fileNames, files, opts }) {
  const templatesByFile = new Map();
  for (const file of fileNames) {
    const t = files.get(file).template;
    if (t) templatesByFile.set(file, t);
  }
  const templateByName = new Map();
  for (const file of [...templatesByFile.keys()].sort()) {
    const t = templatesByFile.get(file);
    if (typeof t.name === 'string' && t.name !== '' && !templateByName.has(t.name)) templateByName.set(t.name, file);
  }
  const includedBy = makeIncludedBy(templatesByFile);
  const includeClosure = makeIncludeClosure(includedBy);
  const contextVarsFor = makeContextVarsFor(templatesByFile, includeClosure);
  const viewRecords = (opts.views ?? [])
    .filter((v) => v && typeof v === 'object' && typeof v.owner === 'string' && typeof v.method === 'string')
    .slice()
    .sort((a, b) => cmp(a.owner, b.owner) || cmp(a.method, b.method) || (a.paramCount ?? 0) - (b.paramCount ?? 0));
  // A NEXACRO FORM IS ITS OWN SCREEN (RM56). Nothing renders it: a user opens
  // it, so no handler names it and the "rendered" question does not arise. It
  // is rendered, and so is every script it includes.
  const rendered = renderedTemplatesOf(viewRecords, templateByName, includeClosure);
  for (const [file, t] of templatesByFile) {
    if (t.engine !== 'nexacro') continue; // a shared script is rendered THROUGH the form that includes it
    rendered.add(file);
    for (const other of includeClosure(file).keys()) rendered.add(other);
  }
  return {
    templatesByFile,
    templateByName,
    includedBy,
    includeClosure,
    contextVarsFor,
    renderedTemplates: rendered,
    viewRecords,
  };
}

/**
 * B7b'': the screens a NEXACRO client declares (RM56).
 *
 * There is no router and there is no handler. A Nexacro form IS a screen: the
 * file is the screen, its `<Form id>` is what the application calls it, its
 * `titletext` is what a user reads on it, and its path in the tree is the path
 * the client opens it by (`Pattern::Pattern_01.xfdl`). So the screen is built
 * straight from the template record, and RENDERS then follows the page rules —
 * the form's own script, and the shared scripts it includes.
 *
 * @returns {number} how many screens were built
 */
export function buildNexacroScreens({ templatesByFile, screenNodes, stats, axis }) {
  let built = 0;
  for (const file of [...templatesByFile.keys()].sort()) {
    const t = templatesByFile.get(file);
    if (t.engine !== 'nexacro') continue;
    const name = typeof t.name === 'string' && t.name !== '' ? t.name : file;
    // KEYED BY ITS PATH, the way a router's screen is. A form's path in the
    // client IS its identity — one form, one path, no handler naming it — so a
    // reader who saw `/packageB/Pattern/Pattern_01` in a list can hand that
    // string straight back to `flow`. A path a router already claimed keeps the
    // router's screen; nothing is merged.
    const path = `/${name}`;
    const id = nodeId('screen', path);
    if (screenNodes.has(id)) continue;
    const node = pageNodeOf(name, file, 'nexacro', axis);
    node.id = id;
    node.source = 'nexacro';
    node.path = path;
    node.paths = [path];
    // The form's own id and the words on its title bar. A screen a reader can
    // find in the product is a screen they can act on; `Pattern_01` alone is a
    // file name.
    node.name = t.formId ?? name;
    node.title = t.title ?? null;
    screenNodes.set(id, node);
    stats.screens.byKind.nexacro += 1;
    built += 1;
  }
  return built;
}

/** How many templates were read, by engine, and how many of them anybody renders. */
export function countTemplates({ templatesByFile, includedBy, renderedTemplates, stats }) {
  for (const [file, t] of templatesByFile) {
    stats.templates.files += 1;
    stats.templates.byEngine[t.engine] = (stats.templates.byEngine[t.engine] ?? 0) + 1;
    stats.templates.includes += includedBy(file).length;
  }
  stats.templates.rendered = renderedTemplates.size;
}

/**
 * Which routes a handler serves, read off the graph the Java bridge built:
 * `endpoint --HANDLES--> symbol` is already there, and re-deriving it from the
 * facts would let the two disagree about the same method.
 */
function routesByHandler(g) {
  const routesOfHandler = new Map();
  for (const e of g.edges) {
    if (e.type !== 'HANDLES') continue;
    const ep = g.nodes.get(e.from);
    if (!ep || ep.kind !== 'endpoint' || typeof ep.path !== 'string') continue;
    if (!routesOfHandler.has(e.to)) routesOfHandler.set(e.to, new Set());
    routesOfHandler.get(e.to).add(ep.path);
  }
  return routesOfHandler;
}

/**
 * A REDIRECT IS NOT A PAGE, IT IS A ROUTE.
 *
 * `return "redirect:/catalog"` sends the browser to another route of this same
 * application, so it is a call onto that route and is graded by the route match
 * like any other call. `forward:` is the same journey without the round trip.
 */
function placeRedirect({ symbol, view, g, nodesToAdd, edges, stats, matchUrl }) {
  stats.templates.redirects += 1;
  if (!g.nodes.has(symbol)) return;
  const full = normalizeUrl(view.name.split('?')[0]);
  if (!namesARoute(full)) return;
  const found = matchUrl(full, 'GET');
  const evidence = {
    rule: 'view-redirect',
    basis: PAGE_RENDERS_BASIS.redirect,
    kind: view.kind,
    url: { written: view.name, template: full },
    method: { value: 'GET', from: 'redirect' },
    match: found.how,
    target: found.routes.length > 0 ? 'in-pack' : 'outside-pack',
  };
  if (found.routes.length === 0) {
    const epId = webEndpointId('GET', full);
    if (!g.nodes.has(epId) && !nodesToAdd.has(epId)) {
      nodesToAdd.set(epId, { id: epId, path: full, httpMethod: 'GET', outbound: true, source: 'web' });
      stats.outboundEndpoints += 1;
    }
    edges.push({ from: symbol, to: epId, type: 'CALLS_HTTP', grade: 'UNRESOLVED', evidence });
    return;
  }
  for (const r of found.routes.slice().sort((a, b) => cmp(a.id, b.id))) {
    edges.push({
      from: symbol, to: r.id, type: 'CALLS_HTTP', grade: 'SOUND_SET',
      evidence: found.routes.length > 1 ? { ...evidence, candidates: found.routes.length } : evidence,
    });
  }
}

/** The screen node one rendered view name produces, the first time that name is seen. */
function pageNodeOf(name, file, engine, { pathRule, codeRegex, codeLength }) {
  const segments = name.split('/').filter((x) => x !== '');
  const label = pathRule === 'last-segment' ? (segments[segments.length - 1] ?? name) : name;
  let code = null;
  if (codeRegex) {
    const m = codeRegex.exec(name);
    if (m) code = m[1] ?? m[0];
  }
  return {
    id: nodeId('screen', `view:${name}`),
    path: '',
    paths: [],
    name,
    title: null,
    label,
    code,
    group: code !== null && codeLength !== null
      ? code.slice(0, codeLength)
      : (segments.length > 1 ? segments[0] : SCREEN_ROOT_GROUP),
    component: null,
    template: file,
    engine,
    file,
    line: 1,
    pack: null,
    params: false,
    lane: 'web',
    source: 'view',
    declaredAt: [],
  };
}

/**
 * THE HANDLER RENDERS THE PAGE, exactly. The literal it returned is the
 * resolver's own input, and joining the prefix and the suffix onto it is what
 * the resolver does; nothing here was matched by name or by shape.
 */
function renderEdge(symbol, id, name, view, file, t) {
  return {
    from: symbol, to: id, type: 'RENDERS_PAGE', grade: 'EXACT',
    evidence: {
      rule: 'view-name', view: name, from: view.from,
      // WHICH method of the handler's own class the name was read out of, when
      // it was not the handler itself.
      ...(typeof view.helper === 'string' ? { helper: view.helper } : {}),
      template: file, engine: t.engine, suffix: t.suffix, root: t.root,
      basis: view.from === 'helper' ? PAGE_RENDERS_BASIS.helper
        : view.from === 'constant' ? PAGE_RENDERS_BASIS.constant
          : PAGE_RENDERS_BASIS.view,
    },
  };
}

/**
 * B7b': the pages a handler renders (RM48).
 *
 * The id says which kind of screen this is, so a hybrid application's two kinds
 * never collide:
 *   screen:<route path>        the router declared it
 *   screen:view:<view name>    a handler rendered it
 *
 * A view name that resolves to no template this run read is a GAP with a name
 * on it, not a screen: a template root nobody declared, a suffix that is not the
 * one configured, a name built at run time.
 *
 * @returns {object[]} the RENDERS_PAGE edges, held back so they land in the same
 *          block as the RENDERS edges the screen axis writes.
 */
export function buildPageScreens({
  g, viewRecords, templatesByFile, templateByName, screenNodes, nodesToAdd, edges,
  stats, matchUrl, axis,
}) {
  const pageEdges = [];
  const handlersOf = new Map(); // screen id -> the symbols that render it
  const routesOfHandler = routesByHandler(g);
  const unresolvedViews = new Map();
  for (const v of viewRecords) {
    stats.templates.views += 1;
    stats.templates.unresolvedViews += Number.isInteger(v.unresolved) ? v.unresolved : 0;
    const symbol = nodeId('symbol', `${v.owner}#${v.method}`);
    const paths = [...(routesOfHandler.get(symbol) ?? new Set())].sort();
    for (const view of v.views ?? []) {
      if (!view || typeof view.name !== 'string') continue;
      if (view.kind !== 'view') {
        placeRedirect({ symbol, view, g, nodesToAdd, edges, stats, matchUrl });
        continue;
      }
      stats.templates.viewNames += 1;
      // A LEADING SLASH IS THE ROOT THE PREFIX ALREADY IS. `return
      // "/pages/index"` and `return "pages/index"` are the same view to every
      // resolver, because the prefix ends in one.
      const name = view.name.replace(/^\/+/, '');
      const file = templateByName.get(name);
      if (file === undefined) {
        unresolvedViews.set(view.name, (unresolvedViews.get(view.name) ?? 0) + 1);
        continue;
      }
      const t = templatesByFile.get(file);
      const id = nodeId('screen', `view:${name}`);
      let node = screenNodes.get(id);
      if (node === undefined) {
        node = pageNodeOf(name, file, t.engine, axis);
        screenNodes.set(id, node);
        stats.screens.byKind.page += 1;
      }
      for (const p of paths) if (!node.paths.includes(p)) node.paths.push(p);
      node.paths.sort();
      node.path = node.paths[0] ?? '';
      node.params = node.paths.some((p) => /[{*]/.test(p));
      node.declaredAt.push({ file: v.file, line: v.line ?? null });
      if (!handlersOf.has(id)) handlersOf.set(id, new Set());
      handlersOf.get(id).add(symbol);
      if (g.nodes.has(symbol)) pageEdges.push(renderEdge(symbol, id, name, view, file, t));
    }
  }
  stats.templates.viewNamesUnplaced = [...unresolvedViews.values()].reduce((n, x) => n + x, 0);
  stats.templates.unresolvedViewNames = topCounts(unresolvedViews, 10, 'name');
  for (const [id, symbols] of handlersOf) {
    const node = screenNodes.get(id);
    if (node) node.renderedBy = [...symbols].sort();
  }
  return pageEdges;
}
