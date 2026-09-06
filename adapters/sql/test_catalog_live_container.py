#!/usr/bin/env python3
"""Live-dialect integration test for adapters/sql/catalog_live.py.

It starts a real MySQL 8 in Docker, creates a tiny schema WITH COMMENTS, reads
it through the live worker, and reads the SAME DDL through the static worker
(``catalog_ddl.py``). The two paths must agree on tables, columns, primary keys
and comments — that agreement is the only thing that makes the two
interchangeable in a pack.

WHEN DOCKER IS NOT AVAILABLE THIS TEST SKIPS **OUT LOUD**. A live-database test
that quietly disappears is worse than no test: the suite goes green and nobody
knows the dialect queries were never executed. So the reason is printed to
stderr as well as handed to `skipTest`, and CI runs the same file in a job that
does have Docker (`.github/workflows/ci.yml`, job `db`).

Run:
    cd adapters/sql && ../../.venv/bin/python -m unittest test_catalog_live_container -v
"""

import json
import os
import subprocess
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import catalog_ddl  # noqa: E402
import catalog_live  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

IMAGE = "mysql:8"
CONTAINER = "cascade-catalog-live-test"
ROOT_PASSWORD = "cascade-test-root-pw"
SCHEMA = "com_example_shop"
PORT = 33061
READY_TIMEOUT_S = 120

# The fixture schema. It lives here as text so BOTH paths read the same thing:
# the container is loaded with it, and catalog_ddl.py parses it directly.
DDL = """
CREATE TABLE `shop_order` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT 'Order id',
  `order_sn` varchar(64) NOT NULL COMMENT 'Order code - unique',
  `total_amount` decimal(10,2) DEFAULT NULL COMMENT 'Order total',
  `delete_status` int(1) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Customer order header';

CREATE TABLE `shop_order_item` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `order_id` bigint(20) NOT NULL COMMENT 'Owning order',
  `quantity` int(11) DEFAULT NULL COMMENT 'Ordered quantity',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""


def docker_reason():
    """None when a Docker daemon answers, otherwise the reason it does not."""
    try:
        proc = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, timeout=5, check=False,
        )
    except FileNotFoundError:
        return "the `docker` command is not on PATH"
    except subprocess.TimeoutExpired:
        return "`docker info` did not answer within 5s"
    except OSError as e:
        return "`docker info` could not be run: %s" % e
    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()
        detail = " ".join(detail.split())[:200] or "no stderr"
        return "`docker info` exited %d: %s" % (proc.returncode, detail)
    return None


def driver_reason():
    try:
        __import__("pymysql")
    except ImportError as e:
        return ("the optional MySQL driver is not installed (%s). "
                "Run `pip install pymysql`" % e)
    return None


def skip_reason():
    """The message this test skips with, or None when it can really run.
    The two halves are named apart so the reader knows WHICH prerequisite was
    missing — "skipped" without that is indistinguishable from "passed"."""
    docker = docker_reason()
    if docker:
        return "docker not reachable: %s" % docker
    driver = driver_reason()
    if driver:
        return "live catalog driver missing: %s" % driver
    return None


def announce_skip(reason):
    """Print the reason. `unittest` shows a skip's reason only in verbose mode,
    and a live-database test that vanishes silently from a green suite is how a
    dialect goes unverified for a year."""
    sys.stderr.write("SKIP test_catalog_live_container: %s\n" % reason)
    sys.stderr.flush()


def _docker(args, **kwargs):
    return subprocess.run(["docker"] + args, capture_output=True, check=False, **kwargs)


def normalized_type(text):
    """Types come from different places on the two paths (sqlglot's rendering of
    the DDL vs MySQL's own COLUMN_TYPE), so they are compared through one
    normalizer applied to both, not byte for byte."""
    return catalog_live._normalize_type(text)


def comparable(records):
    """The part of a catalog the two paths MUST agree on, keyed for comparison."""
    tables = {}
    columns = {}
    for r in records:
        if r["kind"] == "table":
            tables[r["table"]] = r["comment"]
        elif r["kind"] == "column":
            columns[(r["table"], r["column"])] = {
                "ordinal": r["ordinal"],
                "nullable": r["nullable"],
                "pk": r["pk"],
                "comment": r["comment"],
                "type": normalized_type(r["type"]),
            }
    return tables, columns


class PrerequisiteTest(unittest.TestCase):
    """Always runs, everywhere. It does not test the database — it tests that
    this file can SAY why it did not."""

    def test_the_probe_answers_with_a_reason_or_with_none(self):
        reason = skip_reason()
        self.assertTrue(reason is None or isinstance(reason, str))
        if reason is not None:
            self.assertTrue(reason.strip(), "a skip must carry a reason")
            announce_skip(reason)


class CatalogLiveContainerTest(unittest.TestCase):
    """The live MySQL path, end to end, against the DDL path."""

    @classmethod
    def setUpClass(cls):
        cls.started = False
        reason = skip_reason()
        if reason is not None:
            announce_skip(reason)
            raise unittest.SkipTest(reason)
        _docker(["rm", "-f", CONTAINER])
        run = _docker([
            "run", "-d", "--rm", "--name", CONTAINER,
            "-e", "MYSQL_ROOT_PASSWORD=" + ROOT_PASSWORD,
            "-e", "MYSQL_DATABASE=" + SCHEMA,
            "-p", "%d:3306" % PORT,
            IMAGE,
        ])
        if run.returncode != 0:
            raise unittest.SkipTest(
                "could not start %s: %s"
                % (IMAGE, (run.stderr or b"").decode("utf-8", "replace").strip())
            )
        cls.started = True

        deadline = time.time() + READY_TIMEOUT_S
        last = ""
        while time.time() < deadline:
            probe = _docker([
                "exec", CONTAINER, "mysql",
                "-uroot", "-p" + ROOT_PASSWORD, "-e", "SELECT 1",
            ])
            if probe.returncode == 0:
                break
            last = (probe.stderr or b"").decode("utf-8", "replace").strip()
            time.sleep(2)
        else:
            cls.tearDownClass()
            raise unittest.SkipTest("%s never became ready: %s" % (IMAGE, last))

        load = subprocess.run(
            ["docker", "exec", "-i", CONTAINER, "mysql",
             "-uroot", "-p" + ROOT_PASSWORD, SCHEMA],
            input=DDL.encode("utf-8"), capture_output=True, check=False,
        )
        if load.returncode != 0:
            cls.tearDownClass()
            raise unittest.SkipTest(
                "could not load the fixture schema: %s"
                % (load.stderr or b"").decode("utf-8", "replace").strip()
            )

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "started", False):
            _docker(["rm", "-f", CONTAINER])
            cls.started = False

    def live_records(self):
        os.environ["CASCADE_CONTAINER_TEST_PASSWORD"] = ROOT_PASSWORD
        try:
            conn, cursor_factory = catalog_live.connect(
                "mysql", "127.0.0.1", PORT, SCHEMA, "root", ROOT_PASSWORD,
            )
            try:
                return catalog_live.fetch_catalog(
                    cursor_factory, "mysql", SCHEMA,
                    stamp_schema=None,
                    server_identity="127.0.0.1:%d/%s" % (PORT, SCHEMA),
                    fetched_at="2026-01-01T00:00:00Z",
                )
            finally:
                conn.close()
        finally:
            os.environ.pop("CASCADE_CONTAINER_TEST_PASSWORD", None)

    def test_live_and_ddl_paths_agree(self):
        live = self.live_records()
        static = catalog_ddl.parse_ddl_catalog(DDL)

        live_tables, live_columns = comparable(live)
        ddl_tables, ddl_columns = comparable(static)

        self.assertEqual(sorted(live_tables), sorted(ddl_tables))
        self.assertEqual(live_tables, ddl_tables, "table comments disagree")
        self.assertEqual(sorted(live_columns), sorted(ddl_columns))
        for key in sorted(ddl_columns):
            self.assertEqual(live_columns[key], ddl_columns[key],
                             "column %s disagrees between the two paths" % (key,))

    def test_the_live_header_is_provenance_only(self):
        header = self.live_records()[0]
        self.assertEqual(header["schema"], catalog_live.CATALOG_SCHEMA)
        self.assertEqual(header["dialect"], "mysql")
        self.assertTrue(header["serverVersion"])
        self.assertEqual(header["serverIdentity"], "127.0.0.1:%d/%s" % (PORT, SCHEMA))
        self.assertNotIn(ROOT_PASSWORD, json.dumps(header))
        self.assertNotIn("root", header["serverIdentity"])

    def test_the_session_really_is_read_only(self):
        """Not a claim about the source this time: ask the server. A write must
        be refused by the connection the worker opens."""
        conn, cursor_factory = catalog_live.connect(
            "mysql", "127.0.0.1", PORT, SCHEMA, "root", ROOT_PASSWORD,
        )
        try:
            cur = cursor_factory()
            with self.assertRaises(Exception):
                # Deliberately outside the worker: this statement exists in the
                # TEST, never in catalog_live.py (see its static test).
                cur.execute("INSERT INTO shop_order (order_sn) VALUES ('x')")
        finally:
            conn.close()


if __name__ == "__main__":
    reason = skip_reason()
    if reason:
        sys.stderr.write("SKIP test_catalog_live_container: %s\n" % reason)
    unittest.main()
