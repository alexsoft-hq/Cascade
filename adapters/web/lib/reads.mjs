// reads.mjs — which of a function's parameters one call READS at all.
//
// WHAT THIS MODULE OWNS. One question about one call written inside a named
// function (review 2, item 2): does anything in its arguments reach one of the
// function's own parameters, directly or through a `const` the function
// declared from one, and could something in them carry a parameter along a
// path this reader does not follow? `forwards.mjs` says how a parameter is
// handed on when the syntax spells it; this says whether it is handed on at
// all, so the bridge can tell a URL a hop dropped from one it moved through a
// local.
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files. It reads names
// in one function's scope and nothing else.

import { eachChild } from './ast.mjs';

/** How far a local's initializer is followed back to a parameter. */
const READS_DEPTH = 4;

/**
 * WHAT A CALL READS of the enclosing named function's parameters, at all
 * (review 2, item 2): `params`, the positions its arguments mention directly or
 * through a `const` of the function initialized from one (`const copy = {
 * ...option }`, `const { headers, ...rest } = option`, a closure over it),
 * followed a few steps; and `open` when something in them could carry a
 * parameter along a path this reader does not follow (a `let` or `var`, a local
 * with no initializer, `this`, `arguments`). `hands` says how a parameter is
 * passed when the syntax spells it; this says whether it is passed at all, so a
 * hop that reads the URL's parameter nowhere and is not open has dropped it.
 * @returns {{params:number[], open?:true}|null} null outside a named function
 */
export function readsOf(node, env) {
  const fn = env.func;
  if (!fn || !fn.paramScope || !fn.paramOwner || fn.paramOwner.size === 0) return null;
  const params = new Set();
  const state = { open: false, seen: new Set() };
  const visit = (n, scope, depth) => {
    if (!n || state.open) return;
    if (n.type === 'ThisExpression') { state.open = true; return; }
    if (n.type === 'Identifier') { readName(n.name, scope, depth); return; }
    if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed) {
      visit(n.object, scope, depth);
      return;
    }
    if (n.type === 'ObjectProperty' && !n.computed) { visit(n.value, scope, depth); return; }
    eachChild(n, (c) => visit(c, scope, depth));
  };
  const readName = (name, scope, depth) => {
    if (name === 'arguments') { state.open = true; return; }
    const where = scope.find(name);
    if (where === fn.paramScope && fn.paramOwner.has(name)) { params.add(fn.paramOwner.get(name)); return; }
    // The body's own declarations share the parameters' scope, and a block's
    // sit between it and the call.
    if (!where || where.isModule || (where !== fn.paramScope && !insideFunction(where, env.scope, fn.paramScope))) return;
    if (where.mutable.has(name) || !where.names.get(name) || depth >= READS_DEPTH) { state.open = true; return; }
    if (state.seen.has(name)) return;
    state.seen.add(name);
    visit(where.names.get(name), scope, depth + 1);
  };
  for (const a of node.arguments ?? []) visit(a, env.scope, 0);
  const out = { params: [...params].sort((a, b) => a - b) };
  return state.open ? { ...out, open: true } : out;
}

/** Whether `scope` is one the function's body opened, from where the call is up to its parameters. */
function insideFunction(scope, from, paramScope) {
  for (let s = from; s && s !== paramScope; s = s.parent) if (s === scope) return true;
  return false;
}
