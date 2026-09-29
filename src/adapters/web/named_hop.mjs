// named_hop.mjs — a wrapper step a rule pack names, walked as the rule says.
//
// WHAT THIS MODULE OWNS. The web lane settles a wrapper step only in shapes its
// code positively shows (chain.mjs, adapters/web/lib/uses.mjs). A framework's
// own step whose code does not settle it can be named by a `web.wrapper-hop`
// rule (src/core/rules/kinds/web_wrapper_hop.mjs), and then it is read as the
// rule says: the request the step was handed goes on to the client, and each
// key goes on as the rule says it does. That reading is used only where the
// step's call has the shape the rule relies on (the client call hands on a
// local the step assigns again, and nothing else), and what the rule says the
// step does that this lane cannot see through is said on the edge instead of
// settled: options that may set a key the URL's prefix is decided by, and a
// key the step appends to the URL when it holds text.
//
// To know what a call hands the step, the walk keeps, beside the places it
// follows, what each argument of the current step holds (`args`): the caller's
// own summaries, moved on through each step's hands, merged where a step
// spreads one into an object of its own. Anything this cannot follow is a
// value nobody states, which settles nothing.
//
// WHAT IT MUST NEVER KNOW ABOUT: which framework, which class, which keys. The
// rule says; this reads.

/** A value nobody states: it may hold anything. */
const UNKNOWN = Object.freeze({ kind: 'other' });

/** Whether a summarized value may be text: an object or an array never is. */
const mayBeText = (v) => !(v === 'object' || (v && typeof v === 'object' && v.kind === 'object'));

/** Two summaries of one key merged: text if either may be. */
const mergeKey = (a, b) => (a === undefined ? b : b === undefined ? a : (mayBeText(a) || mayBeText(b) ? 'present' : 'object'));

/**
 * An object a step writes with what came in at its parameters spread into it:
 * every key any of them writes, and `spread` when one of them may carry keys
 * nobody states (a value that is not an object summary, another spread, a
 * computed key).
 */
function mergedObject(own, sources, otherSpread) {
  const all = [own, ...sources.filter((x) => x !== null)];
  const objects = all.filter((x) => x.kind === 'object');
  const unknown = otherSpread || own.computed === true || objects.length < all.length
    || sources.some((x) => x !== null && x.kind === 'object' && (x.spread === true || x.computed === true));
  const keys = {};
  for (const o of objects) for (const [k, v] of Object.entries(o.keys ?? {})) keys[k] = mergeKey(keys[k], v);
  const names = [...new Set(objects.flatMap((o) => o.names ?? []))];
  return { kind: 'object', keys, names, ...(unknown ? { spread: true } : {}) };
}

/** Whether a hand moves an argument whole or spreads it, and nothing else touches it. */
const plainHand = (h) => !h.handed && (h.written ?? []).length === 0 && h.part === undefined && (h.as === 'argument' || h.as === 'spread');

/**
 * WHAT A STEP'S CALL HANDS THE NEXT STEP at each argument: its own value, what
 * came in at the parameter it hands on whole (null when nothing came in
 * there), or its own object with what came in spread into it.
 */
export function argumentsInto(args, call) {
  return (call.args ?? []).map((own, j) => {
    const into = (call.hands ?? []).filter((h) => h.arg === j);
    if (into.length === 0) return own;
    if (!into.every(plainHand)) return UNKNOWN;
    if (into.length === 1 && into[0].as === 'argument') return args[into[0].param] ?? null;
    if (!own || own.kind !== 'object' || into.some((h) => h.as !== 'spread')) return UNKNOWN;
    const otherSpread = (call.sets ?? []).some((x) => x.from === 'spread' && x.arg === j);
    return mergedObject(own, into.map((h) => args[h.param] ?? null), otherSpread);
  });
}

/**
 * THE STEP'S CLIENT CALL, read as the rule says: the local it hands the client
 * is the request the step was handed at `config`, moved on whole, with every
 * key the rule does not keep written on the way. Null when the call is not
 * that shape: then the rule says nothing about it.
 */
function namedCallOf(call, statement, keys) {
  const open = call && call.reads ? call.reads.open : null;
  if (!open || open.why !== 'reassigned' || (call.hands ?? []).length > 0) return null;
  const arg = (call.args ?? []).findIndex((a) => a && a.kind === 'ident' && a.name === open.name);
  if (arg < 0) return null;
  const written = [...keys.method, ...(keys.base ? [keys.base] : [])].filter((k) => statement.keyDoes(k) !== 'keep');
  if (statement.url.set) written.push('url');
  const hand = { param: statement.hop.config, arg, as: 'argument', ...(written.length > 0 ? { written } : {}) };
  return { ...call, hands: [hand], reads: { params: [] } };
}

/** Whether what came in at `config` may carry text under `from`. */
function appendMayBeText(cfg, from) {
  if (cfg === undefined || cfg === null) return false;
  if (cfg.kind !== 'object' || cfg.spread === true || cfg.computed === true) return true;
  const v = (cfg.keys ?? {})[from];
  return v === undefined ? (cfg.names ?? []).includes(from) : mayBeText(v);
}

/** The option key a call's own options set of `by` (null when they may set one nobody states), or undefined. */
function optionHit(o, by) {
  if (o === undefined || o === null) return undefined;
  if (o.kind !== 'object' || o.spread === true || o.computed === true) return null;
  return (o.names ?? []).find((k) => by.includes(k));
}

/** Why what the step does is not settled for this call, by what came in at its parameters; null when it is. */
function namedWhy(args, statement) {
  for (const from of statement.url.append) {
    if (appendMayBeText(args[statement.hop.config], from)) return { why: 'hop-append', key: 'url', from };
  }
  if (statement.url.prefix && statement.hop.options !== null) {
    const hit = optionHit(args[statement.hop.options], statement.url.prefix);
    if (hit !== undefined) return { why: 'hop-option', key: 'url', option: hit };
  }
  return null;
}

/**
 * ONE WAY INTO A STEP A RULE NAMES: the client call as the rule reads it, why
 * this call is not settled by it (or null), and the mark the edge carries (the
 * rule, the step, and the option keys the URL's prefix is decided by). Null
 * when the rule does not apply: the URL does not come in at the parameter the
 * rule reads the request from, or the call is not the shape it relies on.
 */
export function readNamedStep(s, step, hop, keys) {
  const { rule, hop: statement } = step.named;
  if (s.url !== '?' && (s.url.param !== statement.hop.config || s.url.key === null)) return null;
  const call = namedCallOf(hop.call, statement, keys);
  if (call === null) return null;
  return { call, why: namedWhy(s.args ?? [], statement), mark: { rule, step: step.key, prefix: statement.url.prefix } };
}
