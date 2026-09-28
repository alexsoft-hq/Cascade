// forwards.mjs — what a function HANDS ON of what it was given.
//
// WHAT THIS MODULE OWNS. Two questions about one call written inside a named
// function, both answered from that call's syntax and the function's own
// parameter list (RM67, R2-K):
//   the hands     which of the function's own parameters the call passes on,
//                 and how: as an argument, spread into an object argument, or
//                 as the value of one of that object's keys
//   the override  whether a method the call writes into its object can be
//                 replaced by what the caller handed in. `{ method: 'GET',
//                 ...option }` sets a default the caller's own `method`
//                 replaces; `{ ...option, method: 'GET' }` sets the method
//
// A wrapper written as an object's method (`export default { get: (option) =>
// request({ method: 'GET', ...option }) }`) calls a helper this file declares,
// and a call on a name this file declares is not a call record: it is one of
// the thousands of ordinary calls a file makes. So the few that hand one of
// the function's parameters on are written on the FUNCTION record as
// `forwards`, beside `returns`, and the bridge follows them the way it follows
// a return.
//
// WHAT IT MUST NEVER KNOW ABOUT: which name is a client, which function is a
// wrapper, the other files. It says what this call passes on; whether that
// reaches a request is the bridge's question.

import { keyName } from './ast.mjs';

/** The keys a method is written under in a config object, in the order the call reader tries them. */
const METHOD_KEYS = ['method', 'type'];

/**
 * A function node's own parameters by name, with their position. Only a plain
 * name counts (`option`, `option = {}`): a destructured parameter hands on its
 * parts, not the object the caller passed.
 * @returns {Map<string,number>}
 */
export function paramIndexOf(node) {
  const out = new Map();
  (node.params ?? []).forEach((p, i) => {
    const id = p && p.type === 'AssignmentPattern' ? p.left : p;
    if (id && id.type === 'Identifier') out.set(id.name, i);
  });
  return out;
}

/**
 * The position of `name` among the enclosing NAMED function's own parameters,
 * or -1. A callback inside it that declares the same name has its own, and the
 * scope the name is found in is what tells the two apart.
 */
function paramAt(env, name) {
  const fn = env.func;
  if (!fn || !fn.paramIndex || !fn.paramIndex.has(name)) return -1;
  return env.scope.find(name) === fn.paramScope ? fn.paramIndex.get(name) : -1;
}

/** What one object argument hands on: its spreads, and the values of its keys. */
function handsInObject(objectNode, arg, env, out) {
  for (const p of objectNode.properties) {
    if (p.type === 'SpreadElement' && p.argument && p.argument.type === 'Identifier') {
      const param = paramAt(env, p.argument.name);
      if (param >= 0) out.push({ param, arg, as: 'spread' });
      continue;
    }
    if (p.type !== 'ObjectProperty' || !p.value || p.value.type !== 'Identifier') continue;
    const param = paramAt(env, p.value.name);
    const key = keyName(p);
    if (param >= 0 && key !== null) out.push({ param, arg, as: 'key', key });
  }
}

/**
 * THE HANDS: what one call passes on of the enclosing function's own
 * parameters, each as `{param, arg, as}` (and `key` when `as` is `key`). Only
 * the first three arguments are read, the same three a call record summarizes.
 * @returns {object[]} empty when the call hands on nothing the function was given
 */
export function handsOf(node, env) {
  const out = [];
  (node.arguments ?? []).slice(0, 3).forEach((a, arg) => {
    if (!a) return;
    if (a.type === 'Identifier') {
      const param = paramAt(env, a.name);
      if (param >= 0) out.push({ param, arg, as: 'argument' });
    } else if (a.type === 'ObjectExpression') handsInObject(a, arg, env, out);
  });
  return out;
}

/** Where an object literal writes `verb` under one of the method keys, or null. */
function verbKeyAt(objectNode, verb) {
  for (const key of METHOD_KEYS) {
    const index = objectNode.properties.findIndex((p) => p.type === 'ObjectProperty' && keyName(p) === key
      && p.value && p.value.type === 'StringLiteral' && p.value.value.toUpperCase() === verb);
    if (index >= 0) return { key, index };
  }
  return null;
}

/**
 * THE OVERRIDE: whether what the caller handed in can replace the method this
 * call writes. A spread written AFTER the key brings the caller's keys in over
 * it, and the later one wins. Each such spread is one of the enclosing
 * function's parameters (`by`, its position) or something else (`other`),
 * whose keys nothing in this file states.
 *
 * @param {string} verb  the method the call reader took from this call's object
 * @returns {{key:string, by:number[], other?:true}|null} null when nothing can replace it
 */
export function methodOverrideOf(node, env, verb) {
  for (const a of (node.arguments ?? []).slice(0, 3)) {
    if (!a || a.type !== 'ObjectExpression') continue;
    const at = verbKeyAt(a, verb);
    if (at === null) continue;
    const later = a.properties.slice(at.index + 1).filter((p) => p.type === 'SpreadElement');
    if (later.length === 0) return null;
    const by = [];
    let other = false;
    for (const s of later) {
      const param = s.argument && s.argument.type === 'Identifier' ? paramAt(env, s.argument.name) : -1;
      if (param >= 0) by.push(param); else other = true;
    }
    return { key: at.key, by, ...(other ? { other: true } : {}) };
  }
  return null;
}
