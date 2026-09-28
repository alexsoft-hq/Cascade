// routers.mjs — what a router DECLARES, and what a framework REGISTERS.
//
// WHAT THIS MODULE OWNS. A frontend's routes are written in half a dozen
// shapes, and every one of them is a DECLARATION rather than a request:
//   the route object   `{path: '/owners', component: …, children: [...]}`,
//                      recognised by whichever declaration pack's keys it
//                      carries, with the file's own registrar calls breaking a
//                      tie between two packs that would both read it
//   the JSX element    `<Route path="/owners" element={…}>`, and the routes
//                      nested inside it
//   the chain form     `$stateProvider.state('a', {…}).state('b', {…})`, one
//                      call per route written on the result of the one before
//   the registration   `angular.module('x').component('ownerList', {…})`: a
//                      frontend written before modules saying what a name means
//   the injection      the two shapes a framework hands a client through, so a
//                      parameter named `$http` is a client HERE and nowhere else
//
// NOTHING HERE IS HARD-CODED TO A FRAMEWORK (SPEC §3.4, §18.2). Every key, every
// method name and every root identifier comes from a declaration pack under
// `adapters/web/packs/`, which a reader extends without touching this file.
//
// NOTHING IS RESOLVED HERE EITHER. A record says which name was registered, in
// which file, and which other names it points at; putting those together is the
// bridge's job, because the two names are in two files.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the routes a pack serves, the other
// files in the tree. Every function takes the walk's CONTEXT as its first
// argument — the packs, the line rules, the record sink and the walk itself —
// so a reader can see at the signature what a rule is allowed to look at.

import { calleeOf, eachChild, isFunctionNode, propOf } from './ast.mjs';
import { HOP_GUARD } from './calls.mjs';
import { navigationElementOf } from './navigation.mjs';
import { customElementTags, soleElementTag } from './templates.mjs';

/**
 * Whether a path value is a NAME rather than text: `appPaths.orders.path`, or
 * `ordersPath`. Only a plain chain of names counts; `a[b]` is a value, not a
 * spelling.
 */
function isPathRefNode(n) {
  if (!n) return false;
  if (n.type === 'Identifier') return true;
  if (n.type !== 'MemberExpression' || n.computed) return false;
  return n.property && n.property.type === 'Identifier' && isPathRefNode(n.object);
}

/** Whether one pack would read this object literal as a route declaration. */
export function packSeesARoute(p, node) {
  const ro = p.routeObject || {};
  if (!ro.pathKey) return false;
  const pathValue = propOf(node, ro.pathKey);
  if (pathValue === null) return false;
  // A pack that reads a path THROUGH a constant (RM67) takes a name where the
  // others take only text.
  if (pathValue.type !== 'StringLiteral' && !(p.pathRefs === true && isPathRefNode(pathValue))) return false;
  const hasComponent = (ro.componentKeys || []).some((k) => propOf(node, k) !== null);
  const hasChildren = ro.childrenKey ? propOf(node, ro.childrenKey) !== null : false;
  const hasLazyChildren = ro.lazyChildrenKey ? propOf(node, ro.lazyChildrenKey) !== null : false;
  const hasRedirect = ro.redirectKey ? propOf(node, ro.redirectKey) !== null : false;
  const indexValue = ro.indexKey ? propOf(node, ro.indexKey) : null;
  const hasIndex = indexValue !== null && indexValue.type === 'BooleanLiteral' && indexValue.value === true;
  return hasComponent || hasChildren || hasLazyChildren || hasRedirect || hasIndex;
}

/** Whether ANY pack would. */
export function anyPackSeesARoute(packs, node) {
  return node !== null && node !== undefined
    && node.type === 'ObjectExpression' && packs.some((p) => packSeesARoute(p, node));
}

/**
 * THE PACKS A FILE CAN HOLD ROUTES OF (RM67): every object pack, and a module
 * pack only when the file imports its module. `{path: 'x', component: X}` is
 * spelled the same by three routers, and the import is what says whose it is;
 * a file that imports none of a module pack's modules is read exactly as it was
 * before that pack existed.
 */
export function routePacksOf(packs, importedModules) {
  return packs.filter((p) => p.__routesFrom === 'object'
    || (p.__routesFrom === 'module' && p.modules.some((m) => importedModules.has(m))));
}

/** The member a `.then(m => m.X)` callback hands back, or null. */
function thenMemberOf(cb) {
  if (!cb || !isFunctionNode(cb) || !cb.params || cb.params.length !== 1 || cb.params[0].type !== 'Identifier') return null;
  let body = cb.body;
  if (body && body.type === 'BlockStatement') {
    const ret = body.body.find((s) => s.type === 'ReturnStatement');
    body = ret ? ret.argument : null;
  }
  if (!body || body.type !== 'MemberExpression' || body.computed || !body.property || body.property.type !== 'Identifier') return null;
  return body.object && body.object.type === 'Identifier' && body.object.name === cb.params[0].name ? body.property.name : null;
}

/**
 * A DYNAMIC IMPORT, and which export of it is meant: `import('./x')` is the
 * module's default, `import('./x').then(m => m.X)` its `X`. Null for anything
 * else.
 */
function dynamicImportOf(node) {
  let n = node;
  if (n && n.type === 'ArrowFunctionExpression' && n.body) n = n.body;
  if (!n || (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') || !n.callee) return null;
  if (n.callee.type === 'Import') {
    const a = n.arguments[0];
    return a && a.type === 'StringLiteral' ? { source: a.value, exported: null } : null;
  }
  const c = n.callee;
  if (c.type !== 'MemberExpression' || c.computed || !c.property || c.property.name !== 'then') return null;
  const inner = dynamicImportOf(c.object);
  if (inner === null || inner.exported !== null) return null;
  const member = thenMemberOf(n.arguments[0]);
  return member === null ? null : { source: inner.source, exported: member };
}

/** Where a route's component comes from: a dynamic import, or an imported name. */
export function componentSourceOf(ctx, node) {
  const { top } = ctx;
  let n = node;
  const lazy = dynamicImportOf(n);
  if (lazy !== null) {
    return lazy.exported === null ? { source: lazy.source, local: null } : { source: lazy.source, local: null, exported: lazy.exported };
  }
  if (n.type === 'ArrowFunctionExpression' && n.body) n = n.body;
  if (n.type === 'ObjectExpression') {
    // `components: { default: X }`: take the first member that resolves.
    for (const p of n.properties) {
      if (p.type !== 'ObjectProperty') continue;
      const r = componentSourceOf(ctx, p.value);
      if (r.source || r.local) return r;
    }
    return { source: null, local: null };
  }
  if (n.type === 'JSXElement' && n.openingElement && n.openingElement.name) {
    const nm = n.openingElement.name;
    const local = nm.type === 'JSXIdentifier' ? nm.name : null;
    if (local && top.imports.has(local)) return { source: top.imports.get(local).source, local };
    return { source: null, local };
  }
  if (n.type === 'Identifier') {
    if (top.imports.has(n.name)) return { source: top.imports.get(n.name).source, local: n.name };
    return { source: null, local: n.name };
  }
  if (n.type === 'StringLiteral') return { source: n.value, local: null };
  return { source: null, local: null };
}

/**
 * WHICH PACK READS THIS OBJECT, or null. The pack is chosen by the keys the
 * object itself carries: each pack's DISTINCTIVE keys (the ones no other pack
 * names) decide, and the file's own registrar calls break a tie. A MODULE pack
 * the file imports outranks both (RM67), because the import is the file saying
 * which router it declares for; in a file that imports none, no module pack is
 * a candidate at all, so the choice there is the one it always was.
 */
function claimingPack(ctx, node, env) {
  const { st, routePacks } = ctx;
  const matches = [];
  for (const p of routePacks) {
    // A module-level object is a route only for a pack that says so.
    if (env.routeTopLevel === true && p.topLevelObjects !== true) continue;
    if (!packSeesARoute(p, node)) continue;
    let score = 0;
    for (const k of p.__distinctive) if (propOf(node, k) !== null) score += 1;
    if (st.registrarPacks && st.registrarPacks.has(p.pack)) score += 0.5;
    matches.push({ pack: p, score, gated: p.__routesFrom === 'module' ? 1 : 0 });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.gated - a.gated || b.score - a.score || (a.pack.pack < b.pack.pack ? -1 : 1));
  return matches[0].pack;
}

/**
 * THE PATH A ROUTE DECLARES, onto the record. Text is the path. A NAME is read
 * through a constant (RM67): one this file declares is put in here, with where
 * it came from; one another module exports is left for the bridge, with the
 * specifier on it; one that leads nowhere says so.
 */
function readRoutePath(ctx, pathValue, rec) {
  if (pathValue.type === 'StringLiteral') { rec.path = pathValue.value; return; }
  const ref = pathRefOf(ctx, pathValue);
  if (typeof ref.value === 'string') {
    rec.path = ref.value;
    rec.pathFrom = { name: ref.name, from: 'same-file' };
    return;
  }
  rec.path = null;
  rec.pathRef = { name: ref.name, ...(ref.source ? { source: ref.source, imported: ref.imported } : { unresolved: ref.kind }) };
}

/** The component a route mounts, onto the record: the first component key it carries. */
function readRouteComponent(ctx, ro, node, rec) {
  for (const k of ro.componentKeys || []) {
    const c = propOf(node, k);
    if (!c) continue;
    const src = componentSourceOf(ctx, c);
    if (src.source) rec.componentSource = src.source;
    if (src.local) rec.componentLocal = src.local;
    if (src.exported) rec.componentExport = src.exported;
    return;
  }
}

/** A route's title: under its meta object for a pack that has one, on the route itself otherwise. */
function readRouteTitle(ro, node, rec) {
  const meta = ro.metaKey ? propOf(node, ro.metaKey) : null;
  if (meta && meta.type === 'ObjectExpression' && ro.titleKey) {
    const title = propOf(meta, ro.titleKey);
    if (title && title.type === 'StringLiteral') rec.metaTitle = title.value;
    return;
  }
  const own = !ro.metaKey && ro.titleKey ? propOf(node, ro.titleKey) : null;
  if (own && own.type === 'StringLiteral') rec.metaTitle = own.value;
}

/**
 * A route's children: the ones written inline, the lists it names by name, and
 * the list it loads lazily from another module (RM67). The count is of the
 * inline ones, as it always was; the named and the lazy ones are records of
 * their own and a field on the route, because only the bridge can find them.
 */
function readRouteChildren(ctx, pack, node, env, line, rec) {
  const { routeHandled } = ctx;
  const ro = pack.routeObject || {};
  const children = ro.childrenKey ? propOf(node, ro.childrenKey) : null;
  let childCount = 0;
  let named = 0;
  const inner = { ...env, routeList: null, routeTopLevel: false };
  if (children && children.type === 'ArrayExpression') {
    for (const el of children.elements) {
      if (el && el.type === 'ObjectExpression') {
        const before = routeHandled.size;
        maybeRoute(ctx, el, inner, line);
        if (routeHandled.size > before) childCount += 1;
      } else if (pack.listRefs === true && emitRouteRef(ctx, el, { list: null, parent: line })) named += 1;
    }
  } else if (children && pack.listRefs === true && emitRouteRef(ctx, children, { list: null, parent: line })) named += 1;
  const lazy = ro.lazyChildrenKey ? dynamicImportOf(propOf(node, ro.lazyChildrenKey)) : null;
  if (lazy !== null) rec.childrenFrom = { source: lazy.source, export: lazy.exported ?? 'default' };
  return { childCount, named, lazy: lazy !== null };
}

/**
 * Emit a route record for `node` when one of the packs recognizes it (see
 * `claimingPack`). Nothing here is hard-coded to a framework.
 */
export function maybeRoute(ctx, node, env, parentLine) {
  const { lineOf, relFile, emit, routeHandled } = ctx;
  if (routeHandled.has(node)) return;
  const pack = claimingPack(ctx, node, env);
  if (pack === null) return;
  const ro = pack.routeObject || {};
  const line = lineOf(node);
  routeHandled.add(node);

  const rec = { kind: 'route', file: relFile, line, pack: pack.pack };
  readRoutePath(ctx, propOf(node, ro.pathKey), rec);
  const nameValue = ro.nameKey ? propOf(node, ro.nameKey) : null;
  if (nameValue && nameValue.type === 'StringLiteral') rec.name = nameValue.value;
  readRouteComponent(ctx, ro, node, rec);
  const redirect = ro.redirectKey ? propOf(node, ro.redirectKey) : null;
  if (redirect && redirect.type === 'StringLiteral') rec.redirect = redirect.value;
  readRouteTitle(ro, node, rec);
  const hidden = ro.hiddenKey ? propOf(node, ro.hiddenKey) : null;
  if (hidden && hidden.type === 'BooleanLiteral') rec.hidden = hidden.value;
  const outlet = ro.outletKey ? propOf(node, ro.outletKey) : null;
  if (outlet && outlet.type === 'StringLiteral') rec.outlet = outlet.value;
  rec.parent = parentLine;
  // THE LIST THIS ROUTE IS IN, by the name the module binds it to, so that a
  // route in another file that names the list can find it (RM67).
  if (parentLine === null && pack.listRefs === true && typeof env.routeList === 'string') rec.list = env.routeList;

  const kids = readRouteChildren(ctx, pack, node, env, line, rec);
  rec.children = kids.childCount;
  // A ROUTE THAT MOUNTS NOTHING, for a pack that says such a route is not a
  // screen: it is the path its children hang off, and that is all it is.
  const mounts = typeof rec.componentSource === 'string' || typeof rec.componentLocal === 'string';
  if (pack.groupsMountNothing === true && !mounts && (kids.childCount > 0 || kids.named > 0 || kids.lazy)) rec.grouping = true;
  emit(rec, line);
}

/**
 * ONE ROUTE NAMED BY NAME in a list, or a list named where a route's children
 * go (RM67): `[ordersRoute, ...errorRoutes]`, `children: ORDER_ROUTES`. What the
 * name holds is another module's business as often as this one's, so the name
 * is recorded as written and the bridge resolves it.
 *
 * @returns {boolean} whether a record was emitted
 */
export function emitRouteRef(ctx, el, { list, parent, registrar = null }) {
  const { lineOf, relFile, emit } = ctx;
  if (!el) return false;
  const spread = el.type === 'SpreadElement';
  const id = spread ? el.argument : el;
  if (!id || id.type !== 'Identifier') return false;
  const line = lineOf(el);
  const rec = { kind: 'routeRef', file: relFile, line, name: id.name, list, parent };
  if (spread) rec.spread = true;
  if (registrar !== null) rec.registrar = registrar;
  emit(rec, line);
  return true;
}

/**
 * THE MODULE-LEVEL NAMES THIS FILE DESTRUCTURES out of something else, local
 * name to where it came from: `const { create, detail } = appPaths.orders`
 * makes `create` mean `appPaths.orders.create`. Read once per file, because a
 * route path written on such a name is as common as one written in full.
 *
 * @returns {Map<string,{init:object, key:string}>}
 */
export function moduleDestructures(program) {
  const out = new Map();
  for (const stmt of program.body ?? []) {
    const d = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (!d || d.type !== 'VariableDeclaration' || d.kind !== 'const') continue;
    for (const decl of d.declarations) {
      if (!decl.id || decl.id.type !== 'ObjectPattern' || !isPathRefNode(decl.init)) continue;
      for (const p of decl.id.properties) {
        if (p.type !== 'ObjectProperty' || p.computed || !p.key || p.key.type !== 'Identifier') continue;
        if (p.value && p.value.type === 'Identifier') out.set(p.value.name, { init: decl.init, key: p.key.name });
      }
    }
  }
  return out;
}

/** A name chain as the parts it is spelled with, through one destructuring. */
function spelledPath(ctx, node) {
  const c = calleeOf(node);
  if (!c || c.root === null) return null;
  const via = (ctx.destructures ?? new Map()).get(c.root);
  if (!via) return [c.root, ...c.path];
  const base = calleeOf(via.init);
  return base && base.root !== null ? [base.root, ...base.path, via.key, ...c.path] : null;
}

/**
 * What a route path written as a NAME holds (RM67): the text a constant of this
 * file keeps under that path, or the import it comes from, or why neither.
 *
 * @returns {{name:string, value?:string, source?:string, imported?:string, kind?:string}}
 */
function pathRefOf(ctx, node) {
  const { top } = ctx;
  const parts = spelledPath(ctx, node);
  if (parts === null) return { name: '(unreadable)', kind: 'expression' };
  const [root, ...rest] = parts;
  const name = parts.join('.');
  if (top.imports.has(root)) {
    const imp = top.imports.get(root);
    return { name, source: imp.source, imported: imp.imported };
  }
  const c = top.constants.get(root);
  if (c) {
    const value = rest.length === 0 ? c.value
      : rest.length === 1 ? (c.members ? c.members.get(rest[0]) : undefined)
        : (c.nested ? c.nested.get(rest.join('.')) : undefined);
    if (typeof value === 'string') return { name, value };
  }
  return { name, kind: 'expression' };
}

/** One JSX attribute of an element, by name. */
function jsxAttr(element, name) {
  const open = element.openingElement;
  if (!open) return null;
  for (const a of open.attributes) {
    if (a.type !== 'JSXAttribute') continue;
    const an = a.name && a.name.type === 'JSXIdentifier' ? a.name.name : null;
    if (an === name) return a.value;
  }
  return null;
}

/** A `<Route path=… element=…>` element, and the routes written inside it. */
export function visitJsx(ctx, node, env, parentLine) {
  const { packs, lineOf, relFile, emit } = ctx;
  // `<Link href="/auth/join">` is a navigation written as markup (RM59). It is
  // recorded beside whatever else this element is, because an element can be
  // both a link and a route declaration in a framework that nests them.
  const navigation = navigationElementOf(ctx, node, env);
  if (navigation !== null) emit(navigation, navigation.line);
  const open = node.openingElement;
  const tag = open && open.name && open.name.type === 'JSXIdentifier' ? open.name.name : null;
  let emitted = null;
  for (const p of packs) {
    const jsx = p.jsx;
    if (!jsx || jsx.element !== tag) continue;
    const pathAttr = jsxAttr(node, jsx.pathAttr);
    let pathText = null;
    if (pathAttr && pathAttr.type === 'StringLiteral') pathText = pathAttr.value;
    else if (pathAttr && pathAttr.type === 'JSXExpressionContainer' && pathAttr.expression.type === 'StringLiteral') {
      pathText = pathAttr.expression.value;
    }
    if (pathText === null) continue;
    const line = lineOf(node);
    const rec = { kind: 'route', file: relFile, line, pack: p.pack, path: pathText };
    for (const attr of jsx.componentAttrs || []) {
      const v = jsxAttr(node, attr);
      if (!v) continue;
      const inner = v.type === 'JSXExpressionContainer' ? v.expression : v;
      const src = componentSourceOf(ctx, inner);
      if (src.source) rec.componentSource = src.source;
      if (src.local) rec.componentLocal = src.local;
      break;
    }
    rec.parent = parentLine;
    let childCount = 0;
    for (const child of node.children || []) {
      if (child.type === 'JSXElement') {
        const t = child.openingElement && child.openingElement.name && child.openingElement.name.type === 'JSXIdentifier'
          ? child.openingElement.name.name : null;
        if (t === jsx.element) { visitJsx(ctx, child, env, line); childCount += 1; continue; }
      }
      ctx.visit(child, env);
    }
    rec.children = childCount;
    emit(rec, line);
    emitted = rec;
    break;
  }
  if (emitted !== null) {
    for (const a of (open.attributes || [])) if (a.type === 'JSXAttribute' && a.value) ctx.visit(a.value, env);
    return;
  }
  eachChild(node, (child) => ctx.visit(child, env));
}

/**
 * The registrars this file NAMES, for the pack tie-break. A file that calls
 * `createRouter` is a file whose route objects that pack should read.
 */
export function registrarScan(ctx, n) {
  const { packs, st } = ctx;
  if (!n) return;
  if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && n.callee) {
    const c = calleeOf(n.callee);
    if (c) {
      for (const p of packs) {
        if ((p.registrars || []).includes(c.name)) st.registrarPacks.add(p.pack);
      }
    }
  }
  if (n.type === 'JSXElement' && n.openingElement && n.openingElement.name && n.openingElement.name.type === 'JSXIdentifier') {
    for (const p of packs) if (p.jsx && p.jsx.element === n.openingElement.name.name) st.registrarPacks.add(p.pack);
  }
  eachChild(n, (child) => registrarScan(ctx, child));
}

/**
 * THE LIST A CHILD REGISTRAR TAKES (RM67): `RouterModule.forChild(routes)`
 * registers `routes` as the children of whichever route loads this module. It
 * is marked, so that when the bridge cannot find that route it says the paths
 * are unknown instead of reading them as top-level paths they are not. A list
 * written inline gets a name of its own, so the mark has something to name.
 */
function childRegistrarList(ctx, p, c, n, env) {
  const { lineOf, relFile, emit } = ctx;
  if (!(p.childRegistrars ?? []).includes(c.name) || !ctx.routePacks.includes(p)) return;
  const first = n.arguments && n.arguments[0];
  if (!first) return;
  if (first.type === 'Identifier') {
    emitRouteRef(ctx, first, { list: null, parent: null, registrar: c.name });
    return;
  }
  if (first.type !== 'ArrayExpression') return;
  const line = lineOf(n);
  const list = `(${c.name}:${line})`;
  emit({ kind: 'routeRef', file: relFile, line, name: list, list: null, parent: null, registrar: c.name }, line);
  for (const el of first.elements) {
    if (el && el.type === 'ObjectExpression') maybeRoute(ctx, el, { ...env, routeList: list }, null);
    else emitRouteRef(ctx, el, { list, parent: null });
  }
}

/** A registrar call's own routes array: `createRouter({routes: [...]})`. */
export function registrarRoutes(ctx, n, env) {
  const { packs } = ctx;
  if (!n) return;
  if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && n.callee) {
    const c = calleeOf(n.callee);
    if (c) {
      for (const p of packs) {
        if (!(p.registrars || []).includes(c.name)) continue;
        childRegistrarList(ctx, p, c, n, env);
        const first = n.arguments && n.arguments[0];
        const list = first && first.type === 'ObjectExpression' && p.routesKey ? propOf(first, p.routesKey) : null;
        if (list && list.type === 'ArrayExpression') {
          for (const el of list.elements) if (el && el.type === 'ObjectExpression') maybeRoute(ctx, el, env, null);
        }
      }
    }
  }
  eachChild(n, (child) => registrarRoutes(ctx, child, env));
}

/**
 * The receiver a CHAIN registrar is written on.
 *
 * `$stateProvider.state('owners', {…}).state('vets', {…})` is one call per
 * route, each written on the result of the one before it. `calleeOf` gives up
 * on that shape by design (its root is a call, not a name), so the chain is
 * walked here: down the member/call spine to the identifier at the bottom,
 * which is the receiver the pack names.
 */
function chainReceiverOf(node, spec) {
  if (!node.callee || (node.callee.type !== 'MemberExpression' && node.callee.type !== 'OptionalMemberExpression')) return null;
  const prop = node.callee.property;
  const method = !node.callee.computed && prop && prop.type === 'Identifier' ? prop.name
    : (prop && prop.type === 'StringLiteral' ? prop.value : null);
  if (method !== spec.method) return null;
  let cur = node.callee.object;
  for (let i = 0; i < HOP_GUARD && cur; i += 1) {
    if (cur.type === 'Identifier') return spec.receivers.includes(cur.name) ? cur.name : null;
    if ((cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') && cur.callee) { cur = cur.callee; continue; }
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') { cur = cur.object; continue; }
    return null;
  }
  return null;
}

/** The parent state a route names: its own `parent` key, or a dotted name. */
function parentNameOf(routeNode, ro, stateName) {
  const p = ro.parentKey ? propOf(routeNode, ro.parentKey) : null;
  if (p && p.type === 'StringLiteral' && p.value !== '') return p.value;
  if (typeof stateName === 'string') {
    const dot = stateName.lastIndexOf('.');
    if (dot > 0) return stateName.slice(0, dot);
  }
  return null;
}

/** Every route a chain registrar declares, one record per link. */
export function chainRoutes(ctx, n) {
  const { packs, lineOf, relFile, emit, declarationCalls, routeObjects, attachTemplate } = ctx;
  if (!n) return;
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    for (const p of packs) {
      for (const spec of p.__chains ?? []) {
        const receiver = chainReceiverOf(n, spec);
        if (receiver === null) continue;
        declarationCalls.add(n);
        const args = n.arguments ?? [];
        const routeNode = args[spec.routeArg];
        if (routeNode && routeNode.type === 'ObjectExpression') routeObjects.add(routeNode);
        const ro = p.routeObject || {};
        // THE LINE OF THIS LINK, not of the chain. Every `.state(…)` written
        // on the result of the one before it starts where the whole
        // expression starts, so the call node's own position would give the
        // ten routes of one chain the same line.
        const line = lineOf(n.callee.property ?? n);
        const rec = { kind: 'route', file: relFile, line, pack: p.pack, via: 'chain', receiver };
        const nameNode = Number.isInteger(spec.nameArg) ? args[spec.nameArg] : null;
        if (nameNode && nameNode.type === 'StringLiteral') rec.name = nameNode.value;
        // The path is the route object's own key on a `state`, and the first
        // argument on a `when`. Missing is '' — a state with no url of its own
        // is the parent's path, which is what composing it says.
        let pathText = null;
        if (Number.isInteger(spec.pathArg)) {
          const pathNode = args[spec.pathArg];
          if (pathNode && pathNode.type === 'StringLiteral') pathText = pathNode.value;
        }
        if (pathText === null && routeNode && ro.pathKey) {
          const urlNode = propOf(routeNode, ro.pathKey);
          if (urlNode && urlNode.type === 'StringLiteral') pathText = urlNode.value;
        }
        rec.path = pathText ?? '';
        const parentName = routeNode ? parentNameOf(routeNode, ro, rec.name) : null;
        if (parentName !== null) rec.parentName = parentName;
        const abstractNode = routeNode && ro.abstractKey ? propOf(routeNode, ro.abstractKey) : null;
        if (abstractNode && abstractNode.type === 'BooleanLiteral' && abstractNode.value === true) rec.abstract = true;
        if (routeNode) {
          for (const k of ro.componentKeys ?? []) {
            const v = propOf(routeNode, k);
            if (!v || v.type !== 'StringLiteral') continue;
            if (k === 'component') { rec.componentName = v.value; break; }
            if (k === 'template') {
              const tag = soleElementTag(v.value);
              if (tag !== null) { rec.componentTag = tag; break; }
              continue;
            }
            if (k === 'templateUrl') { attachTemplate(rec, v.value); break; }
          }
          const ctrl = ro.controllerKey ? propOf(routeNode, ro.controllerKey) : null;
          if (ctrl && ctrl.type === 'StringLiteral') rec.controllerName = ctrl.value;
        }
        rec.parent = null;
        rec.children = 0;
        emit(rec, line);
      }
    }
  }
  eachChild(n, (child) => chainRoutes(ctx, child));
}

/** The names this file binds a framework MODULE to, so `x.component(…)` is one too. */
export function collectModuleLocals(ctx, n) {
  const { registrationSpecs, moduleLocals } = ctx;
  if (!n) return;
  if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.init) {
    const c = n.init.type === 'CallExpression' || n.init.type === 'OptionalCallExpression'
      ? calleeOf(n.init.callee) : null;
    for (const spec of registrationSpecs) {
      if (c && c.root === spec.root && c.path.length === 1 && c.path[0] === spec.moduleMethod) moduleLocals.add(n.id.name);
    }
  }
  eachChild(n, (child) => collectModuleLocals(ctx, child));
}

/** The definition object a registration was given, through the DI array form. */
function definitionObjectOf(node) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') return node;
  if (node.type === 'ArrayExpression') {
    const last = node.elements[node.elements.length - 1];
    return last && last.type === 'ObjectExpression' ? last : null;
  }
  // `.directive('x', function () { return { controller: 'X' } })`
  if (isFunctionNode(node)) {
    let body = node.body;
    if (body && body.type === 'BlockStatement') {
      for (let i = body.body.length - 1; i >= 0; i -= 1) {
        if (body.body[i].type === 'ReturnStatement') { body = body.body[i].argument; break; }
      }
    }
    return body && body.type === 'ObjectExpression' ? body : null;
  }
  return null;
}

/**
 * The framework's own name registry.
 *
 * `angular.module('ownerList').component('ownerList', {controller:
 * 'OwnerListController'})` is how a frontend written before modules says one
 * thing is made of another. Nothing is resolved here.
 */
export function registrationScan(ctx, n) {
  const { registrationSpecs, moduleLocals, lineOf, relFile, emit, attachTemplate } = ctx;
  const isRegistryRoot = (name, spec) => name === spec.root || moduleLocals.has(name);
  if (!n) return;
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    const method = n.callee && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')
      && !n.callee.computed && n.callee.property && n.callee.property.type === 'Identifier'
      ? n.callee.property.name : null;
    if (method !== null) {
      let cur = n.callee.object;
      let rootName = null;
      for (let i = 0; i < HOP_GUARD && cur; i += 1) {
        if (cur.type === 'Identifier') { rootName = cur.name; break; }
        if ((cur.type === 'CallExpression' || cur.type === 'OptionalCallExpression') && cur.callee) { cur = cur.callee; continue; }
        if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') { cur = cur.object; continue; }
        break;
      }
      for (const spec of registrationSpecs) {
        if (rootName === null || !isRegistryRoot(rootName, spec)) continue;
        const kind = spec.kinds.find((k) => k.method === method);
        if (!kind) continue;
        const args = n.arguments ?? [];
        const nameNode = args[kind.nameArg];
        if (!nameNode || nameNode.type !== 'StringLiteral' || nameNode.value === '') continue;
        const def = definitionObjectOf(args[kind.defArg]);
        const line = lineOf(n);
        const rec = {
          kind: 'registration', file: relFile, line, framework: spec.root,
          what: method, name: nameNode.value,
        };
        if (def) {
          const ctrl = spec.controllerKey ? propOf(def, spec.controllerKey) : null;
          if (ctrl && ctrl.type === 'StringLiteral') rec.controller = ctrl.value;
          const tpl = spec.templateKey ? propOf(def, spec.templateKey) : null;
          if (tpl && tpl.type === 'StringLiteral') {
            const tags = customElementTags(tpl.value);
            if (tags.length > 0) rec.templateTags = tags;
          }
          const url = spec.templateUrlKey ? propOf(def, spec.templateUrlKey) : null;
          if (url && url.type === 'StringLiteral') attachTemplate(rec, url.value);
        }
        // A directive is only a mount point when its definition names a
        // controller. Every other directive is behaviour on an element, and
        // claiming it renders a screen would be an invention.
        if (kind.needs && !Object.prototype.hasOwnProperty.call(rec, kind.needs)) continue;
        emit(rec, line);
      }
    }
  }
  eachChild(n, (child) => registrationScan(ctx, child));
}

/**
 * The client the framework hands you.
 *
 * `$http` is not imported and not declared: it arrives as a parameter, and the
 * only thing that says it is a client is WHERE the function sits. So the two
 * forms the pack names are found first, and a parameter is a client only inside
 * one of them.
 */
export function injectionScan(ctx, n) {
  const { injectedClients, injectionTargets } = ctx;
  if (!n) return;
  if (n.type === 'ArrayExpression') {
    // `['$http', function ($http) {…}]`: the framework's own inline
    // annotation. The names come first, the function last.
    const els = n.elements ?? [];
    const last = els[els.length - 1];
    if (els.length >= 2 && last && isFunctionNode(last)
      && els.slice(0, -1).every((e) => e && e.type === 'StringLiteral')) {
      injectionTargets.add(last);
    }
  }
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    const c = n.callee ? calleeOf(n.callee) : null;
    const method = c ? c.name : (n.callee && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression')
      && !n.callee.computed && n.callee.property && n.callee.property.type === 'Identifier'
      ? n.callee.property.name : null);
    const named = [...injectedClients.values()].some((client) => (client.registrars ?? []).includes(method));
    if (named) {
      for (const a of n.arguments ?? []) {
        if (!a) continue;
        if (isFunctionNode(a)) { injectionTargets.add(a); continue; }
        if (a.type === 'ObjectExpression') {
          for (const prop of a.properties) {
            if (prop.type !== 'ObjectProperty') continue;
            if (isFunctionNode(prop.value)) injectionTargets.add(prop.value);
          }
        }
      }
    }
  }
  eachChild(n, (child) => injectionScan(ctx, child));
}
