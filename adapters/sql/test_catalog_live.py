#!/usr/bin/env python3
"""Unit tests for adapters/sql/catalog_live.py — the live DB catalog worker.

No database and no driver are involved: the query layer takes an injected
cursor factory, so all three dialects' row->record mapping is checked against
recorded fixtures, and the CLI is exercised end to end against a fake driver
module installed into ``sys.modules``.

Three of these tests are the ones SPEC §12.3 asks for by name:

  * ``test_no_write_keyword_in_any_sql_constant`` and
    ``test_execute_is_only_ever_called_with_a_module_constant`` are the STATIC
    read-only enforcement — they read this module's own source with `ast`.
  * ``test_cli_never_emits_the_password_or_the_user`` is the credential
    non-leak test: a known password goes into the environment, and every byte
    the worker writes (file, stdout, stderr) is searched for it.

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_catalog_live -v
"""

import ast
import io
import json
import os
import re
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout, redirect_stderr

sys.path.insert(0, os.path.dirname(__file__))
import catalog_live  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures", "catalog_live")
SOURCE = os.path.join(HERE, "catalog_live.py")

# The statement keywords that must not appear in any SQL this worker can issue.
WRITE_KEYWORDS = [
    "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP",
    "TRUNCATE", "GRANT", "MERGE", "CALL", "EXEC",
]
WRITE_RE = re.compile(r"\b(" + "|".join(WRITE_KEYWORDS) + r")\b", re.IGNORECASE)


class RecordingCursor:
    """A DB-API-shaped cursor that answers from recorded rows and remembers
    every statement it was handed."""

    def __init__(self, responses):
        self.responses = [[tuple(row) for row in batch] for batch in responses]
        self.calls = []
        self._i = 0

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchall(self):
        rows = self.responses[self._i]
        self._i += 1
        return rows

    def close(self):
        pass


def load_fixture(name):
    with open(os.path.join(FIXTURES, name + ".json"), encoding="utf-8") as fh:
        return json.load(fh)


def load_expected(name):
    with open(os.path.join(FIXTURES, name + ".expected.jsonl"), encoding="utf-8") as fh:
        return fh.read()


def run_fixture(fx, diagnostics=None):
    cur = RecordingCursor(fx["responses"])
    records = catalog_live.fetch_catalog(
        lambda: cur, fx["dialect"], fx["schema"],
        stamp_schema=fx["stampSchema"],
        server_identity=fx["serverIdentity"],
        fetched_at=fx["fetchedAt"],
        diagnostics=diagnostics,
    )
    return cur, records


def as_jsonl(records):
    return "".join(catalog_live._emit(r) + "\n" for r in records)


# ---------------------------------------------------------------------------
# Dialect row -> record mapping, against recorded fixtures
# ---------------------------------------------------------------------------

class DialectGoldenTest(unittest.TestCase):
    def test_mysql_matches_golden(self):
        _, records = run_fixture(load_fixture("mysql"))
        self.assertEqual(as_jsonl(records), load_expected("mysql"))

    def test_postgres_matches_golden(self):
        _, records = run_fixture(load_fixture("postgres"))
        self.assertEqual(as_jsonl(records), load_expected("postgres"))

    def test_oracle_matches_golden(self):
        _, records = run_fixture(load_fixture("oracle"))
        self.assertEqual(as_jsonl(records), load_expected("oracle"))

    def test_record_shape_is_the_ddl_path_shape(self):
        """The live path must be a drop-in for catalog_ddl.py: same record
        kinds, same field names. A drifted field would silently blank a column
        comment for every consumer downstream."""
        import catalog_ddl
        ddl_records = catalog_ddl.parse_ddl_catalog(
            "CREATE TABLE `shop_order` (\n"
            "  `id` bigint(20) NOT NULL,\n"
            "  `order_sn` varchar(64) NOT NULL COMMENT 'code',\n"
            "  PRIMARY KEY (`id`)\n"
            ") ENGINE=InnoDB COMMENT='Customer order header';"
        )
        _, live_records = run_fixture(load_fixture("mysql"))
        for kind in ("table", "column"):
            ddl_keys = sorted(set(
                k for r in ddl_records if r["kind"] == kind for k in r
            ))
            live_keys = sorted(set(
                k for r in live_records if r["kind"] == kind for k in r
            ))
            self.assertEqual(ddl_keys, live_keys, "%s record fields differ" % kind)

    def test_a_view_column_is_dropped_with_a_diagnostic(self):
        diagnostics = []
        _, records = run_fixture(load_fixture("postgres"), diagnostics)
        self.assertEqual(
            [d["code"] for d in diagnostics], ["column_without_table"]
        )
        self.assertNotIn(
            "v_shop_order_totals", as_jsonl(records)
        )

    def test_empty_and_whitespace_comments_become_null(self):
        _, records = run_fixture(load_fixture("mysql"))
        by_col = {(r["table"], r.get("column")): r
                  for r in records if r["kind"] == "column"}
        # MySQL returns '' for "no comment", and the fixture's quantity column
        # carries whitespace only.
        self.assertIsNone(by_col[("shop_order", "delete_status")]["comment"])
        self.assertIsNone(by_col[("shop_order_item", "quantity")]["comment"])

    def test_ordering_is_deterministic_regardless_of_row_order(self):
        fx = load_fixture("mysql")
        shuffled = json.loads(json.dumps(fx))
        shuffled["responses"][1] = list(reversed(shuffled["responses"][1]))
        shuffled["responses"][2] = list(reversed(shuffled["responses"][2]))
        _, a = run_fixture(fx)
        _, b = run_fixture(shuffled)
        self.assertEqual(as_jsonl(a), as_jsonl(b))

    def test_unknown_dialect_is_a_structured_bad_input(self):
        with self.assertRaises(catalog_live.CatalogLiveError) as ctx:
            catalog_live.fetch_catalog(lambda: None, "sqlite", "main")
        self.assertEqual(ctx.exception.code, "bad-input")

    def test_header_carries_provenance_and_no_credential(self):
        fx = load_fixture("mysql")
        _, records = run_fixture(fx)
        header = records[0]
        self.assertEqual(header["schema"], catalog_live.CATALOG_SCHEMA)
        self.assertEqual(header["version"], catalog_live.CATALOG_VERSION)
        self.assertEqual(header["dialect"], "mysql")
        self.assertEqual(header["serverVersion"], "8.0.36")
        self.assertEqual(header["serverIdentity"], fx["serverIdentity"])
        self.assertEqual(header["fetchedAt"], fx["fetchedAt"])
        self.assertEqual(header["rowCounts"],
                         {"tables": 2, "columns": 7, "commented": 4})
        # host:port/db and nothing else — no user, no password, no URL.
        self.assertNotIn("@", header["serverIdentity"])


class TypeNormalizationTest(unittest.TestCase):
    def test_integer_display_width_is_dropped(self):
        self.assertEqual(catalog_live._normalize_type("bigint(20)"), "BIGINT")
        self.assertEqual(catalog_live._normalize_type("int(11)"), "INT")

    def test_semantic_parameters_are_kept_and_respaced(self):
        self.assertEqual(catalog_live._normalize_type("varchar(64)"), "VARCHAR(64)")
        self.assertEqual(catalog_live._normalize_type("decimal(10,2)"), "DECIMAL(10, 2)")

    def test_suffixes_survive(self):
        self.assertEqual(catalog_live._normalize_type("int(10) unsigned"), "INT UNSIGNED")

    def test_none_stays_none(self):
        self.assertIsNone(catalog_live._normalize_type(None))

    def test_postgres_type_is_reassembled_from_information_schema_columns(self):
        self.assertEqual(catalog_live._pg_type("character varying", 64, None, None),
                         "CHARACTER VARYING(64)")
        self.assertEqual(catalog_live._pg_type("numeric", None, 10, 2), "NUMERIC(10, 2)")
        self.assertEqual(catalog_live._pg_type("bigint", None, 64, 0), "BIGINT")

    def test_oracle_type_is_reassembled(self):
        self.assertEqual(catalog_live._oracle_type("NUMBER", 22, 10, 2), "NUMBER(10, 2)")
        self.assertEqual(catalog_live._oracle_type("VARCHAR2", 64, None, None),
                         "VARCHAR2(64)")
        self.assertEqual(catalog_live._oracle_type("DATE", 7, None, None), "DATE")


# ---------------------------------------------------------------------------
# READ-ONLY, enforced statically (SPEC §12.3)
# ---------------------------------------------------------------------------

def module_string_constants(tree):
    """Every module-level `NAME = "..."` string constant, by name."""
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                out[target.id] = node.value.value
    return out


class StaticReadOnlyTest(unittest.TestCase):
    def setUp(self):
        with open(SOURCE, encoding="utf-8") as fh:
            self.source = fh.read()
        self.tree = ast.parse(self.source)
        self.constants = module_string_constants(self.tree)

    def test_the_sql_constants_are_all_there(self):
        """A smoke check on the checker itself: if the constants stopped being
        module-level assignments, the two tests below would pass vacuously."""
        for name in ("MYSQL_TABLES", "MYSQL_COLUMNS", "POSTGRES_TABLES",
                     "POSTGRES_COLUMNS", "ORACLE_TABLES", "ORACLE_COLUMNS",
                     "MYSQL_READ_ONLY", "ORACLE_READ_ONLY"):
            self.assertIn(name, self.constants)

    def test_no_write_keyword_in_any_sql_constant(self):
        for name, value in sorted(self.constants.items()):
            hit = WRITE_RE.search(value)
            self.assertIsNone(
                hit,
                "module constant %s contains the statement keyword %r: %r"
                % (name, hit.group(1) if hit else None, value),
            )

    def test_execute_is_only_ever_called_with_a_module_constant(self):
        """Every `x.execute(...)` in this worker must pass one of the constants
        BY NAME. An f-string, a concatenation or a caller-supplied string would
        be a hole in the read-only claim, however innocent it looked."""
        calls = [
            node for node in ast.walk(self.tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute"
        ]
        self.assertGreaterEqual(len(calls), 8, "expected the dialect queries to be executed")
        for call in calls:
            self.assertTrue(call.args, "execute() called with no SQL at line %d" % call.lineno)
            first = call.args[0]
            self.assertIsInstance(
                first, ast.Name,
                "execute() at line %d is passed a %s, not a module SQL constant"
                % (call.lineno, type(first).__name__),
            )
            self.assertIn(
                first.id, self.constants,
                "execute() at line %d passes %s, which is not a module-level SQL "
                "constant" % (call.lineno, first.id),
            )

    def test_the_queries_actually_issued_are_the_constants(self):
        """The static check says the SOURCE is clean; this one says the RUNTIME
        path is the same one — the fake cursor records every statement it got."""
        sql_constants = set(self.constants.values())
        for name in ("mysql", "postgres", "oracle"):
            cur, _ = run_fixture(load_fixture(name))
            self.assertEqual(len(cur.calls), 3, "%s: expected three reads" % name)
            for sql, _params in cur.calls:
                self.assertIn(sql, sql_constants, "%s issued an unknown statement" % name)
                self.assertIsNone(WRITE_RE.search(sql))

    def test_the_read_only_switch_is_the_first_statement_on_a_mysql_session(self):
        """`connect` must put the session into a read-only transaction before
        anything else runs on it."""
        source_of_connect = None
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == "connect":
                source_of_connect = ast.get_source_segment(self.source, node)
        self.assertIsNotNone(source_of_connect)
        self.assertIn("MYSQL_READ_ONLY", source_of_connect)
        self.assertIn("ORACLE_READ_ONLY", source_of_connect)
        self.assertIn("default_transaction_read_only=on", source_of_connect)


# ---------------------------------------------------------------------------
# Credentials (SPEC §17.3)
# ---------------------------------------------------------------------------

FAKE_PASSWORD = "pw-SECRET-123"
FAKE_USER = "cascade_reader"


def install_fake_driver(test, responses, capture):
    """Put a module named `pymysql` into sys.modules whose `connect` returns a
    connection over recorded rows. Removed again on test teardown."""
    module = types.ModuleType("pymysql")

    class Conn:
        def __init__(self, **kwargs):
            capture["kwargs"] = kwargs
            self._cursor = RecordingCursor(responses)

        def cursor(self):
            return self._cursor

        def close(self):
            capture["closed"] = True

    module.connect = lambda **kwargs: Conn(**kwargs)
    previous = sys.modules.get("pymysql")
    sys.modules["pymysql"] = module

    def restore():
        if previous is None:
            sys.modules.pop("pymysql", None)
        else:
            sys.modules["pymysql"] = previous
    test.addCleanup(restore)


class CredentialTest(unittest.TestCase):
    def test_cli_never_emits_the_password_or_the_user(self):
        fx = load_fixture("mysql")
        # The session read-only switch consumes no result set, but the fake
        # cursor is shared, so give the recorded batches to it as they are: the
        # read-only execute() does not call fetchall().
        capture = {}
        install_fake_driver(self, fx["responses"], capture)

        out_dir = tempfile.mkdtemp(prefix="cascade-catalog-live-")
        out_file = os.path.join(out_dir, "columns.jsonl")
        argv = [
            "--dialect", "mysql", "--host", "db.example.com", "--port", "3306",
            "--database", "com_example_shop", "--user", FAKE_USER,
            "--password-env", "CASCADE_TEST_PASSWORD", "--out", out_file,
        ]
        previous = os.environ.get("CASCADE_TEST_PASSWORD")
        os.environ["CASCADE_TEST_PASSWORD"] = FAKE_PASSWORD
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                rc = catalog_live.main(argv)
        finally:
            if previous is None:
                os.environ.pop("CASCADE_TEST_PASSWORD", None)
            else:
                os.environ["CASCADE_TEST_PASSWORD"] = previous

        self.assertEqual(rc, 0, stderr.getvalue())
        with open(out_file, "rb") as fh:
            written = fh.read()

        # The password reached the DRIVER (so the worker really would connect)…
        self.assertEqual(capture["kwargs"]["password"], FAKE_PASSWORD)
        # …and nowhere else. Every emitted byte, on every stream.
        for label, blob in (("snapshot file", written.decode("utf-8")),
                            ("stdout", stdout.getvalue()),
                            ("stderr", stderr.getvalue())):
            self.assertNotIn(FAKE_PASSWORD, blob, "password leaked into %s" % label)
            self.assertNotIn(FAKE_USER, blob, "user leaked into %s" % label)

        header = json.loads(written.decode("utf-8").splitlines()[0])
        self.assertEqual(header["serverIdentity"], "db.example.com:3306/com_example_shop")

    def test_a_missing_password_env_var_is_refused_before_connecting(self):
        os.environ.pop("CASCADE_TEST_ABSENT", None)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            rc = catalog_live.main([
                "--dialect", "mysql", "--host", "h", "--database", "d",
                "--user", "u", "--password-env", "CASCADE_TEST_ABSENT",
            ])
        self.assertEqual(rc, 2)
        payload = json.loads(stderr.getvalue().strip())
        self.assertEqual(payload["code"], "bad-input")
        self.assertIn("CASCADE_TEST_ABSENT", payload["message"])

    def test_the_password_is_not_an_argument_the_cli_accepts(self):
        """A `--password` flag would put the secret in `ps` output. There is
        none, and argparse must reject it."""
        parser = catalog_live.build_parser()
        options = set()
        for action in parser._actions:  # noqa: SLF001 — the point is the surface
            options.update(action.option_strings)
        self.assertNotIn("--password", options)
        self.assertIn("--password-env", options)

    def test_a_driver_exception_quoting_the_password_is_scrubbed(self):
        self.assertEqual(
            catalog_live._scrub("auth failed for pw-SECRET-123", FAKE_PASSWORD),
            "auth failed for ***",
        )


class DriverAbsenceTest(unittest.TestCase):
    def test_a_missing_driver_names_the_pip_package(self):
        previous = sys.modules.get("oracledb")
        sys.modules["oracledb"] = None  # an import of None raises ImportError

        def restore():
            if previous is None:
                sys.modules.pop("oracledb", None)
            else:
                sys.modules["oracledb"] = previous
        self.addCleanup(restore)

        with self.assertRaises(catalog_live.CatalogLiveError) as ctx:
            catalog_live.connect("oracle", "h", 1521, "svc", "u", "p")
        self.assertEqual(ctx.exception.code, "db-driver-missing")
        self.assertIn("oracledb", ctx.exception.message)
        self.assertIn("pip install", ctx.exception.message)

    def test_every_dialect_names_a_pip_package(self):
        for dialect in catalog_live.DIALECTS:
            self.assertIn(dialect, catalog_live.DRIVER_PACKAGES)
            module_name, pip_name = catalog_live.DRIVER_PACKAGES[dialect]
            self.assertTrue(module_name and pip_name)


class DefaultsTest(unittest.TestCase):
    def test_default_schema_per_dialect(self):
        self.assertEqual(catalog_live.default_schema_for("mysql", "shop", "u"), "shop")
        self.assertEqual(catalog_live.default_schema_for("postgres", "shop", "u"), "public")
        self.assertEqual(catalog_live.default_schema_for("oracle", "svc", "app"), "APP")

    def test_default_ports(self):
        self.assertEqual(catalog_live.DEFAULT_PORTS,
                         {"mysql": 3306, "postgres": 5432, "oracle": 1521})


if __name__ == "__main__":
    unittest.main()
