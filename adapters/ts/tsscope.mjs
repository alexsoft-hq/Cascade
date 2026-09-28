// tsscope.mjs — which local declaration a name in one file refers to, and whether that local is ever written again.
//
// Two names spelled alike are not one binding: `const x = this.prisma.$extends(...)`
// in a method and `const x = {...}` in a block inside it are two locals, and a
// call on the inner one is not a call on the client. A reader that keys a name
// by the member it is written in cannot tell them apart; this walk can. It
// scopes one file's syntax tree the way the language does (a function's
// parameters and `var`s, a block's `let`, `const`, class and function, a catch
// clause's parameter, a for loop's head) and answers, for an identifier, the
// place of the declaration it refers to (`line:column`), and whether that local
// is written again anywhere it is in scope: an assignment, `++`, a for-in or
// for-of target, a second `var` of the same name. A local declared with no
// value (`let r;`) and written exactly once is `once`: wherever it is read, it
// holds that one value or none at all.
//
// Only a LOCAL is answered: a name declared in a function, a block or a clause.
// A name declared at module level, or imported, has no answer, so a record that
// uses none stays what it was. Types are another namespace and are not scoped.
// Nothing here looks at another file.

import { eachChild, isFunctionNode } from '../web/lib/ast.mjs';

const place = (id) => (id.loc ? `${id.loc.start.line}:${id.loc.start.column}` : null);

/** A scope: its parent, whether a `var` stops here, and the locals declared in it by name. */
const scopeIn = (parent, kind) => ({ parent, kind, names: new Map() });

/** The identifiers a binding pattern declares, or an assignment target writes. */
function patternIds(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternIds(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) patternIds(e, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  else if (p.type === 'TSParameterProperty') patternIds(p.parameter, out);
  return out;
}

/** The nearest scope a `var` is declared in: a function's, or the module's. */
function varScope(scope) {
  let s = scope;
  while (s.kind === 'block') s = s.parent;
  return s;
}

function declare(st, scope, id, initialized = true) {
  if (!id || !id.name) return;
  const prev = scope.names.get(id.name);
  if (prev) {
    // A second declaration of one name in one scope (`var x = a; var x = b`) writes it again.
    prev.reassigned = true;
    prev.redeclared = true;
    st.declared.set(id, prev);
    return;
  }
  const b = { at: place(id), local: scope.kind !== 'module', reassigned: false, initialized, writes: 0, redeclared: false };
  scope.names.set(id.name, b);
  st.declared.set(id, b);
}

function resolve(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const b = s.names.get(name);
    if (b) return b;
  }
  return null;
}

/** A function: its own name (an expression's, in a scope of its own), its parameters, and its body, all in one function scope. */
function walkFunction(st, node, scope) {
  let outer = scope;
  if (node.type === 'FunctionDeclaration') declare(st, scope, node.id);
  else if (node.id && node.type === 'FunctionExpression') { outer = scopeIn(scope, 'block'); declare(st, outer, node.id); }
  if (node.computed && node.key) walk(st, node.key, scope);
  for (const d of node.decorators ?? []) walk(st, d, scope);
  const fn = scopeIn(outer, 'function');
  for (const p of node.params) for (const id of patternIds(p)) declare(st, fn, id);
  for (const p of node.params) walk(st, p, fn);
  const body = node.body;
  if (body && body.type === 'BlockStatement') for (const s of body.body) walk(st, s, fn);
  else if (body) walk(st, body, fn);
}

/** A declaration statement's names, in the scope its kind puts them in; the rest of it is walked where it stands. */
function walkDeclaration(st, node, scope) {
  if (node.type === 'VariableDeclaration') {
    const target = node.kind === 'var' ? varScope(scope) : scope;
    // A for-in or for-of head is given a value by the loop, whatever it writes.
    for (const d of node.declarations) for (const id of patternIds(d.id)) declare(st, target, id, Boolean(d.init) || st.loopHeads.has(node));
  } else if (node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration') {
    declare(st, scope, node.id);
  }
}

/** The identifiers an assignment, an update or a for-in/of head writes, kept to resolve once every declaration is known. */
function noteWrites(st, node, scope) {
  let target = null;
  if (node.type === 'AssignmentExpression') target = node.left;
  else if (node.type === 'UpdateExpression') target = node.argument;
  else if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type !== 'VariableDeclaration') target = node.left;
  for (const id of patternIds(target)) st.writes.push({ id, scope });
}

/** The scope a node opens for its children, or the scope it stands in when it opens none. */
function scopeOpened(node, scope) {
  if (node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'SwitchStatement'
    || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'
    || node.type === 'CatchClause' || node.type === 'ClassBody' || node.type === 'ClassExpression') return scopeIn(scope, 'block');
  if (node.type === 'TSModuleBlock') return scopeIn(scope, 'function');
  return scope;
}

function walk(st, node, scope) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') { if (!st.declared.has(node)) st.scopes.set(node, scope); return; }
  if (isFunctionNode(node)) { walkFunction(st, node, scope); return; }
  if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type === 'VariableDeclaration') st.loopHeads.add(node.left);
  walkDeclaration(st, node, scope);
  noteWrites(st, node, scope);
  const inner = scopeOpened(node, scope);
  if (node.type === 'CatchClause') for (const id of patternIds(node.param)) declare(st, inner, id);
  if (node.type === 'ClassExpression' && node.id) declare(st, inner, node.id);
  // A type says nothing about which value a name is.
  eachChild(node, (c, key) => { if (key !== 'typeAnnotation' && key !== 'returnType' && key !== 'typeParameters') walk(st, c, inner); });
}

/**
 * The locals of one file's syntax tree.
 *
 * @param {object} ast  a Babel `File`
 * @returns {{local:(id:object) => ({at:string, reassigned:boolean, once:boolean}|null)}}
 *          `local(id)`: for an identifier node of this tree, the local it refers
 *          to or declares, or null when it is not a local (module level,
 *          imported, or declared nowhere in the file)
 */
export function readScopes(ast) {
  const st = { declared: new Map(), scopes: new Map(), writes: [], loopHeads: new Set() };
  walk(st, ast.program, scopeIn(null, 'module'));
  for (const w of st.writes) {
    const b = st.declared.get(w.id) ?? resolve(w.scope, w.id.name);
    if (b) { b.reassigned = true; b.writes += 1; }
  }
  const local = (id) => {
    const b = st.declared.get(id) ?? (st.scopes.has(id) ? resolve(st.scopes.get(id), id.name) : null);
    return b && b.local && b.at ? { at: b.at, reassigned: b.reassigned, once: !b.initialized && b.writes === 1 && !b.redeclared } : null;
  };
  return { local };
}
