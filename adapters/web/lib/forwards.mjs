// forwards.mjs — what a function HANDS ON of what it was given.
//
// WHAT THIS MODULE OWNS. A named function's own parameter list, and one
// question about one call written inside it, answered from that call's syntax
// (RM67, R2-K):
//   the override  whether a method the call writes into its object can be
//                 replaced by what the caller handed in. `{ method: 'GET',
//                 ...option }` sets a default the caller's own `method`
//                 replaces; `{ ...option, method: 'GET' }` sets the method
// What the call HANDS ON of those parameters is `origins.mjs`'s question,
// because a parameter is handed on through a rest or a copy as often as whole.
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

import { keyName, patternNames } from './ast.mjs';

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
 * Every name a parameter binds, to that parameter's position: `(a, { b, ...c })`
 * gives a 0, b 1 and c 1. What a call READS of the parameters (`readsOf`) is
 * asked of these, because a part of a parameter still carries what the caller
 * put in it.
 * @returns {Map<string,number>}
 */
export function paramOwnerOf(node) {
  const out = new Map();
  (node.params ?? []).forEach((p, i) => {
    for (const n of patternNames(p)) if (!out.has(n)) out.set(n, i);
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
