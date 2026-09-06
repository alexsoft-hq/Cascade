#!/usr/bin/env python3
"""Static DDL catalog extractor for the Cascade SQL lane: the path that reads
a schema file and connects to nothing.

Parses a MySQL ``CREATE TABLE`` dump into a deterministic **catalog** JSONL
stream — no DB connection. The catalog carries table/column names, types,
nullability, and (most importantly for column lineage) the business
**comments**.

Determinism (SPEC §2.1): identical input file + args produce byte-for-byte
identical stdout. Tables are sorted by name; columns keep declaration order;
every line is emitted with sorted keys and no incidental whitespace. Nothing
time-, machine-, or absolute-path-derived enters the output (basename only).

Robustness (SPEC §17.8): non-CREATE-TABLE statements are skipped silently, but
a table or column that cannot be read emits a structured diagnostic to stderr
and processing continues — a table is never dropped without a trace.

Several files (SPEC RM20 §3): a schema is often split — one file per service,
or a base schema plus an ordered migration sequence. The files are folded IN THE
ORDER GIVEN: ``CREATE TABLE`` declares, ``ALTER TABLE ADD/DROP/MODIFY/CHANGE
COLUMN`` and ``ALTER TABLE ... RENAME TO`` / ``RENAME TABLE`` amend. Two files
declaring the SAME table is never merged silently — the first declaration is kept
and a ``DUPLICATE_TABLE_DECLARATION`` diagnostic names both files.

CLI: ``python catalog_ddl.py <ddl.sql> [<ddl.sql> ...] [--schema NAME]``
"""

import argparse
import json
import os
import re
import sys

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

CATALOG_SCHEMA = "cascade:catalog-snapshot:1"

# Worker version — the identity of THIS parser's output shape. It rides in the
# header record and is folded into the content-addressed catalog-shard key
# (SPEC §17.7). BUMP IT whenever the catalog records change.
# Mirrored (and asserted) in src/core/worker_versions.mjs.
#   /2 - a NAMED table constraint (``CONSTRAINT pk_x PRIMARY KEY (a)``) is now read
#        as a primary key. Output for a MySQL dump that writes the bare
#        ``PRIMARY KEY (a)`` is byte-identical to /1; for standard-SQL dumps that
#        name the constraint, the ``pk`` field changes, so shards from the two
#        generations must not share a key.
#   /3 - SEVERAL files, folded in order, and ``ALTER TABLE``/``RENAME TABLE`` are
#        applied instead of skipped. A single CREATE-TABLE-only file parses to the
#        same records as /2 except for the header, which now names every source
#        file and carries the per-file counts. ``--identifier-case`` says what
#        makes two names THE SAME NAME when the fold decides it.
CATALOG_VERSION = "catalog-ddl/3"

# WHAT MAKES TWO SPELLINGS ONE TABLE (SPEC §8.1). The same identity rule the
# lineage worker matches statements with, applied where two files are folded:
# jpetstore-6 ships its 13 tables twice, ``create table SUPPLIER`` in one file and
# ``create table supplier`` in the other, and a byte comparison calls that 26
# tables. The rule is the DATABASE's, so it is passed in rather than assumed.
_IDENTIFIER_CASES = ("fold-lower", "fold-upper", "exact")


def _fold(name, identifier_case):
    if identifier_case == "fold-lower":
        return name.lower()
    if identifier_case == "fold-upper":
        return name.upper()
    return name

# MySQL integer types carry a cosmetic *display width* (e.g. ``bigint(20)``,
# ``int(11)``) that is deprecated and semantically meaningless — MySQL 8 ignores
# it. sqlglot preserves it in ``.sql()``. We strip it so the normalized type is
# ``BIGINT`` / ``INT`` (SPEC examples), while keeping semantic parameters like
# ``VARCHAR(64)`` and ``DECIMAL(10, 2)``.
_INT_DISPLAY_WIDTH_TYPES = {
    exp.DataType.Type.BIGINT,
    exp.DataType.Type.INT,
    exp.DataType.Type.MEDIUMINT,
    exp.DataType.Type.SMALLINT,
    exp.DataType.Type.TINYINT,
    exp.DataType.Type.UBIGINT,
    exp.DataType.Type.UINT,
    exp.DataType.Type.UMEDIUMINT,
    exp.DataType.Type.USMALLINT,
    exp.DataType.Type.UTINYINT,
}


def _diag(diagnostics, level, code, table, message):
    """Record a structured diagnostic (appended to the caller's list, if any)."""
    if diagnostics is not None:
        diagnostics.append(
            {"level": level, "code": code, "table": table, "message": message}
        )


def _literal_text(node):
    """Return the string content of a sqlglot literal/identifier node, or None."""
    if node is None:
        return None
    # exp.Literal.name and identifier .name both yield the underlying string.
    text = node.name
    return text if text != "" else ""


def _type_text(kind):
    """Normalized SQL type text from sqlglot, integer display-width stripped."""
    if kind is None:
        return None
    if (
        isinstance(kind, exp.DataType)
        and kind.this in _INT_DISPLAY_WIDTH_TYPES
        and kind.expressions
    ):
        stripped = kind.copy()
        stripped.set("expressions", [])
        return stripped.sql()
    return kind.sql()


def _column_record(col_def, schema, table_name):
    """Build a column dict from an ``exp.ColumnDef`` (ordinal set by caller)."""
    name = col_def.name
    constraints = col_def.args.get("constraints") or []

    nullable = True
    comment = None
    for c in constraints:
        k = getattr(c, "kind", None)
        if isinstance(k, exp.NotNullColumnConstraint):
            # allow_null=True means the source wrote a bare ``NULL`` (nullable);
            # its absence means a real ``NOT NULL``.
            if not k.args.get("allow_null"):
                nullable = False
        elif isinstance(k, exp.CommentColumnConstraint):
            comment = _literal_text(k.this)

    return {
        "kind": "column",
        "schema": schema,
        "table": table_name,
        "column": name,
        "type": _type_text(col_def.args.get("kind")),
        "nullable": nullable,
        "comment": comment,
    }


def _primary_key_columns(col_defs):
    """Column names in the table's PRIMARY KEY — from a table-level
    ``PRIMARY KEY (a, b)`` constraint or an inline column ``PRIMARY KEY``.
    Used to infer join cardinality (a join on a PK is the ``1`` side). Best
    effort: anything not recognized simply yields no PK (cardinality unknown),
    never a guess."""
    pk = set()

    def add_pk(primary_key):
        for e in primary_key.expressions or []:
            node = e.this if isinstance(e, exp.Ordered) else e
            name = getattr(node, "name", None)
            if name:
                pk.add(name)

    for cd in col_defs:
        if isinstance(cd, exp.PrimaryKey):
            add_pk(cd)
        elif isinstance(cd, exp.Constraint):
            # A NAMED table constraint — ``CONSTRAINT pk_account PRIMARY KEY
            # (userid)``. Standard SQL, and what HSQLDB/Oracle/PostgreSQL dumps
            # normally write; MySQL dumps usually write the bare
            # ``PRIMARY KEY (id)`` handled above. sqlglot wraps the named form in
            # an ``exp.Constraint`` whose expressions hold the real constraint,
            # so without this branch the PK of every such table was silently
            # empty and every column came back ``pk: false``.
            for inner in cd.expressions or []:
                if isinstance(inner, exp.PrimaryKey):
                    add_pk(inner)
        elif isinstance(cd, exp.ColumnDef):
            for c in (cd.args.get("constraints") or []):
                kind = getattr(c, "kind", None)
                if isinstance(kind, exp.PrimaryKeyColumnConstraint):
                    pk.add(cd.name)
    return pk


def _table_comment(create):
    """Read the table-level COMMENT property, or None."""
    props = create.args.get("properties")
    if not props:
        return None
    for p in props.expressions:
        if isinstance(p, exp.SchemaCommentProperty):
            return _literal_text(p.this)
    return None


_ALTER_CLAUSE_NAMES = {
    "AddConstraint": "ADD CONSTRAINT / ADD INDEX / ADD KEY",
    "AlterColumn": "ALTER COLUMN",
    "AlterSet": "ALTER ... SET",
    "Command": "an unparsed ALTER clause",
}

# ``RENAME TABLE a TO b, c TO d`` is not modelled by sqlglot's MySQL dialect: it
# falls back to a Command whose text is everything after the keyword. Read the
# pairs out of that text rather than dropping the statement.
_RENAME_TABLE_RE = re.compile(
    r"(?:^|,)\s*(?:`|\")?([A-Za-z0-9_$.]+)(?:`|\")?\s+TO\s+(?:`|\")?([A-Za-z0-9_$.]+)(?:`|\")?",
    re.IGNORECASE,
)


class _Table(object):
    """One table as the fold has it so far. Column ORDER is declaration order."""

    __slots__ = ("name", "comment", "columns", "pk", "declared_in")

    def __init__(self, name, comment, declared_in):
        self.name = name
        self.comment = comment
        self.columns = {}       # column name -> record (insertion-ordered dict)
        self.pk = set()
        self.declared_in = declared_in


def _parse_statements(sql_text, diagnostics, source):
    """sqlglot.parse with the same salvage path the single-file reader had."""
    try:
        return sqlglot.parse(sql_text, read="mysql")
    except ParseError as e:
        _diag(
            diagnostics,
            "warn",
            "parse_error",
            None,
            "full parse of %s failed, salvaging with error_level=IGNORE: %s"
            % (source, str(e).replace("\n", " ")),
        )
        return sqlglot.parse(sql_text, read="mysql", error_level=sqlglot.ErrorLevel.IGNORE)


def _apply_create(stmt, tables, schema, diagnostics, source, identifier_case="exact"):
    try:
        target = stmt.this
        if isinstance(target, exp.Schema):
            table_exp = target.this
            col_defs = target.expressions
        else:
            table_exp = target
            col_defs = []
        table_name = table_exp.name
        if not table_name:
            _diag(diagnostics, "warn", "unnamed_table", None,
                  "CREATE TABLE with no readable name in %s; skipped" % source)
            return
    except Exception as e:  # noqa: BLE001 — never drop a table without a trace
        _diag(diagnostics, "warn", "table_read_failed", None,
              "could not read table header in %s: %s" % (source, str(e).replace("\n", " ")))
        return

    key = _fold(table_name, identifier_case)
    existing = tables.get(key)
    if existing is not None:
        # NEVER merged: two declarations of one table are two different schemas,
        # and merging them would invent a table neither file describes. The FIRST
        # wins (the files are applied in the order the caller gave) and the
        # disagreement is reported.
        _diag(diagnostics, "warn", "DUPLICATE_TABLE_DECLARATION", table_name,
              "%s is declared in %s (as %s) and again in %s; the first declaration is kept, "
              "nothing is merged — pass only one of the two files, or the one that "
              "describes the live schema"
              % (table_name, existing.declared_in, existing.name, source))
        return

    tbl = _Table(table_name, _table_comment(stmt), source)
    pk_cols = _primary_key_columns(col_defs)
    for col_def in col_defs:
        if not isinstance(col_def, exp.ColumnDef):
            continue  # PRIMARY KEY / INDEX / etc. are not columns
        try:
            rec = _column_record(col_def, schema, table_name)
        except Exception as e:  # noqa: BLE001
            _diag(diagnostics, "warn", "column_read_failed", table_name,
                  "a column of %s in %s could not be read: %s"
                  % (table_name, source, str(e).replace("\n", " ")))
            continue
        tbl.columns[rec["column"]] = rec
    tbl.pk = set(pk_cols)
    tables[key] = tbl


def _column_is_pk(col_def):
    for c in (col_def.args.get("constraints") or []):
        if isinstance(getattr(c, "kind", None), exp.PrimaryKeyColumnConstraint):
            return True
    return False


def _rename_table(tables, old, new, diagnostics, source, identifier_case="exact"):
    old_key = _fold(old, identifier_case)
    new_key = _fold(new, identifier_case)
    tbl = tables.get(old_key)
    if tbl is None:
        _diag(diagnostics, "warn", "alter_unknown_table", old,
              "%s renames %s, which no file declared before it; ignored" % (source, old))
        return
    if new_key in tables:
        _diag(diagnostics, "warn", "DUPLICATE_TABLE_DECLARATION", new,
              "%s renames %s to %s, but %s already exists; the rename is ignored"
              % (source, old, new, new))
        return
    # Rebuild in place so the table keeps its position in the fold order.
    rebuilt = {}
    for name, tb in tables.items():
        if name == old_key:
            tb.name = new
            for rec in tb.columns.values():
                rec["table"] = new
            rebuilt[new_key] = tb
        else:
            rebuilt[name] = tb
    tables.clear()
    tables.update(rebuilt)


def _apply_alter(stmt, tables, schema, diagnostics, source, identifier_case="exact"):
    """Apply one ALTER TABLE. Every clause this reader does not model is named."""
    target = stmt.this
    table_name = getattr(target, "name", None)
    if not table_name:
        _diag(diagnostics, "warn", "alter_read_failed", None,
              "ALTER in %s has no readable table name; ignored" % source)
        return
    actions = stmt.args.get("actions") or []
    for action in actions:
        if isinstance(action, exp.AlterRename):
            _rename_table(tables, table_name, action.this.name, diagnostics, source, identifier_case)
            table_name = action.this.name
            continue
        tbl = tables.get(_fold(table_name, identifier_case))
        if tbl is None:
            _diag(diagnostics, "warn", "alter_unknown_table", table_name,
                  "%s alters %s, which no file declared before it; ignored"
                  % (source, table_name))
            return
        if isinstance(action, exp.ColumnDef):          # ADD COLUMN
            rec = _column_record(action, schema, tbl.name)
            if rec["column"] in tbl.columns:
                # Re-adding an existing column is the same disagreement as a
                # duplicate table: the later file is describing a different
                # history. Keep what is there and say so.
                _diag(diagnostics, "warn", "duplicate_column", tbl.name,
                      "%s adds %s.%s, which already exists; kept as declared"
                      % (source, tbl.name, rec["column"]))
                continue
            tbl.columns[rec["column"]] = rec
            if _column_is_pk(action):
                tbl.pk.add(rec["column"])
        elif isinstance(action, exp.Drop) and str(action.args.get("kind") or "").upper() == "COLUMN":
            name = action.this.name if action.this is not None else None
            if name and name in tbl.columns:
                del tbl.columns[name]
                tbl.pk.discard(name)
            else:
                _diag(diagnostics, "warn", "alter_unknown_column", tbl.name,
                      "%s drops %s.%s, which is not there; ignored" % (source, tbl.name, name))
        elif isinstance(action, exp.ModifyColumn):     # MODIFY / CHANGE COLUMN
            col_def = action.this
            if not isinstance(col_def, exp.ColumnDef):
                _diag(diagnostics, "warn", "alter_clause_unsupported", tbl.name,
                      "%s: MODIFY COLUMN on %s carries no column definition; ignored"
                      % (source, tbl.name))
                continue
            rec = _column_record(col_def, schema, tbl.name)
            old_ident = action.args.get("rename_from")
            old_name = old_ident.name if old_ident is not None else rec["column"]
            if old_name not in tbl.columns:
                _diag(diagnostics, "warn", "alter_unknown_column", tbl.name,
                      "%s modifies %s.%s, which is not there; added as declared"
                      % (source, tbl.name, old_name))
                tbl.columns[rec["column"]] = rec
                continue
            # Keep the column's POSITION: a rename must not reorder the table.
            rebuilt = {}
            for name, existing in tbl.columns.items():
                if name == old_name:
                    rebuilt[rec["column"]] = rec
                else:
                    rebuilt[name] = existing
            tbl.columns = rebuilt
            if old_name in tbl.pk and old_name != rec["column"]:
                tbl.pk.discard(old_name)
                tbl.pk.add(rec["column"])
        else:
            _diag(diagnostics, "warn", "alter_clause_unsupported", tbl.name,
                  "%s: %s on %s is not applied to the catalog (it changes no column set)"
                  % (source, _ALTER_CLAUSE_NAMES.get(type(action).__name__, type(action).__name__),
                     tbl.name))


def parse_ddl_catalog_files(files, schema=None, diagnostics=None, identifier_case="exact"):
    """Fold several DDL files, IN THE ORDER GIVEN, into catalog records.

    ``files`` — a sequence of ``(source_label, sql_text)``. The label appears in
    diagnostics and in the header, so a reader can tell which file declared what.

    ``identifier_case`` — what makes two table names the SAME table when the fold
    decides it (``fold-lower`` / ``fold-upper`` / ``exact``). Only the DUPLICATE
    check and the ALTER lookup use it; every record keeps the name as the first
    file wrote it.

    Returns the same record list shape as :func:`parse_ddl_catalog`: one header,
    then every table sorted by name with its columns in declaration order.
    """
    tables = {}   # folded table name -> _Table (the record keeps the name as written)
    per_file = []
    for source, sql_text in files:
        before = len(tables)
        statements = _parse_statements(sql_text, diagnostics, source)
        alters = 0
        for stmt in statements:
            if stmt is None:
                continue
            if isinstance(stmt, exp.Create) and stmt.kind == "TABLE":
                _apply_create(stmt, tables, schema, diagnostics, source, identifier_case)
            elif isinstance(stmt, exp.Alter) and str(stmt.args.get("kind") or "").upper() == "TABLE":
                alters += 1
                _apply_alter(stmt, tables, schema, diagnostics, source, identifier_case)
            elif isinstance(stmt, exp.Command) and str(stmt.name or "").upper() == "RENAME":
                text = stmt.expression.name if stmt.expression is not None else ""
                body = re.sub(r"^\s*TABLE\s+", "", str(text), flags=re.IGNORECASE)
                pairs = _RENAME_TABLE_RE.findall(body)
                if not pairs:
                    _diag(diagnostics, "warn", "alter_clause_unsupported", None,
                          "%s: RENAME statement could not be read (%r); ignored" % (source, text))
                for old, new in pairs:
                    alters += 1
                    _rename_table(tables, old, new, diagnostics, source, identifier_case)
            # everything else (INSERT/UPDATE/CREATE INDEX/…) is skipped silently
        per_file.append({"source": source, "tablesAfter": len(tables),
                         "tablesAdded": len(tables) - before, "alters": alters})

    ordered = sorted(tables.values(), key=lambda t: t.name)
    n_columns = 0
    n_commented = 0
    body = []
    for tbl in ordered:
        body.append({
            "kind": "table",
            "schema": schema,
            "table": tbl.name,
            "comment": tbl.comment,
        })
        ordinal = 0
        for rec in tbl.columns.values():
            ordinal += 1
            rec["ordinal"] = ordinal
            rec["pk"] = rec["column"] in tbl.pk
            if rec.get("comment") is not None:
                n_commented += 1
            n_columns += 1
            body.append(rec)

    header = {
        "kind": "header",
        "schema": CATALOG_SCHEMA,
        "version": CATALOG_VERSION,
        "source": None,  # filled by the CLI (basenames); None when parsed in-memory
        "dialect": "mysql",
        "tables": len(ordered),
        "columns": n_columns,
        "commented": n_commented,
        # Which file contributed what, so "7 tables" can be checked against the
        # files rather than taken on faith.
        "files": per_file,
    }
    return [header] + body


def parse_ddl_catalog(sql_text, schema=None, diagnostics=None, identifier_case="exact"):
    """Parse ONE DDL text into ordered catalog records (header first).

    Kept as the single-file entry point; it is :func:`parse_ddl_catalog_files`
    over a one-element sequence.
    """
    return parse_ddl_catalog_files([("(in-memory)", sql_text)], schema=schema,
                                   diagnostics=diagnostics,
                                   identifier_case=identifier_case)


def _emit(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="catalog_ddl.py",
        description="Parse a MySQL DDL dump into a deterministic catalog JSONL stream.",
    )
    parser.add_argument("ddl", nargs="+",
                        help="paths to the MySQL DDL .sql dumps, applied IN THIS ORDER")
    parser.add_argument("--schema", default=None,
                        help="schema name to stamp on records (default: null)")
    parser.add_argument("--identifier-case", default="exact", choices=list(_IDENTIFIER_CASES),
                        dest="identifier_case",
                        help="what makes two table names the SAME table when "
                             "several files are folded (default: exact)")
    args = parser.parse_args(argv)

    files = []
    for p in args.ddl:
        try:
            with open(p, "r", encoding="utf-8") as fh:
                files.append((os.path.basename(p), fh.read()))
        except OSError as e:
            sys.stderr.write("error: cannot read DDL file %r: %s\n" % (p, e))
            return 2

    diagnostics = []
    records = parse_ddl_catalog_files(files, schema=args.schema, diagnostics=diagnostics,
                                      identifier_case=args.identifier_case)

    # Stamp the source basenames only (determinism §2.1 — no absolute path).
    records[0]["source"] = "ddl:" + ",".join(name for name, _ in files)

    out = sys.stdout
    try:
        for rec in records:
            out.write(_emit(rec))
            out.write("\n")
        out.flush()
    except BrokenPipeError:
        # Downstream closed early (e.g. `| head`). Exit quietly, not with a trace.
        try:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
        except OSError:
            pass
        return 0

    for d in diagnostics:
        sys.stderr.write(_emit(d) + "\n")
    header = records[0]
    sys.stderr.write(_emit({
        "level": "info",
        "code": "summary",
        "version": CATALOG_VERSION,
        "tables": header["tables"],
        "columns": header["columns"],
        "commented": header["commented"],
        "files": header["files"],
        "warnings": len(diagnostics),
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
