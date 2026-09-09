#!/usr/bin/env node
// measure-pack-cost.mjs — what does one pack COST to ship, load and query?
//
// The numbers behind SPEC §2.3 (the performance gates) and §13 (response size
// limits), measured rather than assumed:
//
//   pack bytes / index bytes    what the analysis ships
//   load                        JSON.parse + loadPack, wall clock
//   heap                        what a loaded pack costs in V8, next to the
//                               RM7 PROXY the memory budget is applied to
//                               (pack.json bytes + fact-index text length) —
//                               run under `node --expose-gc` or the heap
//                               numbers include uncollected garbage and the
//                               report says so
//   per tool                    p50 / p95 through callTool (the real dispatch
//                               path, contract stamping included) and the size
//                               of the JSON a client would receive
//
// Every tool is called with arguments DERIVED FROM THE PACK (the busiest table,
// a column of it, the endpoint that reaches the most tables), so the same
// command measures mall, a synthetic project, or anything else — and measures
// the expensive end of each tool rather than a lucky empty answer.
//
// --max-limits additionally calls every tool at its DOCUMENTED MAXIMUM limit,
// which is the §13 question: how big can this answer get if a client asks for
// everything it is allowed to ask for?
//
//   node --expose-gc scripts/measure-pack-cost.mjs \
//     --pack ../target-examples/mall/.cascade/pack/pack.json --reps 7 --max-limits
//
// Reads only; writes nothing except the optional --json report.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { cacheDir } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACK = process.env.CASCADE_MALL_PACK
  || path.join(ENGINE_ROOT, '..', 'target-examples', 'mall', '.cascade', 'pack', 'pack.json');

const packFile = path.resolve(opt('pack', DEFAULT_PACK));
const reps = Number(opt('reps', '7'));
const jsonOut = opt('json', null);
const maxLimits = flag('max-limits');

if (!fs.existsSync(packFile)) {
  process.stderr.write(`no pack at ${packFile} — pass --pack <pack.json>\n`);
  process.exit(2);
}
if (!Number.isInteger(reps) || reps < 1) {
  process.stderr.write('--reps must be a whole number >= 1\n');
  process.exit(2);
}

const gc = typeof global.gc === 'function' ? global.gc : null;
const settle = () => { if (gc) { gc(); gc(); } };
const heapUsed = () => { settle(); return process.memoryUsage().heapUsed; };
const mb = (n) => (n / (1024 * 1024)).toFixed(1);
const kb = (n) => (n / 1024).toFixed(1);
const ms = (n) => n.toFixed(1);

// ---- 1. what the analysis shipped -----------------------------------------
const packBytes = fs.statSync(packFile).size;
const indexFile = path.join(path.dirname(packFile), 'facts-index.json');
const indexBytes = fs.existsSync(indexFile) ? fs.statSync(indexFile).size : 0;
// The CAS (content-addressed fact shards) does not sit beside the pack at all:
// it lives in the user's cache directory, keyed by project id (core/paths.mjs).
// The fact index beside the pack names that project, so the size is measured
// where the shards really are rather than reported as 0.
const idxProject = readIndexProject(indexFile);
const casRoot = idxProject ? cacheDir(idxProject) : null;
const casBytes = casRoot ? dirBytes(path.join(casRoot, 'cas')) : 0;

// ---- 2. load: parse + build, and what it costs in heap ---------------------
// TWO heap numbers, because they answer two different questions and quoting one
// for the other is how a memory budget ends up wrong by 2x:
//   PEAK      everything alive at once — the file text, the parsed JSON and the
//             Graph built from it. This is what a load transiently needs.
//   RESIDENT  what the server actually HOLDS: the Graph. The text and the
//             parsed pack are released once the graph exists (the pack's own
//             metadata is copied out first), so this is the number the LRU's
//             budget should be read against.
const heapBefore = heapUsed();
const t0 = performance.now();
let packText = fs.readFileSync(packFile, 'utf8');
const tRead = performance.now();
let pack = JSON.parse(packText);
const tParse = performance.now();
const graph = loadPack(pack);
const tLoad = performance.now();
const heapPeak = heapUsed();

// Copy out everything the report and the tool context need, then let the parsed
// pack and its source text go.
const packInfo = {
  digest: pack.digest,
  counts: pack.counts ?? { nodes: pack.nodes.length, edges: pack.edges.length },
  meta: {
    project: pack.meta?.project ?? 'measured',
    builtAt: pack.meta?.builtAt ?? null,
    lanes: pack.meta?.lanes ?? null,
    axes: pack.meta?.axes ?? null,
    laneStats: pack.meta?.laneStats ?? null,
  },
};
// THE POINT OF THESE TWO LINES IS THE ASSIGNMENT, not the value. Dropping the
// last reference to the pack text and the parsed pack is what lets the heap
// reading below be about the GRAPH rather than about the JSON it was built
// from. A linter is right that nothing reads them again, and wrong that they
// can go.
// eslint-disable-next-line no-useless-assignment
packText = null;
// eslint-disable-next-line no-useless-assignment
pack = null;
const heapResident = heapUsed();

const proxyBytes = packBytes + indexBytes;

// ---- 3. arguments derived from the pack ------------------------------------
const pick = derivePickings(graph);

const ctx = {
  graph,
  basis: {
    project: packInfo.meta.project,
    buildDigest: packInfo.digest,
    builtAt: packInfo.meta.builtAt,
    freshness: { verdict: 'unknown' },
  },
  trust: computeTrust({}),
  limits: [],
  pack: { project: packInfo.meta.project, digest: packInfo.digest, ...packInfo.meta },
};

// name → [label, args, atMaxLimit?]
const CALLS = [];
const add = (label, tool, args, maxArgs) => CALLS.push({ label, tool, args, maxArgs: maxArgs ?? null });
add('overview', 'overview', {});
add('map', 'map', {}, { limit: 20000 });
add('map +statements', 'map', { layers: ['statements'] }, { layers: ['statements'], limit: 20000 });
add('coupling column', 'coupling', { axis: 'column' }, { axis: 'column', limit: 500 });
add('coupling table', 'coupling', { axis: 'table' }, { axis: 'table', limit: 500 });
add('erd whole', 'erd', {});
if (pick.table) add('erd table', 'erd', { table: pick.table }, { table: pick.table, hops: 4 });
add('flow list', 'flow', {}, { limit: 500 });
if (pick.endpoint) add('flow down', 'flow', { endpoint: pick.endpoint }, { endpoint: pick.endpoint, depth: 8, limit: 200 });
if (pick.column) add('flow up', 'flow', { direction: 'up', column: pick.column }, { direction: 'up', column: pick.column, depth: 8, limit: 200 });
add('transactions list', 'transactions', {}, { limit: 100 });
if (pick.transaction) add('transactions one', 'transactions', { method: pick.transaction }, { method: pick.transaction, limit: 100 });
if (pick.column) add('column_impact', 'column_impact', { column: pick.column }, { column: pick.column, limit: 100 });
if (pick.column) add('endpoint_impact', 'endpoint_impact', { column: pick.column }, { column: pick.column, limit: 100 });
if (pick.table) add('table_usage', 'table_usage', { table: pick.table }, { table: pick.table, limit: 100 });
if (pick.table) add('neighborhood', 'neighborhood', { table: pick.table, direction: 'both' }, { table: pick.table, direction: 'both', hops: 5, limit: 800 });
add('search', 'search', { query: pick.searchTerm }, { query: pick.searchTerm, limit: 100 });

const rows = [];
for (const c of CALLS) {
  rows.push(measure(c.label, c.tool, c.args, false));
  if (maxLimits && c.maxArgs) rows.push(measure(`${c.label} @max`, c.tool, c.maxArgs, true));
}

function measure(label, tool, args, atMax) {
  const times = [];
  let bytes = 0;
  let error = null;
  let truncatedAny = null;
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    let resp;
    try {
      resp = callTool(tool, args, ctx);
    } catch (e) {
      error = `${e.name}: ${e.message}`;
      break;
    }
    times.push(performance.now() - s);
    if (i === 0) {
      bytes = Buffer.byteLength(JSON.stringify(resp), 'utf8');
      truncatedAny = resp.truncated ? resp.truncated.any === true : null;
    }
  }
  if (error) return { label, tool, atMax, error };
  times.sort((a, b) => a - b);
  return {
    label, tool, atMax,
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)],
    max: times[times.length - 1],
    bytes,
    truncated: truncatedAny,
  };
}

// ---- report ----------------------------------------------------------------
const out = [];
const say = (s) => { out.push(s); process.stdout.write(`${s}\n`); };

say(`pack        ${packFile}`);
say(`digest      ${packInfo.digest}   nodes ${packInfo.counts.nodes}   edges ${packInfo.counts.edges}`);
say(`bytes       pack ${packBytes} (${mb(packBytes)} MB)   index ${indexBytes} (${mb(indexBytes)} MB)   `
  + `CAS ${casBytes} (${mb(casBytes)} MB)${casRoot ? ` at ${path.join(casRoot, 'cas')}` : ' — no fact index, so the shard cache was not located'}`);
say(`load        read ${ms(tRead - t0)} ms + parse ${ms(tParse - tRead)} ms + loadPack ${ms(tLoad - tParse)} ms = ${ms(tLoad - t0)} ms`);
say(`heap        peak +${mb(heapPeak - heapBefore)} MB (${((heapPeak - heapBefore) / proxyBytes).toFixed(1)}x proxy, text+JSON+graph alive)`
  + `   resident +${mb(heapResident - heapBefore)} MB (${((heapResident - heapBefore) / proxyBytes).toFixed(1)}x proxy, the graph the server holds)`
  + `${gc ? '' : '   [NOT --expose-gc: includes uncollected garbage, read as an upper bound]'}`);
say(`picks       table=${pick.table} column=${pick.column} endpoint=${pick.endpoint} transaction=${pick.transaction} search="${pick.searchTerm}"`);
say(`reps        ${reps} per call`);
say('');
say(`${'tool call'.padEnd(24)}${'p50 ms'.padStart(9)}${'p95 ms'.padStart(9)}${'answer KB'.padStart(11)}   truncated`);
for (const r of rows) {
  if (r.error) { say(`${r.label.padEnd(24)}  ERROR ${r.error}`); continue; }
  say(`${r.label.padEnd(24)}${ms(r.p50).padStart(9)}${ms(r.p95).padStart(9)}${kb(r.bytes).padStart(11)}   ${r.truncated === null ? '-' : r.truncated}`);
}
const biggest = rows.filter((r) => !r.error).sort((a, b) => b.bytes - a.bytes)[0];
const slowest = rows.filter((r) => !r.error).sort((a, b) => b.p95 - a.p95)[0];
say('');
say(`biggest answer  ${biggest.label}: ${kb(biggest.bytes)} KB (truncated=${biggest.truncated})`);
say(`slowest p95     ${slowest.label}: ${ms(slowest.p95)} ms`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, `${JSON.stringify({
    pack: packFile,
    digest: packInfo.digest,
    counts: packInfo.counts,
    bytes: { pack: packBytes, index: indexBytes, cas: casBytes, proxy: proxyBytes },
    load: { readMs: tRead - t0, parseMs: tParse - tRead, buildMs: tLoad - tParse, totalMs: tLoad - t0 },
    heap: {
      peakBytes: heapPeak - heapBefore, residentBytes: heapResident - heapBefore, proxyBytes,
      peakRatio: (heapPeak - heapBefore) / proxyBytes,
      residentRatio: (heapResident - heapBefore) / proxyBytes,
      gcExposed: !!gc,
    },
    picks: pick,
    reps,
    rows,
  }, null, 1)}\n`);
  process.stdout.write(`\nwrote ${jsonOut}\n`);
}

// ---------------------------------------------------------------------------

/** The project id the fact index records, or null when there is no index. */
function readIndexProject(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).project ?? null; } catch { return null; }
}

/** Total size of a directory tree, 0 when it is absent. */
function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(dir);
  return total;
}

/**
 * The most expensive arguments this pack can be asked: the table the most
 * statements execute, one of its columns, the endpoint that reaches the most
 * tables, and a @Transactional method. Derived, never hard-coded, so the same
 * script measures any pack.
 */
function derivePickings(g) {
  const stmtsPerTable = new Map();
  const colsPerTable = new Map();
  for (const e of g.edges) {
    if (e.type === 'EXECUTES') stmtsPerTable.set(e.to, (stmtsPerTable.get(e.to) ?? 0) + 1);
    else if (e.type === 'DECLARES') {
      const arr = colsPerTable.get(e.from) ?? [];
      arr.push(e.to);
      colsPerTable.set(e.from, arr);
    }
  }
  const tableId = [...stmtsPerTable.entries()].sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0]))[0]?.[0]
    ?? [...g.nodes.values()].find((n) => n.kind === 'table')?.id ?? null;
  // The column of that table that the most statements touch.
  const touches = new Map();
  for (const e of g.edges) {
    if (e.type !== 'READS' && e.type !== 'WRITES') continue;
    touches.set(e.to, (touches.get(e.to) ?? 0) + 1);
  }
  const cols = (tableId ? colsPerTable.get(tableId) : null) ?? [];
  const columnId = cols.sort((a, b) => ((touches.get(b) ?? 0) - (touches.get(a) ?? 0)) || cmp(a, b))[0]
    ?? [...touches.entries()].sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0]))[0]?.[0] ?? null;
  // The endpoint with the most HANDLES-reachable statements is expensive to
  // find; the one whose handler has the most outgoing calls is a good, cheap
  // proxy for "the biggest chain".
  let endpointId = null;
  let bestDeg = -1;
  for (const n of g.nodes.values()) {
    if (n.kind !== 'endpoint') continue;
    let deg = 0;
    for (const e of g.outEdges(n.id)) if (e.type === 'HANDLES') deg += g.outEdges(e.to).length;
    if (deg > bestDeg) { bestDeg = deg; endpointId = n.id; }
  }
  const tx = [...g.nodes.values()].find((n) => n.kind === 'symbol' && n.transactional === true);
  const strip = (id) => (id ? id.slice(id.indexOf(':') + 1) : null);
  // A substring every pack has something for: the first two characters of the
  // busiest table's name (search demands at least two).
  const tName = strip(tableId) ?? 'ab';
  return {
    table: strip(tableId),
    column: strip(columnId),
    endpoint: strip(endpointId),
    transaction: tx ? strip(tx.id) : null,
    searchTerm: tName.replace(/^[^.]*\./, '').slice(0, 3) || 'ab',
  };
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
