// identifier_case.test.mjs — the declared SQL identity rule, and the gate that
// keeps its two implementations from drifting apart (SPEC §8.1, §12).
//
// The rule lives twice on purpose: `src/core/identifier_case.mjs` decides which
// node id a table fact lands on, and `adapters/sql/identifier_case.py` decides
// which catalog table a statement's `FROM ITEM` means. If they ever disagreed,
// a graph built by the bridge and a graph built from the worker's own output
// would carry the same table twice. So the last test here RUNS BOTH over the
// same inputs and compares — it is the only honest way to test a mirror.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DIALECT_IDENTIFIER_CASE, IDENTIFIER_CASES, DEFAULT_IDENTIFIER_CASE,
  foldIdentifier, identifierCaseForDialect, IdentifierCaseError,
} from '../src/core/identifier_case.mjs';
import {
  buildGraphFromSql, catalogIdentity, foldedKey,
} from '../src/adapters/sql_bridge.mjs';
import { normalizeProfile, sqlIdentifierCaseOf, ProfileError, validateProfile } from '../src/core/profile.mjs';

const ENGINE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const VENV_PY = path.join(ENGINE_ROOT, '.venv', 'bin', 'python');
const PY_MODULE_DIR = path.join(ENGINE_ROOT, 'adapters', 'sql');

// --------------------------------------------------------------------------
// The table itself — one row per database, each row the documented behaviour.
// --------------------------------------------------------------------------

test('the fold table states the rule each database documents, and nothing else', () => {
  assert.equal(identifierCaseForDialect('mysql'), 'fold-lower');
  assert.equal(identifierCaseForDialect('mariadb'), 'fold-lower');
  assert.equal(identifierCaseForDialect('postgres'), 'fold-lower');
  assert.equal(identifierCaseForDialect('postgresql'), 'fold-lower');
  assert.equal(identifierCaseForDialect('oracle'), 'fold-upper');
  assert.equal(identifierCaseForDialect('oracle-11g'), 'fold-upper');
  assert.equal(identifierCaseForDialect('oracle-19c'), 'fold-upper');
  assert.equal(identifierCaseForDialect('hsqldb'), 'fold-upper');
  assert.equal(identifierCaseForDialect('h2'), 'fold-upper');
  // A dialect the table does not name folds NOTHING — folding when the database
  // does not would merge two genuinely different tables, so it fails closed.
  assert.equal(identifierCaseForDialect('db2'), 'exact');
  assert.equal(identifierCaseForDialect(null), 'exact');
  assert.equal(identifierCaseForDialect(''), 'exact');
  assert.equal(DEFAULT_IDENTIFIER_CASE, 'exact');
  // Every value in the table is one of the three rules.
  for (const [name, rule] of Object.entries(DIALECT_IDENTIFIER_CASE)) {
    assert.ok(IDENTIFIER_CASES.includes(rule), `${name} -> ${rule}`);
  }
});

test('foldIdentifier folds ASCII only, in the declared direction', () => {
  assert.equal(foldIdentifier('Item', 'fold-lower'), 'item');
  assert.equal(foldIdentifier('Item', 'fold-upper'), 'ITEM');
  assert.equal(foldIdentifier('Item', 'exact'), 'Item');
  assert.equal(foldIdentifier('T_1_x', 'fold-upper'), 'T_1_X');
  assert.equal(foldIdentifier(null, 'fold-lower'), null);
  // Non-ASCII is matched exactly: the fold has a Python mirror, and the two
  // languages do not agree on locale-sensitive case rules (the dotless i).
  assert.equal(foldIdentifier('ß', 'fold-upper'), 'ß');
  assert.equal(foldIdentifier('İstanbul', 'fold-upper'), 'İSTANBUL');
  assert.throws(() => foldIdentifier('x', 'lower'), (e) => e instanceof IdentifierCaseError);
});

test('foldedKey folds each part of a key and keeps the separators', () => {
  assert.equal(foldedKey('PMS_Product', 'fold-lower'), 'pms_product');
  assert.equal(foldedKey('Shop.PMS_Product', 'fold-lower'), 'shop.pms_product');
  assert.equal(foldedKey('shop.pms_product.Price', 'fold-upper'), 'SHOP.PMS_PRODUCT.PRICE');
  assert.equal(foldedKey('Shop.Pms', 'exact'), 'Shop.Pms');
});

// --------------------------------------------------------------------------
// The profile key
// --------------------------------------------------------------------------

test('sqlIdentifierCase: null takes the dialect rule, a value overrides it', () => {
  assert.equal(sqlIdentifierCaseOf(normalizeProfile({})), 'fold-lower');            // mysql assumed
  assert.equal(sqlIdentifierCaseOf(normalizeProfile({ sqlDialects: { main: 'oracle' } })), 'fold-upper');
  assert.equal(sqlIdentifierCaseOf(normalizeProfile({ sqlDialects: { main: 'hsqldb' } })), 'fold-upper');
  assert.equal(
    sqlIdentifierCaseOf(normalizeProfile({ sqlDialects: { main: 'oracle' }, sqlIdentifierCase: 'exact' })),
    'exact',
  );
  assert.equal(
    sqlIdentifierCaseOf(normalizeProfile({ sqlDialects: { main: 'mysql' }, sqlIdentifierCase: 'fold-upper' })),
    'fold-upper',
  );
  // A value outside the three rules is refused, in validation and at use.
  assert.throws(() => validateProfile({ sqlIdentifierCase: 'lower' }), (e) => e instanceof ProfileError);
  assert.throws(() => sqlIdentifierCaseOf({ sqlIdentifierCase: 'lower' }), (e) => e instanceof ProfileError);
  assert.equal(validateProfile({ sqlIdentifierCase: null }).sqlIdentifierCase, null);
});

// --------------------------------------------------------------------------
// The bridge: one node per table, named the way the catalog declared it.
// --------------------------------------------------------------------------

const catalog = () => [
  { kind: 'header', schema: 'cascade:catalog-snapshot:1' },
  { kind: 'table', schema: null, table: 'pms_product', comment: 'product' },
  { kind: 'column', schema: null, table: 'pms_product', column: 'id', type: 'BIGINT', ordinal: 1 },
  { kind: 'column', schema: null, table: 'pms_product', column: 'price', type: 'DECIMAL(10,2)', ordinal: 2 },
];

/** A lineage record naming the table and column the way an UPPER-CASE mapper would. */
const lineage = (table, column) => [
  { kind: 'header', schema: 'cascade:sqlfacts:1' },
  {
    kind: 'lineage',
    namespace: 'ns',
    id: 'getProduct',
    type: 'select',
    tables: [{ schema: null, table, access: 'read' }],
    columns: [{ schema: null, table, column, access: 'read' }],
    joins: [],
    unresolved: [],
    file: 'ProductMapper.xml',
    line: 1,
  },
];

test('bridge: a differently-cased lineage name lands on the catalog node, keeping its spelling', () => {
  const g = buildGraphFromSql(catalog(), lineage('PMS_PRODUCT', 'PRICE'), { identifierCase: 'fold-lower' });
  const tables = [...g.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id);
  const columns = [...g.nodes.values()].filter((n) => n.kind === 'column').map((n) => n.id);
  // ONE table, named as the catalog declares it — not `PMS_PRODUCT`.
  assert.deepEqual(tables, ['table:pms_product']);
  assert.deepEqual(columns.sort(), ['column:pms_product.id', 'column:pms_product.price']);
  assert.deepEqual(
    g.edges.filter((e) => e.type === 'READS').map((e) => e.to),
    ['column:pms_product.price'],
  );
  assert.deepEqual(
    g.edges.filter((e) => e.type === 'EXECUTES').map((e) => e.to),
    ['table:pms_product'],
  );
});

test('bridge: without a fold the same records build the split graph the defect produced', () => {
  const g = buildGraphFromSql(catalog(), lineage('PMS_PRODUCT', 'PRICE'));  // default: exact
  const tables = [...g.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id).sort();
  assert.deepEqual(tables, ['table:PMS_PRODUCT', 'table:pms_product']);
  assert.equal(g.nodes.get('table:PMS_PRODUCT').stub, true);
});

test('bridge: a name the catalog really does NOT have stays unresolved, folded or not', () => {
  // Folding must reduce the split because the names MATCH — never because the
  // comparison got loose. `pms_produkt` is a different table and stays one.
  const g = buildGraphFromSql(catalog(), lineage('PMS_PRODUKT', 'PRICE'), { identifierCase: 'fold-lower' });
  const tables = [...g.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id).sort();
  // And the stub keeps the spelling the STATEMENT used — the bridge folds to
  // find the catalog's node, it never renames a name it could not find.
  assert.deepEqual(tables, ['table:PMS_PRODUKT', 'table:pms_product']);
  assert.equal(g.nodes.get('table:PMS_PRODUKT').stub, true);
});

test('bridge: two catalog spellings that fold together are REPORTED, not merged in silence', () => {
  const twoSpellings = [
    { kind: 'table', schema: null, table: 'Item', comment: null },
    { kind: 'column', schema: null, table: 'Item', column: 'Id', type: 'INT', ordinal: 1 },
    { kind: 'table', schema: null, table: 'ITEM', comment: null },
    { kind: 'column', schema: null, table: 'ITEM', column: 'ID', type: 'INT', ordinal: 1 },
  ];
  // Under an EXACT rule they are two tables, which is what such a schema means
  // in a case-sensitive database — no collision to report.
  const exact = catalogIdentity(twoSpellings, 'exact');
  assert.deepEqual(exact.collisions, []);
  assert.equal(exact.tables.size, 2);
  // Under a folding rule they collide. The first declaration keeps the key and
  // the second is named in a collision the caller can print.
  const folded = catalogIdentity(twoSpellings, 'fold-upper');
  assert.deepEqual(folded.collisions, [
    { kind: 'table', key: 'ITEM', kept: 'Item', dropped: 'ITEM' },
    { kind: 'column', key: 'ITEM.ID', kept: 'Item.Id', dropped: 'ITEM.ID' },
  ]);
  assert.equal(folded.tables.size, 1);
  // Both declared tables are still NODES — the catalog is carried as declared;
  // it is the MATCHING that collapses, and that is what gets reported.
  const g = buildGraphFromSql(twoSpellings, [], { identifierCase: 'fold-upper' });
  assert.deepEqual(
    [...g.nodes.values()].filter((n) => n.kind === 'table').map((n) => n.id).sort(),
    ['table:ITEM', 'table:Item'],
  );
});

// --------------------------------------------------------------------------
// The mirror gate: both implementations, same inputs, same answers.
// --------------------------------------------------------------------------

test('the JavaScript and Python folds agree on every input, rule by rule', (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY} (see docs/setup/sql-lane.md)`); return; }

  const names = [
    'item', 'ITEM', 'Item', 'pms_product', 'PMS_PRODUCT', 'Pms_Product',
    'T_1_x', '_leading', 'trailing_', 'a', 'A', '', 'MiXeD123', 'ß', 'İstanbul',
    'İSTANBUL', 'Ωμέγα', 'Été', 'order#1', 'a.b',
  ];
  const dialects = ['mysql', 'mariadb', 'postgres', 'postgresql', 'oracle',
    'oracle-11g', 'oracle-19c', 'hsqldb', 'h2', 'db2', ''];

  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from identifier_case import fold_identifier, identifier_case_for_dialect',
    'names, dialects, cases = json.loads(sys.argv[2])',
    'print(json.dumps({',
    '  "folds": {c: [fold_identifier(n, c) for n in names] for c in cases},',
    '  "dialects": {d: identifier_case_for_dialect(d) for d in dialects},',
    '}))',
  ].join('\n');
  const r = spawnSync(VENV_PY, ['-c', script, PY_MODULE_DIR, JSON.stringify([names, dialects, IDENTIFIER_CASES])],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);

  for (const rule of IDENTIFIER_CASES) {
    assert.deepEqual(names.map((n) => foldIdentifier(n, rule)), py.folds[rule],
      `the two folds disagree under ${rule}`);
  }
  for (const d of dialects) {
    assert.equal(identifierCaseForDialect(d), py.dialects[d], `the two tables disagree on dialect ${JSON.stringify(d)}`);
  }
});

test('the worker keeps a QUOTED identifier exact even under a folding rule', (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY} (see docs/setup/sql-lane.md)`); return; }

  // The catalog declares `item`. Under fold-upper an UNQUOTED `ITEM` is the same
  // table; a QUOTED `"ITEM"` is not — a quoted identifier is exact in every
  // dialect this engine knows, and a database would reject it here.
  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import lineage',
    'cat = [',
    '  {"kind": "table", "schema": None, "table": "item"},',
    '  {"kind": "column", "schema": None, "table": "item", "column": "listprice", "type": "DECIMAL", "ordinal": 1},',
    ']',
    'idx = lineage.build_schema_index(cat, "fold-upper")',
    'out = {}',
    'for label, sql in [("unquoted", "SELECT LISTPRICE FROM ITEM"),',
    '                   ("quoted-declared", \'SELECT "listprice" FROM "item"\'),',
    '                   ("quoted-star", \'SELECT * FROM "item"\'),',
    '                   ("quoted-other-case", \'SELECT "LISTPRICE" FROM "ITEM"\')]:',
    '    r = lineage.analyze_statement(sql, "select", idx, dialect="")',
    '    out[label] = {"tables": r["tables"], "columns": r["columns"],',
    '                  "unresolved": [u["reason"] for u in r["unresolved"]]}',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(VENV_PY, ['-c', script, PY_MODULE_DIR], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);

  // Unquoted: folds, matches, and is emitted with the CATALOG's spelling.
  assert.deepEqual(out.unquoted.tables, [{ table: 'item', access: 'read' }]);
  assert.deepEqual(out.unquoted.columns, [{ table: 'item', column: 'listprice', access: 'read' }]);
  assert.deepEqual(out.unquoted.unresolved, []);
  // Quoted with the spelling the catalog declares: exact match, same answer.
  assert.deepEqual(out['quoted-declared'].tables, [{ table: 'item', access: 'read' }]);
  assert.deepEqual(out['quoted-declared'].columns, [{ table: 'item', column: 'listprice', access: 'read' }]);
  assert.deepEqual(out['quoted-declared'].unresolved, []);
  // And a quoted table still gets its star expanded from the catalog.
  assert.deepEqual(out['quoted-star'].columns, [{ table: 'item', column: 'listprice', access: 'read' }]);
  assert.deepEqual(out['quoted-star'].unresolved, []);
  // Quoted in another case: NOT the same object. It stays the statement's own
  // spelling and is filed as a miss rather than folded onto `item` — which is
  // what the database would do too, since `"ITEM"` is not a table it has.
  assert.deepEqual(out['quoted-other-case'].tables, [{ table: 'ITEM', access: 'read' }]);
  assert.deepEqual(out['quoted-other-case'].columns, []);
  assert.deepEqual(out['quoted-other-case'].unresolved, ['table_not_in_catalog']);
});

test('the worker reports a folded catalog collision as a diagnostic', (t) => {
  if (!fs.existsSync(VENV_PY)) { t.skip(`no venv python at ${VENV_PY} (see docs/setup/sql-lane.md)`); return; }

  const script = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import lineage',
    'cat = [',
    '  {"kind": "table", "schema": None, "table": "Item"},',
    '  {"kind": "column", "schema": None, "table": "Item", "column": "id", "type": "INT", "ordinal": 1},',
    '  {"kind": "table", "schema": None, "table": "ITEM"},',
    '  {"kind": "column", "schema": None, "table": "ITEM", "column": "id", "type": "INT", "ordinal": 1},',
    ']',
    'diags = []',
    'folded = lineage.build_schema_index(cat, "fold-upper", diagnostics=diags)',
    'exact_diags = []',
    'exact = lineage.build_schema_index(cat, "exact", diagnostics=exact_diags)',
    'print(json.dumps({"folded": folded["collisions"], "diags": diags,',
    '                  "foldedTables": sorted(folded["tables"]),',
    '                  "exact": exact["collisions"], "exactDiags": exact_diags,',
    '                  "exactTables": sorted(exact["tables"])}))',
  ].join('\n');
  const r = spawnSync(VENV_PY, ['-c', script, PY_MODULE_DIR], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);

  assert.deepEqual(out.folded, [{ kind: 'table', key: 'ITEM', kept: 'Item', dropped: 'ITEM' }]);
  assert.equal(out.diags.length, 1);
  assert.equal(out.diags[0].code, 'folded_identifier_collision');
  assert.equal(out.diags[0].level, 'warn');
  assert.match(out.diags[0].message, /'Item' and 'ITEM' both fold to 'ITEM'/);
  assert.match(out.diags[0].message, /the first declaration is kept and the second is NOT merged into it/);
  assert.deepEqual(out.foldedTables, ['ITEM']);
  // Under the exact rule the same catalog is simply two tables — no collision.
  assert.deepEqual(out.exact, []);
  assert.deepEqual(out.exactDiags, []);
  assert.deepEqual(out.exactTables, ['ITEM', 'Item']);
});
