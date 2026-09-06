// mall_demo.test.mjs — the large-project demo, as a golden (SPEC §15 M11).
//
// The README makes numbered claims about macrozheng/mall. This test is what
// makes them checkable: it CLONES the fixture at the pinned commit into a temp
// directory, runs `cascade init` and then `cascade analyze` **with no lane
// flags** — the exact two commands the README's Quickstart prints — and asserts
// the claims against the pack that comes out.
//
// TWO THINGS THIS DESIGN BUYS, on purpose:
//
//  1. It exercises the DOCUMENTED path. Every other mall test reads a pack that
//     somebody already built. This one builds it the way a reader would, so a
//     regression in discovery, in the profile that `init` writes, or in lane
//     selection shows up here and nowhere else.
//
//  2. It is a determinism test with real teeth. The pack is built in a temp
//     directory, from a fresh clone, with a profile `init` wrote today — a
//     different absolute path, a different cache root, a newer profile shape
//     than the one the digest was first pinned against. It must still produce
//     digest 99141d55e969, byte for byte. If it does not, that is a determinism
//     bug to fix, not a number to loosen.
//
// The claim §15 M11 words as "column → screen round trip" is NOT claimable here
// and is not asserted: this engine has no web lane, and the mall pack declares
// `web` and `screen` as not-shipped. What IS demonstrated is the column →
// ENDPOINT round trip, and the test checks the axis declaration too, so the
// difference cannot be quietly forgotten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPack } from '../src/core/pack.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { computeTrust } from '../src/core/trust.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { MALL_COMMIT, MALL_DIGEST, MALL_REPO, mallRepoWhyNot } from './helpers/mall_fixture.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');

const gitOut = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function preflight() {
  const repo = mallRepoWhyNot(gitOut);
  if (repo) return repo;
  if (!findJdk()) return 'no JDK found: JAVA_HOME is unset and no javac on PATH (see docs/setup/java-lane.md)';
  if (!fs.existsSync(VENV_PY)) return `no venv python at ${VENV_PY} (see docs/setup/sql-lane.md)`;
  return null;
}

/** Ask the pack through the SAME catalog the MCP server and the viewer use. */
function askOf(packDir) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const graph = loadPack(pack, { verifyDigest: true });
  const ctx = {
    graph,
    basis: { project: pack.meta.project, buildDigest: pack.digest, builtAt: pack.meta.builtAt, freshness: { verdict: 'unknown' } },
    trust: computeTrust({}),
    limits: [],
    pack: {
      project: pack.meta.project, digest: pack.digest, builtAt: pack.meta.builtAt,
      lanes: pack.meta.lanes, base: pack.meta.base, axes: pack.meta.axes, laneStats: pack.meta.laneStats,
    },
    profile: null,
  };
  return { pack, graph, ask: (name, args) => callTool(name, args, ctx) };
}

/** The first path segment of an endpoint id ("POST /product/update/{id}" -> "product"). */
const groupOf = (id) => (id.split(' ')[1] || '').split('/')[1] || '(root)';

test('macrozheng/mall: the documented no-flag path reproduces the README golden', { timeout: 1800000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-mall-demo-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const repo = path.join(work, 'repo');

  // A clone, never the fixture itself: `init` writes a `.cascade/` into the tree
  // it is given, and the checkout is read-only as far as this suite is concerned.
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', MALL_REPO, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, 'checkout', '--quiet', MALL_COMMIT], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(gitOut(['-C', repo, 'rev-parse', 'HEAD']).trim(), MALL_COMMIT);

  // The home registry and the shard cache go to the temp directory too, so the
  // run changes nothing outside it.
  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(work, 'cache'), CASCADE_HOME: path.join(work, 'home') },
  });

  // ---- the two commands the Quickstart prints, verbatim in shape -----------
  const init = cli(['init', '--root', repo, '--project', 'mall']);
  assert.equal(init.status, 0, init.stderr);
  // Discovery's own census, hand-checkable against the checkout.
  assert.match(init.stderr, /524 java \(48 spring handlers, 0 JPA entities\), 104 mybatis mapper xml, 1 DDL/, init.stderr);
  assert.match(init.stderr, /lanes \[sql,java\]/);

  const analyze = cli(['analyze', '--root', repo, '--project', 'mall']);
  assert.equal(analyze.status, 0, analyze.stderr);
  // NO lane flag was passed: the inputs must have come from the project itself.
  assert.match(analyze.stderr, /mappers 4 dir\(s\) \(discovery\)/, analyze.stderr);
  assert.match(analyze.stderr, /java-src 7 root\(s\) \(discovery/, analyze.stderr);

  // ---- 1. the determinism claim -------------------------------------------
  const { pack, ask } = askOf(path.join(repo, '.cascade', 'pack'));
  assert.equal(pack.digest, MALL_DIGEST,
    'a fresh clone at a different absolute path, with a profile `init` wrote today, must produce the SAME pack');
  assert.equal(pack.meta.base.commit, MALL_COMMIT);
  assert.deepEqual(pack.meta.lanes, ['sql', 'java']);

  // ---- 2. the census the README prints ------------------------------------
  const census = Object.fromEntries(ask('overview', {}).answer.nodes.map((n) => [n.kind, n.count]));
  assert.deepEqual(census, { column: 669, endpoint: 239, statement: 906, symbol: 10784, table: 76 });

  // ---- 3. "change pms_product.price -> 8 statements write it, 10 read it" --
  // The statement axis. Every one of these edges comes from SQL the lineage
  // worker really parsed, so every one is EXACT.
  const ci = ask('column_impact', { column: 'pms_product.price' });
  const write = ci.answer.statements.filter((s) => s.access === 'write');
  const read = ci.answer.statements.filter((s) => s.access === 'read');
  assert.equal(write.length, 8, write.map((s) => s.id).join('\n'));
  assert.equal(read.length, 10, read.map((s) => s.id).join('\n'));
  assert.deepEqual([...new Set(ci.answer.statements.map((s) => s.grade))], ['EXACT']);

  // ---- 4. "...and it reaches 27 HTTP endpoints, 12 of them /product/*" -----
  // The code axis. The chain runs through candidate calls, so the grade drops
  // to SOUND_SET — never EXACT, however narrow the set got (invariant I-1).
  const ei = ask('endpoint_impact', { column: 'pms_product.price', limit: 100 });
  const endpoints = ei.answer.endpoints.map((e) => e.id).sort();
  assert.equal(endpoints.length, 27);
  assert.deepEqual([...new Set(ei.answer.endpoints.map((e) => e.grade))], ['SOUND_SET']);
  const groups = {};
  for (const id of endpoints) groups[groupOf(id)] = (groups[groupOf(id)] ?? 0) + 1;
  assert.deepEqual(groups, {
    brand: 2, cart: 1, esProduct: 3, flashProductRelation: 1,
    home: 4, member: 3, product: 12, productCategory: 1,
  });
  // The four /product/update/*Status routes the README names, spelled out.
  for (const id of ['POST /product/update/deleteStatus', 'POST /product/update/newStatus',
    'POST /product/update/publishStatus', 'POST /product/update/recommendStatus',
    'POST /product/update/verifyStatus', 'POST /product/create', 'POST /product/update/{id}']) {
    assert.ok(endpoints.includes(id), `${id} is missing from the endpoint set`);
  }

  // ---- 5. the truncation is DISCLOSED, not silent -------------------------
  // The tool's default limit is 25 and there are 27. An answer that cut two
  // rows away while calling itself complete is the failure `truncated` exists
  // to prevent, so the default call must say so and say where to continue.
  const dflt = ask('endpoint_impact', { column: 'pms_product.price' });
  const f = dflt.truncated.fields.find((x) => x.field === 'endpoints');
  assert.deepEqual({ shown: f.shown, total: f.total, nextOffset: f.nextOffset }, { shown: 25, total: 27, nextOffset: 25 });
  assert.equal(dflt.truncated.any, true);

  // ---- 6. what this demo does NOT show ------------------------------------
  // §15 M11 words the acceptance as "column -> screen". There is no web lane in
  // this engine, and the pack says so rather than leaving a reader to assume the
  // round trip reached a screen. The claim that IS demonstrated is column ->
  // endpoint, which is what the README says.
  assert.equal(pack.meta.axes.web.status, 'not-shipped');
  assert.equal(pack.meta.axes.screen.status, 'not-shipped');
  assert.equal(pack.meta.axes.jpa.status, 'not-shipped');
  assert.equal(pack.meta.axes.catalog.status, 'shipped');
  assert.equal(pack.meta.axes.statements.status, 'shipped');
  assert.equal(pack.meta.axes.column.status, 'shipped');
  assert.equal(pack.meta.axes.code.status, 'shipped');
  assert.ok(ei.trust.knownGaps.includes('web-axis-not-shipped'), ei.trust.knownGaps.join(','));

  // ---- 7. with no golden corpus, the trust level is UNCERTIFIED ------------
  assert.equal(ei.trust.trustLevel, 'UNCERTIFIED');
});

test('the demo script prints the numbers the golden asserts (same tool calls)', { timeout: 1800000 }, (t) => {
  const why = preflight();
  if (why) { t.skip(why); return; }
  // The script reads a BUILT pack when one is there. Point it at the pack the
  // sibling checkout carries; if that one is at another digest the script still
  // runs, and the assertions below only cover what it printed about ITS pack.
  const packJson = path.join(MALL_REPO, '.cascade', 'pack', 'pack.json');
  if (!fs.existsSync(packJson)) {
    t.skip(`no built mall pack at ${packJson} — run \`cascade analyze --root ${MALL_REPO}\` first`);
    return;
  }
  const pack = JSON.parse(fs.readFileSync(packJson, 'utf8'));
  if (pack.digest !== MALL_DIGEST) {
    t.skip(`the mall pack at ${packJson} has digest ${pack.digest}, not the pinned ${MALL_DIGEST}`);
    return;
  }

  const r = spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'scripts', 'demo-mall-impact.mjs'),
    '--pack', path.dirname(packJson)], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  // The same 8 / 10 / 27 / 12 the golden above asserts, through the same tools.
  assert.match(r.stdout, /WRITE \(8\)/, r.stdout);
  assert.match(r.stdout, /READ {2}\(10\)/, r.stdout);
  assert.match(r.stdout, /27 HTTP endpoint\(s\)/, r.stdout);
  assert.match(r.stdout, /\/product\/\*\s+12$/m, r.stdout);
  assert.match(r.stdout, /\[SOUND_SET\]/);
  assert.match(r.stdout, /UNCERTIFIED/, 'the demo carries no golden corpus, and must say so');
});
