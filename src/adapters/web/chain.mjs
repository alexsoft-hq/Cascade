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
// WHAT IT MUST NEVER KNOW ABOUT: files, bindings, routes. It is handed the
// steps (src/adapters/web/calls.mjs traced them) and the caller's record, and
// answers with what arrives.

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
    if (!a || typeof a !== 'object' || i === url) return;
    const k = a.kind === 'object' ? names.find((n) => a.keys && a.keys[n] !== undefined) : undefined;
    if (k !== undefined) {
      places.push({ param: i, key: k });
      const v = valueOf(a.keys[k]);
      if (v === null || a.spread === true) maybe = true; else values.add(v);
    } else if ((a.kind === 'object' && a.spread === true) || CARRIERS.has(a.kind)) {
      places.push({ param: i, key: names[0] });
      maybe = true;
    }
  });
  if (places.length === 0) return null;
  return maybe || values.size !== 1 ? { value: null, from: 'absent', places } : { value: [...values][0], from: 'config', places };
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

/** A method or a base URL moved through one step: every place it sits, followed. */
function moveItem(item, call, key) {
  if (item === null || item.places === '?') return { item, why: null };
  const places = [];
  for (const p of item.places) {
    const r = follow(p, call);
    if (r === null) continue;
    if (r.to === '?') return { item: { ...item, places: '?' }, why: { ...r.why, key } };
    places.push(r.to);
  }
  return { item: places.length > 0 ? { ...item, places } : null, why: null };
}

/**
 * WHAT ONE STEP WRITES over a method or a base URL (lib/sets.mjs). Written
 * after everything it spreads, it is what goes on; written before a spread of
 * one of its parameters, it is a default what was handed in at that parameter
 * replaces; with anything else spread after it, what goes on is not settled.
 * At the client call, the verb its method name says (`axios.get`) is the method.
 */
function applySets(before, moved, call, names, valueOf, verb) {
  if (verb) return { value: verb, from: 'library-verb', places: '?' };
  const sets = (call.sets ?? []).filter((x) => names.includes(x.key));
  if (sets.length === 0) return moved;
  const x = sets[sets.length - 1];
  const value = x.value === null ? null : valueOf(x.value);
  const places = [{ param: x.arg, key: x.key }];
  if (!x.by && !x.other) return value === null ? { value: null, from: 'absent', written: 'variable', places } : { value, from: 'wrapper-verb', places };
  const over = before && before.places !== '?' ? before.places.some((p) => (x.by ?? []).includes(p.param)) : before !== null;
  if (x.other || (over && before.value === null)) return { value: null, from: 'absent', ...(value ? { wrapperDefault: value } : {}), places };
  if (over) return { value: before.value, from: before.from, places };
  return value === null ? { value: null, from: 'absent', places } : { value, from: 'wrapper-default', places };
}

/** One way through one step: every item moved and written, or null when the URL was dropped. */
function stepOver(s, step, hop, keys) {
  const call = hop.call;
  const at = { hop: step.key, ...(call && Number.isInteger(call.line) ? { line: call.line } : {}) };
  if (call === null || (!call.reads && !Array.isArray(call.hands))) {
    const unknown = (item) => (item === null ? null : { ...item, places: '?' });
    return { url: '?', why: s.why ?? { ...at, why: 'unrecorded' }, method: unknown(s.method), base: unknown(s.base) };
  }
  let url = { to: '?', why: null };
  if (s.url !== '?') url = follow(s.url, call);
  if (url === null) return null;
  const method = moveItem(s.method, call, 'method');
  const base = moveItem(s.base, call, keys.base);
  const why = s.why ?? [url.why && { key: s.url.key ?? 'url', ...url.why }, method.why, base.why].find(Boolean) ?? null;
  return {
    url: url.to,
    why: why && !why.hop ? { ...at, ...why } : why,
    method: applySets(s.method, method.item, call, keys.method, verbOf, step.last ? hop.verb : null),
    base: keys.base ? applySets(s.base, base.item, call, [keys.base], textOf, null) : null,
  };
}

/** What the client reads of an item that arrived: only one sitting in the object it takes its options from. */
function arrived(item, url, keys) {
  if (item === null || item.places === '?' || url === '?') return item;
  const options = url.key !== null ? url.param : (keys.optionsArg ?? url.param + 1);
  return item.places.some((p) => p.param === options) ? item : null;
}

/** Every way through, reduced to what the request may carry. */
function finish(states, keys) {
  const why = states.map((s) => s.why).find(Boolean) ?? null;
  const methods = [];
  const bases = new Set();
  for (const s of states) {
    const m = arrived(s.method, s.url, keys);
    if (!methods.some((x) => JSON.stringify(x) === JSON.stringify(m))) methods.push(m);
    const b = arrived(s.base, s.url, keys);
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
  const at = c.url.at;
  let states = [{
    url: { param: at.arg, key: typeof at.key === 'string' ? at.key : null },
    why: null,
    method: carriedFrom(c, keys.method, verbOf),
    base: keys.base ? carriedFrom(c, [keys.base], textOf) : null,
  }];
  for (const step of steps) {
    const next = [];
    for (const s of states) {
      for (const hop of step.hops) {
        const r = stepOver(s, step, hop, keys);
        if (r !== null) next.push(step.forks > 0 && !r.why ? { ...r, why: { hop: step.key, why: 'branches' } } : r);
      }
    }
    const seen = new Set();
    states = next.filter((s) => { const k = JSON.stringify(s); return !seen.has(k) && seen.add(k); });
    if (states.length === 0) return { reached: false };
    if (states.length > WAYS) states = states.slice(0, WAYS).map((s) => ({ ...s, why: s.why ?? { hop: step.key, why: 'branches' } }));
  }
  return finish(states, keys);
}
