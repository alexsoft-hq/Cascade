// sets.mjs — what one call writes into the object it sends, under the keys a
// client reads its method and its base URL from.
//
// WHAT THIS MODULE OWNS. A wrapper step decides the request's method and base
// URL as often as its URL: `axios({ ...o, method: 'DELETE' })` sets the method,
// `axios({ method: 'GET', ...o })` sets a default the caller's own `method`
// replaces, `axios({ ...o, method: verb })` sets one this file does not state,
// `service({ ...o, baseURL: '/v2' })` sends the request under another base
// (review 3, R1 and R3). Each such key is one SET: the key, the argument whose
// object it is written in, the string when it is one (null when it is not),
// and, when a spread comes after it, which of the function's parameters that
// spread is (`by`) or that it is something else (`other`): a later spread may
// carry the key too, and the later one wins. The keys are the pack's
// (packs/http-clients.json): the method keys every client reads, and each
// library's `configBaseUrlKey`.
//
// WHAT IT MUST NEVER KNOW ABOUT: which client the call reaches. It says what is
// written; the bridge knows which keys the client at the end of the chain reads.

import { bare, keyName } from './ast.mjs';
import { originOf, valueOrigin } from './origins.mjs';

/** The method keys a request's object is read for, whatever the client (the worker's own `methodOf` reads the same two). */
const METHOD_KEYS = ['method', 'type'];

/** The keys a set is recorded for: the method keys, and every base URL key a library in the pack names. */
export function setKeysOf(libraries) {
  const base = (libraries ?? []).map((l) => l.configBaseUrlKey).filter((k) => typeof k === 'string');
  return [...new Set([...METHOD_KEYS, ...base])];
}

/** A string written as one: a literal, or a template with nothing in it. Null for anything else. */
function stringOf(node) {
  const n = bare(node);
  if (n && n.type === 'StringLiteral') return n.value;
  if (n && n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** The spreads after position `at` that may carry `key`: the parameters they are, and whether one is anything else. */
function laterSpreads(objectNode, at, key, env) {
  const by = [];
  let other = false;
  for (const s of objectNode.properties.slice(at + 1)) {
    if (s.type !== 'SpreadElement') continue;
    const a = bare(s.argument);
    const o = a && a.type === 'Identifier' ? originOf(env, a.name) : null;
    if (o === null || o.key !== undefined) other = true;
    else if (!(o.minus ?? []).includes(key)) by.push(o.param);
  }
  if (by.length === 0 && !other) return {};
  return { by: [...new Set(by)].sort((x, y) => x - y), ...(other ? { other: true } : {}) };
}

/** A spread of something other than one of the function's parameters (`...defaults`, `...this.opts`, `...o.config`). */
function spreadOfOther(p, env) {
  if (p.type !== 'SpreadElement') return false;
  const a = bare(p.argument);
  const o = a && a.type === 'Identifier' ? originOf(env, a.name) : null;
  return o === null || o.key !== undefined;
}

/**
 * THE SETS OF ONE CALL: every key of `keys` an object literal among its first
 * three arguments writes, and the `extra` ones a member write put in an object
 * it passes on (lib/writes.mjs, which always runs, and so is never replaced by
 * a spread). A spread of an object that is not one of the function's
 * parameters may carry any of the keys (review 4, W-4: `{ ...defaults, ...o }`
 * with `defaults.method` set), so it is a set of each, whose value is not
 * known (`from: 'spread'`).
 * @returns {{key:string, arg:number, value:(string|null), from:string, by?:number[], other?:true}[]}
 */
export function setsOf(node, env, keys, extra = []) {
  const out = [];
  (node.arguments ?? []).slice(0, 3).forEach((a, arg) => {
    const n = bare(a);
    if (n && n.type === 'ObjectExpression') n.properties.forEach((p, i) => out.push(...setsAt(n, i, arg, env, keys)));
  });
  for (const e of extra) if (keys.includes(e.key)) out.push(e);
  return out;
}

/**
 * The sets one property of an object argument makes: its own key, or every
 * key when it spreads something unread. A value that is one of the function's
 * parameters, or one key of one (`method: m`, `method: o.method`), says which
 * (`param`, `part`), so the walk can put there what the caller handed in
 * (review 4, W-11).
 */
function setsAt(n, i, arg, env, keys) {
  const p = n.properties[i];
  if (spreadOfOther(p, env)) return keys.map((key) => ({ key, arg, value: null, from: 'spread', ...laterSpreads(n, i, key, env) }));
  const key = p.type === 'ObjectProperty' ? keyName(p) : null;
  if (key === null || !keys.includes(key)) return [];
  const o = valueOrigin(p.value, env);
  const handed = o !== null && !o.minus && !o.written ? { param: o.param, ...(o.key !== undefined ? { part: o.key } : {}) } : {};
  return [{ key, arg, value: stringOf(p.value), from: 'config', ...handed, ...laterSpreads(n, i, key, env) }];
}
