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

import { calleeOf, eachChild, isFunctionNode, keyName, patternNames, propOf, Scope, summarizeArg } from './ast.mjs';
import { maybeRoute } from './routers.mjs';

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

/** A top-level constant: a string, or an object/enum of strings. */
export function recordConstant(ctx, name, node, exported, line) {
  const { top, emit, relFile } = ctx;
  const m = stringMembers(node);
  if (m && m.members.size > 0) {
    const members = {};
    for (const [k, v] of m.members) members[k] = v;
    top.constants.set(name, { members: m.members, value: null });
    emit({ kind: 'constant', file: relFile, line, name, exported, members, omitted: m.omitted }, line);
    return true;
  }
  if (node && node.type === 'StringLiteral') {
    top.constants.set(name, { members: null, value: node.value });
    emit({ kind: 'constant', file: relFile, line, name, exported, value: node.value }, line);
    return true;
  }
  return false;
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
      if (b) out.baseURL = summarizeArg(b);
    }
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
  ctx.visit(d, env);
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

/** A class: its record, its members, and the client a field may hold. */
export function visitClass(ctx, node, env, exportedAs) {
  const { emit, relFile, lineOf } = ctx;
  const className = node.id ? node.id.name : 'default';
  const line = lineOf(node);
  // WHAT THE CLASS DECLARES, collected BEFORE any body is walked: a method
  // that forwards to `this.request(…)` is written above the method it calls
  // as often as below it, and a walk that learned the member list on the way
  // through would follow one and not the other.
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
  const uniq = (xs) => [...new Set(xs)];
  const top = env.func === null;
  const classInfo = {
    name: className,
    members: new Set([...methods, ...fields]),
  };
  if (top) {
    emit({
      kind: 'class', file: relFile, line, name: className, exported: exportedAs ?? null,
      methods: uniq(methods), fields: uniq(fields),
    }, line);
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

/** An array literal: the routes and the functions written inside it. */
export function visitArray(ctx, node, env, defaultMember) {
  for (const el of node.elements) {
    if (!el) continue;
    if (el.type === 'ObjectExpression') {
      maybeRoute(ctx, el, env, null);
      visitObject(ctx, el, env, defaultMember === true);
      continue;
    }
    if (el.type === 'ArrayExpression') { visitArray(ctx, el, env, defaultMember); continue; }
    ctx.visit(el, env);
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
  if (!ctx.nexacro || env.func !== null || !env.scope.isModule) return null;
  if (!left || (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression')) return null;
  const right = node.right;
  if (!right || (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression')) return null;
  const c = calleeOf(left);
  return c && c.root === 'this' && c.path.length >= 1 ? c.path.join('.') : null;
}

export function visitAssignment(ctx, node, env) {
  const { emit, relFile, lineOf } = ctx;
  const left = node.left;
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
