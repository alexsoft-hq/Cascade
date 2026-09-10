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
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the screens, the other files.

import { calleeOf, propOf, summarizeArg } from './ast.mjs';

/** The evidence rule every navigation record carries, worker and bridge alike. */
export const NAVIGATION_RULE = 'router-navigation';

/** One key made of the module and the name it exports, so a renamed import is still the same hook. */
const importKey = (source, imported) => `${source} ${imported}`;

const NAV_SPECS = new WeakMap();

/**
 * The navigation pack, flattened into the four lookups a walk needs.
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
  const hooks = new Map();
  const functions = new Map();
  const receivers = new Map();
  const globals = [];
  const elements = [];
  for (const p of packs) {
    for (const r of p.routers ?? []) {
      const shape = {
        framework: r.framework,
        methods: new Set(r.methods ?? []),
        valueIsACall: r.hookValueIsACall === true,
        urlArg: Number.isInteger(r.urlArg) ? r.urlArg : 0,
        urlKeys: r.urlKeys ?? [],
      };
      for (const m of r.modules ?? []) {
        for (const h of r.hooks ?? []) hooks.set(importKey(m, h), shape);
        for (const f of r.functions ?? []) functions.set(importKey(m, f), shape);
      }
      for (const name of r.receivers ?? []) receivers.set(name, shape);
    }
    for (const g of p.globals ?? []) {
      globals.push({
        framework: g.framework,
        receivers: new Set(g.receivers ?? []),
        methods: new Set(g.methods ?? []),
        properties: new Set(g.properties ?? []),
        urlArg: Number.isInteger(g.urlArg) ? g.urlArg : 0,
        urlKeys: [],
      });
    }
    // A sink written in MARKUP is declared and not read: this worker parses a
    // single-file component's `<script>` blocks, not its `<template>`.
    for (const e of p.elements ?? []) {
      if (e.markup === true || !Array.isArray(e.modules)) continue;
      elements.push({
        framework: e.framework,
        element: e.element,
        modules: new Set(e.modules),
        pathAttr: e.pathAttr,
        urlKeys: [],
      });
    }
  }
  const spec = hooks.size + functions.size + receivers.size + globals.length + elements.length === 0
    ? null : { hooks, functions, receivers, globals, elements };
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
      if (g.receivers.has(receiver) && g.methods.has(method)) return { shape: g, sink: `${receiver}.${method}` };
    }
  }
  if (method !== null && callee.root === 'this' && callee.path.length === 2) {
    const r = spec.receivers.get(callee.path[0]) ?? null;
    if (r !== null && r.methods.has(method)) return { shape: r, sink: `${callee.path[0]}.${method}` };
  }
  const hook = hookRouterOf(ctx, spec, callee.root, env.scope);
  if (hook !== null) {
    if (method === null && hook.valueIsACall) return { shape: hook, sink: `${callee.root}()` };
    if (method !== null && hook.methods.has(method)) return { shape: hook, sink: `${callee.root}.${method}` };
  }
  if (method === null && binding !== null && binding.kind === 'import') {
    const f = spec.functions.get(importKey(binding.source, binding.imported)) ?? null;
    if (f !== null) return { shape: f, sink: `${callee.root}()` };
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
  if (at === null || at === undefined) return null;
  if (at.type !== 'ObjectExpression') return ctx.buildUrl(summarizeArg(at), scope);
  for (const key of shape.urlKeys) {
    const v = propOf(at, key);
    if (v !== null) return ctx.buildUrl(summarizeArg(v), scope);
  }
  return null;
}

/** The record one navigation prints: which sink, and where it goes. */
function navigationRecord(ctx, { shape, sink }, { to, line, env }) {
  return {
    kind: 'navigation',
    file: ctx.relFile,
    line,
    enclosing: env.func ? (env.func.finalName ?? env.func.baseName) : ctx.moduleEnclosing,
    framework: shape.framework,
    sink,
    rule: NAVIGATION_RULE,
    to,
  };
}

/**
 * ONE CALL, read for a screen change rather than a request.
 *
 * @returns {object|null} the navigation record, or null when this is not one
 */
export function navigationOf(ctx, { isNew, callee, binding, env, argNodes, line }) {
  const spec = ctx.navigation ?? null;
  if (spec === null || isNew || callee === null) return null;
  const hit = navigationSinkOf(ctx, spec, { callee, binding, env });
  if (hit === null) return null;
  const to = navigationTargetOf(ctx, hit.shape, argNodes, env.scope);
  return navigationRecord(ctx, hit, { to, line, env });
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
    return navigationRecord(ctx, { shape: g, sink: `${receiver}.${property}` }, {
      to, line: ctx.lineOf(node), env,
    });
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
    return navigationRecord(ctx, { shape: e, sink: `<${tag} ${e.pathAttr}>` }, {
      to, line: ctx.lineOf(node), env,
    });
  }
  return null;
}
