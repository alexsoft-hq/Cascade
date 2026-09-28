// origins.mjs — which part of a function's parameters a name inside it holds.
//
// WHAT THIS MODULE OWNS. A wrapper rarely hands its parameter on as it came in.
// It destructures it (`const { headersType, headers, ...otherOption } = option`),
// copies it (`const o = option`, `const cfg = { ...option, method }`), or takes
// one key of it (`const { url } = option`, `({ url, ...rest }) =>`). What each
// such name holds is settled by the syntax, and this module says it. An ORIGIN
// is `{param}` (the parameter itself), `{param, key}` (the value at one key of
// it) or `{param, minus}` (its object without the keys a pattern named beside
// a rest, or wrote over a spread). `handsOf` then says what a call passes on in
// those terms, so the bridge can tell that `service({ ...otherOption })` hands
// on the caller's `url` and that `axios({ ...rest })` after `const { url,
// ...rest } = option` does not (review 2, item 2).
//
// WHAT IS NOT SETTLED, and so has no origin: a `let` or `var`, a parameter the
// body assigns again, a part of a part, and anything a call or an expression
// computes. `reads.mjs` says what a call reads through those.
//
// WHAT IT MUST NEVER KNOW ABOUT: clients, wrappers, other files.

import { eachChild, keyName, patternNames } from './ast.mjs';
import { paramIndexOf, paramOwnerOf } from './forwards.mjs';

/** The TypeScript written around an expression, which changes nothing it holds. */
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression']);

/** An expression with the TypeScript around it taken off: `option as any` is `option`. */
export function bare(n) {
  let cur = n;
  for (let i = 0; i < 8 && cur && TS_WRAPPERS.has(cur.type); i += 1) cur = cur.expression;
  return cur;
}

/** The keys an object pattern names, the names it binds to one key each, and its rest. */
function patternShape(pattern) {
  const named = [];
  const parts = [];
  let rest = null;
  for (const p of pattern.properties ?? []) {
    if (p.type === 'RestElement') {
      if (p.argument && p.argument.type === 'Identifier') rest = p.argument.name;
      continue;
    }
    const key = keyName(p);
    if (key === null) return null;
    named.push(key);
    const v = p.value && p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
    if (v && v.type === 'Identifier') parts.push({ name: v.name, key });
  }
  return { named: [...new Set(named)].sort(), parts, rest };
}

/** What each name an object pattern binds holds of `base`, handed to `set`. */
function originsOfPattern(pattern, base, set) {
  const shape = patternShape(pattern);
  if (shape === null) return;
  for (const p of shape.parts) set(p.name, { ...base, key: p.key });
  if (shape.rest !== null) set(shape.rest, { ...base, minus: shape.named });
}

/** The parameters a function's body assigns again (`option = { ...option }`): what they hold is not what was passed. */
function reassignedIn(node, owner) {
  const out = new Set();
  if (owner.size === 0 || !node.body) return out;
  const note = (target) => { for (const n of patternNames(target)) if (owner.has(n)) out.add(n); };
  const walk = (n) => {
    if (n.type === 'AssignmentExpression') note(n.left);
    else if (n.type === 'UpdateExpression') note(n.argument);
    else if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left.type !== 'VariableDeclaration') note(n.left);
    eachChild(n, walk);
  };
  walk(node.body);
  return out;
}

/**
 * WHAT A NAMED FUNCTION'S PARAMETERS ARE, for the calls inside it: each plain
 * one's position, the position every name a parameter binds belongs to, what
 * a pattern in the signature binds (`({ url, ...rest }) =>` makes `url` key
 * `url` of parameter 0 and `rest` parameter 0 without `url`), and which of them
 * the body assigns again.
 */
export function paramFactsOf(node, scope) {
  const paramOwner = paramOwnerOf(node);
  const paramParts = new Map();
  (node.params ?? []).forEach((p, i) => {
    const pattern = p && p.type === 'AssignmentPattern' ? p.left : p;
    if (pattern && pattern.type === 'ObjectPattern') originsOfPattern(pattern, { param: i }, (n, o) => paramParts.set(n, o));
  });
  return {
    paramScope: scope, paramIndex: paramIndexOf(node), paramOwner, paramParts, reassigned: reassignedIn(node, paramOwner),
  };
}

/** The keys written after an object literal's one spread, and the name spread; null for any other shape. */
function spreadCopyOf(objectNode) {
  const spreads = objectNode.properties.filter((p) => p.type === 'SpreadElement');
  const arg = spreads.length === 1 ? bare(spreads[0].argument) : null;
  if (!arg || arg.type !== 'Identifier') return null;
  const over = keysAfter(objectNode, objectNode.properties.indexOf(spreads[0]));
  return over === null ? null : { from: arg.name, over };
}

/** The keys an object literal writes after position `at`, or null when one of them is not written as a name. */
function keysAfter(objectNode, at) {
  const keys = objectNode.properties.slice(at + 1).map((p) => (p.type === 'SpreadElement' ? null : keyName(p)));
  return keys.includes(null) ? null : [...new Set(keys)].sort();
}

/**
 * WHAT A `const` INSIDE A NAMED FUNCTION HOLDS of another name, kept on the
 * scope it is declared in: `const o = option` (the same value), `const cfg = {
 * ...option, method }` (a copy without `method`), `const { a, ...r } = option`
 * (a part, and the rest). A `let` or `var` keeps nothing: the next line may
 * assign it again.
 */
export function noteOrigins(node, decl, env) {
  if (!env.func || !env.func.paramScope || node.kind !== 'const' || !decl.init) return;
  const scope = env.scope;
  const set = (name, o) => {
    if (!scope.origins) scope.origins = new Map();
    scope.origins.set(name, o);
  };
  const init = bare(decl.init);
  if (decl.id.type === 'Identifier' && init.type === 'Identifier') set(decl.id.name, { from: init.name });
  else if (decl.id.type === 'Identifier' && init.type === 'ObjectExpression') {
    const copy = spreadCopyOf(init);
    if (copy !== null) set(decl.id.name, { from: copy.from, minus: copy.over });
  } else if (decl.id.type === 'ObjectPattern' && init.type === 'Identifier') {
    originsOfPattern(decl.id, { from: init.name }, set);
  }
}

/** Whether `scope` is one the function's body opened, from where the call is up to its parameters. */
export function insideFunction(scope, from, paramScope) {
  for (let s = from; s && s !== paramScope; s = s.parent) if (s === scope) return true;
  return false;
}

/** A local's origin laid over the origin of the name it was made from; null when that is not settled. */
function compose(base, o) {
  if (o.key === undefined && o.minus === undefined) return base;
  if (base.key !== undefined) return null;
  if (o.key !== undefined) return (base.minus ?? []).includes(o.key) ? null : { param: base.param, key: o.key };
  return { param: base.param, minus: [...new Set([...(base.minus ?? []), ...o.minus])].sort() };
}

/**
 * THE ORIGIN of a name read at a call inside the enclosing named function, or
 * null when the syntax does not settle what it holds of the parameters.
 * @returns {{param:number, key?:string, minus?:string[]}|null}
 */
export function originOf(env, name, scope = env.scope, depth = 0) {
  const fn = env.func;
  if (!fn || !fn.paramScope || depth > 8) return null;
  const where = scope.find(name);
  if (!where || (fn.reassigned && fn.reassigned.has(name) && where === fn.paramScope)) return null;
  if (where === fn.paramScope && fn.paramIndex.has(name)) return { param: fn.paramIndex.get(name) };
  if (where === fn.paramScope && fn.paramParts && fn.paramParts.has(name)) return fn.paramParts.get(name);
  if (where !== fn.paramScope && !insideFunction(where, env.scope, fn.paramScope)) return null;
  const o = where.mutable.has(name) ? null : (where.origins?.get(name) ?? null);
  if (o === null) return null;
  const base = originOf(env, o.from, where, depth + 1);
  return base === null ? null : compose(base, o);
}

/** The hand for one value with a settled origin, passed as `as`; null when a part cannot go that way. */
function handFrom(origin, arg, as, key = null) {
  if (origin === null) return null;
  if (origin.key !== undefined) {
    if (as === 'argument') return { param: origin.param, arg, as: 'member', key: origin.key };
    return as === 'key' ? { param: origin.param, arg, as, key, part: origin.key } : null;
  }
  return {
    param: origin.param, arg, as, ...(key === null ? {} : { key }), ...(origin.minus ? { minus: origin.minus } : {}),
  };
}

/** `option.url`, on a name with a settled origin: the value at that key, or null. */
function memberOrigin(node, env) {
  const n = bare(node);
  if (!n || (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression')) return null;
  if (n.computed || !n.property || n.property.type !== 'Identifier') return null;
  const obj = bare(n.object);
  const o = obj && obj.type === 'Identifier' ? originOf(env, obj.name) : null;
  if (o === null || o.key !== undefined || (o.minus ?? []).includes(n.property.name)) return null;
  return { param: o.param, key: n.property.name };
}

/** A value written as a name or as `name.key`, and its origin. */
function valueOrigin(node, env) {
  const n = bare(node);
  if (n && n.type === 'Identifier') return originOf(env, n.name);
  return memberOrigin(n, env);
}

/** What one object argument hands on: each spread (without the keys written over it), and each key's value. */
function handsInObject(objectNode, arg, env, used, out) {
  objectNode.properties.forEach((p, i) => {
    let h = null;
    if (p.type === 'SpreadElement') {
      const o = bare(p.argument) && bare(p.argument).type === 'Identifier' ? originOf(env, bare(p.argument).name) : null;
      const over = keysAfter(objectNode, i);
      if (o !== null && o.key === undefined && over !== null) {
        const minus = [...new Set([...(o.minus ?? []), ...over])].sort();
        h = handFrom({ param: o.param, ...(minus.length > 0 ? { minus } : {}) }, arg, 'spread');
      }
    } else if (p.type === 'ObjectProperty' && keyName(p) !== null) {
      h = handFrom(valueOrigin(p.value, env), arg, 'key', keyName(p));
    }
    if (h === null) return;
    out.push(h);
    used.add(p);
  });
}

/**
 * THE HANDS: what one call passes on of the enclosing function's parameters,
 * each as `{param, arg, as}`: `as` is `argument` (the parameter, or a settled
 * copy of it), `spread` (spread into an object argument), `key` (the value of
 * one of that object's keys, `key`) or `member` (the value at key `key`). A
 * hand made from a part says which key of the parameter it is (`part`); one
 * made from a rest or a copy says which keys it no longer carries (`minus`).
 * Only the first three arguments are read, the same three a call record
 * summarizes. What it took is added to `used`, so what the call reads apart
 * from its hands can be told from them.
 * @returns {object[]} empty when the call hands on nothing the function was given
 */
export function handsOf(node, env, used = new Set()) {
  const out = [];
  (node.arguments ?? []).slice(0, 3).forEach((a, arg) => {
    const n = bare(a);
    if (!n) return;
    if (n.type === 'ObjectExpression') { handsInObject(n, arg, env, used, out); return; }
    const h = handFrom(valueOrigin(n, env), arg, 'argument');
    if (h === null) return;
    out.push(h);
    used.add(a);
  });
  return out;
}
