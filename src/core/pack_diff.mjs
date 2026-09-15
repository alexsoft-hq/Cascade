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
import { diffEdgeRecords, diffNodeRecords, materializePackDiff, touchedRows } from './pack_diff_fields.mjs';
import { canonicalJson } from './canonical.mjs';

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
const ANALYSIS_KEYS = new Set(['profileDigest', 'enginePrint', 'engineVersion', 'optOuts', 'sourceRoots', 'flags', 'catalogSnapshot', 'evidence', 'externalSources']);

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
    sourceRoots: a?.selection ? canonicalJson({ ...a.selection, root: undefined }) : null,
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
  if (!a) return { flags: null, catalogSnapshot: null, evidence: null, externalSources: null };
  const ext = a.external ?? null;
  return {
    // Where the profile file sat is not how it was read; `profileDigest` is.
    flags: a.invocation ? canonicalJson({ ...a.invocation, profile: undefined }) : null,
    catalogSnapshot: ext ? String(ext.catalogSnapshot ?? 'none') : null,
    evidence: ext ? (ext.evidence ?? []).join(' ') || 'none' : null,
    // What was read from outside the repository, by content: it changes with no commit.
    externalSources: externalCondition(ext),
  };
}

/** The outside inputs as one comparable string; null (unknown) when there is no record or one of them could not be read. */
function externalCondition(ext) {
  if (!ext?.sources) return null;
  const entries = Object.entries(ext.sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.some(([, d]) => d === 'unreadable')) return null;
  return entries.map(([p, d]) => `${p}=${d}`).join(' ') || 'none';
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
 * Changed records are walked from both packs; additions and head regrades are
 * walked from head, removals and base regrades from base. A frontend change is
 * above no endpoint, which is why the screens are named too.
 */
function touchedEnds(basePack, headPack, nodes, edges) {
  const headStarts = [...edges.added, ...edges.regraded, ...edges.changed].map((edge) => edge.from).concat(nodes.added, nodes.changed.map((node) => node.id));
  const baseStarts = [...edges.removed, ...edges.regraded, ...edges.changed].map((edge) => edge.from).concat(nodes.removedRows.map((node) => node.id), nodes.changed.map((node) => node.id));
  return touchedRows(upstream(basePack, baseStarts), upstream(headPack, headStarts), basePack.nodes.map((node) => node.id), headPack.nodes.map((node) => node.id));
}

/** Whether the two packs are one codebase, and which evidence said so. */
const repositoryLine = (basePack, headPack) => (({ verdict, by }) => ({ verdict, by }))(sameRepository(basePack, headPack));

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
  const nodes = diffNodeRecords(basePack, headPack, conditions.changedAxes, kindRank, axisOf);
  const edges = diffEdgeRecords(basePack, headPack);
  const touched = touchedEnds(basePack, headPack, nodes, edges);
  return materializePackDiff(PACK_DIFF_SCHEMA, basePack, headPack, conditions, nodes, edges, touched, limit, sideOf, repositoryLine(basePack, headPack));
}
