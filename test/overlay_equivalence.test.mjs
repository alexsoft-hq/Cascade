// overlay_equivalence.test.mjs — an overlay over NO edit is the pack's own graph.
//
// The working-tree overlay rebuilds the graph from the base pack's cached facts
// plus the edited files, through the assembly `cascade analyze` uses
// (src/core/assemble.mjs). Its promise is that the edit is the ONLY difference:
// with no file edited, the graph it builds is the analyzed graph, node for node
// and edge for edge, grades and evidence included. Every other difference would
// show up in an answer as "your edit did this" when the edit did nothing.
//
// So each tree below is analyzed by the real CLI, and the overlay is then laid
// over it with an empty dirty set through the function the provider lays every
// overlay with (layOverlay in src/cli/overlay_provider.mjs). The comparison
// prints what differs, one line per node or edge, so a failure names the bug.
//
// The trees:
//   fullstack  the golden backend (JPA, a service, four controllers) and the
//              web-smoke frontend beside it, with its `.env`, its dev proxy and
//              its path alias
//   openapi    the same backend, a controller implementing an interface only a
//              generator writes, and the shop document it is generated from
//   ports      the same backend listening on 8081, the web-smoke frontend, and a
//              second frontend package with no config file of its own that
//              calls this machine on 8082 (another service) and on no port.
//              analyze hands the web bridge the packages discovery found and the
//              ports the Spring configuration states; the overlay used to hand
//              it neither.
//
// What the overlay cannot read again is not in this promise and is said as a
// limit instead (the Spring XML id generators, an edited package.json or Spring
// configuration); the limits are pinned at the end of this file.
//
// Needs a JDK and the SQL lane's python; skips out loud without them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPack, projectPack } from '../src/core/pack.mjs';
import { canonicalJson } from '../src/core/canonical.mjs';
import { overlaySession } from '../src/core/overlay_session.mjs';
import { classifyDirtyFiles } from '../src/core/overlay.mjs';
import { baseWebInputsOf, indexOfPack, layOverlay, webInputLimits } from '../src/cli/overlay_provider.mjs';
import { servedProfile } from '../src/cli/serve.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';
import { ENGINE_ROOT, FIXTURES, TREES, backend, commit } from '../scripts/golden-trees.mjs';
import { skipWithoutSqlLane } from './helpers/lane_prereqs.mjs';

const CLI = path.join(ENGINE_ROOT, 'bin', 'cascade.mjs');

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Where two JSON values differ, down to the leaves: `path is X in the pack and Y in the overlay`. */
function valueDifferences(a, b, at = '') {
  if (same(a, b)) return [];
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      .flatMap((k) => valueDifferences(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return [`${at || 'the value'} is ${JSON.stringify(a ?? null)} in the pack and ${JSON.stringify(b ?? null)} in the overlay`];
}

const edgeKey = (e) => `${e.from} -${e.type}-> ${e.to}`;
function byEdgeKey(edges) {
  const m = new Map();
  for (const e of edges) {
    if (!m.has(edgeKey(e))) m.set(edgeKey(e), []);
    m.get(edgeKey(e)).push({ grade: e.grade, evidence: e.evidence ?? null });
  }
  for (const list of m.values()) list.sort((x, y) => (canonicalJson(x) < canonicalJson(y) ? -1 : 1));
  return m;
}

/** Every way the overlay's graph differs from the pack's, one readable line each. */
function graphDifferences(pack, overlay) {
  const out = [];
  const nodesA = new Map(pack.nodes.map((n) => [n.id, n]));
  const nodesB = new Map(overlay.nodes.map((n) => [n.id, n]));
  for (const id of nodesA.keys()) if (!nodesB.has(id)) out.push(`node only in the pack: ${id}`);
  for (const id of nodesB.keys()) if (!nodesA.has(id)) out.push(`node only in the overlay: ${id}`);
  for (const [id, n] of nodesA) {
    if (nodesB.has(id)) out.push(...valueDifferences(n, nodesB.get(id)).map((d) => `node ${id}: ${d}`));
  }
  const edgesA = byEdgeKey(pack.edges);
  const edgesB = byEdgeKey(overlay.edges);
  for (const [k, list] of edgesA) {
    const other = edgesB.get(k);
    if (!other) out.push(`edge only in the pack: ${k} [${list.map((e) => e.grade).join(', ')}]`);
    else if (other.length !== list.length) out.push(`edge ${k}: ${list.length} of it in the pack and ${other.length} in the overlay`);
    else list.forEach((e, i) => out.push(...valueDifferences(e, other[i]).map((d) => `edge ${k}: ${d}`)));
  }
  for (const [k, list] of edgesB) if (!edgesA.has(k)) out.push(`edge only in the overlay: ${k} [${list.map((e) => e.grade).join(', ')}]`);
  return out;
}

// ---------------------------------------------------------------------------
// one tree: built, analyzed, and overlaid with no edit
// ---------------------------------------------------------------------------

function tmpDir(t, prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(repo, rel, body) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body, 'utf8');
}

/** Build the tree, commit it, `init` and `analyze` it with the real CLI; the pack's directory and its cache. */
function analyzed(t, name, build, flags) {
  const base = tmpDir(t, `cascade-overlay-eq-${name}-`);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  build(repo);
  commit(repo);
  const env = { ...process.env, CASCADE_HOME: path.join(base, 'home'), XDG_CACHE_HOME: path.join(base, 'cache') };
  const run = (args) => execFileSync(process.execPath, [CLI, ...args], { env, cwd: base, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 28 });
  run(['init', '--root', repo, '--project', `eq-${name}`]);
  const packDir = path.join(base, 'pack');
  try {
    run(['analyze', '--root', repo, '--out', packDir, ...flags(repo)]);
  } catch (e) {
    throw new Error(`analyze failed (${e.status}):\n${String(e.stderr ?? '')}`, { cause: e });
  }
  return { packDir, cache: env.XDG_CACHE_HOME };
}

/** The overlay over NO dirty file, laid the way the provider lays every overlay. */
function overlayOverNoEdit({ packDir, cache }) {
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const baseGraph = loadPack(pack, { verifyDigest: true });
  const stale = (msg) => { throw new Error(msg); };
  const idx = indexOfPack(path.join(packDir, 'facts-index.json'), pack, stale);
  const commitSha = pack.meta.base.commit;
  const session = overlaySession({ baseDigest: pack.digest, baseCommit: commitSha, headCommit: commitSha, dirtyFiles: [] });
  // The shard store is found through XDG_CACHE_HOME, as the analyze run found it.
  const was = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    const state = layOverlay({
      packDir, pack, baseGraph, profile: servedProfile(packDir, pack), idx, session, entries: [],
      baseCommit: commitSha, headCommit: commitSha, stale,
    });
    assert.equal(state.applied, true, `the overlay was not laid: ${state.reason}`);
    return { pack, state, overlay: projectPack(state.graph, {}) };
  } finally {
    if (was === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = was;
  }
}

/** The promise itself, said with every difference named. */
function assertSameGraph({ pack, state, overlay }) {
  const diffs = graphDifferences(pack, overlay);
  assert.deepEqual(diffs.slice(0, 40), [], `the overlay over no edit differs from the pack in ${diffs.length} place(s):\n  ${diffs.slice(0, 40).join('\n  ')}`);
  assert.equal(overlay.digest, pack.digest, 'and the two graphs hash the same');
  assert.deepEqual(state.limits, [], 'a pack this engine built, overlaid with no edit, has nothing to disclose');
}

function preflight(t) {
  if (skipWithoutSqlLane(t)) return false;
  if (!findJdk()) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH. Install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// the trees
// ---------------------------------------------------------------------------

test('fullstack: over no edit, the overlay builds the analyzed graph (Java, JPA, and a frontend with a .env, a dev proxy and an alias)', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const tree = TREES.find((x) => x.name === 'fullstack');
  const r = overlayOverNoEdit(analyzed(t, 'fullstack', tree.build, tree.flags));
  assert.ok(r.pack.edges.some((e) => e.type === 'CALLS_HTTP' && e.grade === 'SOUND_SET'), 'the tree has frontend calls that land on a route');
  assert.ok(r.pack.meta.laneStats.web.envFiles > 0 && r.pack.meta.laneStats.web.proxies > 0, 'and the frontend reads a .env and a proxy rule');
  assertSameGraph(r);
});

/** A controller whose route only a generated interface declares: the contract link rule's case. */
const ITEM_CONTROLLER = `package com.example.web;

import com.example.api.ItemApi;
import com.example.domain.Thing;
import com.example.service.ThingService;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ItemController implements ItemApi {
  private final ThingService service;

  public ItemController(ThingService service) {
    this.service = service;
  }

  @Override
  public Thing getItem(Long id) {
    return service.byId(id);
  }
}
`;

test('openapi: over no edit, the overlay builds the analyzed graph, the document\'s routes and its contract links included', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const r = overlayOverNoEdit(analyzed(t, 'openapi', (repo) => {
    backend(repo, { extraJava: { 'web/ItemController.java': ITEM_CONTROLLER } });
    fs.cpSync(path.join(FIXTURES, 'openapi', 'shop.yaml'), path.join(repo, 'api', 'shop.yaml'));
  }, (repo) => ['--no-mappers', '--openapi', path.join(repo, 'api', 'shop.yaml')]));
  assert.ok(r.pack.edges.some((e) => e.type === 'HANDLES' && e.evidence?.rule === 'openapi-generator.spring-interface'), 'the tree has a contract link');
  assert.ok(r.pack.nodes.some((n) => n.kind === 'endpoint' && n.source === 'openapi'), 'and a route only the document declares');
  assertSameGraph(r);
});

/**
 * A frontend package with nothing but its package.json: no .env, no proxy, no
 * alias and no `src` directory (the worker assumes an `@` alias for a package
 * with one, and that record would name the package too), so only discovery
 * names it. A call through the axios module itself is filed under the package
 * it is made in (`admin#(module axios)`).
 */
const ADMIN_PACKAGE = '{\n  "name": "admin",\n  "private": true,\n  "dependencies": { "axios": "^1.7.0", "react": "^18.3.0" }\n}\n';
const ADMIN_API = `import axios from 'axios';

// Another service on this machine, and this one through the dev server.
export function listRemote() {
  return fetch('http://localhost:8082/things/list');
}

export function listHere() {
  return axios.get('/things/list');
}
`;

test('ports and packages: over no edit, the overlay hands the web bridge the packages and the ports the analyzed run handed it', { timeout: 600000 }, (t) => {
  if (!preflight(t)) return;
  const r = overlayOverNoEdit(analyzed(t, 'ports', (repo) => {
    backend(repo);
    write(repo, 'src/main/resources/application.yml', 'server:\n  port: 8081\n');
    fs.cpSync(path.join(FIXTURES, 'web-smoke'), path.join(repo, 'front'), { recursive: true });
    write(repo, 'admin/package.json', ADMIN_PACKAGE);
    write(repo, 'admin/api/remote.js', ADMIN_API);
  }, (repo) => ['--web-src', path.join(repo, 'front', 'src'), '--web-src', path.join(repo, 'admin'), '--no-mappers']));
  // The tree is only a test if analyze really decided something by each input.
  const web = r.pack.meta.laneStats.web;
  assert.deepEqual([web.ports.known, web.ports.ports], [true, [8081]], 'the run read the port the backend listens on');
  assert.deepEqual(web.packages, ['admin/package.json', 'front/package.json'], 'and recorded the packages discovery found');
  const remote = r.pack.edges.find((e) => e.type === 'CALLS_HTTP' && e.from.endsWith('remote.js#listRemote'));
  assert.equal(remote?.evidence?.away?.called, 8082, 'the call on 8082 is another service\'s');
  assert.equal(remote.grade, 'UNRESOLVED');
  const here = r.pack.edges.find((e) => e.type === 'CALLS_HTTP' && e.from.endsWith('remote.js#listHere'));
  assert.match(here?.evidence?.sink?.instance ?? '', /^admin#/, 'and the admin package files its own calls');
  assertSameGraph(r);
});

// ---------------------------------------------------------------------------
// what the overlay does not read again, said
// ---------------------------------------------------------------------------

const PORTS_8081 = { known: true, ports: [8081], files: ['src/main/resources/application.yml'], defaulted: false, why: null, otherPortCalls: 1 };
const packWith = (web) => ({ meta: { laneStats: { web } } });

test('the packages and ports the base pack read are handed back as it recorded them, and a package.json gone from the tree is not one', (t) => {
  const root = tmpDir(t, 'cascade-overlay-eq-inputs-');
  write(root, 'front/package.json', '{}\n');
  const inputs = baseWebInputsOf(packWith({ packages: ['front/package.json', 'gone/package.json'], ports: PORTS_8081 }), root);
  assert.deepEqual(inputs.packages, [{ path: 'front/package.json' }]);
  assert.deepEqual(inputs.serverPorts, { known: true, ports: [8081], files: ['src/main/resources/application.yml'], defaulted: false, why: null });
  assert.equal(inputs.recorded, true);
  const old = baseWebInputsOf(packWith({}), root);
  assert.deepEqual([old.packages, old.serverPorts, old.recorded], [[], null, false], 'a pack from before either record keeps neither');
});

test('an edited package.json or Spring configuration, and a pack that kept no package list, are said as limits', () => {
  const selection = { webRoots: ['front/src'], javaRoots: ['src/main/java'] };
  const limitsFor = (web, entries) => {
    const pack = packWith(web);
    return webInputLimits(pack, entries, classifyDirtyFiles(entries, selection), baseWebInputsOf(pack, os.tmpdir()));
  };
  const recorded = { packages: [], ports: PORTS_8081 };
  assert.deepEqual(limitsFor(recorded, [{ path: 'front/src/App.vue', status: 'M' }]), [], 'an edit to source says nothing');
  assert.deepEqual(limitsFor(recorded, [{ path: 'front/package.json', status: 'D' }]), [], 'a deleted package.json is simply not a package, as analyze would see it');
  const [pkg] = limitsFor(recorded, [{ path: 'front/package.json', status: 'M' }]);
  assert.equal(pkg.scope, 'overlay');
  assert.match(pkg.reason, /^front\/package\.json changed since the pack was built\. The overlay takes which directories are frontend packages from the base pack/);
  const [port] = limitsFor(recorded, [{ path: 'src/main/resources/application.yml', status: 'M' }]);
  assert.match(port.reason, /by the ports the base pack read \(port 8081\) and does not read them again/);
  assert.deepEqual(limitsFor({ packages: [] }, [{ path: 'src/main/resources/application.yml', status: 'M' }]), [],
    'with no ports read, nothing was decided by port, so there is nothing to go stale');
  const [old] = limitsFor({ ports: PORTS_8081 }, []);
  assert.match(old.reason, /^this pack does not record which frontend packages its run read/);
  assert.deepEqual(webInputLimits({ meta: {} }, [{ path: 'front/package.json', status: 'M' }], { webConfig: ['front/package.json'] }, { recorded: false, serverPorts: null }), [],
    'a pack with no web lane has no web inputs to go stale');
  for (const l of [pkg, port, old]) assert.doesNotMatch(l.reason, /[—·]/);
});
