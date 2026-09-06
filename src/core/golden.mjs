// golden.mjs — the PROJECT golden corpus (SPEC §14.1, §2.2).
//
// The engine golden (synthetic fixtures under test/) proves the engine still
// does what it did. It cannot prove anything about YOUR repository. The project
// golden is the other half: real ids from a real pack, with a human's approval
// on every one of them, kept under `.cascade/golden/` where the project owns it.
//
// Three rules from §14.1 are load-bearing here, and each is enforced in code
// rather than in a README:
//
//  1. THE TOOL NEVER APPROVES ITSELF. `proposeCases` writes candidates built
//     from the engine's CURRENT answers into `proposed.jsonl` and marks every
//     one `proposed: true`. Only `approveCases` — driven by a human typing
//     `cascade golden approve --ids ...` or an explicit `--all` — moves a case
//     into `cases.jsonl` and stamps `approvedAt`. A proposal is a question, not
//     an answer: it is right by construction, which is exactly why it carries no
//     evidential weight until somebody looks at it.
//
//  2. POSITIVE AND NEGATIVE, ALWAYS. Every case carries `expect.present` (must
//     be in the answer) and `expect.absent` (must NOT be). A corpus of positives
//     only scores recall and calls it quality; the absent list is what makes a
//     precision number mean anything.
//
//  3. WHICH CASES ARE HELD OUT IS DECIDED BY A HASH, NOT BY A PERSON. `sealCases`
//     seals every case whose `sha256(id)` starts below 0x33 (~20%), replacing the
//     labels with a hash. The grader then sees which ids are IN PLAY but not
//     which side they are on, so it cannot be tuned to the easy ones.
//
// Every engine answer is fetched through the MCP dispatcher (`callTool`), never
// through a private walk: the corpus scores the SHIPPED query surface, which is
// the only surface a user or an AI can actually reach.
//
// Pure: the tool dispatcher and the node inventory are injected.

import { sha256, canonicalJson } from './canonical.mjs';

export const GOLDEN_CASE_SCHEMA = 'cascade:golden-case:1';
export const GOLDEN_SUMMARY_SCHEMA = 'cascade:golden-summary:1';

/** The relations this engine can score. */
export const RELATIONS = Object.freeze([
  'column->endpoints', 'endpoint->tables', 'statement->columns', 'method->statements',
]);

/**
 * The §2.2 quality gate each relation borrows its targets from. The mapping is
 * written down here, with the row it came from, because §2.2's table is phrased
 * in terms of relations this engine implements under slightly different names —
 * and an unstated mapping is a threshold nobody can audit.
 *
 * `precision: null` means §2.2 sets no precision target for that row ("—"): the
 * number is still measured and reported, it just does not gate.
 */
export const RELATION_TARGETS = Object.freeze({
  'column->endpoints': Object.freeze({ recall: 0.90, precision: 0.95, specRow: 'changed symbol -> affected endpoints/screens' }),
  'endpoint->tables': Object.freeze({ recall: 0.95, precision: 0.98, specRow: 'endpoint -> directly called methods' }),
  'statement->columns': Object.freeze({ recall: 0.97, precision: null, specRow: 'statement -> column read/write' }),
  'method->statements': Object.freeze({ recall: 0.97, precision: 0.99, specRow: 'method -> mapper/repository statement' }),
});

/** Below this many cases a relation is never scored PASS (SPEC §14.1, §2.2). */
export const MIN_CASES = 30;

/** The Wilson z for a 95% bound (SPEC §2.2 judges on the lower bound, not the point estimate). */
export const WILSON_Z = 1.96;

/** Held-out share: `sha256(id)` first byte below this is sealed (~20%). */
export const HELD_OUT_BYTE = 51;

// ---------------------------------------------------------------------------
// Wilson
// ---------------------------------------------------------------------------

/**
 * Wilson score interval, lower bound. `null` for n === 0 — an empty sample has
 * no bound, and reporting 0 there would read as "measured, and terrible".
 *
 * For k === n the formula collapses to n / (n + z^2), which is the easiest way
 * to check this implementation by hand: 30/30 at z=1.96 is 30/33.8416.
 *
 * @param {number} hits
 * @param {number} n
 * @param {number} [z]
 * @returns {number|null}
 */
export function wilsonLowerBound(hits, n, z = WILSON_Z) {
  const N = Number(n);
  const k = Number(hits);
  if (!Number.isFinite(N) || N <= 0) return null;
  if (!Number.isFinite(k) || k < 0 || k > N) throw new GoldenError(`hits ${hits} out of range 0..${n}`);
  const p = k / N;
  const z2 = z * z;
  const denom = 1 + z2 / N;
  const centre = (p + z2 / (2 * N)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / N + z2 / (4 * N * N))) / denom;
  return Math.max(0, centre - margin);
}

// ---------------------------------------------------------------------------
// Case identity and sealing
// ---------------------------------------------------------------------------

/** A case's id: content-addressed by relation + input, so it never depends on order. */
export function caseId({ relation, input }) {
  if (!RELATIONS.includes(relation)) throw new GoldenError(`unknown relation ${JSON.stringify(relation)}`);
  return sha256(canonicalJson({ relation, input })).slice(0, 16);
}

/** Whether a case id is held out. Decided by the hash — never by a human. */
export function isHeldOut(id) {
  return parseInt(sha256(String(id)).slice(0, 2), 16) < HELD_OUT_BYTE;
}

/** The canonical hash of an expectation. Both sealing and checking go through it. */
export function expectationHash(expect) {
  return sha256(canonicalJson({
    present: [...(expect.present ?? [])].sort(),
    absent: [...(expect.absent ?? [])].sort(),
  }));
}

/**
 * Seal the held-out share of a corpus: the labels are replaced by a hash, and
 * the union of the two lists stays visible as `probes` so the checker knows
 * which ids to classify without being told which side they are on.
 *
 * Deterministic: the same corpus seals to the same bytes every time.
 *
 * @param {Object[]} cases
 * @returns {{cases:Object[], sealed:number}}
 */
export function sealCases(cases) {
  let sealed = 0;
  const out = cases.map((c) => {
    if (c.sealed === true) { sealed += 1; return c; }
    if (!isHeldOut(c.id)) return c;
    sealed += 1;
    const probes = [...new Set([...(c.expect?.present ?? []), ...(c.expect?.absent ?? [])])].sort();
    const { expect, ...rest } = c;
    return { ...rest, sealed: true, probes, expectHash: expectationHash(expect ?? { present: [], absent: [] }) };
  });
  return { cases: out, sealed };
}

// ---------------------------------------------------------------------------
// Asking the engine
// ---------------------------------------------------------------------------

/**
 * The engine's CURRENT answer for one case input, fetched through the shipped
 * MCP tool catalog. Returns the id set plus whether the tool had to truncate —
 * a truncated answer is not an answer, and the caller must not score it.
 *
 * @param {string} relation
 * @param {Object} input
 * @param {(name:string, args:Object)=>Object} ask  bound `callTool`
 * @returns {{ids:string[], truncated:boolean, tool:string}}
 */
export function answerFor(relation, input, ask) {
  switch (relation) {
    case 'column->endpoints': {
      const r = ask('endpoint_impact', { column: input.column, limit: 100 });
      return { ids: sortUnique((r.answer.endpoints ?? []).map((e) => e.id)), truncated: fieldTruncated(r, 'endpoints'), tool: 'endpoint_impact' };
    }
    case 'endpoint->tables': {
      const r = ask('flow', { endpoint: input.endpoint, direction: 'down', limit: 200 });
      return { ids: sortUnique((r.answer.tables ?? []).map((t) => t.table)), truncated: fieldTruncated(r, 'tables'), tool: 'flow' };
    }
    case 'method->statements': {
      // depth 1: the statements this method BINDS (IMPLEMENTS_STMT), not
      // everything its call chain eventually reaches.
      const r = ask('flow', { symbol: input.symbol, direction: 'down', depth: 1, limit: 200 });
      return { ids: sortUnique((r.answer.statements ?? []).map((s) => s.id)), truncated: fieldTruncated(r, 'statements'), tool: 'flow' };
    }
    case 'statement->columns': {
      // `flow` walks endpoints and methods, and `column_impact` answers the
      // inverse question one column at a time, so the only shipped tool that
      // answers "which columns does THIS statement touch" in one call is
      // `neighborhood` at one hop. Still the public catalog, still one call.
      const r = ask('neighborhood', { statement: input.statement, direction: 'down', hops: 1, limit: 800 });
      const ids = (r.answer.nodes ?? []).filter((n) => n.kind === 'column').map((n) => strip(n.id));
      return { ids: sortUnique(ids), truncated: fieldTruncated(r, 'nodes'), tool: 'neighborhood' };
    }
    default:
      throw new GoldenError(`unknown relation ${JSON.stringify(relation)}`);
  }
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/**
 * The candidate pool `proposeCases` samples from, read off a loaded pack. Pure
 * (a Graph in, sorted key lists out) so the sampling is testable without a pack
 * on disk.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @returns {{columns:string[], endpoints:string[], statements:string[],
 *            mapperMethods:string[], tables:string[]}}
 */
export function inventoryOf(graph) {
  const inv = { columns: [], endpoints: [], statements: [], mapperMethods: [], tables: [] };
  if (!graph || !graph.nodes) throw new GoldenError('inventoryOf requires a Graph');
  for (const n of graph.nodes.values()) {
    const key = strip(n.id);
    if (n.kind === 'column') inv.columns.push(key);
    else if (n.kind === 'endpoint') inv.endpoints.push(key);
    else if (n.kind === 'statement') inv.statements.push(key);
    else if (n.kind === 'table') inv.tables.push(key);
    // A mapper method is the symbol that BINDS statements, which is the method
    // the `method -> statement` row of SPEC §2.2 is about.
    if (n.kind === 'symbol' && n.mapperMethod === true) inv.mapperMethods.push(key);
  }
  for (const k of Object.keys(inv)) inv[k].sort();
  return inv;
}

/**
 * Build candidate cases from the engine's current answers — a stratified sample
 * per relation, ordered by a hash seeded with the PACK DIGEST so the same pack
 * always proposes the same cases and nobody can reroll for an easier set.
 *
 * The result is a QUESTION for a human. Every case is marked `proposed: true`
 * and carries no `approvedAt`; `checkCases` refuses to score one.
 *
 * @param {{inventory:{columns:string[], endpoints:string[], statements:string[],
 *          mapperMethods:string[], tables:string[]},
 *          ask:(name:string, args:Object)=>Object, packDigest:string,
 *          perRelation?:number, negatives?:number}} input
 * @returns {{cases:Object[], perRelation:Object, notes:string[]}}
 */
export function proposeCases(input) {
  const { inventory, ask, packDigest } = input;
  if (!inventory || typeof inventory !== 'object') throw new GoldenError('proposeCases requires an inventory');
  if (typeof ask !== 'function') throw new GoldenError('proposeCases requires an `ask` (bound callTool)');
  if (typeof packDigest !== 'string' || packDigest.length === 0) throw new GoldenError('proposeCases requires the pack digest as the sample seed');
  const want = Number.isInteger(input.perRelation) && input.perRelation > 0 ? input.perRelation : MIN_CASES;
  const negatives = Number.isInteger(input.negatives) && input.negatives > 0 ? input.negatives : 2;

  const universe = {
    'column->endpoints': { keys: inventory.columns ?? [], arg: 'column', negativePool: inventory.endpoints ?? [] },
    'endpoint->tables': { keys: inventory.endpoints ?? [], arg: 'endpoint', negativePool: inventory.tables ?? [] },
    'statement->columns': { keys: inventory.statements ?? [], arg: 'statement', negativePool: inventory.columns ?? [] },
    'method->statements': { keys: inventory.mapperMethods ?? [], arg: 'symbol', negativePool: inventory.statements ?? [] },
  };

  const cases = [];
  const perRelation = {};
  const notes = [];
  for (const relation of RELATIONS) {
    const u = universe[relation];
    const ordered = seededOrder(u.keys, `${packDigest}:${relation}`);
    let taken = 0;
    let skippedEmpty = 0;
    let skippedTruncated = 0;
    for (const key of ordered) {
      if (taken >= want) break;
      const caseInput = { [u.arg]: key };
      let a;
      try { a = answerFor(relation, caseInput, ask); } catch { continue; }
      if (a.truncated) { skippedTruncated += 1; continue; }
      if (a.ids.length === 0) { skippedEmpty += 1; continue; }
      const id = caseId({ relation, input: caseInput });
      const absent = pickNegatives(u.negativePool, new Set(a.ids), `${packDigest}:${id}`, negatives);
      if (absent.length === 0) { continue; } // §14.1 wants a pair; a positive-only case is not one
      cases.push({
        schema: GOLDEN_CASE_SCHEMA,
        id,
        relation,
        input: caseInput,
        expect: { present: a.ids, absent },
        proposed: true,
        approvedAt: null,
        proposedFrom: { packDigest, tool: a.tool },
      });
      taken += 1;
    }
    perRelation[relation] = { proposed: taken, candidates: ordered.length, skippedEmpty, skippedTruncated };
    if (taken < want) {
      notes.push(`${relation}: only ${taken} of ${want} candidates could be proposed `
        + `(${ordered.length} in the pack, ${skippedEmpty} answered nothing, ${skippedTruncated} were truncated). `
        + `A relation below ${MIN_CASES} approved cases is scored INSUFFICIENT_SAMPLE, never PASS`);
    }
  }
  cases.sort(byIdThenRelation);
  return { cases, perRelation, notes };
}

/**
 * Move proposals into the approved corpus. This is the ONLY function that
 * stamps `approvedAt`, and it acts on ids a human named (or an explicit
 * `all: true`, which is still a human typing `--all`).
 *
 * @param {Object[]} proposed
 * @param {{ids?:string[], all?:boolean, approvedAt:string}} choice
 * @returns {{approved:Object[], remaining:Object[], unknownIds:string[]}}
 */
export function approveCases(proposed, choice = {}) {
  const all = choice.all === true;
  const ids = new Set(Array.isArray(choice.ids) ? choice.ids : []);
  if (!all && ids.size === 0) throw new GoldenError('approveCases needs --ids <id>... or an explicit --all; it never approves by itself');
  if (typeof choice.approvedAt !== 'string' || choice.approvedAt.length === 0) throw new GoldenError('approveCases requires approvedAt');
  const approved = [];
  const remaining = [];
  for (const c of proposed) {
    if (all || ids.has(c.id)) {
      const { proposed: _p, proposedFrom, ...rest } = c;
      approved.push({ ...rest, approvedAt: choice.approvedAt, proposedFrom: proposedFrom ?? null });
    } else {
      remaining.push(c);
    }
  }
  const known = new Set(proposed.map((c) => c.id));
  return { approved, remaining, unknownIds: [...ids].filter((i) => !known.has(i)).sort() };
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Score every approved case against the engine's current answers.
 *
 * Scoring is per case, not per id: a case counts one recall hit when EVERY id
 * it expects is present, and one precision hit when NONE of the ids it forbids
 * is. That is what makes a Wilson bound over `n` cases mean what §2.2 says it
 * means.
 *
 * A case whose answer had to be truncated is UNSCORABLE and is left out of `n`
 * entirely — scoring it either way would be inventing evidence, and leaving it
 * out can only push a relation towards INSUFFICIENT_SAMPLE, which never passes.
 *
 * @param {Object[]} cases
 * @param {{ask:(name:string, args:Object)=>Object}} deps
 * @returns {{results:Object[], summary:Object}}
 */
export function checkCases(cases, deps = {}) {
  const ask = deps.ask;
  if (typeof ask !== 'function') throw new GoldenError('checkCases requires an `ask` (bound callTool)');
  const results = [];
  for (const c of Array.isArray(cases) ? cases : []) {
    if (!RELATIONS.includes(c.relation)) {
      results.push({ id: c.id, relation: c.relation, status: 'UNSCORABLE', reason: `unknown relation ${JSON.stringify(c.relation)}` });
      continue;
    }
    if (c.proposed === true || !c.approvedAt) {
      results.push({ id: c.id, relation: c.relation, status: 'UNSCORABLE', reason: 'this case is a proposal, not an approved case. A human has to approve it before it can score anything, because a tool that approves its own proposals proves nothing' });
      continue;
    }
    let a;
    try {
      a = answerFor(c.relation, c.input, ask);
    } catch (e) {
      results.push({ id: c.id, relation: c.relation, status: 'FAIL', recallHit: false, precisionHit: false, reason: `the engine could not answer: ${e.message}` });
      continue;
    }
    if (a.truncated) {
      results.push({ id: c.id, relation: c.relation, status: 'UNSCORABLE', reason: `the answer was truncated by the tool's own list cap, so it is not the engine's full answer. This case is left out of n rather than scored on a partial list` });
      continue;
    }
    const got = new Set(a.ids);
    if (c.sealed === true) {
      const probes = [...(c.probes ?? [])];
      const present = probes.filter((p) => got.has(p)).sort();
      const absent = probes.filter((p) => !got.has(p)).sort();
      const hit = expectationHash({ present, absent }) === c.expectHash;
      results.push({
        id: c.id, relation: c.relation, sealed: true,
        status: hit ? 'PASS' : 'FAIL', recallHit: hit, precisionHit: hit,
        reason: hit ? null : 'the sealed expectation hash does not match the engine\'s classification of the probe ids (the labels stay hidden, and only pass/fail is visible)',
      });
      continue;
    }
    const present = [...(c.expect?.present ?? [])];
    const absent = [...(c.expect?.absent ?? [])];
    const missing = present.filter((p) => !got.has(p));
    const forbidden = absent.filter((p) => got.has(p));
    const recallHit = missing.length === 0;
    const precisionHit = forbidden.length === 0;
    results.push({
      id: c.id, relation: c.relation, sealed: false,
      status: recallHit && precisionHit ? 'PASS' : 'FAIL',
      recallHit, precisionHit,
      missing, forbidden,
      reason: recallHit && precisionHit ? null
        : `${missing.length} expected id(s) missing, ${forbidden.length} forbidden id(s) returned`,
    });
  }
  return { results, summary: goldenSummary(results) };
}

/**
 * Aggregate per relation, with the Wilson lower bound against the §2.2 target.
 * Every relation this engine can score appears, even with n = 0 — a relation
 * that is silently absent reads as one that passed.
 *
 * @param {Object[]} results
 * @returns {Object}
 */
export function goldenSummary(results) {
  const relations = {};
  for (const relation of RELATIONS) {
    const rows = (results ?? []).filter((r) => r.relation === relation);
    const scored = rows.filter((r) => r.status !== 'UNSCORABLE');
    const n = scored.length;
    const recallHits = scored.filter((r) => r.recallHit === true).length;
    const precisionHits = scored.filter((r) => r.precisionHit === true).length;
    const targets = RELATION_TARGETS[relation];
    const enough = n >= MIN_CASES;
    const recall = bound(recallHits, n, targets.recall, enough);
    const precision = bound(precisionHits, n, targets.precision, enough);
    // SPEC §2.2, in its own words: "if the sample is small, falling short even
    // with no errors is INSUFFICIENT_SAMPLE". A flawless 30-case relation cannot
    // demonstrate a 95% lower bound — the bound for 30/30 is 0.8865 — and
    // calling that FAIL would blame the engine for the size of the corpus.
    // FAIL is reserved for a relation that actually got something wrong.
    const gated = [recall, precision].filter((b) => b.target != null);
    let status;
    if (!enough) status = 'INSUFFICIENT_SAMPLE';
    else if (gated.every((b) => b.meets)) status = 'PASS';
    else if (gated.every((b) => b.meets || b.perfect)) status = 'INSUFFICIENT_SAMPLE';
    else status = 'FAIL';
    relations[relation] = {
      n, recallHits, precisionHits,
      unscorable: rows.length - n,
      recall, precision, status,
      specRow: targets.specRow,
    };
  }
  const values = Object.values(relations);
  const status = values.some((r) => r.status === 'FAIL') ? 'FAIL'
    : values.some((r) => r.status === 'INSUFFICIENT_SAMPLE') ? 'INSUFFICIENT_SAMPLE' : 'PASS';
  return {
    schema: GOLDEN_SUMMARY_SCHEMA,
    status,
    cases: (results ?? []).length,
    scored: values.reduce((a, r) => a + r.n, 0),
    unscorable: values.reduce((a, r) => a + r.unscorable, 0),
    minCases: MIN_CASES,
    z: WILSON_Z,
    relations,
  };
}

// ---------------------------------------------------------------------------
// JSONL persistence (pure string in / string out)
// ---------------------------------------------------------------------------

/** One case per line, sorted, newline-terminated. */
export function serializeCases(cases) {
  return cases.slice().sort(byIdThenRelation).map((c) => JSON.stringify(c)).join('\n') + (cases.length ? '\n' : '');
}

/** Parse a case file, refusing an unknown schema version (§17.7). */
export function parseCases(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    let obj;
    try { obj = JSON.parse(s); } catch (e) { throw new GoldenError(`golden case file line ${i + 1} is not JSON: ${e.message}`); }
    if (obj.schema !== GOLDEN_CASE_SCHEMA) {
      throw new GoldenError(`golden case file line ${i + 1} has schema ${JSON.stringify(obj.schema)} (expected ${GOLDEN_CASE_SCHEMA})`);
    }
    if (typeof obj.id !== 'string' || !RELATIONS.includes(obj.relation)) {
      throw new GoldenError(`golden case file line ${i + 1} has no id or an unknown relation`);
    }
    out.push(obj);
  });
  return out;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Deterministic order seeded by a string — the same seed always samples the same. */
export function seededOrder(keys, seed) {
  return keys
    .map((k) => ({ k, h: sha256(`${seed}:${k}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.k < b.k ? -1 : 1))
    .map((x) => x.k);
}

function pickNegatives(pool, exclude, seed, count) {
  const out = [];
  for (const k of seededOrder(pool, seed)) {
    if (exclude.has(k)) continue;
    out.push(k);
    if (out.length >= count) break;
  }
  return out.sort();
}

function bound(hits, n, target, enough) {
  const lowerBound = wilsonLowerBound(hits, n);
  const meets = target != null && lowerBound != null && lowerBound >= target;
  return {
    hits, n, lowerBound,
    target: target ?? null,
    // The smallest FLAWLESS corpus that could demonstrate this target, from the
    // k === n closed form n/(n+z^2) >= target. It turns "INSUFFICIENT_SAMPLE"
    // from a shrug into an instruction: approve this many cases.
    nForTarget: target == null ? null : Math.ceil((target * WILSON_Z * WILSON_Z) / (1 - target)),
    perfect: n > 0 && hits === n,
    meets,
    pass: target == null ? null : (enough && meets),
  };
}

/**
 * Whether the ONE list this relation reads was cut. A sibling lane the case does
 * not look at (a `flow` answer's `services` list) hitting its own cap is not a
 * reason to throw the case away.
 */
function fieldTruncated(resp, field) {
  const rows = resp && resp.truncated && Array.isArray(resp.truncated.fields) ? resp.truncated.fields : [];
  const row = rows.find((f) => f.field === field);
  return !!(row && row.nextOffset != null);
}

function sortUnique(list) {
  return [...new Set(list.map((x) => String(x)))].sort();
}

function strip(id) {
  return String(id).slice(String(id).indexOf(':') + 1);
}

function byIdThenRelation(a, b) {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0;
}

export class GoldenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoldenError';
  }
}
