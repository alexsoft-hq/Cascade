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

/** Whether one pack would read this object literal as a route declaration. */
export function packSeesARoute(p, node) {
  const ro = p.routeObject || {};
  if (!ro.pathKey) return false;
  const pathValue = propOf(node, ro.pathKey);
  if (pathValue === null || pathValue.type !== 'StringLiteral') return false;
  const hasComponent = (ro.componentKeys || []).some((k) => propOf(node, k) !== null);
  const hasChildren = ro.childrenKey ? propOf(node, ro.childrenKey) !== null : false;
  const hasRedirect = ro.redirectKey ? propOf(node, ro.redirectKey) !== null : false;
  const indexValue = ro.indexKey ? propOf(node, ro.indexKey) : null;
  const hasIndex = indexValue !== null && indexValue.type === 'BooleanLiteral' && indexValue.value === true;
  return hasComponent || hasChildren || hasRedirect || hasIndex;
}

/** Whether ANY pack would. */
export function anyPackSeesARoute(packs, node) {
  return node !== null && node !== undefined
    && node.type === 'ObjectExpression' && packs.some((p) => packSeesARoute(p, node));
}

/** Where a route's component comes from: a dynamic import, or an imported name. */
export function componentSourceOf(ctx, node) {
  const { top } = ctx;
  let n = node;
  if (n.type === 'ArrowFunctionExpression' && n.body) n = n.body;
  if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && n.callee && n.callee.type === 'Import') {
    const a = n.arguments[0];
    if (a && a.type === 'StringLiteral') return { source: a.value, local: null };
  }
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
 * Emit a route record for `node` when one of the packs recognizes it. The
 * pack is chosen by the keys the object itself carries: each pack's
 * DISTINCTIVE keys (the ones no other pack names) decide, and the file's own
 * registrar calls break a tie. Nothing here is hard-coded to a framework.
 */
export function maybeRoute(ctx, node, env, parentLine) {
  const { packs, st, lineOf, relFile, emit, routeHandled } = ctx;
  if (routeHandled.has(node)) return;
  const matches = [];
  for (const p of packs) {
    // A chain pack's route objects are read where its registrar names them
    // (`chainRoutes` below) and nowhere else.
    if (p.__routesFrom === 'chain') continue;
    if (!packSeesARoute(p, node)) continue;
    let score = 0;
    for (const k of p.__distinctive) if (propOf(node, k) !== null) score += 1;
    if (st.registrarPacks && st.registrarPacks.has(p.pack)) score += 0.5;
    matches.push({ pack: p, score });
  }
  if (matches.length === 0) return;
  matches.sort((a, b) => b.score - a.score || (a.pack.pack < b.pack.pack ? -1 : 1));
  const pack = matches[0].pack;
  const ro = pack.routeObject || {};
  const line = lineOf(node);
  routeHandled.add(node);

  const rec = { kind: 'route', file: relFile, line, pack: pack.pack };
  const pathValue = propOf(node, ro.pathKey);
  rec.path = pathValue.value;
  const nameValue = ro.nameKey ? propOf(node, ro.nameKey) : null;
  if (nameValue && nameValue.type === 'StringLiteral') rec.name = nameValue.value;
  for (const k of ro.componentKeys || []) {
    const c = propOf(node, k);
    if (!c) continue;
    const src = componentSourceOf(ctx, c);
    if (src.source) rec.componentSource = src.source;
    if (src.local) rec.componentLocal = src.local;
    break;
  }
  const redirect = ro.redirectKey ? propOf(node, ro.redirectKey) : null;
  if (redirect && redirect.type === 'StringLiteral') rec.redirect = redirect.value;
  const meta = ro.metaKey ? propOf(node, ro.metaKey) : null;
  if (meta && meta.type === 'ObjectExpression' && ro.titleKey) {
    const title = propOf(meta, ro.titleKey);
    if (title && title.type === 'StringLiteral') rec.metaTitle = title.value;
  }
  const hidden = ro.hiddenKey ? propOf(node, ro.hiddenKey) : null;
  if (hidden && hidden.type === 'BooleanLiteral') rec.hidden = hidden.value;
  rec.parent = parentLine;

  const children = ro.childrenKey ? propOf(node, ro.childrenKey) : null;
  let childCount = 0;
  if (children && children.type === 'ArrayExpression') {
    for (const el of children.elements) {
      if (el && el.type === 'ObjectExpression') {
        const before = routeHandled.size;
        maybeRoute(ctx, el, env, line);
        if (routeHandled.size > before) childCount += 1;
      }
    }
  }
  rec.children = childCount;
  emit(rec, line);
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

/** A registrar call's own routes array: `createRouter({routes: [...]})`. */
export function registrarRoutes(ctx, n, env) {
  const { packs } = ctx;
  if (!n) return;
  if ((n.type === 'CallExpression' || n.type === 'NewExpression' || n.type === 'OptionalCallExpression') && n.callee) {
    const c = calleeOf(n.callee);
    if (c) {
      for (const p of packs) {
        if (!(p.registrars || []).includes(c.name)) continue;
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
