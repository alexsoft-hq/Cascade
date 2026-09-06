#!/usr/bin/env node
// measure-host-memory.mjs — is the memory budget honest?
//
// The multi-project server (src/mcp/projects.mjs) bounds its pack cache with a
// budget applied to a PROXY: the pack file's size on disk plus the text length
// of its fact index. Nothing in Node can price a live object graph, so the
// question this script answers is the only one that matters in practice: how
// much V8 heap does one loaded pack actually cost, per proxy byte?
//
// It loads the SAME pack several times under different project ids (real
// copies on disk, so each is a separate cache entry), prints heapUsed after
// each load, then forces an eviction by shrinking nothing but the budget and
// prints heapUsed again. The ratio at the end is the number the budget's
// documentation rests on.
//
//   node --expose-gc scripts/measure-host-memory.mjs \
//     --pack ../target-examples/mall/.cascade/pack/pack.json --copies 4 --budget 32
//
// --expose-gc is not required but makes the numbers far less noisy: without it
// the "after" figures include garbage V8 has not collected yet, and the script
// says so rather than quietly reporting inflated heap.
//
// It writes ONLY into a scratch directory under $TMPDIR (removed on exit) and
// never touches the analysed project.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { createProjectHost, packProxyBytes } from '../src/mcp/projects.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACK = process.env.CASCADE_MALL_PACK
  || path.join(ENGINE_ROOT, '..', 'target-examples', 'mall', '.cascade', 'pack', 'pack.json');

const packFile = path.resolve(opt('pack', DEFAULT_PACK));
const copies = Number(opt('copies', '4'));
const budgetMb = Number(opt('budget', '32'));

if (!fs.existsSync(packFile)) {
  process.stderr.write(`no pack at ${packFile} — pass --pack <pack.json> (or set CASCADE_MALL_PACK)\n`);
  process.exit(2);
}
if (!Number.isInteger(copies) || copies < 2) {
  process.stderr.write('--copies must be a whole number >= 2 (one load measures nothing about a cache)\n');
  process.exit(2);
}
if (!Number.isFinite(budgetMb) || budgetMb <= 0) {
  process.stderr.write('--budget must be a positive number of megabytes\n');
  process.exit(2);
}

const gc = typeof global.gc === 'function' ? global.gc : null;
const settle = () => { if (gc) { gc(); gc(); } };
const heap = () => { settle(); return process.memoryUsage().heapUsed; };
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

// ---- N copies of the pack, each its own project ---------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-memory-'));
process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } });

const indexFile = path.join(path.dirname(packFile), 'facts-index.json');
const entries = [];
for (let i = 1; i <= copies; i += 1) {
  const id = `copy${i}`;
  const dir = path.join(work, id, '.cascade', 'pack');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(packFile, path.join(dir, 'pack.json'));
  if (fs.existsSync(indexFile)) fs.copyFileSync(indexFile, path.join(dir, 'facts-index.json'));
  entries.push({ id, dotCascadePath: path.join(work, id, '.cascade'), source: 'measure', stack: ['sql'], lastCertifiedAt: null });
}

const proxyBytes = packProxyBytes(entries[0]);
const budgetBytes = Math.floor(budgetMb * 1024 * 1024);
const holds = Math.floor(budgetBytes / proxyBytes);

process.stdout.write(`pack        ${packFile}\n`);
process.stdout.write(`proxy       ${proxyBytes} bytes (${mb(proxyBytes)} MB) per copy — pack.json`
  + `${fs.existsSync(indexFile) ? ' + facts-index.json' : ' (no fact index beside it)'}\n`);
process.stdout.write(`budget      ${budgetBytes} bytes (${budgetMb} MB) — room for ${holds} cop${holds === 1 ? 'y' : 'ies'} of this pack\n`);
process.stdout.write(`copies      ${copies}\n`);
process.stdout.write(`gc          ${gc ? 'exposed (numbers are GC-settled)' : 'NOT exposed — run with `node --expose-gc` for settled numbers'}\n\n`);

const evictionLines = [];
const host = createProjectHost({
  registry: entries,
  budgetBytes,
  log: (line) => evictionLines.push(line),
  loadProject: (entry) => {
    const pack = JSON.parse(fs.readFileSync(path.join(entry.dotCascadePath, 'pack', 'pack.json'), 'utf8'));
    const graph = loadPack(pack, { verifyDigest: true });
    return {
      graph,
      basis: { project: entry.id, buildDigest: pack.digest, builtAt: pack.meta?.builtAt ?? null, freshness: { verdict: 'unknown' } },
      trust: computeTrust({}),
      limits: [],
      pack: { project: entry.id, digest: pack.digest, builtAt: pack.meta?.builtAt ?? null, lanes: pack.meta?.lanes ?? null, axes: pack.meta?.axes ?? null },
    };
  },
});

const base = heap();
process.stdout.write(`baseline    heapUsed ${base} (${mb(base)} MB), rss ${mb(process.memoryUsage().rss)} MB\n\n`);

let previous = base;
for (const e of entries) {
  const before = evictionLines.length;
  // A real query, not just a load: the answer is what a client would receive,
  // and it forces the graph indexes the tools build.
  const resp = host.callTool('overview', { project: e.id, depth: 1 });
  const after = heap();
  const s = host.stats();
  const evicted = evictionLines.length - before;
  process.stdout.write(
    `load ${e.id.padEnd(7)} heapUsed ${String(after).padStart(11)} (${mb(after).padStart(7)} MB)  `
    + `delta ${(after - previous >= 0 ? '+' : '')}${mb(after - previous)} MB  `
    + `cache ${s.loaded} held / ${mb(s.bytes)} MB proxy / ${s.evictions} evicted`
    + `${evicted ? `  <- ${evicted} eviction(s) on this load` : ''}\n`,
  );
  process.stdout.write(`            answer: ${resp.answer.nodes.reduce((n, r) => n + r.count, 0)} nodes, `
    + `${resp.answer.edges.reduce((n, r) => n + r.count, 0)} edges, trust ${resp.trust.trustLevel}\n`);
  previous = after;
}

// ---- what one loaded pack really costs ------------------------------------
// Measured on the FIRST load, before any eviction muddies the arithmetic.
const firstLoadHeap = (() => {
  // Re-measure cleanly: drop everything, then load exactly one.
  const solo = createProjectHost({
    registry: [entries[0]],
    budgetBytes,
    loadProject: (entry) => {
      const pack = JSON.parse(fs.readFileSync(path.join(entry.dotCascadePath, 'pack', 'pack.json'), 'utf8'));
      return { graph: loadPack(pack, { verifyDigest: true }), basis: { project: entry.id, buildDigest: pack.digest, freshness: { verdict: 'unknown' } }, trust: computeTrust({}), limits: [] };
    },
  });
  const before = heap();
  solo.ctxFor(entries[0].id);
  const after = heap();
  return { before, after, delta: after - before };
})();

process.stdout.write(`\none pack alone: heapUsed ${firstLoadHeap.before} -> ${firstLoadHeap.after} `
  + `(+${mb(firstLoadHeap.delta)} MB for ${mb(proxyBytes)} MB of pack JSON = `
  + `${(firstLoadHeap.delta / proxyBytes).toFixed(1)}x the proxy)\n`);

// ---- eviction --------------------------------------------------------------
process.stdout.write('\nevictions:\n');
if (evictionLines.length === 0) process.stdout.write('  (none — the budget held every copy; lower --budget to force one)\n');
for (const line of evictionLines) process.stdout.write(`  ${line}\n`);

const held = host.list().filter((p) => p.loaded).map((p) => p.id);
const afterEviction = heap();
process.stdout.write(`\nafter evictions: heapUsed ${afterEviction} (${mb(afterEviction)} MB), `
  + `rss ${mb(process.memoryUsage().rss)} MB, holding [${held.join(', ')}]\n`);
process.stdout.write(`stats: ${JSON.stringify(host.stats())}\n`);
process.stdout.write(`net growth over ${copies} loads: ${mb(afterEviction - base)} MB of heap for a `
  + `${mb(host.stats().bytes)} MB proxy under a ${budgetMb} MB budget\n`);
