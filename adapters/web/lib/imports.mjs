// imports.mjs — what a file DECLARES, and what each declaration holds.
//
// WHAT THIS MODULE OWNS. Everything a walk meets before it meets a call:
//   the hoist        a function at the top of a file calls one declared at the
//                    bottom, so the top level is collected before anything is
//                    resolved
//   the binding      what a root identifier IS in this file: an import, a local,
//                    a `this` inside a class, or a global nobody declared
//   the records      the `import`, `export`, `constant`, `binding`, `class` and
//                    `function` records, each one thing the file states about
//                    itself
//   the instance     the four shapes an initializer can hold a client in —
//   tracing          `f(...)`, `new C(...)`, another name, a member of one —
//                    and what a function RETURNS, one level deep
//   the walk's       the visitors for every declaration form, including the
//   visitors         object literal a Vue options component is
//
// ONE FILE IS ALL IT SEES. Whether the name an import leads to is really a
// client is the bridge's question, because the file that builds it is another
// file. What is recorded here is what this file says.
//
// WHAT IT MUST NEVER KNOW ABOUT: the graph, the routes a pack serves, the other
// files in the tree. Every function takes the walk's CONTEXT first, so a reader
// can see at the signature what a rule is allowed to reach.

import {
  calleeOf, eachChild, isEnvExpression, isFunctionNode, keyName, patternNames, propOf, Scope, summarizeArg,
} from './ast.mjs';
import { navigationAssignmentOf } from './navigation.mjs';
import { formActionAssignment, formMethodAssignment } from './forms.mjs';
import { emitRouteRef, maybeRoute } from './routers.mjs';

/**
 * Pass 1: hoist what the top level declares. A function at the top of a file
 * calls one declared at the bottom, so the declarations are collected before
 * anything is resolved.
 */
export function hoist(ctx, body) {
  const { moduleScope } = ctx;
  for (const node of body) {
    const d = (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration')
      ? node.declaration : node;
    if (!d) continue;
    if (d.type === 'VariableDeclaration') {
      for (const decl of d.declarations) {
        for (const n of patternNames(decl.id)) moduleScope.declare(n, decl.init, d.kind !== 'const');
      }
    } else if (d.type === 'FunctionDeclaration' && d.id) moduleScope.declare(d.id.name, null);
    else if (d.type === 'ClassDeclaration' && d.id) moduleScope.declare(d.id.name, null);
    else if (d.type === 'TSEnumDeclaration' && d.id) moduleScope.declare(d.id.name, null);
    else if (d.type === 'TSModuleDeclaration' && d.id && d.id.type === 'Identifier') moduleScope.declare(d.id.name, null);
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) moduleScope.declare(s.local.name, null);
    }
  }
}

/**
 * WHAT A ROOT IDENTIFIER IS IN THIS FILE.
 *
 * `classInfo` is the class whose body we are inside, when we are inside one. A
 * `this` root there is not a global: it is THAT class, and saying so is the
 * whole difference between `this.inner.get(url)` being followable and being a
 * call on an unknown object.
 */
export function bindingOf(ctx, root, scope, classInfo) {
  const { top } = ctx;
  if (root === null) return null;
  if (root === 'this') {
    return classInfo ? { kind: 'this', class: classInfo.name } : { kind: 'global', name: 'this' };
  }
  if (root === 'import.meta') return { kind: 'global', name: root };
  const found = scope.find(root);
  if (found && !found.isModule) return null; // a parameter, or a variable of the enclosing function
  if (top.imports.has(root)) {
    const imp = top.imports.get(root);
    return { kind: 'import', source: imp.source, imported: imp.imported };
  }
  if (top.bindings.has(root) || top.constants.has(root) || top.functions.has(root)) {
    return { kind: 'local', name: root };
  }
  if (found && found.isModule) return { kind: 'local', name: root };
  return { kind: 'global', name: root };
}

/** The `import` record, and the names it puts in scope. */
export function recordImport(ctx, node) {
  const { top, emit, relFile, lineOf } = ctx;
  const source = node.source.value;
  const specifiers = [];
  for (const s of node.specifiers) {
    let imported = 'default';
    if (s.type === 'ImportNamespaceSpecifier') imported = '*';
    else if (s.type === 'ImportSpecifier') {
      imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
    }
    specifiers.push({ imported, local: s.local.name });
    top.imports.set(s.local.name, { source, imported });
  }
  emit({ kind: 'import', file: relFile, line: lineOf(node), source, specifiers, dynamic: false }, lineOf(node));
}

/** The string members of an enum or an object literal, when it has any. */
function stringMembers(node) {
  const members = new Map();
  let omitted = 0;
  if (!node) return null;
  if (node.type === 'TSEnumDeclaration') {
    for (const m of node.members) {
      const name = m.id.type === 'Identifier' ? m.id.name : m.id.value;
      if (m.initializer && m.initializer.type === 'StringLiteral') members.set(name, m.initializer.value);
      else omitted += 1;
    }
    return { members, omitted };
  }
  if (node.type === 'ObjectExpression') {
    for (const p of node.properties) {
      if (p.type !== 'ObjectProperty') { omitted += 1; continue; }
      const name = keyName(p);
      if (name === null) { omitted += 1; continue; }
      if (p.value.type === 'StringLiteral') members.set(name, p.value.value);
      else omitted += 1;
    }
    return { members, omitted };
  }
  return null;
}

/** How deep an object of objects is read for its text, and how much text is kept. */
const NESTED_DEPTH = 6;
const NESTED_LEAVES = 2000;

/**
 * THE TEXT AN OBJECT OF OBJECTS KEEPS BELOW ITS FIRST LEVEL (RM67), by dotted
 * path: `{orders: {path: 'orders', list: {path: 'list'}}}` keeps `orders.path`
 * and `orders.list.path`. An application that writes its route paths once, in
 * one object, and names them everywhere else is read through this; the first
 * level is `members`, as it always was.
 *
 * @returns {Map<string,string>}
 */
function nestedStrings(node) {
  const out = new Map();
  const walk = (obj, prefix, depth) => {
    for (const p of obj.properties) {
      if (out.size >= NESTED_LEAVES) return;
      if (p.type !== 'ObjectProperty') continue;
      const key = keyName(p);
      if (key === null || key.includes('.')) continue;
      const at = prefix === null ? key : `${prefix}.${key}`;
      if (p.value.type === 'StringLiteral' && prefix !== null) out.set(at, p.value.value);
      else if (p.value.type === 'ObjectExpression' && depth < NESTED_DEPTH) walk(p.value, at, depth + 1);
    }
  };
  if (node && node.type === 'ObjectExpression') walk(node, null, 1);
  return out;
}

/**
 * The members of an object literal whose value is a BUILD fact (see
 * isEnvExpression): `{ base_url: import.meta.env.VITE_BASE_URL +
 * import.meta.env.VITE_API_URL }`. Null when there are none.
 */
function envMembers(node) {
  if (!node || node.type !== 'ObjectExpression') return null;
  const out = {};
  let any = false;
  for (const p of node.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const key = keyName(p);
    const s = key === null ? null : summarizeArg(p.value);
    if (s === null || !isEnvExpression(s)) continue;
    out[key] = s;
    any = true;
  }
  return any ? out : null;
}

/** A top-level constant: a string, an object/enum of strings, or a value the build decides. */
export function recordConstant(ctx, name, written, exported, line) {
  const { top, emit, relFile } = ctx;
  // `{…} as const` and `{…} satisfies T` hold the object they are written around.
  const node = withoutTypeScript(written);
  const m = stringMembers(node);
  const nested = nestedStrings(node);
  const exprMembers = envMembers(node);
  if (m && (m.members.size > 0 || nested.size > 0 || exprMembers !== null)) {
    const members = {};
    for (const [k, v] of m.members) members[k] = v;
    const more = { ...(nested.size > 0 ? { nested } : {}), ...(exprMembers ? { exprMembers } : {}) };
    top.constants.set(name, { members: m.members, value: null, ...more });
    emit({
      kind: 'constant', file: relFile, line, name, exported, members, omitted: m.omitted,
      ...(nested.size > 0 ? { nested: Object.fromEntries(nested) } : {}), ...(exprMembers ? { exprMembers } : {}),
    }, line);
    return true;
  }
  if (node && node.type === 'StringLiteral') {
    top.constants.set(name, { members: null, value: node.value });
    emit({ kind: 'constant', file: relFile, line, name, exported, value: node.value }, line);
    return true;
  }
  return recordEnvExpression(ctx, name, node, exported, line);
}

/**
 * `export const API = process.env.X || 'http://localhost:8080/api'`: a constant
 * whose value is a BUILD fact. The record carries the expression whole
 * (`expr`) and no `value`, because what X holds is in the package's `.env`
 * files and one file cannot read those; the bridge does. It is kept out of
 * `top.constants` on purpose: nothing in this file may read it as text. A bare
 * `process.env.X` is left to the binding record it has always had.
 */
function recordEnvExpression(ctx, name, node, exported, line) {
  const s = node ? summarizeArg(node) : null;
  if (s === null || s.kind === 'member' || !isEnvExpression(s)) return false;
  ctx.emit({ kind: 'constant', file: ctx.relFile, line, name, exported, expr: s }, line);
  return true;
}

/**
 * WHAT AN INITIALIZER IS, in the four shapes that can hold a client:
 * `f(...)`, `new C(...)`, another name, or a member of one. Null for anything
 * else. Shared by the three places a client can be put somewhere: a top-level
 * `const`, `this.field = …` inside a class, and what a function RETURNS.
 * @returns {{shape:string, callee:object, binding:object|null, baseURL?:object}|null}
 */
export function initOf(ctx, init, env) {
  if (!init) return null;
  // `inject(OrderService)`: the value is an instance of the TYPE the call
  // names, not whatever the injector function returns (RM67).
  const injected = injectorTypeOf(ctx, init, env);
  if (injected !== null) return injected;
  let shape = null;
  let target = null;
  if (init.type === 'CallExpression' || init.type === 'OptionalCallExpression') { shape = 'call'; target = init.callee; }
  else if (init.type === 'NewExpression') { shape = 'new'; target = init.callee; }
  else if (init.type === 'Identifier') { shape = 'ident'; target = init; }
  else if (init.type === 'MemberExpression' || init.type === 'OptionalMemberExpression') { shape = 'member'; target = init; }
  if (shape === null) return null;
  const callee = target ? calleeOf(target) : null;
  if (callee === null) return null;
  const out = { shape, callee, binding: bindingOf(ctx, callee.root, env.scope, env.classInfo) };
  // A base URL declared where the client is built is the one thing in this
  // file that decides what every call through it resolves to, so it rides on
  // the record rather than being left for the bridge to go and find.
  if ((shape === 'call' || shape === 'new') && init.arguments && init.arguments.length > 0) {
    const first = init.arguments[0];
    if (first && first.type === 'ObjectExpression') {
      const b = propOf(first, 'baseURL');
      if (b) out.baseURL = baseUrlSummary(ctx, b, env);
    }
  }
  return out;
}

/**
 * A base URL as the bridge can follow it. `baseURL: base_url`, where the top of
 * the module wrote `const { base_url } = config`, is the member `config.base_url`:
 * the name alone says nothing, the member says where to look.
 */
function baseUrlSummary(ctx, node, env) {
  const s = summarizeArg(node);
  if (s.kind !== 'ident') return s;
  const d = ctx.top.destructured ? ctx.top.destructured.get(s.name) : undefined;
  const where = env.scope.find(s.name);
  if (!d || !where || !where.isModule) return s;
  return { kind: 'member', root: d.root, path: [d.key] };
}

/** `const { a, b: c } = obj` at the top of a module: which member of `obj` each name is. */
function noteDestructured(ctx, node, decl, env) {
  if (!env.scope.isModule || node.kind !== 'const' || !decl.init || decl.id.type !== 'ObjectPattern') return;
  if (decl.init.type !== 'Identifier') return;
  for (const p of decl.id.properties) {
    // A default (`{ a = '/x' }`) is a second value, and a rest is no member.
    if (p.type !== 'ObjectProperty' || p.value.type !== 'Identifier') continue;
    const key = keyName(p);
    if (key !== null) ctx.top.destructured.set(p.value.name, { root: decl.init.name, key });
  }
}

/** The `typed` init a TYPE name makes: what the field holds is an instance of it. */
function typedInit(ctx, typeNode, env, via, extra = {}) {
  const t = typeNode ? calleeOf(typeNode) : null;
  if (!t || t.root === null || t.root === 'this') return null;
  return { shape: 'typed', callee: t, binding: bindingOf(ctx, t.root, env.scope, env.classInfo), via, ...extra };
}

/**
 * THE FRAMEWORK'S INJECTOR, called for a type (RM67): `inject(OrderService)`
 * where `inject` is imported from the module an injection pack names
 * (adapters/web/packs/injection.json). Null for any other call, so a function
 * that merely happens to be called `inject` is nothing here.
 */
export function injectorTypeOf(ctx, init, env) {
  const injectors = ctx.injectors ?? [];
  if (injectors.length === 0 || !init || init.type !== 'CallExpression' || !init.callee) return null;
  const c = calleeOf(init.callee);
  if (!c || c.path.length > 0) return null;
  const b = bindingOf(ctx, c.root, env.scope, env.classInfo);
  if (!b || b.kind !== 'import') return null;
  const inj = injectors.find((i) => i.module === b.source && i.name === b.imported);
  if (!inj) return null;
  const arg = (init.arguments ?? [])[inj.typeArg ?? 0];
  if (!arg || (arg.type !== 'Identifier' && arg.type !== 'MemberExpression')) return null;
  return typedInit(ctx, arg, env, 'injector', { injector: inj.name });
}

/**
 * THE FIELDS A CLASS STATES THE TYPE OF (RM67), field name to its `typed`
 * init. Two spellings, and only two:
 *   a constructor parameter with an access modifier   `constructor(private
 *       orders: OrderService)` is TypeScript's own field declaration. One with a
 *       decorator is left out: `@Inject(TOKEN)` hands in whatever the token
 *       names, which is not the type written beside it
 *   a field set from the framework's injector         `orders = inject(OrderService)`
 * A field typed this way holds that type or a class a provider puts in its
 * place, and the bridge grades what goes through it accordingly.
 *
 * @returns {Map<string,{init:object, line:number}>}
 */
function typedFields(ctx, node, env) {
  const out = new Map();
  for (const m of node.body.body) {
    if (m.type === 'ClassMethod' && m.kind === 'constructor') {
      for (const p of m.params ?? []) {
        if (!p || p.type !== 'TSParameterProperty' || (p.decorators ?? []).length > 0) continue;
        const id = p.parameter && p.parameter.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
        if (!id || id.type !== 'Identifier' || (id.decorators ?? []).length > 0) continue;
        const ann = id.typeAnnotation && id.typeAnnotation.typeAnnotation;
        if (!ann || ann.type !== 'TSTypeReference' || !ann.typeName || ann.typeName.type !== 'Identifier') continue;
        const init = typedInit(ctx, ann.typeName, env, 'constructor-parameter');
        if (init !== null) out.set(id.name, { init, line: ctx.lineOf(p) });
      }
      continue;
    }
    if (m.type !== 'ClassProperty' || !m.value) continue;
    const name = memberNameOf(m);
    const init = name === null ? null : injectorTypeOf(ctx, m.value, env);
    if (init !== null) out.set(name, { init, line: ctx.lineOf(m) });
  }
  return out;
}

/** A top-level `const` whose initializer is one of those four shapes. */
export function recordBinding(ctx, name, init, exported, line) {
  const { top, emit, relFile, moduleScope } = ctx;
  const shaped = initOf(ctx, init, { scope: moduleScope, classInfo: null });
  if (shaped === null) return false;
  const rec = { kind: 'binding', file: relFile, line, name, exported, init: shaped };
  if (shaped.shape === 'new' && shaped.callee.name === 'XMLHttpRequest') top.xhr.add(name);
  top.bindings.set(name, rec);
  emit(rec, line);
  return true;
}

/**
 * WHAT A FUNCTION HANDS BACK, in the one form that can be followed: the LAST
 * `return` at the top level of its body, when it returns a call or a `new`.
 *
 * Only the last one, and only at the top level, on purpose. A `return` inside
 * an `if` is one of several answers and picking it would state a fact the
 * code does not; a function that ends `return new Client(opts)` states
 * exactly one. Everything else is `null`, which the bridge reads as "not
 * followable" rather than as "returns nothing".
 *
 * A concise arrow body (`() => make()`) IS its return statement, so it counts.
 */
export function returnsOf(ctx, node, env) {
  if (!node || !node.body) return null;
  let arg = null;
  if (node.body.type === 'BlockStatement') {
    for (let i = node.body.body.length - 1; i >= 0; i -= 1) {
      if (node.body.body[i].type === 'ReturnStatement') { arg = node.body.body[i].argument; break; }
    }
  } else {
    arg = node.body;
  }
  if (!arg) return null;
  if (arg.type !== 'CallExpression' && arg.type !== 'OptionalCallExpression' && arg.type !== 'NewExpression') return null;
  // The parameters are in scope inside the body, so a `return handler(x)`
  // whose `handler` is a PARAMETER is correctly reported as unfollowable
  // rather than as a call on a module-level name of the same spelling.
  const inner = new Scope(env.scope, false);
  for (const p of node.params || []) for (const n of patternNames(p)) inner.declare(n, null);
  return initOf(ctx, arg, { scope: inner, classInfo: env.classInfo ?? null });
}

/**
 * The `function` record, and the entry the naming pass later finalises.
 *
 * `member` is the OWNER AND KEY of a function written inside a named object
 * literal (`contentService.get`), when there is one. It rides beside the name
 * rather than replacing it, because the name is half of this lane's symbol key
 * and renaming it would rename every symbol in every frontend already read.
 */
export function declareFunction(ctx, node, baseName, exported, scope, env, member = null) {
  const { st, top, emit, relFile, lineOf, endLineOf, columnOf } = ctx;
  const line = lineOf(node);
  const entry = {
    node, baseName, line, column: columnOf(node), finalName: null, record: null, parent: null,
  };
  const rec = {
    kind: 'function', file: relFile, line, name: baseName,
    endLine: endLineOf(node), exported: exported ?? null,
    async: node.async === true, params: (node.params || []).length,
    returns: returnsOf(ctx, node, env ?? { scope, classInfo: null }),
    ...(member === null ? {} : { member }),
  };
  entry.record = rec;
  st.funcEntries.push(entry);
  emit(rec, line);
  if (baseName && scope.isModule) top.functions.set(baseName, rec);
  return entry;
}

/** `export …` with a name on it. */
export function visitExportNamed(ctx, node, env) {
  const { top, emit, relFile, lineOf } = ctx;
  const line = lineOf(node);
  if (node.source) {
    for (const s of node.specifiers) {
      const name = s.exported ? (s.exported.name ?? s.exported.value) : '*';
      emit({ kind: 'export', file: relFile, line, name, of: 'reexport', source: node.source.value }, line);
    }
    if (node.specifiers.length === 0) {
      emit({ kind: 'export', file: relFile, line, name: '*', of: 'reexport', source: node.source.value }, line);
    }
    return;
  }
  const d = node.declaration;
  if (!d) {
    for (const s of node.specifiers) {
      const local = s.local ? (s.local.name ?? s.local.value) : null;
      const name = s.exported ? (s.exported.name ?? s.exported.value) : local;
      const of = top.functions.has(local) ? 'function' : top.constants.has(local) || top.bindings.has(local) ? 'const' : 'expression';
      emit({ kind: 'export', file: relFile, line, name, of, local }, line);
    }
    return;
  }
  if (d.type === 'FunctionDeclaration') {
    const name = d.id ? d.id.name : 'default';
    emit({ kind: 'export', file: relFile, line, name, of: 'function', local: name }, line);
    const entry = env.func === null ? declareFunction(ctx, d, name, 'named', env.scope, env) : null;
    visitFunctionBody(ctx, d, env, entry);
    return;
  }
  if (d.type === 'ClassDeclaration') {
    const name = d.id ? d.id.name : 'default';
    emit({ kind: 'export', file: relFile, line, name, of: 'class', local: name }, line);
    visitClass(ctx, d, env, 'named');
    return;
  }
  if (d.type === 'VariableDeclaration') {
    for (const decl of d.declarations) {
      for (const n of patternNames(decl.id)) {
        emit({ kind: 'export', file: relFile, line: lineOf(decl), name: n, of: 'const', local: n }, lineOf(decl));
      }
    }
    visitVariableDeclaration(ctx, d, env, 'named');
    return;
  }
  if (d.type === 'TSEnumDeclaration' && d.id) {
    emit({ kind: 'export', file: relFile, line, name: d.id.name, of: 'const', local: d.id.name }, line);
    if (env.scope.isModule) recordConstant(ctx, d.id.name, d, true, lineOf(d));
    return;
  }
  ctx.visit(d, env);
}

/** `export default …`, including the object a Vue options component is. */
export function visitExportDefault(ctx, node, env) {
  const { emit, relFile, lineOf } = ctx;
  const line = lineOf(node);
  const d = node.declaration;
  if (!d) return;
  if (d.type === 'FunctionDeclaration' || d.type === 'FunctionExpression' || d.type === 'ArrowFunctionExpression') {
    const name = (d.id && d.id.name) || 'default';
    emit({ kind: 'export', file: relFile, line, name: 'default', of: 'function', local: name }, line);
    const entry = env.func === null ? declareFunction(ctx, d, name, 'default', env.scope, env) : null;
    visitFunctionBody(ctx, d, env, entry);
    return;
  }
  if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') {
    emit({ kind: 'export', file: relFile, line, name: 'default', of: 'class', local: d.id ? d.id.name : null }, line);
    visitClass(ctx, d, env, 'default');
    return;
  }
  if (d.type === 'ObjectExpression') {
    emit({ kind: 'export', file: relFile, line, name: 'default', of: 'object' }, line);
    visitNamedRouteValue(ctx, d, env, 'default');
    // A Vue options component IS this object, and its methods are what the
    // screen calls. Every function-valued member of it, at any depth, is a
    // member of the default export.
    visitObject(ctx, d, { ...env, defaultExport: true }, true, 'default');
    return;
  }
  if (d.type === 'Identifier') {
    emit({ kind: 'export', file: relFile, line, name: 'default', of: 'expression', local: d.name }, line);
    return;
  }
  emit({ kind: 'export', file: relFile, line, name: 'default', of: 'expression' }, line);
  if (!visitNamedRouteValue(ctx, d, env, 'default')) ctx.visit(d, env);
}

/** An expression with the TypeScript written around it taken off: `[…] as Routes` is `[…]`. */
function withoutTypeScript(n) {
  let cur = n;
  for (let i = 0; i < 8 && cur; i += 1) {
    if (cur.type !== 'TSAsExpression' && cur.type !== 'TSSatisfiesExpression' && cur.type !== 'TSTypeAssertion'
      && cur.type !== 'TSNonNullExpression' && cur.type !== 'ParenthesizedExpression') return cur;
    cur = cur.expression;
  }
  return cur;
}

/**
 * A LIST OR A ROUTE BOUND TO A MODULE-LEVEL NAME, in a file whose router names
 * routes by name (RM67). `const orderRoutes: Routes = […]` is walked knowing
 * its name, so every route in it says which list it is in and every name in it
 * is recorded as a reference; `const ordersRoute: Route = {…}` is read as one
 * route under its own name. A route in another file finds either by that name.
 *
 * @returns {boolean} whether the value was walked here (a list), so the caller
 *          does not walk it again
 */
function visitNamedRouteValue(ctx, init, env, name) {
  if (ctx.listRefsOn !== true || !env.scope.isModule || env.func !== null) return false;
  const value = withoutTypeScript(init);
  if (!value) return false;
  if (value.type === 'ArrayExpression') {
    visitArray(ctx, value, { ...env, routeList: name });
    return true;
  }
  if (value.type === 'ObjectExpression') maybeRoute(ctx, value, { ...env, routeList: name, routeTopLevel: true }, null);
  return false;
}

/** `const x = require('y')` names the local the import lands in. */
export function isRequireCall(ctx, n, env) {
  return (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')
    && n.callee && n.callee.type === 'Identifier' && n.callee.name === 'require'
    && n.arguments.length === 1 && n.arguments[0].type === 'StringLiteral'
    && !env.scope.find('require');
}

/** Every declarator of one `const`/`let`/`var`, and what each one holds. */
export function visitVariableDeclaration(ctx, node, env, exportedAs) {
  const { top, lineOf } = ctx;
  for (const decl of node.declarations) {
    const names = patternNames(decl.id);
    for (const n of names) env.scope.declare(n, decl.init, node.kind !== 'const');
    const simple = decl.id.type === 'Identifier' ? decl.id.name : null;
    const line = lineOf(decl);
    noteDestructured(ctx, node, decl, env);
    // `const x = require('y')` names the local the import lands in, which a
    // bare `require('y')` further down cannot.
    if (decl.init && isRequireCall(ctx, decl.init, env)) {
      ctx.visit(decl.init, { ...env, requireLocal: simple });
      if (simple !== null) top.imports.set(simple, { source: decl.init.arguments[0].value, imported: 'default' });
      continue;
    }
    if (simple !== null && env.scope.isModule) {
      // Order matters: a constant is a constant even when its initializer is
      // also an object, and only what is left becomes a binding.
      const asConstant = recordConstant(ctx, simple, decl.init, exportedAs === 'named', line);
      if (!asConstant) recordBinding(ctx, simple, decl.init, exportedAs === 'named', line);
      if (visitNamedRouteValue(ctx, decl.init, env, simple)) continue;
    }
    if (decl.init && isFunctionNode(decl.init) && simple !== null) {
      const entry = env.func === null
        ? declareFunction(ctx, decl.init, simple, exportedAs === 'named' ? 'named' : null, env.scope, env)
        : null;
      visitFunctionBody(ctx, decl.init, env, entry);
      continue;
    }
    if (decl.init && decl.init.type === 'NewExpression') {
      const c = calleeOf(decl.init.callee);
      if (c && c.name === 'XMLHttpRequest' && simple !== null) top.xhr.add(simple);
    }
    // A NAMED OBJECT OF FUNCTIONS is walked knowing its name. The generic walk
    // below reaches the same members and records them under their bare keys;
    // this one records WHOSE they are as well, which is what a caller writing
    // `contentService.get(id)` in another file spells out.
    if (decl.init && decl.init.type === 'ObjectExpression' && simple !== null && env.scope.isModule) {
      visitObject(ctx, decl.init, env, false, simple);
      continue;
    }
    if (decl.init) ctx.visit(decl.init, env);
  }
}

/** A class member's name as written: `get`, `'get'`, `#secret`. */
function memberNameOf(m) {
  if (m.type === 'ClassPrivateMethod' || m.type === 'ClassPrivateProperty') {
    return `#${m.key && m.key.id ? m.key.id.name : 'private'}`;
  }
  return keyName(m);
}

/**
 * The fields a class body ASSIGNS on `this`, wherever it does it. Most
 * JavaScript classes never declare a field at all: `this.inner = create(…)`
 * in the constructor is the declaration. Nested classes are not descended
 * into, because their `this` is a different object.
 */
function thisAssignedFields(classNode, out) {
  const walk = (n) => {
    if (!n) return;
    if (n !== classNode && (n.type === 'ClassDeclaration' || n.type === 'ClassExpression')) return;
    if (n.type === 'AssignmentExpression' && n.left
      && (n.left.type === 'MemberExpression' || n.left.type === 'OptionalMemberExpression')) {
      const c = calleeOf(n.left);
      if (c && c.root === 'this' && c.path.length === 1 && c.path[0] !== '*') out.push(c.path[0]);
    }
    eachChild(n, walk);
  };
  walk(classNode);
}

/**
 * WHAT A CLASS DECLARES, collected BEFORE any body is walked: a method that
 * forwards to `this.request(…)` is written above the method it calls as often
 * as below it, and a walk that learned the member list on the way through would
 * follow one and not the other. A field whose TYPE the class states (RM67) is a
 * field too, wherever it was declared.
 */
function classShape(ctx, node, env) {
  const methods = [];
  const fields = [];
  for (const m of node.body.body) {
    const name = memberNameOf(m);
    if (name === null) continue;
    if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') { methods.push(name); continue; }
    if (m.type === 'ClassProperty' || m.type === 'ClassPrivateProperty') {
      if (m.value && isFunctionNode(m.value)) methods.push(name); else fields.push(name);
    }
  }
  thisAssignedFields(node, fields);
  const typed = typedFields(ctx, node, env);
  for (const name of typed.keys()) fields.push(name);
  return { methods, fields, typed };
}

/**
 * Whether a class is a COMPONENT by the decorator it carries (RM67): one a pack
 * names (`componentClasses`), imported from that pack's module. A file whose
 * extension does not say it is a component says it this way.
 */
function isComponentClass(ctx, node, env) {
  const decl = ctx.componentDecorators ?? [];
  if (decl.length === 0) return false;
  for (const d of node.decorators ?? []) {
    const e = d.expression && d.expression.type === 'CallExpression' ? d.expression.callee : d.expression;
    const c = e ? calleeOf(e) : null;
    if (!c || c.path.length > 0) continue;
    const b = bindingOf(ctx, c.root, env.scope, null);
    if (b && b.kind === 'import' && decl.some((x) => x.module === b.source && x.decorator === b.imported)) return true;
  }
  return false;
}

/** A class: its record, its members, and the client a field may hold. */
export function visitClass(ctx, node, env, exportedAs) {
  const { emit, relFile, lineOf } = ctx;
  const className = node.id ? node.id.name : 'default';
  const line = lineOf(node);
  const { methods, fields, typed } = classShape(ctx, node, env);
  const uniq = (xs) => [...new Set(xs)];
  const top = env.func === null;
  const classInfo = {
    name: className,
    members: new Set([...methods, ...fields]),
    typed: new Map([...typed].map(([k, v]) => [k, v.init])),
  };
  if (top) {
    emit({
      kind: 'class', file: relFile, line, name: className, exported: exportedAs ?? null,
      methods: uniq(methods), fields: uniq(fields),
      ...(isComponentClass(ctx, node, env) ? { component: true } : {}),
    }, line);
  }
  // A TYPED FIELD IS AN ASSIGNMENT the class never writes (RM67): the
  // framework fills it, and the record says with what type.
  for (const [field, t] of typed) {
    emit({ kind: 'assign', file: relFile, line: t.line, class: className, field, init: t.init }, t.line);
  }
  const inner = { ...env, classInfo };
  for (const m of node.body.body) {
    if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') {
      const mName = memberNameOf(m) ?? 'anonymous';
      const entry = env.func === null
        ? declareFunction(ctx, m, `${className}.${mName}`, exportedAs === null ? null : exportedAs, inner.scope, inner)
        : null;
      visitFunctionBody(ctx, m, inner, entry);
      continue;
    }
    if (m.type === 'ClassProperty' || m.type === 'ClassPrivateProperty') {
      if (m.value && isFunctionNode(m.value)) {
        const pName = memberNameOf(m) ?? 'anonymous';
        const entry = env.func === null
          ? declareFunction(ctx, m.value, `${className}.${pName}`, exportedAs === null ? null : exportedAs, inner.scope, inner)
          : null;
        visitFunctionBody(ctx, m.value, inner, entry);
        continue;
      }
      if (m.value) ctx.visit(m.value, inner);
      continue;
    }
    eachChild(m, (child) => ctx.visit(child, inner));
  }
}

/** A function's body, with its parameters in scope. */
export function visitFunctionBody(ctx, node, env, entry) {
  const { injectionTargets, injectedClients } = ctx;
  const scope = new Scope(env.scope, false);
  for (const p of node.params || []) for (const n of patternNames(p)) scope.declare(n, null);
  // A CLIENT ARRIVES AS A PARAMETER, in a function the framework fills in.
  // The map is inherited downward, because `$http.get(url).then(function () {
  // $http.post(…) })` is the same client one scope deeper.
  let injected = env.injected ?? null;
  if (injectedClients.size > 0 && injectionTargets.has(node)) {
    for (const p of node.params || []) {
      if (!p || p.type !== 'Identifier') continue;
      const client = injectedClients.get(p.name);
      if (!client) continue;
      if (injected === null || injected === env.injected) injected = new Map(injected ?? []);
      injected.set(p.name, client);
    }
  }
  const inner = {
    scope, func: entry ?? env.func, defaultExport: false, classInfo: env.classInfo ?? null, injected,
  };
  if (node.body) {
    if (node.body.type === 'BlockStatement') {
      for (const stmt of node.body.body) ctx.visit(stmt, inner);
    } else {
      ctx.visit(node.body, inner);
    }
  }
}

/**
 * An object literal: its function-valued members, and the routes inside it.
 *
 * `owner` is the module-level name the whole object is bound to, when it has
 * one. A service written as `export const contentService = { get: … }` is the
 * ordinary way a TypeScript frontend keeps its API calls, and a page that
 * writes `contentService.get(id)` is calling the function inside it. Only the
 * DIRECT members carry the owner: one more level down, `a: { b(){} }`, the name
 * `a.b` would be a path this lane invented rather than one the caller writes.
 */
export function visitObject(ctx, node, env, defaultMember, owner = null) {
  const memberOf = (name) => (owner !== null && name !== null ? `${owner}.${name}` : null);
  for (const p of node.properties) {
    if (p.type === 'ObjectMethod') {
      const name = keyName(p);
      const entry = (env.func === null && name !== null)
        ? declareFunction(ctx, p, name, defaultMember ? 'default-member' : null, env.scope, env, memberOf(name))
        : null;
      visitFunctionBody(ctx, p, env, entry);
      continue;
    }
    if (p.type === 'ObjectProperty') {
      const name = keyName(p);
      if (isFunctionNode(p.value)) {
        const entry = (env.func === null && name !== null)
          ? declareFunction(ctx, p.value, name, defaultMember ? 'default-member' : null, env.scope, env, memberOf(name))
          : null;
        visitFunctionBody(ctx, p.value, env, entry);
        continue;
      }
      if (p.value.type === 'ObjectExpression') { visitObject(ctx, p.value, env, defaultMember); continue; }
      if (p.value.type === 'ArrayExpression') { visitArray(ctx, p.value, env, defaultMember); continue; }
      ctx.visit(p.value, env);
      continue;
    }
    eachChild(p, (child) => ctx.visit(child, env));
  }
}

/**
 * An array literal: the routes and the functions written inside it. A NAMED
 * route list (RM67) also records every route it holds by name, and hands its
 * name to nothing nested in it: the arrays inside a route are that route's.
 */
export function visitArray(ctx, node, env, defaultMember) {
  const list = typeof env.routeList === 'string' ? env.routeList : null;
  const inner = list === null ? env : { ...env, routeList: null };
  for (const el of node.elements) {
    if (!el) continue;
    if (el.type === 'ObjectExpression') {
      maybeRoute(ctx, el, env, null);
      visitObject(ctx, el, inner, defaultMember === true);
      continue;
    }
    if (list !== null && emitRouteRef(ctx, el, { list, parent: null })) continue;
    if (el.type === 'ArrayExpression') { visitArray(ctx, el, inner, defaultMember); continue; }
    ctx.visit(el, inner);
  }
}

/** `this.field = …` and `x.y = …`: the one that can hold a client is recorded. */
/**
 * THE NAME A NEXACRO FORM GIVES ONE OF ITS HANDLERS, or null (RM56).
 *
 * `this.fn_search = function(obj, e) {…}` at the top of an `.xfdl` script is the
 * form's own method: it is what a button's `onclick` names, and it is where the
 * transaction is written. Recorded as a FUNCTION, so the screen renders it and
 * the call hangs off it rather than off the module.
 */
function nexacroHandlerName(ctx, node, env) {
  const left = node.left;
  if (!(ctx.nexacro || ctx.websquare) || env.func !== null || !env.scope.isModule) return null;
  if (!left || (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression')) return null;
  const right = node.right;
  if (!right || (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression')) return null;
  const c = calleeOf(left);
  // …and a WebSquare page on `scwin` (RM63), the object the engine gives every
  // screen for its own functions: `scwin.btn_search_onclick = function () {…}`.
  if (ctx.websquare) return c && c.root === 'scwin' && c.path.length >= 1 ? `scwin.${c.path.join('.')}` : null;
  return c && c.root === 'this' && c.path.length >= 1 ? c.path.join('.') : null;
}

export function visitAssignment(ctx, node, env) {
  const { emit, relFile, lineOf } = ctx;
  const left = node.left;
  // `location.href = '/'` is a navigation written as an assignment (RM59): the
  // browser leaves this screen for another, and no request is sent from here.
  const navigation = navigationAssignmentOf(ctx, node, env);
  if (navigation !== null) emit(navigation, navigation.line);
  // `form.action = '/x'` and `form.method = 'get'` are the two halves of the
  // idiom every eGovFrame page submits with (RM60). Collected here and paired
  // with the `submit()` after the file has been read, because "the nearest
  // assignment before the submit" is a question about the whole file.
  if (!formActionAssignment(ctx, node, env)) formMethodAssignment(ctx, node, env);
  if (left && (left.type === 'MemberExpression' || left.type === 'OptionalMemberExpression')) {
    const c = calleeOf(left);
    if (c && c.path.length >= 2 && c.path[c.path.length - 2] === 'defaults' && c.path[c.path.length - 1] === 'baseURL') {
      const line = lineOf(node);
      emit({
        kind: 'config', file: relFile, line, what: 'axios-defaults', key: 'baseURL',
        value: summarizeArg(node.right),
      }, line);
    }
    // `this.<field> = <what>` inside a class body. This is where a class puts
    // the client it will send everything through, so it is recorded with the
    // same `init` shape a top-level `const` gets.
    if (env.classInfo && c && c.root === 'this' && c.path.length === 1) {
      const shaped = initOf(ctx, node.right, env);
      if (shaped !== null) {
        const line = lineOf(node);
        emit({
          kind: 'assign', file: relFile, line, class: env.classInfo.name, field: c.path[0], init: shaped,
        }, line);
      }
    }
  }
  // A NEXACRO FORM DECLARES ITS HANDLERS ON `this` (RM56); `nexacroHandlerName`
  // says why that is a function record and not an assignment.
  const handler = nexacroHandlerName(ctx, node, env);
  if (handler !== null) {
    const entry = declareFunction(ctx, node.right, handler, null, env.scope, env);
    visitFunctionBody(ctx, node.right, env, entry);
    eachChild(left, (child) => ctx.visit(child, env));
    return;
  }
  ctx.visit(node.right, env);
  if (left && left.type !== 'Identifier') eachChild(left, (child) => ctx.visit(child, env));
}
