// catalog_read.test.mjs — what the schema reader could not read, or had to assume, is in the pack (RM67-C5).
//
// catalog_ddl.py named every table it lost and every rule it assumed, on stderr
// only. The pack never held a word of it, so ruoyi-vue-pro's SQL Server schema,
// read with MySQL's grammar, gave a catalog of 0 of its 60 tables, and the
// overview, the viewer and the MCP answers showed the catalog as read. These
// tests hold the grouping, the gaps the overview counts them into, the answer a
// reader and an AI get, and that none of it moves a digest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Graph } from '../src/core/graph.mjs';
import { projectPack } from '../src/core/pack.mjs';
import { catalogDigestOf } from '../src/core/facts_store.mjs';
import { buildOverview } from '../src/core/overview.mjs';
import { callTool } from '../src/mcp/catalog.mjs';
import { packMeta } from '../src/cli/serve.mjs';
import { CATALOG_CODES, catalogReadStats, catalogDiagnostics, plainSentence } from '../src/core/catalog_read.mjs';
import { declareAxes } from '../src/core/lanes.mjs';
import { axisRemedies } from '../src/core/remedies.mjs';
import { sqlLaneVenv } from './helpers/lane_prereqs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cascade.mjs');

const said = (level, code, table, message) => ({ level, code, table, message });
const header = (diagnostics) => ({
  kind: 'header', schema: 'cascade:catalog-snapshot:1', version: 'catalog-ddl/12', source: 'ddl:schema.sql', dialect: 'mysql',
  tables: 1, columns: 1, commented: 0, files: [], ...(diagnostics ? { diagnostics } : {}),
});
const BODY = [
  { kind: 'table', schema: null, table: 'a', comment: null },
  { kind: 'column', schema: null, table: 'a', column: 'id', type: 'INT', nullable: false, comment: null, ordinal: 1, pk: true },
];

/** What the reader says of a SQL Server schema read with MySQL's grammar, and of an ALTER read by an assumed rule. */
function sqlServerRead() {
  const unread = Array.from({ length: 49 }, (_, i) => said('warn', 'create_table_unread', `t${String(i).padStart(2, '0')}`,
    `ruoyi-vue-pro.sql: CREATE TABLE t${String(i).padStart(2, '0')} at line ${10 + i} is not a statement the grammar read on its own (it is read as part of another), so its table is not in the catalog`));
  const unreadable = Array.from({ length: 11 }, (_, i) => said('warn', 'create_table_unreadable', `QRTZ_${i}`,
    `quartz.sql: CREATE TABLE QRTZ_${i} could not be read, so its table is not in the catalog: CREATE TABLE [dbo].[QRTZ_${i}] (...)`));
  return [
    said('warn', 'parse_error', null, 'full parse of ruoyi-vue-pro.sql failed, salvaging with error_level=IGNORE: Invalid expression / Unexpected token. Line 16, Col: 2.\n  DROP TABLE IF EXISTS dual \u001b[4mGO\u001b[0m'),
    ...unread,
    ...unreadable,
    said('warn', 'alter_rule_assumed', 'a', "schema.sql: MODIFY a.c leaves out its nullability, which is read as gone, by MySQL's rule that MODIFY restates the whole column. MySQL is assumed because sqlDialects.main is not declared; declare it if these files are for another database"),
    said('warn', 'alter_clause_unsupported', 'a', 'schema.sql: ADD CONSTRAINT / ADD INDEX / ADD KEY on a is not applied to the catalog (it changes no column, type, nullability or primary key)'),
    said('info', 'create_read_in_mode', 'b', "schema.sql: CREATE TABLE b is not written in H2's own SQL; it is read as H2 reads it in its MySQL mode"),
  ];
}

// ---------------------------------------------------------------------------
// the grouping
// ---------------------------------------------------------------------------

test('the reader\'s diagnostics are grouped by code, each with its count, the tables it named and the first sentences in full', () => {
  const s = catalogReadStats([header(sqlServerRead()), ...BODY]);
  assert.equal(s.reader, 'catalog-ddl/12');
  assert.equal(s.said, 64);
  assert.deepEqual(s.codes.map((c) => [c.code, c.count, c.level, c.gap]), [
    ['create_table_unreadable', 11, 'warn', 'catalog-tables-unread'],
    ['create_table_unread', 49, 'warn', 'catalog-tables-unread'],
    ['alter_rule_assumed', 1, 'warn', 'catalog-rules-assumed'],
    ['parse_error', 1, 'warn', 'catalog-read-in-part'],
    ['alter_clause_unsupported', 1, 'warn', null],
    ['create_read_in_mode', 1, 'info', null],
  ], 'in the order the table names the codes, each with the gap it counts into');
  const unread = s.codes.find((c) => c.code === 'create_table_unread');
  assert.equal(unread.kind, 'CATALOG_CREATE_TABLE_UNREAD');
  assert.equal(unread.tablesNamed, 49);
  assert.deepEqual(unread.tables, ['t00', 't01', 't02', 't03', 't04', 't05', 't06', 't07', 't08', 't09'], 'the first ten names');
  assert.equal(unread.examples.length, 5, 'the first five sentences, whatever the schema gave');
  assert.match(unread.examples[0], /^ruoyi-vue-pro\.sql: CREATE TABLE t00 at line 10 /);
  assert.deepEqual(s.gaps, { 'catalog-tables-unread': 60, 'catalog-rules-assumed': 1, 'catalog-read-in-part': 1 },
    'a clause the catalog does not hold and an info note count into no gap');
});

test('a catalog whose header carries no list said nothing this run can see, which is not "none"', () => {
  assert.equal(catalogReadStats([header(null), ...BODY]), null, 'a snapshot, or a reader from before the list was kept');
  assert.equal(catalogReadStats(BODY), null, 'no header at all');
  assert.equal(catalogReadStats([]), null);
  assert.deepEqual(catalogReadStats([header([]), ...BODY]), { reader: 'catalog-ddl/12', said: 0, gaps: {}, codes: [] },
    'a reader that read every statement says so with an empty list');
  assert.deepEqual(catalogDiagnostics(null), []);
});

test('a sentence the reader wrote for a terminal is carried plain: no escape codes, no line breaks, cut to a line', () => {
  const s = catalogReadStats([header(sqlServerRead())]);
  const parse = s.codes.find((c) => c.code === 'parse_error').examples[0];
  // eslint-disable-next-line no-control-regex -- Verify terminal control characters were removed.
  assert.equal(/[\u0000-\u001f]/.test(parse), false, parse);
  assert.match(parse, /DROP TABLE IF EXISTS dual GO$/);
  assert.equal(plainSentence('x'.repeat(1000)).length, 300);
  assert.match(plainSentence('x'.repeat(1000)), /\.\.\.$/);
});

test('an unlisted code is still said, and counted where it may have cost the catalog something', () => {
  const s = catalogReadStats([header([said('warn', 'from_tomorrow', 't', 'something new'), said('info', 'note_from_tomorrow', null, 'fyi')])]);
  assert.deepEqual(s.codes.map((c) => [c.code, c.kind, c.gap]), [
    ['from_tomorrow', 'CATALOG_OTHER_NOTE', 'catalog-read-in-part'],
    ['note_from_tomorrow', 'CATALOG_OTHER_NOTE', null],
  ]);
});

// ---------------------------------------------------------------------------
// the table, held to the reader and to the overview
// ---------------------------------------------------------------------------

test('every code the reader can say is in the table, and the table names no code the reader never says', () => {
  const src = fs.readFileSync(path.join(ROOT, 'adapters', 'sql', 'catalog_ddl.py'), 'utf8');
  const emitted = new Set([...src.matchAll(/"(?:info|warn|error)",\s*"([A-Za-z_]+)",/g)].map((m) => m[1]));
  assert.ok(emitted.size >= 20, `expected the reader's whole vocabulary, found ${emitted.size}`);
  assert.ok(emitted.has('create_table_unread') && emitted.has('alter_rule_assumed'));
  assert.deepEqual([...emitted].filter((c) => !Object.hasOwn(CATALOG_CODES, c)).sort(), [], 'codes the table does not name');
  assert.deepEqual(Object.keys(CATALOG_CODES).filter((c) => !emitted.has(c)).sort(), [], 'codes the reader never says');
});

test('every kind is the catalog\'s own and said once, and every gap a code counts into is one the overview emits', () => {
  const overview = fs.readFileSync(path.join(ROOT, 'src', 'core', 'overview.mjs'), 'utf8');
  const kinds = Object.values(CATALOG_CODES).map((e) => e.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'one kind per code');
  for (const [code, e] of Object.entries(CATALOG_CODES)) {
    assert.match(e.kind, /^CATALOG_[A-Z_]+$/, code);
    if (e.gap) assert.ok(overview.includes(`kind: '${e.gap}'`), `${code} counts into ${e.gap}, which the overview never emits`);
    assert.equal(/[\u2014\u00b7]/.test(e.what), false, `${code}: plain punctuation`);
  }
  // What loses the catalog nothing counts into no gap: a clause it does not hold, and every info note.
  assert.equal(CATALOG_CODES.alter_clause_unsupported.gap, null);
  for (const code of ['create_clause_not_held', 'create_constraint_disabled', 'create_read_in_mode', 'alter_primary_key_by_convention']) {
    assert.equal(CATALOG_CODES[code].gap, null, code);
  }
});

// ---------------------------------------------------------------------------
// the run's diagnostics, and the overview
// ---------------------------------------------------------------------------

test('each code is one diagnostic of the run, with its count, the tables it named and its first sentences', () => {
  const many = Array.from({ length: 300 }, (_, i) => said('warn', 'alter_unknown_table', `x${i}`, `m.sql alters x${i}, which no file declared before it; ignored`));
  const ds = catalogDiagnostics(catalogReadStats([header(many)]));
  assert.equal(ds.length, 1, 'three hundred of one are one line');
  const [d] = ds;
  assert.deepEqual([d.kind, d.severity, d.key, d.count, d.examples.length], ['CATALOG_ALTER_UNKNOWN_TABLE', 'warn', 'catalog', 300, 5]);
  assert.match(d.reason, /^300 ALTER or RENAME statement\(s\) change a table no file declared before them, and were ignored \(x0, x1, x2, and 297 more\)\. The first, as the schema reader said it: m\.sql alters x0,/);
  const assumed = catalogDiagnostics(catalogReadStats([header(sqlServerRead())])).find((x) => x.kind === 'CATALOG_RULE_ASSUMED');
  assert.equal(assumed.key, 'sqlDialects', 'the setting a reader declares to settle it');
});

/** Two routes, one reaching table a. */
function graph() {
  const g = new Graph();
  g.addNode({ id: 'endpoint:GET /a', path: '/a', httpMethod: 'GET', handler: 'symbol:A#get' });
  g.addNode({ id: 'symbol:A#get', file: 'A.java' });
  g.addEdge({ from: 'endpoint:GET /a', to: 'symbol:A#get', type: 'HANDLES', grade: 'EXACT' });
  g.addNode({ id: 'statement:s1', statementType: 'select' });
  g.addEdge({ from: 'symbol:A#get', to: 'statement:s1', type: 'IMPLEMENTS_STMT', grade: 'EXACT' });
  g.addEdge({ from: 'statement:s1', to: 'table:a', type: 'EXECUTES', grade: 'EXACT', evidence: { access: 'read' } });
  return g;
}

test('the overview counts what the reader lost into its gaps, each with a cause and the remedy the engine knows', () => {
  const catalog = catalogReadStats([header(sqlServerRead())]);
  const o = buildOverview(graph(), { laneStats: { catalog }, axes: { catalog: { status: 'shipped', reason: null } } });
  const gap = (k) => o.gaps.find((g) => g.kind === k);
  const tables = gap('catalog-tables-unread');
  assert.equal(tables.count, 60);
  assert.equal(tables.class, 'unresolved');
  assert.equal(tables.remedy, null, 'no single fix is known for a table the grammar could not read');
  assert.match(tables.note, /^60 table\(s\) the schema files declare are not in the catalog, or only in part, because the reader could not read their CREATE TABLE, among them QRTZ_0, QRTZ_1, QRTZ_2\./);
  assert.match(tables.note, /CATALOG_CREATE_TABLE_UNREADABLE 11, CATALOG_CREATE_TABLE_UNREAD 49/);
  const rules = gap('catalog-rules-assumed');
  assert.equal(rules.count, 1);
  assert.equal(rules.class, 'input', 'the run did not have the database it was told');
  assert.deepEqual(rules.remedy, { action: 'declare', key: 'sqlDialects', example: '{ "main": "postgres" }' });
  assert.match(rules.note, /sqlDialects\.main is not declared/);
  const part = gap('catalog-read-in-part');
  assert.equal(part.count, 1);
  assert.equal(part.class, 'unresolved');
  assert.match(part.note, /CATALOG_FILE_NOT_PARSED 1/);
  // Told right after the schema's own gaps, before the routes and the reach.
  const kinds = o.gaps.map((g) => g.kind);
  const first = kinds.indexOf('catalog-tables-unread');
  assert.deepEqual(kinds.slice(first, first + 3), ['catalog-tables-unread', 'catalog-rules-assumed', 'catalog-read-in-part']);
  assert.deepEqual(kinds.slice(0, first).filter((k) => !['no-catalog', 'not-shipped', 'unresolved-calls', 'external-symbols'].includes(k)), [], 'only the schema gaps come first');
  assert.ok(first < kinds.indexOf('mode-floor'));
  // Nothing the reader lost is no catalog gap, and a pack from before is none either.
  const clean = buildOverview(graph(), { laneStats: { catalog: catalogReadStats([header([sqlServerRead().at(-2)])]) } });
  assert.equal(clean.gaps.some((g) => g.kind.startsWith('catalog-')), false, 'a clause the catalog does not hold is no gap');
  assert.equal(buildOverview(graph(), {}).gaps.some((g) => g.kind.startsWith('catalog-')), false);
});

test('the overview answer carries each kind once, with its count, its first sentences and the remedy the engine knows', () => {
  const catalog = catalogReadStats([header(sqlServerRead())]);
  const pack = {
    project: 'p', digest: 'd', lanes: ['sql'], laneStats: { catalog },
    axes: { catalog: { status: 'shipped', reason: null } },
    diagnostics: [{ kind: 'PROFILE_DEFAULT_ASSUMED', severity: 'info', key: 'sqlDialects', reason: 'sqlDialects is empty' }, ...catalogDiagnostics(catalog)],
  };
  const r = callTool('overview', {}, {
    graph: graph(), pack, trust: { trustLevel: 'UNCERTIFIED' },
    basis: { project: 'p', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
  });
  const a = r.answer;
  const ds = a.diagnostics;
  assert.deepEqual(ds.map((d) => [d.kind, d.count]), [
    ['CATALOG_CREATE_TABLE_UNREADABLE', 11], ['CATALOG_CREATE_TABLE_UNREAD', 49], ['CATALOG_RULE_ASSUMED', 1],
    ['CATALOG_FILE_NOT_PARSED', 1], ['CATALOG_CLAUSE_NOT_HELD', 1],
  ], 'warn and error only, as every lane\'s: an info note is not a gap');
  assert.equal(ds[1].examples.length, 5);
  assert.deepEqual(ds.find((d) => d.kind === 'CATALOG_RULE_ASSUMED').remedy, { action: 'declare', key: 'sqlDialects', example: '{ "main": "postgres" }' });
  assert.equal(ds.find((d) => d.kind === 'CATALOG_CREATE_TABLE_UNREAD').remedy, null);
  const lim = r.limits.filter((l) => l.scope.startsWith('diagnostic:CATALOG_'));
  assert.equal(lim.length, 5, 'one limit per kind, not one per table');
  assert.ok(r.limits.some((l) => l.scope === 'overview' && l.reason.startsWith('catalog-tables-unread (60): ')));
  // A pack from before carries no count, and the answer adds none.
  const old = callTool('overview', {}, {
    graph: graph(), pack: { ...pack, diagnostics: [{ kind: 'TS_PREFIX_UNREAD', severity: 'warn', key: 'tsBackend', reason: 'r' }] },
    trust: { trustLevel: 'UNCERTIFIED' }, basis: { project: 'p', buildDigest: 'd', builtAt: 'x', freshness: { verdict: 'unknown' } },
  });
  assert.deepEqual(Object.keys(old.answer.diagnostics[0]).sort(), ['key', 'kind', 'reason', 'remedy', 'severity']);
});

// ---------------------------------------------------------------------------
// the catalog axis, and its remedy per cause (RM67-C6)
// ---------------------------------------------------------------------------

test('a catalog that lost tables or assumed rules is degraded, with the reason and each cause', () => {
  const lost = declareAxes({ ddl: true, statements: true, code: true, catalogRead: catalogReadStats([header(sqlServerRead())]) });
  assert.equal(lost.catalog.status, 'degraded', 'ruoyi-vue-pro\'s SQL Server schema: 0 of 60 tables read, and it said shipped');
  assert.deepEqual(lost.catalog.causes, ['tables-unread', 'rules-assumed']);
  assert.match(lost.catalog.reason, /^60 table\(s\) the schema files declare are not in the catalog, or are in it only in part, because the schema reader could not read their CREATE TABLE/);
  assert.match(lost.catalog.reason, /1 conclusion\(s\) about the schema rest on a rule of a database this run assumed, because sqlDialects\.main is not declared/);
  assert.equal(/[—·]/.test(lost.catalog.reason), false);
  // What costs no table and assumes no rule leaves the axis whole: a table read in part is a gap, not a lost table.
  const inPart = catalogReadStats([header([said('warn', 'DUPLICATE_TABLE_DECLARATION', 't', 't is declared twice'),
    said('warn', 'alter_clause_unsupported', 't', 'x'), said('info', 'parse_error_not_held', null, 'y')])]);
  assert.deepEqual(declareAxes({ ddl: true, statements: true, code: true, catalogRead: inPart }).catalog, { status: 'shipped', reason: null });
  assert.deepEqual(declareAxes({ ddl: true, statements: true, code: true, catalogRead: null }).catalog, { status: 'shipped', reason: null },
    'a snapshot, or a reader that kept no list, says nothing this run can see');
  const rules = declareAxes({ ddl: true, statements: true, code: true, catalogRead: catalogReadStats([header([sqlServerRead().at(-3)])]) });
  assert.deepEqual([rules.catalog.status, rules.catalog.causes], ['degraded', ['rules-assumed']]);
});

test('the catalog axis names the remedy of the cause at hand, and none where the causes differ or none is known', () => {
  const axis = (causes) => axisRemedies({ catalog: { status: 'degraded', reason: 'r', causes } }).catalog;
  assert.equal(axis(['tables-unread']), null, 'no single fix is known for a table the grammar could not read');
  assert.deepEqual(axis(['rules-assumed']), { action: 'declare', key: 'sqlDialects', example: '{ "main": "postgres" }' });
  assert.equal(axis(['typeorm-names-heuristic']).key, 'tsBackend.typeorm');
  assert.equal(axis(['tables-unread', 'rules-assumed']), null, 'two causes, no one fix');
  assert.equal(axis(['typeorm-names-heuristic', 'rules-assumed']), null);
  assert.equal(axis([]), null, 'a degraded catalog that names no cause gets no guess');
  // The column axis follows the catalog's fix only where the catalog has one.
  const both = axisRemedies({ catalog: { status: 'degraded', reason: 'r', causes: ['rules-assumed'] }, column: { status: 'degraded', reason: 'r' } });
  assert.deepEqual(both.column, both.catalog);
});

test('what changes nothing is a note: IF EXISTS on a column that is not there, and a parse that stopped only where no table changes', () => {
  assert.equal(CATALOG_CODES.alter_if_exists_absent.gap, null);
  assert.equal(CATALOG_CODES.parse_error_not_held.gap, null);
  assert.equal(CATALOG_CODES.parse_error.gap, 'catalog-read-in-part', 'a stop where an ALTER or a RENAME was is still a gap');
  const s = catalogReadStats([header([
    said('info', 'alter_if_exists_absent', 't', 'm.sql drops t.zz IF EXISTS, which is not there; nothing changes, as the database changes nothing'),
    said('info', 'parse_error_not_held', null, 'full parse of schema.sql failed, salvaging with error_level=IGNORE: x. The 2 statement(s) it could not read as written, the first at line 1, declare and change no table, except a CREATE TABLE named on its own, so the catalog may have lost nothing by them'),
  ])]);
  assert.deepEqual(s.gaps, {}, 'neither counts as a table read in part');
  assert.deepEqual(s.codes.map((c) => c.kind), ['CATALOG_FILE_PART_NOT_HELD', 'CATALOG_IF_EXISTS_ABSENT']);
});

// ---------------------------------------------------------------------------
// no digest moves
// ---------------------------------------------------------------------------

test('what the reader said moves no digest: not the pack\'s, and not the catalog digest every lineage key holds', () => {
  const records = [header(sqlServerRead()), ...BODY];
  assert.equal(catalogDigestOf(records), catalogDigestOf([header(null), ...BODY]), 'the header is outside the lineage keys');
  const catalog = catalogReadStats(records);
  const withIt = projectPack(graph(), { laneStats: { catalog }, diagnostics: catalogDiagnostics(catalog) });
  assert.equal(withIt.digest, projectPack(graph(), {}).digest, 'the pack digest is its nodes and edges, and none of this is either');
  assert.deepEqual(packMeta(withIt).laneStats, { catalog }, 'and the server hands the block to the overview');
});

// ---------------------------------------------------------------------------
// end to end: a cached catalog still says it
// ---------------------------------------------------------------------------

const SCHEMA = `CREATE TABLE a (id INT NOT NULL, c INT, PRIMARY KEY (id));
CREATE TABLE b (id bigint NOT NULL, name varchar(30) NULL)
GO
CREATE TABLE d (id bigint NOT NULL)
GO
ALTER TABLE a MODIFY c BIGINT;
ALTER TABLE a ADD INDEX ic (c);
`;

function analyzeOnce(repo, out, home) {
  const r = spawnSync(process.execPath, [CLI, 'analyze', '--root', repo, '--out', out, '--project', 'c5', '--ddl', path.join(repo, 'schema.sql')], {
    encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, XDG_CACHE_HOME: path.join(home, 'cache'), CASCADE_HOME: path.join(home, 'home') },
  });
  assert.equal(r.status, 0, r.stderr);
  return { pack: JSON.parse(fs.readFileSync(path.join(out, 'pack.json'), 'utf8')), stderr: r.stderr };
}

test('a catalog read back from its cache still says what its reader could not read, and the run says it too', (t) => {
  if (!sqlLaneVenv().ok) { t.skip('no SQL lane interpreter: build one with `node bin/cascade.mjs setup`'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-c5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'schema.sql'), SCHEMA);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'c5', GIT_AUTHOR_EMAIL: 'c5@example.com', GIT_COMMITTER_NAME: 'c5', GIT_COMMITTER_EMAIL: 'c5@example.com' } });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'schema');
  const cold = analyzeOnce(repo, path.join(dir, 'out'), dir);
  const warm = analyzeOnce(repo, path.join(dir, 'out'), dir);
  assert.equal(warm.pack.meta.incremental.catalogReused, true, 'the second run read the catalog from its cache, not from the reader');
  const cat = cold.pack.meta.laneStats.catalog;
  assert.deepEqual(cat.gaps, { 'catalog-tables-unread': 2, 'catalog-rules-assumed': 1 });
  assert.deepEqual(cat.codes.find((c) => c.code === 'create_table_unreadable').tables, ['b', 'd']);
  assert.deepEqual(warm.pack.meta.laneStats.catalog, cat, 'the cache keeps what the reader said');
  const kinds = (p) => p.meta.diagnostics.filter((d) => d.kind.startsWith('CATALOG_')).map((d) => [d.kind, d.severity, d.count]);
  assert.deepEqual(kinds(cold.pack), [['CATALOG_CREATE_TABLE_UNREADABLE', 'warn', 2], ['CATALOG_RULE_ASSUMED', 'warn', 1], ['CATALOG_CLAUSE_NOT_HELD', 'warn', 1]]);
  assert.deepEqual(kinds(warm.pack), kinds(cold.pack));
  assert.equal(warm.pack.digest, cold.pack.digest);
  assert.match(warm.stderr, /\[warn\] CATALOG_CREATE_TABLE_UNREADABLE catalog: 2 CREATE TABLE statement\(s\) could not be read, so their tables are not in the catalog or are in it only in part \(b, d\)\./,
    'the run says it on a warm run too, where the reader did not run');
  // RM67-C6: the axis says it too, on both runs, and the overview names no fix for two causes at once.
  assert.deepEqual([cold.pack.meta.axes.catalog.status, cold.pack.meta.axes.catalog.causes], ['degraded', ['tables-unread', 'rules-assumed']]);
  assert.deepEqual(warm.pack.meta.axes.catalog, cold.pack.meta.axes.catalog);
});

test('a statement the grammar library fails on is named, and the run goes on to its pack', (t) => {
  // RM67-C6: MySQL's grammar raises AttributeError on SQL Server's ON [PRIMARY]; `cascade analyze` exited 1 with a stack trace.
  if (!sqlLaneVenv().ok) { t.skip('no SQL lane interpreter: build one with `node bin/cascade.mjs setup`'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-c6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'schema.sql'), 'CREATE TABLE a (id INT NOT NULL, PRIMARY KEY (id));\nCREATE TABLE [dbo].[b] ([id] bigint NOT NULL) ON [PRIMARY];\n');
  const { pack, stderr } = analyzeOnce(repo, path.join(dir, 'out'), dir);
  assert.equal(/Traceback/.test(stderr), false, stderr);
  assert.ok(pack.nodes.some((n) => n.id === 'table:a' && !n.stub), 'the table the grammar read is in the catalog');
  const cat = pack.meta.laneStats.catalog;
  assert.deepEqual(cat.codes.find((c) => c.code === 'create_table_unreadable').tables, ['[dbo].[b]']);
  // The sentence names the AttributeError (adapters/sql/test_catalog_ddl.py holds it whole); the pack keeps its first 300 characters.
  assert.deepEqual(cat.codes.filter((c) => c.code.startsWith('parse_error')).map((c) => [c.code, c.level, c.gap]), [['parse_error_not_held', 'info', null]]);
  assert.equal(pack.meta.axes.catalog.status, 'degraded');
});
