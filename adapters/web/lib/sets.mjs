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
import { originOf } from './origins.mjs';

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

/**
 * THE SETS OF ONE CALL: every key of `keys` an object literal among its first
 * three arguments writes, and the `extra` ones a member write put in an object
 * it passes on (lib/writes.mjs, which always runs, and so is never replaced by
 * a spread).
 * @returns {{key:string, arg:number, value:(string|null), from:string, by?:number[], other?:true}[]}
 */
export function setsOf(node, env, keys, extra = []) {
  const out = [];
  (node.arguments ?? []).slice(0, 3).forEach((a, arg) => {
    const n = bare(a);
    if (!n || n.type !== 'ObjectExpression') return;
    n.properties.forEach((p, i) => {
      const key = p.type === 'ObjectProperty' ? keyName(p) : null;
      if (key === null || !keys.includes(key)) return;
      out.push({ key, arg, value: stringOf(p.value), from: 'config', ...laterSpreads(n, i, key, env) });
    });
  });
  for (const e of extra) if (keys.includes(e.key)) out.push(e);
  return out;
}
