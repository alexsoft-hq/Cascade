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
        self.assertEqual(catalog_ddl.CATALOG_VERSION, "catalog-ddl/3")
        self.assertEqual(
            catalog_ddl.parse_ddl_catalog(self.HSQLDB_DDL)[0]["version"],
            "catalog-ddl/3",
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


if __name__ == "__main__":
    unittest.main()


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
