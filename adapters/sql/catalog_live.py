#!/usr/bin/env python3
"""Live DB catalog worker for the Cascade SQL lane: the path that opens one
read-only connection and pins a snapshot.

Connects READ-ONLY to a database, asks it for tables, columns and — the reason
this exists — the business **comments**, and writes the same deterministic
catalog JSONL stream ``catalog_ddl.py`` produces from a DDL file. The engine's
extraction pipeline never connects to anything (§2.3): this worker runs once,
by explicit user confirmation (§12.3), and its output is PINNED as a snapshot.

WHAT MAKES THE READ-ONLY CLAIM CHECKABLE (§12.3, and the test that enforces it):

  1. Every statement this module can issue is a MODULE-LEVEL CONSTANT below,
     and every ``cursor.execute`` call passes one of those constants by NAME.
     ``test_catalog_live.py`` parses this file and fails if either half stops
     being true, or if any constant contains a write keyword. A write path
     therefore cannot be added by accident — only by deleting a test.
  2. The session is put into a read-only transaction before anything is read:
     MySQL and Oracle by issuing the constant below, PostgreSQL by
     ``default_transaction_read_only=on`` in the connection options.

WHAT MAKES THE CREDENTIAL CLAIM CHECKABLE (§17.3):

  The password is read ONLY from the environment variable named by
  ``--password-env`` (default ``CASCADE_DB_PASSWORD``). It is never a command
  line argument (argv is world-readable in ``ps``), it is never echoed, and it
  never reaches the output: the header's ``serverIdentity`` is ``host:port/db``
  with no user and no password. ``test_catalog_live.py`` runs the worker with a
  known password in the environment and greps every emitted byte for it.

CLI::

    catalog_live.py --dialect mysql --host h --port 3306 --database db --user u
                    [--schema NAME] [--stamp-schema NAME]
                    [--password-env CASCADE_DB_PASSWORD] [--out FILE]

``--schema`` selects WHICH schema is read; ``--stamp-schema`` sets the ``schema``
field written on the records, and defaults to null exactly as ``catalog_ddl.py``
does — so a live snapshot and a DDL snapshot key their tables the same way
unless the caller deliberately asks for qualified keys.
"""

import argparse
import json
import os
import re
import sys
import datetime

CATALOG_SCHEMA = "cascade:catalog-snapshot:1"

# Worker version — the identity of THIS worker's output shape. Mirrored (and
# asserted) in src/core/worker_versions.mjs. BUMP IT whenever the records change.
CATALOG_VERSION = "catalog-live/1"

DIALECTS = ("mysql", "postgres", "oracle")

# The pip package each dialect's driver comes from. Imported LAZILY (inside
# `connect`), so this module is importable — and its query layer fully
# testable — on a machine with no driver installed at all.
DRIVER_PACKAGES = {
    "mysql": ("pymysql", "pymysql"),
    "postgres": ("psycopg", "psycopg[binary]"),
    "oracle": ("oracledb", "oracledb"),
}

DEFAULT_PORTS = {"mysql": 3306, "postgres": 5432, "oracle": 1521}
DEFAULT_PASSWORD_ENV = "CASCADE_DB_PASSWORD"

# ---------------------------------------------------------------------------
# THE COMPLETE SET OF STATEMENTS THIS WORKER CAN ISSUE.
# Metadata SELECTs and read-only transaction switches. Nothing else. Every one
# is passed to `cursor.execute` BY NAME (see the static test).
# ---------------------------------------------------------------------------

MYSQL_READ_ONLY = "SET SESSION TRANSACTION READ ONLY"

MYSQL_SERVER_VERSION = "SELECT VERSION()"

MYSQL_TABLES = (
    "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COMMENT "
    "FROM INFORMATION_SCHEMA.TABLES "
    "WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE' "
    "ORDER BY TABLE_SCHEMA, TABLE_NAME"
)

MYSQL_COLUMNS = (
    "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, "
    "COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT "
    "FROM INFORMATION_SCHEMA.COLUMNS "
    "WHERE TABLE_SCHEMA = %s "
    "ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
)

POSTGRES_SERVER_VERSION = "SELECT version()"

POSTGRES_TABLES = (
    "SELECT n.nspname, c.relname, "
    "       pg_catalog.obj_description(c.oid, 'pg_class') "
    "FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind IN ('r', 'p') AND n.nspname = %s "
    "ORDER BY n.nspname, c.relname"
)

# information_schema for the column shape, pg_description for the comments, and
# pg_constraint for the primary key — the three sources SPEC §12.2 names.
POSTGRES_COLUMNS = (
    "SELECT c.table_schema, c.table_name, c.column_name, c.ordinal_position, "
    "       c.data_type, c.character_maximum_length, c.numeric_precision, "
    "       c.numeric_scale, c.is_nullable, d.description, "
    "       CASE WHEN k.conname IS NULL THEN 'NO' ELSE 'YES' END "
    "FROM information_schema.columns c "
    "JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema "
    "JOIN pg_catalog.pg_class t ON t.relname = c.table_name "
    "     AND t.relnamespace = n.oid "
    "LEFT JOIN pg_catalog.pg_description d "
    "     ON d.objoid = t.oid AND d.objsubid = c.ordinal_position::int "
    "LEFT JOIN pg_catalog.pg_constraint k "
    "     ON k.conrelid = t.oid AND k.contype = 'p' "
    "     AND c.ordinal_position::smallint = ANY (k.conkey) "
    "WHERE c.table_schema = %s "
    "ORDER BY c.table_schema, c.table_name, c.ordinal_position"
)

ORACLE_READ_ONLY = "SET TRANSACTION READ ONLY"

ORACLE_SERVER_VERSION = (
    "SELECT VERSION FROM PRODUCT_COMPONENT_VERSION WHERE ROWNUM = 1"
)

ORACLE_TABLES = (
    "SELECT OWNER, TABLE_NAME, COMMENTS "
    "FROM ALL_TAB_COMMENTS "
    "WHERE OWNER = :owner AND TABLE_TYPE = 'TABLE' "
    "ORDER BY OWNER, TABLE_NAME"
)

ORACLE_COLUMNS = (
    "SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_ID, c.DATA_TYPE, "
    "       c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, "
    "       cc.COMMENTS, "
    "       (SELECT COUNT(*) FROM ALL_CONSTRAINTS k "
    "          JOIN ALL_CONS_COLUMNS kc ON kc.OWNER = k.OWNER "
    "               AND kc.CONSTRAINT_NAME = k.CONSTRAINT_NAME "
    "         WHERE k.OWNER = c.OWNER AND k.TABLE_NAME = c.TABLE_NAME "
    "           AND k.CONSTRAINT_TYPE = 'P' "
    "           AND kc.COLUMN_NAME = c.COLUMN_NAME) "
    "FROM ALL_TAB_COLUMNS c "
    "LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER "
    "     AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME "
    "WHERE c.OWNER = :owner "
    "ORDER BY c.OWNER, c.TABLE_NAME, c.COLUMN_ID"
)


class CatalogLiveError(Exception):
    """A structured, actionable failure. `code` is the machine name the CLI
    prints; `message` is what a human does about it."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Type normalization — toward the spelling catalog_ddl.py produces
# ---------------------------------------------------------------------------

# MySQL integer types carry a cosmetic display width (`bigint(20)`); the DDL
# path strips it, so this path strips it too, or the two catalogs would disagree
# on a difference that means nothing.
_INT_TYPES = frozenset(
    ["BIGINT", "INT", "INTEGER", "MEDIUMINT", "SMALLINT", "TINYINT"]
)


def _normalize_type(text):
    """A column type in the DDL path's spelling: upper-case, integer display
    width dropped, parameters separated by ", ". Best effort — the two paths
    read the type from different places, so the container test compares them
    with the same normalizer applied to both."""
    if text is None:
        return None
    s = " ".join(str(text).split()).upper()
    m = re.match(r"^([A-Z ]+?)\s*\(([^)]*)\)\s*(.*)$", s)
    if not m:
        return s
    base, params, suffix = m.group(1).strip(), m.group(2), m.group(3).strip()
    if base in _INT_TYPES:
        rendered = base
    else:
        parts = [p.strip() for p in params.split(",") if p.strip() != ""]
        rendered = "%s(%s)" % (base, ", ".join(parts)) if parts else base
    return (rendered + " " + suffix).strip() if suffix else rendered


def _pg_type(data_type, char_len, num_precision, num_scale):
    """PostgreSQL's information_schema splits a type across four columns; put
    them back together the way the type was written."""
    base = (data_type or "").upper()
    if char_len is not None:
        return "%s(%s)" % (base, char_len)
    if num_precision is not None and base in ("NUMERIC", "DECIMAL"):
        if num_scale:
            return "%s(%s, %s)" % (base, num_precision, num_scale)
        return "%s(%s)" % (base, num_precision)
    return base or None


def _oracle_type(data_type, length, precision, scale):
    base = (data_type or "").upper()
    if base in ("NUMBER",) and precision is not None:
        if scale:
            return "NUMBER(%s, %s)" % (precision, scale)
        return "NUMBER(%s)" % (precision,)
    if base in ("VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW") and length is not None:
        return "%s(%s)" % (base, length)
    return base or None


def _text(value):
    """A comment column as a record field: an empty string is NO comment (MySQL
    returns '' for both), and whitespace-only is the same thing."""
    if value is None:
        return None
    s = str(value).strip()
    return s if s != "" else None


# ---------------------------------------------------------------------------
# The query layer — injected cursor, no driver, no network
# ---------------------------------------------------------------------------

def fetch_catalog(cursor_factory, dialect, schema, stamp_schema=None,
                  server_identity=None, fetched_at=None, diagnostics=None):
    """Read one schema's catalog through an injected cursor.

    ``cursor_factory()`` returns anything with ``execute(sql, params)`` and
    ``fetchall()`` — a real DB-API cursor in production, a recorded-rows fake in
    the unit tests. THE WHOLE QUERY LAYER IS THEREFORE TESTABLE WITHOUT A
    DATABASE, which is what makes the three dialects' record mapping something
    the suite checks rather than something the reader hopes for.

    Returns the record list (header first), in the same order and shape
    ``catalog_ddl.parse_ddl_catalog`` returns.
    """
    if dialect not in DIALECTS:
        raise CatalogLiveError(
            "bad-input",
            "unknown dialect %r — expected one of %s" % (dialect, ", ".join(DIALECTS)),
        )
    cur = cursor_factory()
    if dialect == "mysql":
        version, tables, columns = _read_mysql(cur, schema)
    elif dialect == "postgres":
        version, tables, columns = _read_postgres(cur, schema)
    else:
        version, tables, columns = _read_oracle(cur, schema)

    return _assemble(
        dialect=dialect,
        server_version=version,
        server_identity=server_identity,
        fetched_at=fetched_at,
        stamp_schema=stamp_schema,
        tables=tables,
        columns=columns,
        diagnostics=diagnostics,
    )


def _read_mysql(cur, schema):
    cur.execute(MYSQL_SERVER_VERSION, ())
    version = _scalar(cur.fetchall())
    cur.execute(MYSQL_TABLES, (schema,))
    tables = [
        {"table": row[1], "comment": _text(row[2])}
        for row in cur.fetchall()
    ]
    cur.execute(MYSQL_COLUMNS, (schema,))
    columns = []
    for row in cur.fetchall():
        columns.append({
            "table": row[1],
            "column": row[2],
            "ordinal": int(row[3]),
            "type": _normalize_type(row[4]),
            "nullable": str(row[5]).upper() == "YES",
            "pk": str(row[6]).upper() == "PRI",
            "comment": _text(row[7]),
        })
    return version, tables, columns


def _read_postgres(cur, schema):
    cur.execute(POSTGRES_SERVER_VERSION, ())
    version = _scalar(cur.fetchall())
    cur.execute(POSTGRES_TABLES, (schema,))
    tables = [
        {"table": row[1], "comment": _text(row[2])}
        for row in cur.fetchall()
    ]
    cur.execute(POSTGRES_COLUMNS, (schema,))
    columns = []
    for row in cur.fetchall():
        columns.append({
            "table": row[1],
            "column": row[2],
            "ordinal": int(row[3]),
            "type": _normalize_type(_pg_type(row[4], row[5], row[6], row[7])),
            "nullable": str(row[8]).upper() == "YES",
            "comment": _text(row[9]),
            "pk": str(row[10]).upper() == "YES",
        })
    return version, tables, columns


def _read_oracle(cur, schema):
    cur.execute(ORACLE_SERVER_VERSION, {})
    version = _scalar(cur.fetchall())
    cur.execute(ORACLE_TABLES, {"owner": schema})
    tables = [
        {"table": row[1], "comment": _text(row[2])}
        for row in cur.fetchall()
    ]
    cur.execute(ORACLE_COLUMNS, {"owner": schema})
    columns = []
    for row in cur.fetchall():
        columns.append({
            "table": row[1],
            "column": row[2],
            "ordinal": int(row[3]),
            "type": _normalize_type(_oracle_type(row[4], row[5], row[6], row[7])),
            # Oracle spells nullability 'Y'/'N'.
            "nullable": str(row[8]).upper() == "Y",
            "comment": _text(row[9]),
            "pk": int(row[10] or 0) > 0,
        })
    return version, tables, columns


def _scalar(rows):
    if not rows:
        return None
    row = rows[0]
    if isinstance(row, (list, tuple)):
        return None if not row else (None if row[0] is None else str(row[0]))
    return None if row is None else str(row)


def _assemble(dialect, server_version, server_identity, fetched_at,
              stamp_schema, tables, columns, diagnostics=None):
    """Turn the two row sets into the catalog record stream.

    Determinism (§2.1): tables sorted by name, columns by ordinal, keys sorted
    on emit. Nothing machine-derived enters a record except the header's
    ``fetchedAt``/``serverVersion``/``serverIdentity`` provenance — and
    `catalogDigestOf` (src/core/facts_store.mjs) excludes the header, so a
    refetch of an UNCHANGED schema does not invalidate a single lineage shard.
    """
    by_table = {}
    for col in columns:
        by_table.setdefault(col["table"], []).append(col)

    known = set(t["table"] for t in tables)
    for name in sorted(set(by_table) - known):
        _diag(diagnostics, "warn", "column_without_table", name,
              "columns were returned for %r, which is not a base table in this "
              "schema (a view?); they were dropped" % (name,))
        by_table.pop(name, None)

    records = []
    n_columns = 0
    n_commented = 0
    ordered = sorted(tables, key=lambda t: t["table"])
    for t in ordered:
        records.append({
            "kind": "table",
            "schema": stamp_schema,
            "table": t["table"],
            "comment": t["comment"],
        })
        for col in sorted(by_table.get(t["table"], []), key=lambda c: c["ordinal"]):
            n_columns += 1
            if col["comment"] is not None:
                n_commented += 1
            records.append({
                "kind": "column",
                "schema": stamp_schema,
                "table": col["table"],
                "column": col["column"],
                "type": col["type"],
                "nullable": col["nullable"],
                "comment": col["comment"],
                "ordinal": col["ordinal"],
                "pk": col["pk"],
            })

    header = {
        "kind": "header",
        "schema": CATALOG_SCHEMA,
        "version": CATALOG_VERSION,
        "source": "jdbc",
        "dialect": dialect,
        "serverVersion": server_version,
        # host:port/db — NO user, NO password (SPEC §17.3).
        "serverIdentity": server_identity,
        "fetchedAt": fetched_at,
        "rowCounts": {
            "tables": len(ordered),
            "columns": n_columns,
            "commented": n_commented,
        },
    }
    return [header] + records


def _diag(diagnostics, level, code, table, message):
    if diagnostics is not None:
        diagnostics.append(
            {"level": level, "code": code, "table": table, "message": message}
        )


# ---------------------------------------------------------------------------
# The connection edge — the only impure part
# ---------------------------------------------------------------------------

def connect(dialect, host, port, database, user, password, diagnostics=None):
    """Open a READ-ONLY connection. The driver is imported here, lazily: a
    missing one is a structured, actionable error naming the pip package, not an
    ImportError traceback at module load (SPEC §17.4, §17.9).

    Returns ``(connection, cursor_factory)``.
    """
    module_name, pip_name = DRIVER_PACKAGES[dialect]
    try:
        driver = __import__(module_name)
    except ImportError as e:
        raise CatalogLiveError(
            "db-driver-missing",
            "the %s driver is not installed: %s. Install it with "
            "`pip install %s` (the live catalog drivers are OPTIONAL — see "
            "adapters/sql/requirements.txt)" % (dialect, e, pip_name),
        )

    try:
        if dialect == "mysql":
            conn = driver.connect(
                host=host, port=port, database=database, user=user,
                password=password, charset="utf8mb4",
            )
            # First statement on the session: no write can precede it.
            cur = conn.cursor()
            cur.execute(MYSQL_READ_ONLY, ())
            cur.close()
        elif dialect == "postgres":
            conn = driver.connect(
                host=host, port=port, dbname=database, user=user,
                password=password,
                options="-c default_transaction_read_only=on",
            )
        else:
            conn = driver.connect(
                user=user, password=password,
                dsn="%s:%s/%s" % (host, port, database),
            )
            cur = conn.cursor()
            cur.execute(ORACLE_READ_ONLY, {})
            cur.close()
    except CatalogLiveError:
        raise
    except Exception as e:  # noqa: BLE001 — every driver raises its own type
        raise CatalogLiveError(
            "db-connect-error",
            "could not connect to %s %s:%s/%s as %s: %s"
            % (dialect, host, port, database, user, _scrub(str(e), password)),
        )
    return conn, conn.cursor


def _scrub(text, password):
    """A driver's exception text can quote the connection string back at us.
    Nothing carrying the password reaches a message, a log or the output."""
    if password:
        return str(text).replace(password, "***")
    return str(text)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _emit(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_parser():
    p = argparse.ArgumentParser(
        prog="catalog_live.py",
        description="Read a DB catalog (tables, columns, comments) READ-ONLY "
                    "into the Cascade catalog JSONL stream.",
    )
    p.add_argument("--dialect", required=True, choices=list(DIALECTS))
    p.add_argument("--host", required=True)
    p.add_argument("--port", type=int, default=None,
                   help="default: 3306 (mysql) / 5432 (postgres) / 1521 (oracle)")
    p.add_argument("--database", required=True,
                   help="the database (mysql), dbname (postgres) or service (oracle)")
    p.add_argument("--user", required=True)
    p.add_argument("--password-env", default=DEFAULT_PASSWORD_ENV,
                   help="NAME of the environment variable holding the password. "
                        "The password itself is never an argument (default: %s)"
                        % DEFAULT_PASSWORD_ENV)
    p.add_argument("--schema", default=None,
                   help="which schema to read (default: the database name for "
                        "mysql, `public` for postgres, the upper-cased user for oracle)")
    p.add_argument("--stamp-schema", default=None,
                   help="the `schema` field written on every record (default: "
                        "null, exactly as catalog_ddl.py)")
    p.add_argument("--out", default=None, help="write JSONL here instead of stdout")
    return p


def default_schema_for(dialect, database, user):
    if dialect == "mysql":
        return database
    if dialect == "postgres":
        return "public"
    return (user or "").upper()


def main(argv=None):
    args = build_parser().parse_args(argv)
    port = args.port if args.port is not None else DEFAULT_PORTS[args.dialect]
    schema = args.schema or default_schema_for(args.dialect, args.database, args.user)

    password = os.environ.get(args.password_env)
    if password is None:
        sys.stderr.write(_emit({
            "level": "error", "code": "bad-input",
            "message": "the environment variable %s holds no password. The "
                       "password is read from the environment ONLY — never from "
                       "the command line, where `ps` would show it." % args.password_env,
        }) + "\n")
        return 2

    server_identity = "%s:%s/%s" % (args.host, port, args.database)
    fetched_at = datetime.datetime.now(datetime.timezone.utc).replace(
        microsecond=0).isoformat().replace("+00:00", "Z")

    diagnostics = []
    conn = None
    try:
        conn, cursor_factory = connect(
            args.dialect, args.host, port, args.database, args.user, password,
            diagnostics=diagnostics,
        )
        records = fetch_catalog(
            cursor_factory, args.dialect, schema,
            stamp_schema=args.stamp_schema,
            server_identity=server_identity,
            fetched_at=fetched_at,
            diagnostics=diagnostics,
        )
    except CatalogLiveError as e:
        sys.stderr.write(_emit({
            "level": "error", "code": e.code,
            "message": _scrub(e.message, password),
        }) + "\n")
        return 3
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(_emit({
            "level": "error", "code": "db-connect-error",
            "message": _scrub(str(e), password),
        }) + "\n")
        return 3
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 — closing must not mask the result
                pass

    body = "".join(_emit(r) + "\n" for r in records)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(body)
    else:
        sys.stdout.write(body)
        sys.stdout.flush()

    for d in diagnostics:
        sys.stderr.write(_emit(d) + "\n")
    counts = records[0]["rowCounts"]
    sys.stderr.write(_emit({
        "level": "info", "code": "summary", "version": CATALOG_VERSION,
        "dialect": args.dialect, "schema": schema,
        "serverIdentity": server_identity,
        "tables": counts["tables"], "columns": counts["columns"],
        "commented": counts["commented"], "warnings": len(diagnostics),
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
