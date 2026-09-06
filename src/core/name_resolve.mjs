// name_resolve.mjs — a tool ARGUMENT that names a schema object, resolved the
// same way the SQL analyzer resolves a name in a statement (SPEC §8.1, §13).
//
// THE DEFECT THIS FIXES. The pack stores the catalog's spelling of a table
// (`orders`), and the query layer compared arguments byte for byte. So a user
// who read `ORDERS` off their own SQL and typed `table_usage ORDERS` got
// `unknown-table` for a table the pack holds — while the lineage worker, given
// the SAME two spellings inside a statement, correctly calls them one table,
// because it folds identifiers under the dialect's declared rule
// (src/core/identifier_case.mjs, adapters/sql/identifier_case.py). One engine
// must not hold two opinions about what a name means.
//
// THE RULE HERE IS THE PACK'S OWN RULE, NEVER A GUESS:
//   - `pack.meta.identifierCase` is written by `cascade analyze` from the same
//     `sqlLaneArgs()` the lineage worker was run with. This module takes that
//     value and no other; there is no dialect sniffing and no default fold.
//   - `exact` folds NOTHING. A dialect whose identity rule we cannot cite is
//     `exact` (see identifier_case.mjs), and folding there would merge two
//     tables the schema really does distinguish.
//   - AN OLD PACK WITH NO `identifierCase` IN ITS META BEHAVES EXACTLY AS
//     TODAY: `identifierCase` arrives as null, no fold is attempted, and a
//     case-differing name is only ever SUGGESTED, never resolved. Nothing
//     silently changes meaning under a pack built by an older engine.
//   - A folded hit is DISCLOSED by the caller (one `limits` line naming what
//     was typed and what it resolved to). A fold is a match the user did not
//     literally ask for, so it is never silent.
//   - When two names in the pack fold together (the collision the lineage
//     summary counts as `identifierCollisions`), the argument is AMBIGUOUS and
//     stays unresolved. Picking one would be a coin toss dressed as an answer.
//
// Pure: graph in, plain result out. The per-(graph, kind) fold index is built
// lazily — only when an exact lookup already missed — and memoised on the graph
// in a WeakMap, so the hot path (an argument spelled exactly as the pack holds
// it) costs one Map lookup, as it always did.

import { nodeId } from './graph.mjs';
import { foldIdentifier } from './identifier_case.mjs';

/** How many "did you mean" names an error may carry. */
export const MAX_SUGGESTIONS = 3;

/** The largest edit distance a suggestion may sit at (a typo, not a new word). */
export const MAX_EDIT_DISTANCE = 3;

// graph -> kind -> {byFold:Map<string,string[]>, keys:string[]}
const INDEX_CACHE = new WeakMap();

/**
 * Resolve one schema-object argument against the pack.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {'table'|'column'} kind
 * @param {string} typed  the argument exactly as the caller wrote it
 * @param {string|null|undefined} identifierCase  `pack.meta.identifierCase`
 *        (`fold-lower` | `fold-upper` | `exact`), or null/undefined for a pack
 *        that declares none — which folds nothing.
 * @returns {{how:'exact'|'folded'|'ambiguous'|'none', id:(string|null),
 *            key:(string|null), typed:string, identifierCase:(string|null),
 *            candidates:string[], suggestions:string[]}}
 *   how=exact     the pack holds this spelling; `id`/`key` are it.
 *   how=folded    the pack holds ONE name that folds together with this one;
 *                 `id`/`key` are the pack's spelling. Disclose it.
 *   how=ambiguous two or more pack names fold together with this one
 *                 (`candidates`); nothing is resolved.
 *   how=none      no match; `suggestions` is the "did you mean" list (possibly
 *                 empty).
 */
export function resolveSchemaName(graph, kind, typed, identifierCase) {
  const name = String(typed);
  const exactId = nodeId(kind, name);
  if (graph.nodes.has(exactId)) {
    return result('exact', exactId, name, name, identifierCase ?? null, [], []);
  }

  const idx = indexFor(graph, kind);
  const folds = identifierCase === 'fold-lower' || identifierCase === 'fold-upper';
  if (folds) {
    const hits = idx.byFold.get(foldIdentifier(name, identifierCase)) ?? [];
    if (hits.length === 1) {
      return result('folded', nodeId(kind, hits[0]), hits[0], name, identifierCase, [], []);
    }
    if (hits.length > 1) {
      return result('ambiguous', null, null, name, identifierCase, hits.slice(), suggest(name, hits));
    }
  }
  return result('none', null, null, name, identifierCase ?? null, [], suggest(name, idx.keys));
}

/**
 * The "did you mean" list: every case-insensitive match first (a name the
 * reader almost certainly meant), then the nearest names by edit distance —
 * at most `MAX_SUGGESTIONS` in all.
 *
 * Case-insensitive equality is offered even under `exact`, where it is NOT a
 * match: on such a pack `Orders` and `orders` really are two different names,
 * so the reader is told the other one exists rather than handed it.
 *
 * @param {string} typed
 * @param {string[]} keys  every known key of that kind
 * @returns {string[]}
 */
export function suggest(typed, keys) {
  const lower = typed.toLowerCase();
  const ci = [];
  const near = [];
  for (const k of keys) {
    if (k === typed) continue;
    if (k.toLowerCase() === lower) { ci.push(k); continue; }
    const d = editDistance(typed, k, MAX_EDIT_DISTANCE);
    if (d != null && d < typed.length) near.push({ k, d });
  }
  ci.sort(cmp);
  near.sort((a, b) => a.d - b.d || cmp(a.k, b.k));
  return [...ci, ...near.map((n) => n.k)].slice(0, MAX_SUGGESTIONS);
}

/**
 * Levenshtein distance, abandoned as soon as every cell in a row exceeds `max`
 * (which is what keeps this affordable over the 669 column names of a mall-sized
 * pack — and bounded, rather than quadratic in the pack, on a far bigger one).
 * @returns {number|null} the distance, or null when it exceeds `max`
 */
export function editDistance(a, b, max = MAX_EDIT_DISTANCE) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return null;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return null;
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length] <= max ? prev[b.length] : null;
}

/** The lazily built, memoised fold index for one node kind. */
function indexFor(graph, kind) {
  let byKind = INDEX_CACHE.get(graph);
  if (!byKind) { byKind = new Map(); INDEX_CACHE.set(graph, byKind); }
  let idx = byKind.get(kind);
  if (idx) return idx;
  const keys = [];
  const byFold = new Map();
  const prefix = `${kind}:`;
  for (const n of graph.nodes.values()) {
    if (n.kind !== kind || typeof n.id !== 'string' || !n.id.startsWith(prefix)) continue;
    const key = n.id.slice(prefix.length);
    keys.push(key);
    // Indexed under BOTH folds, so one index serves either rule and a pack
    // whose rule changed between runs cannot be answered from a stale shape.
    for (const f of new Set([foldIdentifier(key, 'fold-lower'), foldIdentifier(key, 'fold-upper')])) {
      const arr = byFold.get(f);
      if (arr) { if (!arr.includes(key)) arr.push(key); } else byFold.set(f, [key]);
    }
  }
  keys.sort(cmp);
  for (const arr of byFold.values()) arr.sort(cmp);
  idx = { byFold, keys };
  byKind.set(kind, idx);
  return idx;
}

function result(how, id, key, typed, identifierCase, candidates, suggestions) {
  return { how, id, key, typed, identifierCase, candidates, suggestions };
}
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
