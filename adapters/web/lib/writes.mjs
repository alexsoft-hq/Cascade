// writes.mjs — what a named function does to the objects it could hand on.
//
// WHAT THIS MODULE OWNS. `origins.mjs` says which part of a parameter a name
// holds; that settles what a call hands on only while nothing changes the
// object in between (review 3, R2). `const cfg = { ...option }; cfg.url =
// '/other'` hands on a copy whose `url` is not the caller's, `delete cfg.url`
// hands on one with none, and `transform(cfg)` hands it to code this file
// may not show. So each named function is read once for what it does through
// each name (lib/uses.mjs), and that reader is default-deny (review 4, W-3):
// a place that is not a read it recognizes either writes a key it names or
// hands the object on. A hand whose object is written under the key the URL
// (or the method, or the base URL) is under does not settle that key, and one
// whose object went anywhere else settles nothing.
//
// A write that runs on every path through the function (not under an `if`, a
// loop, a `&&`, a callback), puts a string there, and is the only write that
// can reach that key is also a VALUE: `cfg.method = 'POST'` says what the
// request is sent with (review 3, R1).
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files.

import { eachUse } from './uses.mjs';

/** Nodes under which a statement may or may not run. */
const BRANCHING = new Set([
  'IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'TryStatement', 'CatchClause',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod',
]);

/** The record for one name, made the first time the name is seen. */
function recordOf(out, name) {
  if (!out.byName.has(name)) out.byName.set(name, { keys: new Map(), handed: [] });
  return out.byName.get(name);
}

/** One write under `key` of what `name` holds: the string put there when it is one, and whether it runs every time. */
function write(out, name, key, value, cond) {
  const keys = recordOf(out, name).keys;
  const prev = keys.get(key);
  keys.set(key, { count: (prev ? prev.count : 0) + 1, value, cond: cond || (prev ? prev.cond : false) });
}

/**
 * THE WRITES OF ONE NAMED FUNCTION, by the name written through, read once
 * when the function's body is entered: for each name, the keys written under
 * it (`*` when the key is not a name) with how many times, the string put
 * there and whether the write may not run; the places it is handed to; and
 * the `const` aliases (`const o = option`), which write what they alias.
 */
export function writesIn(fnNode) {
  const out = { byName: new Map(), aliases: new Map() };
  if (!fnNode || !fnNode.body) return out;
  eachUse(fnNode.body, BRANCHING, (name, u, cond) => {
    if (u.use === 'write') write(out, name, u.key, u.value, cond);
    else if (u.use === 'handed') recordOf(out, name).handed.push(u.site);
    else if (u.use === 'alias') out.aliases.set(u.to, name);
  });
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
 * sorted, `*` for a key that is not a name), whether any was handed anywhere
 * but this call (`handed`), and the keys a write that always runs set to a
 * string while nothing else could reach them (`sets`).
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
  if (out.handed || keys.has('*')) return out;
  for (const [k, v] of keys) if (v.count === 1 && !v.cond && typeof v.value === 'string') out.sets.set(k, v.value);
  return out;
}
