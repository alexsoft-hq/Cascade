"""Stored routines: what a procedure or a function runs, and a call read through it."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import catalog_ddl  # noqa: E402
import lineage  # noqa: E402
from routines import embedded_statements, extract_routines, is_pure_call, routine_names_in  # noqa: E402

PG_DDL = """
CREATE TABLE app.orders (order_id integer NOT NULL, status character varying(10), total numeric);
CREATE TABLE app.order_log (log_id integer, order_id integer, note text);

-- the two routines a mapper calls
CREATE FUNCTION app.p_close_order(p_order_id integer, OUT p_result character varying) RETURNS character varying
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_status VARCHAR(10);
BEGIN
  SELECT status INTO v_status FROM orders WHERE order_id = p_order_id;
  IF v_status = 'OPEN' THEN
    UPDATE orders SET status = 'CLOSED' WHERE order_id = p_order_id;
  END IF;
  SELECT app.f_log(p_order_id, 'closed') INTO p_result;
END;
$$;

CREATE FUNCTION app.f_log(p_order_id integer, p_note text) RETURNS character varying
    LANGUAGE plpgsql
    AS $body$
BEGIN
  FOR r IN SELECT order_id FROM orders WHERE order_id = p_order_id LOOP
    INSERT INTO order_log (order_id, note) VALUES (r.order_id, p_note);
  END LOOP;
  PERFORM app.p_close_order(p_order_id);  -- a cycle, stopped by name
  RETURN 'OK';
END;
$body$;
"""

ORACLE_DDL = """
CREATE OR REPLACE PROCEDURE SP_CLOSE (P_ID IN NUMBER) IS
  V_CNT NUMBER;
BEGIN
  SELECT COUNT(*) INTO V_CNT FROM TB_ORDER WHERE ORDER_ID = P_ID;
  UPDATE TB_ORDER SET STATUS = 'C' WHERE ORDER_ID = P_ID;
END SP_CLOSE;
/
CREATE OR REPLACE PACKAGE BODY PKG_ORDER IS
  PROCEDURE P_SAVE(P_ID IN NUMBER) IS
  BEGIN
    INSERT INTO TB_ORDER (ORDER_ID) VALUES (P_ID);
  END P_SAVE;
  FUNCTION F_COUNT RETURN NUMBER IS
    V NUMBER;
  BEGIN
    SELECT COUNT(*) INTO V FROM TB_ORDER;
    RETURN V;
  END F_COUNT;
END PKG_ORDER;
/
"""


class ExtractRoutinesTests(unittest.TestCase):
    def test_a_postgres_function_is_read_with_its_dollar_quoted_body_and_language(self):
        rs = extract_routines(PG_DDL, "schema.sql")
        self.assertEqual([r["name"] for r in rs], ["app.f_log", "app.p_close_order"])
        close = rs[1]
        self.assertEqual((close["routineKind"], close["language"]), ("function", "plpgsql"))
        self.assertIn("UPDATE orders SET status", close["body"])
        self.assertNotIn("$$", close["body"])

    def test_an_oracle_procedure_and_the_routines_of_a_package_body_are_read(self):
        names = [r["name"] for r in extract_routines(ORACLE_DDL)]
        self.assertEqual(names, ["PKG_ORDER.F_COUNT", "PKG_ORDER.P_SAVE", "SP_CLOSE"])

    def test_a_comment_or_a_string_that_says_create_function_is_not_a_routine(self):
        text = "-- CREATE FUNCTION fake() AS $$ SELECT 1 $$;\nSELECT 'CREATE FUNCTION x() AS $$ y $$';"
        self.assertEqual(extract_routines(text), [])


class EmbeddedStatementsTests(unittest.TestCase):
    def test_every_statement_a_body_runs_comes_out_of_the_control_flow_around_it(self):
        body = extract_routines(PG_DDL)[1]["body"]
        got = [(k, " ".join(s.split())) for s, k, _ in embedded_statements(body)]
        self.assertEqual(got, [
            # PL/SQL's own INTO clause is not SQL, and it is taken out.
            ("select", "SELECT status FROM orders WHERE order_id = p_order_id"),
            ("update", "UPDATE orders SET status = 'CLOSED' WHERE order_id = p_order_id"),
            # A SELECT with no FROM assigns a value and reads no table.
            ("select", "SELECT app.f_log(p_order_id, 'closed')"),
        ])

    def test_a_loop_s_query_and_the_statement_inside_the_loop_are_two_statements(self):
        body = extract_routines(PG_DDL)[0]["body"]
        got = [(k, " ".join(s.split())) for s, k, _ in embedded_statements(body)]
        self.assertEqual([k for k, _ in got], ["select", "insert"])
        self.assertEqual(got[0][1], "SELECT order_id FROM orders WHERE order_id = p_order_id")
        self.assertTrue(got[1][1].startswith("INSERT INTO order_log (order_id, note) VALUES"))


class CallsTests(unittest.TestCase):
    def test_the_names_a_statement_calls_are_read_in_every_call_spelling(self):
        self.assertEqual(routine_names_in("{call p_close_order(?, ?)}"), ["p_close_order"])
        self.assertEqual(routine_names_in("{ ? = call PKG_ORDER.F_COUNT }"), ["PKG_ORDER.F_COUNT"])
        self.assertEqual(routine_names_in("CALL app.p_close_order(1)"), ["app.p_close_order"])
        self.assertIn("f_log", routine_names_in("SELECT f_log(1, 'x') FROM dual"))

    def test_a_pure_call_is_told_apart_from_sql_that_calls_a_function(self):
        self.assertTrue(is_pure_call("{call p_close_order(?)}"))
        self.assertTrue(is_pure_call("BEGIN PKG_ORDER.P_SAVE(1); END;"))
        self.assertFalse(is_pure_call("SELECT f_log(1, 'x')"))


class LineageThroughRoutinesTests(unittest.TestCase):
    def setUp(self):
        self.catalog = catalog_ddl.parse_ddl_catalog_files(
            [("schema.sql", PG_DDL)], diagnostics=[], identifier_case="fold-lower", dialect="postgres")
        self.index = lineage.build_schema_index(self.catalog, "fold-lower")

    def _one(self, sql, stype="update"):
        recs = lineage.analyze_stream(
            [{"kind": "statement", "namespace": "OrderMapper", "id": "close", "type": stype, "sql": sql}],
            self.index, dialect="postgres", routine_index=lineage.build_routine_index(self.catalog))
        return recs[1]

    def test_the_catalog_parses_in_the_declared_dialect_and_carries_the_routines(self):
        kinds = [r["kind"] for r in self.catalog]
        self.assertEqual(kinds.count("table"), 2)
        self.assertEqual(kinds.count("routine"), 2)
        self.assertEqual(self.catalog[0]["dialect"], "postgres")

    def test_a_call_reaches_the_tables_of_the_routine_and_of_what_the_routine_calls(self):
        rec = self._one("{call p_close_order(?, ?)}")
        tables = {(t["table"], t["access"], t.get("via")) for t in rec["tables"]}
        self.assertEqual(tables, {
            ("orders", "read", "routine"), ("orders", "write", "routine"), ("order_log", "write", "routine"),
        })
        self.assertEqual([(r["name"], r["depth"]) for r in rec["routines"]],
                         [("app.p_close_order", 1), ("app.f_log", 2)])
        # The call itself is no SQL a parser reads, and no parse failure is recorded for it.
        self.assertEqual(rec["unresolved"], [])

    def test_a_statement_that_calls_no_routine_is_what_it_was(self):
        rec = self._one("SELECT status FROM orders WHERE order_id = 1", "select")
        self.assertNotIn("routines", rec)
        self.assertTrue(all("via" not in t for t in rec["tables"]))


if __name__ == "__main__":
    unittest.main()
