import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runLanesWithShards, INCREMENTAL_ENGINE_VERSION, IncrementalError } from '../src/core/incremental.mjs';
import { createFactsStore } from '../src/core/facts_store.mjs';
import { MODE_COLD, MODE_INCREMENTAL } from '../src/core/invalidate.mjs';

// The execution half of the incremental core, driven with FAKE workers: no JDK,
// no Python, no filesystem. What is under test is the bookkeeping — what gets
// recomputed, what gets reused, and what happens when a shard is unusable.

const WORKERS = { java: 'javafacts/2', mybatis: 'mybatis-extract/1', lineage: 'lineage/1', catalog: 'catalog-ddl/1', web: 'webfacts/2' };

/** The package configuration, which no shard ever holds: it is read on every run. */
const CONFIG_RECORDS = (tree) => [
  { kind: 'config', file: 'front/.env.development', line: 1, what: 'env', name: 'BASE', value: tree['front/.env.development'], mode: 'development' },
];

function memIo() {
  const files = new Map();
  return {
    files,
    readFile: (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    writeFile: (p, s) => files.set(p, s),
    exists: (p) => files.has(p),
    mkdir: () => {},
  };
}

// ---- the fake tree ---------------------------------------------------------

const TREE = {
  'src/main/java/com/example/A.java': 'A-v1',
  'src/main/java/com/example/B.java': 'B-v1',
  'src/main/resources/mapper/ItemMapper.xml': 'xml-v1',
  'schema.sql': 'ddl-v1',
  // The frontend: two source files under one web root, plus the package
  // configuration that is never cached.
  'front/src/api/items.js': 'items-v1',
  'front/src/api/orders.js': 'orders-v1',
  'front/.env.development': 'env-v1',
};

/** A worker set that records what it was asked to do. */
function fakeWorkers(tree) {
  const calls = { java: [], web: [], webConfigs: 0, mybatis: 0, lineage: [], catalog: 0 };
  const webFor = (rel) => [
    { kind: 'file', file: rel, line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'call', file: rel, line: 4, marker: tree[rel], url: { resolved: [{ via: 'literal', template: `/${rel}` }] } },
  ];
  const javaFor = (rel) => {
    const fqn = `com.example.${rel.split('/').pop().replace('.java', '')}`;
    return [
      { kind: 'type', fqn, typeKind: 'class', package: 'com.example', annotations: [], implements: [], extends: null, file: rel },
      { kind: 'method', fqn: `${fqn}#run`, owner: fqn, name: 'run', paramCount: 0, line: 3, file: rel, marker: tree[rel] },
    ];
  };
  return {
    calls,
    run: {
      catalog: () => {
        calls.catalog += 1;
        return [
          { kind: 'header', schema: 'cascade:catalog-snapshot:1', tables: 1 },
          { kind: 'table', schema: null, table: 'shop_item', comment: null },
          { kind: 'column', schema: null, table: 'shop_item', column: 'price', type: 'INT', comment: tree['schema.sql'], pk: false },
        ];
      },
      mybatis: () => {
        calls.mybatis += 1;
        return [
          { kind: 'header', schema: 'cascade:mybatis-stmts:1', statements: 2 },
          { kind: 'statement', namespace: 'com.example.mapper.ItemMapper', id: 'one', type: 'select', sql: `select price from shop_item -- ${tree['src/main/resources/mapper/ItemMapper.xml']}`, hasStringSubst: false, schemaUnknown: false, file: 'ItemMapper.xml', line: 4 },
          // TWO statements with byte-identical SQL: one lineage shard serves both,
          // and each must still carry its OWN namespace/id/file/line.
          { kind: 'statement', namespace: 'com.example.mapper.OtherMapper', id: 'two', type: 'select', sql: 'select price from shop_item', hasStringSubst: false, schemaUnknown: false, file: 'OtherMapper.xml', line: 9 },
          { kind: 'statement', namespace: 'com.example.mapper.ItemMapper', id: 'three', type: 'select', sql: 'select price from shop_item', hasStringSubst: false, schemaUnknown: false, file: 'ItemMapper.xml', line: 12 },
        ];
      },
      lineage: (statements, catalogRecords) => {
        calls.lineage.push(statements.map((s) => `${s.namespace}.${s.id}`));
        assert.ok(Array.isArray(catalogRecords), 'the lineage worker is handed the catalog it must analyze against');
        return statements.map((s) => ({
          kind: 'lineage', namespace: s.namespace, id: s.id, type: s.type,
          tables: [{ table: 'shop_item', access: 'read' }],
          columns: [{ table: 'shop_item', column: 'price', access: 'read' }],
          joins: [], unresolved: [],
          hasStringSubst: false, schemaUnknown: false, file: s.file, line: s.line,
        }));
      },
      java: (targets) => {
        calls.java.push([...targets]);
        const files = targets.flatMap((t) => (t.endsWith('.java')
          ? [t.replace('/root/', '')]
          : Object.keys(tree).filter((f) => f.endsWith('.java'))));
        return [{ kind: 'header', schema: 'cascade:javafacts:1', version: WORKERS.java, files: files.length },
          ...files.flatMap(javaFor)];
      },
      web: (targets) => {
        calls.web.push([...targets]);
        const files = targets.flatMap((t) => (t.endsWith('.js')
          ? [t.replace('/root/', '')]
          : Object.keys(tree).filter((f) => f.startsWith('front/src/') && f in tree)));
        // A real run prints the package configuration whatever the targets are;
        // the split drops it, and `webConfigs` is what actually supplies it.
        return [
          { kind: 'header', schema: 'cascade:webfacts:1', version: WORKERS.web, files: files.length },
          ...CONFIG_RECORDS(tree),
          ...files.flatMap(webFor),
          { kind: 'summary', version: WORKERS.web, files: files.length },
        ];
      },
      // The real worker's `--configs-only` mode: the package configuration, and
      // the LIST of files this lane would read. It parses nothing.
      webConfigs: (roots) => {
        calls.webConfigs += 1;
        assert.ok(roots.every((r) => r.startsWith('/root/')), 'the config run is handed the ROOTS, always');
        return [
          { kind: 'header', schema: 'cascade:webfacts:1', version: WORKERS.web, files: 1 },
          ...CONFIG_RECORDS(tree),
          ...Object.keys(tree).filter((f) => f.startsWith('front/src/')).sort()
            .map((file) => ({ kind: 'sourceFile', file })),
          { kind: 'summary', version: WORKERS.web, configsOnly: true },
        ];
      },
    },
  };
}

function harness(tree = { ...TREE }, io = memIo()) {
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  const { calls, run } = fakeWorkers(tree);
  const selection = {
    root: '/root',
    javaRoots: ['src/main/java'], javaRootsAbs: ['/root/src/main/java'],
    webRoots: ['front/src'], webRootsAbs: ['/root/front/src'],
    mapperDirs: ['src/main/resources/mapper'], ddl: 'schema.sql',
    sqlArgs: [], packagePrefixes: ['com.example'],
  };
  const inputs = {
    mapperFiles: [{ rel: 'src/main/resources/mapper/ItemMapper.xml', abs: '/root/src/main/resources/mapper/ItemMapper.xml' }],
    ddlFile: { rel: 'schema.sql', abs: '/root/schema.sql' },
    dialect: 'mysql', defaultSchema: null, mybatisArgs: [], lineageArgs: [], catalogArgs: [],
  };
  const diagnostics = [];
  const call = (plan, index) => runLanesWithShards({
    plan, index, store, selection, inputs, run,
    // Content hashes come from the fake tree, so an "edit" is a string change.
    hash: (abs) => `${'0'.repeat(56)}${hash8(tree[abs.replace('/root/', '')] ?? '')}`,
    abs: (rel) => `/root/${rel}`,
    workers: WORKERS, project: 'shop', base: { commit: 'c1', dirty: false, dirtyFiles: [] },
    diag: (d) => diagnostics.push(d),
  });
  return { store, io, calls, call, diagnostics, tree };
}

function hash8(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const COLD = { mode: MODE_COLD, reason: 'test cold', notes: [], reparseJava: [], dropJava: [], reparseWeb: [], dropWeb: [], sqlChanged: true, catalogChanged: true, webConfigChanged: true, reuse: { java: 0, web: 0 } };
const inc = (over = {}) => ({ mode: MODE_INCREMENTAL, reason: null, notes: [], reparseJava: [], dropJava: [], reparseWeb: [], dropWeb: [], sqlChanged: false, catalogChanged: false, webConfigChanged: false, reuse: { java: 0, web: 0 }, ...over });

// ---------------------------------------------------------------------------

test('cold: every worker runs, every shard is written, the index describes them all', () => {
  const h = harness();
  const r = h.call(COLD, null);
  assert.equal(h.calls.catalog, 1);
  assert.equal(h.calls.mybatis, 1);
  assert.deepEqual(h.calls.java, [['/root/src/main/java']], 'cold hands the worker the ROOTS, not a file list');
  assert.deepEqual(h.calls.web, [['/root/front/src']], 'and the web worker the web ROOTS');
  assert.equal(h.calls.webConfigs, 1, 'the package configuration is read on every run, cold or not');
  assert.equal(r.stats.mode, MODE_COLD);
  assert.equal(r.stats.reparsedJava, 2);
  assert.equal(r.stats.reusedJava, 0);
  assert.equal(r.stats.reparsedWeb, 2);
  assert.equal(r.stats.reusedWeb, 0);
  assert.deepEqual(Object.keys(r.index.files).sort(), [
    'front/src/api/items.js', 'front/src/api/orders.js',
    'src/main/java/com/example/A.java', 'src/main/java/com/example/B.java',
  ]);
  assert.deepEqual(Object.entries(r.index.files).filter(([, e]) => e.lane === 'web').map(([f]) => f).sort(),
    ['front/src/api/items.js', 'front/src/api/orders.js'], 'a web shard is recorded as one');
  // The package configuration is in the assembled stream, in the place a cold
  // worker printed it, and it is in no shard.
  assert.equal(r.webFacts.some((x) => x.kind === 'config' && x.what === 'env'), true);
  assert.equal(r.webFacts.some((x) => x.kind === 'header' || x.kind === 'summary'), false);
  assert.deepEqual(Object.keys(r.index.statements).sort(), ['com.example.mapper.ItemMapper.one', 'com.example.mapper.ItemMapper.three', 'com.example.mapper.OtherMapper.two']);
  assert.equal(r.index.engineVersion, INCREMENTAL_ENGINE_VERSION);
  assert.equal(r.index.catalog.shardKey.length, 12);
});

test('cold: identical SQL is analyzed ONCE and still produces one record per statement', () => {
  const h = harness();
  const r = h.call(COLD, null);
  assert.deepEqual(h.calls.lineage, [['com.example.mapper.ItemMapper.one', 'com.example.mapper.OtherMapper.two']],
    'the third statement shares the second\'s shard key, so it is not analyzed again');
  assert.equal(r.lineageRecords.length, 3);
  const two = r.lineageRecords.find((l) => l.id === 'two');
  const three = r.lineageRecords.find((l) => l.id === 'three');
  assert.equal(two.namespace, 'com.example.mapper.OtherMapper');
  assert.equal(two.line, 9);
  assert.equal(three.namespace, 'com.example.mapper.ItemMapper');
  assert.equal(three.line, 12, 'namespace/id/file/line come from the STATEMENT, never from the shared shard');
  assert.deepEqual(two.columns, three.columns);
});

test('a second run with nothing changed runs no worker at all and returns the same facts', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const before = { ...h.calls, java: [...h.calls.java], lineage: [...h.calls.lineage] };
  const again = h.call(inc(), cold.index);
  assert.equal(h.calls.catalog, before.catalog, 'catalog reused');
  assert.equal(h.calls.mybatis, before.mybatis, 'statement set reused');
  assert.deepEqual(h.calls.java, before.java, 'no java parse');
  assert.deepEqual(h.calls.lineage, before.lineage, 'no lineage analysis');
  assert.equal(again.stats.reusedJava, 2);
  assert.equal(again.stats.reparsedJava, 0);
  assert.equal(again.stats.reusedLineage, 2);
  assert.equal(again.stats.recomputedLineage, 0);
  assert.equal(again.stats.catalogReused, true);
  assert.equal(again.stats.statementsReused, true);
  assert.deepEqual(again.javaFacts, cold.javaFacts);
  assert.deepEqual(again.lineageRecords, cold.lineageRecords);
  assert.deepEqual(again.catalogRecords, cold.catalogRecords);
});

test('one edited java file: that file is reparsed, the other is reused, the SQL lanes are untouched', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  h.tree['src/main/java/com/example/A.java'] = 'A-v2';
  const r = h.call(inc({ reparseJava: ['src/main/java/com/example/A.java'] }), cold.index);
  assert.deepEqual(h.calls.java[1], ['/root/src/main/java/com/example/A.java'], 'exactly one file handed to the worker');
  assert.equal(r.stats.reparsedJava, 1);
  assert.equal(r.stats.reusedJava, 1);
  assert.equal(h.calls.mybatis, 1);
  assert.equal(h.calls.catalog, 1);
  const marker = (facts, fqn) => facts.find((f) => f.kind === 'method' && f.fqn === `${fqn}#run`).marker;
  assert.equal(marker(r.javaFacts, 'com.example.A'), 'A-v2', 'the edited file carries the new facts');
  assert.equal(marker(r.javaFacts, 'com.example.B'), 'B-v1', 'the untouched file carries the cached ones');
});

test('a deleted java file drops out of the assembled facts and out of the index', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  delete h.tree['src/main/java/com/example/B.java'];
  const r = h.call(inc({ dropJava: ['src/main/java/com/example/B.java'] }), cold.index);
  assert.equal(r.stats.droppedJava, 1);
  assert.equal(r.javaFacts.some((f) => f.file === 'src/main/java/com/example/B.java'), false);
  assert.deepEqual(Object.entries(r.index.files).filter(([, e]) => e.lane === 'java').map(([f]) => f),
    ['src/main/java/com/example/A.java']);
});

test('an edited DDL invalidates EVERY lineage shard (the catalog digest is in the key)', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  h.tree['schema.sql'] = 'ddl-v2';
  const r = h.call(inc({ catalogChanged: true }), cold.index);
  assert.equal(h.calls.catalog, 2, 'the catalog is reparsed');
  assert.equal(r.stats.catalogReused, false);
  assert.equal(r.stats.reusedLineage, 0, 'no lineage shard survives a catalog change');
  assert.equal(r.stats.recomputedLineage, 2);
  assert.equal(h.calls.mybatis, 1, 'the mapper XML did not change, so its statements are still reused');
  assert.equal(r.stats.statementsReused, true);
});

test('an edited mapper reruns the extractor but reuses every statement whose SQL did not move', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  h.tree['src/main/resources/mapper/ItemMapper.xml'] = 'xml-v2';
  const r = h.call(inc({ sqlChanged: true }), cold.index);
  assert.equal(h.calls.mybatis, 2);
  assert.equal(r.stats.statementsReused, false);
  assert.equal(r.stats.catalogReused, true, 'the DDL did not move');
  // Statement "one" embeds the mapper's marker in its SQL, the other two do not.
  assert.deepEqual(h.calls.lineage[1], ['com.example.mapper.ItemMapper.one']);
  assert.equal(r.stats.recomputedLineage, 1);
  assert.equal(r.stats.reusedLineage, 1);
});

test('a reparsed file that now carries NO facts still gets a shard ("analyzed, nothing in it")', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  // A worker that returns nothing for the file it was handed.
  const r = runLanesWithShards({
    plan: inc({ reparseJava: ['src/main/java/com/example/A.java'] }),
    index: cold.index, store: h.store,
    selection: { root: '/root', javaRoots: ['src/main/java'], javaRootsAbs: ['/root/src/main/java'], mapperDirs: [], ddl: null, sqlArgs: [], packagePrefixes: [] },
    inputs: { mapperFiles: [], ddlFile: null, dialect: 'mysql', defaultSchema: null, mybatisArgs: [], lineageArgs: [], catalogArgs: [] },
    run: { java: () => [{ kind: 'header', schema: 'cascade:javafacts:1', files: 1 }], mybatis: () => [], lineage: () => [], catalog: () => [] },
    hash: () => `${'0'.repeat(56)}deadbeef`,
    abs: (rel) => `/root/${rel}`,
    workers: WORKERS, project: 'shop', base: null,
  });
  assert.equal(r.index.files['src/main/java/com/example/A.java'].lines, 0);
  assert.equal(r.javaFacts.some((f) => f.file === 'src/main/java/com/example/A.java'), false);
  assert.equal(r.javaFacts.some((f) => f.file === 'src/main/java/com/example/B.java'), true, 'the other file is still reused');
});

// ---------------------------------------------------------------------------
// the web lane's shards (RM29)
// ---------------------------------------------------------------------------

test('a second run over an unchanged frontend re-parses nothing and reuses every web shard', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const again = h.call(inc(), cold.index);
  assert.deepEqual(h.calls.web, [['/root/front/src']], 'the worker was not asked for a source file again');
  assert.equal(again.stats.reusedWeb, 2);
  assert.equal(again.stats.reparsedWeb, 0);
  assert.deepEqual(again.webFacts, cold.webFacts, 'the assembled stream is the same stream');
});

test('two edited frontend files and one deleted: those three, and nothing else', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  h.tree['front/src/api/items.js'] = 'items-v2';
  h.tree['front/src/api/orders.js'] = 'orders-v2';
  h.tree['front/src/api/carts.js'] = 'carts-v1';
  const withCart = h.call(inc({ reparseWeb: ['front/src/api/carts.js', 'front/src/api/items.js', 'front/src/api/orders.js'] }), cold.index);
  assert.deepEqual(h.calls.web[1],
    ['/root/front/src/api/carts.js', '/root/front/src/api/items.js', '/root/front/src/api/orders.js'],
    'exactly the changed files are handed to the worker, sorted');
  assert.equal(withCart.stats.reparsedWeb, 3);
  assert.equal(withCart.stats.reusedWeb, 0, 'all three moved, so nothing was left to reuse');
  const marker = (facts, file) => facts.find((f) => f.kind === 'call' && f.file === file).marker;
  assert.equal(marker(withCart.webFacts, 'front/src/api/items.js'), 'items-v2');

  delete h.tree['front/src/api/carts.js'];
  const dropped = h.call(inc({ dropWeb: ['front/src/api/carts.js'] }), withCart.index);
  assert.equal(dropped.stats.droppedWeb, 1);
  assert.equal(dropped.stats.reusedWeb, 2);
  assert.equal(dropped.webFacts.some((f) => f.file === 'front/src/api/carts.js'), false,
    'a deleted frontend file leaves no fact behind');
  assert.equal(Object.hasOwn(dropped.index.files, 'front/src/api/carts.js'), false);
});

test('a re-read frontend file that now carries no facts still gets a shard', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  // Empty the file: the fake worker keys its records off the tree, so a target
  // it does not know produces nothing for it.
  const r = runLanesWithShards({
    plan: inc({ reparseWeb: ['front/src/api/items.js'] }),
    index: cold.index, store: h.store,
    selection: {
      root: '/root', javaRoots: [], javaRootsAbs: [],
      webRoots: ['front/src'], webRootsAbs: ['/root/front/src'],
      mapperDirs: [], ddl: null, sqlArgs: [], packagePrefixes: [],
    },
    inputs: { mapperFiles: [], ddlFile: null, dialect: 'mysql', defaultSchema: null, mybatisArgs: [], lineageArgs: [], catalogArgs: [] },
    run: {
      java: () => [], mybatis: () => [], lineage: () => [], catalog: () => [],
      web: () => [{ kind: 'header', schema: 'cascade:webfacts:1', files: 1 }],
      webConfigs: () => [
        { kind: 'sourceFile', file: 'front/src/api/items.js' },
        { kind: 'sourceFile', file: 'front/src/api/orders.js' },
      ],
    },
    // Every file hashes the same, so `items.js` no longer matches its recorded
    // shard key and is re-read; `orders.js` never had a matching one either, so
    // this fixture also shows a whole-lane re-read behaving.
    hash: () => `${'0'.repeat(56)}deadbeef`,
    abs: (rel) => `/root/${rel}`,
    workers: WORKERS, project: 'shop', base: null,
  });
  assert.equal(r.index.files['front/src/api/items.js'].lines, 0);
  assert.equal(r.webFacts.some((f) => f.file === 'front/src/api/items.js'), false);
  assert.equal(r.index.files['front/src/api/orders.js'].lines, 0);
});

test('the package configuration is recomputed on EVERY run, and is in no shard', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  assert.equal(h.calls.webConfigs, 1);
  h.tree['front/.env.development'] = 'env-v2';
  const after = h.call(inc({ webConfigChanged: true }), cold.index);
  assert.equal(h.calls.webConfigs, 2, 'the config run happens again even though no source file moved');
  assert.equal(after.stats.reparsedWeb, 0, 'a config edit re-parses no source file');
  assert.equal(after.stats.reusedWeb, 2);
  const env = after.webFacts.find((f) => f.kind === 'config' && f.what === 'env');
  assert.equal(env.value, 'env-v2', 'the new value is in the stream, from the config run and not from a shard');
  for (const key of Object.keys(after.index.files)) {
    assert.equal(key.endsWith('.env.development'), false, 'a package config file never gets a shard');
  }
});

test('a frontend file the CHANGESET never mentioned is still re-read: the bytes decide', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  // The edit git could not see: a frontend in another repository, or simply
  // outside the analyzed root. The plan lists nothing at all.
  h.tree['front/src/api/items.js'] = 'items-v2';
  const r = h.call(inc(), cold.index);
  assert.equal(r.stats.reparsedWeb, 1, 'the file whose content moved must be re-read whatever the plan said');
  assert.equal(r.stats.reusedWeb, 1);
  assert.deepEqual(h.calls.web[1], ['/root/front/src/api/items.js']);
  const marker = r.webFacts.find((f) => f.kind === 'call' && f.file === 'front/src/api/items.js').marker;
  assert.equal(marker, 'items-v2', 'the stale shard would have said items-v1, and the pack would disagree with a cold run');
});

test('a frontend file added or removed outside the changeset is picked up from the walk', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  h.tree['front/src/api/carts.js'] = 'carts-v1';
  const added = h.call(inc(), cold.index);
  assert.equal(added.stats.reparsedWeb, 1, 'a file the walk lists and the index does not is new');
  assert.deepEqual(h.calls.web[1], ['/root/front/src/api/carts.js']);
  assert.equal(added.webFacts.some((f) => f.file === 'front/src/api/carts.js'), true);

  delete h.tree['front/src/api/carts.js'];
  const removed = h.call(inc(), added.index);
  assert.equal(removed.stats.droppedWeb, 1, 'a file the index holds and the walk does not is gone');
  assert.equal(removed.webFacts.some((f) => f.file === 'front/src/api/carts.js'), false);
  assert.equal(Object.hasOwn(removed.index.files, 'front/src/api/carts.js'), false);
});

test('a TAMPERED web shard is never loaded — that one file is re-read', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const entry = cold.index.files['front/src/api/orders.js'];
  h.io.files.set(h.store.fileFor('webfacts', entry.shardKey), '');
  const r = h.call(inc(), cold.index);
  assert.equal(r.stats.tamperedWeb, 1);
  assert.deepEqual(h.calls.web[1], ['/root/front/src/api/orders.js'], 'the damaged unit is recomputed, alone');
  assert.equal(r.stats.reusedWeb, 1);
  assert.ok(h.diagnostics.some((d) => d.kind === 'SHARD_UNUSABLE' && /webfacts/.test(d.reason)));
  assert.equal(r.webFacts.some((f) => f.kind === 'call' && f.file === 'front/src/api/orders.js'), true);
});

// ---------------------------------------------------------------------------
// tamper: a shard that does not match what the index recorded
// ---------------------------------------------------------------------------

test('a TRUNCATED java shard is never loaded — the file is reparsed and a diagnostic says so', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const entry = cold.index.files['src/main/java/com/example/B.java'];
  const file = h.store.fileFor('javafacts', entry.shardKey);
  h.io.files.set(file, ''); // truncate to nothing
  const r = h.call(inc(), cold.index);
  assert.equal(r.stats.tamperedJava, 1);
  assert.deepEqual(h.calls.java[1], ['/root/src/main/java/com/example/B.java'], 'the damaged unit is recomputed, alone');
  assert.equal(r.stats.reusedJava, 1, 'the healthy shard is still reused');
  const d = h.diagnostics.find((x) => x.kind === 'SHARD_UNUSABLE');
  assert.ok(d, 'the recovery is reported, not silent');
  assert.match(d.reason, /is corrupt|is truncated/);
  assert.match(d.reason, /recomputed from source/);
  // And the result is the same facts a healthy cache would have given.
  assert.equal(r.javaFacts.some((f) => f.kind === 'type' && f.fqn === 'com.example.B'), true);
});

test('a TAMPERED lineage shard is recomputed rather than trusted', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const entry = cold.index.statements['com.example.mapper.ItemMapper.one'];
  h.io.files.set(h.store.fileFor('lineage', entry.shardKey), JSON.stringify({ tables: [{ table: 'evil', access: 'write' }], columns: [], joins: [], unresolved: [] }) + '\n');
  const r = h.call(inc(), cold.index);
  assert.equal(r.stats.tamperedLineage, 1);
  assert.deepEqual(h.calls.lineage[1], ['com.example.mapper.ItemMapper.one']);
  const one = r.lineageRecords.find((l) => l.id === 'one');
  assert.deepEqual(one.tables, [{ table: 'shop_item', access: 'read' }], 'the injected fact never reaches the graph');
  assert.ok(h.diagnostics.some((d) => d.kind === 'SHARD_UNUSABLE'));
});

test('a lineage shard holding more than one payload is refused', () => {
  const h = harness();
  const cold = h.call(COLD, null);
  const entry = cold.index.statements['com.example.mapper.ItemMapper.one'];
  const line = JSON.stringify({ tables: [], columns: [], joins: [], unresolved: [] });
  const text = `${line}\n${line}\n`;
  h.io.files.set(h.store.fileFor('lineage', entry.shardKey), text);
  // Rewrite the index entry so the integrity check passes and only the SHAPE is wrong.
  const idx = { ...cold.index, statements: { ...cold.index.statements } };
  idx.statements['com.example.mapper.ItemMapper.one'] = { ...entry, sha256: sha256Of(text), lines: 2 };
  const r = h.call(inc(), idx);
  assert.ok(h.diagnostics.some((d) => d.kind === 'SHARD_CORRUPT'), 'the wrong shape is named');
  assert.deepEqual(r.lineageRecords.find((l) => l.id === 'one').tables, [{ table: 'shop_item', access: 'read' }]);
});

test('a lineage worker that skips a statement is a hard failure, not a quietly missing statement', () => {
  const h = harness();
  assert.throws(() => runLanesWithShards({
    plan: COLD, index: null, store: h.store,
    selection: { root: '/root', javaRoots: [], javaRootsAbs: [], mapperDirs: ['m'], ddl: null, sqlArgs: [], packagePrefixes: [] },
    inputs: { mapperFiles: [{ rel: 'm/One.xml', abs: '/root/m/One.xml' }], ddlFile: null, dialect: 'mysql', defaultSchema: null, mybatisArgs: [], lineageArgs: [], catalogArgs: [] },
    run: {
      java: () => [], catalog: () => [],
      mybatis: () => [{ kind: 'statement', namespace: 'ns', id: 'a', type: 'select', sql: 'select 1', file: 'One.xml', line: 1 }],
      lineage: () => [], // returns nothing
    },
    hash: () => `${'0'.repeat(56)}deadbeef`,
    abs: (rel) => `/root/${rel}`,
    workers: WORKERS, project: 'shop', base: null,
  }), IncrementalError);
});

function sha256Of(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
