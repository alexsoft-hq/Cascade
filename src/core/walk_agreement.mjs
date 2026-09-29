// walk_agreement.mjs — one question, one answer: the check that every tool asked
// "what does a change to this column or table reach?" names the same routes and
// the same screens, at the same grades (RM67-J4, design 3).
//
// Three kinds of answer ask it, from two directions:
//   impact   endpoint_impact and screen_impact, a walk UP from the target
//            (`affectedBy`, core/walks.mjs)
//   trace    Trace's picture of the same walk up (`chainWalk`, core/chain.mjs)
//   census   the whole-pack census that browse, the overview and the map count
//            on, a walk DOWN from every route and every screen (`walkEndpoints`,
//            `walkScreens`), read back onto the columns and tables its
//            statements touch (`censusReach`, in the mode asked; browse's rows
//            are held to it in each mode by test/helpers/browse_census.mjs)
// The first two share one walk by construction; the census is a different walk
// in the other direction and agrees only if the two rule sets are mirrors. This
// module runs all three over every column and table of a graph and names every
// row one of them has and another lacks, or grades otherwise. The suite runs it
// on the fixture trees and on the real packs it has (test/walks_review4.test.mjs,
// test/golden_answers.test.mjs), so a rule added to one walk and not the other
// fails a test instead of reaching a reader as two answers.
//
// A target whose walk stopped at the node cap is counted apart (`capped`): the
// answers there are lower bounds, each says so, and they need not be equal.
//
// Pure: graph in, plain report out.

import { chainWalk } from './chain.mjs';
import { sqlEdgesOf } from './graph.mjs';
import { affectedBy, walkEndpoints, walkScreens } from './walks.mjs';

const RANK = Object.freeze({ UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 });
const weaker = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** The census read back onto the schema: target id -> row id -> the strongest grade it is reached at. */
function censusByTarget(graph, rows, mode) {
  const out = new Map();
  const keep = (target, row, grade) => {
    let m = out.get(target);
    if (!m) out.set(target, m = new Map());
    const prev = m.get(row);
    if (prev === undefined || RANK[grade] > RANK[prev]) m.set(row, grade);
  };
  for (const r of rows) {
    for (const s of r.statements) {
      for (const e of sqlEdgesOf(graph, s.id, mode)) keep(e.to, r.id, weaker(s.grade, e.grade));
    }
  }
  return out;
}

/**
 * The whole-pack census in one mode, read back onto the schema: for every
 * column and table, the routes and the screens whose walk down reaches a
 * statement that touches it, each at the strongest grade it is reached at.
 * The impact tools are held to it below, and `browse` counts its table and
 * column rows on it in the same mode (test/browse_modes.test.mjs holds the two
 * to one number per row). `capped` says a walk stopped at the node cap.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {'strict'|'conservative'|'heuristic'} [mode]
 * @returns {{endpoints:Map<string,Map<string,string>>, screens:Map<string,Map<string,string>>, capped:boolean}}
 */
export function censusReach(graph, mode = 'conservative') {
  const eps = walkEndpoints(graph, { mode });
  const scr = walkScreens(graph, { mode });
  return {
    endpoints: censusByTarget(graph, eps.endpoints, mode),
    screens: censusByTarget(graph, scr.screens, mode),
    capped: eps.walk.nodeCapStarts + scr.walk.nodeCapStarts > 0,
  };
}

/** Every difference between two answers to one question, as the rows one has and the other lacks or grades otherwise. */
function differences(a, b) {
  const out = [];
  for (const [id, g] of a) if (!b.has(id)) out.push({ id, only: 'first', grade: g }); else if (b.get(id) !== g) out.push({ id, grades: [g, b.get(id)] });
  for (const [id, g] of b) if (!a.has(id)) out.push({ id, only: 'second', grade: g });
  return out;
}

/**
 * Run the three answers over every column and table and report where they part.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{mode?:'strict'|'conservative'|'heuristic', limit?:number}} [opts]
 *        limit: how many disagreements to keep in full (all are counted)
 * @returns {{mode:string, targets:number, capped:number, disagreements:number,
 *            examples:{target:string, what:string, rows:object[]}[]}}
 */
export function walkAgreement(graph, opts = {}) {
  const mode = opts.mode ?? 'conservative';
  const limit = opts.limit ?? 20;
  const census = censusReach(graph, mode);
  const report = { mode, targets: 0, capped: 0, disagreements: 0, examples: [] };
  const say = (target, what, rows) => {
    if (rows.length === 0) return;
    report.disagreements += 1;
    if (report.examples.length < limit) report.examples.push({ target, what, rows: rows.slice(0, 5) });
  };
  for (const n of graph.nodes.values()) {
    if (n.kind !== 'column' && n.kind !== 'table') continue;
    report.targets += 1;
    const impact = affectedBy(graph, n.id, { mode });
    const trace = chainWalk(graph, { start: n.id, direction: 'up', mode });
    if (impact.cut.nodeCap || trace.cut.nodeCap || census.capped) { report.capped += 1; continue; }
    const im = { ep: new Map(impact.endpoints.map((e) => [e.endpoint, e.pathGrade])), sc: new Map(impact.screens.map((s) => [s.screen, s.pathGrade])) };
    const tr = { ep: new Map(trace.endpoints.map((e) => [`endpoint:${e.id}`, e.grade])), sc: new Map(trace.screens.map((s) => [`screen:${s.id}`, s.grade])) };
    say(n.id, 'endpoints: impact vs trace', differences(im.ep, tr.ep));
    say(n.id, 'screens: impact vs trace', differences(im.sc, tr.sc));
    say(n.id, 'endpoints: impact vs census', differences(im.ep, census.endpoints.get(n.id) ?? new Map()));
    say(n.id, 'screens: impact vs census', differences(im.sc, census.screens.get(n.id) ?? new Map()));
  }
  return report;
}
