// chain.mjs — what reaches the client along a wrapper chain, walked hop by hop.
//
// WHAT THIS MODULE OWNS. A call through the project's own wrappers
// (`api.get({ url })` -> `request(...)` -> `service(...)`) sends what the LAST
// call sends, and three things in it come from the caller or from a step on the
// way: the URL, the method and the base URL (review 2 item 2, review 3 R1 and
// R3). Each is followed the same way. It sits somewhere in the current step's
// parameters (a PLACE: a parameter, and the key it is under when it is in an
// object); a step's HANDS (worker lib/origins.mjs) move it into the next
// step's parameters or drop it; a step's SETS (lib/sets.mjs) write the method
// or the base URL over it, or write a default the thing handed in replaces.
// Where the code does not settle whether a step hands it on (a variable
// assigned again, a key the function writes, an object handed to another
// call, an expression on it: lib/reads.mjs, lib/writes.mjs), it is followed no
// further and the step is named: the edge is HEURISTIC and says why.
//
// A step that makes more than one client call (`if (o.upload) return axios({
// ...o, method: 'POST' }); return axios({ ...o, method: 'GET' })`) is walked
// once per call, and what the request may be is every answer one of them
// gives. A step whose calls lead on to different clients is not followed
// branch by branch: the edge says so.
//
// A step a rule pack names (`web.wrapper-hop`) is read as the rule says
// (named_hop.mjs), and the edge names the rule and the step.
//
// WHAT IT MUST NEVER KNOW ABOUT: files, bindings, routes. It is handed the
// steps (src/adapters/web/calls.mjs traced them) and the caller's record, and
// answers with what arrives.

import { argumentsInto, readNamedStep } from './named_hop.mjs';

/** The HTTP verbs a caller's or a step's object can name. */
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** Argument summaries that may carry keys nobody wrote here: a name, a member, a call, anything else. */
const CARRIERS = new Set(['ident', 'member', 'call', 'other']);

/** How many ways through a branching chain are walked before the rest are said to be not followed. */
const WAYS = 16;

/**
 * WHY A STEP THE CODE DOES NOT SETTLE MAY STILL CARRY THE URL, the method or
 * the base URL, by what the worker saw there. The edge of a call through such
 * a step names the step, the key, and one of these, and is graded HEURISTIC.
 */
export const UNSETTLED_BECAUSE = Object.freeze({
  reassigned: 'a step of the wrapper chain passes the request through a variable it assigns again (a let, a var, a parameter written over), so what reaches the client is not what the code first put in it',
  this: 'a step of the wrapper chain passes the request through `this`, which may or may not hold what the caller gave',
  arguments: 'a step of the wrapper chain passes `arguments`, which may or may not hold what the caller gave',
  unbound: 'a step of the wrapper chain passes a name with no value written beside it (a callback\'s parameter, a function), which may or may not hold what the caller gave',
  deep: 'a step of the wrapper chain reaches the argument through more locals than this lane follows',
  computed: 'a step of the wrapper chain passes the argument through an expression this lane does not evaluate (a call on it, a value built from it)',
  unrecorded: 'a step of the wrapper chain is a return or a call whose arguments this lane did not read',
  written: 'a step of the wrapper chain writes the key on the object it hands on (an assignment, `delete`, `Object.assign`), so what arrives is not only what the caller gave',
  handed: 'a step of the wrapper chain also hands the object to another call, which may change it',
  branches: 'a step of the wrapper chain makes calls that lead on to different clients, and which one runs is not settled by the code',
  'request-base': 'the request carries a base URL of its own that is not a path this lane can read, so where it goes is not settled',
  'hop-option': 'a wrapper step a rule pack names puts a prefix before the URL that the request options decide, and this call hands it options that set, or may set, one of those keys (`option`, null when which is not known), so where it goes is not settled',
  'hop-append': 'a wrapper step a rule pack names appends a key of the request to the URL when that key holds text (`from`), and this call may hand it text there, so the path it asks for may be longer than the one written',
});

/** A method a summary or a set spells, upper-cased, or null. */
const verbOf = (v) => {
  const s = typeof v === 'string' ? v : (v && v.kind === 'string' ? v.value : null);
  return s !== null && HTTP_VERBS.has(s.toUpperCase()) ? s.toUpperCase() : null;
};
/** A base URL a summary or a set spells, or null. */
const textOf = (v) => (typeof v === 'string' ? v : (v && v.kind === 'string' ? v.value : null));

/**
 * What the CALLER hands in under one of `names`: the places a key sits (an
 * object that writes it, or an argument that may carry it: a name, a call, an
 * object with a spread), and its value when every one of them states the same.
 * The argument that IS the URL carries no key.
 * @returns {{value:(string|null), from:string, places:object[]}|null} null when no argument can carry it
 */
function carriedFrom(c, names, valueOf) {
  const places = [];
  const values = new Set();
  let maybe = false;
  const url = c.url && c.url.at && typeof c.url.at.key !== 'string' ? c.url.at.arg : null;
  (Array.isArray(c.args) ? c.args : []).forEach((a, i) => {
    const got = a && typeof a === 'object' && i !== url ? placeOfArgument(a, i, names, valueOf) : null;
    if (got === null) return;
    places.push(got.place);
    if (got.value === null) maybe = true; else values.add(got.value);
  });
  if (places.length === 0) return null;
  return maybe || values.size !== 1 ? { value: null, from: 'absent', places } : { value: [...values][0], from: 'config', places };
}

/**
 * Where ONE argument of the caller may hold a method or a base URL, and what
 * it is (null when not stated): under a key its object writes, anywhere in a
 * name or a spread, or the argument itself when it is one written out
 * (`req('/items', 'DELETE')`), which a step may put under the key (review 4, W-11).
 */
function placeOfArgument(a, i, names, valueOf) {
  const k = a.kind === 'object' ? names.find((n) => a.keys && a.keys[n] !== undefined) : undefined;
  if (k !== undefined) return { place: { param: i, key: k }, value: a.spread === true ? null : valueOf(a.keys[k]) };
  if ((a.kind === 'object' && a.spread === true) || CARRIERS.has(a.kind)) return { place: { param: i, key: names[0] }, value: null };
  const own = a.kind === 'string' ? valueOf(a) : null;
  return own === null ? null : { place: { param: i, key: null }, value: own };
}

/** The key a hand's carry rests on, and whether the function wrote it or handed the object elsewhere. */
function writtenHit(place, h) {
  const k = h.as === 'member' ? h.key : (h.part ?? place.key);
  if (k === null || k === undefined) return null;
  if (h.handed) return { why: 'handed', key: k };
  const w = h.written ?? [];
  return w.includes(k) || w.includes('*') ? { why: 'written', key: k } : null;
}

/**
 * Where ONE hand puts what sits at `place`. Passed whole or spread in, it keeps
 * its key; passed as one key of an object, it gains that key; `options.url`
 * passed as a value loses it. A rest or a copy carries every key but the ones
 * it names (`minus`); a part carries its own key (`part`) and nothing else.
 * When what is followed is the parameter itself, only the parameter carries it.
 */
function handOnOne(place, h) {
  if (place.key === null) {
    if (h.minus || h.part !== undefined) return null;
    if (h.as === 'argument') return { param: h.arg, key: null };
    return h.as === 'key' ? { param: h.arg, key: h.key } : null;
  }
  if ((h.minus ?? []).includes(place.key)) return null;
  if (h.as === 'member') return h.key === place.key ? { param: h.arg, key: null } : null;
  if (h.as === 'key') return h.part === place.key ? { param: h.arg, key: h.key } : null;
  return h.as === 'argument' || h.as === 'spread' ? { param: h.arg, key: place.key } : null;
}

/** Whether what one bucket of a step's reads (lib/reads.mjs) takes of the parameters could carry `place`. */
function bucketWhy(b, place, top) {
  if (b.open) return { why: b.open.why ?? 'unbound', ...(b.open.name ? { name: b.open.name } : {}) };
  if ((b.params ?? []).includes(place.param)) return { why: 'computed' };
  const part = (b.partial ?? []).some((r) => r.param === place.param && (!top
    || (r.key !== undefined ? r.key === place.key : place.key !== null && !r.minus.includes(place.key))));
  return part ? { why: 'computed' } : null;
}

/** Why a step whose hands do not carry `place` may still carry it; null when it dropped it. */
function readsWhy(reads, place) {
  if (!reads) return null;
  const top = bucketWhy(reads, place, true);
  if (top !== null) return top;
  for (const [k, b] of Object.entries(reads.under ?? {})) {
    const why = place.key === null || k === place.key ? bucketWhy(b, place, false) : null;
    if (why !== null) return why;
  }
  return null;
}

/**
 * WHERE ONE STEP PUTS WHAT SITS AT `place`: the place in the next step's
 * parameters (`to`), `'?'` and why when the code does not settle it, or null
 * when the step dropped it.
 */
function follow(place, call) {
  let hit = null;
  for (const h of call.hands ?? []) {
    const next = h.param === place.param ? handOnOne(place, h) : null;
    if (next === null) continue;
    const w = writtenHit(place, h);
    if (w === null) return { to: next };
    hit = hit ?? w;
  }
  if (hit !== null) return { to: '?', why: hit };
  const why = readsWhy(call.reads, place);
  return why === null ? null : { to: '?', why };
}

/** What a method or a base URL holds once a step may have changed it without saying to what. */
const unknownItem = () => ({ value: null, from: 'absent', places: '?' });

/** A method or a base URL moved through one step: every place it sits, followed. */
function moveItem(item, call, key) {
  if (item === null || item.places === '?') return { item, why: null };
  const places = [];
  for (const p of item.places) {
    const r = follow(p, call);
    if (r === null) continue;
    // A step that does not settle what it hands on may have changed this key too (review 4, W-5).
    if (r.to === '?') return { item: unknownItem(), why: { ...r.why, key } };
    places.push(r.to);
  }
  return { item: places.length > 0 ? { ...item, places } : null, why: null };
}

/**
 * Why a step may put a method or a base URL (`names`, said as `key`) into what
 * it hands on without the code saying which (review 4, W-1 and W-5), or null:
 * a hand whose object it hands to another call, or writes under one of them
 * or under a key it cannot name, or a URL it passes through something it
 * computes. Then what arrives is not known, even when nothing was carried in:
 * no method is the library's default unless nothing on the way may have
 * written one.
 */
function mayWrite(call, names, url, { label: key, at }) {
  for (const h of call.hands ?? []) {
    // The caller's URL handed on whole is text: no method or base URL is in it.
    if (at !== '?' && at.key === null && h.param === at.param) continue;
    if (h.handed) return { why: 'handed', key };
    if ((h.written ?? []).some((k) => k === '*' || names.includes(k))) return { why: 'written', key };
  }
  return url.to === '?' && url.why !== null && url.why.why !== 'written' ? url.why : null;
}

/**
 * What a default written before a spread becomes: `unknown` when what is
 * spread is not settled, `replaced` by what came in at that spread, or `kept`.
 */
function underDefault(before, moved, x) {
  if (x.other || (moved !== null && moved.places === '?' && moved.value === null)) return 'unknown';
  const over = before && before.places !== '?' ? before.places.some((p) => (x.by ?? []).includes(p.param)) : before !== null;
  if (!over) return 'kept';
  return before.value === null ? 'unknown' : 'replaced';
}

/**
 * A key a step writes after everything it spreads: the string it writes, or,
 * when it writes what it was handed at one parameter (`method: m`, `method:
 * o.method`), what the caller put there, if the walk carried it that far and
 * the step settles the object (review 4, W-11). Anything else is not stated.
 */
function definiteSet(before, moved, x, value, places) {
  if (value !== null) return { value, from: 'wrapper-verb', places };
  const settled = moved === null || moved.places !== '?';
  const here = x.param !== undefined && settled && before !== null && before.places !== '?'
    && before.places.some((p) => p.param === x.param && (p.key ?? null) === (x.part ?? null));
  if (here && before.value !== null) return { value: before.value, from: before.from, places };
  return { value: null, from: 'absent', written: x.from === 'spread' ? 'spread' : 'variable', places };
}

/**
 * WHAT ONE STEP WRITES over a method or a base URL (lib/sets.mjs). Written
 * after everything it spreads, it is what goes on; written before a spread of
 * one of its parameters, it is a default what was handed in at that parameter
 * replaces; with anything else spread after it, what goes on is not settled.
 * At the client call, the verb its method name says (`axios.get`) is the method.
 * A spread of an object this lane does not read is a set whose value is not
 * known (review 4, W-4): it may carry the key.
 */
function applySets(before, moved, call, names, valueOf, verb) {
  if (verb) return { value: verb, from: 'library-verb', places: '?' };
  const sets = (call.sets ?? []).filter((x) => names.includes(x.key));
  if (sets.length === 0) return moved;
  const x = sets[sets.length - 1];
  const value = x.value === null ? null : valueOf(x.value);
  const places = [{ param: x.arg, key: x.key }];
  if (!x.by && !x.other) return definiteSet(before, moved, x, value, places);
  const under = underDefault(before, moved, x);
  if (under === 'unknown') return { value: null, from: 'absent', ...(value ? { wrapperDefault: value } : {}), places };
  if (under === 'replaced') return { value: before.value, from: before.from, places };
  return value === null ? { value: null, from: 'absent', places } : { value, from: 'wrapper-default', places };
}

/** One item through one step: moved by the hands, made unknown by a write the step does not settle, then written over by its sets. */
function itemOver(item, call, url, spec) {
  const moved = moveItem(item, call, spec.label);
  const unsure = mayWrite(call, spec.names, url, spec);
  const out = applySets(item, unsure ? unknownItem() : moved.item, call, spec.names, spec.valueOf, spec.verb);
  // The reason goes on the edge only while the step's own sets leave the item unknown.
  return { item: out, why: moved.why ?? (unsure && out !== null && out.value === null ? unsure : null) };
}

/** One way through one step: every item moved and written, or null when the URL was dropped. */
function stepOver(s, step, hop, keys) {
  const call = hop.call;
  const at = { hop: step.key, ...(call && Number.isInteger(call.line) ? { line: call.line } : {}) };
  if (call === null || (!call.reads && !Array.isArray(call.hands))) {
    return { url: '?', why: s.why ?? { ...at, why: 'unrecorded' }, method: unknownItem(), base: keys.base ? unknownItem() : null };
  }
  let url = { to: '?', why: null };
  if (s.url !== '?') url = follow(s.url, call);
  if (url === null) return null;
  const method = itemOver(s.method, call, url, { label: 'method', names: keys.method, valueOf: verbOf, verb: step.last ? hop.verb : null, at: s.url });
  const base = keys.base ? itemOver(s.base, call, url, { label: keys.base, names: [keys.base], valueOf: textOf, verb: null, at: s.url }) : { item: null, why: null };
  const why = s.why ?? [url.why && { key: s.url.key ?? 'url', ...url.why }, method.why, base.why].find(Boolean) ?? null;
  return { url: url.to, why: why && !why.hop ? { ...at, ...why } : why, method: method.item, base: base.item };
}

/** What the client reads of an item that arrived: only one sitting in the object it takes its options from. */
function arrived(item, url, keys, names) {
  if (item === null || item.places === '?' || url === '?') return item;
  const options = url.key !== null ? url.param : (keys.optionsArg ?? url.param + 1);
  // Under one of the keys the client reads it from: a value a step put under
  // another key, or an argument that IS a verb, is not what it reads.
  return item.places.some((p) => p.param === options && names.includes(p.key)) ? item : null;
}

/** The caller's request, where the walk starts: its URL's place, the method and base URL it carries, and what each argument holds. */
function startOf(c, keys) {
  const at = c.url.at;
  return {
    url: { param: at.arg, key: typeof at.key === 'string' ? at.key : null },
    why: null,
    method: carriedFrom(c, keys.method, verbOf),
    base: keys.base ? carriedFrom(c, [keys.base], textOf) : null,
    args: Array.isArray(c.args) ? c.args : [],
  };
}

/**
 * One way through one step. A step a rule pack names is read as the rule says
 * (named_hop.mjs), where its call has the shape the rule relies on; why the
 * rule does not settle this call goes on the edge like any other step's.
 */
function stepThrough(s, step, hop, keys) {
  const named = step.named ? readNamedStep(s, step, hop, keys) : null;
  const r = stepOver(s, step, named ? { ...hop, call: named.call } : hop, keys);
  if (r === null) return null;
  const line = hop.call && Number.isInteger(hop.call.line) ? { line: hop.call.line } : {};
  const why = r.why ?? (named && named.why ? { hop: step.key, ...line, ...named.why } : null);
  const marks = [...(s.named ?? []), ...(named ? [named.mark] : [])];
  return { ...r, why, args: hop.call ? argumentsInto(s.args ?? [], hop.call) : [], ...(marks.length > 0 ? { named: marks } : {}) };
}

/** The steps rule packs named on the way, each once, in a fixed order. */
function namedOf(states) {
  const seen = new Map();
  for (const s of states) for (const m of s.named ?? []) seen.set(JSON.stringify(m), m);
  return seen.size > 0 ? { named: [...seen.keys()].sort().map((k) => seen.get(k)) } : {};
}

/** Every way through, reduced to what the request may carry. */
function finish(states, keys) {
  const why = states.map((s) => s.why).find(Boolean) ?? null;
  const methods = [];
  const bases = new Set();
  for (const s of states) {
    const m = arrived(s.method, s.url, keys, keys.method);
    if (!methods.some((x) => JSON.stringify(x) === JSON.stringify(m))) methods.push(m);
    const b = arrived(s.base, s.url, keys, [keys.base]);
    bases.add(b === null ? null : (b.value ?? '?'));
  }
  const unknownMethod = methods.find((m) => m !== null && m.value === null);
  const base = bases.size === 1 ? [...bases][0] : '?';
  const readable = base === null || (typeof base === 'string' && base.startsWith('/'));
  return {
    reached: true,
    why: why ?? (readable ? null : { hop: null, why: 'request-base', key: keys.base }),
    methods: unknownMethod ? [unknownMethod] : methods,
    ...(readable && base !== null ? { base } : {}),
  };
}

/**
 * THE CALLER'S REQUEST, WALKED TO THE CLIENT. `steps` are the wrapper chain's
 * steps from the one the caller named to the one that calls the client, each
 * with the calls it may make (`hops`, each with the verb its client call names
 * when it is the last step) and how many other calls lead on to a different
 * client (`forks`). `keys` are the client's: the method keys it reads, its
 * base URL key, and the argument it takes options from when the URL comes
 * alone.
 * @returns {{reached:false}|{reached:true, why:(object|null), methods:(object|null)[], base?:string}}
 *          `methods` holds null for "no method arrives, the client's default"
 */
export function walkChain(steps, c, keys) {
  let states = [startOf(c, keys)];
  for (const step of steps) {
    const next = [];
    for (const s of states) {
      for (const hop of step.hops) {
        const r = stepThrough(s, step, hop, keys);
        if (r !== null) next.push(step.forks > 0 && !r.why ? { ...r, why: { hop: step.key, why: 'branches' } } : r);
      }
    }
    const seen = new Set();
    states = next.filter((s) => { const k = JSON.stringify(s); return !seen.has(k) && seen.add(k); });
    if (states.length === 0) return { reached: false };
    if (states.length > WAYS) states = states.slice(0, WAYS).map((s) => ({ ...s, why: s.why ?? { hop: step.key, why: 'branches' } }));
  }
  return { ...finish(states, keys), ...namedOf(states) };
}
