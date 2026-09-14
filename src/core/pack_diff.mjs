// pack_diff.mjs — what changed between two packs of one project, and whether the two can be compared.
//
// WHAT THIS MODULE OWNS. A pull request moves code, and two analyses of the code
// before and after it are two packs. Their difference is the structural change a
// reviewer wants to see: the routes, statements, tables and columns that appeared
// or went away, the calls that appeared, went away or changed grade, and the
// endpoints above any of that. Every node id in a pack is a meaning, not a
// position (`endpoint:GET /x`, `statement:ns.id`, `column:t.c`), so two packs can
// be compared by id with no matching heuristic at all.
//
// A DIFFERENCE IS ONLY A CODE CHANGE WHEN THE ANALYSIS DID NOT CHANGE. The same
// code read by a newer worker, under another profile, with a lane switched off or
// with the catalog missing produces a different pack too, and that difference is
// not in the code. So before any node is counted, the two packs' analysis
// conditions are compared: the lanes, the identity rule, the axes each one
// shipped, the worker versions, the profile digest, the engine, the opt-out flags
// and the source roots. A removal whose axis did not ship on the head side is
// marked as such, because "the catalog was not read" and "the table was dropped"
// look the same in a list of ids. A condition a pack does not record (a pack
// built before this module existed records no worker versions) is said to be
// unknown, never assumed equal.
//
// WHAT IT DOES NOT DO: rename detection (a renamed method is one removal and one
// addition), and any judgement of whether a change is safe.

import { FLOW_EDGE_TYPES } from './graph.mjs';
import { sameRepository } from './repo_identity.mjs';

export const PACK_DIFF_SCHEMA = 'cascade:pack-diff:1';

/** How many ids each list shows by default; the totals are always whole. */
export const PACK_DIFF_LIMIT = 50;

/** The order the node lists read in: the ends of a round trip first. */
const KIND_ORDER = ['endpoint', 'screen', 'table', 'column', 'statement', 'symbol'];

/** Which declared axis a node of each kind is read on. */
const AXIS_OF_KIND = Object.freeze({
  table: 'catalog', column: 'catalog', statement: 'statements', endpoint: 'code', symbol: 'code', screen: 'screen',
});

/** The conditions only `meta.analysis` records; both absent is said once, not per key. */
const ANALYSIS_KEYS = new Set(['profileDigest', 'enginePrint', 'engineVersion', 'optOuts', 'sourceRoots', 'flags', 'catalogSnapshot', 'evidence']);

const idKind = (id) => String(id).slice(0, String(id).indexOf(':'));

/** The axis a node belongs to: a frontend symbol is read on the web axis. */
function axisOf(node) {
  const kind = node.kind ?? idKind(node.id);
  if (kind === 'symbol' && node.lane === 'web') return 'web';
  return AXIS_OF_KIND[kind] ?? null;
}

/** One side's identity line. */
function sideOf(pack) {
  const m = pack.meta ?? {};
  return {
    project: m.project ?? null, digest: pack.digest ?? null, builtAt: m.builtAt ?? null,
    commit: m.base?.commit ?? null, dirty: m.base?.dirty === true,
  };
}

/** What one pack was analyzed under, as flat comparable strings; null means not recorded. */
function conditionsOf(pack) {
  const m = pack.meta ?? {};
  const a = m.analysis ?? null;
  const flat = {
    lanes: Array.isArray(m.lanes) ? [...m.lanes].sort().join(' + ') : null,
    identifierCase: m.identifierCase ?? null,
    profileDigest: a?.profileDigest ?? null,
    enginePrint: a?.enginePrint ?? null,
    engineVersion: a?.engineVersion ?? null,
    optOuts: a ? (a.optOuts ?? []).join(' ') : null,
    // The roots as the project spells them (portable paths, no checkout root): where
    // the checkout sits is not a condition, and a base built in a worktree sits elsewhere.
    sourceRoots: a?.selection ? JSON.stringify({ ...a.selection, root: undefined }) : null,
    ...runConditions(a),
  };
  for (const [k, v] of Object.entries(a?.workers ?? {})) flat[`worker.${k}`] = v;
  for (const [k, v] of Object.entries(m.axes ?? {})) flat[`axis.${k}`] = v?.status ?? null;
  return { flat, recorded: a !== null };
}

/**
 * The lane flags the run was given (the same roots named on the command line and
 * found by discovery are not read the same way: mapper alternatives, for one), and
 * what changes without a commit (a database snapshot, a recording).
 */
function runConditions(a) {
  if (!a) return { flags: null, catalogSnapshot: null, evidence: null };
  const ext = a.external ?? null;
  return {
    // Where the profile file sat is not how it was read; `profileDigest` is.
    flags: a.invocation ? JSON.stringify({ ...a.invocation, profile: undefined }) : null,
    catalogSnapshot: ext ? String(ext.catalogSnapshot ?? 'none') : null,
    evidence: ext ? (ext.evidence ?? []).join(' ') || 'none' : null,
  };
}

/**
 * Whether a condition one pack or both did not record is said as unknown.
 * Recorded on one side only is not a difference: it is a thing nobody knows.
 * Absent on BOTH is said too when both packs record their analysis: two packs
 * that cannot say which flags they were given are not known to agree on them.
 * (When a pack records no analysis at all, one line below says so for all of it.)
 */
const unrecorded = (k, bv, hv, bothRecorded) => bv !== hv || !ANALYSIS_KEYS.has(k) || bothRecorded;

/**
 * Whether the two packs were analyzed the same way, and every way they were not.
 * @returns {{verdict:string, differences:object[], unknown:string[], changedAxes:string[]}}
 */
export function compareConditions(basePack, headPack) {
  const b = conditionsOf(basePack);
  const h = conditionsOf(headPack);
  const keys = [...new Set([...Object.keys(b.flat), ...Object.keys(h.flat)])].sort();
  const differences = [];
  const unknown = [];
  for (const k of keys) {
    const bv = b.flat[k] ?? null;
    const hv = h.flat[k] ?? null;
    if (bv === null || hv === null) { if (unrecorded(k, bv, hv, b.recorded && h.recorded)) unknown.push(k); continue; }
    if (bv !== hv) differences.push({ what: k, base: bv, head: hv });
  }
  if (!b.recorded || !h.recorded) {
    const sides = [!b.recorded && 'base', !h.recorded && 'head'].filter(Boolean);
    unknown.push(`analysis: the ${sides.join(' and ')} ${sides.length > 1 ? 'packs were' : 'pack was'} built before packs recorded their workers, profile and engine`);
  }
  const changedAxes = differences.filter((d) => d.what.startsWith('axis.')).map((d) => d.what.slice('axis.'.length));
  const verdict = differences.length > 0 ? 'different' : unknown.length > 0 ? 'unknown' : 'same';
  return { verdict, differences, unknown, changedAxes };
}

const kindRank = (id) => {
  const i = KIND_ORDER.indexOf(idKind(id));
  return i < 0 ? KIND_ORDER.length : i;
};
const byKindThenId = (a, b) => kindRank(a) - kindRank(b) || (a < b ? -1 : a > b ? 1 : 0);

/** The nodes one side has and the other does not, counted per kind. */
function nodeChanges(basePack, headPack, changedAxes) {
  const baseById = new Map(basePack.nodes.map((n) => [n.id, n]));
  const headById = new Map(headPack.nodes.map((n) => [n.id, n]));
  const added = [...headById.keys()].filter((id) => !baseById.has(id)).sort(byKindThenId);
  const removed = [...baseById.keys()].filter((id) => !headById.has(id)).sort(byKindThenId);
  const byKind = {};
  const bump = (id, field) => {
    const k = idKind(id);
    byKind[k] ??= { added: 0, removed: 0 };
    byKind[k][field] += 1;
  };
  for (const id of added) bump(id, 'added');
  for (const id of removed) bump(id, 'removed');
  const axisChanged = new Set(changedAxes);
  const removedRows = removed.map((id) => {
    const axis = axisOf(baseById.get(id));
    return axis && axisChanged.has(axis) ? { id, axisChanged: axis } : { id };
  });
  const kindsInOrder = Object.fromEntries(Object.keys(byKind).sort((x, y) => kindRank(`${x}:`) - kindRank(`${y}:`) || (x < y ? -1 : 1)).map((k) => [k, byKind[k]]));
  return { added, removedRows, byKind: kindsInOrder };
}

/** An edge's identity: its ends, its type and the rule that drew it. */
const edgeKey = (e) => [e.from, e.to, e.type, e.evidence?.rule ?? ''].join('\n');

/** Every edge of a pack by identity, with the grades its copies carry. */
function edgesByKey(pack) {
  const out = new Map();
  for (const e of pack.edges) {
    const k = edgeKey(e);
    if (!out.has(k)) out.set(k, { from: e.from, to: e.to, type: e.type, rule: e.evidence?.rule ?? null, grades: [] });
    out.get(k).grades.push(e.grade);
  }
  for (const v of out.values()) v.grades.sort();
  return out;
}

/** The edges one side has and the other does not, and the ones whose grade moved. */
function edgeChanges(basePack, headPack) {
  const b = edgesByKey(basePack);
  const h = edgesByKey(headPack);
  const row = (v, grades) => ({ from: v.from, to: v.to, type: v.type, rule: v.rule, grade: grades.join('+') });
  const added = [];
  const removed = [];
  const regraded = [];
  for (const [k, v] of h) {
    const was = b.get(k);
    if (!was) added.push(row(v, v.grades));
    else if (was.grades.join('+') !== v.grades.join('+')) {
      regraded.push({ from: v.from, to: v.to, type: v.type, rule: v.rule, base: was.grades.join('+'), head: v.grades.join('+') });
    }
  }
  for (const [k, v] of b) if (!h.has(k)) removed.push(row(v, v.grades));
  const order = (x, y) => byKindThenId(x.from, y.from) || (x.to < y.to ? -1 : x.to > y.to ? 1 : 0) || (x.type < y.type ? -1 : 1);
  const byType = {};
  const bump = (list, field) => {
    for (const e of list) {
      byType[e.type] ??= { added: 0, removed: 0, regraded: 0 };
      byType[e.type][field] += 1;
    }
  };
  bump(added, 'added'); bump(removed, 'removed'); bump(regraded, 'regraded');
  const typesInOrder = Object.fromEntries(Object.keys(byType).sort().map((k) => [k, byType[k]]));
  return { added: added.sort(order), removed: removed.sort(order), regraded: regraded.sort(order), byType: typesInOrder };
}

/** Upstream over the flow edges of one pack: every node that can reach one of `starts`. */
function upstream(pack, starts) {
  const flow = new Set(FLOW_EDGE_TYPES);
  const into = new Map();
  for (const e of pack.edges) {
    if (!flow.has(e.type)) continue;
    if (!into.has(e.to)) into.set(e.to, []);
    into.get(e.to).push(e.from);
  }
  const seen = new Set(starts);
  const queue = [...starts];
  for (let i = 0; i < queue.length; i += 1) {
    for (const from of into.get(queue[i]) ?? []) {
      if (!seen.has(from)) { seen.add(from); queue.push(from); }
    }
  }
  return seen;
}

/**
 * The endpoints and the screens above the change: on the head side above what
 * was added or regraded, on the base side above what was removed. A frontend
 * change is above no endpoint, which is why the screens are named too.
 */
function touchedEnds(basePack, headPack, nodes, edges) {
  const headStarts = [...edges.added, ...edges.regraded].map((e) => e.from).concat(nodes.added);
  const baseStarts = edges.removed.map((e) => e.from).concat(nodes.removedRows.map((r) => r.id));
  const endpoints = new Set();
  const screens = new Set();
  const take = (id) => {
    if (id.startsWith('endpoint:')) endpoints.add(id);
    else if (id.startsWith('screen:')) screens.add(id);
  };
  for (const id of upstream(headPack, headStarts)) take(id);
  for (const id of upstream(basePack, baseStarts)) take(id);
  return { endpoints: [...endpoints].sort(), screens: [...screens].sort() };
}

/** Whether the two packs are one codebase, and which evidence said so. */
const repositoryLine = (basePack, headPack) => (({ verdict, by }) => ({ verdict, by }))(sameRepository(basePack, headPack));

/** A list cut to `limit`, and the truncation line that says so. */
function cut(field, list, limit) {
  const shown = Math.min(limit, list.length);
  // No paging: a cut list says how much there is, and a larger limit shows it.
  return { shown: list.slice(0, limit), trunc: { field, shown, total: list.length, order: 'kind, id asc', nextOffset: shown < list.length ? shown : null } };
}

/**
 * THE DIFFERENCE between two packs of one project.
 *
 * @param {{nodes:object[], edges:object[], meta:object, digest:string}} basePack
 * @param {{nodes:object[], edges:object[], meta:object, digest:string}} headPack
 * @param {{limit?:number}} [opts]
 */
export function diffPacks(basePack, headPack, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : PACK_DIFF_LIMIT;
  const conditions = compareConditions(basePack, headPack);
  const nodes = nodeChanges(basePack, headPack, conditions.changedAxes);
  const edges = edgeChanges(basePack, headPack);
  const { endpoints, screens } = touchedEnds(basePack, headPack, nodes, edges);
  const lists = [
    cut('nodes.added', nodes.added, limit), cut('nodes.removed', nodes.removedRows, limit),
    cut('edges.added', edges.added, limit), cut('edges.removed', edges.removed, limit),
    cut('edges.regraded', edges.regraded, limit), cut('endpointsTouched', endpoints, limit),
    cut('screensTouched', screens, limit),
  ];
  const [na, nr, ea, er, eg, et, st] = lists;
  return {
    schema: PACK_DIFF_SCHEMA,
    base: sideOf(basePack),
    head: sideOf(headPack),
    samePack: basePack.digest === headPack.digest, repository: repositoryLine(basePack, headPack),
    conditions: { verdict: conditions.verdict, differences: conditions.differences, unknown: conditions.unknown },
    nodes: { added: nodes.added.length, removed: nodes.removedRows.length, byKind: nodes.byKind, addedIds: na.shown, removedIds: nr.shown },
    edges: {
      added: edges.added.length, removed: edges.removed.length, regraded: edges.regraded.length, byType: edges.byType,
      addedList: ea.shown, removedList: er.shown, regradedList: eg.shown,
    },
    endpointsTouched: { total: endpoints.length, ids: et.shown },
    screensTouched: { total: screens.length, ids: st.shown },
    truncated: { any: lists.some((l) => l.trunc.nextOffset !== null), fields: lists.map((l) => l.trunc) },
  };
}
