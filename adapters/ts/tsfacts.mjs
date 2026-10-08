#!/usr/bin/env node
import { staticValue, staticFacts } from './tsstatic.mjs';
// tsfacts.mjs — the TypeScript backend worker: what each .ts file says, read from that file alone.
//
// USAGE
//   node adapters/ts/tsfacts.mjs --root <abs root> (<abs dir or file>... | --files-from <list>)
//   node adapters/ts/tsfacts.mjs --list --root <abs root> <abs dir>...
//
// One JSONL record per line (schema `cascade:tsfacts:1`): a header, then for
// each file, in path order, a record that it was read, its imports, exports,
// classes (with their decorators and the type arguments of what they extend),
// interfaces (with those they extend), constructor parameters, properties,
// methods (with what they return), module functions, every call (its receiver
// chain, its arguments, the name its value is held in, the calls chained on
// its result, its place among the calls of the member it is in, and which local
// its receiver and its holder are), and every `new`; then a summary.
// `--list` prints only the files a run over those roots would read. Nothing
// here knows a framework: which call starts an application is a rule the
// bridge reads (src/core/rules/packs/nestjs.json).
//
// NOTHING HERE LOOKS AT ANOTHER FILE. Which class an import names, which
// controller a module registers, which path a route ends up at: all of that is
// decided by the bridge over the whole project's records
// (src/adapters/ts_bridge.mjs). That is what lets a file's records be cached on
// that file's bytes alone: an edit to tsconfig.json, a barrel or main.ts changes
// no other file's records.
//
// Deterministic: files in path order, records in source order, no clock, no
// locale, no environment.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { calleeOf, eachChild, isFunctionNode, keyName, toPosix } from '../web/lib/ast.mjs';
import { readScopes } from './tsscope.mjs';
import { useRecords } from './tsuses.mjs';

const SCHEMA = 'cascade:tsfacts:1';
// 2: a method record carries what each of its own `return`s hands back (`returns`).
// 3: type arguments (`typeArgs`, `extendsArgs`), an object literal a method
//    returns, every `new`, and the calls chained on a call's result (`chain`).
// 4: which local a call's receiver starts at and which it is held in (`rootAt`,
//    `holderAt`, and whether that local is written again), and which local a
//    name or a function parameter among its arguments is (`at`, `paramsAt`).
// 5: a record that each file was read (`file`), interfaces (`interface`), and
//    which local a `new` makes its object through (`rootAt`).
// 6: which local the result of a chain of calls is held in (`chainHolderAt`).
// 7: a property that holds a function (`fn`), the class a mixin function
//    returns (`mixinOf`, `mixinParam`), a class that extends a call
//    (`extendsCall`), and a module constant that names another value (`alias`).
// 8: a local written once after a declaration with no value (`...Once`), the
//    call an assignment or a condition's branch hands to a local (`holder`,
//    `holderBranch`), a local given a name or a member chain (`bind`), a const
//    holding a literal (`const`), the local a `new` is held in, and the local
//    a method returns.
// 9: every class the file declares, nested or held in a const, by the name it
//    is recorded under (`local` for one not at module level); what a class's
//    extends is when it is neither a name nor a call (`extendsExpr`) or names
//    a value of the file that is not a class (`extendsBound`); a member a
//    method's name may be overwritten by (`write`, a property's `bindsSelf`,
//    `computedMembers`); a spread's lists written out (`spreads`); a
//    module-level name written again (`reassigned` on a function,
//    `holderModuleWritten` on a `new`); every use of a local that holds a
//    call's value other than a step whose value is thrown away (`use`,
//    tsuses.mjs); and the locals a destructuring of `this` or of a member
//    chain gives, and each value a `||`, `??` or `&&` may be, as `bind`s. Test
//    files are listed like any other: which are a test's is the typescript
//    pack's to say (ts.test-support).
export const VERSION = 'tsfacts/10';

const require = createRequire(import.meta.url);
// The same vendored parser the web worker reads TypeScript with.
const babel = require('../web/vendor/babel-parser.cjs');

/**
 * Directories no backend source lives in: packages, build output, tool state.
 * Which files are a test's is not decided here: the run asks the typescript
 * pack (ts.test-support), so it can say what it left out.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.nx', '.angular', 'tmp']);

/** How deep an argument is summarized; past it a value is only "something". */
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function isSourceFile(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

/**
 * Whether a root-relative path is a file a run over a directory holding it
 * would read: a source file with no directory on the way that a walk skips.
 * Asked of a file an import reaches outside the application's root, so that
 * file is read under the same rule as one found by walking.
 */
export function isReadablePath(rel) {
  const parts = rel.split('/');
  const dirs = parts.slice(0, -1);
  return isSourceFile(parts[parts.length - 1]) && !dirs.some((d) => d === '' || d === '..' || SKIP_DIRS.has(d) || d.startsWith('.'));
}

function collect(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return; }
  if (stat.isFile()) { if (isSourceFile(target)) out.push(target); return; }
  if (!stat.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(target).sort(); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    collect(path.join(target, name), out);
  }
}

export function sourceFiles(targets) {
  const out = [];
  for (const t of targets) collect(t, out);
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A TypeScript wrapper that does not change the value (`x as T`, `x!`, `x satisfies T`, `await x`). */
function unwrap(node) {
  let n = node;
  while (n && ['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'ParenthesizedExpression', 'AwaitExpression'].includes(n.type)) {
    n = n.expression ?? n.argument;
  }
  return n;
}

/** A member chain as written, `a.b.c` or `this.x.y`, or null when it is not one. */
export function chainOf(node) {
  const c = node && calleeOf(unwrap(node));
  return c && c.root !== null ? [c.root, ...c.path].join('.') : null;
}

function objectSummary(node, depth, sc) {
  const v = {};
  let spread = false;
  let computed = false;
  for (const p of node.properties) {
    if (p.type === 'SpreadElement') { spread = true; continue; }
    const key = keyName(p);
    if (key === null) { computed = true; continue; }
    v[key] = p.type === 'ObjectMethod' ? { k: 'fn' } : valueOf(p.value, depth + 1, sc);
  }
  return { k: 'obj', v, ...(spread ? { spread: true } : {}), ...(computed ? { computed: true } : {}) };
}

/**
 * What a value written in the source is, as far as the file alone can say:
 * a literal, a name, a member chain, an array or object of such (with any
 * spread or computed key marked, since the keys it adds are not known), a call,
 * a function, or just an expression. With `sc` (the file's locals, as a call's
 * arguments are read), a name that is a local says where it is declared (`at`),
 * and whether it is written again, and a function where its parameters are.
 */
export function valueOf(node, depth = 0, sc = null) {
  const n = unwrap(node);
  if (!n) return { k: 'none' };
  if (depth > MAX_DEPTH) return { k: 'expr' };
  switch (n.type) {
    case 'StringLiteral': return { k: 'str', v: n.value };
    case 'NumericLiteral': return { k: 'num', v: n.value };
    case 'BooleanLiteral': return { k: 'bool', v: n.value };
    case 'NullLiteral': return { k: 'null' };
    case 'TemplateLiteral':
      return n.expressions.length === 0 ? { k: 'str', v: n.quasis.map((q) => q.value.cooked ?? '').join('') } : { k: 'tpl' };
    case 'Identifier': return n.name === 'undefined' ? { k: 'undefined' } : { k: 'id', v: n.name, ...localField(sc, n, 'at', 'reassigned', 'once') };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const chain = chainOf(n);
      return chain ? { k: 'member', v: chain } : { k: 'expr' };
    }
    case 'ArrayExpression': {
      const v = n.elements.filter((e) => e && e.type !== 'SpreadElement').map((e) => valueOf(e, depth + 1, sc));
      const spreads = n.elements.filter((e) => e && e.type === 'SpreadElement').flatMap((e) => spreadLeaves(e.argument, depth + 1, sc));
      return { k: 'arr', v, ...(spreads.length > 0 ? { spread: true, spreads } : {}) };
    }
    case 'ObjectExpression': return objectSummary(n, depth, sc);
    case 'CallExpression':
    case 'OptionalCallExpression':
      return { k: 'call', callee: chainOf(n.callee), args: n.arguments.map((a) => valueOf(a, depth + 1, sc)) };
    case 'NewExpression': return { k: 'new', callee: chainOf(n.callee) };
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return fnSummary(n, depth, sc);
    default: return { k: 'expr' };
  }
}

/**
 * What a spread in a list may put there: the list it spreads when that is
 * written out, each branch's when a condition picks one (`...(on ? [A] : [])`),
 * else the value it spreads as it is, which a reader cannot list.
 */
function spreadLeaves(node, depth, sc) {
  const n = unwrap(node);
  if (n && n.type === 'ConditionalExpression' && depth <= MAX_DEPTH) return [...spreadLeaves(n.consequent, depth + 1, sc), ...spreadLeaves(n.alternate, depth + 1, sc)];
  return [valueOf(n, depth, sc)];
}

/**
 * A function written as a value: the names its parameters go by (null for a
 * destructured one) and the lines it spans, so a call written inside it can be
 * told apart from one beside it; and, for an arrow with an expression body,
 * what it returns (`forwardRef(() => UsersModule)` names the module there).
 * With `sc`, where each named parameter is declared (`paramsAt`), so a call
 * inside can be told to be on that parameter and not on a name that shadows it.
 */
function fnSummary(n, depth, sc) {
  const returns = n.type === 'ArrowFunctionExpression' && n.body.type !== 'BlockStatement' ? { returns: valueOf(n.body, depth + 1, sc) } : {};
  const at = sc ? n.params.map((p) => { const id = paramId(p); return id ? sc.local(id)?.at ?? null : null; }) : [];
  return { k: 'fn', params: paramsOf(n).map((p) => p.name), ...(at.some(Boolean) ? { paramsAt: at } : {}), line: lineOf(n), endLine: endLineOf(n), ...returns };
}

/**
 * `{[name]: place}` for an identifier that is a local, else nothing; with
 * `{[flag]: true}` when it is written again, and `{[onceFlag]: true}` when that
 * one write is all it is ever given (declared with no value, written once).
 */
function localField(sc, id, name, flag, onceFlag = null) {
  const b = sc && id ? sc.local(id) : null;
  return b ? { [name]: b.at, ...(b.reassigned ? { [flag]: true } : {}), ...(b.once && onceFlag ? { [onceFlag]: true } : {}) } : {};
}

/** A type annotation's name: `Foo` or `ns.Foo` for a type reference, null for anything else. */
export function typeNameOf(annotation) {
  const t = annotation && annotation.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : annotation;
  if (!t || t.type !== 'TSTypeReference') return null;
  const name = (n) => (n.type === 'Identifier' ? n.name : n.type === 'TSQualifiedName' ? `${name(n.left)}.${n.right.name}` : null);
  return name(t.typeName);
}

/**
 * The type arguments a type reference writes, each by its name as typeNameOf
 * reads one (null for one that is not a plain reference): `Repository<User>`
 * gives ['User']. An empty list when it writes none.
 */
export function typeArgsOf(annotation) {
  const t = annotation && annotation.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : annotation;
  const inst = t && t.type === 'TSTypeReference' ? (t.typeParameters ?? t.typeArguments) : t && t.type === 'TSTypeParameterInstantiation' ? t : null;
  return inst ? inst.params.map((p) => typeNameOf(p)) : [];
}

/** `{typeArgs}` when a type annotation writes any, else nothing: a record without them stays as it was. */
const typeArgsField = (annotation) => {
  const args = typeArgsOf(annotation);
  return args.length > 0 ? { typeArgs: args } : {};
};

function decoratorsOf(node) {
  return (node.decorators ?? []).map((d) => {
    const e = d.expression;
    if (e.type === 'CallExpression') return { name: chainOf(e.callee), args: e.arguments.map((a) => valueOf(a)) };
    return { name: chainOf(e), args: [] };
  }).filter((d) => d.name !== null);
}

const lineOf = (n) => (n.loc ? n.loc.start.line : null);
const endLineOf = (n) => (n.loc ? n.loc.end.line : null);

/** What one `return` hands back: a call by its callee and line, a name (with the local it is) or member chain as written, an object literal whole, else only an expression. */
function returnedValue(node, sc) {
  const n = unwrap(node);
  if (!n) return { k: 'none' };
  if (n.type === 'Identifier' && sc) return valueOf(n, 0, sc);
  // An options factory (`createTypeOrmOptions() { return {...} }`) is read by its keys.
  if (n.type === 'ObjectExpression') return valueOf(n);
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    const callee = chainOf(n.callee);
    return callee ? { k: 'call', callee, line: lineOf(n) } : { k: 'expr' };
  }
  const chain = n.type === 'Identifier' || n.type === 'MemberExpression' || n.type === 'ThisExpression' ? chainOf(n) : null;
  return chain ? { k: n.type === 'Identifier' ? 'id' : 'member', v: chain } : { k: 'expr' };
}

/**
 * What a method hands back, one entry per `return` of its own (one in a
 * function nested in it returns from that function, not from this one), and
 * `{k: 'none'}` when its body may end without a return. Empty when it never
 * returns a value, so a caller can tell "returns this, and only this" from a
 * guess.
 */
function returnsOf(fn, sc) {
  const body = fn.body;
  if (!body || body.type !== 'BlockStatement') return [];
  const out = [];
  const visit = (node) => {
    if (isFunctionNode(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return;
    if (node.type === 'ReturnStatement') out.push(returnedValue(node.argument, sc));
    eachChild(node, visit);
  };
  eachChild(body, visit);
  const last = body.body[body.body.length - 1];
  if (out.length > 0 && !(last && (last.type === 'ReturnStatement' || last.type === 'ThrowStatement'))) out.push({ k: 'none' });
  return out;
}

// ---------------------------------------------------------------------------
// one file
// ---------------------------------------------------------------------------

function importRecord(file, node) {
  const rec = { kind: 'import', file, source: node.source.value, names: [], typeOnly: node.importKind === 'type', line: lineOf(node) };
  for (const s of node.specifiers) {
    if (s.type === 'ImportDefaultSpecifier') rec.default = s.local.name;
    else if (s.type === 'ImportNamespaceSpecifier') rec.namespace = s.local.name;
    else rec.names.push({ imported: keyName({ key: s.imported }) ?? s.imported.name, local: s.local.name });
  }
  return rec;
}

function exportRecords(file, node) {
  const source = node.source ? node.source.value : null;
  if (node.type === 'ExportAllDeclaration') return [{ kind: 'export', file, all: true, source, line: lineOf(node) }];
  return (node.specifiers ?? []).map((s) => ({
    kind: 'export', file, name: s.exported.name ?? s.exported.value, local: s.local ? s.local.name : null,
    ...(source ? { source } : {}), line: lineOf(node),
  }));
}

/** A parameter's own identifier node, or null for a destructured one. */
function paramId(p) {
  const inner = p.type === 'TSParameterProperty' ? p.parameter : p;
  const id = inner.type === 'AssignmentPattern' ? inner.left : inner;
  return id.type === 'Identifier' ? id : null;
}

function paramsOf(fn) {
  return fn.params.map((p) => {
    const inner = p.type === 'TSParameterProperty' ? p.parameter : p;
    const id = inner.type === 'AssignmentPattern' ? inner.left : inner;
    return { name: id.type === 'Identifier' ? id.name : null, type: typeNameOf(id.typeAnnotation), ...typeArgsField(id.typeAnnotation), decorators: decoratorsOf(p) };
  });
}

/**
 * What a class extends when it is a call (`extends Loud(Base)`, a mixin
 * applied): the function and what it is handed, which only the bridge can
 * follow into the class the function returns.
 */
function extendsCallOf(superClass, sc) {
  const n = unwrap(superClass);
  return n && n.type === 'CallExpression' ? { extendsCall: { callee: chainOf(n.callee), args: n.arguments.map((a) => valueOf(a, 0, sc)) } } : {};
}

/**
 * What a class's extends is when the bridge cannot take it for a class by its
 * name: an expression that is neither a name nor a call (`extends (on ? A :
 * B)`), or a name the file itself gives a value that is not a class (`const B
 * = makeBase(); class X extends B`). The bridge then does not know which class
 * it extends. A name the file does not declare is an import, or a global.
 */
function extendsKindOf(superClass, sc) {
  const n = unwrap(superClass);
  if (!n || n.type === 'CallExpression') return {};
  if (chainOf(n) === null) return { extendsExpr: true };
  const head = rootIdentifier(n);
  const b = head && sc ? sc.binding(head) : null;
  return b && b.kind !== 'class' ? { extendsBound: true } : {};
}

/** The name a class's extends is written with; a class declared nested in a function goes by the name its records have. */
function superNameOf(superClass, sc, names) {
  const n = unwrap(superClass);
  const at = n && n.type === 'Identifier' && sc ? sc.local(n)?.at : null;
  return (at && names.localAt?.get(at)) ?? chainOf(superClass);
}

/** Whether a class has a member whose name is computed from a value (`[key]() {}`), which may be any name; `[Symbol.iterator]` is not one. */
const hasComputedMembers = (node) => node.body.body.some((m) => m.computed && keyName(m) === null
  && !(isMember(m.key) && m.key.object.type === 'Identifier' && m.key.object.name === 'Symbol'));

/** A class, and its members, by the name `names` gives it (a mixin's is `Loud()`, a nested one's `Local$12`). */
function classRecords(file, node, exported, emit, sc, names) {
  const info = names.get(node) ?? { name: node.id ? node.id.name : 'default' };
  const mixin = info.mixin ?? null;
  // A mixin's class extends what its function is handed, not a name of the file.
  const ownSuper = node.superClass && !(mixin && mixin.param !== null);
  emit({
    kind: 'class', file, name: info.name, exported, decorators: decoratorsOf(node),
    extends: ownSuper ? superNameOf(node.superClass, sc, names) : null,
    ...(node.superClass && node.superTypeParameters ? { extendsArgs: typeArgsOf(node.superTypeParameters) } : {}),
    ...(node.superClass ? extendsCallOf(node.superClass, sc) : {}),
    ...(ownSuper ? extendsKindOf(node.superClass, sc) : {}),
    ...(mixin ? { mixinOf: mixin.of, ...(mixin.param !== null ? { mixinParam: mixin.param } : {}) } : {}),
    ...(info.local ? { local: true } : {}),
    ...(hasComputedMembers(node) ? { computedMembers: true } : {}),
    implements: (node.implements ?? []).map((i) => chainOf(i.expression)).filter(Boolean),
    line: lineOf(node), endLine: endLineOf(node),
  });
  for (const m of node.body.body) memberRecords(file, info.name, m, emit, sc);
}

/** Whether a value is `this.<name>.bind(this)`: the method of that name, bound, which changes nothing it runs. */
function bindsSelf(value, name) {
  const v = unwrap(value);
  if (!isCall(v) || !isMember(v.callee) || memberName(v.callee) !== 'bind' || v.arguments[0]?.type !== 'ThisExpression') return false;
  const target = unwrap(v.callee.object);
  return isMember(target) && target.object.type === 'ThisExpression' && memberName(target) === name;
}

function memberRecords(file, name, m, emit, sc) {
  const key = keyName(m);
  if (m.type === 'ClassMethod' && m.kind === 'constructor') {
    m.params.forEach((p, index) => {
      if (p.type !== 'TSParameterProperty') return;
      const id = p.parameter.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
      emit({ kind: 'ctorParam', file, class: name, index, name: id.name, type: typeNameOf(id.typeAnnotation), ...typeArgsField(id.typeAnnotation), decorators: decoratorsOf(p), line: lineOf(p) });
    });
  } else if (m.type === 'ClassMethod' && key !== null) {
    const returns = returnsOf(m, sc);
    emit({
      kind: 'method', file, class: name, name: key, static: m.static === true, decorators: decoratorsOf(m),
      params: paramsOf(m), ...(returns.length > 0 ? { returns } : {}), line: lineOf(m), endLine: endLineOf(m),
    });
  } else if (m.type === 'ClassProperty' && key !== null) {
    // A property holding a function is set on each object, over any method of that name.
    const fn = isFunctionNode(unwrap(m.value)) ? { fn: true } : {};
    const self = bindsSelf(m.value, key) ? { bindsSelf: true } : {};
    emit({ kind: 'property', file, class: name, name: key, static: m.static === true, type: typeNameOf(m.typeAnnotation), ...typeArgsField(m.typeAnnotation), ...fn, ...self, decorators: decoratorsOf(m), line: lineOf(m) });
  }
}

/** The parts of a statement or an expression that may not run when it does. */
const MAY_NOT_RUN = Object.freeze({
  IfStatement: ['consequent', 'alternate'],
  ConditionalExpression: ['consequent', 'alternate'],
  LogicalExpression: ['right'],
  SwitchStatement: ['cases'],
  ForStatement: ['test', 'update', 'body'],
  ForInStatement: ['body'],
  ForOfStatement: ['body'],
  WhileStatement: ['test', 'body'],
  DoWhileStatement: ['body'],
  TryStatement: ['handler'],
});

const isMember = (n) => n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression');
const isCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression');

/** A member's name as written: `x.y` is y, `x['y']` is y, anything else is `*`. */
function memberName(n) {
  if (!n.computed && n.property.type === 'Identifier') return n.property.name;
  return n.property.type === 'StringLiteral' ? n.property.value : '*';
}

/**
 * The calls chained on a first call's result, when `outer` is the last of
 * them: `{base, steps}`, each step the member path written after the call
 * before it (`where`, or `manager.find`), its arguments and its line. Null
 * when the chain does not start at a call whose receiver is a name.
 */
function chainFrom(outer, sc) {
  const steps = [];
  for (let cur = outer; ;) {
    let obj = unwrap(cur.callee);
    if (!isMember(obj)) return null;
    const path = [];
    for (; isMember(obj); obj = unwrap(obj.object)) path.unshift(memberName(obj));
    steps.unshift({ name: path.join('.'), args: cur.arguments.map((a) => valueOf(a, 0, sc)), line: lineOf(cur) });
    if (!isCall(obj)) return null;
    if (chainOf(obj.callee) !== null) return { base: obj, steps };
    cur = obj;
  }
}

/** The outermost call of a chain is met first: it names every step, and a call inside it names fewer. */
function noteChain(node, chains, holders, sc) {
  const hit = chainFrom(node, sc);
  if (!hit || chains.has(hit.base)) return;
  const holder = holders.get(node);
  chains.set(hit.base, { steps: hit.steps, ...(holder ? { holder: holder.name, holderId: holder } : {}) });
}

/** The identifier a callee's member chain starts at (`x` of `x.user.findMany`), or null when it starts at anything else. */
function rootIdentifier(callee) {
  let cur = unwrap(callee);
  while (isMember(cur)) cur = cur.object;
  return cur && cur.type === 'Identifier' ? cur : null;
}

/**
 * One call. `rootAt` is where the local its receiver starts at is declared,
 * `holderAt` where the local it is held in is, and `chainHolderAt` where the
 * local the result of its chain is held in is, each with a flag when that
 * local is written again anywhere it is in scope: the same name in two blocks is
 * two locals, and a name assigned again may hold anything at the call.
 */
function callRecord(file, node, { here, callee, n, cond, holder, chain, branch }, sc) {
  return {
    kind: 'call', file, in: here, callee, args: node.arguments.map((a) => valueOf(a, 0, sc)), staticArgs: node.arguments.map((a) => staticValue(a, sc)), n,
    ...(holder ? { holder: holder.name } : {}), ...(cond ? { cond: true } : {}),
    ...(chain ? { chain: chain.steps, ...(chain.holder ? { chainHolder: chain.holder } : {}) } : {}),
    line: lineOf(node),
    ...localField(sc, rootIdentifier(node.callee), 'rootAt', 'rootReassigned', 'rootOnce'),
    ...localField(sc, holder, 'holderAt', 'holderReassigned', 'holderOnce'),
    ...localField(sc, chain?.holderId, 'chainHolderAt', 'chainHolderReassigned', 'chainHolderOnce'),
    ...(branch ? { holderBranch: true } : {}),
  };
}

/**
 * The name a value is held in: a declaration's (`const r = …`) or an
 * assignment's (`r = …`); each branch of a condition (`c ? a() : b()`) is held
 * in it only if that branch runs.
 */
function noteHolders(node, holders, branchHeld) {
  let id = null;
  let value = null;
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) [id, value] = [node.id, node.init];
  else if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier') [id, value] = [node.left, node.right];
  if (!id) return;
  const v = unwrap(value);
  if (v && v.type === 'ConditionalExpression') {
    for (const b of [unwrap(v.consequent), unwrap(v.alternate)]) { holders.set(b, id); branchHeld.add(b); }
    return;
  }
  holders.set(v, id);
}

const isValueCall = (n) => n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression');

/**
 * A local given a name, a member chain or a condition's branches, not a call
 * (a call says what holds it itself): `{kind: 'bind'}`, with where the local is
 * declared, or `name: null` when a local's value goes somewhere else (`this.x =
 * qb`). Only what a later reading can follow is told: a local's value, a chain
 * off `this`, a branch that is a call.
 */
function bindRecord(file, here, node, cond, sc) {
  let target = null;
  let value = null;
  if (node.type === 'VariableDeclarator' && node.init) [target, value] = [node.id, node.init];
  else if (node.type === 'AssignmentExpression' && node.operator === '=') [target, value] = [node.left, node.right];
  if (target && target.type === 'ObjectPattern') return destructureBinds(file, here, target, value, cond, sc);
  const v = unwrap(value);
  if (!v || isValueCall(v) || isFunctionNode(v)) return [];
  // One of several values: a condition's branch, or a side of `||`, `??` or `&&`.
  const leaves = choiceLeaves(v);
  const branch = leaves.length > 1;
  const values = leaves.map((x) => valueOf(x, 0, sc));
  const local = target && target.type === 'Identifier' ? localField(sc, target, 'at', 'reassigned', 'once') : {};
  const followed = (x) => (x.k === 'id' && x.at) || (local.at && ((x.k === 'member' && x.v.startsWith('this.')) || (branch && x.k === 'call')));
  if (!values.some(followed)) return [];
  return [{
    kind: 'bind', file, in: here, name: local.at ? target.name : null, values, ...(branch ? { branch: true } : {}), ...(cond ? { cond: true } : {}),
    line: lineOf(v), ...local,
  }];
}

/** The values an expression may be: each branch of a condition and each side of `||`, `??` and `&&`, or itself. */
function choiceLeaves(node, depth = 0) {
  const n = unwrap(node);
  if (depth < 4 && n && n.type === 'ConditionalExpression') return [...choiceLeaves(n.consequent, depth + 1), ...choiceLeaves(n.alternate, depth + 1)];
  if (depth < 4 && n && n.type === 'LogicalExpression') return [...choiceLeaves(n.left, depth + 1), ...choiceLeaves(n.right, depth + 1)];
  return [n];
}

/**
 * The locals `const { users, roles: r } = this` gives: each a bind of the
 * member it takes (`this.users`), when the object is `this` or a member chain;
 * a default (`{ users = other }`) is one more value it may hold.
 */
function destructureBinds(file, here, pattern, value, cond, sc) {
  const v = unwrap(value);
  const base = v && v.type === 'ThisExpression' ? 'this' : chainOf(v);
  if (!base) return [];
  return pattern.properties.flatMap((p) => {
    const key = p.type === 'ObjectProperty' ? keyName(p) : null;
    const target = p.type === 'ObjectProperty' ? (p.value.type === 'AssignmentPattern' ? p.value.left : p.value) : null;
    const local = key !== null && target?.type === 'Identifier' ? localField(sc, target, 'at', 'reassigned', 'once') : {};
    if (!local.at) return [];
    const values = [{ k: 'member', v: `${base}.${key}` }, ...(p.value.type === 'AssignmentPattern' ? [valueOf(p.value.right, 0, sc)] : [])];
    return [{ kind: 'bind', file, in: here, name: target.name, values, ...(values.length > 1 ? { branch: true } : {}), ...(cond ? { cond: true } : {}), line: lineOf(p), ...local }];
  });
}

/** The calls that write members of an object handed first: `Object.assign(this, …)` may write any; `defineProperty` the one its second argument names. */
const MEMBER_WRITERS = Object.freeze({ 'Object.assign': null, 'Object.defineProperty': 1, 'Object.defineProperties': null, 'Reflect.set': 1, 'Reflect.defineProperty': 1 });

/** What a write lands on: `this` (a member of the class it is written in), or `X.prototype`; null for anything else. */
function writtenOn(obj, where) {
  const o = unwrap(obj);
  if (o && o.type === 'ThisExpression') return where && where.includes('.') ? { on: 'this', class: where.slice(0, where.indexOf('.')) } : null;
  const of = isMember(o) && memberName(o) === 'prototype' ? chainOf(o.object) : null;
  return of ? { on: 'prototype', of } : null;
}

/**
 * A member of an object written where a method of that name may be: `this.x =
 * …` in a class, `X.prototype.x = …`, `Object.assign(this, …)`. Each is a
 * `write` record with the name (null when any name may be written) and
 * whether it is only `this.x.bind(this)`, which runs the same method. A method
 * the bridge would take for the one `this.x()` runs may be replaced there.
 */
function writeRecords(file, where, node) {
  if (node.type === 'AssignmentExpression' && isMember(node.left)) {
    const at = writtenOn(node.left.object, where);
    const name = memberName(node.left);
    const n = name === '*' ? null : name;
    return at ? [{ kind: 'write', file, ...at, name: n, ...(n && bindsSelf(node.right, n) ? { bindsSelf: true } : {}), line: lineOf(node) }] : [];
  }
  const callee = isCall(node) ? chainOf(node.callee) : null;
  if (callee === null || !Object.hasOwn(MEMBER_WRITERS, callee)) return [];
  const at = writtenOn(node.arguments[0], where);
  const keyArg = MEMBER_WRITERS[callee] === null ? null : node.arguments[MEMBER_WRITERS[callee]];
  return at ? [{ kind: 'write', file, ...at, name: keyArg?.type === 'StringLiteral' ? keyArg.value : null, line: lineOf(node) }] : [];
}

/** A `const` that holds a literal: its name, its value, and where it is declared when it is a local. */
function constRecords(file, node, sc) {
  if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return [];
  return node.declarations.flatMap((d) => {
    if (d.id.type !== 'Identifier' || !d.init) return [];
    const value = valueOf(d.init, 0, sc);
    return ['str', 'num', 'bool'].includes(value.k) ? [{ kind: 'const', file, name: d.id.name, value, line: lineOf(d), ...localField(sc, d.id, 'at', 'reassigned') }] : [];
  });
}

/**
 * Every call in the file, each with the member or function it is written in,
 * and its place among that member's calls. The place is what an id is built on,
 * so a blank line or a comment added above it changes nothing. A decorator is
 * not a call its member makes: it runs once, when the class is defined, and
 * is recorded on the class, method or parameter it decorates.
 *
 * A call that may not run when its member does is marked `cond`: one in a
 * branch, a loop or a catch block, or in a function nested in the member, which
 * runs when, and if, whatever it is handed to calls it.
 *
 * A call made on another call's result, `repo.createQueryBuilder('u').where(…)
 * .getMany()`, has no receiver chain of its own: it is recorded as a step of
 * the `chain` of the first call, the one whose receiver is a name, with the
 * name the whole expression is held in as `chainHolder`. A `new` is a record of
 * its own and takes no place among the calls.
 */
function walkCalls(file, ast, emit, sc, names = new Map()) {
  const counters = new Map();
  // The name each initializer is held in (`const app = await …` holds the call under the await).
  const holders = new Map();
  // The first call of a chain -> the calls made on its result, read from the outermost call down.
  const chains = new Map();
  // The calls held only if a condition's branch that makes them runs (`r = c ? a() : b()`).
  const branchHeld = new Set();
  // `root` is the function that IS the member, so it is not taken for one nested in it.
  const visit = (node, where, root, cond) => {
    if (node.type === 'Decorator') return;
    noteHolders(node, holders, branchHeld);
    const told = [...bindRecord(file, where, node, cond, sc), ...constRecords(file, node, sc), ...writeRecords(file, where, node)];
    for (const r of told) emit(r);
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      // A class goes by the name its records give it: a mixin's by its function, a nested one by its line.
      const cls = names.get(node)?.name ?? (node.id ? node.id.name : 'default');
      for (const m of node.body.body) {
        const member = keyName(m);
        const w = member === null ? `${cls}.<computed>` : `${cls}.${m.kind === 'constructor' ? 'constructor' : member}`;
        const body = m.type === 'ClassProperty' && isFunctionNode(unwrap(m.value)) ? unwrap(m.value) : null;
        eachChild(m, (c) => visit(c, w, body, false));
      }
      return;
    }
    let [here, top, mayNotRun] = [where, root, cond];
    if (node.type === 'FunctionDeclaration' && node.id && where === null) [here, top] = [node.id.name, node];
    if (node.type === 'VariableDeclarator' && where === null && node.id.type === 'Identifier' && isFunctionNode(unwrap(node.init))) [here, top] = [node.id.name, unwrap(node.init)];
    if (isFunctionNode(node) && node !== top) mayNotRun = true;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = chainOf(node.callee);
      if (callee !== null) {
        const n = counters.get(here) ?? 0;
        counters.set(here, n + 1);
        emit(callRecord(file, node, { here, callee, n, cond: mayNotRun, holder: holders.get(node), chain: chains.get(node), branch: branchHeld.has(node) }, sc));
      } else {
        noteChain(node, chains, holders, sc);
      }
    }
    if (node.type === 'NewExpression') {
      const callee = chainOf(node.callee);
      const holder = holders.get(node);
      // `rootAt`: a class held in a local (`const C = UsersService; new C()`) is not the class its name spells.
      // A module-level name written again may hold something else wherever it is read (`holderModuleWritten`).
      if (callee !== null) {
        const moduleWritten = holder && !sc.local(holder) && sc.binding(holder)?.reassigned ? { holderModuleWritten: true } : {};
        emit({
          kind: 'new', file, in: here, callee, args: node.arguments.map((a) => valueOf(a, 0, sc)), ...localField(sc, rootIdentifier(node.callee), 'rootAt', 'rootReassigned'),
          ...(holder ? { holder: holder.name, ...localField(sc, holder, 'holderAt', 'holderReassigned', 'holderOnce'), ...moduleWritten } : {}), ...(mayNotRun ? { cond: true } : {}), line: lineOf(node),
        });
      }
    }
    const branches = MAY_NOT_RUN[node.type] ?? [];
    eachChild(node, (c, key) => visit(c, here, top, mayNotRun || branches.includes(key)));
  };
  visit(ast.program, null, null, false);
}

/** The name an interface's `extends` entry is written with: `A`, or `ns.A`. */
function heritageName(h) {
  const e = h.expression;
  if (e.type === 'Identifier') return e.name;
  return e.type === 'TSQualifiedName' && e.left.type === 'Identifier' ? `${e.left.name}.${e.right.name}` : null;
}

/**
 * An interface, with the interfaces it extends. It has no code: a call through
 * a value of its type runs a method of a class that implements it.
 */
function interfaceRecord(file, node, exported) {
  return { kind: 'interface', file, name: node.id.name, exported, extends: (node.extends ?? []).map(heritageName).filter(Boolean), line: lineOf(node) };
}

/**
 * A module function, with the names its parameters go by (null for a
 * destructured one), and `reassigned` when the file writes its name again
 * (`let f = () => 1; f = other`): a call of it may then run something else.
 */
function functionRecord(file, name, fn, exported, at, sc) {
  const reassigned = at.id && sc?.binding(at.id)?.reassigned ? { reassigned: true } : {};
  return { kind: 'function', file, name, exported, params: paramsOf(fn).map((p) => p.name), ...reassigned, line: lineOf(at) };
}

/**
 * The one class expression a module function returns, a mixin: `function
 * Loud(B) { return class extends B {...} }` or `const Loud = (B) => class
 * extends B {...}`, with the parameter it extends. None when it returns two.
 */
function mixinClassOf(fn) {
  const body = fn.body;
  const found = [];
  if (body && body.type !== 'BlockStatement') {
    if (unwrap(body)?.type === 'ClassExpression') found.push(unwrap(body));
  } else if (body) {
    const visit = (node) => {
      if (isFunctionNode(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return;
      if (node.type === 'ReturnStatement' && unwrap(node.argument)?.type === 'ClassExpression') found.push(unwrap(node.argument));
      eachChild(node, visit);
    };
    eachChild(body, visit);
  }
  if (found.length !== 1) return null;
  const params = paramsOf(fn).map((p) => p.name);
  const sup = unwrap(found[0].superClass);
  return { node: found[0], param: sup && sup.type === 'Identifier' && params.includes(sup.name) ? params.indexOf(sup.name) : null };
}

/** A module function, and the class it returns when it is a mixin, named `<function>()` (nameClasses found it). */
function functionRecords(file, name, fn, exported, at, emit, sc, names) {
  emit(functionRecord(file, name, fn, exported, at, sc));
  const mixin = names.mixins?.get(fn);
  if (mixin) classRecords(file, mixin, false, emit, sc, names);
}

/** The classes a module-level statement declares, into `names`: a class, one a `const` holds, a mixin a function returns. */
function topLevelClassNames(stmt, names) {
  const exported = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration';
  const decl = exported ? stmt.declaration : stmt;
  const mixin = (fnName, fn) => {
    const m = mixinClassOf(fn);
    if (m) { names.set(m.node, { name: `${fnName}()`, mixin: { of: fnName, param: m.param } }); names.mixins.set(fn, m.node); }
  };
  if (!decl) return;
  if (decl.type === 'ClassDeclaration') names.set(decl, { name: decl.id ? decl.id.name : 'default' });
  else if (decl.type === 'FunctionDeclaration' && decl.id) mixin(decl.id.name, decl);
  else if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations) {
      const init = d.id.type === 'Identifier' ? unwrap(d.init) : null;
      if (isFunctionNode(init)) mixin(d.id.name, init);
      else if (init && init.type === 'ClassExpression' && decl.kind === 'const') names.set(init, { name: d.id.name, held: true });
    }
  }
}

/**
 * The name every class of the file is recorded under: one at module level by
 * its own (`default` for an anonymous default export), one a module `const`
 * holds by the const's (`const Sub = class extends Base {}`), a mixin's by its
 * function's (`Loud()`), and any other, nested in a function or written in an
 * expression, by its name or `class` and its line (`Local$12`), marked
 * `local`. `localAt` maps where a nested class declaration is declared to its
 * name, so a class that extends it by that name is read as extending it.
 */
function nameClasses(ast, sc) {
  const names = new Map();
  names.mixins = new Map();
  names.localAt = new Map();
  for (const stmt of ast.program.body) topLevelClassNames(stmt, names);
  const taken = new Set([...names.values()].map((n) => n.name));
  const visit = (node) => {
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && !names.has(node)) {
      const base = `${node.id ? node.id.name : 'class'}$${lineOf(node)}`;
      let name = base;
      for (let i = 2; taken.has(name); i += 1) name = `${base}_${i}`;
      taken.add(name);
      names.set(node, { name, local: true });
      const at = node.type === 'ClassDeclaration' && node.id ? sc.local(node.id)?.at : null;
      if (at) names.localAt.set(at, name);
    }
    eachChild(node, visit);
  };
  eachChild(ast.program, visit);
  return names;
}

/** The records of every class `nameClasses` found that no module-level statement declares. */
function localClassRecords(file, emit, sc, names) {
  for (const [node, info] of names) if (info.local) classRecords(file, node, false, emit, sc, names);
}

/**
 * A module constant that names another value, one or another (`const m =
 * isDocument ? DocumentModule : RelationalModule`): what it may hold, as the
 * worker reads a value. A module list that names the constant lists those.
 */
function aliasRecord(file, d, exported) {
  const leaves = [];
  const gather = (n, depth) => {
    const x = unwrap(n);
    if (x && x.type === 'ConditionalExpression' && depth < 4) { gather(x.consequent, depth + 1); gather(x.alternate, depth + 1); } else leaves.push(valueOf(x));
  };
  const top = unwrap(d.init);
  if (!top || (top.type !== 'Identifier' && top.type !== 'ConditionalExpression')) return null;
  gather(top, 0);
  return { kind: 'alias', file, name: d.id.name, exported, values: leaves, line: lineOf(d) };
}

function declarationRecords(file, ast, emit, sc, names) {
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration') { emit(importRecord(file, stmt)); continue; }
    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration)) {
      for (const r of exportRecords(file, stmt)) emit(r);
      continue;
    }
    const exported = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration';
    const decl = exported ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === 'ClassDeclaration') classRecords(file, decl, exported, emit, sc, names);
    else if (decl.type === 'TSInterfaceDeclaration') emit(interfaceRecord(file, decl, exported));
    else if (decl.type === 'FunctionDeclaration' && decl.id) functionRecords(file, decl.id.name, decl, exported, decl, emit, sc, names);
    else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue;
        if (isFunctionNode(unwrap(d.init))) functionRecords(file, d.id.name, unwrap(d.init), exported, d, emit, sc, names);
        else if (names.get(unwrap(d.init))?.held) classRecords(file, unwrap(d.init), exported, emit, sc, names);
        else if (decl.kind === 'const') {
          const alias = aliasRecord(file, d, exported);
          if (alias) emit(alias);
        }
      }
    }
  }
}

/** One TypeScript expression's value, read on its own (a rule example's argument). */
export function valueOfSource(text) {
  return valueOf(babel.parseExpression(text, { plugins: ['typescript'] }));
}

export function factsOfFile(file, code) {
  const out = [];
  let ast;
  try {
    ast = babel.parse(code, { sourceType: 'module', errorRecovery: true, plugins: ['typescript', 'decorators-legacy'] });
  } catch (e) {
    return [{ kind: 'parse_error', file, message: String(e.message).split('\n')[0] }];
  }
  const emit = (r) => out.push(r);
  // That the file was read, whatever it holds: a file of constants and types
  // alone is still a file of the project, not a package.
  const sc = readScopes(ast);
  emit({ kind: 'file', file });
  emit({ kind: 'static-context', file, staticFacts: staticFacts(ast, sc) });
  const names = nameClasses(ast, sc);
  declarationRecords(file, ast, emit, sc, names);
  localClassRecords(file, emit, sc, names);
  walkCalls(file, ast, emit, sc, names);
  for (const r of useRecords(file, ast, sc)) emit(r);
  for (const e of ast.errors ?? []) out.push({ kind: 'parse_error', file, message: String(e.message).split('\n')[0], recovered: true });
  return out;
}

// ---------------------------------------------------------------------------
// command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let root = null;
  let list = false;
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { root = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '--list') { list = true; continue; }
    // One target per line: an incremental run can name more files than a command line holds.
    if (argv[i] === '--files-from') { targets.push(...fs.readFileSync(argv[i + 1], 'utf8').split('\n').filter(Boolean)); i += 1; continue; }
    targets.push(argv[i]);
  }
  if (root === null || targets.length === 0) {
    process.stderr.write('usage: node adapters/ts/tsfacts.mjs [--list] --root <abs root> (<abs dir or file>... | --files-from <list>)\n');
    process.exit(2);
  }
  return { root: path.resolve(root), targets: targets.map((t) => path.resolve(t)), list };
}

function main(argv) {
  const { root, targets, list } = parseArgs(argv);
  const files = sourceFiles(targets);
  const rel = (f) => toPosix(path.relative(root, f));
  const write = (r) => process.stdout.write(`${JSON.stringify(r)}\n`);
  write({ kind: 'header', schema: SCHEMA, version: VERSION });
  if (list) {
    for (const f of files) write({ kind: 'sourceFile', file: rel(f) });
    return;
  }
  let parseErrors = 0;
  for (const f of files) {
    for (const r of factsOfFile(rel(f), fs.readFileSync(f, 'utf8'))) {
      if (r.kind === 'parse_error') parseErrors += 1;
      write(r);
    }
  }
  write({ kind: 'summary', version: VERSION, files: files.length, parseErrors });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2));
