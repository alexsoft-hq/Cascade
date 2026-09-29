#!/usr/bin/env python3
"""Unit tests for adapters/sql/catalog_ddl.py (parse_ddl_catalog).

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_catalog_ddl -v
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import catalog_ddl  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures — small inline MySQL DDL strings, no dependency on mall.sql.
# ---------------------------------------------------------------------------

BASIC_DDL = """
CREATE TABLE `pms_product` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `product_sn` varchar(64) NOT NULL COMMENT 'Product code (SKU) — unique',
  `price` decimal(10,2) NULL DEFAULT NULL COMMENT 'Unit price in €',
  `delete_status` int(1) NULL DEFAULT NULL COMMENT 'Deletion status — 0/1',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='Product master — catalogue';
"""

MULTI_TABLE_DDL = """
CREATE TABLE `zebra_table` (
  `z_id` int(11) NOT NULL,
  `z_name` varchar(20) NULL
);
CREATE TABLE `alpha_table` (
  `a_id` int(11) NOT NULL
);
"""

NO_NULL_CONSTRAINT_DDL = """
CREATE TABLE `plain_table` (
  `has_default_nullable` varchar(20)
);
"""

NON_CREATE_TRAILER_DDL = """
CREATE TABLE `only_table` (
  `id` int(11) NOT NULL
);
SELECT 1;
INSERT INTO only_table VALUES (1);
"""

# A statement that fails to parse (forcing the salvage/error_level=IGNORE path)
# followed by a CREATE TABLE with no readable name, sandwiched between two
# valid tables. Exercises both the "parse_error" and "unnamed_table"
# diagnostic codes while still salvaging the good tables.
MALFORMED_DDL = """
CREATE TABLE `good_table` (
  `id` int(11) NOT NULL
);
CREATE TABLE (();;garbage!!!;
CREATE TABLE `other_table` (
  `id` int(11) NOT NULL
);
"""

# A file written for PostgreSQL, read as MySQL: the backslash that ends 'C:\' escapes
# the closing quote in MySQL, every quote after it is out of step, and the tokenizer
# reads B', ' as a bit string and gives up on the WHOLE file. Read with backslash
# escapes off, as MySQL reads under NO_BACKSLASH_ESCAPES, it is whole again.
POSTGRES_QUOTED_DDL = r"""
CREATE TABLE `before_dump` (
  `id` int(11) NOT NULL
);
INSERT INTO before_dump VALUES (1, 'C:\', 'B', 'x');
INSERT INTO before_dump (id, path) VALUES (2, '
hello; /* seed */ -- batch 1
CREATE TABLE phantom (id int);
--');
CREATE TABLE `after_dump` (
  `id` int(11) NOT NULL
);
"""

# The same file edited by hand in MySQL's quoting too ('don\'t'): neither string rule
# can read it whole, so it is read one statement at a time. The data statements and
# the table on either side of them are how a schema file with a data dump looks.
UNTOKENIZABLE_DUMP_DDL = r"""
CREATE TABLE `before_dump` (
  `id` int(11) NOT NULL
);
INSERT INTO before_dump VALUES (1, 'C:\', 'B', 'x');
INSERT INTO before_dump VALUES (2, 'don\'t', 'B', 'x');
CREATE TABLE `after_dump` (
  `id` int(11) NOT NULL
);
"""

# The same miscount inside a CREATE TABLE: that one table cannot be read, and the
# diagnostic names it rather than letting it vanish from the catalog.
UNTOKENIZABLE_CREATE_DDL = r"""
CREATE TABLE `good_one` (
  `id` int(11) NOT NULL
);
INSERT INTO good_one VALUES ('don\'t');
CREATE TABLE `broken_one` (`path` varchar(10) DEFAULT 'C:\', `flag` varchar(1) DEFAULT 'B');
CREATE TABLE `good_two` (
  `id` int(11) NOT NULL
);
"""


def _dumps(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class HeaderRecordTests(unittest.TestCase):
    def test_header_is_first_record(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.assertEqual(recs[0]["kind"], "header")

    def test_header_schema_is_catalog_schema_constant(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.assertEqual(recs[0]["schema"], "cascade:catalog-snapshot:1")
        self.assertEqual(recs[0]["schema"], catalog_ddl.CATALOG_SCHEMA)

    def test_header_counts_match_fixture(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        header = recs[0]
        self.assertEqual(header["tables"], 1)
        self.assertEqual(header["columns"], 4)
        self.assertEqual(header["commented"], 3)

    def test_header_source_is_none_without_file(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.assertIsNone(recs[0]["source"])

    def test_header_dialect_is_mysql(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.assertEqual(recs[0]["dialect"], "mysql")

    def test_header_schema_field_unaffected_by_schema_arg(self):
        # The header's "schema" field always carries CATALOG_SCHEMA — it is not
        # the catalog namespace, unlike the schema= argument stamped on table
        # and column records.
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL, schema="mall")
        self.assertEqual(recs[0]["schema"], catalog_ddl.CATALOG_SCHEMA)


class TableRecordTests(unittest.TestCase):
    def test_table_record_kind_and_name(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        table_rec = recs[1]
        self.assertEqual(table_rec["kind"], "table")
        self.assertEqual(table_rec["table"], "pms_product")

    def test_table_comment_preserved(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        table_rec = recs[1]
        self.assertEqual(table_rec["comment"], "Product master — catalogue")


class ColumnRecordTests(unittest.TestCase):
    def setUp(self):
        self.recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        # header, table, then 4 columns in declaration order
        self.columns = self.recs[2:]

    def test_column_count_excludes_primary_key(self):
        # 4 columns declared; PRIMARY KEY (`id`) is a constraint, not a column.
        self.assertEqual(len(self.columns), 4)

    def test_columns_are_in_declaration_order(self):
        names = [c["column"] for c in self.columns]
        self.assertEqual(names, ["id", "product_sn", "price", "delete_status"])

    def test_ordinals_are_1_indexed_and_contiguous(self):
        ordinals = [c["ordinal"] for c in self.columns]
        self.assertEqual(ordinals, [1, 2, 3, 4])

    def test_primary_key_produces_no_column_record(self):
        names = [c["column"] for c in self.columns]
        self.assertNotIn("id_PRIMARY", names)
        # No stray record referencing the PRIMARY KEY constraint itself.
        for c in self.columns:
            self.assertNotEqual(c.get("column"), "PRIMARY")

    def test_column_record_has_expected_keys(self):
        expected_keys = {
            "kind", "schema", "table", "column", "type", "nullable",
            "comment", "ordinal", "pk",
        }
        for c in self.columns:
            self.assertEqual(set(c.keys()), expected_keys)
            self.assertEqual(c["kind"], "column")
            self.assertEqual(c["table"], "pms_product")
            self.assertIsInstance(c["pk"], bool)

    def test_primary_key_flagged(self):
        # A table-level PRIMARY KEY (id) marks exactly that column pk=True.
        by_col = {c["column"]: c for c in self.columns}
        self.assertTrue(by_col["id"]["pk"])
        for name, c in by_col.items():
            if name != "id":
                self.assertFalse(c["pk"], "%s should not be pk" % name)


class NamedConstraintPrimaryKeyTests(unittest.TestCase):
    """``CONSTRAINT <name> PRIMARY KEY (...)`` — the standard-SQL spelling.

    MySQL dumps normally write a bare ``PRIMARY KEY (id)``; HSQLDB, Oracle and
    PostgreSQL dumps normally NAME the constraint. sqlglot parses the named form
    into an ``exp.Constraint`` wrapping the ``exp.PrimaryKey``, and the parser
    used to look only for the bare node — so every column of every such table
    came back ``pk: false``, silently, and join cardinality could never be
    inferred for that schema (catalog-ddl/2 fixed it).
    """

    HSQLDB_DDL = """
    create table account (
        userid varchar(80) not null,
        email varchar(80) not null,
        constraint pk_account primary key (userid)
    );

    create table lineitem (
        orderid int not null,
        linenum int not null,
        itemid varchar(10) not null,
        constraint pk_lineitem primary key (orderid, linenum)
    );

    create table product (
        productid varchar(10) not null,
        category varchar(10) not null,
        constraint pk_product primary key (productid),
            constraint fk_product_1 foreign key (category)
            references category (catid)
    );
    """

    def cols(self, table):
        recs = catalog_ddl.parse_ddl_catalog(self.HSQLDB_DDL)
        return {c["column"]: c for c in recs
                if c["kind"] == "column" and c["table"] == table}

    def test_named_single_column_primary_key(self):
        by_col = self.cols("account")
        self.assertTrue(by_col["userid"]["pk"])
        self.assertFalse(by_col["email"]["pk"])

    def test_named_composite_primary_key_marks_every_member(self):
        by_col = self.cols("lineitem")
        self.assertTrue(by_col["orderid"]["pk"])
        self.assertTrue(by_col["linenum"]["pk"])
        self.assertFalse(by_col["itemid"]["pk"])

    def test_a_named_foreign_key_is_not_a_primary_key(self):
        # `product` names BOTH a pk and an fk constraint; only the pk counts.
        by_col = self.cols("product")
        self.assertTrue(by_col["productid"]["pk"])
        self.assertFalse(by_col["category"]["pk"])

    def test_a_named_constraint_is_not_a_column(self):
        recs = catalog_ddl.parse_ddl_catalog(self.HSQLDB_DDL)
        header = recs[0]
        self.assertEqual(header["tables"], 3)
        self.assertEqual(header["columns"], 2 + 3 + 2)

    def test_the_worker_version_says_which_generation_produced_this(self):
        # A shard key folds this string in, so a /2 shard can never be reused
        # for a /3 answer (SPEC §17.7).
        self.assertEqual(catalog_ddl.CATALOG_VERSION, "catalog-ddl/11")
        self.assertEqual(
            catalog_ddl.parse_ddl_catalog(self.HSQLDB_DDL)[0]["version"],
            "catalog-ddl/11",
        )


class NullabilityTests(unittest.TestCase):
    """The nullability trap: NOT NULL -> False; NULL / absent -> True."""

    def setUp(self):
        self.recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.by_name = {c["column"]: c for c in self.recs[2:]}

    def test_not_null_column_is_not_nullable(self):
        self.assertFalse(self.by_name["id"]["nullable"])
        self.assertFalse(self.by_name["product_sn"]["nullable"])

    def test_explicit_null_column_is_nullable(self):
        self.assertTrue(self.by_name["price"]["nullable"])
        self.assertTrue(self.by_name["delete_status"]["nullable"])

    def test_column_with_no_null_constraint_defaults_nullable(self):
        recs = catalog_ddl.parse_ddl_catalog(NO_NULL_CONSTRAINT_DDL)
        col = recs[2]
        self.assertEqual(col["column"], "has_default_nullable")
        self.assertTrue(col["nullable"])


class TypeNormalizationTests(unittest.TestCase):
    def setUp(self):
        self.recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.by_name = {c["column"]: c for c in self.recs[2:]}

    def test_bigint_display_width_stripped(self):
        self.assertEqual(self.by_name["id"]["type"], "BIGINT")

    def test_varchar_length_kept(self):
        self.assertEqual(self.by_name["product_sn"]["type"], "VARCHAR(64)")

    def test_decimal_precision_and_scale_kept(self):
        decimal_type = self.by_name["price"]["type"]
        self.assertIn("10", decimal_type)
        self.assertIn("2", decimal_type)

    def test_int_display_width_stripped(self):
        self.assertEqual(self.by_name["delete_status"]["type"], "INT")


class CommentTests(unittest.TestCase):
    def test_non_ascii_comments_preserved_exactly(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        by_name = {c["column"]: c for c in recs[2:]}
        self.assertEqual(by_name["product_sn"]["comment"], "Product code (SKU) — unique")
        self.assertEqual(by_name["price"]["comment"], "Unit price in €")
        self.assertEqual(by_name["delete_status"]["comment"], "Deletion status — 0/1")

    def test_column_without_comment_is_none(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        by_name = {c["column"]: c for c in recs[2:]}
        self.assertIsNone(by_name["id"]["comment"])

    def test_table_without_comment_is_none(self):
        recs = catalog_ddl.parse_ddl_catalog(NO_NULL_CONSTRAINT_DDL)
        table_rec = recs[1]
        self.assertIsNone(table_rec["comment"])


class SchemaArgTests(unittest.TestCase):
    def test_schema_arg_stamps_table_and_column_records(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL, schema="mall")
        table_rec = recs[1]
        self.assertEqual(table_rec["schema"], "mall")
        for col in recs[2:]:
            self.assertEqual(col["schema"], "mall")

    def test_schema_defaults_to_none(self):
        recs = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        table_rec = recs[1]
        self.assertIsNone(table_rec["schema"])
        for col in recs[2:]:
            self.assertIsNone(col["schema"])


class DeterminismTests(unittest.TestCase):
    def test_repeated_calls_return_equal_lists(self):
        r1 = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        r2 = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        self.assertEqual(r1, r2)

    def test_repeated_calls_produce_byte_identical_json(self):
        r1 = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        r2 = catalog_ddl.parse_ddl_catalog(BASIC_DDL)
        d1 = [_dumps(rec) for rec in r1]
        d2 = [_dumps(rec) for rec in r2]
        self.assertEqual(d1, d2)

    def test_determinism_holds_with_schema_and_multi_table_input(self):
        r1 = catalog_ddl.parse_ddl_catalog(MULTI_TABLE_DDL, schema="s")
        r2 = catalog_ddl.parse_ddl_catalog(MULTI_TABLE_DDL, schema="s")
        self.assertEqual([_dumps(rec) for rec in r1], [_dumps(rec) for rec in r2])


class RobustnessTests(unittest.TestCase):
    def test_non_create_table_statements_are_skipped(self):
        recs = catalog_ddl.parse_ddl_catalog(NON_CREATE_TRAILER_DDL)
        header = recs[0]
        self.assertEqual(header["tables"], 1)
        table_names = [r["table"] for r in recs if r["kind"] == "table"]
        self.assertEqual(table_names, ["only_table"])

    def test_diagnostics_empty_for_clean_ddl(self):
        diagnostics = []
        catalog_ddl.parse_ddl_catalog(BASIC_DDL, diagnostics=diagnostics)
        self.assertEqual(diagnostics, [])

    def test_diagnostics_none_is_safe_and_does_not_change_records(self):
        with_none = catalog_ddl.parse_ddl_catalog(BASIC_DDL, diagnostics=None)
        collected = []
        with_list = catalog_ddl.parse_ddl_catalog(BASIC_DDL, diagnostics=collected)
        self.assertEqual(with_none, with_list)

    def test_malformed_statement_appends_diagnostics_without_crashing(self):
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog(MALFORMED_DDL, diagnostics=diagnostics)

        # Good tables on either side of the garbage statement are salvaged.
        table_names = sorted(r["table"] for r in recs if r["kind"] == "table")
        self.assertEqual(table_names, ["good_table", "other_table"])
        self.assertEqual(recs[0]["tables"], 2)

        # At least one structured diagnostic was recorded, with the documented shape.
        self.assertGreaterEqual(len(diagnostics), 1)
        for d in diagnostics:
            self.assertEqual(set(d.keys()), {"level", "code", "table", "message"})
            self.assertEqual(d["level"], "warn")

        codes = {d["code"] for d in diagnostics}
        self.assertIn("parse_error", codes)


class UntokenizableFileTests(unittest.TestCase):
    """One literal the tokenizer rejects no longer ends the whole analysis."""

    def test_a_file_quoted_for_another_database_is_read_whole_with_the_backslash_rule_turned(self):
        # Cut at line ends, the string holding "hello; ... CREATE TABLE phantom" became a
        # table; read whole with backslash escapes off, it is the string it is.
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", POSTGRES_QUOTED_DDL)], diagnostics=diagnostics)
        self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["after_dump", "before_dump"])
        token = [d for d in diagnostics if d["code"] == "token_error"]
        self.assertEqual(len(token), 1)
        self.assertIn("pg.sql could not be tokenized as mysql", token[0]["message"])
        self.assertIn("read whole with backslash escapes off", token[0]["message"])

    def test_a_table_whose_default_is_quoted_for_another_database_is_read(self):
        broken = "CREATE TABLE `t` (`path` varchar(10) DEFAULT 'C:\\', `flag` varchar(1) DEFAULT 'B');\n"
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", broken)])
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["t"])
        self.assertEqual(sorted(r["column"] for r in recs if r["kind"] == "column"), ["flag", "path"])

    def test_a_data_statement_the_tokenizer_rejects_leaves_every_table_readable(self):
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", UNTOKENIZABLE_DUMP_DDL)], diagnostics=diagnostics)
        self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["after_dump", "before_dump"])
        token = [d for d in diagnostics if d["code"] == "token_error"]
        self.assertEqual(len(token), 1)
        self.assertIn("pg.sql could not be tokenized as a whole", token[0]["message"])
        self.assertIn("0 statement(s) unreadable", token[0]["message"])

    def test_a_create_table_that_still_cannot_be_read_is_named(self):
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", UNTOKENIZABLE_CREATE_DDL)], diagnostics=diagnostics)
        self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["good_one", "good_two"])
        token = [d for d in diagnostics if d["code"] == "token_error"]
        self.assertEqual(len(token), 1)
        self.assertIn("1 statement(s) unreadable: CREATE TABLE `broken_one`", token[0]["message"])

    def test_a_file_that_tokenizes_is_read_exactly_as_before(self):
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("basic.sql", BASIC_DDL)], diagnostics=diagnostics)
        self.assertEqual(recs, catalog_ddl.parse_ddl_catalog_files([("basic.sql", BASIC_DDL)]))
        self.assertEqual([d for d in diagnostics if d["code"] == "token_error"], [])

    def test_statements_are_cut_where_a_line_ends_in_a_semicolon(self):
        chunks = catalog_ddl._statements_by_line("CREATE TABLE a (\n id int\n);\nINSERT INTO a VALUES (1);\nSELECT 1")
        self.assertEqual(chunks, ["CREATE TABLE a (\n id int\n);\n", "INSERT INTO a VALUES (1);\n", "SELECT 1"])

    def test_a_comment_after_the_semicolon_still_ends_the_statement(self):
        # Joined to the next statement, a CREATE TABLE after a data row was skipped
        # with it, and the diagnostic said nothing was lost.
        for comment in ("-- loaded seed rows", "# seed", "/* seed */", "/* seed */ -- batch 1", "/* a */ /* b */ # c"):
            dump = UNTOKENIZABLE_DUMP_DDL.replace("'x');", "'x'); " + comment)
            diagnostics = []
            recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", dump)], diagnostics=diagnostics)
            self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["after_dump", "before_dump"], comment)
            self.assertIn("0 statement(s) unreadable", [d for d in diagnostics if d["code"] == "token_error"][0]["message"])

    def test_a_table_inside_a_skipped_data_statement_is_named_never_dropped_silently(self):
        # A data row whose end this reader cannot see (no semicolon at the end of
        # its line) runs on into the table after it; both are skipped, and the
        # diagnostic says which table went with the data.
        dump = UNTOKENIZABLE_DUMP_DDL.replace("'x');", "'x')")
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", dump)], diagnostics=diagnostics)
        self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["before_dump"])
        self.assertIn("1 statement(s) unreadable: CREATE TABLE `after_dump` (inside a skipped data statement)",
                      [d for d in diagnostics if d["code"] == "token_error"][0]["message"])

    def test_a_comment_above_a_statement_is_not_how_it_starts(self):
        dump = UNTOKENIZABLE_DUMP_DDL.replace("INSERT", "-- seed rows\n/* loaded */\nINSERT").replace(
            "CREATE TABLE `after_dump` (\n  `id` int(11) NOT NULL\n);",
            "-- Table structure\nCREATE TABLE `after_dump` (`p` varchar(9) DEFAULT 'C:\\', `q` varchar(1) DEFAULT 'B');")
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("pg.sql", dump)], diagnostics=diagnostics)
        self.assertEqual(sorted(r["table"] for r in recs if r["kind"] == "table"), ["before_dump"])
        # The data row is skipped, not reported; the table that cannot be read is named by its table.
        self.assertIn("1 statement(s) unreadable: CREATE TABLE `after_dump`", [d for d in diagnostics if d["code"] == "token_error"][0]["message"])


class MultipleTableTests(unittest.TestCase):
    def test_tables_sorted_by_name_in_output(self):
        recs = catalog_ddl.parse_ddl_catalog(MULTI_TABLE_DDL)
        table_names = [r["table"] for r in recs if r["kind"] == "table"]
        # Declared as zebra_table then alpha_table; output must be sorted.
        self.assertEqual(table_names, ["alpha_table", "zebra_table"])

    def test_each_table_keeps_its_own_columns(self):
        recs = catalog_ddl.parse_ddl_catalog(MULTI_TABLE_DDL)

        # alpha_table (sorted first) has one column.
        idx = next(i for i, r in enumerate(recs)
                   if r["kind"] == "table" and r["table"] == "alpha_table")
        self.assertEqual(recs[idx + 1]["column"], "a_id")
        # Only one column follows before the next table record (or end of list).
        self.assertTrue(
            idx + 2 == len(recs) or recs[idx + 2]["kind"] == "table"
        )

        # zebra_table (sorted second) has two columns, in declaration order.
        idx2 = next(i for i, r in enumerate(recs)
                    if r["kind"] == "table" and r["table"] == "zebra_table")
        self.assertEqual(recs[idx2 + 1]["column"], "z_id")
        self.assertEqual(recs[idx2 + 2]["column"], "z_name")

    def test_header_counts_sum_across_tables(self):
        recs = catalog_ddl.parse_ddl_catalog(MULTI_TABLE_DDL)
        header = recs[0]
        self.assertEqual(header["tables"], 2)
        self.assertEqual(header["columns"], 3)  # a_id + z_id + z_name



# ---------------------------------------------------------------------------
# SEVERAL FILES (RM20 §3). A schema split across files — one per service, or a
# base plus an ordered migration sequence — folded in the order it is given.
# ---------------------------------------------------------------------------

SERVICE_A_DDL = """
CREATE TABLE owners (
  id INT NOT NULL PRIMARY KEY,
  last_name VARCHAR(30) COMMENT 'family name'
);
"""

SERVICE_B_DDL = """
CREATE TABLE vets (
  id INT NOT NULL PRIMARY KEY,
  specialty VARCHAR(80)
);
"""


class MultipleFileTests(unittest.TestCase):
    def _records(self, files, diagnostics=None):
        return catalog_ddl.parse_ddl_catalog_files(files, diagnostics=diagnostics)

    def test_two_files_are_the_union_of_their_tables(self):
        recs = self._records([("a.sql", SERVICE_A_DDL), ("b.sql", SERVICE_B_DDL)])
        header = recs[0]
        self.assertEqual(header["tables"], 2)
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"],
                         ["owners", "vets"])
        # The header says which file contributed what, so the count can be checked.
        self.assertEqual([f["source"] for f in header["files"]], ["a.sql", "b.sql"])
        self.assertEqual([f["tablesAdded"] for f in header["files"]], [1, 1])

    def test_a_single_file_is_unchanged_by_the_fold(self):
        one = self._records([("a.sql", SERVICE_A_DDL)])
        direct = catalog_ddl.parse_ddl_catalog(SERVICE_A_DDL)
        self.assertEqual([r for r in one if r["kind"] != "header"],
                         [r for r in direct if r["kind"] != "header"])

    def test_two_files_declaring_the_same_table_are_never_merged(self):
        diags = []
        other = "CREATE TABLE owners (id INT, city VARCHAR(80));"
        recs = self._records([("a.sql", SERVICE_A_DDL), ("b.sql", other)], diags)
        cols = [r["column"] for r in recs if r["kind"] == "column"]
        self.assertEqual(cols, ["id", "last_name"], "the FIRST declaration is kept whole")
        codes = [d["code"] for d in diags]
        self.assertIn("DUPLICATE_TABLE_DECLARATION", codes)
        msg = [d["message"] for d in diags if d["code"] == "DUPLICATE_TABLE_DECLARATION"][0]
        self.assertIn("a.sql", msg)
        self.assertIn("b.sql", msg)


class AlterTests(unittest.TestCase):
    BASE = """
    CREATE TABLE t_user (
      id INT NOT NULL PRIMARY KEY,
      name VARCHAR(30) COMMENT 'display name',
      scratch INT
    );
    """

    def _fold(self, migration, diagnostics=None):
        return catalog_ddl.parse_ddl_catalog_files(
            [("base.sql", self.BASE), ("up.sql", migration)], diagnostics=diagnostics)

    def _cols(self, recs, table="t_user"):
        return [(r["column"], r["type"], r["comment"], r["ordinal"], r["pk"])
                for r in recs if r["kind"] == "column" and r["table"] == table]

    def test_add_column_appends_with_its_type_and_comment(self):
        recs = self._fold("ALTER TABLE t_user ADD COLUMN state INT NOT NULL COMMENT 'lifecycle';")
        cols = self._cols(recs)
        self.assertEqual([c[0] for c in cols], ["id", "name", "scratch", "state"])
        self.assertEqual(cols[3][1], "INT")
        self.assertEqual(cols[3][2], "lifecycle")
        self.assertEqual(cols[3][3], 4, "ordinals are re-derived over the folded table")

    def test_drop_column_removes_it_and_renumbers(self):
        recs = self._fold("ALTER TABLE t_user DROP COLUMN scratch;")
        self.assertEqual([c[0] for c in self._cols(recs)], ["id", "name"])
        self.assertEqual([c[3] for c in self._cols(recs)], [1, 2])

    def test_modify_column_replaces_the_type_in_place(self):
        recs = self._fold("ALTER TABLE t_user MODIFY COLUMN name VARCHAR(120) COMMENT 'wider';")
        cols = self._cols(recs)
        self.assertEqual([c[0] for c in cols], ["id", "name", "scratch"])
        self.assertEqual(cols[1][1], "VARCHAR(120)")
        self.assertEqual(cols[1][2], "wider")

    def test_change_column_renames_and_keeps_the_position(self):
        recs = self._fold("ALTER TABLE t_user CHANGE COLUMN name display_name VARCHAR(60);")
        self.assertEqual([c[0] for c in self._cols(recs)], ["id", "display_name", "scratch"])

    def test_change_column_carries_the_primary_key_over(self):
        recs = self._fold("ALTER TABLE t_user CHANGE COLUMN id user_id BIGINT;")
        cols = self._cols(recs)
        self.assertEqual(cols[0][0], "user_id")
        self.assertTrue(cols[0][4], "the PK follows the rename")

    def test_alter_rename_to_renames_the_table(self):
        recs = self._fold("ALTER TABLE t_user RENAME TO t_account;")
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["t_account"])
        self.assertEqual([c[0] for c in self._cols(recs, "t_account")], ["id", "name", "scratch"])

    def test_rename_table_statement_renames_the_table(self):
        recs = self._fold("RENAME TABLE t_user TO t_account;")
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["t_account"])

    def test_a_sequence_of_alters_is_applied_in_order(self):
        recs = self._fold("""
        ALTER TABLE t_user ADD COLUMN state INT;
        ALTER TABLE t_user DROP COLUMN scratch;
        ALTER TABLE t_user CHANGE COLUMN state status VARCHAR(8);
        ALTER TABLE t_user RENAME TO t_account;
        """)
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["t_account"])
        self.assertEqual([c[0] for c in self._cols(recs, "t_account")], ["id", "name", "status"])

    def test_an_unmodelled_alter_clause_is_named_in_a_diagnostic(self):
        diags = []
        self._fold("ALTER TABLE t_user ADD INDEX idx_name (name);", diags)
        codes = [d["code"] for d in diags]
        self.assertIn("alter_clause_unsupported", codes)
        msg = [d["message"] for d in diags if d["code"] == "alter_clause_unsupported"][0]
        self.assertIn("ADD CONSTRAINT / ADD INDEX / ADD KEY", msg)

    def test_an_alter_on_a_table_nobody_declared_is_reported_not_invented(self):
        diags = []
        recs = self._fold("ALTER TABLE t_ghost ADD COLUMN x INT;", diags)
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["t_user"])
        self.assertIn("alter_unknown_table", [d["code"] for d in diags])


class IdentifierCaseTests(unittest.TestCase):
    """Two files declaring the same table in different CASE.

    jpetstore-6 ships its 13 tables twice — `create table SUPPLIER` in one file
    and `create table supplier` in the other. Under a fold-lower database that is
    ONE table declared twice; comparing the bytes calls it 26 tables and puts 13
    that nothing can ever touch into the catalog.
    """

    A = "CREATE TABLE SUPPLIER (suppid int, name varchar(80));"
    B = "create table supplier (suppid int, city varchar(80));"

    def test_exact_keeps_them_apart(self):
        recs = catalog_ddl.parse_ddl_catalog_files(
            [("a.sql", self.A), ("b.sql", self.B)], identifier_case="exact")
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"],
                         ["SUPPLIER", "supplier"])

    def test_fold_lower_makes_them_one_table_declared_twice(self):
        diags = []
        recs = catalog_ddl.parse_ddl_catalog_files(
            [("a.sql", self.A), ("b.sql", self.B)], diagnostics=diags,
            identifier_case="fold-lower")
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["SUPPLIER"],
                         "the FIRST declaration is kept, spelling included")
        self.assertEqual([r["column"] for r in recs if r["kind"] == "column"],
                         ["suppid", "name"])
        self.assertIn("DUPLICATE_TABLE_DECLARATION", [d["code"] for d in diags])

    def test_fold_upper_does_the_same(self):
        recs = catalog_ddl.parse_ddl_catalog_files(
            [("b.sql", self.B), ("a.sql", self.A)], identifier_case="fold-upper")
        self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], ["supplier"])

    def test_an_alter_finds_the_table_under_the_fold(self):
        recs = catalog_ddl.parse_ddl_catalog_files(
            [("a.sql", self.A), ("up.sql", "ALTER TABLE supplier ADD COLUMN city varchar(80);")],
            identifier_case="fold-lower")
        self.assertEqual([r["column"] for r in recs if r["kind"] == "column"],
                         ["suppid", "name", "city"])


class UnnamedColumnTests(unittest.TestCase):
    """A PostgreSQL migration read as MySQL: a name in double quotes is a
    string there, so a column comes out with no name. It is said, and never a
    column named ''."""

    DDL = 'CREATE TABLE "User" (\n  "id" TEXT NOT NULL,\n  "role" "Role" NOT NULL\n);\n'

    def _read(self, dialect):
        diagnostics = []
        recs = catalog_ddl.parse_ddl_catalog_files([("migration.sql", self.DDL)], diagnostics=diagnostics, dialect=dialect)
        return [r["column"] for r in recs if r.get("kind") == "column"], diagnostics

    def test_a_column_with_no_name_is_left_out_and_said(self):
        names, diagnostics = self._read("mysql")
        self.assertNotIn("", names)
        said = [d for d in diagnostics if d["code"] == "column_unnamed"]
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("sqlDialects.main", said[0]["message"])

    def test_read_in_its_own_dialect_every_column_has_its_name(self):
        names, diagnostics = self._read("postgres")
        self.assertEqual(sorted(names), ["id", "role"])
        self.assertEqual([d for d in diagnostics if d["code"] == "column_unnamed"], [])


# ---------------------------------------------------------------------------
# THE STATE A MIGRATION LEAVES (catalog-ddl/8). Migrations are read in order, so
# the catalog ends in the state the last statement leaves: a column set NOT NULL
# later is NOT NULL, a primary key dropped and added again is the new key.
# ---------------------------------------------------------------------------

def _fold_files(files, dialect, identifier_case="fold-lower"):
    diagnostics = []
    recs = catalog_ddl.parse_ddl_catalog_files(files, diagnostics=diagnostics,
                                               identifier_case=identifier_case, dialect=dialect)
    cols = {(r["table"], r["column"]): r for r in recs if r["kind"] == "column"}
    return cols, diagnostics


def _pk(cols, table):
    return sorted(c for (t, c), r in cols.items() if t == table and r["pk"])


def _codes(diagnostics, code):
    return [d["message"] for d in diagnostics if d["code"] == code]


class PostgresMigrationStateTests(unittest.TestCase):
    """Prisma's migrations for PostgreSQL, the shape ghostfolio ships."""

    INIT = '''
    CREATE TABLE "Access" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "granteeUserId" TEXT NOT NULL,
        PRIMARY KEY ("id","userId")
    );
    CREATE TABLE "MarketData" ("id" TEXT NOT NULL, "symbol" TEXT NOT NULL);
    '''
    EXPIRES = '''
    ALTER TABLE "Access" ADD COLUMN "expiresAt" TIMESTAMP(3);
    UPDATE "Access" SET "expiresAt" = '2050-12-31 12:00:00' WHERE "expiresAt" IS NULL;
    ALTER TABLE "Access" ALTER COLUMN "expiresAt" SET NOT NULL;
    '''

    def test_a_column_set_not_null_after_its_creation_is_not_null(self):
        cols, _ = _fold_files([("1_init", self.INIT), ("2_expires", self.EXPIRES)], "postgres")
        self.assertFalse(cols[("Access", "expiresAt")]["nullable"])

    def test_the_files_are_read_in_migration_order(self):
        relax = 'ALTER TABLE "Access" ALTER COLUMN "expiresAt" DROP NOT NULL;'
        files = [("1_init", self.INIT), ("2_expires", self.EXPIRES), ("3_relax", relax)]
        cols, _ = _fold_files(files, "postgres")
        self.assertTrue(cols[("Access", "expiresAt")]["nullable"], "the last statement leaves it nullable")
        cols, _ = _fold_files(files[:2], "postgres")
        self.assertFalse(cols[("Access", "expiresAt")]["nullable"])

    def test_drop_not_null_makes_a_column_nullable(self):
        cols, _ = _fold_files([("1_init", self.INIT),
                               ("2", 'ALTER TABLE "Access" ALTER COLUMN "granteeUserId" DROP NOT NULL;')], "postgres")
        self.assertTrue(cols[("Access", "granteeUserId")]["nullable"])

    def test_a_primary_key_dropped_and_added_again_on_other_columns(self):
        # One statement with two kinds of clause, which sqlglot reads only as text.
        change = ('ALTER TABLE "Access" DROP CONSTRAINT "Access_pkey",\n'
                  'ADD CONSTRAINT "Access_pkey" PRIMARY KEY ("id");')
        cols, diagnostics = _fold_files([("1_init", self.INIT), ("2_ids", change)], "postgres")
        self.assertEqual(_pk(cols, "Access"), ["id"])
        # The key was declared without a name: that it is Access_pkey is PostgreSQL's convention, and said.
        said = _codes(diagnostics, "alter_primary_key_by_convention")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("Access_pkey", said[0])
        self.assertIn("PostgreSQL names such a key <table>_pkey by convention", said[0])
        self.assertEqual(_codes(diagnostics, "alter_unreadable"), [])

    def test_add_constraint_primary_key_on_a_table_without_one(self):
        cols, _ = _fold_files([("1_init", self.INIT),
                               ("2", 'ALTER TABLE "MarketData" ADD CONSTRAINT "MarketData_pkey" PRIMARY KEY ("id");')],
                              "postgres")
        self.assertEqual(_pk(cols, "MarketData"), ["id"])

    def test_add_primary_key_makes_its_columns_not_null(self):
        base = 'CREATE TABLE t (a INT, b INT);'
        cols, _ = _fold_files([("1", base), ("2", "ALTER TABLE t ADD PRIMARY KEY (a, b);")], "postgres")
        self.assertEqual(_pk(cols, "t"), ["a", "b"])
        self.assertFalse(cols[("t", "a")]["nullable"])
        self.assertFalse(cols[("t", "b")]["nullable"])

    def test_a_key_named_in_its_create_is_dropped_by_that_name_only(self):
        base = 'CREATE TABLE "T" ("a" INT NOT NULL, "b" INT, CONSTRAINT "pk_t" PRIMARY KEY ("a"));'
        cols, diagnostics = _fold_files([("1", base), ("2", 'ALTER TABLE "T" DROP CONSTRAINT "T_pkey";')], "postgres")
        self.assertEqual(_pk(cols, "T"), ["a"], "T_pkey is not this key's name")
        self.assertTrue(_codes(diagnostics, "alter_clause_unsupported"))
        cols, diagnostics = _fold_files([("1", base), ("2", 'ALTER TABLE "T" DROP CONSTRAINT "pk_t";')], "postgres")
        self.assertEqual(_pk(cols, "T"), [])
        self.assertEqual(_codes(diagnostics, "alter_primary_key_by_convention"), [], "the name was written, not assumed")

    def test_a_renamed_key_is_dropped_by_its_new_name(self):
        base = 'CREATE TABLE "T" ("a" INT NOT NULL PRIMARY KEY);'
        for rename in ('ALTER TABLE "T" RENAME CONSTRAINT "T_pkey" TO "T_key";',
                       'ALTER INDEX "T_pkey" RENAME TO "T_key";'):
            cols, _ = _fold_files([("1", base), ("2", rename), ("3", 'ALTER TABLE "T" DROP CONSTRAINT "T_key";')],
                                  "postgres")
            self.assertEqual(_pk(cols, "T"), [], rename)

    def test_a_renamed_table_keeps_the_key_name_it_was_created_with(self):
        base = 'CREATE TABLE "Old" ("a" INT NOT NULL PRIMARY KEY);'
        steps = ('ALTER TABLE "Old" RENAME TO "New";', 'ALTER TABLE "New" DROP CONSTRAINT "Old_pkey";')
        cols, _ = _fold_files([("1", base), ("2", steps[0]), ("3", steps[1])], "postgres")
        self.assertEqual(_pk(cols, "New"), [])

    def test_a_key_name_past_the_server_limit_is_not_known_and_the_key_is_kept(self):
        long_name = "t" * 60
        base = 'CREATE TABLE %s (a INT NOT NULL PRIMARY KEY);' % long_name
        drop = "ALTER TABLE %s DROP CONSTRAINT %s_pkey;" % (long_name, long_name)
        cols, diagnostics = _fold_files([("1", base), ("2", drop)], "postgres")
        self.assertEqual(_pk(cols, long_name), ["a"])
        self.assertEqual(len(_codes(diagnostics, "alter_primary_key_unknown")), 1)

    def test_several_clauses_of_different_kinds_are_each_applied(self):
        base = 'CREATE TABLE "User" ("id" TEXT NOT NULL, "provider" "Provider");'
        change = ('ALTER TABLE "User" ALTER COLUMN "provider" SET NOT NULL,\n'
                  'ALTER COLUMN "provider" SET DEFAULT E\'ANONYMOUS\';')
        cols, diagnostics = _fold_files([("1", base), ("2", change)], "postgres")
        self.assertFalse(cols[("User", "provider")]["nullable"])
        self.assertIn("SET DEFAULT", _codes(diagnostics, "alter_clause_unsupported")[0])

    def test_a_type_change_and_the_type_renamed_back(self):
        # PostgreSQL drops an enum value by building a new type and swapping names.
        base = ('CREATE TYPE "DataSource" AS ENUM (\'A\', \'B\');\n'
                'CREATE TABLE "M" ("ds" "DataSource" NOT NULL, "cur" "Currency");')
        swap = '''
        CREATE TYPE "DataSource_new" AS ENUM ('A');
        ALTER TYPE "DataSource" RENAME TO "DataSource_old";
        ALTER TABLE "M" ALTER COLUMN "ds" TYPE "DataSource_new" USING ("ds"::text::"DataSource_new");
        ALTER TYPE "DataSource_new" RENAME TO "DataSource";
        DROP TYPE "DataSource_old";
        ALTER TABLE "M" ALTER COLUMN "cur" TYPE TEXT;
        '''
        cols, _ = _fold_files([("1", base), ("2", swap)], "postgres")
        self.assertEqual(cols[("M", "ds")]["type"], '"DataSource"')
        self.assertEqual(cols[("M", "cur")]["type"], "TEXT")
        self.assertFalse(cols[("M", "ds")]["nullable"], "a type change leaves nullability as it was")

    def test_dropping_one_column_of_a_key_drops_the_whole_key(self):
        base = "CREATE TABLE t (a INT NOT NULL, b INT NOT NULL, c INT, PRIMARY KEY (a, b));"
        cols, _ = _fold_files([("1", base), ("2", "ALTER TABLE t DROP COLUMN b;")], "postgres")
        self.assertEqual(_pk(cols, "t"), [], "PostgreSQL drops the constraints involving the column")
        cols, _ = _fold_files([("1", base), ("2", "ALTER TABLE t DROP COLUMN b;")], "mysql")
        self.assertEqual(_pk(cols, "t"), ["a"], "MySQL takes the column out of the key")

    def test_a_clause_that_cannot_be_read_is_named_and_the_key_is_kept(self):
        base = 'CREATE TABLE t (a INT NOT NULL, b INT NOT NULL);'
        change = "ALTER TABLE t ADD CONSTRAINT t_pkey PRIMARY KEY USING INDEX t_b_idx;"
        cols, diagnostics = _fold_files([("1", base), ("2", change)], "postgres")
        self.assertEqual(_pk(cols, "t"), [])
        said = _codes(diagnostics, "alter_unreadable")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("PRIMARY KEY USING INDEX t_b_idx", said[0])

    def test_rename_column_renames_it_in_place(self):
        base = 'CREATE TABLE t (a INT NOT NULL PRIMARY KEY, b INT, c INT);'
        cols, _ = _fold_files([("1", base), ("2", "ALTER TABLE t RENAME COLUMN a TO z;")], "postgres")
        self.assertEqual(sorted(c for (t, c) in cols), ["b", "c", "z"])
        self.assertEqual(_pk(cols, "t"), ["z"])


class MysqlMigrationStateTests(unittest.TestCase):
    BASE = """
    CREATE TABLE `t_order` (
      `id` bigint(20) NOT NULL,
      `line` int(11) NOT NULL,
      `note` varchar(20) DEFAULT NULL,
      PRIMARY KEY (`id`),
      KEY `idx_note` (`note`)
    );
    """

    def _fold(self, *migrations):
        files = [("base.sql", self.BASE)] + [("V%d.sql" % i, m) for i, m in enumerate(migrations, 1)]
        return _fold_files(files, "mysql")

    def test_drop_primary_key_and_add_it_on_other_columns(self):
        cols, diagnostics = self._fold("ALTER TABLE `t_order` DROP PRIMARY KEY, ADD PRIMARY KEY (`id`, `line`);")
        self.assertEqual(_pk(cols, "t_order"), ["id", "line"])
        self.assertEqual(_codes(diagnostics, "alter_unreadable"), [])

    def test_drop_primary_key_alone(self):
        cols, _ = self._fold("ALTER TABLE `t_order` DROP PRIMARY KEY;")
        self.assertEqual(_pk(cols, "t_order"), [])
        self.assertFalse(cols[("t_order", "id")]["nullable"], "a dropped key leaves its column NOT NULL")

    def test_the_primary_key_is_always_called_primary(self):
        cols, _ = self._fold("ALTER TABLE `t_order` DROP INDEX `idx_note`;")
        self.assertEqual(_pk(cols, "t_order"), ["id"])
        cols, _ = self._fold("ALTER TABLE `t_order` DROP INDEX `PRIMARY`;")
        self.assertEqual(_pk(cols, "t_order"), [])

    def test_add_primary_key_using_an_index_type(self):
        cols, _ = self._fold("ALTER TABLE `t_order` DROP PRIMARY KEY;",
                             "ALTER TABLE `t_order` ADD PRIMARY KEY USING BTREE (`line`);")
        self.assertEqual(_pk(cols, "t_order"), ["line"])

    def test_modify_restates_nullability(self):
        cols, _ = self._fold("ALTER TABLE `t_order` MODIFY COLUMN `note` varchar(40) NOT NULL;")
        self.assertFalse(cols[("t_order", "note")]["nullable"])
        cols, _ = self._fold("ALTER TABLE `t_order` MODIFY COLUMN `line` int(11) NULL;")
        self.assertTrue(cols[("t_order", "line")]["nullable"], "MODIFY restates the whole column")

    def test_a_key_column_modified_without_not_null_stays_not_null(self):
        # MySQL declares a key column NOT NULL "implicitly (and silently)".
        cols, _ = self._fold("ALTER TABLE `t_order` MODIFY `id` bigint(20) COMMENT 'order id';")
        self.assertFalse(cols[("t_order", "id")]["nullable"])
        self.assertTrue(cols[("t_order", "id")]["pk"])

    def test_change_with_primary_key_makes_the_new_key(self):
        cols, _ = self._fold("ALTER TABLE `t_order` DROP PRIMARY KEY;",
                             "ALTER TABLE `t_order` CHANGE `line` `line_no` int(11) NOT NULL PRIMARY KEY;")
        self.assertEqual(_pk(cols, "t_order"), ["line_no"])

    def test_an_h2_set_null_read_as_mysql_is_applied(self):
        # HSQLDB and H2 files are read with the MySQL grammar, which keeps this clause as text.
        cols, _ = self._fold("ALTER TABLE t_order ALTER COLUMN line SET NULL;")
        self.assertTrue(cols[("t_order", "line")]["nullable"])


class OracleMigrationStateTests(unittest.TestCase):
    BASE = ("CREATE TABLE T_USER (ID NUMBER(19) NOT NULL, NAME VARCHAR2(30), "
            "CODE VARCHAR2(8) NOT NULL, PRIMARY KEY (ID));")

    def _fold(self, migration):
        return _fold_files([("base.sql", self.BASE), ("up.sql", migration)], "oracle", "fold-upper")

    def test_modify_changes_only_what_it_says(self):
        cols, diagnostics = self._fold("ALTER TABLE T_USER MODIFY (NAME NOT NULL);")
        self.assertFalse(cols[("T_USER", "NAME")]["nullable"])
        self.assertEqual(cols[("T_USER", "NAME")]["type"], "VARCHAR(30)", "the type is not restated")
        cols, _ = self._fold("ALTER TABLE T_USER MODIFY (CODE VARCHAR2(16), NAME NULL);")
        self.assertEqual(cols[("T_USER", "CODE")]["type"], "VARCHAR(16)")
        self.assertFalse(cols[("T_USER", "CODE")]["nullable"], "Oracle keeps what MODIFY does not say")
        self.assertTrue(cols[("T_USER", "NAME")]["nullable"])
        self.assertEqual(_codes(diagnostics, "alter_unreadable"), [])

    def test_drop_primary_key(self):
        cols, _ = self._fold("ALTER TABLE T_USER DROP PRIMARY KEY;")
        self.assertEqual(_pk(cols, "T_USER"), [])

    def test_an_unnamed_key_is_not_known_by_name(self):
        # Oracle names an unnamed key SYS_C<n>: a drop by name cannot be told apart from another constraint's.
        cols, diagnostics = self._fold("ALTER TABLE T_USER DROP CONSTRAINT SYS_C0012345;")
        self.assertEqual(_pk(cols, "T_USER"), ["ID"])
        self.assertEqual(len(_codes(diagnostics, "alter_primary_key_unknown")), 1)

    def test_add_a_list_of_columns(self):
        cols, _ = self._fold("ALTER TABLE T_USER ADD (STATE NUMBER(1) NOT NULL, NOTE VARCHAR2(100));")
        self.assertFalse(cols[("T_USER", "STATE")]["nullable"])
        self.assertIn(("T_USER", "NOTE"), cols)


class PrimaryKeyNullabilityTests(unittest.TestCase):
    def test_a_key_column_written_without_not_null_holds_no_null(self):
        cols, _ = _fold_files([("s.sql", "CREATE TABLE owners (id INTEGER PRIMARY KEY, name VARCHAR(30));")], "mysql")
        self.assertFalse(cols[("owners", "id")]["nullable"])
        self.assertTrue(cols[("owners", "name")]["nullable"])



# ---------------------------------------------------------------------------
# REVIEW 3 (catalog-ddl/9). The rules an ALTER is read by belong to the DATABASE
# the profile names, not to the grammar it is parsed with: H2 and HSQLDB are read
# with the standard grammar and CUBRID with MySQL's, and none of them inherits the
# rules of the database whose grammar it borrows.
# ---------------------------------------------------------------------------

def _fold_db(files, dialect, database, identifier_case="fold-lower"):
    diagnostics = []
    recs = catalog_ddl.parse_ddl_catalog_files(files, diagnostics=diagnostics, identifier_case=identifier_case,
                                               dialect=dialect, database=database)
    cols = {(r["table"], r["column"]): r for r in recs if r["kind"] == "column"}
    return cols, diagnostics


class DatabaseRuleTests(unittest.TestCase):
    PETS = ("CREATE TABLE pets (id INT NOT NULL, name VARCHAR(30), CONSTRAINT pk_pets PRIMARY KEY (id));\n"
            "ALTER TABLE pets DROP CONSTRAINT pk_pets;")

    def test_h2_catalog_is_not_read_with_mysql_primary_key_rule(self):
        # The key is named in its CREATE: dropping that name drops it, whatever
        # grammar the file is read with. MySQL's "always PRIMARY" is MySQL's.
        for dialect in ("", "mysql"):
            for database in ("h2", "hsqldb"):
                cols, diagnostics = _fold_db([("schema.sql", self.PETS)], dialect, database, "fold-upper")
                self.assertEqual(_pk(cols, "pets"), [], (dialect, database, diagnostics))

    def test_an_empty_dialect_on_the_command_line_is_the_standard_grammar(self):
        import contextlib
        import io
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as fh:
            fh.write(self.PETS)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(catalog_ddl.main(["--dialect", "", "--database", "h2",
                                                   "--identifier-case", "fold-upper", fh.name]), 0)
        finally:
            os.unlink(fh.name)
        recs = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual(recs[0]["dialect"], "")
        self.assertEqual([r["column"] for r in recs if r["kind"] == "column" and r["pk"]], [])

    def test_a_database_with_no_rule_of_its_own_keeps_the_key_name_unknown_and_says_so(self):
        # CUBRID speaks MySQL, but that its key is always PRIMARY is not known.
        base = "CREATE TABLE t (id INT NOT NULL, c INT, PRIMARY KEY (id), KEY idx_c (c));\n"
        for drop in ("ALTER TABLE t DROP INDEX idx_c;", "ALTER TABLE t DROP INDEX `PRIMARY`;"):
            cols, diagnostics = _fold_db([("s.sql", base + drop)], "mysql", "cubrid")
            self.assertEqual(_pk(cols, "t"), ["id"], drop)
            self.assertEqual(len(_codes(diagnostics, "alter_primary_key_unknown")), 1, (drop, diagnostics))

    def test_mariadb_has_its_own_documented_rules(self):
        # MariaDB's ALTER TABLE page: a primary key's name "is always PRIMARY", and
        # MODIFY needs "all attributes for the new column".
        base = "CREATE TABLE t (id INT NOT NULL, c INT NOT NULL, PRIMARY KEY (id), KEY idx_c (c));\n"
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t DROP INDEX idx_c;")], "mysql", "mariadb")
        self.assertEqual(_pk(cols, "t"), ["id"])
        self.assertEqual(_codes(diagnostics, "alter_primary_key_unknown"), [])
        cols, _ = _fold_db([("s.sql", base + "ALTER TABLE t DROP INDEX `PRIMARY`;")], "mysql", "mariadb")
        self.assertEqual(_pk(cols, "t"), [])
        cols, _ = _fold_db([("s.sql", base + "ALTER TABLE t MODIFY c BIGINT;")], "mysql", "mariadb")
        self.assertTrue(cols[("t", "c")]["nullable"])

    def test_an_oracle_compatible_database_does_not_borrow_what_modify_keeps(self):
        # Tibero is read with Oracle's grammar; that its MODIFY keeps what it does not say is not known.
        base = "CREATE TABLE T (ID NUMBER NOT NULL, C VARCHAR2(10) NOT NULL, PRIMARY KEY (ID));\n"
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE T MODIFY (C VARCHAR2(20));")],
                                     "oracle", "tibero", "fold-upper")
        self.assertEqual(cols[("T", "C")]["type"], "VARCHAR(20)")
        said = _codes(diagnostics, "alter_modify_unsaid_unknown")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("tibero", said[0])
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE T MODIFY (C VARCHAR2(20));")], "oracle", "oracle",
                                     "fold-upper")
        self.assertEqual(_codes(diagnostics, "alter_modify_unsaid_unknown"), [], "Oracle's own MODIFY is known")

    def test_a_database_with_no_rule_says_what_dropping_a_key_column_does_is_not_known(self):
        base = "CREATE TABLE t (a INT NOT NULL, b INT NOT NULL, CONSTRAINT pk_t PRIMARY KEY (a, b));\n"
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t DROP COLUMN b;")], "", "h2")
        self.assertEqual(len(_codes(diagnostics, "alter_primary_key_unknown")), 1, diagnostics)


class Review3ClauseTests(unittest.TestCase):
    def test_postgres_rename_without_column_keyword_renames_the_column(self):
        cols, diagnostics = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY, c INT);\n"
                                                   "ALTER TABLE t RENAME c TO d;")], "postgres")
        self.assertEqual(sorted(cols), [("t", "d"), ("t", "id")])
        cols, _ = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY);\nALTER TABLE t RENAME TO u;")],
                              "postgres")
        self.assertEqual(sorted(cols), [("u", "id")], "RENAME TO still renames the table")

    def test_oracle_export_primary_key_with_using_index_enable_is_applied(self):
        base = "CREATE TABLE U (ID NUMBER(10) NOT NULL, C VARCHAR2(10));\n"
        for add in ("ALTER TABLE U ADD CONSTRAINT PK_U PRIMARY KEY (ID) USING INDEX TABLESPACE USERS;",
                    "ALTER TABLE U ADD CONSTRAINT PK_U PRIMARY KEY (ID) ENABLE;",
                    'ALTER TABLE "U" ADD CONSTRAINT "PK_U" PRIMARY KEY ("ID")\n  USING INDEX PCTFREE 10 INITRANS 2 '
                    'MAXTRANS 255 COMPUTE STATISTICS\n  TABLESPACE "USERS"  ENABLE;'):
            cols, diagnostics = _fold_files([("s.sql", base + add)], "oracle", "fold-upper")
            self.assertEqual(_pk(cols, "U"), ["ID"], (add, diagnostics))
            self.assertEqual(_codes(diagnostics, "alter_unreadable"), [], add)

    def test_oracle_export_modify_not_null_enable_is_applied(self):
        base = "CREATE TABLE T (ID NUMBER NOT NULL, D VARCHAR2(10), PRIMARY KEY (ID));\n"
        for modify in ("ALTER TABLE T MODIFY D NOT NULL ENABLE;", 'ALTER TABLE "T" MODIFY ("D" NOT NULL ENABLE);'):
            cols, diagnostics = _fold_files([("s.sql", base + modify)], "oracle", "fold-upper")
            self.assertFalse(cols[("T", "D")]["nullable"], (modify, diagnostics))

    def test_drop_without_column_keyword_is_applied(self):
        cols, _ = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY, c INT, d INT);\n"
                                         "ALTER TABLE t DROP c;\nALTER TABLE t DROP IF EXISTS zz;")], "postgres")
        self.assertEqual(sorted(cols), [("t", "d"), ("t", "id")])
        # sqlglot keeps "c, DROP d" as the text of one clause: each is read on its own.
        cols, diagnostics = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY, c INT, d INT);\n"
                                                   "ALTER TABLE t DROP c, DROP d;")], "postgres")
        self.assertEqual(sorted(cols), [("t", "id")], diagnostics)
        base = "CREATE TABLE T (ID NUMBER NOT NULL, C NUMBER, D NUMBER, E NUMBER, PRIMARY KEY (ID));\n"
        cols, diagnostics = _fold_files([("s.sql", base + "ALTER TABLE T DROP (D);\n"
                                                          "ALTER TABLE T DROP (C, E) CASCADE CONSTRAINTS;")],
                                        "oracle", "fold-upper")
        self.assertEqual(sorted(cols), [("T", "ID")], diagnostics)

    def test_h2_alter_column_rename_to_renames_the_column(self):
        cols, _ = _fold_db([("s.sql", "CREATE TABLE t (id INT NOT NULL, c INT, PRIMARY KEY (id));\n"
                                      "ALTER TABLE t ALTER COLUMN c RENAME TO d;")], "", "h2", "fold-upper")
        self.assertEqual(sorted(cols), [("t", "d"), ("t", "id")])

    def test_mariadb_modify_column_if_exists_is_read(self):
        base = "CREATE TABLE t (id INT NOT NULL, c INT NOT NULL COMMENT 'cc', PRIMARY KEY (id));\n"
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t MODIFY COLUMN IF EXISTS c BIGINT;")],
                                     "mysql", "mariadb")
        self.assertEqual(cols[("t", "c")]["type"], "BIGINT")
        self.assertEqual(_codes(diagnostics, "column_unnamed"), [], "the name is c, not an expression")
        cols, _ = _fold_db([("s.sql", base + "ALTER TABLE t CHANGE COLUMN IF EXISTS c d BIGINT;")], "mysql", "mariadb")
        self.assertEqual(sorted(cols), [("t", "d"), ("t", "id")])
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t MODIFY COLUMN IF EXISTS zz BIGINT;")],
                                     "mysql", "mariadb")
        self.assertEqual(sorted(cols), [("t", "c"), ("t", "id")], "IF EXISTS adds nothing that is not there")
        self.assertIn("IF EXISTS", " ".join(_codes(diagnostics, "alter_unknown_column")))

    def test_a_column_option_the_grammar_splits_off_is_named_as_written(self):
        cols, diagnostics = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY, c INT);\n"
                                                   "ALTER TABLE t ALTER COLUMN c SET STATISTICS 100;")], "postgres")
        said = _codes(diagnostics, "alter_clause_unsupported")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("SET STATISTICS 100", said[0])
        self.assertNotIn("DEFAULT", said[0])



# ---------------------------------------------------------------------------
# A CREATE TABLE THE GRAMMAR CANNOT READ AS WRITTEN (catalog-ddl/10). An Oracle
# export writes how each constraint is checked and built (ENABLE, USING INDEX ...)
# and the table's physical attributes (PCTFREE, STORAGE, TABLESPACE ...). sqlglot
# either stops at them (a parse error) or keeps the whole statement as text, and
# the table was then gone without a word. What the catalog does not hold is set
# aside and said; a table that still cannot be read is named.
# ---------------------------------------------------------------------------

_ORACLE_EXPORT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "oracle_export")


def _export(name):
    with open(os.path.join(_ORACLE_EXPORT, name), encoding="utf-8") as fh:
        return fh.read()


def _fold_export(files, dialect="oracle", database=None, identifier_case="fold-upper"):
    diagnostics = []
    recs = catalog_ddl.parse_ddl_catalog_files(files, diagnostics=diagnostics, identifier_case=identifier_case,
                                               dialect=dialect, database=database)
    tables = [r["table"] for r in recs if r["kind"] == "table"]
    cols = {(r["table"], r["column"]): r for r in recs if r["kind"] == "column"}
    return tables, cols, diagnostics


class UnreadCreateTableTests(unittest.TestCase):
    def test_a_create_table_the_grammar_keeps_as_text_is_named_never_dropped_silently(self):
        # PostgreSQL's typed table has no column list this reader could read.
        tables, _, diagnostics = _fold_export([("m.sql", "CREATE TABLE t OF some_type;\nCREATE TABLE u (a INT);")],
                                              "postgres", identifier_case="fold-lower")
        self.assertEqual(tables, ["u"])
        said = _codes(diagnostics, "create_table_unreadable")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("CREATE TABLE t", said[0])

    def test_physical_attributes_after_the_column_list_are_set_aside_in_every_dialect(self):
        cases = (
            ("mysql", "CREATE TABLE t (a INT NOT NULL, PRIMARY KEY (a)) TABLESPACE ts STORAGE DISK;"),
            ("postgres", "CREATE TABLE t (a INT NOT NULL PRIMARY KEY) WITH (fillfactor=70) TABLESPACE ts;"),
            ("oracle", "CREATE TABLE T (A NUMBER NOT NULL PRIMARY KEY) ORGANIZATION INDEX;"),
            ("", "CREATE CACHED TABLE T (A INT NOT NULL PRIMARY KEY);"),
            ("", "CREATE MEMORY TABLE PUBLIC.T (A INT NOT NULL PRIMARY KEY);"),
        )
        for dialect, sql in cases:
            tables, cols, diagnostics = _fold_export([("s.sql", sql)], dialect)
            self.assertEqual(len(tables), 1, (sql, diagnostics))
            self.assertEqual([c for (t, c), r in cols.items() if r["pk"]], [tables[0] == "t" and "a" or "A"], sql)
            self.assertEqual(len(_codes(diagnostics, "create_clause_not_held")), 1, (sql, diagnostics))

    def test_a_constraint_the_catalog_holds_nothing_of_is_set_aside_last(self):
        # egovframe common components, script/ddl/mysql/com_DDL_mysql.sql: MySQL names a
        # foreign key after FOREIGN KEY, and sqlglot stops there. 54 of its 182 tables were lost.
        egov = ("CREATE TABLE COMTNROLES_HIERARCHY\n(\n\tPARNTS_ROLE VARCHAR(30) NOT NULL,\n\tCHLDRN_ROLE VARCHAR(30) NOT NULL,\n"
                "\t PRIMARY KEY (PARNTS_ROLE,CHLDRN_ROLE),\n\tFOREIGN KEY COMTNROLES_HIERARCHY_FK1 (PARNTS_ROLE) "
                "REFERENCES COMTNROLEINFO(ROLE_CODE)\n\t\tON DELETE CASCADE\n);\n")
        # jeecg-boot db/jeecgboot-mysql-5.7.sql:3061, its comments put in English: an index
        # with a comment of its own, which the salvage used to take for the table's.
        jeecg = ("CREATE TABLE `jimu_report_share`  (\n  `id` varchar(32) NOT NULL COMMENT 'primary key',\n"
                 "  `report_id` varchar(32) NULL DEFAULT NULL COMMENT 'report designer id',\n"
                 "  PRIMARY KEY (`id`) USING BTREE,\n  UNIQUE INDEX `uniq_jrs_report_id`(`report_id`) USING BTREE "
                 "COMMENT 'unique index on the report'\n"
                 ") ENGINE = InnoDB COMMENT = 'report preview shares' ROW_FORMAT = DYNAMIC;\n")
        for sql, table, pk in ((egov, "COMTNROLES_HIERARCHY", ["CHLDRN_ROLE", "PARNTS_ROLE"]), (jeecg, "jimu_report_share", ["id"])):
            diagnostics = []
            recs = catalog_ddl.parse_ddl_catalog_files([("s.sql", sql)], diagnostics=diagnostics, dialect="mysql")
            self.assertEqual([r["table"] for r in recs if r["kind"] == "table"], [table], diagnostics)
            self.assertEqual(sorted(r["column"] for r in recs if r["kind"] == "column" and r["pk"]), pk)
            said = _codes(diagnostics, "create_clause_not_held")
            self.assertEqual(len(said), 1, diagnostics)
            self.assertIn("FOREIGN KEY" if table.startswith("COMTN") else "UNIQUE", said[0])
        self.assertEqual([r["comment"] for r in recs if r["kind"] == "table"], ["report preview shares"])

    def test_an_hsqldb_script_with_a_statement_per_line_keeps_every_table(self):
        # egovframe common components, src/test/resources/egovframework/crypto/testdb.sql, lines 1-6:
        # no semicolons, so the grammar keeps it all as one text; the second table is not the first's attributes.
        script = ("-- Base Tables\n"
                  "CREATE MEMORY TABLE SAMPLE(ID VARCHAR(16) NOT NULL PRIMARY KEY,NAME VARCHAR(50),DESCRIPTION VARCHAR(100),"
                  "USE_YN CHAR(1),REG_USER VARCHAR(10))\n"
                  "CREATE MEMORY TABLE IDS(TABLE_NAME VARCHAR(16) NOT NULL PRIMARY KEY,NEXT_ID DECIMAL(30) NOT NULL)\n\n"
                  "SET SCHEMA PUBLIC\n"
                  "INSERT INTO SAMPLE VALUES('SAMPLE-00001','Runtime Environment','Foundation Layer','Y','eGov')\n")
        tables, cols, diagnostics = _fold_export([("testdb.sql", script)], "")
        self.assertEqual(sorted(tables), ["IDS", "SAMPLE"], diagnostics)
        self.assertEqual(_pk(cols, "IDS"), ["TABLE_NAME"])
        self.assertNotIn("INSERT", " ".join(_codes(diagnostics, "create_clause_not_held")))

    def test_a_table_that_cannot_be_read_is_named_once(self):
        # A type the grammar does not know is not set aside: the catalog holds types.
        sql = "CREATE TABLE a (x INT);\nCREATE TABLE b (x CHARACTER VARYING VARYING(10), CONSTRAINT q CHECK (x > 0) ENABLE);\n"
        diagnostics = []
        catalog_ddl.parse_ddl_catalog_files([("s.sql", sql)], diagnostics=diagnostics, dialect="oracle")
        self.assertEqual([d["table"] for d in diagnostics if d["code"] == "create_table_unreadable"], ["b"])

    def test_a_mysql_table_comment_after_the_list_is_kept(self):
        recs = catalog_ddl.parse_ddl_catalog_files(
            [("s.sql", "CREATE TABLE t (a INT) TABLESPACE ts STORAGE DISK COMMENT='orders';")], dialect="mysql")
        self.assertEqual([r["comment"] for r in recs if r["kind"] == "table"], ["orders"])


class OracleExportTests(unittest.TestCase):
    def test_dbms_metadata_output_is_read_whole(self):
        tables, cols, diagnostics = _fold_export([("export.sql", _export("dbms_metadata.sql"))])
        self.assertEqual(sorted(tables), ["DEPT", "PAYROLL_EMPS", "PAYROLL_TIMECARDS", "TIMECARDS"], diagnostics)
        self.assertEqual([c for (t, c) in cols if t == "TIMECARDS"], ["EMPLOYEE_ID", "WEEK", "JOB_ID", "HOURS_WORKED"])
        # NOT NULL ENABLE is NOT NULL; PRIMARY KEY (...) ENABLE is the key.
        self.assertFalse(cols[("PAYROLL_EMPS", "LASTNAME")]["nullable"])
        self.assertTrue(cols[("PAYROLL_EMPS", "MI")]["nullable"])
        self.assertEqual(_pk(cols, "PAYROLL_EMPS"), ["BADGE_NO"])
        # CONSTRAINT "PK_DEPT" PRIMARY KEY (...) USING INDEX ... ENABLE is the key too.
        self.assertEqual(_pk(cols, "DEPT"), ["DEPTNO"])
        self.assertEqual(cols[("DEPT", "DNAME")]["type"], "VARCHAR(14)")
        said = " ".join(_codes(diagnostics, "create_clause_not_held"))
        for word in ("ENABLE", "USING INDEX", "PCTFREE", "TABLESPACE"):
            self.assertIn(word, said)
        self.assertEqual(_codes(diagnostics, "create_table_unreadable") + _codes(diagnostics, "parse_error"), [])

    def test_the_reviewers_not_null_enable_and_the_alter_after_it(self):
        # Review 3, case Y10: the CREATE stopped the parse, and the ALTER after it found no table.
        y10 = 'CREATE TABLE "T" ("ID" NUMBER NOT NULL ENABLE, "D" VARCHAR2(10));\nALTER TABLE "T" MODIFY ("D" NOT NULL ENABLE);'
        tables, cols, diagnostics = _fold_export([("f.sql", y10)])
        self.assertEqual(tables, ["T"], diagnostics)
        self.assertFalse(cols[("T", "ID")]["nullable"])
        self.assertFalse(cols[("T", "D")]["nullable"])
        self.assertEqual(_codes(diagnostics, "alter_unknown_table"), [])

    def test_navicat_export_is_read_with_its_key_and_its_checks(self):
        tables, cols, diagnostics = _fold_export([("quartz.sql", _export("navicat_quartz.sql"))])
        self.assertEqual(tables, ["QRTZ_JOB_DETAILS"], diagnostics)
        self.assertEqual(len([c for (t, c) in cols]), 10)
        self.assertEqual(cols[("QRTZ_JOB_DETAILS", "SCHED_NAME")]["type"], "VARCHAR(120)", "as sqlglot writes VARCHAR2(120 BYTE)")
        self.assertTrue(cols[("QRTZ_JOB_DETAILS", "DESCRIPTION")]["nullable"])
        self.assertFalse(cols[("QRTZ_JOB_DETAILS", "IS_DURABLE")]["nullable"])
        self.assertEqual(_pk(cols, "QRTZ_JOB_DETAILS"), ["JOB_GROUP", "JOB_NAME", "SCHED_NAME"])
        # Each CHECK (... IS NOT NULL) NOT DEFERRABLE ... VALIDATE is read as a check, which holds nothing here.
        self.assertEqual(_codes(diagnostics, "alter_unreadable"), [])
        self.assertEqual(len(_codes(diagnostics, "alter_clause_unsupported")), 8)

    def test_a_disabled_constraint_is_not_read_and_is_said(self):
        sql = ('CREATE TABLE "T" ("A" NUMBER CONSTRAINT "NN_A" NOT NULL DISABLE, "B" NUMBER NOT NULL ENABLE,\n'
               ' CONSTRAINT "PK_T" PRIMARY KEY ("A") DISABLE) ;')
        tables, cols, diagnostics = _fold_export([("s.sql", sql)])
        self.assertEqual(tables, ["T"], diagnostics)
        self.assertTrue(cols[("T", "A")]["nullable"], "a disabled NOT NULL is not enforced")
        self.assertFalse(cols[("T", "B")]["nullable"])
        self.assertEqual(_pk(cols, "T"), [], "a disabled key is not enforced")
        self.assertEqual(len(_codes(diagnostics, "create_constraint_disabled")), 2, diagnostics)

    def test_a_file_that_reads_as_written_is_read_as_before(self):
        # Nothing is set aside where nothing needs to be.
        for sql, dialect in ((BASIC_DDL, "mysql"), ('CREATE TABLE "T" ("A" NUMBER, CONSTRAINT "PK" PRIMARY KEY ("A"));', "oracle")):
            diagnostics = []
            catalog_ddl.parse_ddl_catalog_files([("s.sql", sql)], diagnostics=diagnostics, dialect=dialect)
            self.assertEqual(_codes(diagnostics, "create_clause_not_held"), [], sql)


class AlterTableOptionTests(unittest.TestCase):
    def test_mysql_alter_table_comment_sets_the_table_comment(self):
        base = "CREATE TABLE t (id INT NOT NULL, PRIMARY KEY (id)) COMMENT='old';\n"
        for alter in ("ALTER TABLE t COMMENT = 'new one';", "ALTER TABLE t COMMENT 'new one', ENGINE=InnoDB;"):
            diagnostics = []
            recs = catalog_ddl.parse_ddl_catalog_files([("s.sql", base + alter)], diagnostics=diagnostics, dialect="mysql")
            self.assertEqual([r["comment"] for r in recs if r["kind"] == "table"], ["new one"], (alter, diagnostics))
            self.assertEqual(_codes(diagnostics, "alter_unreadable"), [], alter)

    def test_h2_alter_column_definition_changes_what_it_says(self):
        base = "CREATE TABLE t (id INT NOT NULL, c INT, d INT NOT NULL, PRIMARY KEY (id));\n"
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t ALTER COLUMN c BIGINT NOT NULL;")], "", "h2",
                                     "fold-upper")
        self.assertEqual(cols[("t", "c")]["type"], "BIGINT")
        self.assertFalse(cols[("t", "c")]["nullable"])
        self.assertEqual(_codes(diagnostics, "alter_unreadable"), [])
        # H2's manual does not say what the column definition form does with what it leaves out: kept, and said.
        # (A bare ``ALTER COLUMN d BIGINT`` parses as ``SET DATA TYPE`` does, and is read as that type change.)
        cols, diagnostics = _fold_db([("s.sql", base + "ALTER TABLE t ALTER COLUMN d BIGINT DEFAULT 0;")], "", "h2",
                                     "fold-upper")
        self.assertEqual(cols[("t", "d")]["type"], "BIGINT")
        self.assertFalse(cols[("t", "d")]["nullable"])
        self.assertEqual(len(_codes(diagnostics, "alter_modify_unsaid_unknown")), 1, diagnostics)


# ---------------------------------------------------------------------------
# REVIEW 4 (catalog-ddl/11). What the reader sets aside, and what it takes for a
# column, is decided by shapes it recognizes, never by a first word: a column
# named ``key`` is a column, and ``KEY idx (c)`` is an index whatever grammar
# read it. A CREATE TABLE in the file is read or named, whatever statement the
# grammar folded it into. A table a database reads in a compatibility mode is
# read the way that mode reads it, and said so.
# ---------------------------------------------------------------------------

def _tables(files, dialect, database=None, identifier_case="fold-upper", **kw):
    diagnostics = []
    recs = catalog_ddl.parse_ddl_catalog_files(files, diagnostics=diagnostics, identifier_case=identifier_case,
                                               dialect=dialect, database=database, **kw)
    tables = sorted(r["table"] for r in recs if r["kind"] == "table")
    cols = {(r["table"], r["column"]): r for r in recs if r["kind"] == "column"}
    return tables, cols, diagnostics


def _columns_of(cols, table):
    return [c for (t, c) in cols if t == table]


class Review4SetAsideTests(unittest.TestCase):
    def test_create_set_aside_keeps_a_column_named_like_a_constraint_word(self):
        # Review 4, D-2: the set-aside took the element's first word for a constraint, and a column
        # named key went, with the primary key it carried.
        cases = (
            ("postgres", "postgres", "CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL, "
                                     "CONSTRAINT ck CHECK (length(value) > 0) NO INHERIT);",
             "settings", ["key", "value"], ["key"]),
            ("", "hsqldb", "CREATE MEMORY TABLE PUBLIC.CONFIG(KEY VARCHAR(100) NOT NULL PRIMARY KEY,VALUE VARCHAR(200),"
                           "CONSTRAINT CK CHECK(VALUE IS NOT NULL) NOCHECK)",
             "CONFIG", ["KEY", "VALUE"], ["KEY"]),
            ("postgres", "postgres", "CREATE TABLE t (index int, c int, CONSTRAINT ck CHECK (c > 0) NO INHERIT);",
             "t", ["index", "c"], []),
            ("oracle", "oracle", "CREATE TABLE T (ID NUMBER NOT NULL ENABLE, KEY VARCHAR2(10), J CLOB, CONSTRAINT CK_J "
                                 "CHECK (J IS JSON) ENABLE, CONSTRAINT PK_T PRIMARY KEY (ID) ENABLE);",
             "T", ["ID", "KEY", "J"], ["ID"]),
            ("", "h2", "CREATE TABLE T (ID INT NOT NULL, KEY VARCHAR(10), CONSTRAINT CK CHECK (ID > 0) NOCHECK, "
                       "PRIMARY KEY (ID));",
             "T", ["ID", "KEY"], ["ID"]),
        )
        for dialect, database, sql, table, columns, pk in cases:
            tables, cols, diagnostics = _tables([("s.sql", sql)], dialect, database)
            self.assertEqual(tables, [table], (sql, diagnostics))
            self.assertEqual(_columns_of(cols, table), columns, (sql, diagnostics))
            self.assertEqual(_pk(cols, table), pk, sql)
            said = " ".join(_codes(diagnostics, "create_clause_not_held"))
            if "ENABLE" not in sql:
                self.assertIn("CHECK", said, sql)
            self.assertNotIn("KEY", said.replace("PRIMARY KEY", ""), sql)
            self.assertNotIn("INDEX", said, sql)

    def test_an_element_that_is_neither_a_column_nor_a_constraint_this_reader_knows_is_not_set_aside(self):
        # A shape the reader does not recognize is kept, and the table is named rather than read without it.
        sql = "CREATE TABLE t (a INT, PERIOD FOR valid (s, e) WHATEVER, CONSTRAINT ck CHECK (a > 0) NO INHERIT);"
        tables, _, diagnostics = _tables([("s.sql", sql)], "postgres", "postgres", "fold-lower")
        self.assertEqual(tables, [], diagnostics)
        self.assertEqual(len(_codes(diagnostics, "create_table_unreadable")), 1, diagnostics)

    def test_mysql_index_shapes_are_still_set_aside(self):
        sql = ("CREATE TABLE t (id INT NOT NULL, c INT, d TEXT, PRIMARY KEY (id), KEY idx_c (c) INVISIBLE, "
               "INDEX (c, id), FULLTEXT KEY ft (d) WITH PARSER ngram, UNIQUE KEY uk (c) USING BTREE, "
               "CONSTRAINT fk FOREIGN KEY (c) REFERENCES u (id) MATCH FULL ON DELETE CASCADE) ENGINE=InnoDB;")
        tables, cols, diagnostics = _tables([("s.sql", sql)], "mysql", "mysql", "fold-lower")
        self.assertEqual(tables, ["t"], diagnostics)
        self.assertEqual(_columns_of(cols, "t"), ["id", "c", "d"])
        self.assertEqual(_pk(cols, "t"), ["id"])


class Review4CompatibilityModeTests(unittest.TestCase):
    # dolphinscheduler-dao/src/main/resources/sql/dolphinscheduler_h2.sql, lines 349-360 and 271-289,
    # abridged: the file H2 runs in MODE=MySQL (the jdbc url beside it says so).
    SERIAL = ("CREATE TABLE `t_ds_serial_command` (\n"
              "   `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'primary key',\n"
              "   `workflow_instance_id` bigint(20) NOT NULL COMMENT 'workflow instance id',\n"
              "   `update_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n"
              "   PRIMARY KEY (`id`),\n"
              "   KEY `idx_workflow_instance_id` (`workflow_instance_id`)\n"
              ") ENGINE = InnoDB\n  DEFAULT CHARSET = utf8;\n")
    ALERT = ("CREATE TABLE t_ds_alert\n(\n    id            int(11) NOT NULL AUTO_INCREMENT,\n"
             "    sign           char(40) NOT NULL DEFAULT '',\n    PRIMARY KEY (id),\n    KEY            idx_sign (sign)\n);\n")

    def test_h2_catalog_reads_or_names_mysql_mode_create_table(self):
        # Review 4, D-1: read with H2's own grammar, the MySQL-mode table was lost.
        tables, cols, diagnostics = _tables([("ds_h2.sql", self.ALERT + self.SERIAL)], "", "h2", "fold-upper")
        self.assertEqual(tables, ["t_ds_alert", "t_ds_serial_command"], diagnostics)
        self.assertEqual(_columns_of(cols, "t_ds_serial_command"), ["id", "workflow_instance_id", "update_time"])
        self.assertEqual(_pk(cols, "t_ds_serial_command"), ["id"])
        self.assertEqual(cols[("t_ds_serial_command", "id")]["comment"], "primary key")
        said = _codes(diagnostics, "create_read_in_mode")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("MySQL", said[0])
        self.assertIn("t_ds_serial_command", said[0])
        self.assertEqual(_codes(diagnostics, "create_table_unreadable"), [])

    def test_an_index_the_grammar_reads_as_a_column_is_not_a_column(self):
        # H2's own grammar reads MySQL's KEY idx_sign (sign) as a column named KEY of type idx_sign(sign).
        tables, cols, diagnostics = _tables([("ds_h2.sql", self.ALERT)], "", "h2", "fold-upper")
        self.assertEqual(_columns_of(cols, "t_ds_alert"), ["id", "sign"], diagnostics)
        said = " ".join(_codes(diagnostics, "create_clause_not_held"))
        self.assertIn("KEY", said)
        # A column named KEY with a type is a column.
        _, cols, _ = _tables([("s.sql", "CREATE TABLE t (KEY VARCHAR(10), VALUE INT)")], "", "h2", "fold-upper")
        self.assertEqual(_columns_of(cols, "t"), ["KEY", "VALUE"])

    def test_a_database_with_no_mode_names_what_its_grammar_cannot_read(self):
        # PostgreSQL has no MySQL mode: the backquoted table is named, not read by another grammar.
        tables, _, diagnostics = _tables([("s.sql", "CREATE TABLE a (x INT);\n" + self.SERIAL)], "postgres", "postgres",
                                         "fold-lower")
        self.assertEqual(tables, ["a"], diagnostics)
        self.assertEqual(_codes(diagnostics, "create_read_in_mode"), [])
        self.assertEqual(len(_codes(diagnostics, "create_table_unreadable")), 1, diagnostics)


class Review4EveryCreateTableTests(unittest.TestCase):
    HS = ("SET DATABASE UNIQUE NAME HSQLDB8A1B2C3D4E\n"
          "SET DATABASE SQL SYNTAX ORA FALSE\n"
          "CREATE USER SA PASSWORD DIGEST 'd41d8cd98f00b204e9800998ecf8427e'\n"
          "CREATE SCHEMA PUBLIC AUTHORIZATION DBA\n"
          "CREATE MEMORY TABLE PUBLIC.OWNERS(ID INTEGER GENERATED BY DEFAULT AS IDENTITY(START WITH 1) NOT NULL "
          "PRIMARY KEY,FIRST_NAME VARCHAR(30),NOTE VARCHAR(40) DEFAULT 'x\nUPDATE y')\n"
          "ALTER TABLE PUBLIC.OWNERS ALTER COLUMN ID RESTART WITH 11\n"
          "CREATE MEMORY TABLE PUBLIC.PETS(ID INTEGER NOT NULL PRIMARY KEY,NAME VARCHAR(30),OWNER_ID INTEGER,"
          "CONSTRAINT FK_PETS_OWNERS FOREIGN KEY(OWNER_ID) REFERENCES PUBLIC.OWNERS(ID))\n"
          "CREATE INDEX IDX ON PUBLIC.PETS(NAME)\n"
          "SET TABLE PUBLIC.PETS INDEX '1 0'\n"
          "GRANT DBA TO SA\n"
          "SET SCHEMA PUBLIC\n"
          "INSERT INTO OWNERS VALUES(1,'George','x')\n")

    def test_hsqldb_script_with_leading_set_statements_is_read_or_named(self):
        # Review 4, D-3: the grammar keeps the whole script as the text of its first SET, and both tables went.
        tables, cols, diagnostics = _tables([("app.script", self.HS)], "", "hsqldb", "fold-upper")
        self.assertEqual(tables, ["OWNERS", "PETS"], diagnostics)
        self.assertEqual(_columns_of(cols, "OWNERS"), ["ID", "FIRST_NAME", "NOTE"])
        self.assertEqual(_pk(cols, "PETS"), ["ID"])

    def test_a_create_table_folded_into_another_statement_is_named(self):
        # Whatever a grammar folds a CREATE TABLE into, the table is read or named: never gone without a word.
        for sql, dialect in (("CREATE TABLE a (x INT);\nSET @x = 1\nCREATE TABLE b (y INT);\n", "mysql"),
                             ("CREATE TABLE a (x INT);\nCREATE INDEX i ON a (x)\nCREATE TABLE b (y INT);\n", "mysql"),
                             ("CREATE TABLE a (x INT);\nCREATE VIEW v AS SELECT 1\nCREATE TABLE b (y INT);\n", "postgres"),
                             ("CREATE TABLE a (x INT);\nSELECT 1\nCREATE TABLE b (y INT);\n", "mysql")):
            tables, _, diagnostics = _tables([("s.sql", sql)], dialect, dialect, "fold-lower")
            named = [d["table"] for d in diagnostics if d["code"] in ("create_table_unreadable", "create_table_unread")]
            self.assertEqual(sorted(set(tables) | set(named)), ["a", "b"], (sql, diagnostics))
            if "b" not in tables:
                self.assertIn("line 3", " ".join(_codes(diagnostics, "create_table_unread")), sql)
        # A CREATE TABLE in a comment or a string declares nothing, and nothing is said of it.
        sql = "-- CREATE TABLE c (z INT)\nCREATE TABLE a (x VARCHAR(40) DEFAULT 'CREATE TABLE d (w INT)');\n"
        _, _, diagnostics = _tables([("s.sql", sql)], "mysql", "mysql", "fold-lower")
        self.assertEqual(_codes(diagnostics, "create_table_unread"), [])


class Review4InheritsTests(unittest.TestCase):
    def test_postgres_inherits_columns_are_read_or_said(self):
        # Review 4, D-4: a child table holds its parents' columns, before its own.
        for child in ("CREATE TABLE child (c int) INHERITS (parent);",
                      "CREATE TABLE child (c int, CONSTRAINT ck CHECK (c > 0) NO INHERIT) INHERITS (parent);"):
            tables, cols, diagnostics = _tables([("m.sql", "CREATE TABLE parent (a int NOT NULL PRIMARY KEY, b int);\n"
                                                           + child)], "postgres", "postgres", "fold-lower")
            self.assertEqual(tables, ["child", "parent"], diagnostics)
            self.assertEqual(_columns_of(cols, "child"), ["a", "b", "c"], (child, diagnostics))
            self.assertFalse(cols[("child", "a")]["nullable"], "NOT NULL is inherited")
            self.assertEqual(_pk(cols, "child"), [], "a primary key is not inherited")
            self.assertNotIn("INHERITS", " ".join(_codes(diagnostics, "create_clause_not_held")), child)
        # A column the child restates is one column, where the parent put it.
        _, cols, _ = _tables([("m.sql", "CREATE TABLE p (a int, b int);\nCREATE TABLE c (b int NOT NULL, d int) "
                                        "INHERITS (p);")], "postgres", "postgres", "fold-lower")
        self.assertEqual(_columns_of(cols, "c"), ["a", "b", "d"])
        self.assertFalse(cols[("c", "b")]["nullable"])
        # A parent no file declared: the child's own columns, and the gap said.
        tables, cols, diagnostics = _tables([("m.sql", "CREATE TABLE c (d int) INHERITS (elsewhere);")], "postgres",
                                            "postgres", "fold-lower")
        self.assertEqual(_columns_of(cols, "c"), ["d"])
        self.assertEqual(len(_codes(diagnostics, "create_parent_unknown")), 1, diagnostics)


class Review4AssumedDatabaseTests(unittest.TestCase):
    BASE = "CREATE TABLE t (id INT NOT NULL, c INT NOT NULL, d INT NOT NULL, PRIMARY KEY (id), KEY k (d));\n"

    def test_an_undeclared_database_reads_by_the_assumed_rule_and_says_so(self):
        # Design 4: MySQL is the default when sqlDialects.main is not declared. What rests on one of its
        # rules is still read that way, and said to rest on an assumption.
        cols, diagnostics = _fold_db([("s.sql", self.BASE + "ALTER TABLE t MODIFY c BIGINT;")], "mysql", "mysql")
        self.assertTrue(cols[("t", "c")]["nullable"])
        self.assertEqual(_codes(diagnostics, "alter_rule_assumed"), [], "declared, MySQL's rule is known")
        _, cols, diagnostics = _tables([("s.sql", self.BASE + "ALTER TABLE t MODIFY c BIGINT;")], "mysql", "mysql",
                                       "fold-lower", database_assumed=True)
        self.assertTrue(cols[("t", "c")]["nullable"])
        said = _codes(diagnostics, "alter_rule_assumed")
        self.assertEqual(len(said), 1, diagnostics)
        self.assertIn("sqlDialects.main", said[0])
        _, cols, diagnostics = _tables([("s.sql", self.BASE + "ALTER TABLE t DROP INDEX `PRIMARY`;")], "mysql", "mysql",
                                       "fold-lower", database_assumed=True)
        self.assertEqual(_pk(cols, "t"), [])
        self.assertEqual(len(_codes(diagnostics, "alter_rule_assumed")), 1, diagnostics)
        # A drop that leaves the key rests on the key's assumed name too.
        _, cols, diagnostics = _tables([("s.sql", self.BASE + "ALTER TABLE t DROP INDEX k;")], "mysql", "mysql",
                                       "fold-lower", database_assumed=True)
        self.assertEqual(_pk(cols, "t"), ["id"])
        self.assertEqual(len(_codes(diagnostics, "alter_rule_assumed")), 1, diagnostics)
        # A statement no rule decides says nothing more.
        _, _, diagnostics = _tables([("s.sql", self.BASE + "ALTER TABLE t MODIFY c BIGINT NOT NULL;")], "mysql",
                                    "mysql", "fold-lower", database_assumed=True)
        self.assertEqual(_codes(diagnostics, "alter_rule_assumed"), [])

    def test_the_command_line_says_the_database_is_assumed(self):
        import contextlib
        import io
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as fh:
            fh.write(self.BASE + "ALTER TABLE t MODIFY c BIGINT;")
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(catalog_ddl.main(["--database-assumed", fh.name]), 0)
        finally:
            os.unlink(fh.name)
        self.assertIn("alter_rule_assumed", err.getvalue())


class Review4ClauseTests(unittest.TestCase):
    def test_a_clause_that_cannot_be_read_is_quoted_as_written(self):
        # Review 4, D-6: the diagnostic quoted a MODIFY the file never wrote.
        _, diagnostics = _fold_files([("m.sql", "CREATE TABLE t (id INT PRIMARY KEY, c INT);\n"
                                                "ALTER TABLE t ALTER COLUMN c RESET (n_distinct);")], "postgres")
        said = " ".join(_codes(diagnostics, "alter_unreadable") + _codes(diagnostics, "alter_clause_unsupported"))
        self.assertIn("RESET", said, diagnostics)
        self.assertNotIn("MODIFY", said)

    def test_h2_drop_column_of_a_list_drops_each(self):
        # Review 4: H2's DROP COLUMN (c, d).
        cols, diagnostics = _fold_db([("s.sql", "CREATE TABLE t (id INT NOT NULL, c INT, d INT, PRIMARY KEY (id));\n"
                                                "ALTER TABLE t DROP COLUMN (c, d);")], "", "h2", "fold-upper")
        self.assertEqual(sorted(cols), [("t", "id")], diagnostics)


if __name__ == "__main__":
    unittest.main()
