// projects.mjs — the multi-project MCP host (SPEC §13 MUST, §15 M8, §17.6).
//
// One server, several projects. Three rules decide everything here:
//
//   1. LAZY. Listing the served projects reads the REGISTRY only — no pack is
//      parsed until a tool actually asks a project a question. A server that
//      serves ten projects starts as fast as one that serves one.
//   2. BOUNDED. Loaded packs live in an LRU keyed by project id with a total
//      MEMORY BUDGET. §17.6 names the unbounded Map as the defect that kills a
//      resident server: a pack heap is tens to hundreds of MB, so the cache
//      evicts instead of growing. A pack that cannot fit ALONE is refused
//      outright (`pack-unreadable`) rather than half-loaded.
//   3. EXPLICIT. Which project a call is about is never guessed: one served
//      project answers by itself, several without a `project` argument is
//      `ambiguous` (409, §17.4) — never a silent pick, because answering the
//      wrong project confidently is the failure this whole product exists to
//      prevent.
//
// The memory budget is applied to a PROXY, not to real heap: bytes = the pack
// file's size on disk + the JSON text length of `facts-index.json` when it is
// there. Node gives no per-object heap accounting, and measuring the real thing
// would mean loading the pack first — which is the very thing the budget is
// there to refuse. The proxy is a LOWER BOUND on what a pack costs.
//
// RE-MEASURED (RM11) with two independent tools that agree — the mall pack
// (10.0 MB proxy, 12 674 nodes / 19 268 edges) holds as 18.1 MB of V8 heap,
// 1.8x its proxy; a synthetic 400-table / 3 800-endpoint pack (47.6 MB proxy,
// 61 980 / 105 068) holds as 94.1 MB, 2.0x. RESIDENT means the Graph, which is
// all the cache keeps: the file text and the parsed JSON go once the graph
// exists, and while all three are alive a LOAD transiently costs about 4x the
// proxy. (An earlier note here said 2.3x; it was measured on a 2.8 MB /
// 3 941-node mall pack that no longer exists.)
//
// Run `node --expose-gc scripts/measure-host-memory.mjs` — or
// `scripts/measure-pack-cost.mjs`, which prints both numbers — to re-measure on
// your own pack. So the honest reading of a 512 MB budget is "512 MB of pack
// JSON", which on this evidence is roughly 1 GB of resident graph and a higher
// transient peak per load: if what you must bound is RSS, divide by the ratio
// you measure. It IS a bound, and a documented one; what it is not is a heap
// limit.
//
// Pure except `packProxyBytes`, which stats two files (and takes its `io`
// injected, so the LRU is unit-testable with fake loaders and no filesystem).

import fs from 'node:fs';
import path from 'node:path';
import { DispatchError, TOOLS, callTool as catalogCallTool } from './catalog.mjs';
import { computeTrust } from '../core/trust.mjs';

/** The default memory budget, in bytes (512 MB of pack JSON — see above). */
export const DEFAULT_BUDGET_MB = 512;
export const DEFAULT_BUDGET_BYTES = DEFAULT_BUDGET_MB * 1024 * 1024;

/**
 * Where a served entry's pack lives: an explicit `packDir` (a `--pack <dir>`
 * server), else `<dotCascadePath>/pack` (a registry entry, SPEC §5).
 * @param {{packDir?:string, dotCascadePath?:string}} entry
 * @returns {string}
 */
export function packDirOf(entry) {
  if (entry && typeof entry.packDir === 'string' && entry.packDir.length > 0) return path.resolve(entry.packDir);
  if (entry && typeof entry.dotCascadePath === 'string' && entry.dotCascadePath.length > 0) {
    return path.join(path.resolve(entry.dotCascadePath), 'pack');
  }
  throw new DispatchError('pack-unreadable', `project ${JSON.stringify(entry && entry.id)} names no pack directory (neither packDir nor dotCascadePath)`);
}

/**
 * The memory proxy for one project's pack, in bytes: the pack file's size plus
 * the JSON text length of `facts-index.json` when the project has one. See the
 * header for why this is a proxy and what it under-counts.
 * @param {object} entry
 * @param {{statSync:Function, existsSync:Function, readFileSync:Function}} [io]
 * @returns {number}
 */
export function packProxyBytes(entry, io = fs) {
  const dir = packDirOf(entry);
  const packFile = path.join(dir, 'pack.json');
  let bytes = io.statSync(packFile).size;
  const indexFile = path.join(dir, 'facts-index.json');
  if (io.existsSync(indexFile)) bytes += io.readFileSync(indexFile, 'utf8').length;
  return bytes;
}

/**
 * A project-scoped context factory: the registry in, a bounded lazy cache of
 * loaded project contexts out.
 *
 * @param {{
 *   registry: ({projects:object[]}|object[]),
 *   loadProject: (entry:object) => object,   // entry -> the tool ctx (graph/basis/trust/pack/…)
 *   budgetBytes?: number,
 *   now?: () => (string|number),
 *   measureBytes?: (entry:object) => number, // defaults to packProxyBytes
 *   log?: (line:string) => void              // defaults to one stderr line
 * }} cfg
 */
export function createProjectHost(cfg = {}) {
  const entries = entriesOf(cfg.registry);
  const byId = new Map(entries.map((e) => [e.id, e]));
  if (byId.size !== entries.length) {
    const dupes = entries.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i);
    throw new DispatchError('bad-input', `the same project id is served twice: ${[...new Set(dupes)].join(', ')}`);
  }
  const loadProject = cfg.loadProject;
  if (typeof loadProject !== 'function') throw new DispatchError('bad-input', 'createProjectHost needs a loadProject(entry) function');
  const budgetBytes = Number.isFinite(cfg.budgetBytes) && cfg.budgetBytes > 0 ? Math.floor(cfg.budgetBytes) : DEFAULT_BUDGET_BYTES;
  const now = typeof cfg.now === 'function' ? cfg.now : () => new Date().toISOString();
  const measureBytes = typeof cfg.measureBytes === 'function' ? cfg.measureBytes : packProxyBytes;
  const log = typeof cfg.log === 'function' ? cfg.log : (line) => process.stderr.write(line + '\n');

  // The LRU. A Map keeps insertion order, so "least recently used" is simply
  // "first key": every hit deletes and re-inserts the entry at the back.
  const cache = new Map(); // id -> {ctx, bytes, loadedAt, lastUsedAt}
  let evictions = 0;
  let hits = 0;
  let misses = 0;

  const ids = () => entries.map((e) => e.id);
  const totalBytes = () => [...cache.values()].reduce((n, e) => n + e.bytes, 0);

  /** The served projects, from the registry alone — this NEVER loads a pack. */
  function list() {
    return entries.map((e) => {
      const held = cache.get(e.id);
      return {
        id: e.id,
        dotCascadePath: e.dotCascadePath ?? null,
        stack: Array.isArray(e.stack) ? e.stack.slice() : [],
        lastCertifiedAt: e.lastCertifiedAt ?? null,
        loaded: !!held,
        bytes: held ? held.bytes : null,
        // What the pack SAYS about itself — only for a project whose pack is
        // already in memory. Reading it for an unloaded project would mean
        // parsing the pack, which is exactly what listing must not do (§15 M8):
        // `null` here means "not loaded", never "this pack has no metadata".
        meta: held ? metaSummary(held.ctx) : null,
      };
    });
  }

  function stats() {
    return { loaded: cache.size, bytes: totalBytes(), budgetBytes, evictions, hits, misses };
  }

  /** Evict least-recently-used projects until the cache fits the budget. */
  function evictToBudget(keepId) {
    while (totalBytes() > budgetBytes) {
      const victim = [...cache.keys()].find((id) => id !== keepId);
      if (victim == null) break; // only the just-loaded project is left; it fits by construction
      const held = cache.get(victim);
      cache.delete(victim);
      evictions += 1;
      log(`cascade: evicted project ${victim} (${held.bytes} bytes, last used ${held.lastUsedAt}): `
        + `${cache.size} project(s) / ${totalBytes()} bytes now held under the ${budgetBytes} byte budget`);
    }
  }

  /**
   * The tool context for one project — loaded on first use, then kept in the
   * LRU. Throws DispatchError: `unknown-key` for an id this server does not
   * serve, `pack-unreadable` for a pack that cannot be read or cannot fit.
   */
  function ctxFor(projectId) {
    const entry = byId.get(projectId);
    if (!entry) throw unknownProject(projectId, ids());
    const held = cache.get(projectId);
    if (held) {
      hits += 1;
      cache.delete(projectId);
      held.lastUsedAt = now();
      cache.set(projectId, held); // to the back: most recently used
      return held.ctx;
    }
    misses += 1;

    let bytes;
    try {
      bytes = Number(measureBytes(entry));
    } catch (e) {
      throw new DispatchError('pack-unreadable', `pack of ${projectId} cannot be measured: ${(e && e.message) || e}`);
    }
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new DispatchError('pack-unreadable', `pack of ${projectId} reported a nonsense size (${bytes})`);
    }
    // A pack that does not fit ALONE is refused before a byte of it is parsed:
    // loading it would blow the budget the moment it succeeded, and a partial
    // load would answer from half a graph (§17.6).
    if (bytes > budgetBytes) {
      throw new DispatchError(
        'pack-unreadable',
        `pack of ${projectId} (${bytes}) exceeds the memory budget (${budgetBytes}). Serve it alone, or raise --memory-budget`,
      );
    }

    let ctx;
    try {
      ctx = loadProject(entry);
    } catch (e) {
      if (e instanceof DispatchError) throw e;
      throw new DispatchError('pack-unreadable', `pack of ${projectId} could not be loaded: ${(e && e.message) || e}`);
    }
    const stamp = now();
    cache.set(projectId, { ctx, bytes, loadedAt: stamp, lastUsedAt: stamp });
    evictToBudget(projectId);
    return ctx;
  }

  /**
   * Which project a call is about, and the arguments with `project` removed.
   * The tool never sees the routing argument.
   * @param {object} args
   * @returns {{projectId:string, args:object}}
   */
  function resolveProjectArg(args) {
    const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const { project, ...rest } = raw;
    if (project != null && project !== '') {
      if (typeof project !== 'string') throw new DispatchError('bad-input', `"project" must be a string, got ${typeof project}`);
      if (!byId.has(project)) throw unknownProject(project, ids());
      return { projectId: project, args: rest };
    }
    if (entries.length === 1) return { projectId: entries[0].id, args: rest };
    if (entries.length === 0) {
      throw new DispatchError('unknown-key', 'this server serves no project. Run `cascade init` + `cascade analyze` in a project, or start the server with --pack <dir>');
    }
    throw new DispatchError('ambiguous', `several projects are registered: ${ids().join(', ')}. Pass "project"`);
  }

  /** The basis/trust a SERVER-LEVEL answer carries (the `projects` listing). */
  function serverCtx() {
    return {
      graph: null,
      basis: {
        // Not a pack: this answer describes the server. It anchors to no
        // snapshot, and the contract lets it say so instead of inventing a
        // digest (see src/mcp/contract.mjs).
        project: '*',
        scope: 'server',
        buildDigest: null,
        builtAt: null,
        freshness: { verdict: 'unknown' },
      },
      trust: computeTrust({ knownGaps: ['server-level-answer'] }),
      limits: [],
      projects: { list, stats },
    };
  }

  /**
   * Run one tool for the right project. Server-level tools (`projects`) answer
   * from the host itself; every other tool is routed by `resolveProjectArg`.
   */
  function callTool(name, args) {
    const spec = TOOLS[name];
    if (!spec) return catalogCallTool(name, args, {}); // the catalog owns the unknown-tool message
    if (spec.serverLevel) {
      const raw = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const { project, ...rest } = raw; // a project argument means nothing here; it is dropped, not honoured
      void project;
      return catalogCallTool(name, rest, serverCtx());
    }
    const routed = resolveProjectArg(args);
    return catalogCallTool(name, routed.args, ctxFor(routed.projectId));
  }

  return { list, stats, ctxFor, resolveProjectArg, callTool, serverCtx, ids, budgetBytes };
}

/**
 * The five things a LOADED project's pack says about itself, for a listing and
 * for the viewer's project selector: which pack it is, when it was built, which
 * lanes ran, which axes it declares it could ship, and how fresh the served
 * answer is. Every field is read straight off the loaded context — nothing is
 * recomputed here, so this can never disagree with `/api/meta`.
 *
 * Defensive by design: a context assembled by a test (or by a future caller
 * that carries no pack) yields nulls rather than throwing, because a listing
 * must not fail on account of one odd project.
 * @param {object} ctx
 * @returns {{project:(string|null), digest:(string|null), builtAt:(string|null), lanes:(string[]|null), axes:(object|null), freshness:(object|null)}|null}
 */
function metaSummary(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const pack = ctx.pack && typeof ctx.pack === 'object' ? ctx.pack : {};
  const basis = ctx.basis && typeof ctx.basis === 'object' ? ctx.basis : {};
  return {
    project: pack.project ?? basis.project ?? null,
    digest: pack.digest ?? basis.buildDigest ?? null,
    builtAt: pack.builtAt ?? basis.builtAt ?? null,
    lanes: pack.lanes ?? null,
    axes: pack.axes ?? null,
    freshness: basis.freshness ?? null,
  };
}

function unknownProject(id, ids) {
  return new DispatchError(
    'unknown-key',
    ids.length === 0
      ? `unknown project ${JSON.stringify(id)}: this server serves no project`
      : `unknown project ${JSON.stringify(id)}: served ids are ${ids.join(', ')}`,
  );
}

function entriesOf(registry) {
  const list = Array.isArray(registry) ? registry : (registry && Array.isArray(registry.projects) ? registry.projects : null);
  if (!list) throw new DispatchError('bad-input', 'createProjectHost needs a registry {projects:[…]} or an array of project entries');
  return list.map((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || e.id.length === 0) {
      throw new DispatchError('bad-input', `project entry ${i} needs a non-empty string id`);
    }
    return e;
  });
}
