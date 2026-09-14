// pack_diff.test.mjs — what changed between two packs, and whether the two can be compared at all.
//
// One small project in two states. The head adds a route and the statement it
// runs, drops a column, and downgrades one call from EXACT to SOUND_SET. The
// tests check the reading a reviewer relies on: every addition, removal and
// regrade is listed, the endpoints above them are named, a difference in how the
// two packs were ANALYZED is said before any count, and a condition one pack does
// not record is unknown rather than equal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph, nodeId } from '../src/core/graph.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { PACK_DIFF_SCHEMA, compareConditions, diffPacks } from '../src/core/pack_diff.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { createProjectHost, fileStamp, packFingerprint } from '../src/mcp/projects.mjs';
import { writeAtomic } from '../src/cli/pack_history.mjs';
import { assertContract } from '../src/mcp/contract.mjs';
import { startViewer } from './helpers/viewer_fixtures.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKERS = { java: 'javafacts/12', lineage: 'lineage/3', catalog: 'catalog-ddl/4', mybatis: 'mybatis-extract/2', web: 'webfacts/13' };
const ANALYSIS = { workers: WORKERS, profileDigest: 'p'.repeat(64), enginePrint: 'e'.repeat(64), engineVersion: '0.8.8', optOuts: [], selection: { javaRoots: ['src'] },
  invocation: { ddl: [], mappers: [], javaSrc: [], webSrc: [], openapi: [], har: [], otel: [], noDdl: false, noMappers: false, noJava: false, noWeb: false, noOpenapi: false, profile: null },
  external: { catalogSnapshot: null, evidence: [], sources: {} } };
const AXES = { catalog: { status: 'shipped' }, statements: { status: 'shipped' }, code: { status: 'shipped' } };

/** One state of the project: a route, its handler, a service, a mapper statement, a table. */
function state({ head }) {
  const g = new Graph();
  const node = (kind, key, extra = {}) => g.addNode({ id: nodeId(kind, key), ...extra });
  const edge = (from, to, type, grade, evidence) => g.addEdge({ from, to, type, grade, ...(evidence ? { evidence } : {}) });
  node('endpoint', 'GET /orders', { path: '/orders', httpMethod: 'GET' });
  node('symbol', 'x.OrderController#list', { owner: 'x.OrderController' });
  node('symbol', 'x.OrderService#list', { owner: 'x.OrderService' });
  node('statement', 'x.OrderMapper.list', { statementType: 'select' });
  node('table', 'orders');
  node('column', 'orders.id');
  if (!head) node('column', 'orders.legacy_code');
  edge('endpoint:GET /orders', 'symbol:x.OrderController#list', 'HANDLES', 'EXACT');
  edge('symbol:x.OrderController#list', 'symbol:x.OrderService#list', 'CALLS', head ? 'SOUND_SET' : 'EXACT', { rule: 'field-receiver' });
  edge('symbol:x.OrderService#list', 'statement:x.OrderMapper.list', 'MAY_CALL', 'SOUND_SET');
  edge('statement:x.OrderMapper.list', 'table:orders', 'EXECUTES', 'EXACT', { access: 'read' });
  edge('table:orders', 'column:orders.id', 'DECLARES', 'EXACT');
  if (!head) edge('table:orders', 'column:orders.legacy_code', 'DECLARES', 'EXACT');
  if (head) {
    node('endpoint', 'POST /orders', { path: '/orders', httpMethod: 'POST' });
    node('symbol', 'x.OrderController#save', { owner: 'x.OrderController' });
    node('statement', 'x.OrderMapper.insert', { statementType: 'insert' });
    edge('endpoint:POST /orders', 'symbol:x.OrderController#save', 'HANDLES', 'EXACT');
    edge('symbol:x.OrderController#save', 'statement:x.OrderMapper.insert', 'MAY_CALL', 'SOUND_SET');
    edge('statement:x.OrderMapper.insert', 'table:orders', 'EXECUTES', 'EXACT', { access: 'write' });
  }
  return g;
}

const packOf = (g, meta = {}) => JSON.parse(JSON.stringify(projectPack(g, {
  project: 'orders', builtAt: '2026-09-14T00:00:00.000Z', lanes: ['sql', 'java'], identifierCase: 'fold-lower',
  axes: AXES, analysis: ANALYSIS, base: { commit: 'a'.repeat(40), dirty: false, rootCommit: 'r'.repeat(40) }, ...meta,
})));

test('every node and edge that appeared, went away or changed grade is listed, and the endpoints above them', () => {
  const d = diffPacks(packOf(state({ head: false })), packOf(state({ head: true }), { base: { commit: 'b'.repeat(40), dirty: false, rootCommit: 'r'.repeat(40) } }));
  assert.equal(d.schema, PACK_DIFF_SCHEMA);
  assert.equal(d.samePack, false);
  assert.equal(d.conditions.verdict, 'same');
  assert.deepEqual([d.base.commit.slice(0, 1), d.head.commit.slice(0, 1)], ['a', 'b']);
  // The ends of a round trip list first.
  assert.deepEqual(d.nodes.addedIds, ['endpoint:POST /orders', 'statement:x.OrderMapper.insert', 'symbol:x.OrderController#save']);
  assert.deepEqual(d.nodes.removedIds, [{ id: 'column:orders.legacy_code' }]);
  assert.deepEqual(d.nodes.byKind, { endpoint: { added: 1, removed: 0 }, statement: { added: 1, removed: 0 }, symbol: { added: 1, removed: 0 }, column: { added: 0, removed: 1 } });
  assert.deepEqual(d.edges.regradedList, [{ from: 'symbol:x.OrderController#list', to: 'symbol:x.OrderService#list', type: 'CALLS', rule: 'field-receiver', base: 'EXACT', head: 'SOUND_SET' }]);
  assert.equal(d.edges.added, 3);
  assert.deepEqual(d.edges.removedList, [{ from: 'table:orders', to: 'column:orders.legacy_code', type: 'DECLARES', rule: null, grade: 'EXACT' }]);
  // Above the new route is the new route; above the regraded call is the old one.
  assert.deepEqual(d.endpointsTouched, { total: 2, ids: ['endpoint:GET /orders', 'endpoint:POST /orders'] });
  assert.deepEqual(d.screensTouched, { total: 0, ids: [] }, 'this project has no screens above anything');
  assert.equal(d.truncated.any, false);
});

test('two packs of the same code and the same analysis differ in nothing', () => {
  const d = diffPacks(packOf(state({ head: true })), packOf(state({ head: true })));
  assert.equal(d.samePack, true);
  assert.deepEqual([d.nodes.added, d.nodes.removed, d.edges.added, d.edges.removed, d.edges.regraded, d.endpointsTouched.total], [0, 0, 0, 0, 0, 0]);
});

test('two packs that both record their analysis but not their flags are not taken to agree on them', () => {
  const { invocation: _i, external: _e, ...old } = ANALYSIS;
  const c = compareConditions(packOf(state({ head: true }), { analysis: old }), packOf(state({ head: true }), { analysis: old }));
  assert.equal(c.verdict, 'unknown');
  assert.deepEqual(c.unknown, ['catalogSnapshot', 'evidence', 'externalSources', 'flags']);
});

test('where the profile file sat is not a difference in how the packs were read, and its content is', () => {
  const at = (profile, profileDigest = ANALYSIS.profileDigest) => packOf(state({ head: true }), { analysis: { ...ANALYSIS, profileDigest, invocation: { ...ANALYSIS.invocation, profile } } });
  assert.equal(compareConditions(at(null), at('conventions/strict.json')).verdict, 'same');
  assert.deepEqual(compareConditions(at(null), at(null, 'q'.repeat(64))).differences.map((d) => d.what), ['profileDigest']);
});

test('a difference in how the packs were analyzed is said first, and a removal on a changed axis is marked', () => {
  const base = packOf(state({ head: false }));
  const head = packOf(state({ head: true }), {
    axes: { ...AXES, catalog: { status: 'not-shipped' } },
    analysis: { ...ANALYSIS, workers: { ...WORKERS, java: 'javafacts/13' } },
  });
  const d = diffPacks(base, head);
  assert.equal(d.conditions.verdict, 'different');
  assert.deepEqual(d.conditions.differences, [
    { what: 'axis.catalog', base: 'shipped', head: 'not-shipped' },
    { what: 'worker.java', base: 'javafacts/12', head: 'javafacts/13' },
  ]);
  assert.deepEqual(d.nodes.removedIds, [{ id: 'column:orders.legacy_code', axisChanged: 'catalog' }]);
});

test('what changes without a commit is a condition: a database snapshot, a recording, the lane flags', () => {
  const withExternal = (external, invocation = { ddl: [], mappers: ['src/main/resources/mapper'] }) => packOf(state({ head: true }), { analysis: { ...ANALYSIS, invocation, external } });
  const base = withExternal({ catalogSnapshot: 'a'.repeat(64), evidence: [] });
  assert.deepEqual(compareConditions(base, withExternal({ catalogSnapshot: 'b'.repeat(64), evidence: [] })).differences.map((d) => d.what), ['catalogSnapshot']);
  assert.deepEqual(compareConditions(base, withExternal({ catalogSnapshot: 'a'.repeat(64), evidence: ['har:1'] })).differences.map((d) => d.what), ['evidence']);
  assert.deepEqual(compareConditions(base, withExternal({ catalogSnapshot: 'a'.repeat(64), evidence: [] }, { ddl: [], mappers: [] })).differences.map((d) => d.what), ['flags'],
    'the same roots named on the command line or found by discovery are not read the same way');
});

test('a condition one pack does not record is unknown, never equal', () => {
  const old = packOf(state({ head: false }));
  delete old.meta.analysis;
  const c = compareConditions(old, packOf(state({ head: true })));
  assert.equal(c.verdict, 'unknown');
  assert.deepEqual(c.differences, []);
  assert.ok(c.unknown.includes('worker.java'));
  assert.ok(c.unknown.some((u) => /base pack was built before packs recorded/.test(u)));
});

test('a list longer than the limit is cut, and the cut says how much there is', () => {
  const d = diffPacks(packOf(state({ head: false })), packOf(state({ head: true })), { limit: 1 });
  assert.deepEqual(d.nodes.addedIds, ['endpoint:POST /orders']);
  assert.equal(d.nodes.added, 3);
  assert.equal(d.truncated.any, true);
  assert.deepEqual(d.truncated.fields.find((f) => f.field === 'nodes.added'), { field: 'nodes.added', shown: 1, total: 3, order: 'kind, id asc', nextOffset: 1 });
});

test('cascade diff prints the conditions before the counts, and --json the whole difference', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-diff-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const write = (name, pack) => {
    fs.mkdirSync(path.join(work, name), { recursive: true });
    fs.writeFileSync(path.join(work, name, 'pack.json'), JSON.stringify(pack));
    return path.join(work, name);
  };
  const base = write('base', packOf(state({ head: false })));
  const head = write('head', packOf(state({ head: true }), { analysis: { ...ANALYSIS, profileDigest: 'q'.repeat(64) } }));
  const cli = (...args) => spawnSync(process.execPath, [path.join(ENGINE_ROOT, 'bin', 'cascade.mjs'), 'diff', ...args], { encoding: 'utf8', env: { ...process.env, CASCADE_HOME: work } });
  const text = cli('--base', base, '--head', head);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^conditions: different$/) >= 0, text.stdout);
  assert.ok(at(/^ {2}profileDigest: p+ -> q+$/) > at(/^conditions:/));
  assert.ok(at(/may come from the analysis rather than the code/) < at(/^nodes: \+3 -1 {2}\(endpoint \+1, column -1, statement \+1, symbol \+1\)$/), 'the conditions come before the counts');
  assert.match(text.stdout, /^edges: \+3 -1 regraded 1 {2}\(CALLS ~1, DECLARES -1, EXECUTES \+1, HANDLES \+1, MAY_CALL \+1\)$/m);
  assert.match(text.stdout, /^endpoints above the change: 2$/m);
  assert.match(text.stdout, /^ {2}symbol:x\.OrderController#list -> symbol:x\.OrderService#list {2}CALLS \[field-receiver\] {2}EXACT -> SOUND_SET$/m);
  const json = cli('--base', path.join(base, 'pack.json'), '--head', head, '--json', '--limit', '1');
  assert.equal(json.status, 0, json.stderr);
  const d = JSON.parse(json.stdout);
  assert.equal(d.nodes.addedIds.length, 1);
  assert.equal(cli('--head', head).status !== 0, true, 'no --base is refused');
  assert.match(cli('--base', path.join(work, 'nowhere'), '--head', head).stderr, /no pack at/);
});

test('pack_diff refuses two different projects, and compares a project with an earlier build of its own', async (t) => {
  const { host } = await startViewer(t, ['alpha', 'beta']);
  assert.throws(() => host.callTool('pack_diff', { project: 'beta', base: 'alpha' }),
    (e) => e.code === 'bad-input' && /different repositories \(project id: "alpha" and "beta"\)/.test(e.message));
  assert.throws(() => host.callTool('pack_diff', { project: 'beta', base: 'beta' }), (e) => e.code === 'bad-input');
  const basis = { project: 'orders', buildDigest: 'x', builtAt: null, freshness: { verdict: 'unknown' } };
  const head = state({ head: true });
  const earlier = packOf(state({ head: false }));
  const history = { list: () => [], load: (q) => (q.commit && 'a'.repeat(40).startsWith(q.commit) ? { entry: { id: 'e1' }, pack: earlier } : null) };
  const ctx = { graph: head, basis, trust: {}, limits: [], pack: packOf(head).meta, history };
  const r = callTool('pack_diff', { base_commit: 'aaaaaaa' }, ctx);
  assertContract(r);
  assert.equal(r.basis.siblings, undefined, 'an earlier build of this project is not another project');
  assert.equal(r.answer.repository.verdict, 'same');
  assert.deepEqual(r.answer.nodes.addedIds, ['endpoint:POST /orders', 'statement:x.OrderMapper.insert', 'symbol:x.OrderController#save']);
  assert.throws(() => callTool('pack_diff', { base_commit: 'bbbbbbb' }, ctx), (e) => e.code === 'unknown-key' && /cascade diff --base-commit/.test(e.message));
  assert.throws(() => callTool('pack_diff', {}, ctx), (e) => e.code === 'bad-input' && /exactly one base/.test(e.message));
  assert.throws(() => callTool('pack_diff', { base: 'other' }, { ...ctx, history: undefined }), (e) => e.code === 'bad-input' && /base_commit/.test(e.message));
});

test('a served project whose pack was republished is read again, so its head is never an old build beside the new history', async (t) => {
  const { host } = await startViewer(t, ['alpha']);
  const first = host.ctxFor('alpha');
  const file = path.join(first.packDir, 'pack.json');
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(host.ctxFor('alpha'), first, 'nothing changed: the same context');
  // A build of the SAME size and modification time, renamed into place the way analyze publishes.
  const before = fs.statSync(file);
  const builtAt = pack.meta.builtAt.replace(/\d(?=\D*$)/, (c) => String((Number(c) + 1) % 10));
  const next = JSON.stringify({ ...pack, meta: { ...pack.meta, builtAt } });
  assert.equal(next.length, JSON.stringify(pack).length);
  writeAtomic(file, next);
  fs.utimesSync(file, before.atime, before.mtime);
  const second = host.ctxFor('alpha');
  assert.notEqual(second, first, 'a republished pack is read again');
  assert.equal(second.pack.builtAt, builtAt, 'and what is read is the new build');
  // A copy that restores the size and the modification time exactly is still a new file.
  const stat = (ino, ctimeMs) => ({ statSync: () => ({ ino, size: 10, mtimeMs: 1000, ctimeMs }) });
  const entry = { dotCascadePath: '/nowhere/.cascade' };
  assert.notEqual(packFingerprint(entry, stat(1, 1000)), packFingerprint(entry, stat(2, 1000)), 'another inode');
  assert.notEqual(packFingerprint(entry, stat(1, 1000)), packFingerprint(entry, stat(1, 2000)), 'another change time');
});

test('a served project\'s route sidecar is read again once its pack is republished, from the list as from a tool', () => {
  let build = 1;
  let reads = 0;
  const host = createProjectHost({
    registry: { projects: [{ id: 'alpha', dotCascadePath: '/nowhere/.cascade' }] },
    loadProject: () => ({ graph: new Graph(), pack: {} }),
    fingerprint: () => `build-${build}`,
    readIndex: () => { reads += 1; return { ok: true, index: { serves: Array.from({ length: build }), calls: [] } }; },
    log: () => {},
  });
  assert.equal(host.list()[0].federation.serves, 1);
  assert.equal(host.list()[0].federation.serves, 1);
  assert.equal(reads, 1, 'one build, one read');
  build = 2;
  assert.equal(host.list()[0].federation.serves, 2, 'the list does not answer from the old build\'s sidecar');
  assert.equal(typeof packFingerprint({ dotCascadePath: '/nowhere/.cascade' }), 'object', 'no pack on disk is no fingerprint');
});

test('a context loaded from an earlier build is dropped from the list once anything it reads is republished', () => {
  let build = 1;
  const host = createProjectHost({
    registry: { projects: [{ id: 'alpha', dotCascadePath: '/nowhere/.cascade' }] },
    loadProject: () => ({ graph: new Graph(), pack: { digest: `d${build}` } }),
    measureBytes: () => 1,
    fingerprint: () => `build-${build}`,
    readIndex: () => ({ ok: false, reason: 'absent' }),
    log: () => {},
  });
  host.ctxFor('alpha');
  assert.equal(host.list()[0].loaded, true);
  build = 2;
  assert.deepEqual([host.list()[0].loaded, host.list()[0].meta], [false, null], 'never the old build\'s metadata beside the new build\'s routes');
  // What counts as republished: the gate's verdict written after the pack changes the fingerprint too.
  const at = { ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 };
  const io = (gate) => ({ statSync: (f) => (f.endsWith('gate-state.json') ? gate : at) });
  const entry = { dotCascadePath: '/nowhere/.cascade' };
  assert.notEqual(packFingerprint(entry, io({ ...at, ino: 2 })), packFingerprint(entry, io({ ...at, ino: 3 })));
});

test('a served context is read again when a profile it read outside the pack directory changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'conventions.json');
  fs.writeFileSync(profile, '{"a":1}');
  let loads = 0;
  const host = createProjectHost({
    registry: { projects: [{ id: 'alpha', dotCascadePath: '/nowhere/.cascade' }] },
    loadProject: () => { loads += 1; return { graph: new Graph(), pack: {}, watchFiles: [{ file: profile, stamp: fileStamp(profile) }] }; },
    measureBytes: () => 1, fingerprint: () => 'same-build', readIndex: () => ({ ok: false, reason: 'absent' }), log: () => {},
  });
  host.ctxFor('alpha');
  host.ctxFor('alpha');
  assert.equal(loads, 1);
  fs.rmSync(profile);
  fs.writeFileSync(profile, '{"a":2}');
  host.ctxFor('alpha');
  assert.equal(loads, 2, 'the profile it answered with changed');
});

test('a project list row is read again when a publish lands between its two reads, so it never mixes two builds', () => {
  let build = 1;
  const host = createProjectHost({
    registry: { projects: [{ id: 'alpha', dotCascadePath: '/nowhere/.cascade' }] },
    loadProject: () => ({ graph: new Graph(), pack: { digest: `d${build}` } }),
    measureBytes: () => 1,
    fingerprint: () => `build-${build}`,
    // The publish lands while the sidecar is being read, once.
    readIndex: () => { const r = { ok: true, index: { serves: Array.from({ length: build }), calls: [] } }; if (build === 1) build = 2; return r; },
    log: () => {},
  });
  const row = host.list()[0];
  assert.equal(row.federation.serves, 2, 'the row was read again after the build moved');
});
