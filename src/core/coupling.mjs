// coupling.mjs — "which API group WRITES what another API group READS?"
//
// The screen this answers is a module × module matrix of DB sharing: in a system
// whose modules talk through one shared database rather than through calls, two
// modules are coupled when one writes a column (or table) the other reads —
// nothing in the call graph shows that link, and nothing in the schema does either.
//
// A "module" here is the API GROUP: the first path segment of an endpoint
// (`/product/update/{id}` → `product`, an empty path → `(root)`). That is a
// naming convention, not a declared boundary — said out loud in the tool's
// `limits` rather than presented as architecture.
//
// ATTRIBUTION IS BY REACHABILITY, and that is the honest cost of this view: a
// statement belongs to EVERY group whose endpoints can reach it (the same
// forward flow walk the Flow tab draws — the SAME walk, but not the same depth:
// this view walks depth 8 by default, the Flow tab 6). A
// statement behind a service two groups share is therefore counted for both —
// which is why `sharedStatements` (reached by ≥3 groups) is part of the answer:
// the fan-out is disclosed, not hidden.
//
// Same-group pairs (a writes it, a reads it) are NOT coupling between modules;
// they are counted apart as `selfOnly`, so the matrix never inflates its own
// diagonal into a finding.
//
// Pure: graph in, plain view model out — no contract, no paging, no DOM.

import { walkEndpoints, groupOfPath, ROOT_GROUP } from './walks.mjs';
import { GRADE_SETS } from './graph.mjs';

// The endpoint walk and the group rule live in core/walks.mjs — the `map` view
// runs the SAME walk over the same endpoints, so keeping it here would let two
// whole-pack views drift apart about what an endpoint reaches. Re-exported so
// this module stays the one import a caller of the matrix needs.
export { groupOfPath, ROOT_GROUP };

/** A statement reached by this many groups or more is a shared/fan-out statement. */
export const SHARED_AT = 3;
/** A pair names at most this many of the shared statements its items rest on. */
export const SHARED_VIA_CAP = 5;

/**
 * Build the group × group DB-sharing matrix.
 *
 * @param {import('./graph.mjs').Graph} graph
 * @param {{axis?:'column'|'table', mode?:'strict'|'conservative'|'heuristic',
 *           depth?:number, maxNodes?:number}} [opts]
 * @returns {{axis:string, mode:string, depth:number,
 *            groups:{group:string,endpoints:number,writes:number,reads:number}[],
 *            pairs:{writer:string,reader:string,count:number,items:string[],
 *                   viaShared:number,sharedVia:string[]}[],
 *            sharedStatements:{statement:string,groups:number}[],
 *            walk:{starts:number,depthCut:number,depthCutStarts:number,nodeCapStarts:number,byMode:number},
 *            unknownAccess:number,
 *            summary:{items:number,coupledItems:number,selfOnlyItems:number,writeOnlyItems:number,
 *                     readOnlyItems:number,groups:number,participatingGroups:number,
 *                     sharedStatements:number,statements:number,endpoints:number}}}
 */
export function buildCoupling(graph, opts = {}) {
  const axis = opts.axis ?? 'column';
  if (axis !== 'column' && axis !== 'table') throw new CouplingError(`unknown axis: ${JSON.stringify(axis)}`);
  const mode = opts.mode ?? 'conservative';
  // Validated here and not only inside the walk: a pack with no endpoints would
  // otherwise never reach chainWalk, and a bad mode would answer "empty" instead
  // of failing.
  if (!GRADE_SETS[mode]) throw new CouplingError(`unknown mode: ${JSON.stringify(mode)}`);
  const depth = opts.depth ?? 8;
  if (!Number.isInteger(depth) || depth < 1) throw new CouplingError(`depth must be a positive integer, got ${depth}`);

  // 1./2. Every endpoint's forward walk (core/walks.mjs — the same walk the
  // `map` view runs), folded into groups: how many endpoints each group has,
  // and which groups can reach each statement. `walk` is that walk's own cut
  // census, counted per DISTINCT start.
  const { endpoints, walk } = walkEndpoints(graph, {
    mode, depth, packageDepth: opts.packageDepth ?? null,
    ...(opts.maxNodes != null ? { maxNodes: opts.maxNodes } : {}),
  });
  const endpointsPerGroup = new Map(); // group -> endpoint count
  const stmtGroups = new Map(); // statement node id -> Set(group)
  for (const ep of endpoints) {
    endpointsPerGroup.set(ep.group, (endpointsPerGroup.get(ep.group) ?? 0) + 1);
    for (const s of ep.statements) {
      let gs = stmtGroups.get(s.id);
      if (!gs) { gs = new Set(); stmtGroups.set(s.id, gs); }
      gs.add(ep.group);
    }
  }

  // 3. Each reached statement's items, split into the write side and the read
  // side. Column axis: the statement's own READS/WRITES edges. Table axis: its
  // EXECUTES edges, where `delete` is a WRITE — a delete changes what the next
  // reader sees just as an update does.
  const items = new Map(); // item key -> {writers: Map(group -> Set(stmt)), readers: same}
  const touch = (key, side, group, stmtId) => {
    let it = items.get(key);
    if (!it) { it = { writers: new Map(), readers: new Map() }; items.set(key, it); }
    const byGroup = it[side];
    let stmts = byGroup.get(group);
    if (!stmts) { stmts = new Set(); byGroup.set(group, stmts); }
    stmts.add(stmtId);
  };
  // An EXECUTES edge whose access the lane did not record (or recorded as
  // something this view has no rule for) is counted on BOTH sides: guessing
  // "read" would silently drop a write, and dropping it would lose the table.
  // The count is disclosed by the caller, never absorbed.
  let unknownAccess = 0;
  for (const [stmtId, groups] of stmtGroups) {
    for (const e of graph.outEdges(stmtId)) {
      let sides = null;
      if (axis === 'column') {
        if (e.type === 'WRITES') sides = ['writers'];
        else if (e.type === 'READS') sides = ['readers'];
      } else if (e.type === 'EXECUTES') {
        const access = graph.edgeAt(e.idx)?.evidence?.access;
        if (access === 'write' || access === 'delete') sides = ['writers'];
        else if (access === 'read') sides = ['readers'];
        else { sides = ['writers', 'readers']; unknownAccess += 1; }
      }
      if (!sides) continue;
      const key = strip(e.to);
      for (const g of groups) for (const side of sides) touch(key, side, g, stmtId);
    }
  }

  // 4. The fan-out disclosure: statements so many groups reach that attributing
  // them to any one group says little.
  const sharedStatements = [];
  const isShared = new Set();
  for (const [stmtId, groups] of stmtGroups) {
    if (groups.size < SHARED_AT) continue;
    isShared.add(stmtId);
    sharedStatements.push({ statement: strip(stmtId), groups: groups.size });
  }
  sharedStatements.sort((a, b) => (b.groups - a.groups) || cmp(a.statement, b.statement));

  // 5. The cells. An item read and written only inside ONE group couples nothing.
  const cells = new Map(); // key: writer + NUL + reader -> {writer, reader, items:[], viaShared, sharedVia:Set}
  const writesPerGroup = new Map();
  const readsPerGroup = new Map();
  let coupledItems = 0;
  let selfOnlyItems = 0;
  // An item only one SIDE of the walk ever touched is neither coupling nor
  // self-only, and it is a third of this pack's columns: counted apart so the
  // four numbers add up to `items` rather than leaving a silent remainder.
  let writeOnlyItems = 0;
  let readOnlyItems = 0;
  for (const [key, it] of items) {
    const writers = [...it.writers.keys()].sort(cmp);
    const readers = [...it.readers.keys()].sort(cmp);
    for (const g of writers) writesPerGroup.set(g, (writesPerGroup.get(g) ?? 0) + 1);
    for (const g of readers) readsPerGroup.set(g, (readsPerGroup.get(g) ?? 0) + 1);
    if (!writers.length || !readers.length) { // written but never read here, or vice versa
      if (writers.length) writeOnlyItems += 1; else readOnlyItems += 1;
      continue;
    }
    let coupled = false;
    for (const a of writers) {
      for (const b of readers) {
        if (a === b) continue; // the diagonal is not coupling between modules
        coupled = true;
        const k = `${a}\u0000${b}`;
        let cell = cells.get(k);
        if (!cell) { cell = { writer: a, reader: b, items: [], viaShared: 0, sharedVia: new Set() }; cells.set(k, cell); }
        cell.items.push(key);
        // "This pair rests on a shared statement": on AT LEAST ONE SIDE the
        // item's whole evidence is fan-out statements — every statement that
        // makes a a writer of it, or every statement that makes b a reader of
        // it. The link is then an artefact of reachability at least as much as
        // of the two groups' own code. The statements that carried it travel
        // with the pair (`sharedVia`), so the reader sees THIS pair's evidence
        // rather than the pack's global top of the list.
        const wShared = allShared(it.writers.get(a), isShared);
        const rShared = allShared(it.readers.get(b), isShared);
        if (wShared || rShared) {
          cell.viaShared += 1;
          if (wShared) for (const sid of it.writers.get(a)) cell.sharedVia.add(strip(sid));
          if (rShared) for (const sid of it.readers.get(b)) cell.sharedVia.add(strip(sid));
        }
      }
    }
    if (coupled) coupledItems += 1; else selfOnlyItems += 1;
  }

  const pairs = [...cells.values()].map((c) => ({
    writer: c.writer, reader: c.reader, count: c.items.length,
    items: c.items.slice().sort(cmp), viaShared: c.viaShared,
    sharedVia: [...c.sharedVia].sort(cmp).slice(0, SHARED_VIA_CAP),
  }));
  pairs.sort((a, b) => (b.count - a.count) || cmp(a.writer, b.writer) || cmp(a.reader, b.reader));

  const participating = new Set();
  for (const p of pairs) { participating.add(p.writer); participating.add(p.reader); }

  const groups = [...endpointsPerGroup.keys()].sort(cmp).map((group) => ({
    group,
    endpoints: endpointsPerGroup.get(group),
    writes: writesPerGroup.get(group) ?? 0,
    reads: readsPerGroup.get(group) ?? 0,
  }));

  return {
    axis, mode, depth,
    groups,
    pairs,
    sharedStatements,
    walk,
    unknownAccess,
    summary: {
      items: items.size,
      coupledItems,
      selfOnlyItems,
      writeOnlyItems,
      readOnlyItems,
      groups: groups.length,
      participatingGroups: participating.size,
      sharedStatements: sharedStatements.length,
      statements: stmtGroups.size,
      endpoints: endpoints.length,
    },
  };
}

/** True when the set is non-empty and every statement in it is a fan-out statement. */
function allShared(stmts, isShared) {
  if (!stmts || stmts.size === 0) return false;
  for (const s of stmts) if (!isShared.has(s)) return false;
  return true;
}

function strip(id) { return id.slice(id.indexOf(':') + 1); }
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class CouplingError extends Error {
  constructor(message) { super(message); this.name = 'CouplingError'; }
}
