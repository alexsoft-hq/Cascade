// forwards.mjs — a named function's own parameter list.
//
// WHAT THIS MODULE OWNS. The two views of a function's parameters every call
// inside it is read against (RM67, R2-K): the plain ones by position, and every
// name a parameter binds, patterns included, by the position it belongs to.
// What a call HANDS ON of those parameters is `origins.mjs`'s question, what
// it writes into the object it sends is `sets.mjs`'s, and what it reads apart
// from its hands is `reads.mjs`'s.
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
// wrapper, the other files.

import { patternNames } from './ast.mjs';

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
