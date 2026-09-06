#!/usr/bin/env python3
"""Unit tests for adapters/sql/lineage.py (SQL lineage resolver, piece 3 of 3).

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_lineage -v
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import lineage  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures — a tiny inline catalog (piece-1 record shape), no dependency on
# mall.sql. Three tables: pms_product(id, name, price),
# oms_order(id, status, delivery_sn), oms_order_item(id, order_id, product_id).
# ---------------------------------------------------------------------------

CATALOG_RECORDS = [
    {"kind": "header", "schema": "cascade:catalog-snapshot:1", "tables": 3,
     "columns": 9, "commented": 0, "source": None, "dialect": "mysql"},

    {"kind": "table", "schema": None, "table": "pms_product", "comment": None},
    {"kind": "column", "schema": None, "table": "pms_product", "column": "id",
     "type": "BIGINT", "nullable": False, "comment": None, "ordinal": 1},
    {"kind": "column", "schema": None, "table": "pms_product", "column": "name",
     "type": "VARCHAR(64)", "nullable": True, "comment": None, "ordinal": 2},
    {"kind": "column", "schema": None, "table": "pms_product", "column": "price",
     "type": "DECIMAL(10,2)", "nullable": True, "comment": None, "ordinal": 3},

    {"kind": "table", "schema": None, "table": "oms_order", "comment": None},
    {"kind": "column", "schema": None, "table": "oms_order", "column": "id",
     "type": "BIGINT", "nullable": False, "comment": None, "ordinal": 1},
    {"kind": "column", "schema": None, "table": "oms_order", "column": "status",
     "type": "INT", "nullable": True, "comment": None, "ordinal": 2},
    {"kind": "column", "schema": None, "table": "oms_order", "column": "delivery_sn",
     "type": "VARCHAR(64)", "nullable": True, "comment": None, "ordinal": 3},

    {"kind": "table", "schema": None, "table": "oms_order_item", "comment": None},
    {"kind": "column", "schema": None, "table": "oms_order_item", "column": "id",
     "type": "BIGINT", "nullable": False, "comment": None, "ordinal": 1},
    {"kind": "column", "schema": None, "table": "oms_order_item", "column": "order_id",
     "type": "BIGINT", "nullable": False, "comment": None, "ordinal": 2},
    {"kind": "column", "schema": None, "table": "oms_order_item", "column": "product_id",
     "type": "BIGINT", "nullable": False, "comment": None, "ordinal": 3},
]

SCHEMA_INDEX = lineage.build_schema_index(CATALOG_RECORDS)


def _col_tuples(result):
    """{(table, column, access), ...} from an analyze_statement() result."""
    return {(c["table"], c["column"], c["access"]) for c in result["columns"]}


def _tbl_tuples(result):
    """{(table, access), ...} from an analyze_statement() result."""
    return {(t["table"], t["access"]) for t in result["tables"]}


def _unres_reasons(result):
    return {u["reason"] for u in result["unresolved"]}


def _join_tuples(result):
    """{(l.table, l.column, r.table, r.column, kind), ...} from a result."""
    return {
        (j["left"]["table"], j["left"]["column"],
         j["right"]["table"], j["right"]["column"], j["kind"])
        for j in result["joins"]
    }


def _dumps(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class SchemaIndexTests(unittest.TestCase):
    """build_schema_index() over the inline catalog fixture."""

    def test_tables_set_has_bare_names(self):
        self.assertEqual(
            SCHEMA_INDEX["tables"],
            {"pms_product", "oms_order", "oms_order_item"},
        )

    def test_columns_view_preserves_declaration_order(self):
        self.assertEqual(
            SCHEMA_INDEX["columns"]["pms_product"], ["id", "name", "price"]
        )
        self.assertEqual(
            SCHEMA_INDEX["columns"]["oms_order"],
            ["id", "status", "delivery_sn"],
        )

    def test_sqlglot_view_maps_column_to_type(self):
        self.assertEqual(
            SCHEMA_INDEX["sqlglot"]["pms_product"]["price"], "DECIMAL(10,2)"
        )


class SelectTests(unittest.TestCase):
    def test_select_read_marks_table_and_all_referenced_columns_as_read(self):
        result = lineage.analyze_statement(
            "SELECT id, price FROM pms_product WHERE name = 'x'",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(_tbl_tuples(result), {("pms_product", "read")})
        self.assertEqual(
            _col_tuples(result),
            {
                ("pms_product", "id", "read"),
                ("pms_product", "price", "read"),
                ("pms_product", "name", "read"),
            },
        )
        self.assertFalse(any(c["access"] == "write" for c in result["columns"]))
        self.assertEqual(result["unresolved"], [])


class InsertTests(unittest.TestCase):
    def test_insert_with_column_list_marks_table_and_listed_columns_as_write(self):
        result = lineage.analyze_statement(
            "INSERT INTO pms_product (name, price) VALUES (?, ?)",
            "insert", SCHEMA_INDEX,
        )
        self.assertEqual(_tbl_tuples(result), {("pms_product", "write")})
        self.assertEqual(
            _col_tuples(result),
            {("pms_product", "name", "write"), ("pms_product", "price", "write")},
        )
        # No column is read: VALUES holds only placeholders, no source SELECT.
        self.assertFalse(any(c["access"] == "read" for c in result["columns"]))
        self.assertEqual(result["unresolved"], [])


class UpdateTests(unittest.TestCase):
    def test_update_set_is_write_where_is_read(self):
        result = lineage.analyze_statement(
            "UPDATE pms_product SET price = ? WHERE id = ?",
            "update", SCHEMA_INDEX,
        )
        self.assertEqual(_tbl_tuples(result), {("pms_product", "write")})
        cols = _col_tuples(result)
        self.assertIn(("pms_product", "price", "write"), cols)
        self.assertIn(("pms_product", "id", "read"), cols)
        # The invariant under test: SET's column is never also a read, and
        # WHERE's column is never also a write.
        self.assertNotIn(("pms_product", "price", "read"), cols)
        self.assertNotIn(("pms_product", "id", "write"), cols)
        self.assertEqual(result["unresolved"], [])


class DeleteTests(unittest.TestCase):
    def test_delete_never_produces_a_column_write(self):
        """Reference invariant: DELETE ... WHERE writes no columns at all."""
        result = lineage.analyze_statement(
            "DELETE FROM pms_product WHERE id = ?", "delete", SCHEMA_INDEX,
        )
        self.assertEqual(_tbl_tuples(result), {("pms_product", "delete")})
        self.assertEqual(_col_tuples(result), {("pms_product", "id", "read")})
        self.assertEqual(
            [c for c in result["columns"] if c["access"] == "write"], []
        )
        self.assertEqual(result["unresolved"], [])


class JoinAttributionTests(unittest.TestCase):
    def test_join_columns_attributed_to_the_correct_side(self):
        result = lineage.analyze_statement(
            "SELECT o.status, oi.product_id FROM oms_order o "
            "JOIN oms_order_item oi ON o.id = oi.order_id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _tbl_tuples(result),
            {("oms_order", "read"), ("oms_order_item", "read")},
        )
        cols = _col_tuples(result)
        self.assertIn(("oms_order", "status", "read"), cols)
        self.assertIn(("oms_order_item", "product_id", "read"), cols)
        # Not swapped to the other table.
        self.assertNotIn(("oms_order_item", "status", "read"), cols)
        self.assertNotIn(("oms_order", "product_id", "read"), cols)
        self.assertEqual(result["unresolved"], [])


class JoinRelationshipTests(unittest.TestCase):
    """The additive `joins` key: cross-table equi-join relationships an ERD can
    draw when the DB itself declares no foreign keys."""

    def test_explicit_on_join_yields_one_relationship(self):
        result = lineage.analyze_statement(
            "SELECT o.status, oi.product_id FROM oms_order o "
            "JOIN oms_order_item oi ON o.id = oi.order_id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _join_tuples(result),
            {("oms_order", "id", "oms_order_item", "order_id", "on")},
        )
        self.assertEqual(result["joinsDropped"], 0)

    def test_three_table_chain_yields_pairwise_relationships(self):
        result = lineage.analyze_statement(
            "SELECT o.id FROM oms_order o "
            "JOIN oms_order_item oi ON o.id = oi.order_id "
            "JOIN pms_product p ON oi.product_id = p.id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _join_tuples(result),
            {
                ("oms_order", "id", "oms_order_item", "order_id", "on"),
                ("oms_order_item", "product_id", "pms_product", "id", "on"),
            },
        )
        self.assertEqual(result["joinsDropped"], 0)

    def test_implicit_where_equi_join_is_kind_where(self):
        result = lineage.analyze_statement(
            "SELECT o.id, oi.product_id FROM oms_order o, oms_order_item oi "
            "WHERE o.id = oi.order_id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _join_tuples(result),
            {("oms_order", "id", "oms_order_item", "order_id", "where")},
        )
        self.assertEqual(result["joinsDropped"], 0)

    def test_literal_and_same_table_on_predicates_are_not_relationships(self):
        # `o.status = 5` (literal) and `oi.product_id = oi.id` (same table) are
        # not cross-table joins and must not be emitted — nor counted as drops.
        result = lineage.analyze_statement(
            "SELECT o.id FROM oms_order o "
            "JOIN oms_order_item oi ON oi.order_id = o.id "
            "AND o.status = 5 AND oi.product_id = oi.id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _join_tuples(result),
            {("oms_order", "id", "oms_order_item", "order_id", "on")},
        )
        self.assertEqual(result["joinsDropped"], 0)

    def test_unresolved_table_join_is_dropped_and_counted_not_emitted(self):
        # `unknown_t` is absent from the catalog: the p.id = u.pid predicate is a
        # genuine col=col join we cannot resolve — dropped (fail-closed), counted,
        # never guessed into the output.
        result = lineage.analyze_statement(
            "SELECT p.id FROM pms_product p "
            "JOIN unknown_t u ON p.id = u.pid",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(_join_tuples(result), set())
        self.assertEqual(result["joinsDropped"], 1)

    def test_no_joins_yields_empty_list(self):
        result = lineage.analyze_statement(
            "SELECT id FROM pms_product WHERE id = 1", "select", SCHEMA_INDEX,
        )
        self.assertEqual(result["joins"], [])
        self.assertEqual(result["joinsDropped"], 0)

    def test_joins_are_deterministic_across_two_runs(self):
        sql = ("SELECT o.id FROM oms_order o "
               "JOIN oms_order_item oi ON o.id = oi.order_id "
               "JOIN pms_product p ON oi.product_id = p.id")
        r1 = lineage.analyze_statement(sql, "select", SCHEMA_INDEX)
        r2 = lineage.analyze_statement(sql, "select", SCHEMA_INDEX)
        self.assertEqual(r1["joins"], r2["joins"])
        self.assertEqual(_dumps(r1["joins"]), _dumps(r2["joins"]))

    def test_join_record_has_the_documented_shape(self):
        result = lineage.analyze_statement(
            "SELECT o.id FROM oms_order o "
            "JOIN oms_order_item oi ON o.id = oi.order_id",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(len(result["joins"]), 1)
        rel = result["joins"][0]
        self.assertEqual(set(rel.keys()), {"left", "right", "kind"})
        self.assertEqual(set(rel["left"].keys()), {"schema", "table", "column"})
        self.assertEqual(set(rel["right"].keys()), {"schema", "table", "column"})
        self.assertIn(rel["kind"], ("on", "where"))
        self.assertIsNone(rel["left"]["schema"])  # this DB qualifies nothing


class StarExpansionTests(unittest.TestCase):
    def test_star_expands_to_catalog_columns(self):
        result = lineage.analyze_statement(
            "SELECT o.* FROM oms_order o", "select", SCHEMA_INDEX,
        )
        self.assertEqual(_tbl_tuples(result), {("oms_order", "read")})
        self.assertEqual(
            _col_tuples(result),
            {
                ("oms_order", "id", "read"),
                ("oms_order", "status", "read"),
                ("oms_order", "delivery_sn", "read"),
            },
        )
        # No literal '*' leaked through as a fake column.
        self.assertFalse(any(c["column"] == "*" for c in result["columns"]))


class UnresolvedFailClosedTests(unittest.TestCase):
    def test_ambiguous_bare_column_across_two_tables_is_not_guessed(self):
        """A bare column with two candidate tables in scope must not be
        silently attributed to either one.

        Actual observed behavior (verified by direct run, not assumed):
        sqlglot's qualify() itself raises on the ambiguous bare `id`
        (recorded as 'qualify_failed'), and the best-effort unqualified
        fallback walk then also records it as 'unqualified_column' — both
        are recorded, neither invents a table for it. The ON-clause's
        `o.id` / `oi.order_id` are alias-qualified and thus unambiguous;
        those legitimately resolve to their real tables.
        """
        result = lineage.analyze_statement(
            "SELECT id FROM oms_order o "
            "JOIN oms_order_item oi ON o.id = oi.order_id",
            "select", SCHEMA_INDEX,
        )
        reasons = _unres_reasons(result)
        self.assertIn("unqualified_column", reasons)
        detail_texts = [u["detail"] for u in result["unresolved"]
                        if u["reason"] == "unqualified_column"]
        self.assertTrue(any("id" in d and "no resolvable table" in d
                            for d in detail_texts))
        # The bare projected `id` produced no guessed column entry; only the
        # two alias-qualified ON-clause references resolved.
        self.assertEqual(
            _col_tuples(result),
            {
                ("oms_order", "id", "read"),
                ("oms_order_item", "order_id", "read"),
            },
        )

    def test_column_not_in_catalog_table_is_unresolved_not_dropped(self):
        result = lineage.analyze_statement(
            "SELECT bogus_col FROM pms_product", "select", SCHEMA_INDEX,
        )
        # Table access is still recorded (table-level access is not gated on
        # column resolution); the unknown column itself is fail-closed.
        self.assertEqual(_tbl_tuples(result), {("pms_product", "read")})
        self.assertEqual(_col_tuples(result), set())
        self.assertIn("column_unknown_in_table", _unres_reasons(result))

    def test_table_not_in_catalog_is_unresolved_not_dropped(self):
        result = lineage.analyze_statement(
            "SELECT id FROM unknown_table", "select", SCHEMA_INDEX,
        )
        # sqlglot still reports table-level access for a table sqlglot can
        # see in the SQL even though it's absent from the catalog; only the
        # column fact is withheld.
        self.assertEqual(_tbl_tuples(result), {("unknown_table", "read")})
        self.assertEqual(_col_tuples(result), set())
        self.assertIn("table_not_in_catalog", _unres_reasons(result))


class QualifyFallbackTests(unittest.TestCase):
    def test_unresolvable_substitution_token_does_not_crash(self):
        """Mimics piece-2's MyBatis ${} placeholder output (__subst__).
        Must not raise; the single resolvable column still comes through,
        and the unresolvable token is recorded, not silently dropped."""
        result = lineage.analyze_statement(
            "SELECT id FROM pms_product WHERE ( __subst__ )",
            "select", SCHEMA_INDEX,
        )
        self.assertIsInstance(result, dict)
        self.assertEqual(_tbl_tuples(result), {("pms_product", "read")})
        self.assertIn(("pms_product", "id", "read"), _col_tuples(result))
        self.assertIn("unqualified_column", _unres_reasons(result))

    def test_garbage_sql_does_not_crash_and_is_recorded_as_parse_failed(self):
        result = lineage.analyze_statement(
            "!!! not sql at all ///", "select", SCHEMA_INDEX,
        )
        self.assertIsInstance(result, dict)
        self.assertEqual(result["tables"], [])
        self.assertEqual(result["columns"], [])
        self.assertEqual(_unres_reasons(result), {"parse_failed"})

    def test_empty_sql_does_not_crash(self):
        result = lineage.analyze_statement("", "select", SCHEMA_INDEX)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["tables"], [])
        self.assertEqual(result["columns"], [])
        self.assertEqual(_unres_reasons(result), {"parse_failed"})


class AnalyzeStreamTests(unittest.TestCase):
    STATEMENTS = [
        {"kind": "header", "schema": "cascade:sqlstmts:1"},
        {"kind": "statement", "namespace": "ProductMapper", "id": "selectById",
         "type": "select", "sql": "SELECT id, price FROM pms_product WHERE id = ?",
         "file": "ProductMapper.xml", "line": 10},
        {"kind": "statement", "namespace": "ProductMapper", "id": "insertOne",
         "type": "insert", "sql": "INSERT INTO pms_product (name, price) VALUES (?, ?)",
         "file": "ProductMapper.xml", "line": 20},
        {"kind": "statement", "namespace": "OrderMapper", "id": "deleteById",
         "type": "delete", "sql": "DELETE FROM oms_order WHERE id = ?",
         "file": "OrderMapper.xml", "line": 5},
    ]

    def test_header_is_first_record_with_expected_schema_and_counts(self):
        records = lineage.analyze_stream(self.STATEMENTS, SCHEMA_INDEX)
        header = records[0]
        self.assertEqual(header["kind"], "header")
        self.assertEqual(header["schema"], lineage.SQLFACTS_SCHEMA)
        self.assertEqual(header["statements"], 3)
        self.assertEqual(header["tableFacts"], 3)  # one table touched per stmt
        self.assertEqual(header["columnFacts"], 5)  # 2 (select) + 2 (insert) + 1 (delete)
        self.assertEqual(header["unresolvedColumns"], 0)

    def test_non_statement_records_are_skipped_and_none_dropped(self):
        # 3 statement records in (the leading 'header' record is not a
        # 'statement' and must be ignored) -> exactly 3 lineage records out.
        records = lineage.analyze_stream(self.STATEMENTS, SCHEMA_INDEX)
        lineage_records = [r for r in records if r["kind"] == "lineage"]
        self.assertEqual(len(lineage_records), 3)
        self.assertEqual(len(records), 4)  # header + 3 lineage

    def test_header_and_records_carry_join_tallies(self):
        stmts = [
            {"kind": "statement", "namespace": "OrderMapper", "id": "listWithItems",
             "type": "select",
             "sql": "SELECT o.status, oi.product_id FROM oms_order o "
                    "JOIN oms_order_item oi ON o.id = oi.order_id",
             "file": "OrderMapper.xml", "line": 30},
        ]
        records = lineage.analyze_stream(stmts, SCHEMA_INDEX)
        header = records[0]
        self.assertEqual(header["joinFacts"], 1)
        self.assertEqual(header["unresolvedJoins"], 0)
        lineage_rec = records[1]
        self.assertIn("joins", lineage_rec)
        self.assertEqual(len(lineage_rec["joins"]), 1)
        # The internal joinsDropped tally never leaks into the emitted record.
        self.assertNotIn("joinsDropped", lineage_rec)

    def test_lineage_record_carries_through_identity_fields(self):
        records = lineage.analyze_stream(self.STATEMENTS, SCHEMA_INDEX)
        by_id = {r["id"]: r for r in records if r["kind"] == "lineage"}
        rec = by_id["selectById"]
        self.assertEqual(rec["namespace"], "ProductMapper")
        self.assertEqual(rec["type"], "select")
        self.assertEqual(rec["file"], "ProductMapper.xml")
        self.assertEqual(rec["line"], 10)
        self.assertEqual(
            {(t["table"], t["access"]) for t in rec["tables"]},
            {("pms_product", "read")},
        )
        delete_rec = by_id["deleteById"]
        self.assertEqual(
            {(t["table"], t["access"]) for t in delete_rec["tables"]},
            {("oms_order", "delete")},
        )


class DeterminismTests(unittest.TestCase):
    def test_analyze_statement_is_deterministic(self):
        sql = ("SELECT o.status, oi.product_id FROM oms_order o "
              "JOIN oms_order_item oi ON o.id = oi.order_id")
        r1 = lineage.analyze_statement(sql, "select", SCHEMA_INDEX)
        r2 = lineage.analyze_statement(sql, "select", SCHEMA_INDEX)
        self.assertEqual(r1, r2)

    def test_tables_and_columns_are_sorted_within_a_record(self):
        result = lineage.analyze_statement(
            "SELECT o.* FROM oms_order o", "select", SCHEMA_INDEX,
        )
        col_names = [c["column"] for c in result["columns"]]
        self.assertEqual(col_names, sorted(col_names))

    def test_duplicate_column_references_are_deduplicated(self):
        result = lineage.analyze_statement(
            "SELECT id, id, price FROM pms_product WHERE id = 1",
            "select", SCHEMA_INDEX,
        )
        self.assertEqual(
            _col_tuples(result),
            {("pms_product", "id", "read"), ("pms_product", "price", "read")},
        )
        self.assertEqual(len(result["columns"]), 2)

    def test_analyze_stream_twice_is_byte_identical(self):
        records1 = lineage.analyze_stream(
            AnalyzeStreamTests.STATEMENTS, SCHEMA_INDEX
        )
        records2 = lineage.analyze_stream(
            AnalyzeStreamTests.STATEMENTS, SCHEMA_INDEX
        )
        self.assertEqual(records1, records2)
        d1 = [_dumps(r) for r in records1]
        d2 = [_dumps(r) for r in records2]
        self.assertEqual(d1, d2)


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# Dialect + default schema (SPEC §6.2 sqlDialects / schema.default)
# ---------------------------------------------------------------------------

class DialectArgumentTests(unittest.TestCase):
    """The dialect is an ARGUMENT now, not a hardcoded 'mysql' in two places."""

    def test_default_is_mysql_and_backticks_still_parse(self):
        r = lineage.analyze_statement(
            "SELECT `id` FROM `pms_product`", "select", SCHEMA_INDEX)
        self.assertEqual(r["tables"], [{"table": "pms_product", "access": "read"}])
        self.assertEqual(lineage.DEFAULT_DIALECT, "mysql")

    def test_a_named_dialect_is_what_actually_parses_the_statement(self):
        # Double-quoted identifiers are STRINGS in MySQL and IDENTIFIERS in
        # postgres; the two dialects therefore disagree about this statement,
        # which is what proves the argument reaches sqlglot.
        sql = 'SELECT "id" FROM pms_product'
        as_mysql = lineage.analyze_statement(sql, "select", SCHEMA_INDEX, dialect="mysql")
        as_pg = lineage.analyze_statement(sql, "select", SCHEMA_INDEX, dialect="postgres")
        self.assertEqual(
            as_pg["columns"], [{"table": "pms_product", "column": "id", "access": "read"}])
        self.assertNotEqual(as_mysql["columns"], as_pg["columns"])

    def test_analyze_stream_threads_the_dialect_and_the_default_schema(self):
        stmts = [{"kind": "statement", "namespace": "M", "id": "s", "type": "select",
                  "sql": 'SELECT "id" FROM pms_product', "file": "M.xml", "line": 1}]
        pg = lineage.analyze_stream(stmts, SCHEMA_INDEX, dialect="postgres")
        self.assertEqual(pg[0]["columnFacts"], 1)
        my = lineage.analyze_stream(stmts, SCHEMA_INDEX, dialect="mysql")
        self.assertEqual(my[0]["columnFacts"], 0)
        # --default-schema is no longer a dead argument: it reaches qualify.
        with_db = lineage.analyze_stream(stmts, SCHEMA_INDEX, dialect="postgres",
                                         default_schema="mall")
        self.assertEqual(with_db[0]["statements"], 1)


class CarriedFlagTests(unittest.TestCase):
    """Piece 2's own honesty flags ride through to the graph bridge."""

    STATEMENTS = [
        {"kind": "statement", "namespace": "M", "id": "subst", "type": "select",
         "sql": "SELECT id FROM pms_product ORDER BY __subst__",
         "hasStringSubst": True, "schemaUnknown": False, "file": "M.xml", "line": 1},
        {"kind": "statement", "namespace": "M", "id": "plain", "type": "select",
         "sql": "SELECT id FROM pms_product", "file": "M.xml", "line": 2},
        {"kind": "statement", "namespace": "M", "id": "noschema", "type": "select",
         "sql": "SELECT id FROM pms_product", "schemaUnknown": True,
         "file": "M.xml", "line": 3},
    ]

    def test_flags_are_carried_not_re_derived(self):
        by_id = {r["id"]: r for r in lineage.analyze_stream(self.STATEMENTS, SCHEMA_INDEX)
                 if r["kind"] == "lineage"}
        self.assertTrue(by_id["subst"]["hasStringSubst"])
        self.assertFalse(by_id["subst"]["schemaUnknown"])
        # A record that carries no flag reports False, never a missing key.
        self.assertFalse(by_id["plain"]["hasStringSubst"])
        self.assertFalse(by_id["plain"]["schemaUnknown"])
        self.assertTrue(by_id["noschema"]["schemaUnknown"])


# ---------------------------------------------------------------------------
# Identifier identity (RM12). The catalog and the SQL do not have to agree on
# case for the two to name the same table — the dialect says whether they do.
# ---------------------------------------------------------------------------

# The SAME three tables as CATALOG_RECORDS, declared in UPPER case, the way an
# Oracle or HSQLDB DDL dump writes them.
UPPER_CATALOG = [
    {"kind": "table", "schema": None, "table": "PMS_PRODUCT", "comment": None},
    {"kind": "column", "schema": None, "table": "PMS_PRODUCT", "column": "ID",
     "type": "NUMBER", "nullable": False, "comment": None, "ordinal": 1},
    {"kind": "column", "schema": None, "table": "PMS_PRODUCT", "column": "PRICE",
     "type": "NUMBER(10,2)", "nullable": True, "comment": None, "ordinal": 2},
]


class IdentifierCaseTests(unittest.TestCase):
    """Upper DDL + lower SQL, lower DDL + upper SQL — both must resolve, and
    both must print the name the CATALOG declared."""

    def test_upper_case_ddl_and_lower_case_sql_resolve_to_the_upper_names(self):
        idx = lineage.build_schema_index(UPPER_CATALOG, "fold-upper")
        result = lineage.analyze_statement(
            "select price from pms_product where id = 1", "select", idx,
            dialect="oracle")
        self.assertEqual(_tbl_tuples(result), {("PMS_PRODUCT", "read")})
        self.assertEqual(_col_tuples(result), {
            ("PMS_PRODUCT", "PRICE", "read"), ("PMS_PRODUCT", "ID", "read")})
        self.assertEqual(result["unresolved"], [])

    def test_lower_case_ddl_and_upper_case_sql_resolve_to_the_lower_names(self):
        idx = lineage.build_schema_index(CATALOG_RECORDS, "fold-lower")
        result = lineage.analyze_statement(
            "SELECT PRICE FROM PMS_PRODUCT WHERE ID = 1", "select", idx,
            dialect="mysql")
        self.assertEqual(_tbl_tuples(result), {("pms_product", "read")})
        self.assertEqual(_col_tuples(result), {
            ("pms_product", "price", "read"), ("pms_product", "id", "read")})
        self.assertEqual(result["unresolved"], [])

    def test_the_fold_DIRECTION_does_not_change_the_facts(self):
        # Same catalog, same SQL, opposite folds: identical output. The fold
        # decides what MATCHES; the printed name always comes from the catalog.
        sql = "SELECT PRICE FROM PMS_PRODUCT WHERE id = 1"
        lower = lineage.analyze_statement(
            sql, "select", lineage.build_schema_index(CATALOG_RECORDS, "fold-lower"))
        upper = lineage.analyze_statement(
            sql, "select", lineage.build_schema_index(CATALOG_RECORDS, "fold-upper"))
        self.assertEqual(lower, upper)
        self.assertEqual(_col_tuples(lower), {
            ("pms_product", "price", "read"), ("pms_product", "id", "read")})

    def test_exact_is_the_default_and_keeps_the_two_spellings_apart(self):
        idx = lineage.build_schema_index(CATALOG_RECORDS)
        self.assertEqual(idx["identifierCase"], "exact")
        result = lineage.analyze_statement(
            "SELECT PRICE FROM PMS_PRODUCT", "select", idx, dialect="mysql")
        # The table is not the catalog's: it is recorded as written and the
        # column is unresolved, which is exactly the defect RM12 fixes.
        self.assertEqual(_tbl_tuples(result), {("PMS_PRODUCT", "read")})
        self.assertEqual(_col_tuples(result), set())
        self.assertIn("table_not_in_catalog", _unres_reasons(result))

    def test_star_expands_under_a_fold_and_keeps_catalog_spellings(self):
        idx = lineage.build_schema_index(UPPER_CATALOG, "fold-upper")
        result = lineage.analyze_statement(
            "select * from pms_product", "select", idx, dialect="oracle")
        self.assertEqual(_col_tuples(result), {
            ("PMS_PRODUCT", "ID", "read"), ("PMS_PRODUCT", "PRICE", "read")})

    def test_writes_and_joins_use_the_catalog_spelling_too(self):
        idx = lineage.build_schema_index(CATALOG_RECORDS, "fold-upper")
        ins = lineage.analyze_statement(
            "INSERT INTO PMS_PRODUCT (ID, NAME) VALUES (1, 'x')", "insert", idx)
        self.assertEqual(_tbl_tuples(ins), {("pms_product", "write")})
        self.assertEqual(_col_tuples(ins), {
            ("pms_product", "id", "write"), ("pms_product", "name", "write")})
        joined = lineage.analyze_statement(
            "SELECT O.ID FROM OMS_ORDER O, OMS_ORDER_ITEM I "
            "WHERE O.ID = I.ORDER_ID", "select", idx)
        self.assertEqual(_join_tuples(joined), {
            ("oms_order", "id", "oms_order_item", "order_id", "where")})

    def test_a_table_the_catalog_lacks_is_STILL_unresolved_under_a_fold(self):
        # Folding must reduce the unresolved rate because names genuinely match,
        # never because the comparison got loose (§3.3).
        idx = lineage.build_schema_index(CATALOG_RECORDS, "fold-lower")
        result = lineage.analyze_statement(
            "SELECT ID FROM PMS_PRODUKT", "select", idx)
        self.assertEqual(_tbl_tuples(result), {("PMS_PRODUKT", "read")})
        self.assertEqual(_col_tuples(result), set())
        self.assertIn("table_not_in_catalog", _unres_reasons(result))

    def test_an_unknown_table_keeps_the_spelling_the_statement_used(self):
        idx = lineage.build_schema_index(CATALOG_RECORDS, "fold-lower")
        result = lineage.analyze_statement(
            "SELECT ID FROM MixedCaseThing", "select", idx)
        self.assertEqual(_tbl_tuples(result), {("MixedCaseThing", "read")})

    def test_a_quoted_identifier_is_exact_even_under_a_fold(self):
        idx = lineage.build_schema_index(UPPER_CATALOG, "fold-upper")
        # The catalog declares PMS_PRODUCT; a quoted reference to that exact
        # spelling matches, and a quoted reference to another case does not.
        ok = lineage.analyze_statement(
            'SELECT "PRICE" FROM "PMS_PRODUCT"', "select", idx, dialect="")
        self.assertEqual(_col_tuples(ok), {("PMS_PRODUCT", "PRICE", "read")})
        self.assertEqual(ok["unresolved"], [])
        nope = lineage.analyze_statement(
            'SELECT "price" FROM "pms_product"', "select", idx, dialect="")
        self.assertEqual(_tbl_tuples(nope), {("pms_product", "read")})
        self.assertEqual(_col_tuples(nope), set())
        self.assertIn("table_not_in_catalog", _unres_reasons(nope))

    def test_a_folded_collision_is_reported_and_the_first_declaration_wins(self):
        two = [
            {"kind": "table", "schema": None, "table": "Item", "comment": None},
            {"kind": "column", "schema": None, "table": "Item", "column": "Id",
             "type": "INT", "ordinal": 1},
            {"kind": "table", "schema": None, "table": "ITEM", "comment": None},
            {"kind": "column", "schema": None, "table": "ITEM", "column": "ID",
             "type": "INT", "ordinal": 1},
        ]
        diags = []
        idx = lineage.build_schema_index(two, "fold-upper", diagnostics=diags)
        self.assertEqual(idx["collisions"], [
            {"kind": "table", "key": "ITEM", "kept": "Item", "dropped": "ITEM"},
        ])
        self.assertEqual([d["code"] for d in diags],
                         ["folded_identifier_collision"])
        self.assertEqual(diags[0]["level"], "warn")
        self.assertIn("NOT merged into it", diags[0]["message"])
        # One matching key, the FIRST declaration's spelling.
        self.assertEqual(idx["tables"], {"ITEM"})
        self.assertEqual(idx["display"]["ITEM"], "Item")
        # Under the exact rule the same catalog is simply two tables.
        exact_diags = []
        exact = lineage.build_schema_index(two, "exact", diagnostics=exact_diags)
        self.assertEqual(exact["collisions"], [])
        self.assertEqual(exact_diags, [])
        self.assertEqual(exact["tables"], {"Item", "ITEM"})

    def test_two_columns_of_one_table_that_fold_together_collide(self):
        one = [
            {"kind": "table", "schema": None, "table": "t", "comment": None},
            {"kind": "column", "schema": None, "table": "t", "column": "Id",
             "type": "INT", "ordinal": 1},
            {"kind": "column", "schema": None, "table": "t", "column": "ID",
             "type": "INT", "ordinal": 2},
        ]
        diags = []
        idx = lineage.build_schema_index(one, "fold-lower", diagnostics=diags)
        self.assertEqual(idx["collisions"], [
            {"kind": "column", "key": "t.id", "kept": "Id", "dropped": "ID"},
        ])
        self.assertEqual(idx["columns"]["t"], ["id"])
        self.assertEqual(len(diags), 1)

    def test_the_index_carries_the_rule_so_the_walk_cannot_disagree(self):
        idx = lineage.build_schema_index(CATALOG_RECORDS, "fold-upper")
        self.assertEqual(idx["identifierCase"], "fold-upper")
        with self.assertRaises(ValueError):
            lineage.build_schema_index(CATALOG_RECORDS, "lowercase")

    def test_the_cli_default_comes_from_the_dialect(self):
        # No --identifier-case: mysql's declared rule is used, and it is stated
        # in the summary rather than left for the reader to assume.
        self.assertEqual(lineage.identifier_case_for_dialect("mysql"), "fold-lower")
        self.assertEqual(lineage.identifier_case_for_dialect("oracle"), "fold-upper")
