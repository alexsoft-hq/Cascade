// overlay_trees.mjs — build a tree, analyze it with the real CLI, and lay the working-tree overlay over it.
//
// The overlay tests that need the real workers (a JDK and the SQL lane's
// python) share these: a tree committed in a temp directory, `init` and
// `analyze` run by the CLI, and the overlay laid either through the function the
// provider lays every overlay with (layOverlay) or through the provider itself,
// which also reads git.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPack, projectPack } from '../../src/core/pack.mjs';
import { canonicalJson } from '../../src/core/canonical.mjs';
import { overlaySession } from '../../src/core/overlay_session.mjs';
import { indexOfPack, layOverlay, makeOverlayProvider } from '../../src/cli/overlay_provider.mjs';
import { servedProfile } from '../../src/cli/serve.mjs';
import { findJdk } from '../../scripts/ci-java-smoke.mjs';
import { ENGINE_ROOT } from '../../scripts/golden-trees.mjs';
import { skipWithoutSqlLane } from './lane_prereqs.mjs';

export const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

/** Skip out loud without a JDK or the SQL lane; true when the test may run. */
export function preflight(t) {
  if (skipWithoutSqlLane(t)) return false;
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH. Install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return false;
  }
  return true;
}

export function tmpDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function write(dir, rel, body) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, 'utf8');
}

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
}

/** `git init` and one commit of everything in `dir`. */
export function commitAll(dir, message = 'base') {
  if (!fs.existsSync(path.join(dir, '.git'))) git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

/**
 * A project laid out under a temp directory: `build(base)` writes and commits
 * whatever it needs there (the analyzed root is `<base>/repo`), then `init` and
 * `analyze` run with the pack in the project's own `.cascade/pack`, as a user's
 * run puts it. `afterInit(repo)` edits what `init` wrote before the run reads it.
 */
export function analyzedProject(t, name, { build, flags = () => [], afterInit = null }) {
  const base = tmpDir(t, `cascade-overlay-${name}-`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  build(base, repo);
  const env = { ...process.env, CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const run = (args) => {
    try {
      return execFileSync(process.execPath, [CLI, ...args], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString('utf8');
    } catch (e) {
      throw new Error(`cascade ${args[0]} failed (${e.status}):\n${String(e.stderr ?? '').slice(-4000)}`, { cause: e });
    }
  };
  run(['init', '--root', repo, '--project', `ovl-${name}`]);
  if (afterInit) afterInit(repo);
  run(['analyze', '--root', repo, '--project', `ovl-${name}`, ...flags(base, repo)]);
  return { base, repo, packDir: path.join(repo, '.cascade', 'pack'), cache: env.XDG_CACHE_HOME, run };
}

/** Run `fn` with the shard cache the analyze run used. */
export function withCache(cache, fn) {
  const was = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try { return fn(); } finally {
    if (was === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = was;
  }
}

/** The pack beside `packDir`, its graph, and the profile a server would answer with. */
export function packOf(packDir) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  return { pack, baseGraph: loadPack(pack, { verifyDigest: true }), profile: servedProfile(packDir, pack) };
}

/**
 * The overlay over the given dirty entries (none by default), laid by the
 * function the provider lays every overlay with, at the pack's own commit.
 */
export function layOver({ packDir, cache }, entries = []) {
  const { pack, baseGraph, profile } = packOf(packDir);
  const stale = (msg) => { throw new Error(msg); };
  const idx = indexOfPack(path.join(packDir, 'facts-index.json'), pack, stale);
  const c = pack.meta.base.commit;
  const session = overlaySession({ baseDigest: pack.digest, baseCommit: c, headCommit: c, dirtyFiles: entries.map((e) => ({ path: e.path, sha256: null })) });
  const state = withCache(cache, () => layOverlay({ packDir, pack, baseGraph, profile, idx, session, entries, baseCommit: c, headCommit: c, stale }));
  return { pack, baseGraph, state, overlay: state.graph ? projectPack(state.graph, {}) : null };
}

/** The provider a server builds for this pack, and a call to it that uses the run's cache. */
export function providerOf({ packDir, cache }) {
  const { pack, baseGraph, profile } = packOf(packDir);
  const provider = makeOverlayProvider({ packDir, pack, baseGraph, profile });
  return { pack, baseGraph, call: () => withCache(cache, provider) };
}

const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function valueDifferences(a, b, at = '') {
  if (same(a, b)) return [];
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => valueDifferences(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return [`${at || 'the value'} is ${JSON.stringify(a ?? null)} in the pack and ${JSON.stringify(b ?? null)} in the overlay`];
}

const edgeKey = (e) => `${e.from} -${e.type}-> ${e.to}`;

/** Every way one projected graph differs from another, one readable line each. */
export function graphDifferences(pack, overlay) {
  const out = [];
  const nodesA = new Map(pack.nodes.map((n) => [n.id, n]));
  const nodesB = new Map(overlay.nodes.map((n) => [n.id, n]));
  for (const id of nodesA.keys()) if (!nodesB.has(id)) out.push(`node only in the pack: ${id}`);
  for (const id of nodesB.keys()) if (!nodesA.has(id)) out.push(`node only in the overlay: ${id}`);
  for (const [id, n] of nodesA) if (nodesB.has(id)) out.push(...valueDifferences(n, nodesB.get(id)).map((d) => `node ${id}: ${d}`));
  const group = (edges) => {
    const m = new Map();
    for (const e of edges) { if (!m.has(edgeKey(e))) m.set(edgeKey(e), []); m.get(edgeKey(e)).push({ grade: e.grade, evidence: e.evidence ?? null }); }
    for (const l of m.values()) l.sort((x, y) => (canonicalJson(x) < canonicalJson(y) ? -1 : 1));
    return m;
  };
  const edgesA = group(pack.edges);
  const edgesB = group(overlay.edges);
  for (const [k, l] of edgesA) {
    const o = edgesB.get(k);
    if (!o) out.push(`edge only in the pack: ${k}`);
    else if (o.length !== l.length) out.push(`edge ${k}: ${l.length} in the pack and ${o.length} in the overlay`);
    else l.forEach((e, i) => out.push(...valueDifferences(e, o[i]).map((d) => `edge ${k}: ${d}`)));
  }
  for (const k of edgesB.keys()) if (!edgesA.has(k)) out.push(`edge only in the overlay: ${k}`);
  return out;
}

/** The overlay over no edit is the pack's own graph, every difference named. */
export function assertSameGraph({ pack, state, overlay }) {
  assert.equal(state.applied, true, `the overlay was not laid: ${state.reason}`);
  const diffs = graphDifferences(pack, overlay);
  assert.deepEqual(diffs.slice(0, 40), [], `the overlay over no edit differs from the pack in ${diffs.length} place(s):\n  ${diffs.slice(0, 40).join('\n  ')}`);
  assert.equal(overlay.digest, pack.digest);
}
