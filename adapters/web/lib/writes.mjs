// writes.mjs — what a named function does to the objects it could hand on.
//
// WHAT THIS MODULE OWNS. `origins.mjs` says which part of a parameter a name
// holds; that settles what a call hands on only while nothing changes the
// object in between (review 3, R2). `const cfg = { ...option }; cfg.url =
// '/other'` hands on a copy whose `url` is not the caller's, `delete cfg.url`
// hands on one with none, and `transform(cfg)` hands it to code this file
// may not show. So each named function is read once for the WRITES it makes
// through a name: a member assignment (`cfg.url = …`, `cfg.headers.x = …`),
// `delete`, `++`, `Object.assign(cfg, …)`, and every call the name is handed
// to. A hand whose object is written under the key the URL (or the method, or
// the base URL) is under does not settle that key.
//
// A write that runs on every path through the function (not under an `if`, a
// loop, a `&&`, a callback) and puts a string there is also a VALUE: `cfg.method
// = 'POST'` says what the request is sent with (review 3, R1).
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files.

import { bare, eachChild, keyName } from './ast.mjs';

/** Nodes under which a statement may or may not run. */
const BRANCHING = new Set([
  'IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'TryStatement', 'CatchClause',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod',
]);

/** The name a member expression is rooted at, the key right under it, and how deep the write is. */
function memberRoot(node) {
  let cur = bare(node);
  let key = null;
  let depth = 0;
  for (; depth < 16 && cur && (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression'); depth += 1) {
    const p = cur.property;
    key = !cur.computed && p && p.type === 'Identifier' ? p.name : (p && p.type === 'StringLiteral' ? p.value : '*');
    cur = bare(cur.object);
  }
  return depth > 0 && cur && cur.type === 'Identifier' ? { name: cur.name, key, depth } : null;
}

/** The record for one name, made the first time the name is seen. */
function recordOf(out, name) {
  if (!out.byName.has(name)) out.byName.set(name, { keys: new Map(), handed: [] });
  return out.byName.get(name);
}

/** One write under `key` of what `name` holds: a string when it is one, and whether it runs every time. */
function write(out, root, value, cond) {
  const keys = recordOf(out, root.name).keys;
  const prev = keys.get(root.key);
  keys.set(root.key, { count: (prev ? prev.count : 0) + 1, value: root.depth === 1 ? value : null, cond: cond || (prev ? prev.cond : false) });
}

/** `Object.assign(cfg, { method: 'POST' })` writes those keys; any other source writes keys nobody states. */
function assignWrites(out, call, cond) {
  const target = bare(call.arguments[0]);
  if (!target || target.type !== 'Identifier') return;
  const sources = call.arguments.slice(1).map(bare);
  const literal = sources.every((s) => s && s.type === 'ObjectExpression' && s.properties.every((p) => p.type === 'ObjectProperty' && keyName(p) !== null));
  if (!literal) { write(out, { name: target.name, key: '*', depth: 1 }, null, cond); return; }
  for (const p of sources.flatMap((s) => s.properties)) {
    write(out, { name: target.name, key: keyName(p), depth: 1 }, p.value && p.value.type === 'StringLiteral' ? p.value.value : null, cond);
  }
}

/** `Object.x(…)` and `Reflect.x(…)`: the one that assigns keys is read, the others write keys nobody states. */
function builtinCall(out, call, cond) {
  const c = call.callee;
  if (!c || c.type !== 'MemberExpression' || c.computed || !c.object || c.object.type !== 'Identifier') return false;
  if (c.object.name !== 'Object' && c.object.name !== 'Reflect') return false;
  if (c.object.name === 'Object' && c.property.name === 'assign') assignWrites(out, call, cond);
  else if (/^(define|set|delete)/.test(c.property.name)) {
    const target = bare(call.arguments[0]);
    if (target && target.type === 'Identifier') write(out, { name: target.name, key: '*', depth: 1 }, null, cond);
  }
  return true;
}

/** Every name a call is handed (`f(cfg)`, `f(...cfg)`, `new X(cfg)`): what the callee does with it is not read here. */
function handedTo(out, call) {
  for (const a of call.arguments ?? []) {
    const n = bare(a && a.type === 'SpreadElement' ? a.argument : a);
    if (n && n.type === 'Identifier') recordOf(out, n.name).handed.push(call);
  }
}

/** One node of the function, read for what it writes. */
function readNode(out, n, cond) {
  if (n.type === 'AssignmentExpression') {
    const root = memberRoot(n.left);
    const value = n.operator === '=' && n.right && n.right.type === 'StringLiteral' ? n.right.value : null;
    if (root !== null) write(out, root, value, cond);
    const stored = bare(n.right);
    // `this.last = option`, `conf = option`: the object is kept somewhere this reader does not follow.
    if (stored && stored.type === 'Identifier') recordOf(out, stored.name).handed.push(n);
  } else if (n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) {
    const root = memberRoot(n.argument);
    if (root !== null) write(out, root, null, cond);
  } else if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression') {
    if (!builtinCall(out, n, cond)) handedTo(out, n);
  } else if (n.type === 'VariableDeclaration') {
    // `const o = option` writes what `option` holds; `let conf = option` may hold another object by the next line.
    for (const d of n.declarations) {
      const init = bare(d.init);
      if (d.id.type !== 'Identifier' || !init || init.type !== 'Identifier') continue;
      if (n.kind === 'const') out.aliases.set(d.id.name, init.name);
      else recordOf(out, init.name).handed.push(n);
    }
  }
}

/**
 * THE WRITES OF ONE NAMED FUNCTION, by the name written through, read once
 * when the function's body is entered: for each name, the keys written under
 * it (`*` when the key is not a name) with how many times, the string put
 * there and whether the write may not run; the calls it is handed to; and the
 * `const` aliases (`const o = option`), which write what they alias.
 */
export function writesIn(fnNode) {
  const out = { byName: new Map(), aliases: new Map() };
  const walk = (n, cond) => {
    if (!n || typeof n.type !== 'string') return;
    readNode(out, n, cond);
    const inner = cond || BRANCHING.has(n.type);
    eachChild(n, (c) => walk(c, inner));
  };
  if (fnNode && fnNode.body) walk(fnNode.body, false);
  return out;
}

/** The names that hold the same object as one of `names`: their `const` aliases, followed until none is added. */
function sameObject(writes, names) {
  const group = new Set(names);
  for (let grew = true, i = 0; grew && i < 8; i += 1) {
    grew = false;
    for (const [alias, of] of writes.aliases) {
      if (group.has(of) && !group.has(alias)) { group.add(alias); grew = true; }
    }
  }
  return group;
}

/**
 * WHAT HAS BEEN DONE TO WHAT ONE HAND PASSES ON, at the call `callNode`, from
 * the names it was made from (`names`: the name passed and every name up its
 * origin, lib/origins.mjs): the keys written under any of them (`written`,
 * sorted, `*` for a key that is not a name), whether any was handed to a call
 * other than this one (`handed`), and the keys a write that always runs set
 * to a string (`sets`).
 * @returns {{written:string[], handed:boolean, sets:Map<string,string>}}
 */
export function writtenOf(fn, names, callNode) {
  const out = { written: [], handed: false, sets: new Map() };
  const writes = fn && fn.writes;
  if (!writes) return out;
  const keys = new Map();
  for (const name of sameObject(writes, names)) {
    const r = writes.byName.get(name);
    if (!r) continue;
    for (const [k, v] of r.keys) keys.set(k, keys.has(k) ? { count: keys.get(k).count + v.count, value: null, cond: true } : v);
    if (r.handed.some((n) => n !== callNode)) out.handed = true;
  }
  out.written = [...keys.keys()].sort();
  for (const [k, v] of keys) if (v.count === 1 && !v.cond && typeof v.value === 'string') out.sets.set(k, v.value);
  return out;
}
