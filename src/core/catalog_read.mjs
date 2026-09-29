// catalog_read.mjs — what the schema reader could not read, or had to assume, as the pack carries it (RM67-C5).
//
// WHY. catalog_ddl.py names every table it could not read and every rule of a
// database it had to assume, and it said so on stderr only. The pack never held
// it, so the overview, the viewer and every MCP answer showed a catalog read
// whole where tables were missing: ruoyi-vue-pro's SQL Server schema, read with
// MySQL's grammar, gave 0 of its 60 tables and nothing on any page said so. The
// reader's header carries the list now (catalog-ddl/12), so a catalog read back
// from its cache says it too; this groups it by code, with counts and the first
// examples, because one schema can give hundreds.
//
// Pure: the catalog records in, the lane block and the run's diagnostics out.

/** How many sentences and table names one code keeps, and how long a sentence may be. */
const EXAMPLES = 5;
const TABLES_NAMED = 10;
const EXAMPLE_CHARS = 300;

/**
 * PER READER CODE (adapters/sql/catalog_ddl.py): the kind the run's diagnostics
 * say it under, the gap of the overview it counts into, the setting the
 * diagnostic is about, and what one of it means, read after a count. A gap of
 * null is a note the catalog loses nothing by: a clause that changes nothing the
 * catalog holds, or a table read with something set aside and said. Every code
 * the reader can say is here (test/catalog_read.test.mjs reads its source).
 */
export const CATALOG_CODES = Object.freeze({
  create_table_unreadable: {
    kind: 'CATALOG_CREATE_TABLE_UNREADABLE', gap: 'catalog-tables-unread', key: 'catalog',
    what: 'CREATE TABLE statement(s) could not be read, so their tables are not in the catalog or are in it only in part',
  },
  create_table_unread: {
    kind: 'CATALOG_CREATE_TABLE_UNREAD', gap: 'catalog-tables-unread', key: 'catalog',
    what: 'CREATE TABLE statement(s) were read only as part of another statement, so their tables are not in the catalog',
  },
  unnamed_table: {
    kind: 'CATALOG_TABLE_UNNAMED', gap: 'catalog-tables-unread', key: 'catalog',
    what: 'CREATE TABLE statement(s) have no name this reader could read, so their tables are not in the catalog',
  },
  table_read_failed: {
    kind: 'CATALOG_TABLE_READ_FAILED', gap: 'catalog-tables-unread', key: 'catalog',
    what: 'table declaration(s) failed to read, so their tables are not in the catalog',
  },
  alter_rule_assumed: {
    kind: 'CATALOG_RULE_ASSUMED', gap: 'catalog-rules-assumed', key: 'sqlDialects',
    what: 'conclusion(s) rest on a rule of a database this run assumed, because sqlDialects.main is not declared',
  },
  column_unnamed: {
    kind: 'CATALOG_COLUMN_UNNAMED', gap: 'catalog-read-in-part', key: 'sqlDialects',
    what: 'column(s) have no name as this grammar reads them, so they are left out; a quoted name read by the wrong grammar does this, so check sqlDialects.main',
  },
  column_read_failed: {
    kind: 'CATALOG_COLUMN_READ_FAILED', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'column(s) failed to read, so they are not in the catalog',
  },
  create_parent_unknown: {
    kind: 'CATALOG_PARENT_TABLE_UNKNOWN', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'table(s) inherit from a table no file declared before them, so the columns they inherit are not in the catalog',
  },
  DUPLICATE_TABLE_DECLARATION: {
    kind: 'CATALOG_TABLE_DECLARED_TWICE', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'table(s) are declared twice, or renamed onto a table that exists; the first is kept and nothing is merged',
  },
  duplicate_column: {
    kind: 'CATALOG_COLUMN_ADDED_TWICE', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'column(s) are added where the table already has them; the first is kept',
  },
  token_error: {
    kind: 'CATALOG_FILE_NOT_TOKENIZED', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'file(s) could not be split into tokens as a whole, and were read another way',
  },
  parse_error: {
    kind: 'CATALOG_FILE_NOT_PARSED', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'file(s) failed to parse as a whole, and were read with errors ignored; what they could not read holds an ALTER or a RENAME, or the reader could not tell where it stopped',
  },
  alter_unreadable: {
    kind: 'CATALOG_ALTER_UNREADABLE', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER or RENAME statement(s) could not be read, so what they change is not in the catalog',
  },
  alter_read_failed: {
    kind: 'CATALOG_ALTER_TABLE_UNNAMED', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER statement(s) name no table this reader could read, and were ignored',
  },
  alter_unknown_table: {
    kind: 'CATALOG_ALTER_UNKNOWN_TABLE', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER or RENAME statement(s) change a table no file declared before them, and were ignored',
  },
  alter_unknown_column: {
    kind: 'CATALOG_ALTER_UNKNOWN_COLUMN', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER clause(s) change a column the table does not have as read here',
  },
  alter_primary_key_unknown: {
    kind: 'CATALOG_PRIMARY_KEY_UNKNOWN', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER clause(s) may change a primary key in a way this reader cannot tell, so the key it kept may not be the one the files leave',
  },
  alter_primary_key_not_null: {
    kind: 'CATALOG_PRIMARY_KEY_KEPT_NOT_NULL', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER clause(s) let a primary key column hold NULL, which a key cannot; the column is kept NOT NULL',
  },
  alter_primary_key_replaced: {
    kind: 'CATALOG_PRIMARY_KEY_REPLACED', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'ALTER clause(s) add a primary key to a table that has one as read here, so a drop this reader did not see is taken to have come first',
  },
  alter_modify_unsaid_unknown: {
    kind: 'CATALOG_MODIFY_UNSAID_UNKNOWN', gap: 'catalog-read-in-part', key: 'catalog',
    what: 'MODIFY clause(s) leave out part of a column, and whether the database keeps it is not known here; it is kept',
  },
  alter_clause_unsupported: {
    kind: 'CATALOG_CLAUSE_NOT_HELD', gap: null, key: 'catalog',
    what: 'ALTER clause(s) change nothing the catalog holds (an index, a foreign key, a default), and were not applied',
  },
  // RM67-C6: a parse that stopped only in statements that declare and change no
  // table, and IF EXISTS on a column that is not there, cost the catalog nothing.
  parse_error_not_held: {
    kind: 'CATALOG_FILE_PART_NOT_HELD', gap: null, key: 'catalog',
    what: 'file(s) failed to parse as a whole and were read with errors ignored, but what they could not read declares and changes no table, except a CREATE TABLE named on its own, so the catalog may have lost nothing by it',
  },
  alter_if_exists_absent: {
    kind: 'CATALOG_IF_EXISTS_ABSENT', gap: null, key: 'catalog',
    what: 'ALTER clause(s) with IF EXISTS name a column the table does not have as read here, so nothing changes, as in the database',
  },
  create_clause_not_held: {
    kind: 'CATALOG_CREATE_CLAUSE_NOT_HELD', gap: null, key: 'catalog',
    what: 'CREATE TABLE statement(s) were read without a part the catalog does not hold, which was set aside',
  },
  create_constraint_disabled: {
    kind: 'CATALOG_CONSTRAINT_DISABLED', gap: null, key: 'catalog',
    what: 'constraint(s) are declared disabled, so they are not enforced and not read',
  },
  create_read_in_mode: {
    kind: 'CATALOG_READ_IN_MODE', gap: null, key: 'catalog',
    what: 'CREATE TABLE statement(s) are written for another database, and were read as the database reads them in its compatibility mode',
  },
  alter_primary_key_by_convention: {
    kind: 'CATALOG_PRIMARY_KEY_BY_CONVENTION', gap: null, key: 'catalog',
    what: 'ALTER clause(s) drop a primary key named by the database\'s own convention, and are read that way',
  },
});

/** A code this table does not know: still said, and counted where it may have cost something. */
const OTHER = Object.freeze({
  kind: 'CATALOG_OTHER_NOTE', key: 'catalog', what: 'note(s) of a kind this engine does not know yet',
});
const RANK = Object.freeze({ info: 0, warn: 1, error: 2 });
const ORDER = Object.keys(CATALOG_CODES);

/** One code's entry, the table's or the unknown one's, with the gap an unknown one counts into. */
function codeEntry(code, level) {
  if (Object.hasOwn(CATALOG_CODES, code)) return CATALOG_CODES[code];
  return { ...OTHER, gap: (RANK[level] ?? 1) > 0 ? 'catalog-read-in-part' : null };
}

/** A sentence the reader wrote for a terminal, as one plain line: no escape codes, no control characters. */
export function plainSentence(text) {
  // eslint-disable-next-line no-control-regex
  const plain = String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return plain.length <= EXAMPLE_CHARS ? plain : `${plain.slice(0, EXAMPLE_CHARS - 3)}...`;
}

/** Fold one diagnostic into its code's group. */
function addTo(groups, d) {
  const code = String(d.code ?? '');
  const level = RANK[d.level] !== undefined ? d.level : 'warn';
  let g = groups.get(code);
  if (!g) {
    g = { code, level, count: 0, names: new Set(), examples: [] };
    groups.set(code, g);
  }
  g.count += 1;
  if ((RANK[level] ?? 1) > (RANK[g.level] ?? 1)) g.level = level;
  if (typeof d.table === 'string' && d.table !== '') g.names.add(d.table);
  if (g.examples.length < EXAMPLES) g.examples.push(plainSentence(d.message));
}

/** A group as the pack keeps it. */
function codeBlock(g) {
  const e = codeEntry(g.code, g.level);
  const names = [...g.names];
  return {
    code: g.code, kind: e.kind, level: g.level, gap: e.gap, count: g.count,
    tables: names.slice(0, TABLES_NAMED), tablesNamed: names.length, examples: g.examples,
  };
}

/** The table's order, then an unknown code by name. */
function byTableOrder(a, b) {
  const ia = ORDER.indexOf(a.code);
  const ib = ORDER.indexOf(b.code);
  if (ia !== ib) return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * THE CATALOG LANE'S BLOCK (laneStats.catalog): what the reader said, one entry
 * per code in the order the table names them, each with how many times, the
 * tables it named and the first sentences in full, and how many count into each
 * gap. Null when there is no header or the header carries no list: a pinned
 * snapshot, or a reader from before the list was kept, said nothing this run can
 * see, which is not "nothing".
 * @param {object[]} records  the catalog records, header first
 * @returns {{reader:string|null, said:number, gaps:Object<string,number>, codes:object[]}|null}
 */
export function catalogReadStats(records) {
  const header = (Array.isArray(records) ? records : []).find((r) => r && r.kind === 'header');
  if (!header || !Array.isArray(header.diagnostics)) return null;
  const groups = new Map();
  for (const d of header.diagnostics) if (d && typeof d === 'object') addTo(groups, d);
  const codes = [...groups.values()].map(codeBlock).sort(byTableOrder);
  const gaps = {};
  for (const c of codes) if (c.gap) gaps[c.gap] = (gaps[c.gap] ?? 0) + c.count;
  return { reader: typeof header.version === 'string' ? header.version : null, said: header.diagnostics.length, gaps, codes };
}

/** "a, b, c, and 7 more", or '' when the code named no table. */
export function namedTables(c, shown = 3) {
  const first = (c.tables ?? []).slice(0, shown);
  if (first.length === 0) return '';
  const more = (c.tablesNamed ?? first.length) - first.length;
  return more > 0 ? `${first.join(', ')}, and ${more} more` : first.join(', ');
}

/**
 * WHAT DEGRADES THE CATALOG AXIS (RM67-C6): tables the reader lost, and rules of
 * a database it assumed. A table read in part is a gap of the overview and
 * leaves the axis whole; the causes are what src/core/remedies.mjs keys a fix on.
 */
const AXIS_CAUSES = Object.freeze([
  {
    cause: 'tables-unread', gap: 'catalog-tables-unread',
    reason: (n, named) => `${n} table(s) the schema files declare are not in the catalog, or are in it only in part, because the schema reader could not read their CREATE TABLE${named}. `
      + 'A statement that names one still reaches a table of that name, with only the columns it names; the list is on meta.laneStats.catalog',
  },
  {
    cause: 'rules-assumed', gap: 'catalog-rules-assumed',
    reason: (n) => `${n} conclusion(s) about the schema rest on a rule of a database this run assumed, because sqlDialects.main is not declared`,
  },
]);

/** The causes the catalog axis is degraded by, each with its sentence; none when the reader lost nothing, or kept no list. */
export function catalogAxisCauses(stats) {
  const gaps = stats?.gaps ?? {};
  return AXIS_CAUSES.filter((c) => (gaps[c.gap] ?? 0) > 0).map((c) => {
    const names = [...new Set(stats.codes.filter((x) => x.gap === c.gap).flatMap((x) => x.tables ?? []))].slice(0, 3);
    return { cause: c.cause, reason: c.reason(gaps[c.gap], names.length > 0 ? `, among them ${names.join(', ')}` : '') };
  });
}

/** One code's sentence: how many, what one means, which tables, and the first as the reader said it. */
function reasonOf(c) {
  const e = codeEntry(c.code, c.level);
  const tables = namedTables(c);
  return `${c.count} ${e.what}${tables ? ` (${tables})` : ''}. The first, as the schema reader said it: ${c.examples[0] ?? '(no sentence)'}`;
}

/**
 * THE RUN'S DIAGNOSTICS, one per code with its count and first examples, so a
 * schema that gives three hundred of one is one line with its count, not three
 * hundred lines.
 * @param {ReturnType<typeof catalogReadStats>} stats
 * @returns {{kind:string, severity:string, key:string, reason:string, count:number, examples:string[]}[]}
 */
export function catalogDiagnostics(stats) {
  return (stats?.codes ?? []).map((c) => ({
    kind: c.kind, severity: c.level, key: codeEntry(c.code, c.level).key, reason: reasonOf(c),
    count: c.count, examples: c.examples,
  }));
}
