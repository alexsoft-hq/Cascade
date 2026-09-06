#!/usr/bin/env node
// demo-mall-impact.mjs — the end-to-end demo on a real open-source project.
//
// It answers "if I change column X, what breaks?" over macrozheng/mall through
// the SAME tool catalog the MCP server and the viewer dispatch to — not through
// a private path that could disagree with them. That is the point of the
// rewrite: `test/mall_demo.test.mjs` asserts these numbers, and it asserts them
// by calling the same `column_impact` / `endpoint_impact`, so the demo cannot
// print one thing while the product answers another.
//
// TWO MODES, and it says which one it is in.
//
//   --pack <dir>   read a BUILT pack (both lanes). The full round trip:
//                  column -> statements (EXACT) -> HTTP endpoints (SOUND_SET).
//   (no --pack)    run the SQL lane over the checkout right here. That gives
//                  the statement axis only — with no Java lane there are no
//                  endpoints to reach, and the demo says so rather than
//                  printing a zero that reads like "nothing is affected".
//
// Prerequisites (see docs/setup/sql-lane.md):
//   - .venv with sqlglot   (python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt)
//   - target-examples/mall (git clone https://github.com/macrozheng/mall ../target-examples/mall)
//
// Usage:
//   node scripts/demo-mall-impact.mjs [--pack <dir>] [--column pms_product.price]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraphFromSql } from '../src/adapters/sql_bridge.mjs';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = path.join(ROOT, '.venv', 'bin', 'python');
const A = path.join(ROOT, 'adapters', 'sql');
const MALL = path.resolve(ROOT, '..', 'target-examples', 'mall');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const packDir = opt('pack', null);
const target = opt('column', 'pms_product.price');

function need(p, hint) {
  if (!fs.existsSync(p)) { console.error(`missing: ${p}\n  ${hint}`); process.exit(2); }
}

/**
 * A dispatch context over one graph. `basis` and `trust` are filled the way the
 * servers fill them: the trust level is COMPUTED from the state there is — which
 * here is none, so it is UNCERTIFIED, said out loud rather than a nicer label
 * nobody earned (SPEC §14.3).
 */
function contextFor(graph, meta) {
  return {
    graph,
    basis: {
      project: meta.project ?? 'mall',
      buildDigest: meta.digest ?? 'demo',
      builtAt: meta.builtAt ?? 'n/a',
      freshness: { verdict: 'unknown' },
    },
    trust: computeTrust({ axes: meta.axesList ?? ['column'] }),
    limits: [],
    pack: meta.pack ?? null,
    profile: null,
  };
}

/** Load a built pack: both lanes, so the endpoint axis is answerable. */
function fromPack(dir) {
  const file = path.join(dir, 'pack.json');
  need(file, 'build one with `node bin/cascade.mjs analyze --root ../target-examples/mall`');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  return {
    graph,
    source: `pack ${file} — digest ${pack.digest}, lanes [${(pack.meta.lanes ?? []).join(',')}]`,
    hasCode: (pack.meta.lanes ?? []).includes('java'),
    ctx: contextFor(graph, {
      project: pack.meta.project,
      digest: pack.digest,
      builtAt: pack.meta.builtAt,
      pack: {
        project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
        lanes: pack.meta.lanes, base: pack.meta.base, axes: pack.meta.axes, laneStats: pack.meta.laneStats,
      },
    }),
  };
}

/** Run the SQL lane here and now: the statement axis only. */
function fromSqlLane() {
  need(PY, 'python3 -m venv .venv && .venv/bin/pip install -r adapters/sql/requirements.txt');
  need(MALL, 'git clone https://github.com/macrozheng/mall ../target-examples/mall');
  const run = (script, args) => execFileSync(PY, [path.join(A, script), ...args], { maxBuffer: 1 << 28 }).toString('utf8');
  const jsonl = (s) => s.split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-demo-'));
  try {
    process.stderr.write('running the SQL lane over mall…\n');
    const catFile = path.join(tmp, 'catalog.jsonl');
    const stmtFile = path.join(tmp, 'statements.jsonl');
    fs.writeFileSync(catFile, run('catalog_ddl.py', [path.join(MALL, 'document', 'sql', 'mall.sql')]));
    // The SAME four mapper directories `cascade analyze --root ../target-examples/mall`
    // reads with no lane flags (discovery finds them), so this demo's numbers and
    // the pack's numbers describe one analysis, not two.
    fs.writeFileSync(stmtFile, run('mybatis_extract.py', [
      '--root', MALL,
      path.join(MALL, 'mall-admin', 'src', 'main', 'resources', 'dao'),
      path.join(MALL, 'mall-mbg', 'src', 'main', 'resources', 'com', 'macro', 'mall', 'mapper'),
      path.join(MALL, 'mall-portal', 'src', 'main', 'resources', 'dao'),
      path.join(MALL, 'mall-search', 'src', 'main', 'resources', 'dao'),
    ]));
    const catalog = jsonl(fs.readFileSync(catFile, 'utf8'));
    const lineage = jsonl(run('lineage.py', ['--catalog', catFile, '--statements', stmtFile]));
    const graph = buildGraphFromSql(catalog, lineage);
    return {
      graph,
      source: `the SQL lane, run just now over ${MALL} (no Java lane: the endpoint axis is not shipped)`,
      hasCode: false,
      ctx: contextFor(graph, { project: 'mall' }),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const { graph, source, hasCode, ctx } = packDir ? fromPack(packDir) : fromSqlLane();
const ask = (name, args) => callTool(name, args, ctx);

console.log(`# Change impact of  ${target}`);
console.log(`  source: ${source}`);
console.log(`  graph:  ${graph.nodes.size} nodes, ${graph.edges.length} edges\n`);

// --- the statement axis --------------------------------------------------
let ci;
try {
  ci = ask('column_impact', { column: target, limit: 100 });
} catch (e) {
  console.error(`column_impact: ${e.message}`);
  process.exit(1);
}
const short = (id) => id.replace('statement:', '').split('.').slice(-2).join('.');
const writers = ci.answer.statements.filter((s) => s.access === 'write');
const readers = ci.answer.statements.filter((s) => s.access === 'read');
console.log(`  comment: ${graph.nodes.get(`column:${target}`)?.comment ?? '(none)'}`
  + `   type: ${graph.nodes.get(`column:${target}`)?.type ?? '?'}\n`);
console.log(`  WRITE (${writers.length}): ${writers.map((s) => short(s.id)).join(', ')}`);
console.log(`  READ  (${readers.length}): ${readers.map((s) => short(s.id)).join(', ')}`);
console.log(`  grades: ${[...new Set(ci.answer.statements.map((s) => s.grade))].join(', ') || '(none)'}`
  + '   — direct SQL facts\n');

// --- the code axis -------------------------------------------------------
if (hasCode) {
  const ei = ask('endpoint_impact', { column: target, limit: 100 });
  const endpoints = ei.answer.endpoints.map((e) => e.id).sort();
  const groups = new Map();
  for (const id of endpoints) {
    const g = (id.split(' ')[1] || '').split('/')[1] || '(root)';
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  console.log(`  ...and it reaches ${endpoints.length} HTTP endpoint(s) `
    + `[${[...new Set(ei.answer.endpoints.map((e) => e.grade))].join(', ')}]`);
  for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    console.log(`    /${g}/*`.padEnd(26) + `  ${n}`);
  }
  console.log();
  for (const id of endpoints) console.log(`    ${id}`);
  console.log();
  for (const l of ei.limits) console.log(`  limit [${l.scope}]: ${l.reason}`);
  console.log(`\n  trust: ${ei.trust.trustLevel}   known gaps: ${ei.trust.knownGaps.join(', ') || '(none)'}`);
} else {
  console.log('  the endpoint axis is NOT SHIPPED in this run — with no Java lane there is no');
  console.log('  controller→service→mapper chain to walk, so "0 endpoints" would be the absence');
  console.log('  of the lane, not the absence of impact. Build a full pack to ask that question:');
  console.log('    node bin/cascade.mjs init --root ../target-examples/mall --project mall');
  console.log('    node bin/cascade.mjs analyze --root ../target-examples/mall');
  console.log(`    node scripts/demo-mall-impact.mjs --pack ${path.join(MALL, '.cascade', 'pack')}`);
  console.log(`\n  trust: ${ci.trust.trustLevel}   known gaps: ${ci.trust.knownGaps.join(', ') || '(none)'}`);
}

// --- the riskiest columns in the schema ----------------------------------
const radius = new Map();
for (const e of graph.edges) if (e.type === 'READS' || e.type === 'WRITES') radius.set(e.to, (radius.get(e.to) || 0) + 1);
const top = [...radius.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
console.log('\n# Columns with the widest impact radius (riskiest to change)');
for (const [cid, n] of top) {
  console.log(`  ${String(n).padStart(3)}  ${cid.replace('column:', '')}   ${graph.nodes.get(cid)?.comment ?? ''}`);
}
