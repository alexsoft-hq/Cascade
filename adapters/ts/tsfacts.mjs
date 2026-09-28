#!/usr/bin/env node
// tsfacts.mjs — the TypeScript backend worker: what each .ts file says, read from that file alone.
//
// USAGE
//   node adapters/ts/tsfacts.mjs --root <abs root> (<abs dir or file>... | --files-from <list>)
//   node adapters/ts/tsfacts.mjs --list --root <abs root> <abs dir>...
//
// One JSONL record per line (schema `cascade:tsfacts:1`): a header, then for
// each file, in path order, its imports, exports, classes (with their
// decorators and the type arguments of what they extend), constructor
// parameters, properties, methods (with what they return), module functions,
// every call (its receiver chain, its arguments, the name its value is held in,
// the calls chained on its result, its place among the calls of the member it
// is in, and which local its receiver and its holder are), and every `new`;
// then a summary.
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

const SCHEMA = 'cascade:tsfacts:1';
// 2: a method record carries what each of its own `return`s hands back (`returns`).
// 3: type arguments (`typeArgs`, `extendsArgs`), an object literal a method
//    returns, every `new`, and the calls chained on a call's result (`chain`).
// 4: which local a call's receiver starts at and which it is held in (`rootAt`,
//    `holderAt`, and whether that local is written again), and which local a
//    name or a function parameter among its arguments is (`at`, `paramsAt`).
export const VERSION = 'tsfacts/4';

const require = createRequire(import.meta.url);
// The same vendored parser the web worker reads TypeScript with.
const babel = require('../web/vendor/babel-parser.cjs');

/** Directories no backend source lives in. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.nx', '.angular', 'tmp']);
/** A test is not the application; the Java lane leaves src/test out the same way. */
const TEST_FILE = /\.(spec|test|e2e-spec)\.ts$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e']);

/** How deep an argument is summarized; past it a value is only "something". */
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function isSourceFile(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts') && !TEST_FILE.test(name);
}

function collect(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return; }
  if (stat.isFile()) { if (isSourceFile(target)) out.push(target); return; }
  if (!stat.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(target).sort(); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || TEST_DIRS.has(name) || name.startsWith('.')) continue;
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
    case 'Identifier': return n.name === 'undefined' ? { k: 'undefined' } : { k: 'id', v: n.name, ...localField(sc, n, 'at', 'reassigned') };
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const chain = chainOf(n);
      return chain ? { k: 'member', v: chain } : { k: 'expr' };
    }
    case 'ArrayExpression': {
      const v = n.elements.filter((e) => e && e.type !== 'SpreadElement').map((e) => valueOf(e, depth + 1, sc));
      return { k: 'arr', v, ...(n.elements.some((e) => e && e.type === 'SpreadElement') ? { spread: true } : {}) };
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

/** `{[name]: place}` (and `{[flag]: true}` when it is written again) for an identifier that is a local, else nothing. */
function localField(sc, id, name, flag) {
  const b = sc && id ? sc.local(id) : null;
  return b ? { [name]: b.at, ...(b.reassigned ? { [flag]: true } : {}) } : {};
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

/** What one `return` hands back: a call by its callee and line, a name or member chain as written, an object literal whole, else only an expression. */
function returnedValue(node) {
  const n = unwrap(node);
  if (!n) return { k: 'none' };
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
function returnsOf(fn) {
  const body = fn.body;
  if (!body || body.type !== 'BlockStatement') return [];
  const out = [];
  const visit = (node) => {
    if (isFunctionNode(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return;
    if (node.type === 'ReturnStatement') out.push(returnedValue(node.argument));
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

function classRecords(file, node, exported, emit) {
  const name = node.id ? node.id.name : 'default';
  emit({
    kind: 'class', file, name, exported, decorators: decoratorsOf(node),
    extends: node.superClass ? chainOf(node.superClass) : null,
    ...(node.superClass && node.superTypeParameters ? { extendsArgs: typeArgsOf(node.superTypeParameters) } : {}),
    implements: (node.implements ?? []).map((i) => chainOf(i.expression)).filter(Boolean),
    line: lineOf(node), endLine: endLineOf(node),
  });
  for (const m of node.body.body) memberRecords(file, name, m, emit);
}

function memberRecords(file, name, m, emit) {
  if (m.type === 'ClassMethod' && m.kind === 'constructor') {
    m.params.forEach((p, index) => {
      if (p.type !== 'TSParameterProperty') return;
      const id = p.parameter.type === 'AssignmentPattern' ? p.parameter.left : p.parameter;
      emit({ kind: 'ctorParam', file, class: name, index, name: id.name, type: typeNameOf(id.typeAnnotation), ...typeArgsField(id.typeAnnotation), decorators: decoratorsOf(p), line: lineOf(p) });
    });
  } else if (m.type === 'ClassMethod' && m.key && !m.computed) {
    const returns = returnsOf(m);
    emit({
      kind: 'method', file, class: name, name: keyName(m), static: m.static === true, decorators: decoratorsOf(m),
      params: paramsOf(m), ...(returns.length > 0 ? { returns } : {}), line: lineOf(m), endLine: endLineOf(m),
    });
  } else if (m.type === 'ClassProperty' && m.key && !m.computed) {
    emit({ kind: 'property', file, class: name, name: keyName(m), static: m.static === true, type: typeNameOf(m.typeAnnotation), ...typeArgsField(m.typeAnnotation), decorators: decoratorsOf(m), line: lineOf(m) });
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
  chains.set(hit.base, { steps: hit.steps, ...(holder ? { holder: holder.name } : {}) });
}

/** The identifier a callee's member chain starts at (`x` of `x.user.findMany`), or null when it starts at anything else. */
function rootIdentifier(callee) {
  let cur = unwrap(callee);
  while (isMember(cur)) cur = cur.object;
  return cur && cur.type === 'Identifier' ? cur : null;
}

/**
 * One call. `rootAt` is where the local its receiver starts at is declared,
 * and `holderAt` where the local it is held in is, each with a flag when that
 * local is written again anywhere it is in scope: the same name in two blocks is
 * two locals, and a name assigned again may hold anything at the call.
 */
function callRecord(file, node, { here, callee, n, cond, holder, chain }, sc) {
  return {
    kind: 'call', file, in: here, callee, args: node.arguments.map((a) => valueOf(a, 0, sc)), n,
    ...(holder ? { holder: holder.name } : {}), ...(cond ? { cond: true } : {}),
    ...(chain ? { chain: chain.steps, ...(chain.holder ? { chainHolder: chain.holder } : {}) } : {}),
    line: lineOf(node),
    ...localField(sc, rootIdentifier(node.callee), 'rootAt', 'rootReassigned'),
    ...localField(sc, holder, 'holderAt', 'holderReassigned'),
  };
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
function walkCalls(file, ast, emit, sc) {
  const counters = new Map();
  // The name each initializer is held in (`const app = await …` holds the call under the await).
  const holders = new Map();
  // The first call of a chain -> the calls made on its result, read from the outermost call down.
  const chains = new Map();
  // `root` is the function that IS the member, so it is not taken for one nested in it.
  const visit = (node, where, root, cond) => {
    if (node.type === 'Decorator') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) holders.set(unwrap(node.init), node.id);
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const cls = node.id ? node.id.name : 'default';
      for (const m of node.body.body) {
        const member = m.key && !m.computed ? keyName(m) : null;
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
        emit(callRecord(file, node, { here, callee, n, cond: mayNotRun, holder: holders.get(node), chain: chains.get(node) }, sc));
      } else {
        noteChain(node, chains, holders, sc);
      }
    }
    if (node.type === 'NewExpression') {
      const callee = chainOf(node.callee);
      const holder = holders.get(node);
      if (callee !== null) emit({ kind: 'new', file, in: here, callee, args: node.arguments.map((a) => valueOf(a, 0, sc)), ...(holder ? { holder: holder.name } : {}), ...(mayNotRun ? { cond: true } : {}), line: lineOf(node) });
    }
    const branches = MAY_NOT_RUN[node.type] ?? [];
    eachChild(node, (c, key) => visit(c, here, top, mayNotRun || branches.includes(key)));
  };
  visit(ast.program, null, null, false);
}

/** A module function, with the names its parameters go by (null for a destructured one). */
function functionRecord(file, name, fn, exported, at) {
  return { kind: 'function', file, name, exported, params: paramsOf(fn).map((p) => p.name), line: lineOf(at) };
}

function declarationRecords(file, ast, emit) {
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration') { emit(importRecord(file, stmt)); continue; }
    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration)) {
      for (const r of exportRecords(file, stmt)) emit(r);
      continue;
    }
    const exported = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration';
    const decl = exported ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === 'ClassDeclaration') classRecords(file, decl, exported, emit);
    else if (decl.type === 'FunctionDeclaration' && decl.id) emit(functionRecord(file, decl.id.name, decl, exported, decl));
    else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier' && isFunctionNode(unwrap(d.init))) emit(functionRecord(file, d.id.name, unwrap(d.init), exported, d));
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
  declarationRecords(file, ast, emit);
  walkCalls(file, ast, emit, readScopes(ast));
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
