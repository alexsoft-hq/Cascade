// overlay.mjs — the working-tree overlay's read side (SPEC §10, the two-speed
// model). The certified base graph is deterministic and slow to (re)build; this
// answers the fast edit-loop question against it WITHOUT re-analysis:
//
//   "I just edited these files — what do they touch, and what is downstream?"
//
// It is deliberately PURE over (graph, changedFiles): the impure part (asking
// git what changed) lives in the CLI/server. That keeps this unit-testable and
// keeps the honesty explicit — this function never reads the filesystem, so it
// cannot silently mix a stale base with fresh bytes.
//
// HONESTY (this is the whole point of the two-speed split):
//  - Every fact here comes from the BASE pack, i.e. the file as it was last
//    analyzed. If you have edited a file, the impact shown for it is the
//    PRE-EDIT structure — a starting point, not a guarantee. The caller stamps
//    freshness=provisional-overlay and lists the changed files so the answer can
//    never be mistaken for a fresh certified result.
//  - A changed file with NO node in the base graph (a brand-new file, a config,
//    a front-end file, or a lane that was not run) is reported as `unmatched`,
//    never silently dropped. "0 impact" for such a file means "unknown", not "safe".
//  - Path grades are weakest-link, exactly as the graph computes them, so an
//    endpoint reached through a SOUND_SET call edge stays SOUND_SET.

import { FLOW_EDGE_TYPES } from './graph.mjs';
import { spliceFacts, assembleJavaFacts, assembleWebFacts } from './facts_store.mjs';
import { underAny, isWebPackageConfigFile } from './invalidate.mjs';
import { isWebSourceFile } from './discover.mjs';
import { assembleGraph } from './assemble.mjs';

const GRADE_RANK = { UNRESOLVED: 0, RUNTIME_ONLY: 1, HEURISTIC: 2, SOUND_SET: 3, EXACT: 4 };

// The only two edges between an edited frontend file and the screen it is drawn
// on: the frontend's own calls, and the RENDERS edge from a route's component.
// Deliberately NOT the whole flow set — climbing CALLS_HTTP backwards from an
// api function would walk into the backend and come back with screens that
// call the same route for entirely different reasons.
const SCREEN_EDGE_TYPES = Object.freeze(['CALLS', 'RENDERS']);

/**
 * Node ids whose originating file is one of `files`. Matching is root-relative
 * with a basename/suffix fallback, because lane file paths (java: source-root
 * relative; sql: mapper path) and a git diff's paths can differ in prefix.
 * @param {import('./graph.mjs').Graph} graph
 * @param {string[]} files  changed paths (repo-root relative)
 * @returns {{ matched: Map<string,string[]>, byId: Set<string> }}
 *   matched: changedFile -> [nodeId,...]; byId: all matched node ids.
 */
export function nodesInFiles(graph, files) {
  const wanted = files.map(normalize);
  const matched = new Map(files.map((f) => [f, []]));
  const byId = new Set();
  for (const node of graph.nodes.values()) {
    if (!node.file) continue;
    const nf = normalize(node.file);
    for (let i = 0; i < wanted.length; i++) {
      if (pathMatch(nf, wanted[i])) {
        matched.get(files[i]).push(node.id);
        byId.add(node.id);
      }
    }
  }
  return { matched, byId };
}

/**
 * The edit blast radius of a changeset, computed against the base graph.
 * @param {import('./graph.mjs').Graph} graph
 * @param {string[]} changedFiles  repo-root-relative paths (from git)
 * @param {{mode?:'strict'|'conservative'|'heuristic'}} [opts]
 * @returns {{
 *   changedFiles:number, matchedFiles:string[], unmatchedFiles:string[],
 *   touched:{symbols:string[],webSymbols:string[],statements:string[],endpoints:string[],columns:string[],other:string[]},
 *   upstreamEndpoints:{id:string,grade:string,viaHttp?:boolean,httpHops?:number}[],
 *   calledEndpoints:{id:string,grade:string}[],
 *   downstreamColumns:{id:string,grade:string}[]
 * }}
 */
export function changeImpact(graph, changedFiles, opts = {}) {
  if (!Array.isArray(changedFiles)) throw new OverlayError('changedFiles must be an array');
  const mode = opts.mode ?? 'conservative';
  const { matched, byId } = nodesInFiles(graph, changedFiles);

  const matchedFiles = [];
  const unmatchedFiles = [];
  for (const [f, ids] of matched) (ids.length ? matchedFiles : unmatchedFiles).push(f);

  // A FRONTEND function is a symbol too, but its blast radius runs the other
  // way: nothing in this graph calls it, and what it reaches is a route. Listing
  // it beside the Java symbols would put a row under "upstream endpoints" that
  // is really a row under "the endpoints this file calls", so it gets its own
  // bucket and its own walk.
  const touched = { symbols: [], webSymbols: [], screens: [], statements: [], endpoints: [], columns: [], other: [] };
  for (const id of byId) {
    const node = graph.nodes.get(id);
    const kind = node?.kind;
    if (kind === 'symbol') (node.lane === 'web' ? touched.webSymbols : touched.symbols).push(id);
    else if (kind === 'screen') touched.screens.push(id);
    else if (kind === 'statement') touched.statements.push(id);
    else if (kind === 'endpoint') touched.endpoints.push(id);
    else if (kind === 'column') touched.columns.push(id);
    else touched.other.push(id);
  }
  // THE SCREENS AN EDITED COMPONENT IS DRAWN ON (RM30). A `.vue` file is a
  // function in the graph, and what a reader wants to know about editing one is
  // which SCREEN it changes. That is the RENDERS edge read backwards, through
  // however many frontend calls sit between the component and the api function
  // that was edited. The router file itself matches a screen node directly, and
  // both land in the same list.
  const screenSet = new Set(touched.screens);
  for (const id of touched.webSymbols) {
    for (const [rid] of graph.impactOf(id, { mode, edgeTypes: SCREEN_EDGE_TYPES })) {
      if (graph.nodes.get(rid)?.kind === 'screen') screenSet.add(rid);
    }
  }
  touched.screens = [...screenSet];
  for (const k of Object.keys(touched)) touched[k].sort();

  // Upstream endpoints (things whose flow passes THROUGH an edited node) and
  // downstream columns (data an edited node reaches) — strongest grade per id.
  const up = new Map(); // endpoint id -> grade
  const down = new Map(); // column id -> grade
  const called = new Map(); // endpoint id -> grade, for an edited FRONTEND file
  const web = new Set(touched.webSymbols);
  for (const id of byId) {
    if (web.has(id)) keepStrongest(called, endpointsReachedFrom(graph, id, mode));
    else keepStrongest(up, endpointsFrom(graph, id, mode));
    keepStrongest(down, columnsFrom(graph, id, mode));
  }
  // A touched node that IS an endpoint/column is trivially in its own radius.
  for (const id of touched.endpoints) if (!up.has(id)) up.set(id, { grade: 'EXACT', http: 0 });
  for (const id of touched.columns) if (!down.has(id)) down.set(id, { grade: 'EXACT', http: 0 });

  return {
    changedFiles: changedFiles.length,
    matchedFiles: matchedFiles.sort(),
    unmatchedFiles: unmatchedFiles.sort(),
    touched,
    upstreamEndpoints: toSortedList(up),
    calledEndpoints: toSortedList(called),
    downstreamColumns: toSortedList(down),
  };
}

// Both walks follow EXECUTION/DATA flow only. A schema hop would make the
// blast radius bigger than the edit: forward, statement → table --DECLARES-->
// would add EVERY column of a touched table, not the ones the SQL names
// (measured on mall, one edited service file: 103 columns claimed vs 88 the
// reached statements actually read or write).
function endpointsFrom(graph, id, mode) {
  const out = [];
  const reached = graph.impactOf(id, { mode, edgeTypes: FLOW_EDGE_TYPES }); // backward: who depends on id
  for (const [rid, info] of reached) {
    // `http` is how many INTERNAL HTTP HOPS the winning path crossed: an edit
    // whose only route upstream is in another deployable must say so, or the
    // reader deploys one module and believes the blast radius is covered.
    if (graph.nodes.get(rid)?.kind === 'endpoint') out.push([rid, info.pathGrade, info.http ?? 0]);
  }
  return out;
}
// The endpoints an edited node REACHES going forward. For a frontend function
// that is the route it calls: a `.vue` that calls an api module which calls
// `client.get('/orders/{id}')` reaches `GET /orders/{id}` and stops there.
function endpointsReachedFrom(graph, id, mode) {
  const out = [];
  const reached = graph.reach(id, { direction: 'out', mode, edgeTypes: FLOW_EDGE_TYPES });
  for (const [rid, info] of reached) {
    if (graph.nodes.get(rid)?.kind === 'endpoint') out.push([rid, info.pathGrade, info.http ?? 0]);
  }
  return out;
}
function columnsFrom(graph, id, mode) {
  const out = [];
  const reached = graph.reach(id, { direction: 'out', mode, edgeTypes: FLOW_EDGE_TYPES }); // forward: what id touches
  for (const [rid, info] of reached) {
    if (graph.nodes.get(rid)?.kind === 'column') out.push([rid, info.pathGrade, info.http ?? 0]);
  }
  return out;
}

function keepStrongest(map, pairs) {
  for (const [id, grade, http = 0] of pairs) {
    const prev = map.get(id);
    if (prev === undefined || GRADE_RANK[grade] > GRADE_RANK[prev.grade]) map.set(id, { grade, http });
    // A row already known WITHOUT a hop stays without one: the shortest honest
    // claim wins, exactly as the grade takes the strongest across paths.
    else if (GRADE_RANK[grade] === GRADE_RANK[prev.grade] && http < prev.http) prev.http = http;
  }
}
function toSortedList(map) {
  return [...map.entries()]
    .map(([id, v]) => ({ id, grade: v.grade, ...(v.http > 0 ? { viaHttp: true, httpHops: v.http } : {}) }))
    .sort((a, b) => (a.grade !== b.grade ? GRADE_RANK[b.grade] - GRADE_RANK[a.grade] : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
// Match a node's file to a changed path: equal, or one is a path-suffix of the
// other on a segment boundary (tolerates source-root vs repo-root prefixes).
function pathMatch(a, b) {
  if (a === b) return true;
  if (a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
  return false;
}

export class OverlayError extends Error {
  constructor(message) { super(message); this.name = 'OverlayError'; }
}

// ---------------------------------------------------------------------------
// RM4 / SPEC §10.2 — the overlay is COMPUTED, not merely looked up
// ---------------------------------------------------------------------------
// Everything above answers from the base pack: the file as it was last
// analyzed. That is honest but it is not what an editing AI asked. Below, the
// dirty files are re-parsed and a NEW in-memory graph is built from
//   (base fact shards - deleted files + freshly parsed dirty files)
// exactly the way `cascade analyze` builds one, so the answer describes the
// bytes on disk right now.
//
// Two markers ride on the result, and neither is a grade (I-1: the lattice is
// untouched — `PROVISIONAL` is a MARKER):
//   evidence.overlaySessionId  this edge came out of a file the session
//                              re-parsed, so it is ephemeral and outside every
//                              pack digest (§17.2).
//   provisional:true           this node/edge exists ONLY in the overlay — the
//                              base graph never saw the id. The response shows
//                              it beside the grade so an AI reader cannot
//                              report it as confirmed (§10.3).
//
// PURE: it takes records and returns a graph. Reading the shards and running
// the workers is src/core/overlay_lanes.mjs's job.

/** Node kinds an overlay can INVENT. A table/column comes from the catalog, which the overlay never recomputes. */
const PROVISIONAL_KINDS = new Set(['symbol', 'endpoint', 'statement']);

/**
 * Sort the dirty files into the lanes that can consume them.
 *
 * A file no lane claims is NOT dropped: it comes back in `other`, and the
 * caller reports it as "impact unknown, not zero" (a `.properties`, a build
 * script, a template — this engine has no lane for it).
 *
 * @param {{status:string, path:string}[]} files  root-relative, status A|M|D
 * @param {{javaRoots:string[], mapperDirs:string[], webRoots:string[], ddl:(string|null)}} selection
 * @returns {{java:string[], javaDeleted:string[], web:string[], webDeleted:string[],
 *            webConfig:string[], xml:string[], ddl:string[], other:string[]}}
 */
export function classifyDirtyFiles(files, selection) {
  if (!Array.isArray(files)) throw new OverlayError('files must be an array');
  const sel = selection ?? {};
  const webRoots = sel.webRoots ?? [];
  const out = { java: [], javaDeleted: [], web: [], webDeleted: [], webConfig: [], xml: [], ddl: [], other: [] };
  for (const f of files) {
    const p = f && typeof f === 'object' ? f.path : f;
    if (typeof p !== 'string' || p.length === 0) throw new OverlayError('every changed file needs a path');
    const status = (f && f.status) || 'M';
    if (sel.ddl && p === sel.ddl) { out.ddl.push(p); continue; }
    if (p.endsWith('.xml') && underAny(p, sel.mapperDirs ?? [])) { out.xml.push(p); continue; }
    if (p.endsWith('.java') && underAny(p, sel.javaRoots ?? [])) {
      (status === 'D' ? out.javaDeleted : out.java).push(p);
      continue;
    }
    if (isWebSourceFile(p) && underAny(p, webRoots)) {
      (status === 'D' ? out.webDeleted : out.web).push(p);
      continue;
    }
    // A package config is not a source file and has no shard, but the overlay
    // still re-reads it (its values reshape every URL the frontend sends), so it
    // is a lane input and not an unclaimed file.
    if (isWebPackageConfigFile(p) && webRoots.length > 0 && nearWebRoot(p, webRoots)) {
      out.webConfig.push(p);
      continue;
    }
    out.other.push(p);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  // A path reported both deleted and present (a rename decomposed into D+A onto
  // the same path) is PRESENT: the working tree is the authority.
  out.javaDeleted = out.javaDeleted.filter((f) => !out.java.includes(f));
  out.webDeleted = out.webDeleted.filter((f) => !out.web.includes(f));
  return out;
}

/** A config file sits in a directory that holds a web root, or inside one. */
function nearWebRoot(file, webRoots) {
  if (underAny(file, webRoots)) return true;
  const slash = file.lastIndexOf('/');
  const dir = slash < 0 ? '' : file.slice(0, slash);
  return webRoots.some((r) => underAny(r, [dir]));
}

/**
 * Build the overlay graph.
 *
 * @param {Object} a
 * @param {Map<string,object[]>} a.baseShards   file -> JavaFacts records from the CAS (NOT mutated)
 * @param {Map<string,object[]>} [a.dirtyFacts] file -> records freshly parsed from the working tree
 * @param {Iterable<string>} [a.dropFiles]      files deleted in the working tree
 * @param {object[]} [a.catalogRecords]         base catalog (the overlay never re-runs DDL)
 * @param {object[]} [a.lineageRecords]         lineage for the CURRENT statement set
 * @param {import('./graph.mjs').Graph} a.baseGraph  the certified base — what "already existed" means
 * @param {string} a.overlaySessionId
 * @param {string[]} [a.dirtyFiles]             every re-read path, for provenance tagging
 * @param {string[]} [a.packagePrefixes]
 * @param {{annotations?:string[], pathGlobs?:string[]}} [a.generatedSources]
 *        the profile's generated-source declaration — the overlay must classify
 *        machine-written code the same way the base pack did, or an edited file
 *        would change what a walk skips.
 * @param {string} [a.identifierCase]  the SQL identity rule the base pack was
 *        built with (`sqlLaneArgs().identifierCase`); the overlay must key
 *        tables and columns the same way or an overlaid statement would attach
 *        to a table the base graph does not have.
 * @param {{buildGraphFromSql:Function, addJavaFacts:Function, addWebFacts?:Function}} a.bridges
 *        the lane bridges, INJECTED (SPEC §4, I-3): core owns the assembly and
 *        knows nothing about `adapters/`. The CLI wires the real ones; a test
 *        can wire fakes. See src/core/assemble.mjs.
 * @param {Map<string,object[]>} [a.webBaseShards]  file -> webfacts records from the CAS
 * @param {Map<string,object[]>} [a.webDirtyFacts]  file -> records freshly read from the working tree
 * @param {Iterable<string>} [a.webDropFiles]       frontend files deleted in the working tree
 * @param {object[]} [a.webConfigRecords]           the package configuration, re-read every time
 * @param {{gatewayRoutes?:object, packages?:object[]}|null} [a.web]
 *        options for the web bridge; null runs no web bridge. `gatewayRoutes`
 *        comes from the LIVE profile, exactly as `generatedSources` does.
 * @returns {{graph:import('./graph.mjs').Graph, javaStats:object, webStats:(object|null),
 *            provisional:{symbols:string[], endpoints:string[], statements:string[], edges:number},
 *            taggedEdges:number}}
 */
export function overlayGraph(a) {
  const {
    baseShards, dirtyFacts = new Map(), dropFiles = [],
    webBaseShards = new Map(), webDirtyFacts = new Map(), webDropFiles = [], webConfigRecords = [],
    catalogRecords = [], lineageRecords = [],
    baseGraph, overlaySessionId, dirtyFiles = [], packagePrefixes = [], generatedSources = null,
    identifierCase = 'exact', bridges = null, web = null,
  } = a ?? {};
  if (!(baseShards instanceof Map)) throw new OverlayError('baseShards must be a Map of file -> records');
  if (!baseGraph || typeof baseGraph.nodes?.has !== 'function') throw new OverlayError('baseGraph is required. Without it nothing can be called new');
  if (typeof overlaySessionId !== 'string' || overlaySessionId.length === 0) throw new OverlayError('overlaySessionId is required');

  // The SAME assembly `cascade analyze` runs: splice the shards, put the stream
  // back into the worker's own order, then the two bridges — through the one
  // core-owned seam both callers share (src/core/assemble.mjs), so an overlay
  // graph and an analyze graph cannot be built two different ways. Nothing is
  // written anywhere — an uncommitted edit must never become a cached fact
  // (SPEC §10.1: MUST NOT publish).
  const shards = spliceFacts(baseShards, { replaceForFiles: dirtyFacts, dropFiles });
  const javaFacts = assembleJavaFacts(shards);
  // The web lane goes through the same splice, with one difference: the package
  // configuration is not spliced at all, because it is not cached. Whatever the
  // caller just read is what the frontend's base URLs are built from.
  const webShards = spliceFacts(webBaseShards, { replaceForFiles: webDirtyFacts, dropFiles: webDropFiles });
  const webFacts = assembleWebFacts(webShards, webConfigRecords);
  const { graph, javaStats, webStats } = assembleGraph({
    bridges, catalogRecords, lineageRecords, javaFacts, webFacts, identifierCase,
    java: { packagePrefixes, ...(generatedSources ? { generatedSources } : {}) },
    web,
  });

  // ---- provisional: ids the base graph never had -------------------------
  const provisional = { symbols: [], endpoints: [], statements: [], edges: 0 };
  const provIds = new Set();
  for (const [id, node] of graph.nodes) {
    if (!PROVISIONAL_KINDS.has(node.kind) || baseGraph.nodes.has(id)) continue;
    node.provisional = true;
    provIds.add(id);
    if (node.kind === 'symbol') provisional.symbols.push(id);
    else if (node.kind === 'endpoint') provisional.endpoints.push(id);
    else provisional.statements.push(id);
  }
  for (const k of ['symbols', 'endpoints', 'statements']) provisional[k].sort();

  // ---- provenance: which edges came out of a re-read file ----------------
  // An edge's provenance is the file whose bytes produced the fact. For a call
  // that is the CALLER's file, for a dispatch edge the implementation's, for
  // HANDLES the controller's. Rather than encode that case by case, an edge is
  // tagged when EITHER end sits in a dirty file: the tag is a disclosure, and
  // over-disclosure is the safe direction here (§10.2 — over-approximate,
  // never omit).
  const dirty = dirtyFiles.map(normalize);
  const inDirty = new Map(); // node id -> boolean (each node asked once)
  const touchesDirty = (id) => {
    let v = inDirty.get(id);
    if (v === undefined) {
      const file = graph.nodes.get(id)?.file;
      v = typeof file === 'string' && dirty.some((d) => pathMatch(normalize(file), d));
      inDirty.set(id, v);
    }
    return v;
  };
  let taggedEdges = 0;
  for (const e of graph.edges) {
    if (touchesDirty(e.from) || touchesDirty(e.to)) {
      e.evidence = { ...(e.evidence ?? {}), overlaySessionId };
      taggedEdges += 1;
    }
    if (provIds.has(e.from) || provIds.has(e.to)) {
      e.provisional = true;
      provisional.edges += 1;
    }
  }

  return { graph, javaStats, webStats, provisional, taggedEdges };
}
