import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectHost, packProxyBytes, packDirOf, DEFAULT_BUDGET_BYTES } from '../src/mcp/projects.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { callTool as catalogCallTool } from '../src/mcp/catalog.mjs';
import { makeScratch } from '../src/core/scratch.mjs';

// The multi-project host (SPEC §13 MUST, §15 M8, §17.6): lazy loading, an LRU
// with a memory budget, and routing that refuses to guess which project a call
// is about. Everything below runs on FAKE loaders — no pack, no filesystem —
// so the cache arithmetic and the error texts are pinned exactly.

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function entries(...specs) {
  return specs.map(([id, bytes]) => ({
    id,
    dotCascadePath: `/tmp/${id}/.cascade`,
    source: 'init',
    stack: ['sql'],
    lastCertifiedAt: `2026-09-0${1 + (id.charCodeAt(0) % 8)}T00:00:00.000Z`,
    __bytes: bytes,
  }));
}

/** A host over fake loaders; `loaded` records the load order for assertions. */
function makeHost(specs, opts = {}) {
  const loaded = [];
  const evictions = [];
  const host = createProjectHost({
    registry: entries(...specs),
    loadProject: (entry) => {
      loaded.push(entry.id);
      if (opts.failOn === entry.id) throw new Error('pack.json is not valid JSON');
      return { graph: { id: entry.id }, basis: { project: entry.id, buildDigest: `d-${entry.id}`, freshness: { verdict: 'unknown' } } };
    },
    measureBytes: (entry) => entry.__bytes,
    budgetBytes: opts.budgetBytes,
    now: opts.now ?? (() => 'T0'),
    log: (line) => evictions.push(line),
  });
  return { host, loaded, evictions };
}

// ---------------------------------------------------------------------------
// Lazy
// ---------------------------------------------------------------------------

test('list(): reads the registry only — it loads NO pack, and says nothing is loaded', () => {
  const { host, loaded } = makeHost([['alpha', 10], ['beta', 20]]);
  const list = host.list();
  assert.deepEqual(loaded, [], 'listing must not load a pack');
  assert.deepEqual(list.map((p) => p.id), ['alpha', 'beta']);
  assert.deepEqual(list.map((p) => p.loaded), [false, false]);
  assert.deepEqual(list.map((p) => p.bytes), [null, null]);
  // `meta` is the pack's own summary and is only there for a LOADED project:
  // reading it for an unloaded one would mean parsing the pack, which is the
  // one thing listing must not do.
  assert.deepEqual(list.map((p) => p.meta), [null, null]);
  // `federation` comes from the SIDECAR (routes.json), which these fake entries
  // have no directory for: absent, and the listing says which, without ever
  // opening a pack.
  assert.deepEqual(list.map((p) => p.federation), [
    { index: 'absent', reason: 'no-index' }, { index: 'absent', reason: 'no-index' },
  ]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['bytes', 'dotCascadePath', 'federation', 'id', 'lastCertifiedAt', 'loaded', 'meta', 'stack']);
  assert.deepEqual(host.stats(), { loaded: 0, bytes: 0, budgetBytes: DEFAULT_BUDGET_BYTES, evictions: 0, hits: 0, misses: 0 });
});

test('ctxFor(): loads on FIRST use, then serves the same object from the cache', () => {
  const { host, loaded } = makeHost([['alpha', 10], ['beta', 20]]);
  const first = host.ctxFor('alpha');
  const second = host.ctxFor('alpha');
  assert.equal(first, second, 'a cache hit must return the same context, not a re-load');
  assert.deepEqual(loaded, ['alpha'], 'beta was never asked for, so it was never loaded');
  const list = host.list();
  assert.deepEqual(list.find((p) => p.id === 'alpha'), {
    id: 'alpha', dotCascadePath: '/tmp/alpha/.cascade', stack: ['sql'],
    lastCertifiedAt: list.find((p) => p.id === 'alpha').lastCertifiedAt, loaded: true, bytes: 10,
    federation: { index: 'absent', reason: 'no-index' },
    // Now that the pack IS in memory, the listing relays what it says about
    // itself — read off the loaded context, never recomputed.
    meta: { project: 'alpha', digest: 'd-alpha', builtAt: null, lanes: null, axes: null, freshness: { verdict: 'unknown' } },
  });
  const beta = host.list().find((p) => p.id === 'beta');
  assert.equal(beta.loaded, false);
  assert.equal(beta.meta, null, 'an unloaded project has no meta to relay');
  assert.deepEqual(host.stats(), { loaded: 1, bytes: 10, budgetBytes: DEFAULT_BUDGET_BYTES, evictions: 0, hits: 1, misses: 1 });
});

// ---------------------------------------------------------------------------
// LRU + budget
// ---------------------------------------------------------------------------

test('the budget is a boundary: exactly at it nothing is evicted, one byte over evicts', () => {
  const fits = makeHost([['a', 60], ['b', 40]], { budgetBytes: 100 });
  fits.host.ctxFor('a');
  fits.host.ctxFor('b');
  assert.deepEqual(fits.host.list().map((p) => p.loaded), [true, true], '60+40 == the budget: both stay');
  assert.equal(fits.host.stats().evictions, 0);
  assert.deepEqual(fits.evictions, []);

  const over = makeHost([['a', 60], ['b', 41]], { budgetBytes: 100 });
  over.host.ctxFor('a');
  over.host.ctxFor('b');
  assert.deepEqual(over.host.list().map((p) => p.loaded), [false, true], '101 > 100: the least recently used goes');
  assert.equal(over.host.stats().evictions, 1);
  assert.equal(over.host.stats().bytes, 41);
  assert.equal(over.evictions.length, 1, 'one log line per eviction');
  assert.match(over.evictions[0], /^cascade: evicted project a \(60 bytes/);
});

test('eviction is LEAST-RECENTLY-USED, not least-recently-loaded', () => {
  const { host, loaded } = makeHost([['a', 40], ['b', 40], ['c', 40]], { budgetBytes: 100 });
  host.ctxFor('a');
  host.ctxFor('b');
  host.ctxFor('a'); // a is now the most recently USED, though it was loaded first
  host.ctxFor('c'); // 120 > 100 -> evict the LRU, which is b
  assert.deepEqual(host.list().map((p) => [p.id, p.loaded]), [['a', true], ['b', false], ['c', true]]);
  assert.deepEqual(loaded, ['a', 'b', 'c']);
  // …and asking for b again re-loads it, evicting the LRU (now a).
  host.ctxFor('b');
  assert.deepEqual(loaded, ['a', 'b', 'c', 'b']);
  assert.deepEqual(host.list().map((p) => [p.id, p.loaded]), [['a', false], ['b', true], ['c', true]]);
  assert.deepEqual(host.stats(), { loaded: 2, bytes: 80, budgetBytes: 100, evictions: 2, hits: 1, misses: 4 });
});

test('eviction keeps evicting until it fits — one load can push out several', () => {
  const { host, evictions } = makeHost([['a', 30], ['b', 30], ['big', 90]], { budgetBytes: 100 });
  host.ctxFor('a');
  host.ctxFor('b');
  host.ctxFor('big');
  assert.deepEqual(host.list().map((p) => [p.id, p.loaded]), [['a', false], ['b', false], ['big', true]]);
  assert.equal(evictions.length, 2);
  assert.equal(host.stats().bytes, 90);
});

test('a pack that does not fit ALONE is refused, and nothing is loaded', () => {
  const { host, loaded } = makeHost([['huge', 200]], { budgetBytes: 100 });
  assert.throws(() => host.ctxFor('huge'), (e) => {
    assert.equal(e.name, 'DispatchError');
    assert.equal(e.code, 'pack-unreadable');
    assert.match(e.message, /^pack of huge \(200\) exceeds the memory budget \(100\)/);
    return true;
  });
  assert.deepEqual(loaded, [], 'refused BEFORE the load — no partial pack in memory');
  assert.deepEqual(host.list()[0].loaded, false);
  assert.equal(host.stats().bytes, 0);
});

test('a pack that cannot be read is pack-unreadable, and the cache stays clean', () => {
  const { host } = makeHost([['a', 10], ['broken', 10]], { failOn: 'broken' });
  assert.throws(() => host.ctxFor('broken'), (e) => {
    assert.equal(e.code, 'pack-unreadable');
    assert.match(e.message, /pack of broken could not be loaded: pack\.json is not valid JSON/);
    return true;
  });
  assert.equal(host.stats().loaded, 0);
  assert.equal(host.list().find((p) => p.id === 'broken').loaded, false);
});

test('a pack whose size cannot even be measured is pack-unreadable', () => {
  const host = createProjectHost({
    registry: [{ id: 'gone', dotCascadePath: '/nowhere/.cascade', stack: [], lastCertifiedAt: null }],
    loadProject: () => { throw new Error('never reached'); },
    measureBytes: () => { throw new Error('ENOENT: no such file'); },
  });
  assert.throws(() => host.ctxFor('gone'), (e) => {
    assert.equal(e.code, 'pack-unreadable');
    assert.match(e.message, /pack of gone cannot be measured: ENOENT/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('resolveProjectArg: one project answers without being named, and `project` is stripped', () => {
  const { host } = makeHost([['solo', 10]]);
  const out = host.resolveProjectArg({ column: 'pms_product.price', limit: 5 });
  assert.deepEqual(out, { projectId: 'solo', args: { column: 'pms_product.price', limit: 5 } });
  const named = host.resolveProjectArg({ project: 'solo', column: 'x' });
  assert.deepEqual(named, { projectId: 'solo', args: { column: 'x' } });
  assert.equal('project' in named.args, false, 'the tool must never see the routing argument');
});

test('resolveProjectArg: several projects and no `project` -> ambiguous, naming every id', () => {
  const { host } = makeHost([['alpha', 1], ['beta', 1], ['gamma', 1]]);
  assert.throws(() => host.resolveProjectArg({}), (e) => {
    assert.equal(e.code, 'ambiguous');
    assert.equal(e.message, 'several projects are registered: alpha, beta, gamma. Pass "project"');
    return true;
  });
});

test('resolveProjectArg: an unknown id -> unknown-key listing the served ids', () => {
  const { host } = makeHost([['alpha', 1], ['beta', 1]]);
  assert.throws(() => host.resolveProjectArg({ project: 'nope' }), (e) => {
    assert.equal(e.code, 'unknown-key');
    assert.equal(e.message, 'unknown project "nope": served ids are alpha, beta');
    return true;
  });
  assert.throws(() => host.ctxFor('nope'), (e) => e.code === 'unknown-key');
});

test('resolveProjectArg: a non-string project is bad-input, and an empty server is unknown-key', () => {
  const { host } = makeHost([['alpha', 1]]);
  assert.throws(() => host.resolveProjectArg({ project: 7 }), (e) => e.code === 'bad-input');
  const empty = createProjectHost({ registry: [], loadProject: () => ({}) });
  assert.throws(() => empty.resolveProjectArg({}), (e) => {
    assert.equal(e.code, 'unknown-key');
    assert.match(e.message, /serves no project/);
    return true;
  });
});

test('createProjectHost: the same id twice is refused up front', () => {
  assert.throws(() => createProjectHost({ registry: entries(['a', 1], ['a', 2]), loadProject: () => ({}) }), (e) => {
    assert.equal(e.code, 'bad-input');
    assert.match(e.message, /served twice: a/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// The `projects` tool, through the host's own dispatcher
// ---------------------------------------------------------------------------

test('callTool("projects"): a contract-valid, server-level answer that loads nothing', () => {
  const { host, loaded } = makeHost([['alpha', 10], ['beta', 20]], { budgetBytes: 1000 });
  const resp = host.callTool('projects', {});
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(loaded, [], '`projects` must not load a pack');
  assert.equal(resp.basis.project, '*');
  assert.equal(resp.basis.scope, 'server');
  assert.equal(resp.basis.buildDigest, null);
  assert.equal(resp.basis.freshness.verdict, 'unknown');
  assert.deepEqual(resp.trust.axes, ['server']);
  assert.ok(resp.trust.knownGaps.includes('server-level-answer'));
  assert.equal(typeof resp.trust.trustLevel, 'string');
  assert.deepEqual(resp.answer.projects.map((p) => p.id), ['alpha', 'beta']);
  assert.deepEqual(resp.answer.cache, { loaded: 0, bytes: 0, budgetBytes: 1000, evictions: 0, hits: 0, misses: 0 });
  assert.deepEqual(resp.truncated, { any: false, fields: [{ field: 'projects', shown: 2, total: 2, order: 'id asc', nextOffset: null }] });
});

test('callTool("projects"): the cache block tracks loads, hits and evictions', () => {
  const { host } = makeHost([['a', 60], ['b', 60]], { budgetBytes: 100 });
  host.ctxFor('a');
  host.ctxFor('a');
  host.ctxFor('b');
  const resp = host.callTool('projects', {});
  assert.deepEqual(resp.answer.cache, { loaded: 1, bytes: 60, budgetBytes: 100, evictions: 1, hits: 1, misses: 2 });
  assert.deepEqual(resp.answer.projects.map((p) => [p.id, p.loaded, p.bytes]), [['a', false, null], ['b', true, 60]]);
});

test('callTool("projects"): a `project` argument is dropped, not honoured — it is a server answer', () => {
  const { host } = makeHost([['alpha', 1], ['beta', 1]]);
  const resp = host.callTool('projects', { project: 'beta' });
  assert.equal(resp.answer.projects.length, 2, 'the listing is the whole server, whatever project was named');
});

test('callTool: an unknown tool is unknown-tool, not a routing error', () => {
  const { host } = makeHost([['alpha', 1], ['beta', 1]]);
  assert.throws(() => host.callTool('no_such_tool', {}), (e) => {
    assert.equal(e.code, 'unknown-tool');
    return true;
  });
});

test('a registry with no projects lists nothing, and says WHY the list is empty', () => {
  const host = createProjectHost({ registry: { schema: 'cascade:registry:1', projects: [] }, loadProject: () => ({}) });
  const resp = host.callTool('projects', {});
  assert.doesNotThrow(() => assertContract(resp));
  assert.deepEqual(resp.answer.projects, []);
  assert.deepEqual(resp.answer.empty, { projects: 'none' });
});

test('the `projects` tool refuses to invent a registry when the server has none', () => {
  // A single-pack server dispatches through the catalog with no `projects` on
  // its ctx: the tool says so instead of answering with an empty list.
  const ctx = { basis: { project: 'p', buildDigest: 'd', freshness: { verdict: 'unknown' } } };
  assert.throws(() => catalogCallTool('projects', {}, ctx), (e) => {
    assert.equal(e.code, 'bad-input');
    assert.match(e.message, /keeps no project registry/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// packProxyBytes — the documented proxy, on real files
// ---------------------------------------------------------------------------

test('packProxyBytes: pack.json size + facts-index.json text length, and the pack dir rule', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-proxy-'));
  try {
    const dot = path.join(dir, '.cascade');
    const packDir = path.join(dot, 'pack');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), '0123456789', 'utf8'); // 10 bytes
    assert.equal(packDirOf({ id: 'x', dotCascadePath: dot }), packDir);
    assert.equal(packProxyBytes({ id: 'x', dotCascadePath: dot }), 10, 'no fact index: the pack file alone');
    fs.writeFileSync(path.join(packDir, 'facts-index.json'), '{"a":1}', 'utf8'); // 7 chars
    assert.equal(packProxyBytes({ id: 'x', dotCascadePath: dot }), 17);
    // An explicit packDir (a `--pack <dir>` server) wins over dotCascadePath.
    assert.equal(packDirOf({ id: 'x', packDir, dotCascadePath: '/elsewhere' }), packDir);
    assert.throws(() => packDirOf({ id: 'x' }), (e) => e.code === 'pack-unreadable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The scratch sweeper (the `.analyze-*` leak)
// ---------------------------------------------------------------------------

test('makeScratch: the exit handler removes a directory the normal path never got to', () => {
  const removed = [];
  let handler = null;
  let n = 0;
  const scratch = makeScratch({
    mkdtemp: (prefix) => `${prefix}${n++}`,
    rm: (dir) => removed.push(dir),
    onExit: (h) => { handler = h; },
  });
  const kept = scratch.create('/tmp/.analyze-');
  assert.equal(kept, '/tmp/.analyze-0');
  assert.ok(handler, 'the handler is armed on the first create');
  assert.deepEqual(scratch.pending(), ['/tmp/.analyze-0']);
  // The run exits from inside its own try (the calibration RED path): no
  // `finally` runs, and the handler is all that is left.
  handler();
  assert.deepEqual(removed, ['/tmp/.analyze-0']);
  assert.deepEqual(scratch.pending(), []);
  handler(); // idempotent: a second exit sweep removes nothing twice
  assert.deepEqual(removed, ['/tmp/.analyze-0']);
});

test('makeScratch: an eager remove leaves the handler nothing to do, and one failure does not stop the sweep', () => {
  const removed = [];
  const warned = [];
  let handler = null;
  let n = 0;
  const scratch = makeScratch({
    mkdtemp: (prefix) => `${prefix}${n++}`,
    rm: (dir) => { if (dir.endsWith('1')) throw new Error('directory is busy'); removed.push(dir); },
    onExit: (h) => { handler = h; },
    warn: (line) => warned.push(line),
  });
  const a = scratch.create('/tmp/.analyze-'); // 0
  scratch.create('/tmp/.analyze-');           // 1 — removal fails
  scratch.create('/tmp/.analyze-');           // 2
  scratch.remove(a);
  assert.deepEqual(removed, ['/tmp/.analyze-0']);
  assert.deepEqual(scratch.pending(), ['/tmp/.analyze-1', '/tmp/.analyze-2']);
  handler();
  assert.deepEqual(removed, ['/tmp/.analyze-0', '/tmp/.analyze-2'], 'the busy one did not stop the next');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not remove the scratch directory \/tmp\/\.analyze-1: directory is busy/);
});

test('makeScratch: it insists on its io', () => {
  assert.throws(() => makeScratch(), TypeError);
  assert.throws(() => makeScratch({ mkdtemp: () => 'd', rm: () => {} }), TypeError);
});
