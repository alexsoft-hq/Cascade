// navigation.mjs — a screen change is not a request.
//
// WHAT THIS MODULE OWNS: recognising, in ONE file, that a call changes which
// screen the browser shows instead of sending anything to a server, and saying
// where it goes. `router.push('/auth/login')`, `<Link href="/auth/join">` and
// `location.href = '/'` are all the same act: the app swaps the component it is
// already showing, and nothing leaves the machine.
//
// WHY IT IS A DECLARATION AND NOT A RULE (SPEC §3.4, §18.2): every router in the
// ecosystem spells this differently and each spelling is fixed by the framework,
// so `adapters/web/packs/navigation.json` names the sinks and this module only
// reads the pack. A router added tomorrow is a row in that file.
//
// ONE FILE IS ALL IT SEES. Whether the path a navigation names is a screen this
// project declares is a question about the whole tree, so it is the bridge's:
// what is recorded here is the sink that was called and the path as written.
// `router.push(...)` on an IMPORTED name is the same kind of question — whether
// the module it comes from holds a router — so that one comes out as a
// CANDIDATE with the specifier on it and the bridge finishes it (RM60).
//
// THE ONE PLACE THE FILE KIND DECIDES (RM60): the browser's own global. A
// server-rendered page has no router, so `location.href = '/x.do'` written in a
// JSP is the browser fetching a route of this application, and it comes out as
// a call. In a source file the same sink stays a navigation.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the screens, the other files. It
// reads a template's URL rules from `templates.mjs` because a page writes its
// paths the way a page writes them, wherever in the page they are written.

import { calleeOf, propOf, summarizeArg } from './ast.mjs';
import { attributesOf, CTX_MARKER, templateUrlOf } from './templates.mjs';

/** The evidence rule every navigation record carries, worker and bridge alike. */
export const NAVIGATION_RULE = 'router-navigation';

/**
 * The evidence rule a SERVER PAGE's `location.href` carries (RM60).
 *
 * RM59 said the sink tells a navigation from a request and the file kind does
 * not. Measured, that is wrong for the browser's own global: a server-rendered
 * page has no router, so `location.href = "<c:url value='/x.do'/>"` in a JSP is
 * the browser fetching a route of this same application, which is exactly what
 * `<a href>` two lines below it is. In a source file the sink stays a
 * navigation, because there a router really is what answers.
 */
export const LOCATION_REQUEST_RULE = 'location-request';

/** One key made of the module and the name it exports, so a renamed import is still the same hook. */
const importKey = (source, imported) => `${source} ${imported}`;

const NAV_SPECS = new WeakMap();

/** An empty set of lookups, before any pack has been read into it. */
function emptySpec() {
  return {
    hooks: new Map(),
    functions: new Map(),
    receivers: new Map(),
    globals: [],
    elements: [],
    markupElements: [],
    // THE APP'S OWN ROUTER MODULE (RM60): the calls that BUILD one, and the
    // methods a name bound to one is navigated through.
    moduleFactories: new Map(),
    moduleMethods: new Set(),
    moduleShape: null,
  };
}

/** One `routers` entry, read into the lookups a walk asks. */
function readRouter(r, out) {
  const shape = {
    framework: r.framework,
    methods: new Set(r.methods ?? []),
    valueIsACall: r.hookValueIsACall === true,
    urlArg: Number.isInteger(r.urlArg) ? r.urlArg : 0,
    urlKeys: r.urlKeys ?? [],
    nameKeys: r.nameKeys ?? [],
  };
  for (const m of r.modules ?? []) {
    for (const h of r.hooks ?? []) out.hooks.set(importKey(m, h), shape);
    for (const f of r.functions ?? []) out.functions.set(importKey(m, f), shape);
    for (const f of r.module?.factories ?? []) out.moduleFactories.set(importKey(m, f), shape);
  }
  if (r.module) {
    out.moduleShape = shape;
    for (const m of shape.methods) out.moduleMethods.add(m);
  }
  for (const name of r.receivers ?? []) out.receivers.set(name, shape);
}

/**
 * One `elements` entry.
 *
 * AN ELEMENT NAMES ITS ROUTER TWO WAYS. A JSX element is a name the file
 * IMPORTED, and the import is what makes it a navigation rather than one of the
 * dozen other components called `Link`. A single-file component's
 * `<router-link>` imports nothing: the framework registers the tag globally, so
 * the tag itself is the whole declaration, and the entry says which by whether
 * it lists modules at all.
 */
function readElement(e, out) {
  const shape = { framework: e.framework, element: e.element, pathAttr: e.pathAttr, urlKeys: [] };
  if (Array.isArray(e.modules)) out.elements.push({ ...shape, modules: new Set(e.modules) });
  else out.markupElements.push(shape);
}

/**
 * The navigation pack, flattened into the lookups a walk needs.
 *
 * Memoized on the packs array itself: the packs are read once per process and
 * every file is walked against the same array, so this is built once.
 *
 * @param {object[]} packs  every declaration pack this worker loaded
 * @returns {object|null} null when no pack declares a navigation sink
 */
export function navigationSpec(packs) {
  if (!Array.isArray(packs)) return null;
  const cached = NAV_SPECS.get(packs);
  if (cached !== undefined) return cached;
  const out = emptySpec();
  for (const p of packs) {
    for (const r of p.routers ?? []) readRouter(r, out);
    for (const g of p.globals ?? []) {
      out.globals.push({
        framework: g.framework,
        receivers: new Set(g.receivers ?? []),
        methods: new Set(g.methods ?? []),
        properties: new Set(g.properties ?? []),
        urlArg: Number.isInteger(g.urlArg) ? g.urlArg : 0,
        urlKeys: [],
      });
    }
    for (const e of p.elements ?? []) readElement(e, out);
  }
  const total = out.hooks.size + out.functions.size + out.receivers.size
    + out.globals.length + out.elements.length + out.markupElements.length;
  const spec = total === 0 ? null : out;
  NAV_SPECS.set(packs, spec);
  return spec;
}

/**
 * The router a NAME holds, when a hook of one of these routers made it.
 *
 * `const router = useRouter()` is the shape, and it is read off the scope rather
 * than off a name: what makes `router` a router is that the file called a hook
 * the pack lists, so a project that calls it `nav` is read exactly the same.
 */
function hookRouterOf(ctx, spec, root, scope) {
  const found = scope === null || scope === undefined ? null : scope.find(root);
  const init = found === null ? null : (found.names.get(root) ?? null);
  if (init === null) return null;
  if (init.type !== 'CallExpression' && init.type !== 'OptionalCallExpression') return null;
  const callee = init.callee;
  if (!callee || callee.type !== 'Identifier') return null;
  const imp = ctx.top.imports.get(callee.name) ?? null;
  if (imp === null) return null;
  return spec.hooks.get(importKey(imp.source, imp.imported)) ?? null;
}

/**
 * WHICH NAVIGATION SINK this call reached, or null when it is not one.
 *
 * Four shapes, and each is anchored on something the framework fixes rather
 * than on a name a project chose:
 *   the address bar   `location.href = …`, `window.location.assign(…)`: a global
 *                     nothing in the file declares, under a method the pack names
 *   the framework's   `this.$router.push(…)`: the router the framework itself
 *   own property      puts on every component
 *   a hook's value    `const r = useRouter(); r.push(…)`, and the form where the
 *                     hook hands back the navigate function itself
 *   an import         `redirect('/x')`, imported straight from the router
 */
function navigationSinkOf(ctx, spec, { callee, binding, env }) {
  const method = callee.path.length > 0 ? callee.path[callee.path.length - 1] : null;
  if (method !== null && binding !== null && binding.kind === 'global') {
    const receiver = [callee.root, ...callee.path.slice(0, -1)].join('.');
    for (const g of spec.globals) {
      if (g.receivers.has(receiver) && g.methods.has(method)) {
        return { shape: g, sink: `${receiver}.${method}`, via: 'global' };
      }
    }
  }
  if (method !== null && callee.root === 'this' && callee.path.length === 2) {
    const r = spec.receivers.get(callee.path[0]) ?? null;
    if (r !== null && r.methods.has(method)) {
      return { shape: r, sink: `${callee.path[0]}.${method}`, via: 'receiver' };
    }
  }
  const hook = hookRouterOf(ctx, spec, callee.root, env.scope);
  if (hook !== null) {
    if (method === null && hook.valueIsACall) return { shape: hook, sink: `${callee.root}()`, via: 'hook' };
    if (method !== null && hook.methods.has(method)) {
      return { shape: hook, sink: `${callee.root}.${method}`, via: 'hook' };
    }
  }
  if (binding !== null && binding.kind === 'import') {
    if (method === null) {
      const f = spec.functions.get(importKey(binding.source, binding.imported)) ?? null;
      if (f !== null) return { shape: f, sink: `${callee.root}()`, via: 'import' };
    } else if (spec.moduleMethods.has(method) && callee.path.length === 1) {
      // THE APP'S OWN ROUTER MODULE (RM60). `import router from '@/router'`
      // followed by `router.push('/x')` is a navigation, and whether the module
      // really holds a router is a question about ANOTHER FILE. So this is a
      // candidate carrying the specifier, and the bridge finishes it.
      return {
        shape: { ...(spec.moduleShape ?? { urlArg: 0, urlKeys: [], nameKeys: [] }), framework: null },
        sink: `${callee.root}.${method}`,
        via: 'router-module',
        candidate: { source: binding.source, imported: binding.imported },
      };
    }
  }
  return null;
}

/**
 * WHERE a navigation goes, read off the argument the pack points at.
 *
 * A router takes the path as text (`push('/x')`) or as an object that spells it
 * out (`push({path: '/x', query})`), and both are the same navigation. Anything
 * else — a name handed in from outside the file, a call — is recorded with the
 * hole on it, exactly as an unresolved URL is.
 */
function navigationTargetOf(ctx, shape, argNodes, scope) {
  const at = argNodes[shape.urlArg] ?? null;
  if (at === null || at === undefined) return { to: null, targetKind: null };
  if (at.type !== 'ObjectExpression') return { to: ctx.buildUrl(summarizeArg(at), scope), targetKind: null };
  for (const key of shape.urlKeys) {
    const v = propOf(at, key);
    if (v !== null) return { to: ctx.buildUrl(summarizeArg(v), scope), targetKind: null };
  }
  // A NAMED ROUTE (`push({ name: 'user' })`) names a route declaration rather
  // than a path. It is a real navigation and this lane cannot say where it
  // lands, so it is counted as unmatched under its own name.
  for (const key of shape.nameKeys ?? []) {
    if (propOf(at, key) !== null) return { to: null, targetKind: 'named' };
  }
  return { to: null, targetKind: null };
}

/** The record one navigation prints: which sink, where it goes, and how it was found. */
function navigationRecord(ctx, hit, { to, targetKind, line, env }) {
  return {
    kind: hit.candidate === undefined ? 'navigation' : 'navigationCandidate',
    file: ctx.relFile,
    line,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : ctx.moduleEnclosing,
    framework: hit.shape.framework,
    sink: hit.sink,
    via: hit.via,
    rule: NAVIGATION_RULE,
    to,
    ...(targetKind ? { targetKind } : {}),
    ...(hit.candidate === undefined ? {} : { specifier: hit.candidate }),
  };
}

/**
 * A SERVER PAGE'S ADDRESS BAR IS A REQUEST (RM60): the same call record a link
 * in the same page produces, so it is matched, graded and counted as one.
 */
function locationRequestRecord(ctx, hit, { to, line, env }) {
  return {
    kind: 'call', file: ctx.relFile, line,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : ctx.moduleEnclosing,
    callee: { shape: 'template', root: LOCATION_REQUEST_RULE, path: [], name: LOCATION_REQUEST_RULE },
    binding: null,
    args: [],
    url: to,
    method: { value: 'GET', from: 'location-href' },
    platformSink: null,
    template: { rule: LOCATION_REQUEST_RULE, attr: hit.sink, written: writtenOf(to) },
  };
}

/** The address as the source spells it, for the evidence to quote. */
function writtenOf(to) {
  const arg = to === null ? null : (to.arg ?? null);
  if (arg === null) return null;
  if (arg.kind === 'string') return arg.value;
  if (arg.kind === 'template') return arg.template;
  return null;
}

/**
 * Whether this sink, in this file, is a request rather than a screen change.
 *
 * Only the browser's own global, and only in a template: a page has no router,
 * so nothing else could answer the address it loads.
 */
function isARequest(ctx, hit, to) {
  if (hit.via !== 'global' || typeof ctx.template !== 'string') return false;
  const resolved = to === null ? null : to.resolved;
  // A page writes its paths from the app root, and a JSP tag or an EL context
  // path arrives here as the marker for it; the page reader takes the marker
  // off afterwards. What is left has to be a route: a path, and not an asset.
  const aRoute = (t) => {
    const path = t.startsWith(CTX_MARKER) ? t.slice(CTX_MARKER.length) : t;
    return path.startsWith('/') && templateUrlOf(path) !== null;
  };
  return Array.isArray(resolved) && resolved.length > 0
    && resolved.every((r) => typeof r.template === 'string' && aRoute(r.template));
}

/**
 * ONE CALL, read for a screen change rather than a request.
 *
 * @returns {object|null} the record, or null when this call is neither
 */
export function navigationOf(ctx, { isNew, callee, binding, env, argNodes, line }) {
  const spec = ctx.navigation ?? null;
  if (spec === null || isNew || callee === null) return null;
  const hit = navigationSinkOf(ctx, spec, { callee, binding, env });
  if (hit === null) return null;
  const { to, targetKind } = navigationTargetOf(ctx, hit.shape, argNodes, env.scope);
  if (isARequest(ctx, hit, to)) return locationRequestRecord(ctx, hit, { to, line, env });
  return navigationRecord(ctx, hit, { to, targetKind, line, env });
}

/**
 * `location.href = '/'`, which is a navigation written as an assignment.
 *
 * @returns {object|null} the navigation record, or null when this is not one
 */
export function navigationAssignmentOf(ctx, node, env) {
  const spec = ctx.navigation ?? null;
  const left = node.left;
  if (spec === null || !left) return null;
  if (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression') return null;
  const c = calleeOf(left);
  if (c === null || c.path.length === 0) return null;
  const property = c.path[c.path.length - 1];
  const binding = ctx.bindingOf(c.root, env.scope, env.classInfo);
  if (binding === null || binding.kind !== 'global') return null;
  const receiver = [c.root, ...c.path.slice(0, -1)].join('.');
  for (const g of spec.globals) {
    if (!g.receivers.has(receiver) || !g.properties.has(property)) continue;
    const to = ctx.buildUrl(summarizeArg(node.right), env.scope);
    const hit = { shape: g, sink: `${receiver}.${property}`, via: 'global' };
    const line = ctx.lineOf(node);
    if (isARequest(ctx, hit, to)) return locationRequestRecord(ctx, hit, { to, line, env });
    return navigationRecord(ctx, hit, { to, targetKind: null, line, env });
  }
  return null;
}

/** One JSX attribute of an element, by name. */
function jsxAttr(element, name) {
  const open = element.openingElement;
  if (!open) return null;
  for (const a of open.attributes ?? []) {
    if (a.type !== 'JSXAttribute') continue;
    const an = a.name && a.name.type === 'JSXIdentifier' ? a.name.name : null;
    if (an === name) return a.value;
  }
  return null;
}

/**
 * `<Link href="/auth/join">`, which is a navigation written as markup.
 *
 * The ELEMENT NAME alone decides nothing: half the component libraries in the
 * ecosystem export something called `Link`, and one of them puts an address on
 * it. What makes this a navigation is that the file imported that name from the
 * router the pack declares.
 *
 * @returns {object|null} the navigation record, or null when this is not one
 */
export function navigationElementOf(ctx, node, env) {
  const spec = ctx.navigation ?? null;
  const open = node.openingElement;
  const tag = open && open.name && open.name.type === 'JSXIdentifier' ? open.name.name : null;
  if (spec === null || tag === null) return null;
  const imp = ctx.top.imports.get(tag) ?? null;
  if (imp === null) return null;
  for (const e of spec.elements) {
    if (e.element !== tag || !e.modules.has(imp.source)) continue;
    const attr = jsxAttr(node, e.pathAttr);
    if (attr === null) continue;
    const value = attr.type === 'JSXExpressionContainer' ? attr.expression : attr;
    const to = ctx.buildUrl(summarizeArg(value), env.scope);
    return navigationRecord(ctx, { shape: e, sink: `<${tag} ${e.pathAttr}>`, via: 'element' }, {
      to, targetKind: null, line: ctx.lineOf(node), env,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// The app's own router module, and the tag a single-file component navigates by
// ---------------------------------------------------------------------------

/** The router a factory call builds, or null when this call builds none. */
function routerFactoryOf(ctx, spec, node) {
  const callee = node.callee ?? null;
  if (!callee || callee.type !== 'Identifier') return null;
  const imp = ctx.top.imports.get(callee.name) ?? null;
  if (imp === null) return null;
  return spec.moduleFactories.get(importKey(imp.source, imp.imported)) ?? null;
}

/**
 * WHETHER THIS FILE IS THE APP'S ROUTER MODULE (RM60).
 *
 * `createRouter({ routes })` (or `new VueRouter({ routes })`) handed straight to
 * `export default`, or bound to a name that is. Nothing else counts: a file that
 * builds a router and keeps it to itself is not what
 * `import router from '@/router'` reaches.
 *
 * @returns {object|null} the `routerModule` record, or null
 */
export function routerModuleOf(ctx, program) {
  const spec = ctx.navigation ?? null;
  if (spec === null || spec.moduleFactories.size === 0) return null;
  const built = new Map(); // name -> shape
  let exported = null;
  for (const stmt of program.body ?? []) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (!d.init || (d.init.type !== 'CallExpression' && d.init.type !== 'NewExpression')) continue;
        if (!d.id || d.id.type !== 'Identifier') continue;
        const shape = routerFactoryOf(ctx, spec, d.init);
        if (shape !== null) built.set(d.id.name, shape);
      }
      continue;
    }
    if (stmt.type !== 'ExportDefaultDeclaration') continue;
    const d = stmt.declaration;
    if (!d) continue;
    if (d.type === 'CallExpression' || d.type === 'NewExpression') exported = routerFactoryOf(ctx, spec, d);
    else if (d.type === 'Identifier') exported = built.get(d.name) ?? null;
  }
  if (exported === null) return null;
  return {
    kind: 'routerModule', file: ctx.relFile, line: 1, framework: exported.framework,
  };
}

/** Whether a tag as written is the element the pack names, kebab or Pascal. */
const sameTag = (a, b) => String(a).toLowerCase().split('-').join('') === String(b).toLowerCase().split('-').join('');

/** One tag of a single-file component's markup, attributes and all. */
const MARKUP_TAG_RE = /<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;

/**
 * `<router-link to="/x">`, which is a navigation written in a component's
 * MARKUP (RM60).
 *
 * The tag scanner is the template reader's, and no template language is parsed:
 * one element name, one attribute, and the line it sits on. A bound `:to` is a
 * value the component computes, so it is a navigation this lane cannot follow
 * and is counted as one.
 *
 * @param {string} text  the `<template>` half of a `.vue` file, lines intact
 * @returns {object[]} navigation records
 */
export function routerLinkRecords(ctx, text) {
  const spec = ctx.navigation ?? null;
  const src = String(text ?? '');
  if (spec === null || spec.markupElements.length === 0 || src === '') return [];
  const out = [];
  const re = new RegExp(MARKUP_TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const e = spec.markupElements.find((x) => sameTag(m[1], x.element));
    if (e === undefined) continue;
    const attrs = attributesOf(m[2]);
    const line = (src.slice(0, m.index).match(/\n/g) ?? []).length + 1;
    const bound = attrs.has(`:${e.pathAttr}`) || attrs.has(`v-bind:${e.pathAttr}`);
    const written = attrs.get(e.pathAttr);
    if (!bound && written === undefined) continue;
    const path = bound ? null : templateUrlOf(written);
    out.push({
      kind: 'navigation', file: ctx.relFile, line,
      enclosing: '(template)',
      framework: e.framework,
      sink: `<${m[1]} ${bound ? `:${e.pathAttr}` : e.pathAttr}>`,
      via: 'router-link',
      rule: NAVIGATION_RULE,
      to: path === null ? null
        : { arg: { kind: 'string', value: path }, resolved: [{ template: path, dynamicParts: 0, via: 'literal' }] },
      ...(bound ? { targetKind: 'bound' } : {}),
    });
  }
  return out;
}
