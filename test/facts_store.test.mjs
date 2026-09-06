import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createFactsStore, nodeFactsIo, javaShardKey, webShardKey, sqlStmtsShardKey, lineageShardKey,
  catalogShardKey, catalogDigestOf, javaRecordSortKey, splitJavaFactsByFile,
  assembleJavaFacts, webRecordSortKey, splitWebFactsByFile, assembleWebFacts, webFactsSummary,
  spliceFacts, emptyIndex, validateIndex, serializeIndex,
  FactsStoreError, FACTS_INDEX_SCHEMA,
} from '../src/core/facts_store.mjs';
import { findJdk } from '../scripts/ci-java-smoke.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// keys: what must change the key, and what must not
// ---------------------------------------------------------------------------

test('java shard key: same content at the same path -> same key', () => {
  const a = { path: 'src/A.java', contentSha256: 'a'.repeat(64), workerVersion: 'javafacts/2' };
  assert.equal(javaShardKey(a), javaShardKey({ ...a }));
});

test('java shard key: the PATH is part of the key — JavaFacts stamps it on every record', () => {
  const base = { contentSha256: 'a'.repeat(64), workerVersion: 'javafacts/2' };
  assert.notEqual(
    javaShardKey({ ...base, path: 'src/A.java' }),
    javaShardKey({ ...base, path: 'other/A.java' }),
    'two byte-identical files at two paths are NOT interchangeable facts',
  );
});

test('java shard key: content and worker version each change it', () => {
  const base = { path: 'src/A.java', contentSha256: 'a'.repeat(64), workerVersion: 'javafacts/2' };
  assert.notEqual(javaShardKey(base), javaShardKey({ ...base, contentSha256: 'b'.repeat(64) }));
  assert.notEqual(javaShardKey(base), javaShardKey({ ...base, workerVersion: 'javafacts/3' }));
});

test('lineage shard key: the PATH is NOT in it — identical SQL shares one shard', () => {
  const a = { sql: 'select id from t', statementType: 'select', catalogDigest: 'cafe12345678', dialect: 'mysql', defaultSchema: null, workerVersion: 'lineage/1' };
  assert.equal(lineageShardKey(a), lineageShardKey({ ...a }));
  // Two different statements, same SQL: the analysis is the same analysis.
  assert.equal(lineageShardKey(a), lineageShardKey({ ...a, statementId: 'anything' }));
});

test('lineage shard key: sql, type, catalog digest, dialect and default schema each change it', () => {
  const a = { sql: 'select id from t', statementType: 'select', catalogDigest: 'cafe12345678', dialect: 'mysql', defaultSchema: null, workerVersion: 'lineage/1' };
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, sql: 'select id, name from t' }));
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, statementType: 'update' }));
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, catalogDigest: 'beef12345678' }));
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, dialect: 'oracle' }));
  // The identity rule is an INPUT: the same sql under fold-lower and under
  // exact resolve to different tables, so they must not share a shard.
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, identifierCase: 'fold-lower' }));
  assert.notEqual(
    lineageShardKey({ ...a, identifierCase: 'fold-lower' }),
    lineageShardKey({ ...a, identifierCase: 'fold-upper' }),
  );
  // An EMPTY dialect is legitimate — it is how `hsqldb` asks for sqlglot's
  // default parser — and it keys a shard of its own.
  assert.match(lineageShardKey({ ...a, dialect: '' }), /^[0-9a-f]{12}$/);
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, dialect: '' }));
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, defaultSchema: 'mall' }));
  assert.notEqual(lineageShardKey(a), lineageShardKey({ ...a, workerVersion: 'lineage/2' }));
});

test('lineage shard key: an empty statement is a statement, not an error', () => {
  assert.match(lineageShardKey({ sql: '', statementType: 'select', catalogDigest: 'cafe12345678', dialect: 'mysql', workerVersion: 'lineage/1' }), /^[0-9a-f]{12}$/);
});

test('sqlstmts shard key: one shard for the SET — file order does not matter, content does', () => {
  const files = [
    { path: 'a/One.xml', contentSha256: '1'.repeat(64) },
    { path: 'b/Two.xml', contentSha256: '2'.repeat(64) },
  ];
  const v = { workerVersion: 'mybatis-extract/1', args: [] };
  assert.equal(sqlStmtsShardKey({ files, ...v }), sqlStmtsShardKey({ files: [...files].reverse(), ...v }));
  assert.notEqual(sqlStmtsShardKey({ files, ...v }), sqlStmtsShardKey({ files: files.slice(0, 1), ...v }));
  assert.notEqual(sqlStmtsShardKey({ files, ...v }), sqlStmtsShardKey({ files, ...v, args: ['--default-schema', 'mall'] }));
});

test('catalog shard key and catalog digest', () => {
  const file = (name, c) => ({ path: name, contentSha256: c.repeat(64) });
  const a = { files: [file('schema.sql', 'c')], workerVersion: 'catalog-ddl/1', args: [] };
  assert.equal(catalogShardKey(a), catalogShardKey({ ...a }));
  assert.notEqual(catalogShardKey(a), catalogShardKey({ ...a, files: [file('schema.sql', 'd')] }));
  // THE WHOLE SET, IN ORDER (RM20 §3). A catalog folded from several files
  // depends on which files and on their order — `ALTER … DROP COLUMN` before the
  // `CREATE TABLE` is a different catalog — so both must change the key.
  const two = { ...a, files: [file('a.sql', 'c'), file('b.sql', 'e')] };
  assert.notEqual(catalogShardKey(a), catalogShardKey(two), 'adding a file changes the key');
  assert.notEqual(
    catalogShardKey(two),
    catalogShardKey({ ...a, files: [file('b.sql', 'e'), file('a.sql', 'c')] }),
    'reordering the same two files changes the key',
  );
  // The digest that enters every lineage key is over the RECORDS, and the
  // per-run header (counts only) is deliberately left out of it.
  const recs = [{ kind: 'table', table: 't' }, { kind: 'column', table: 't', column: 'id' }];
  assert.equal(catalogDigestOf([{ kind: 'header', tables: 1 }, ...recs]), catalogDigestOf([{ kind: 'header', tables: 99 }, ...recs]));
  assert.notEqual(catalogDigestOf(recs), catalogDigestOf([...recs, { kind: 'column', table: 't', column: 'name' }]));
});

test('key builders refuse missing inputs rather than hashing "undefined"', () => {
  assert.throws(() => javaShardKey({ path: 'a', contentSha256: 'b' }), FactsStoreError);
  assert.throws(() => sqlStmtsShardKey({ files: 'nope', workerVersion: 'v' }), FactsStoreError);
  assert.throws(() => catalogShardKey({ files: [], workerVersion: 'v' }), FactsStoreError);
  assert.throws(() => lineageShardKey({ sql: 'x', catalogDigest: 'y' }), FactsStoreError);
});

// ---------------------------------------------------------------------------
// splitting and reassembling the JavaFacts stream
// ---------------------------------------------------------------------------

const REC = {
  header: { kind: 'header', schema: 'cascade:javafacts:1', version: 'javafacts/2', files: 2 },
  typeA: { kind: 'type', fqn: 'com.example.A', typeKind: 'class', package: 'com.example', annotations: [], implements: [], extends: null, file: 'A.java' },
  typeB: { kind: 'type', fqn: 'com.example.B', typeKind: 'class', package: 'com.example', annotations: [], implements: [], extends: null, file: 'B.java' },
  importA: { kind: 'import', owner: 'com.example.A', simple: 'B', fqn: 'com.example.B', file: 'A.java' },
  methodB: { kind: 'method', fqn: 'com.example.B#run', owner: 'com.example.B', name: 'run', paramCount: 0, line: 4, file: 'B.java' },
};

test('splitJavaFactsByFile: records go to their own file; the header is not shard content', () => {
  const { byFile, skipped } = splitJavaFactsByFile([REC.header, REC.typeA, REC.importA, REC.typeB, REC.methodB]);
  assert.equal(skipped, 1, 'the header carries a per-RUN tally and must not be cached per file');
  assert.deepEqual([...byFile.keys()].sort(), ['A.java', 'B.java']);
  assert.deepEqual(byFile.get('A.java'), [REC.typeA, REC.importA]);
});

test('assembleJavaFacts: shard order does not matter — the worker order is restored', () => {
  const { byFile } = splitJavaFactsByFile([REC.typeA, REC.importA, REC.typeB, REC.methodB]);
  const forward = assembleJavaFacts(byFile);
  const backward = assembleJavaFacts([...byFile.values()].reverse());
  assert.deepEqual(backward, forward);
  // imports (1) before types (2) before methods (5), exactly as JavaFacts sorts.
  assert.deepEqual(forward.map((r) => r.kind), ['import', 'type', 'type', 'method']);
});

test('javaRecordSortKey: a record kind the store does not shard returns null', () => {
  assert.equal(javaRecordSortKey(REC.header), null);
  assert.equal(javaRecordSortKey({ kind: 'something-new-in-a-later-worker' }), null);
  assert.notEqual(javaRecordSortKey(REC.typeA), null);
});

// This is THE test that makes the incremental path trustworthy for the Java lane:
// the reassembly must reproduce the worker's own byte stream, not merely its
// multiset, because the bridge's maps are last-write-wins in a few places.
test('assembleJavaFacts reproduces the real worker stream byte-for-byte', (t) => {
  const jdk = findJdk();
  if (!jdk) {
    t.skip('no JDK found: JAVA_HOME is unset and no javac on PATH — install a JDK 21 (see docs/setup/java-lane.md); CI runs this check on temurin 21');
    return;
  }
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-facts-store-'));
  t.after(() => fs.rmSync(build, { recursive: true, force: true }));
  const src = path.join(ENGINE_ROOT, 'adapters', 'java', 'JavaFacts.java');
  const fixture = path.join(ENGINE_ROOT, 'test', 'fixtures', 'java-smoke');
  execFileSync(jdk.javac, ['-d', build, src], { stdio: ['ignore', 'ignore', 'inherit'] });
  const out = execFileSync(jdk.java, ['-cp', build, 'JavaFacts', '--root', fixture, fixture], { maxBuffer: 1 << 28 }).toString('utf8');
  const lines = out.split('\n').filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));

  const { byFile, skipped } = splitJavaFactsByFile(records);
  assert.equal(skipped, 1, 'only the header should fail to land in a shard');
  assert.ok(byFile.size >= 4, `the fixture has four files, sharded ${byFile.size}`);
  // The M10 record kinds must land in a shard like any other, or an
  // incremental run would quietly lose every entity and repository fact.
  const kinds = new Set(records.filter((r) => r.kind !== 'header').map((r) => r.kind));
  assert.ok(kinds.has('entity') && kinds.has('repository'), `the fixture must exercise entity/repository records, saw ${[...kinds].sort().join(', ')}`);

  const reassembled = assembleJavaFacts(byFile);
  const expected = records.filter((r) => r.kind !== 'header').map((r) => JSON.stringify(r));
  assert.deepEqual(reassembled.map((r) => JSON.stringify(r)), expected,
    'the reassembled stream must equal the worker stream (minus the header) line for line');
});

// ---------------------------------------------------------------------------
// webfacts: keys, the split, the assembly and the recomputed summary (RM29)
// ---------------------------------------------------------------------------

test('web shard key: the PATH is part of the key, and so are content and worker version', () => {
  const base = { path: 'src/api/orders.js', contentSha256: 'a'.repeat(64), workerVersion: 'webfacts/2' };
  assert.equal(webShardKey(base), webShardKey({ ...base }));
  assert.notEqual(webShardKey(base), webShardKey({ ...base, path: 'other/api/orders.js' }));
  assert.notEqual(webShardKey(base), webShardKey({ ...base, contentSha256: 'b'.repeat(64) }));
  assert.notEqual(webShardKey(base), webShardKey({ ...base, workerVersion: 'webfacts/3' }));
  assert.throws(() => webShardKey({ ...base, path: '' }), FactsStoreError);
});

test('webRecordSortKey: the header and the summary are not shard content', () => {
  assert.equal(webRecordSortKey({ kind: 'header', schema: 'cascade:webfacts:1', root: '/x' }), null);
  assert.equal(webRecordSortKey({ kind: 'summary', files: 3 }), null);
  assert.equal(webRecordSortKey({ kind: 'call', line: 2 }), null, 'a record with no file cannot be filed under one');
  assert.notEqual(webRecordSortKey({ kind: 'call', file: 'a.js', line: 2 }), null);
});

test('splitWebFactsByFile keeps the PACKAGE configuration out of the per-file shards', () => {
  const recs = [
    { kind: 'header', schema: 'cascade:webfacts:1' },
    { kind: 'file', file: 'src/api/a.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'config', file: '.env.development', line: 1, what: 'env', name: 'VITE_BASE', value: '/api', mode: 'development' },
    { kind: 'config', file: 'src/api/a.js', line: 7, what: 'axios-defaults', key: 'baseURL' },
    { kind: 'call', file: 'src/api/a.js', line: 4 },
    { kind: 'summary', files: 1 },
  ];
  const { byFile, configRecords, skipped } = splitWebFactsByFile(recs);
  assert.equal(skipped, 2, 'the header and the summary are per-RUN tallies');
  assert.deepEqual([...byFile.keys()], ['src/api/a.js']);
  assert.equal(byFile.get('src/api/a.js').length, 3,
    'an axios-defaults config record is CODE and belongs to the file it is written in');
  assert.deepEqual(configRecords.map((r) => r.file), ['.env.development']);
});

test('splitWebFactsByFile: a file the config run owns is named, never guessed from its name', () => {
  const recs = [
    { kind: 'file', file: 'vue.config.js', line: 1, lang: 'js', recoveredErrors: 0 },
    { kind: 'file', file: 'src/tools/vue.config.js', line: 1, lang: 'js', recoveredErrors: 0 },
  ];
  const { byFile, configRecords } = splitWebFactsByFile(recs, { configFiles: ['vue.config.js'] });
  assert.deepEqual(configRecords.map((r) => r.file), ['vue.config.js']);
  assert.deepEqual([...byFile.keys()], ['src/tools/vue.config.js'],
    'a source file that happens to be called vue.config.js is still source');
});

// THE test that makes the web lane's incremental path trustworthy: reassembling
// the shards plus the package configuration must reproduce the worker's own
// bytes, not merely the same records in some order.
test('assembleWebFacts reproduces the real worker stream byte-for-byte, and the summary with it', (t) => {
  const worker = path.join(ENGINE_ROOT, 'adapters', 'web', 'webfacts.mjs');
  const fixture = path.join(ENGINE_ROOT, 'test', 'fixtures', 'web-smoke');
  const run = (args) => execFileSync(process.execPath, [worker, ...args], { maxBuffer: 1 << 28 })
    .toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const cold = run(['--root', fixture, path.join(fixture, 'src')]);
  const configs = run(['--configs-only', '--root', fixture, path.join(fixture, 'src')]);
  const configRecords = configs.filter((r) => !['header', 'summary', 'sourceFile'].includes(r.kind));
  assert.ok(configRecords.length > 0, 'the fixture declares env values, aliases and proxy rules');
  assert.equal(configs.some((r) => r.kind === 'call'), false,
    '--configs-only parses no source file');
  // ...and it still LISTS them, which is what lets an incremental run decide
  // from the bytes which shards apply.
  const listed = configs.filter((r) => r.kind === 'sourceFile').map((r) => r.file);
  assert.ok(listed.includes('src/api/orders.js'), `the file list is missing a source file: ${listed.join(', ')}`);
  assert.equal(listed.includes('src/types/thing.d.ts'), false, 'a type declaration is not a file this lane reads');
  assert.equal(listed.includes('vue.config.js'), false, 'a config file is not a source file');
  assert.deepEqual(listed, [...listed].sort(), 'the list is sorted, like everything else this worker prints');

  const configFiles = new Set(configRecords.map((r) => r.file));
  const { byFile, configRecords: fromCold } = splitWebFactsByFile(cold, { configFiles });
  assert.ok(byFile.size >= 14, `the fixture has more than a handful of files, sharded ${byFile.size}`);
  assert.deepEqual(fromCold.map((r) => JSON.stringify(r)), configRecords.map((r) => JSON.stringify(r)),
    'the config records a full run prints and the ones --configs-only prints must be the same records');

  const reassembled = assembleWebFacts(byFile, configRecords);
  const expected = cold.filter((r) => r.kind !== 'header' && r.kind !== 'summary').map((r) => JSON.stringify(r));
  assert.deepEqual(reassembled.map((r) => JSON.stringify(r)), expected,
    'the reassembled stream must equal the worker stream (minus header and summary) line for line');

  // ...and the counts the pack reports are derived from those same records.
  const printed = cold[cold.length - 1];
  assert.equal(printed.kind, 'summary');
  const { kind, version, ...counts } = printed;
  assert.deepEqual(webFactsSummary(reassembled), counts);
});

// ---------------------------------------------------------------------------
// spliceFacts — the in-memory swap RM4's overlay will call
// ---------------------------------------------------------------------------

test('spliceFacts replaces and drops without touching the input map', () => {
  const all = new Map([['A.java', [REC.typeA]], ['B.java', [REC.typeB]]]);
  const edited = [{ ...REC.typeA, annotations: ['RestController'] }];
  const out = spliceFacts(all, { replaceForFiles: new Map([['A.java', edited]]), dropFiles: ['B.java'] });
  assert.deepEqual([...out.keys()], ['A.java']);
  assert.deepEqual(out.get('A.java'), edited);
  assert.deepEqual([...all.keys()].sort(), ['A.java', 'B.java'], 'the committed shard map must be left intact');
  assert.deepEqual(all.get('A.java'), [REC.typeA]);
});

test('spliceFacts accepts entry pairs and refuses a non-array replacement', () => {
  const all = new Map([['A.java', [REC.typeA]]]);
  assert.deepEqual(spliceFacts(all, { replaceForFiles: [['C.java', []]] }).get('C.java'), []);
  assert.throws(() => spliceFacts(all, { replaceForFiles: new Map([['A.java', 'nope']]) }), FactsStoreError);
  assert.throws(() => spliceFacts({}, {}), FactsStoreError);
});

// ---------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------

const head = () => ({
  project: 'shop', engineVersion: 'cascade-incremental/1',
  workers: { java: 'javafacts/2', mybatis: 'mybatis-extract/1', lineage: 'lineage/1', catalog: 'catalog-ddl/1' },
  root: '/tmp/shop', selection: { javaRoots: ['src/main/java'], mapperDirs: [], ddl: null, sqlArgs: [], packagePrefixes: [] },
  base: { commit: 'abc', dirty: false, dirtyFiles: [] },
});

test('facts index: round-trips through its canonical serialization', () => {
  const idx = emptyIndex(head());
  idx.files['src/main/java/A.java'] = { lane: 'java', shardKey: 'aaaaaaaaaaaa', sha256: 'a'.repeat(64), lines: 3 };
  idx.statements['ns.one'] = { shardKey: 'bbbbbbbbbbbb', sha256: 'b'.repeat(64), lines: 1 };
  const text = serializeIndex(idx);
  assert.equal(text, serializeIndex(JSON.parse(text)), 'serialization must be stable across a round trip');
  const back = validateIndex(JSON.parse(text));
  assert.equal(back.schema, FACTS_INDEX_SCHEMA);
  assert.deepEqual(back.files, idx.files);
  assert.deepEqual(back.statements, idx.statements);
});

test('facts index: a foreign schema or a half-written entry is REJECTED, not half-trusted', () => {
  assert.throws(() => validateIndex(null), FactsStoreError);
  assert.throws(() => validateIndex({ ...emptyIndex(head()), schema: 'cascade:facts-index:99' }), /unknown facts index schema/);
  const idx = emptyIndex(head());
  idx.files['A.java'] = { lane: 'java', shardKey: 'aaaaaaaaaaaa' }; // no sha256/lines
  assert.throws(() => validateIndex(idx), /missing shardKey\/sha256\/lines/);
});

// ---------------------------------------------------------------------------
// the store itself (over a fake io, then over the real one)
// ---------------------------------------------------------------------------

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

test('store: write then read returns the same records, and reports sha256 + line count', () => {
  const io = memIo();
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  const w = store.write('javafacts', 'aaaaaaaaaaaa', [REC.typeA, REC.importA]);
  assert.equal(w.lines, 2);
  assert.match(w.sha256, /^[0-9a-f]{64}$/);
  assert.equal(store.has('javafacts', 'aaaaaaaaaaaa'), true);
  assert.equal(store.has('javafacts', 'bbbbbbbbbbbb'), false);
  const r = store.read('javafacts', 'aaaaaaaaaaaa', { sha256: w.sha256, lines: w.lines });
  assert.deepEqual(r.records, [REC.typeA, REC.importA]);
  assert.equal(store.fileFor('javafacts', 'aaaaaaaaaaaa'), '/cache/cascade/shop/cas/javafacts-aaaaaaaaaaaa/facts.jsonl');
});

test('store: an empty shard is a real answer ("analyzed, nothing in it")', () => {
  const io = memIo();
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  const w = store.write('javafacts', 'cccccccccccc', []);
  assert.equal(w.lines, 0);
  assert.deepEqual(store.read('javafacts', 'cccccccccccc', w).records, []);
});

test('store: a TRUNCATED shard throws instead of loading a partial fact set', () => {
  const io = memIo();
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  const w = store.write('javafacts', 'dddddddddddd', [REC.typeA, REC.importA, REC.methodB]);
  const file = store.fileFor('javafacts', 'dddddddddddd');
  io.files.set(file, io.files.get(file).split('\n').slice(0, 1).join('\n') + '\n');
  // The content hash catches it first — that is the strongest check, and it is
  // the one a real truncation hits.
  assert.throws(() => store.read('javafacts', 'dddddddddddd', w), /is corrupt: content sha256/);
  // The line count is the SECOND guard, for an index that recorded no hash
  // (or a shard whose bytes were replaced with other valid JSONL).
  assert.throws(() => store.read('javafacts', 'dddddddddddd', { lines: w.lines }), /is truncated: 1 line\(s\) on disk, 3 recorded/);
});

test('store: an EDITED shard fails its recorded sha256', () => {
  const io = memIo();
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  const w = store.write('javafacts', 'eeeeeeeeeeee', [REC.typeA]);
  const file = store.fileFor('javafacts', 'eeeeeeeeeeee');
  io.files.set(file, JSON.stringify({ ...REC.typeA, fqn: 'com.evil.Injected' }) + '\n');
  assert.throws(() => store.read('javafacts', 'eeeeeeeeeeee', w), /is corrupt: content sha256/);
});

test('store: a missing shard, an unknown kind and unparseable JSONL all throw', () => {
  const io = memIo();
  const store = createFactsStore({ io, projectId: 'shop', env: { XDG_CACHE_HOME: '/cache' } });
  assert.throws(() => store.read('javafacts', 'ffffffffffff'), /is missing from the cache/);
  assert.throws(() => store.dirFor('nonsense', 'ffffffffffff'), /unknown shard kind/);
  io.files.set(store.fileFor('lineage', 'ffffffffffff'), 'not json\n');
  assert.throws(() => store.read('lineage', 'ffffffffffff'), /does not parse as JSONL/);
});

test('store: refuses an io that is not an io', () => {
  assert.throws(() => createFactsStore({ io: { readFile: 1 }, projectId: 'shop' }), /io.readFile must be a function/);
});

test('nodeFactsIo: writes are atomic (temp file + rename) and readable back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-facts-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createFactsStore({ io: nodeFactsIo(fs), projectId: 'shop', env: { XDG_CACHE_HOME: dir } });
  const w = store.write('lineage', '0123456789ab', [{ tables: [], columns: [], joins: [], unresolved: [] }]);
  assert.equal(w.lines, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(w.file)), ['facts.jsonl'], 'no .tmp leftovers');
  assert.deepEqual(store.read('lineage', '0123456789ab', w).records, [{ tables: [], columns: [], joins: [], unresolved: [] }]);
});
