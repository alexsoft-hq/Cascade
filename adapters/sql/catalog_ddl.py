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

An ALTER that changes a column's nullability or type, or the primary key, is
applied too, so the catalog ends in the state the last statement leaves. What an
ALTER does that this reader cannot apply is named in a diagnostic, never kept
silently as the old state.

CLI: ``python catalog_ddl.py <ddl.sql> [<ddl.sql> ...] [--schema NAME]``
"""

import argparse
import json
import logging
import os
import re
import sys

import sqlglot
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect
from sqlglot.errors import ParseError, TokenError
from sqlglot.tokens import TokenType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from routines import extract_routines  # noqa: E402

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
#   /4 - the STORED ROUTINES a file declares (``CREATE FUNCTION|PROCEDURE``, an
#        Oracle ``PACKAGE BODY``) follow the tables as ``routine`` records with
#        their body text, so a statement that calls one can be read through it.
#        A file that declares none parses to the records /3 wrote.
#   /8 - an ALTER that sets or drops NOT NULL, changes a type (``ALTER COLUMN ...
#        TYPE``, ``ALTER TYPE ... RENAME``), or adds or drops the primary key is
#        applied; an ALTER sqlglot reads only as text is cut into its clauses and
#        read clause by clause; a primary key's columns are NOT NULL, as every
#        database this reader parses for makes them. A file with no such ALTER and
#        every key column written NOT NULL parses to the records /7 wrote.
CATALOG_VERSION = "catalog-ddl/8"

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


def _unnamed(col_def, table_name, source, diagnostics):
    """A column definition the dialect reads with no name: said, and never a
    column named ''. MySQL reads a name in double quotes as a string, so a
    PostgreSQL migration read as MySQL gives one."""
    if col_def.name:
        return False
    _diag(diagnostics, "warn", "column_unnamed", table_name,
          "a column of %s in %s has no name as this dialect reads it, so it is left out: %s. "
          "A name in double quotes is a string in MySQL; check sqlDialects.main"
          % (table_name, source, col_def.sql().replace("\n", " ")[:80]))
    return True


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


def _key_column_names(primary_key):
    """The columns a ``PRIMARY KEY (a, b DESC)`` names, in the order written."""
    names = []
    for e in primary_key.expressions or []:
        node = e.this if isinstance(e, exp.Ordered) else e
        name = getattr(node, "name", None)
        if name:
            names.append(name)
    return names


def _primary_key_columns(col_defs):
    """Column names in the table's PRIMARY KEY — from a table-level
    ``PRIMARY KEY (a, b)`` constraint or an inline column ``PRIMARY KEY``.
    Used to infer join cardinality (a join on a PK is the ``1`` side). Best
    effort: anything not recognized simply yields no PK (cardinality unknown),
    never a guess."""
    pk = set()

    def add_pk(primary_key):
        pk.update(_key_column_names(primary_key))

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


def _primary_key_name(col_defs):
    """The name a CREATE TABLE gives its primary key: ``CONSTRAINT pk_x PRIMARY
    KEY (a)`` or ``a INT CONSTRAINT pk_x PRIMARY KEY``. None when it gives none."""
    for cd in col_defs:
        if isinstance(cd, exp.Constraint):
            if any(isinstance(inner, exp.PrimaryKey) for inner in cd.expressions or []):
                return cd.name or None
        elif isinstance(cd, exp.ColumnDef):
            for c in (cd.args.get("constraints") or []):
                if isinstance(getattr(c, "kind", None), exp.PrimaryKeyColumnConstraint) and c.args.get("this"):
                    return c.args["this"].name or None
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

# WHAT A DATABASE DOES THAT AN ALTER LEAVES UNSAID, keyed by the dialect the run
# parses with. A later statement is read against it: ``DROP CONSTRAINT x`` drops
# the primary key only if x is the key's name, and the DDL often never wrote one.
#   pkNameAlways    MySQL calls its primary key PRIMARY whatever the DDL wrote
#                   (the manual: "The name of a PRIMARY KEY is always PRIMARY").
#   pkNameUnnamed   PostgreSQL names a key declared without a name <table>_pkey.
#                   That is the server's convention, not a word of the file, so a
#                   drop matched through it says so; a name past pkNameMaxBytes is
#                   cut by the server, and is then not known here.
#   dropKeyColumnDropsKey  dropping one column of a key drops the whole key
#                   (PostgreSQL drops "table constraints involving the column";
#                   Oracle needs CASCADE CONSTRAINTS for it). MySQL takes the column
#                   out of the key and keeps the rest.
#   indexRenameRenamesKey  ``ALTER INDEX a RENAME TO b`` renames the key a is the
#                   index of (PostgreSQL: a key and its index share one name).
#   modifyRedefines ``MODIFY c ...`` restates the whole column (MySQL: what it does
#                   not say, NOT NULL or a comment, is gone) or changes only what
#                   it says (Oracle).
# Oracle, H2 and HSQLDB number the names they give an unnamed key (SYS_C...,
# CONSTRAINT_..., SYS_PK_...), so such a key's name is not known there.
_DIALECT_RULES = {
    "postgres": {"database": "PostgreSQL", "pkNameUnnamed": "{table}_pkey", "pkNameMaxBytes": 63,
                 "dropKeyColumnDropsKey": True, "indexRenameRenamesKey": True},
    "mysql": {"database": "MySQL", "pkNameAlways": "PRIMARY", "modifyRedefines": True},
    "oracle": {"database": "Oracle", "dropKeyColumnDropsKey": True, "modifyRedefines": False},
}


class _Table(object):
    """One table as the fold has it so far. Column ORDER is declaration order.

    ``pk_name`` is the name the database knows the primary key by, None when that
    is not known; ``pk_name_said`` is the sentence that says where the name came
    from when it is a convention of the server rather than a word of the file."""

    __slots__ = ("name", "comment", "columns", "pk", "pk_name", "pk_name_said", "declared_in")

    def __init__(self, name, comment, declared_in):
        self.name = name
        self.comment = comment
        self.columns = {}       # column name -> record (insertion-ordered dict)
        self.pk = set()
        self.pk_name = None
        self.pk_name_said = None
        self.declared_in = declared_in


class _Fold(object):
    """What folding the files carries from one statement to the next."""

    __slots__ = ("tables", "schema", "diagnostics", "identifier_case", "dialect", "source")

    def __init__(self, schema, diagnostics, identifier_case, dialect):
        self.tables = {}    # folded table name -> _Table (the record keeps the name as written)
        self.schema = schema
        self.diagnostics = diagnostics
        self.identifier_case = identifier_case
        self.dialect = dialect
        self.source = None

    def rule(self, key):
        return _DIALECT_RULES.get(self.dialect or "", {}).get(key)

    def same(self, a, b):
        return _fold(a, self.identifier_case) == _fold(b, self.identifier_case)

    def say(self, level, code, table, message):
        _diag(self.diagnostics, level, code, table, message)


def _parse_statements(sql_text, diagnostics, source, dialect="mysql"):
    """Every statement of one file: read whole, then whole with the backslash rule turned round,
    then one statement at a time when neither reading can tokenize it."""
    try:
        return _parse_whole(sql_text, diagnostics, source, dialect)
    except TokenError as e:
        error = e
    try:
        statements = _parse_whole(sql_text, diagnostics, source, _escapes_turned(dialect))
    except TokenError:
        return _parse_each_statement(sql_text, diagnostics, source, dialect, error)
    _diag(
        diagnostics,
        "warn",
        "token_error",
        None,
        "%s could not be tokenized as %s (%s); read whole with backslash escapes %s, as a file written "
        "for another database's string quoting is" % (source, dialect or "the default dialect",
                                                     str(error).split("\n")[0], _escapes_turned_word(dialect)),
    )
    return statements


def _backslash_escapes(dialect):
    return "\\" in Dialect.get_or_raise(dialect).tokenizer_class.STRING_ESCAPES


def _escapes_turned_word(dialect):
    return "off" if _backslash_escapes(dialect) else "on"


_ESCAPES_TURNED = {}


def _escapes_turned(dialect):
    """The run's dialect with backslash escapes the other way round: MySQL as it reads a file under
    NO_BACKSLASH_ESCAPES, or a dialect without them as MySQL reads a string. A schema written for
    PostgreSQL keeps 'C:\\' as a whole string; read as MySQL, that backslash swallows the quote and
    throws every quote after it out of step. Only the string rule changes: identifiers, keywords and
    types are still read as the run's dialect."""
    key = dialect or ""
    if key not in _ESCAPES_TURNED:
        base = Dialect.get_or_raise(dialect).__class__
        escapes = list(base.tokenizer_class.STRING_ESCAPES)
        turned = [e for e in escapes if e != "\\"] if "\\" in escapes else escapes + ["\\"]
        tokenizer = type("Tokenizer", (base.tokenizer_class,), {"STRING_ESCAPES": turned})
        _ESCAPES_TURNED[key] = type("CascadeEscapesTurned" + base.__name__, (base,), {"Tokenizer": tokenizer})
    return _ESCAPES_TURNED[key]


def _parse_whole(sql_text, diagnostics, source, dialect):
    """sqlglot.parse with the same salvage path the single-file reader had."""
    try:
        return sqlglot.parse(sql_text, read=dialect)
    except ParseError as e:
        _diag(
            diagnostics,
            "warn",
            "parse_error",
            None,
            "full parse of %s failed, salvaging with error_level=IGNORE: %s"
            % (source, str(e).replace("\n", " ")),
        )
        return sqlglot.parse(sql_text, read=dialect, error_level=sqlglot.ErrorLevel.IGNORE)


# A data statement fills a table and never declares one, so the catalog has no use for it.
_DATA_STATEMENT_RE = re.compile(r"^\s*(?:INSERT|UPDATE|DELETE|MERGE|REPLACE|COPY)\b", re.IGNORECASE)
# A line ends a statement when it ends in a semicolon, with any comments after it: block
# comments, then at most one line comment ("; /* seed */ -- batch 1"). A literal that holds
# "; --" at the end of a line is cut there too, and the piece after the cut is then read, or
# named as unreadable, on its own.
_STATEMENT_END_RE = re.compile(r";\s*(?:/\*.*?\*/\s*)*(?:(?:--|#).*)?$")
# A line inside a skipped data statement that would start a table declaration: the sign that a
# statement boundary was missed and a table is about to be skipped with the data.
_CREATE_TABLE_LINE_RE = re.compile(r"^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)", re.IGNORECASE | re.MULTILINE)
# The comment lines and blank lines a dump writes above a statement.
_LEADING_COMMENTS_RE = re.compile(r"\A(?:\s*(?:(?:--|#)[^\n]*(?:\n|\Z)|/\*.*?\*/))*\s*", re.DOTALL)
_CREATE_TABLE_NAME_RE = re.compile(r"^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)", re.IGNORECASE)
# How many unreadable statements a diagnostic names before it only counts the rest.
_UNREADABLE_NAMED = 10


def _statements_by_line(sql_text):
    """The text cut where a line ends in a semicolon: how schema files and data dumps are written."""
    chunks, current = [], []
    for line in sql_text.splitlines(keepends=True):
        current.append(line)
        if _STATEMENT_END_RE.search(line.rstrip()):
            chunks.append("".join(current))
            current = []
    rest = "".join(current)
    if rest.strip():
        chunks.append(rest)
    return chunks


def _code_of(chunk):
    """A statement from its first word: the comments written above it are not how it starts."""
    return _LEADING_COMMENTS_RE.sub("", chunk, count=1)


def _statement_label(chunk):
    """What a diagnostic calls a statement it could not read: the table it declares, or how it starts."""
    code = _code_of(chunk)
    m = _CREATE_TABLE_NAME_RE.match(code)
    if m:
        return "CREATE TABLE %s" % m.group(1)
    return " ".join(code.split())[:40]


def _parse_each_statement(sql_text, diagnostics, source, dialect, error):
    """A file the tokenizer cannot read as a whole, read one statement at a time.

    A quote the dialect reads differently (a backslash escapes in MySQL and not in
    PostgreSQL) throws every statement after it out of step, and one bad literal in
    a data dump used to end the whole analysis. Cut at line-end semicolons, the
    miscount stays inside the statement it belongs to. Data statements are skipped
    unread; a statement that still cannot be read is named, never dropped silently.
    """
    statements, unreadable = [], []
    for chunk in _statements_by_line(sql_text):
        if _DATA_STATEMENT_RE.match(_code_of(chunk)):
            # Skipped unread, but never silently with a table inside it.
            unreadable.extend("CREATE TABLE %s (inside a skipped data statement)" % m.group(1)
                              for m in _CREATE_TABLE_LINE_RE.finditer(chunk))
            continue
        try:
            statements.extend(sqlglot.parse(chunk, read=dialect, error_level=sqlglot.ErrorLevel.IGNORE))
        except (ParseError, TokenError):
            unreadable.append(_statement_label(chunk))
    named = ", ".join(unreadable[:_UNREADABLE_NAMED])
    more = len(unreadable) - _UNREADABLE_NAMED
    _diag(
        diagnostics,
        "warn",
        "token_error",
        None,
        "%s could not be tokenized as a whole (%s); read one statement at a time with data statements "
        "skipped, %d statement(s) unreadable%s%s"
        % (source, str(error).split("\n")[0], len(unreadable), (": " + named) if named else "",
           (" and %d more" % more) if more > 0 else ""),
    )
    return statements


def _apply_create(stmt, ctx):
    source, diagnostics = ctx.source, ctx.diagnostics
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

    key = _fold(table_name, ctx.identifier_case)
    existing = ctx.tables.get(key)
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
        if _unnamed(col_def, table_name, source, diagnostics):
            continue
        try:
            rec = _column_record(col_def, ctx.schema, table_name)
        except Exception as e:  # noqa: BLE001
            _diag(diagnostics, "warn", "column_read_failed", table_name,
                  "a column of %s in %s could not be read: %s"
                  % (table_name, source, str(e).replace("\n", " ")))
            continue
        tbl.columns[rec["column"]] = rec
    tbl.pk = set(pk_cols)
    _name_primary_key(tbl, _primary_key_name(col_defs), ctx)
    _key_columns_not_null(tbl)
    ctx.tables[key] = tbl


def _column_is_pk(col_def):
    for c in (col_def.args.get("constraints") or []):
        if isinstance(getattr(c, "kind", None), exp.PrimaryKeyColumnConstraint):
            return True
    return False


def _name_primary_key(tbl, declared, ctx):
    """The name the database knows the primary key by: the one the database always
    uses, else the one written, else the one its convention gives a key with none."""
    tbl.pk_name, tbl.pk_name_said = None, None
    if not tbl.pk:
        return
    if ctx.rule("pkNameAlways"):
        tbl.pk_name = ctx.rule("pkNameAlways")
    elif declared:
        tbl.pk_name = declared
    elif ctx.rule("pkNameUnnamed"):
        name = ctx.rule("pkNameUnnamed").format(table=tbl.name)
        if len(name.encode("utf-8")) <= ctx.rule("pkNameMaxBytes"):
            tbl.pk_name = name
            tbl.pk_name_said = ("it was declared without a name, and %s names such a key %s by convention"
                                % (ctx.rule("database"), ctx.rule("pkNameUnnamed").replace("{table}", "<table>")))


def _key_columns_not_null(tbl):
    """A primary key's columns hold no NULL. Every database this reader parses for
    makes them NOT NULL whether the DDL says so or not (MySQL "implicitly (and
    silently)"), and a key dropped later leaves them NOT NULL here, as MySQL does."""
    for name in tbl.pk:
        rec = tbl.columns.get(name)
        if rec is not None:
            rec["nullable"] = False


def _rename_table(ctx, old, new):
    old_key = _fold(old, ctx.identifier_case)
    new_key = _fold(new, ctx.identifier_case)
    tbl = ctx.tables.get(old_key)
    if tbl is None:
        ctx.say("warn", "alter_unknown_table", old,
                "%s renames %s, which no file declared before it; ignored" % (ctx.source, old))
        return
    if new_key in ctx.tables:
        ctx.say("warn", "DUPLICATE_TABLE_DECLARATION", new,
                "%s renames %s to %s, but %s already exists; the rename is ignored"
                % (ctx.source, old, new, new))
        return
    # Rebuild in place so the table keeps its position in the fold order. A key
    # keeps the name it had: no database renames a constraint with its table.
    rebuilt = {}
    for name, tb in ctx.tables.items():
        if name == old_key:
            tb.name = new
            for rec in tb.columns.values():
                rec["table"] = new
            rebuilt[new_key] = tb
        else:
            rebuilt[name] = tb
    ctx.tables.clear()
    ctx.tables.update(rebuilt)


def _rename_tables(text, ctx):
    """``RENAME TABLE a TO b, c TO d``, read out of the text sqlglot left it as."""
    body = re.sub(r"^\s*TABLE\s+", "", str(text), flags=re.IGNORECASE)
    pairs = _RENAME_TABLE_RE.findall(body)
    if not pairs:
        ctx.say("warn", "alter_clause_unsupported", None,
                "%s: RENAME statement could not be read (%r); ignored" % (ctx.source, text))
    for old, new in pairs:
        _rename_table(ctx, old, new)
    return len(pairs)


# ---------------------------------------------------------------------------
# ALTER TABLE, clause by clause: the state the statement leaves.
# ---------------------------------------------------------------------------

def _short(text):
    text = " ".join(str(text).split())
    return text if len(text) <= 120 else text[:117] + "..."


def _clause_text(node, ctx):
    try:
        return _short(node.sql(dialect=ctx.dialect or None))
    except Exception:  # noqa: BLE001 - a clause is named even when it cannot be printed
        return type(node).__name__


def _command_text(cmd):
    """What sqlglot kept of a statement or clause it read only as text."""
    body = cmd.args.get("expression")
    body = body.name if isinstance(body, exp.Expression) else (body or "")
    return ("%s %s" % (cmd.name or "", body)).strip()


def _not_held(tbl, what, ctx):
    """A clause that changes nothing this catalog holds (an index, a foreign key, a
    default): not applied, and said, as every clause not applied is."""
    ctx.say("warn", "alter_clause_unsupported", tbl.name,
            "%s: %s on %s is not applied to the catalog (it changes no column, type, nullability or primary key)"
            % (ctx.source, what, tbl.name))


def _unreadable(table_name, text, ctx):
    ctx.say("warn", "alter_unreadable", table_name,
            "%s: ALTER TABLE %s %s could not be read, so it is not applied; if it changes a column, a type, "
            "nullability, a comment or the primary key of %s, the catalog does not show it"
            % (ctx.source, table_name, _short(text), table_name))


def _unknown_column(tbl, verb, name, ctx, outcome="ignored"):
    ctx.say("warn", "alter_unknown_column", tbl.name,
            "%s %s %s.%s, which is not there; %s" % (ctx.source, verb, tbl.name, name, outcome))


def _column_key(tbl, name, ctx):
    """The column of ``tbl`` a statement means by ``name``: spelled the same, or the same under the fold."""
    if not name:
        return None
    if name in tbl.columns:
        return name
    return next((key for key in tbl.columns if ctx.same(key, name)), None)


def _replace_column(tbl, old_key, rec):
    """The column ``old_key`` becomes ``rec``, in its place; a rename takes its key membership along."""
    rebuilt = {}
    for name, existing in tbl.columns.items():
        if name == old_key:
            rebuilt[rec["column"]] = rec
        else:
            rebuilt[name] = existing
    tbl.columns = rebuilt
    if old_key in tbl.pk and old_key != rec["column"]:
        tbl.pk.discard(old_key)
        tbl.pk.add(rec["column"])


def _set_nullable(tbl, key, nullable, ctx):
    if nullable and key in tbl.pk:
        ctx.say("warn", "alter_primary_key_not_null", tbl.name,
                "%s lets %s.%s hold NULL, but it is in the primary key, which holds none; it is kept NOT NULL"
                % (ctx.source, tbl.name, key))
        return
    tbl.columns[key]["nullable"] = nullable


def _drop_primary_key(tbl, _action=None, _ctx=None):
    tbl.pk = set()
    tbl.pk_name, tbl.pk_name_said = None, None


def _set_primary_key(tbl, names, declared, ctx):
    """ADD PRIMARY KEY: the key is these columns now, and they hold no NULL."""
    keys = [_column_key(tbl, n, ctx) for n in names]
    missing = [n for n, k in zip(names, keys) if k is None]
    if missing:
        _unknown_column(tbl, "adds a primary key on", ", ".join(missing), ctx)
        return
    if tbl.pk and tbl.pk != set(keys):
        ctx.say("warn", "alter_primary_key_replaced", tbl.name,
                "%s adds a primary key (%s) to %s, which has one (%s) as this reader has read the files. "
                "A database refuses a second key, so a drop this reader could not apply is taken to have "
                "come first, and the new key is kept"
                % (ctx.source, ", ".join(keys), tbl.name, ", ".join(sorted(tbl.pk))))
    tbl.pk = set(keys)
    _name_primary_key(tbl, declared, ctx)
    _key_columns_not_null(tbl)


def _drop_constraint(tbl, name, ctx, what):
    """DROP CONSTRAINT / INDEX / KEY <name>: the primary key when <name> is the key's
    name, and nothing held when it is another's. When the key's name is not known,
    which of the two it is cannot be told, and the key is kept and said."""
    if not tbl.pk:
        _not_held(tbl, what, ctx)
        return
    if tbl.pk_name is None:
        ctx.say("warn", "alter_primary_key_unknown", tbl.name,
                "%s: %s on %s may drop its primary key (%s), whose name is not known here; the key is kept"
                % (ctx.source, what, tbl.name, ", ".join(sorted(tbl.pk))))
        return
    if not ctx.same(name or "", tbl.pk_name):
        _not_held(tbl, what, ctx)
        return
    if tbl.pk_name_said:
        ctx.say("info", "alter_primary_key_by_convention", tbl.name,
                "%s: %s is read as dropping the primary key of %s (%s): %s"
                % (ctx.source, what, tbl.name, ", ".join(sorted(tbl.pk)), tbl.pk_name_said))
    _drop_primary_key(tbl)


def _drop_column(tbl, name, ctx):
    key = _column_key(tbl, name, ctx)
    if key is None:
        _unknown_column(tbl, "drops", name, ctx)
        return
    del tbl.columns[key]
    if key not in tbl.pk:
        return
    if ctx.rule("dropKeyColumnDropsKey"):
        _drop_primary_key(tbl)
    else:
        tbl.pk.discard(key)
        if not tbl.pk:
            _drop_primary_key(tbl)


def _add_column(tbl, col_def, ctx):
    if _unnamed(col_def, tbl.name, ctx.source, ctx.diagnostics):
        return
    rec = _column_record(col_def, ctx.schema, tbl.name)
    if _column_key(tbl, rec["column"], ctx) is not None:
        # Re-adding an existing column is the same disagreement as a
        # duplicate table: the later file is describing a different
        # history. Keep what is there and say so.
        ctx.say("warn", "duplicate_column", tbl.name,
                "%s adds %s.%s, which already exists; kept as declared" % (ctx.source, tbl.name, rec["column"]))
        return
    tbl.columns[rec["column"]] = rec
    if _column_is_pk(col_def):
        _set_primary_key(tbl, [rec["column"]], _primary_key_name([col_def]), ctx)


def _add_listed(tbl, schema_node, ctx):
    """Oracle's ``ADD (c1 ..., c2 ..., CONSTRAINT ...)``: each column added, each constraint read."""
    for item in schema_node.expressions or []:
        if isinstance(item, exp.ColumnDef):
            _add_column(tbl, item, ctx)
        else:
            _add_one_constraint(tbl, item, ctx)


def _add_constraint(tbl, action, ctx):
    for c in action.expressions or []:
        _add_one_constraint(tbl, c, ctx)


def _add_one_constraint(tbl, c, ctx):
    """ADD [CONSTRAINT name] PRIMARY KEY (...) sets the key; any other constraint holds nothing here."""
    name, inner = None, c
    if isinstance(c, exp.Constraint):
        keys = [i for i in c.expressions or [] if isinstance(i, exp.PrimaryKey)]
        name, inner = c.name or None, (keys[0] if keys else c)
    if not isinstance(inner, exp.PrimaryKey):
        _not_held(tbl, _ALTER_CLAUSE_NAMES["AddConstraint"], ctx)
        return
    names = _key_column_names(inner)
    if not names:
        _unreadable(tbl.name, "ADD " + _clause_text(c, ctx), ctx)
        return
    _set_primary_key(tbl, names, name, ctx)


def _drop(tbl, action, ctx):
    kind = str(action.args.get("kind") or "").upper()
    name = action.this.name if action.this is not None else None
    what = ("DROP %s %s" % (kind, name)) if kind else _clause_text(action, ctx)
    if kind == "COLUMN":
        _drop_column(tbl, name, ctx)
    elif kind in ("CONSTRAINT", "INDEX", "KEY"):
        _drop_constraint(tbl, name, ctx, what)
    else:
        _not_held(tbl, what, ctx)


def _changed_only(old, col_def, rec):
    """Oracle's MODIFY: what the clause says changes, what it does not say stays."""
    kept = dict(old)
    if col_def.args.get("kind") is not None:
        kept["type"] = rec["type"]
    if any(isinstance(getattr(c, "kind", None), exp.NotNullColumnConstraint)
           for c in col_def.args.get("constraints") or []):
        kept["nullable"] = rec["nullable"]
    return kept


def _restate_column(tbl, col_def, old_ident, ctx):
    """MODIFY / CHANGE: the column as the clause states it, in its place."""
    if _unnamed(col_def, tbl.name, ctx.source, ctx.diagnostics):
        return
    rec = _column_record(col_def, ctx.schema, tbl.name)
    old_name = old_ident.name if old_ident is not None else rec["column"]
    old_key = _column_key(tbl, old_name, ctx)
    if old_key is None:
        _unknown_column(tbl, "modifies", old_name, ctx, "added as declared")
        tbl.columns[rec["column"]] = rec
        return
    if ctx.rule("modifyRedefines") is False:
        rec = _changed_only(tbl.columns[old_key], col_def, rec)
    _replace_column(tbl, old_key, rec)
    if _column_is_pk(col_def):
        _set_primary_key(tbl, [rec["column"]], _primary_key_name([col_def]), ctx)
    _key_columns_not_null(tbl)


def _modify_column(tbl, action, ctx):
    if not isinstance(action.this, exp.ColumnDef):
        _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        return
    _restate_column(tbl, action.this, action.args.get("rename_from"), ctx)


def _rename_column(tbl, action, ctx):
    old = action.this.name if action.this is not None else None
    new = action.args["to"].name if action.args.get("to") is not None else None
    key = _column_key(tbl, old, ctx)
    if key is None or not new:
        _unknown_column(tbl, "renames", old, ctx)
        return
    _replace_column(tbl, key, dict(tbl.columns[key], column=new))


def _alter_column(tbl, action, ctx):
    """ALTER COLUMN c SET NOT NULL | DROP NOT NULL | [SET DATA] TYPE t | SET / DROP DEFAULT."""
    allow_null, dtype = action.args.get("allow_null"), action.args.get("dtype")
    default = action.args.get("default") is not None or (action.args.get("drop") and allow_null is None)
    if allow_null is None and dtype is None and not default:
        _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        return
    name = action.this.name if action.this is not None else None
    key = _column_key(tbl, name, ctx)
    if key is None:
        _unknown_column(tbl, "alters", name, ctx)
        return
    if dtype is not None:
        tbl.columns[key]["type"] = _type_text(dtype)
    if allow_null is not None:
        _set_nullable(tbl, key, bool(allow_null), ctx)
    if default:
        _not_held(tbl, _clause_text(action, ctx), ctx)


# The clauses sqlglot leaves as text, read here. A name is written bare or quoted
# in any of the three ways the dialects quote.
_NAME = r'(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s,.()"`\[\]]+)'
_QNAME = _NAME + r"(?:\s*\.\s*" + _NAME + r")*"
_CLAUSE_FLAGS = re.IGNORECASE | re.DOTALL
_NULL_ONLY_RE = re.compile(r"^(%s)\s+(NOT\s+)?NULL\s*$" % _NAME, _CLAUSE_FLAGS)


def _unquote(name):
    name = name.strip()
    if len(name) >= 2 and name[0] + name[-1] in ('""', "``", "[]"):
        return name[1:-1]
    return name


def _top_level(text, ctx):
    """``text`` cut at its commas outside brackets and strings, as the dialect tokenizes it."""
    try:
        tokens = Dialect.get_or_raise(ctx.dialect).tokenize(text)
    except (TokenError, ParseError, ValueError):
        return None
    pieces, depth, first = [], 0, 0
    for i, t in enumerate(tokens):
        if t.token_type == TokenType.L_PAREN:
            depth += 1
        elif t.token_type == TokenType.R_PAREN:
            depth -= 1
        elif t.token_type == TokenType.COMMA and depth == 0:
            pieces.append(text[tokens[first].start:t.start].strip() if first < i else "")
            first = i + 1
    if first < len(tokens):
        pieces.append(text[tokens[first].start:tokens[-1].end + 1].strip())
    return [p for p in pieces if p]


def _parse_quietly(sql, ctx):
    """One statement, parsed with sqlglot's fall-back warning held back: the parse of
    the whole file warned about this statement once already."""
    logger = logging.getLogger("sqlglot")
    level = logger.level
    logger.setLevel(logging.ERROR)
    try:
        parsed = [p for p in sqlglot.parse(sql, read=ctx.dialect) if p is not None]
    except (ParseError, TokenError):
        return None
    finally:
        logger.setLevel(level)
    return parsed[0] if len(parsed) == 1 else None


def _column_spec(spec, ctx):
    """A column as a MODIFY clause states it, type or no type, read as the dialect reads a column."""
    created = _parse_quietly("CREATE TABLE cascade_clause (%s)" % spec, ctx)
    cols = created.this.expressions if isinstance(created, exp.Create) and isinstance(created.this, exp.Schema) else []
    return cols[0] if len(cols) == 1 and isinstance(cols[0], exp.ColumnDef) else None


def _restate_specs(tbl, m, text, ctx):
    """``MODIFY c ...`` / ``MODIFY (c1 ..., c2 ...)``: each column as the clause restates it.
    ``c NULL`` says only nullability; read as a column, NULL would be its type."""
    for spec in _top_level(m.group(1), ctx) or [m.group(1)]:
        only = _NULL_ONLY_RE.match(spec)
        if only:
            _set_null_text(tbl, only, spec, ctx)
            continue
        col_def = _column_spec(spec, ctx)
        kind = col_def.args.get("kind") if col_def is not None else None
        if col_def is None or (isinstance(kind, exp.DataType) and kind.this == exp.DataType.Type.NULL):
            _unreadable(tbl.name, "MODIFY " + spec, ctx)
            continue
        _restate_column(tbl, col_def, None, ctx)


def _add_key_text(tbl, m, text, ctx):
    columns = [re.match(_NAME, piece) for piece in _top_level(m.group(2), ctx) or []]
    if not columns or any(c is None for c in columns):
        _unreadable(tbl.name, text, ctx)
        return
    _set_primary_key(tbl, [_unquote(c.group(0)) for c in columns], _unquote(m.group(1)) if m.group(1) else None, ctx)


def _set_null_text(tbl, m, text, ctx):
    key = _column_key(tbl, _unquote(m.group(1)), ctx)
    if key is None:
        _unknown_column(tbl, "alters", _unquote(m.group(1)), ctx)
        return
    _set_nullable(tbl, key, not m.group(2), ctx)


def _rename_constraint_text(tbl, m, text, ctx):
    if tbl.pk_name is not None and ctx.same(_unquote(m.group(1)), tbl.pk_name):
        tbl.pk_name, tbl.pk_name_said = _unquote(m.group(2)), None
    elif tbl.pk and tbl.pk_name is None:
        ctx.say("warn", "alter_primary_key_unknown", tbl.name,
                "%s: %s on %s may rename its primary key, whose name is not known here"
                % (ctx.source, _short(text), tbl.name))
    else:
        _not_held(tbl, _short(text), ctx)


_CLAUSE_READERS = (
    (re.compile(r"^DROP\s+PRIMARY\s+KEY(?:\s+(?:CASCADE|KEEP\s+INDEX|DROP\s+INDEX|ONLINE))*\s*$", _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _drop_primary_key(tbl)),
    (re.compile(r"^DROP\s+(?:CONSTRAINT|INDEX|KEY)\s+(?:IF\s+EXISTS\s+)?(%s)(?:\s+(?:CASCADE|RESTRICT))?\s*$" % _NAME,
                _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _drop_constraint(tbl, _unquote(m.group(1)), ctx, _short(text))),
    (re.compile(r"^ADD\s+(?:CONSTRAINT\s+(?:(?!PRIMARY\s+KEY)(%s)\s+)?)?PRIMARY\s+KEY\s*(?:USING\s+\w+\s*)?"
                r"\((.*)\)(?:\s*USING\s+\w+)?\s*$" % _NAME, _CLAUSE_FLAGS),
     _add_key_text),
    (re.compile(r"^ALTER\s+(?:COLUMN\s+)?(%s)\s+SET\s+(NOT\s+)?NULL\s*$" % _NAME, _CLAUSE_FLAGS),
     _set_null_text),
    (re.compile(r"^MODIFY\s*\((.*)\)\s*$", _CLAUSE_FLAGS), _restate_specs),
    (re.compile(r"^MODIFY\s+(?:COLUMN\s+)?(.+)$", _CLAUSE_FLAGS), _restate_specs),
    (re.compile(r"^RENAME\s+CONSTRAINT\s+(%s)\s+TO\s+(%s)\s*$" % (_NAME, _NAME), _CLAUSE_FLAGS),
     _rename_constraint_text),
    # Clauses that touch no column, type, nullability or key: ownership, triggers,
    # row security, clustering, storage.
    (re.compile(r"^(?:OWNER\s+TO|ENABLE|DISABLE|CLUSTER\s+ON|SET\s+WITHOUT\s+CLUSTER|REPLICA\s+IDENTITY|"
                r"SET\s+TABLESPACE|VALIDATE\s+CONSTRAINT|(?:NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY)\b", _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _not_held(tbl, _short(text), ctx)),
)


def _read_clause(tbl, text, ctx):
    """One clause sqlglot left as text, read by the first form it has; named when it has none."""
    text = text.strip()
    for pattern, apply in _CLAUSE_READERS:
        m = pattern.match(text)
        if m:
            apply(tbl, m, text, ctx)
            return
    _unreadable(tbl.name, text, ctx)


_ACTIONS = {
    exp.ColumnDef: _add_column,
    exp.Schema: _add_listed,
    exp.Drop: _drop,
    exp.DropPrimaryKey: _drop_primary_key,
    exp.ModifyColumn: _modify_column,
    exp.AlterColumn: _alter_column,
    exp.AddConstraint: _add_constraint,
    exp.RenameColumn: _rename_column,
    exp.AlterSet: lambda tbl, action, ctx: _not_held(tbl, _ALTER_CLAUSE_NAMES["AlterSet"], ctx),
    exp.Command: lambda tbl, action, ctx: _read_clause(tbl, _command_text(action), ctx),
}


def _altered_table(table_name, ctx):
    tbl = ctx.tables.get(_fold(table_name, ctx.identifier_case))
    if tbl is None:
        ctx.say("warn", "alter_unknown_table", table_name,
                "%s alters %s, which no file declared before it; ignored" % (ctx.source, table_name))
    return tbl


def _apply_alter(stmt, ctx):
    """Apply one ALTER TABLE, clause by clause. Every clause not applied is named."""
    table_name = getattr(stmt.this, "name", None)
    if not table_name:
        ctx.say("warn", "alter_read_failed", None, "ALTER in %s has no readable table name; ignored" % ctx.source)
        return
    for action in stmt.args.get("actions") or []:
        if isinstance(action, exp.AlterRename):
            _rename_table(ctx, table_name, action.this.name)
            table_name = action.this.name
            continue
        tbl = _altered_table(table_name, ctx)
        if tbl is None:
            return
        apply = _ACTIONS.get(type(action))
        if apply is None:
            _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        else:
            apply(tbl, action, ctx)


def _split_alter_table(body, ctx):
    """``TABLE [IF EXISTS] [ONLY] <name> <clause>, <clause> ...`` as the text up to the
    name, the table's name, and the clauses."""
    try:
        tokens = Dialect.get_or_raise(ctx.dialect).tokenize(body)
    except (TokenError, ParseError, ValueError):
        return None
    i = 1
    while i < len(tokens) and tokens[i].token_type != TokenType.IDENTIFIER and tokens[i].text.upper() in ("IF", "EXISTS", "ONLY"):
        i += 1
    while i + 2 < len(tokens) and tokens[i + 1].token_type == TokenType.DOT:
        i += 2
    if i + 1 >= len(tokens):
        return None
    clauses = _top_level(body[tokens[i + 1].start:], ctx)
    return (body[tokens[0].start:tokens[i].end + 1], tokens[i].text, clauses) if clauses else None


def _apply_alter_table_text(body, ctx):
    """An ALTER TABLE sqlglot reads only as text, most often because its clauses are
    of different kinds (``DROP CONSTRAINT a, ADD CONSTRAINT a PRIMARY KEY (id)``):
    each clause read as an ALTER TABLE of its own, in the order written."""
    split = _split_alter_table(body, ctx)
    if split is None:
        ctx.say("warn", "alter_unreadable", None,
                "%s: ALTER %s could not be read, so it is not applied; if it changes a column, a type, "
                "nullability, a comment or a primary key, the catalog does not show it" % (ctx.source, _short(body)))
        return
    head, table_name, clauses = split
    for clause in clauses:
        parsed = _parse_quietly("ALTER %s %s" % (head, clause), ctx)
        if isinstance(parsed, exp.Alter) and str(parsed.args.get("kind") or "").upper() == "TABLE":
            _apply_alter(parsed, ctx)
            continue
        tbl = _altered_table(table_name, ctx)
        if tbl is None:
            return
        _read_clause(tbl, clause, ctx)


_TYPE_RENAME_RE = re.compile(r"^TYPE\s+(%s)\s+RENAME\s+TO\s+(%s)\s*$" % (_QNAME, _NAME), _CLAUSE_FLAGS)


def _name_parts(text):
    """The parts of a dotted name as written, or None when ``text`` is not one (``VARCHAR(10)``)."""
    text = (text or "").strip()
    if not re.fullmatch(_QNAME, text):
        return None
    return re.findall(_NAME, text)


def _rename_type(body, ctx):
    """``ALTER TYPE a RENAME TO b``: a column of type a is of type b now, so a type
    swapped in through a new name (PostgreSQL's way to drop an enum value) ends as
    the name the last statement gives it."""
    m = _TYPE_RENAME_RE.match(body.strip())
    if not m:
        return
    old = _name_parts(m.group(1))
    for tbl in ctx.tables.values():
        for rec in tbl.columns.values():
            parts = _name_parts(rec.get("type"))
            if not parts or not ctx.same(_unquote(parts[-1]), _unquote(old[-1])):
                continue
            if len(parts) > 1 and len(old) > 1 and not ctx.same(_unquote(parts[-2]), _unquote(old[-2])):
                continue
            rec["type"] = ".".join(parts[:-1] + [m.group(2).strip()])


def _rename_index(stmt, ctx):
    """``ALTER INDEX a RENAME TO b``: where a key and its index share one name, the key's name follows."""
    old = getattr(stmt.this, "name", None)
    if not ctx.rule("indexRenameRenamesKey") or not old:
        return
    for action in stmt.args.get("actions") or []:
        if not isinstance(action, exp.AlterRename):
            continue
        for tbl in ctx.tables.values():
            if tbl.pk_name is not None and ctx.same(tbl.pk_name, old):
                tbl.pk_name, tbl.pk_name_said = action.this.name, None


def _apply_statement(stmt, ctx):
    """One statement folded in. Returns how many table alterations it carried."""
    if isinstance(stmt, exp.Create) and stmt.kind == "TABLE":
        _apply_create(stmt, ctx)
    elif isinstance(stmt, exp.Alter):
        kind = str(stmt.args.get("kind") or "").upper()
        if kind == "TABLE":
            _apply_alter(stmt, ctx)
            return 1
        if kind == "INDEX":
            _rename_index(stmt, ctx)
    elif isinstance(stmt, exp.Command):
        word = str(stmt.name or "").upper()
        body = _command_text(stmt)[len(word):].strip()
        if word == "RENAME":
            return _rename_tables(body, ctx)
        if word == "ALTER" and re.match(r"TABLE\b", body, re.IGNORECASE):
            _apply_alter_table_text(body, ctx)
            return 1
        if word == "ALTER" and re.match(r"TYPE\b", body, re.IGNORECASE):
            _rename_type(body, ctx)
    # everything else (INSERT/UPDATE/CREATE INDEX/…) is skipped silently
    return 0


def parse_ddl_catalog_files(files, schema=None, diagnostics=None, identifier_case="exact", dialect="mysql"):
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
    ctx = _Fold(schema, diagnostics, identifier_case, dialect)
    per_file = []
    routines = []
    for source, sql_text in files:
        ctx.source = source
        before = len(ctx.tables)
        routines.extend(extract_routines(sql_text, source))
        statements = _parse_statements(sql_text, diagnostics, source, dialect)
        alters = 0
        for stmt in statements:
            if stmt is not None:
                alters += _apply_statement(stmt, ctx)
        per_file.append({"source": source, "tablesAfter": len(ctx.tables),
                         "tablesAdded": len(ctx.tables) - before, "alters": alters})

    ordered = sorted(ctx.tables.values(), key=lambda t: t.name)
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

    # THE ROUTINES, after every table, in name order and then in the order the
    # files declared them: the last declaration of a name is the one a database
    # that ran these files holds, and the lineage reads the last.
    for r in sorted(routines, key=lambda r: r["name"].lower()):
        body.append({"kind": "routine", "schema": schema, "name": r["name"], "routineKind": r["routineKind"],
                     "language": r["language"], "body": r["body"], "source": r["source"], "line": r["line"]})

    header = {
        "kind": "header",
        "schema": CATALOG_SCHEMA,
        "version": CATALOG_VERSION,
        "source": None,  # filled by the CLI (basenames); None when parsed in-memory
        "dialect": dialect,
        "tables": len(ordered),
        "columns": n_columns,
        "commented": n_commented,
        **({"routines": len(routines)} if routines else {}),
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
    parser.add_argument("--dialect", default="mysql",
                        help="the SQL dialect the files are written in (default: mysql)")
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
                                      identifier_case=args.identifier_case, dialect=args.dialect)

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
