// serve.mjs — turning "which project?" into a loaded project host.
//
// `mcp` and `view` are two front doors onto the SAME server: the same list of
// served projects, the same lazy loading under the same memory budget, the same
// context handed to the same tools. So the whole of it is here, once, and both
// commands call it — the stdio server and the viewer cannot describe the same
// pack differently, because neither of them assembles one.
//
// It also holds what a pack MEANS to a reader: `packMeta` (what this pack is),
// `runtimeEvidenceBasis` (what was observed running, and how much), and the
// profile a command or a server answers with.

import fs from 'node:fs';
import path from 'node:path';
import { loadPack, PACK_SCHEMA } from '../core/pack.mjs';
import { loadProfile, normalizeProfile, trustGapsFor, PROFILE_DEFAULTS } from '../core/profile.mjs';
import { computeTrust } from '../core/trust.mjs';
import { readRegistry, findProject, projectIds } from '../core/registry.mjs';
import { registryPath } from '../core/paths.mjs';
import { resolveProject } from '../core/resolve.mjs';
import { slugify } from '../core/init.mjs';
import { callTool } from '../mcp/catalog.mjs';
import { createProjectHost, packDirOf, DEFAULT_BUDGET_MB } from '../mcp/projects.mjs';
import { makeOverlayProvider } from './overlay_provider.mjs';
import { calibrationStateOf, gitChangedFiles, ownStateOf } from './state.mjs';

// The pack's own metadata, as the `overview` tool reads it back out of ctx:
// what this pack IS (project, digest, build time, lanes) and what it was built
// from. One helper, called identically by `mcp` and `view`, so the stdio server
// and the viewer can never describe the same pack differently.
export function packMeta(pack) {
  return {
    project: pack.meta?.project ?? 'project',
    digest: pack.digest,
    builtAt: pack.meta?.builtAt ?? null,
    lanes: pack.meta?.lanes ?? null,
    base: pack.meta?.base ?? null,
    ddl: pack.meta?.ddl ?? null,
    // The identity rule this pack's names were matched under (SPEC §8.1), so a
    // tool argument can be resolved the way the analyzer resolved the same
    // spelling. Null on a pack built before the field existed: no fold.
    identifierCase: pack.meta?.identifierCase ?? null,
    // What this pack DECLARES it could and could not ship (SPEC §10.4), and the
    // lane tallies that no edge in the graph can carry (an unresolved call
    // leaves nothing behind — that is why it is counted at ingest).
    axes: pack.meta?.axes ?? null,
    laneStats: pack.meta?.laneStats ?? null,
  };
}

/**
 * The `basis.runtimeEvidence` block, from the trace census the pack carries.
 *
 * It is a COVERAGE statement, not a result: which traces were read, how many
 * spans they held, what window they cover, and how much of the graph they
 * touched. A reader seeing `observed: true` on a row needs it to know how much
 * "observed" is worth here, and a reader seeing NO mark needs it to know that
 * unobserved means unvisited rather than dead.
 *
 * @param {Object} pack  the pack as it was read from disk
 * @returns {{runtimeEvidence:Object}|null}  null when no trace was read
 */
export function runtimeEvidenceBasis(pack) {
  const s = pack?.meta?.laneStats?.otel;
  if (!s || typeof s !== 'object') return null;
  return {
    runtimeEvidence: {
      source: 'otel',
      files: Array.isArray(s.sources) ? s.sources : [],
      spans: s.spans ?? 0,
      observations: s.observations ?? 0,
      window: s.window ?? null,
      services: Array.isArray(s.services) ? s.services : [],
      observedEdges: (s.edgesObserved ?? 0) + (s.edgesAdded ?? 0),
      observedStatements: s.statementsObserved ?? 0,
      observedEndpoints: s.endpointsObserved ?? 0,
      note: 'coverage is only what was exercised. A row marked observed really ran during this capture, a row not marked was not seen by it, '
        + 'and neither of those raised or lowered a static grade',
    },
  };
}

/**
 * The profile a SERVER answers with: the file the pack recorded at analyze time
 * when it is still there, else the profile beside the pack. Null when neither
 * exists — the query layer then falls back to its own defaults rather than
 * inventing a convention.
 */
export function servedProfile(packDir, pack) {
  const candidates = [pack?.meta?.profile, path.join(packDir, '..', 'profile.json')].filter(Boolean);
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    try { return loadProfile(f); } catch (e) { process.stderr.write(`profile ${f} ignored: ${e.message}\n`); }
  }
  return null;
}

/**
 * The profile a command reads: `--profile <file>`, else `<dotCascade>/profile.json`,
 * else the documented defaults. Never guesses a convention the project did not
 * write down — it says which of the three it used.
 */
export function readProfile({ opt, die }, dotCascade) {
  const explicit = opt('profile');
  if (explicit) {
    const file = path.resolve(explicit);
    try {
      return { profile: loadProfile(file), profileFile: file, profileNote: `profile: ${file} (--profile)` };
    } catch (e) { die(e.message); }
  }
  const file = dotCascade ? path.join(dotCascade, 'profile.json') : null;
  if (file && fs.existsSync(file)) {
    try {
      return { profile: loadProfile(file), profileFile: file, profileNote: `profile: ${file}` };
    } catch (e) { die(e.message); }
  }
  return {
    profile: normalizeProfile({}),
    profileFile: null,
    profileNote: `profile: none found${file ? ` at ${file}` : ''}, so we use the documented defaults `
      + `(no package prefixes, no schema default, catalog.source=${PROFILE_DEFAULTS.catalog.source}); run \`cascade init\` to write one`,
  };
}

/** `--memory-budget <MB>` (default 512), as bytes of pack JSON (SPEC §17.6). */
export function memoryBudgetBytes({ opt, die }) {
  const raw = opt('memory-budget', String(DEFAULT_BUDGET_MB));
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) die(`--memory-budget must be a positive number of megabytes, got ${JSON.stringify(raw)}`);
  return Math.floor(mb * 1024 * 1024);
}

/**
 * One served project that the registry does not name: a `--pack <dir>` (or a
 * local `.cascade/`) server. The id comes from the pack's own meta, so the
 * `project` argument still means something to a client. The pack is parsed once
 * here for that name and then dropped — the host re-reads it lazily, under the
 * memory budget, when a tool actually needs the graph.
 */
export function anonymousEntry({ die }, resolved) {
  const file = path.join(resolved.packDir, 'pack.json');
  if (!fs.existsSync(file)) die(`no pack at ${file}. Run \`cascade analyze\` first`);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')).meta ?? {}; }
  catch (e) { die(`cannot read ${file}: ${e.message}`); }
  const id = resolved.projectId || slugify(String(meta.project ?? '')) || 'project';
  return {
    id,
    dotCascadePath: resolved.dotCascade,
    packDir: resolved.packDir,
    source: resolved.source,
    stack: meta.lanes ?? [],
    lastCertifiedAt: meta.builtAt ?? null,
  };
}

/**
 * The projects a SERVER serves (SPEC §13 MUST, §15 M8). Four ways to say it,
 * one order:
 *
 *   --pack <dir> / --root <dir>   ONE anonymous project, id from the pack meta
 *   --project a --project b       exactly those registry entries
 *   (nothing)                     every registered project, lazily
 *   (nothing, empty registry)     the local `.cascade/`, as one anonymous project
 *
 * Nothing here loads a pack: the entries are registry records, and the host
 * parses a pack only when a tool first asks that project a question.
 * @param {string} cmdName  for the error messages ("mcp" / "view")
 */
export function servedEntries(args, cmdName) {
  const { opt, optAll, die } = args;
  const packFlag = opt('pack');
  const rootFlag = opt('root');
  const ids = optAll('project');
  if (packFlag || rootFlag) {
    if (ids.length) {
      die(`cascade ${cmdName}: --pack/--root serve ONE pack, so --project has nothing to select. `
        + 'Drop it, or drop --pack/--root and name the registered projects with --project');
    }
    return [anonymousEntry(args, resolveProject({ pack: packFlag, root: rootFlag, cwd: process.cwd(), env: process.env }))];
  }
  const regFile = registryPath(process.env);
  let reg;
  try { reg = readRegistry(regFile); } catch (e) { die(e.message); }
  if (ids.length) {
    return ids.map((id) => {
      const entry = findProject(reg, id);
      if (!entry) {
        die(`unknown project ${JSON.stringify(id)}: registered ids are ${projectIds(reg).join(', ') || '(none)'} (registry ${regFile})`);
      }
      return entry;
    });
  }
  if (reg.projects.length > 0) return reg.projects;
  const local = resolveProject({ cwd: process.cwd(), env: process.env });
  if (!fs.existsSync(path.join(local.packDir, 'pack.json'))) {
    die(`no project is registered in ${regFile}, and there is no pack at ${path.join(local.packDir, 'pack.json')}. `
      + 'Run `cascade init` then `cascade analyze`, or serve a built pack with --pack <dir>');
  }
  return [anonymousEntry(args, local)];
}

/**
 * Load ONE served project into a tool context: the graph, its basis, its
 * COMPUTED trust (SPEC §14.3), the pack metadata, the project's profile, the
 * live git diff and the live working-tree overlay. This is what the project
 * host calls on a cache miss, so `mcp` and `view` cannot describe the same
 * project differently. `packJson`/`packDir` ride along for the viewer's
 * /api/meta and /api/source; the tools never look at them.
 */
export function loadServedProject(entry) {
  const dir = packDirOf(entry);
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack at ${file}. Run \`cascade analyze\` for project ${entry.id}`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pack.schema !== PACK_SCHEMA) throw new Error(`unexpected pack schema in ${file}: ${pack.schema}`);
  const graph = loadPack(pack, { verifyDigest: true });
  const prof = servedProfile(dir, pack);
  return {
    graph,
    basis: {
      // The id the CLIENT addressed (the registry id / the `project` argument),
      // not the name the pack happens to carry: on a server holding several
      // packs those names can collide — an older `analyze` stamped every pack
      // "project" — and then no answer would say which project it came from.
      // The pack's own declared name is not hidden; it rides along whenever it
      // differs, and `overview` relays it in answer.pack.project.
      project: entry.id,
      ...(pack.meta?.project && pack.meta.project !== entry.id ? { packProject: pack.meta.project } : {}),
      buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null,
      // Served from a static pack with no live source check: freshness is
      // unknown, never "current".
      freshness: { verdict: 'unknown' },
      // WHAT WAS OBSERVED RUNNING, and how much of it. Present only when a
      // trace was read, so its absence is "no trace" and never "a trace that
      // saw nothing". Every answer carries it for the same reason `freshness`
      // is carried: an `observed` mark on a row is only readable next to the
      // coverage it came from.
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    // COMPUTED (SPEC §14.3 MUST): this project's last gate verdict plus its
    // approved golden corpus. A bare `--pack` has no `.cascade/` to read and
    // computes from NO state — UNCERTIFIED with `no-calibration-state`.
    trust: computeTrust({ ...calibrationStateOf(entry.dotCascadePath ?? null), knownGaps: trustGapsFor(prof, pack.meta?.axes ?? null) }),
    limits: [],
    pack: packMeta(pack),
    profile: prof,
    changedFiles: () => gitChangedFiles(pack.meta?.base, ownStateOf(pack.meta?.base, dir)),
    overlay: makeOverlayProvider({ packDir: dir, pack, baseGraph: graph, profile: prof }),
    packJson: pack,
    packDir: dir,
  };
}

/**
 * The bound `callTool` the golden corpus asks its questions through. §14.1 is
 * emphatic that the grader must not see the engine's internals: it scores the
 * SHIPPED query surface, the same one an AI reaches over MCP, so every case
 * goes through the dispatcher and never through a private walk.
 */
export function goldenAsk(graph, pack, profile) {
  const ctx = {
    graph,
    basis: {
      project: pack.meta?.project ?? 'project', buildDigest: pack.digest,
      builtAt: pack.meta?.builtAt ?? null, freshness: { verdict: 'unknown' },
      ...(runtimeEvidenceBasis(pack) ?? {}),
    },
    trust: computeTrust({ knownGaps: trustGapsFor(profile, pack.meta?.axes ?? null) }),
    limits: [],
    pack: packMeta(pack),
    profile,
  };
  return (name, args) => callTool(name, args, ctx);
}

/**
 * THE SERVER BOTH FRONT DOORS OPEN ONTO. `mcp` speaks JSON-RPC over stdio and
 * `view` speaks HTTP, and that is the whole of the difference: which projects
 * are served, when their packs are parsed and how much memory the loaded ones
 * may hold are decided once, here, so the two can never answer the same
 * question from two different servers.
 */
export function servedHost(args, cmdName) {
  return createProjectHost({
    registry: servedEntries(args, cmdName),
    loadProject: loadServedProject,
    budgetBytes: memoryBudgetBytes(args),
  });
}
