// reads.mjs — what one call reads of its function's parameters APART FROM what
// it hands on.
//
// WHAT THIS MODULE OWNS. One question about one call written inside a named
// function (review 2, item 2). `origins.mjs` says what the call hands on where
// the syntax settles it: a parameter, a part of one, a rest, a copy. Whatever
// else in its arguments reaches a parameter is read here: through a `const`
// the function built from one with an expression (`const conf =
// cloneDeep(config)`), through a call on it, inside a nested object. And the
// call is OPEN when something in its arguments could carry a parameter along a
// path nobody can follow from the syntax: a `let` or `var`, a parameter the
// body assigns again, `this`, `arguments`, a name with no initializer.
//
// The bridge asks this only of a hop whose hands do not carry the caller's
// URL: read here, or open, the hop may still carry it and is not settled; read
// nowhere, the hop dropped it.
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files. It reads names
// in one function's scope and nothing else.

import { bare, eachChild, keyName } from './ast.mjs';
import { insideFunction, originOf } from './origins.mjs';

/** How far a local's initializer is followed back to a parameter. */
const READS_DEPTH = 4;

/**
 * WHAT A CALL READS of the enclosing named function's parameters beyond the
 * nodes its hands took (`used`): `params`, the positions it reads whole;
 * `partial`, the parts and rests it reads (`{param, key}` or `{param,
 * minus}`), since a part read somewhere carries only its own key; and `open`,
 * why something in the arguments may carry a parameter along a path the
 * syntax does not settle (`reassigned`, `this`, `arguments`, `unbound`,
 * `deep`), with the name when there is one. What is read as the value of one
 * key of an object argument (`{ params: qs(option) }`) can only land under
 * that key, so it is said apart, under `under[key]`, in the same three words.
 * @returns {{params:number[], partial?:object[], open?:object, under?:object}|null}
 *          null outside a named function with parameters
 */
export function readsOf(node, env, used = new Set()) {
  const fn = env.func;
  if (!fn || !fn.paramScope || !fn.paramOwner || fn.paramOwner.size === 0) return null;
  const buckets = new Map();
  const readInto = (key, n) => {
    if (!buckets.has(key)) buckets.set(key, { env, used, params: new Set(), partial: new Map(), open: null, seen: new Set() });
    visit(buckets.get(key), n, env.scope, 0);
  };
  (node.arguments ?? []).forEach((a, i) => {
    const n = bare(a);
    if (i >= 3 || !n || n.type !== 'ObjectExpression' || used.has(a)) { readInto('', a); return; }
    for (const p of n.properties) {
      const key = p.type === 'ObjectProperty' ? keyName(p) : null;
      if (!used.has(p)) readInto(key ?? '', key !== null ? p.value : p);
    }
  });
  return resultOf(buckets);
}

/** What one bucket read, in the record's words. */
function summaryOf(b) {
  if (!b) return { params: [] };
  const out = { params: [...b.params].sort((x, y) => x - y) };
  if (b.partial.size > 0) out.partial = [...b.partial.keys()].sort().map((k) => b.partial.get(k));
  if (b.open !== null) out.open = b.open;
  return out;
}

/** The reads of the arguments themselves, and those under each key that read anything. */
function resultOf(buckets) {
  const out = summaryOf(buckets.get(''));
  const under = {};
  for (const k of [...buckets.keys()].sort()) {
    const b = buckets.get(k);
    if (k !== '' && (b.params.size > 0 || b.partial.size > 0 || b.open !== null)) under[k] = summaryOf(b);
  }
  if (Object.keys(under).length > 0) out.under = under;
  return out;
}

/** One node of an argument, walked for the names it reads. */
function visit(state, n, scope, depth) {
  if (!n || state.open !== null || state.used.has(n)) return;
  if (n.type === 'ThisExpression') { state.open = { why: 'this' }; return; }
  if (n.type === 'Identifier') { readName(state, n.name, scope, depth); return; }
  if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed) {
    visit(state, n.object, scope, depth);
    return;
  }
  if (n.type === 'ObjectProperty' && !n.computed) { visit(state, n.value, scope, depth); return; }
  eachChild(n, (c) => visit(state, c, scope, depth));
}

/** A part or a rest read, kept once. */
function notePartial(state, o) {
  if (o.key === undefined && o.minus === undefined) { state.params.add(o.param); return; }
  const k = o.key !== undefined ? `${o.param} key ${o.key}` : `${o.param} minus ${o.minus.join(',')}`;
  state.partial.set(k, o.key !== undefined ? { param: o.param, key: o.key } : { param: o.param, minus: o.minus });
}

/** One name read: a parameter, a settled part of one, or a local followed to what it was made from. */
function readName(state, name, scope, depth) {
  const { env } = state;
  const fn = env.func;
  if (name === 'arguments') { state.open = { why: 'arguments' }; return; }
  const where = scope.find(name);
  if (!where || where.isModule) return;
  // The body's own declarations share the parameters' scope, and a block's
  // sit between it and the call.
  if (where !== fn.paramScope && !insideFunction(where, env.scope, fn.paramScope)) return;
  if (where === fn.paramScope && fn.reassigned && fn.reassigned.has(name)) { state.open = { why: 'reassigned', name }; return; }
  const origin = originOf(env, name, scope);
  if (origin !== null) { notePartial(state, origin); return; }
  if (where === fn.paramScope && fn.paramOwner.has(name)) { state.params.add(fn.paramOwner.get(name)); return; }
  if (where.mutable.has(name)) { state.open = { why: 'reassigned', name }; return; }
  if (!where.names.get(name)) { state.open = { why: 'unbound', name }; return; }
  if (depth >= READS_DEPTH) { state.open = { why: 'deep', name }; return; }
  if (state.seen.has(name)) return;
  state.seen.add(name);
  visit(state, where.names.get(name), scope, depth + 1);
}
