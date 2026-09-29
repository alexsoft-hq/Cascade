// ts_reach.test.mjs — which TypeScript files a run reads: the application's, and those its imports reach elsewhere in the analyzed root.
//
// src/core/incremental.mjs decides it, round by round, from the facts of the
// files it has read, with the bridge's own resolution handed in as
// `run.tsResolver`. Driven here with fake workers, in the style of
// test/incremental_core.test.mjs: what is under test is the bookkeeping (which
// files are read, which shards are reused, what the index records), and that a
// shard never holds more than one file's own records. `tsReachResolver`, the
// real resolver, is tested on a real directory, and the node a function both
// lanes make, at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLanesWithShards } from '../src/core/incremental.mjs';
import { createFactsStore } from '../src/core/facts_store.mjs';
import { Graph } from '../src/core/graph.mjs';
import { MODE_COLD, MODE_INCREMENTAL } from '../src/core/invalidate.mjs';
import { addTsFacts, symbolsSharedWithOtherLanes } from '../src/adapters/ts_bridge.mjs';
import { factsOfFile } from '../adapters/ts/tsfacts.mjs';
import { tsLaneRunners, tsReachResolver } from '../src/cli/ts_inputs.mjs';
import { builtinRegistry } from '../src/core/rules/registry.mjs';

const WORKERS = { java: 'javafacts/2', mybatis: 'mybatis-extract/1', lineage: 'lineage/1', catalog: 'catalog-ddl/1', web: 'webfacts/2' };

function memIo() {
  const files = new Map();
  return {
    readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile: (p, s) => files.set(p, s), exists: (p) => files.has(p), mkdir: () => {},
  };
}

// The tree: each file with the specifiers it imports. The application is
// apps/api/src; libs/x is a shared library a tsconfig path names.
const TREE = () => ({
  'apps/api/src/a.ts': ['./b', '@lib/x', 'lodash'],
  'apps/api/src/b.ts': [],
  'libs/x/src/index.ts': ['./y'],
  'libs/x/src/y.ts': ['../../../apps/api/src/b'],
  'libs/x/src/unused.ts': [],
});
const RESOLVE = {
  'apps/api/src/a.ts|./b': 'apps/api/src/b.ts',
  'apps/api/src/a.ts|@lib/x': 'libs/x/src/index.ts',
  'libs/x/src/index.ts|./y': 'libs/x/src/y.ts',
  'libs/x/src/y.ts|../../../apps/api/src/b': 'apps/api/src/b.ts',
};

function harness() {
  const tree = TREE();
  const store = createFactsStore({ io: memIo(), projectId: 'mono', env: { XDG_CACHE_HOME: '/cache' } });
  const calls = { ts: [], resolverListed: [] };
  const recordsOf = (rel) => [
    { kind: 'file', file: rel },
    ...tree[rel].map((source, i) => ({ kind: i === 0 && rel.endsWith('index.ts') ? 'export' : 'import', file: rel, source, all: true, names: [], line: i + 1 })),
  ];
  const run = {
    tsList: () => Object.keys(tree).filter((f) => f.startsWith('apps/api/src/')).sort(),
    ts: (targets) => {
      calls.ts.push(targets.map((t) => t.replace('/root/', '')));
      return targets.flatMap((t) => recordsOf(t.replace('/root/', '')));
    },
    tsResolver: (listed) => {
      calls.resolverListed.push(listed);
      return (from, spec) => RESOLVE[`${from}|${spec}`] ?? null;
    },
  };
  const hash = (abs) => {
    const rel = abs.replace('/root/', '');
    return `${'0'.repeat(48)}${Buffer.from(JSON.stringify(tree[rel])).toString('hex').padStart(16, '0').slice(-16)}`;
  };
  const call = (plan, index) => runLanesWithShards({
    plan, index, store, run, hash, abs: (rel) => `/root/${rel}`, workers: WORKERS, project: 'mono',
    selection: { root: '/root', tsRoots: ['apps/api/src'], tsRootsAbs: ['/root/apps/api/src'] },
    inputs: { mapperFiles: [], ddlFiles: [], mybatisArgs: [], lineageArgs: [], catalogArgs: [] },
    base: { commit: 'c1', dirty: false, dirtyFiles: [] },
  });
  return { tree, calls, call };
}

const COLD = { mode: MODE_COLD, reason: 'test cold', notes: [], reparseJava: [], dropJava: [], reparseWeb: [], dropWeb: [] };
const INC = { mode: MODE_INCREMENTAL, reason: null, notes: [], reparseJava: [], dropJava: [], reparseWeb: [], dropWeb: [] };
const filesIn = (records) => [...new Set(records.map((r) => r.file))].sort();

test('a cold run reads the application, then each round of files its imports reach, and nothing they do not', () => {
  const h = harness();
  const r = h.call(COLD, null);
  assert.deepEqual(h.calls.ts, [
    ['apps/api/src/a.ts', 'apps/api/src/b.ts'],
    ['libs/x/src/index.ts'],
    ['libs/x/src/y.ts'],
  ], 'one worker run per round; b.ts, which y.ts imports back, is not read twice; a package is not followed');
  assert.deepEqual(h.calls.resolverListed, [['apps/api/src/a.ts', 'apps/api/src/b.ts']], 'the resolver knows the application\'s own files from the list');
  assert.deepEqual(filesIn(r.tsFacts), ['apps/api/src/a.ts', 'apps/api/src/b.ts', 'libs/x/src/index.ts', 'libs/x/src/y.ts'], 'unused.ts is imported by nothing, so it is not read');
  assert.equal(r.stats.reachedTs, 2);
  assert.equal(r.stats.reparsedTs, 4);
  assert.deepEqual(Object.keys(r.index.tsFiles).sort(), filesIn(r.tsFacts));
  assert.deepEqual(r.index.files, {}, 'the TypeScript lane\'s entries have a map of their own, so a file the web lane reads too keeps its web entry');
});

test('a second run reuses every shard, the reached files\' too, and runs no worker', () => {
  const h = harness();
  const first = h.call(COLD, null);
  const again = h.call(INC, first.index);
  assert.equal(h.calls.ts.length, 3, 'no worker run the second time');
  assert.equal(again.stats.reusedTs, 4);
  assert.equal(again.stats.reparsedTs, 0);
  assert.deepEqual(again.tsFacts, first.tsFacts, 'the same stream, byte for byte, as the cold run');
});

test('an edited reached file is the only one read again, and an import it gains is followed from its new facts', () => {
  const h = harness();
  const first = h.call(COLD, null);
  h.tree['libs/x/src/y.ts'] = ['./unused'];
  RESOLVE['libs/x/src/y.ts|./unused'] = 'libs/x/src/unused.ts';
  try {
    const r = h.call(INC, first.index);
    assert.deepEqual(h.calls.ts.slice(3), [['libs/x/src/y.ts'], ['libs/x/src/unused.ts']]);
    assert.equal(r.stats.reusedTs, 3);
    assert.equal(r.stats.reachedTs, 3);
  } finally {
    delete RESOLVE['libs/x/src/y.ts|./unused'];
  }
});

test('a file no import reaches any more is not read, and its entry leaves the index', () => {
  const h = harness();
  const first = h.call(COLD, null);
  h.tree['apps/api/src/a.ts'] = ['./b'];
  const r = h.call(INC, first.index);
  assert.deepEqual(h.calls.ts.slice(3), [['apps/api/src/a.ts']]);
  assert.deepEqual(Object.keys(r.index.tsFiles).sort(), ['apps/api/src/a.ts', 'apps/api/src/b.ts']);
  assert.equal(r.stats.reachedTs, undefined, 'nothing outside the application was read');
});

// ---------------------------------------------------------------------------
// the real resolver
// ---------------------------------------------------------------------------

test('tsReachResolver follows a tsconfig path to a shared library, never into node_modules or out of the analyzed root, and into a test file only when it is imported', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reach-'));
  const sibling = `../${path.basename(root)}-sibling`;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(root, sibling), { recursive: true, force: true });
  });
  const put = (rel, text = '') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['libs/common/src/*'], '@vendor/*': ['node_modules/vendor/*'], '@out/*': [`${sibling}/*`] } } }));
  put('apps/api/src/main.ts');
  put('apps/api/src/test/helper.ts');
  put('libs/common/src/helper.ts');
  put('libs/common/src/types/index.ts');
  put('libs/common/src/fixture.spec.ts');
  put('node_modules/vendor/x.ts');
  put(`${sibling}/y.ts`);
  assert.ok(fs.existsSync(path.join(root, sibling, 'y.ts')), 'the file outside is there to be refused');
  const resolve = tsReachResolver({ rootAbs: root, appRootAbs: path.join(root, 'apps/api/src'), listed: ['apps/api/src/main.ts'] });
  const from = 'apps/api/src/main.ts';
  assert.equal(resolve(from, '@lib/helper'), 'libs/common/src/helper.ts');
  assert.equal(resolve(from, '@lib/types'), 'libs/common/src/types/index.ts');
  // A test file a file of the application imports runs with it; one a barrel only re-exports does not.
  assert.equal(resolve(from, '@lib/fixture.spec', 'export'), null, 'a test file a barrel re-exports is not read');
  assert.equal(resolve(from, '@lib/fixture.spec'), 'libs/common/src/fixture.spec.ts', 'a test file the application imports is its own');
  assert.equal(resolve(from, '@vendor/x'), null, 'node_modules is a package\'s, whatever a path names it');
  assert.equal(resolve(from, '@out/y'), null, 'nothing outside the analyzed root');
  assert.equal(resolve(from, './test/helper', 'export'), null, 'under the application\'s root only a listed file is known, or test support it imports');
  assert.equal(resolve(from, './test/helper'), 'apps/api/src/test/helper.ts');
  assert.equal(resolve(from, 'lodash'), null);
});

test('ts_reach_does_not_follow_symlink_out_of_root: a link inside the root to a directory outside it leads nowhere this lane reads', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reach-link-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const put = (abs, text = '') => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  put(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@link/*': ['libs/linked/*'], '@in/*': ['libs/inside/*'] } } }));
  put(path.join(root, 'apps/api/src/main.ts'));
  put(path.join(base, 'outside/lib/x.ts'));
  put(path.join(root, 'libs/real/y.ts'));
  fs.symlinkSync(path.join(base, 'outside/lib'), path.join(root, 'libs/linked'));
  fs.symlinkSync(path.join(root, 'libs/real'), path.join(root, 'libs/inside'));
  const resolve = tsReachResolver({ rootAbs: root, appRootAbs: path.join(root, 'apps/api/src'), listed: ['apps/api/src/main.ts'] });
  assert.equal(resolve('apps/api/src/main.ts', '@link/x'), null, 'the file the link reaches is outside the analyzed root');
  assert.equal(resolve('apps/api/src/main.ts', '@in/y'), 'libs/inside/y.ts', 'a link that stays inside the root is followed');
});

test('test support a shared library holds is not read unless the application imports it: which paths are test support is the typescript pack\'s', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-reach-mocks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text = '') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['libs/common/src/*'] } } }));
  put('apps/api/src/main.ts', 'export function main() {}');
  put('apps/api/src/users.service.mock.ts', 'export class UsersServiceMock {}');
  put('apps/api/src/__mocks__/repo.ts', 'export class RepoMock {}');
  put('libs/common/src/repo.ts');
  put('libs/common/src/repo.mock.ts');
  put('libs/common/src/__mocks__/repo.ts');
  put('libs/common/src/testing/helpers.ts');
  const app = path.join(root, 'apps/api/src');
  const leftOut = new Map();
  const resolve = tsReachResolver({ rootAbs: root, appRootAbs: app, listed: ['apps/api/src/main.ts'], leftOut });
  const from = 'apps/api/src/main.ts';
  assert.equal(resolve(from, '@lib/repo'), 'libs/common/src/repo.ts');
  // A barrel's re-export of its mocks does not make them the application's: they are left out, and said.
  assert.equal(resolve(from, '@lib/repo.mock', 'export'), null);
  assert.equal(resolve(from, '@lib/__mocks__/repo', 'export'), null);
  assert.equal(resolve(from, '@lib/testing/helpers', 'export'), null);
  assert.deepEqual([...leftOut], [['libs/common/src/repo.mock.ts', 'test-support'], ['libs/common/src/__mocks__/repo.ts', 'test-support'], ['libs/common/src/testing/helpers.ts', 'test-support']]);
  // An import is the application running it.
  assert.equal(resolve(from, '@lib/testing/helpers'), 'libs/common/src/testing/helpers.ts');
  const runners = tsLaneRunners(root, app);
  assert.deepEqual(runners.tsList([app]), ['apps/api/src/main.ts'], 'the application\'s own test support is left out of the list as well');
  assert.deepEqual(runners.tsLeftOut(), [{ file: 'apps/api/src/__mocks__/repo.ts', why: 'test-support' }, { file: 'apps/api/src/users.service.mock.ts', why: 'test-support' }], 'and named');
  const rule = builtinRegistry().ofKind('ts.test-support')[0];
  assert.equal(rule.id, 'typescript.test-support');
  assert.equal(rule.compiled.isTestSupport('libs/common/src/testing/helpers.ts'), true);
  assert.equal(rule.compiled.isTestSupport('libs/common/src/contesting/helpers.ts'), false, 'a whole directory name, not a part of one');
});

// ---------------------------------------------------------------------------
// one file, two lanes
// ---------------------------------------------------------------------------

test('a function both lanes make is one node naming both lanes, and the run says so once the graph is whole', () => {
  const g = new Graph();
  addTsFacts(g, [
    ...factsOfFile('apps/api/src/svc.ts', "import { fetchUser } from '../../../libs/api/src/users';\nexport function load() { return fetchUser(); }"),
    ...factsOfFile('libs/api/src/users.ts', "export function fetchUser() { return fetch('/api/users'); }"),
  ], { appRoot: 'apps/api/src' });
  assert.deepEqual(symbolsSharedWithOtherLanes(g), [], 'nothing shared before the web lane runs');
  // What the web bridge adds, after this lane, for a function that sends a request.
  g.addNode({ id: 'symbol:libs/api/src/users.ts#fetchUser', symbol: 'libs/api/src/users.ts#fetchUser', file: 'libs/api/src/users.ts', line: 1, lane: 'web', exported: true });
  const node = g.nodes.get('symbol:libs/api/src/users.ts#fetchUser');
  assert.deepEqual(node.lanes, ['ts', 'web']);
  assert.equal(g.nodes.size, 2, 'two functions, two nodes: the shared one is not made twice');
  const edge = g.edges.find((e) => e.type === 'MAY_CALL');
  assert.equal(edge.to, node.id, 'the backend\'s call lands on the one node');
  const [d] = symbolsSharedWithOtherLanes(g);
  assert.equal(d.kind, 'TS_SYMBOL_SHARED_WITH_WEB');
  assert.match(d.reason, /^1 function\(s\) of a file the web lane reads as well are one node each, made by both lanes: libs\/api\/src\/users\.ts#fetchUser\. /);
});
