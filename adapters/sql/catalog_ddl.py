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
(and, run from the command line, into the header's ``diagnostics``) and
processing continues — a table is never dropped without a trace.

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
#   /9 - an ALTER is read by the rules of the DATABASE the files are for
#        (``--database``), not of the grammar they are parsed with: H2 and HSQLDB
#        no longer take MySQL's "the key is always PRIMARY", and a database with no
#        rule of its own leaves an unnamed key's name unknown and says so. Read too:
#        PostgreSQL ``RENAME c TO d`` without COLUMN, ``DROP c`` without COLUMN,
#        Oracle's ``DROP (c)`` and the ``USING INDEX ... ENABLE`` an export writes
#        after a key, H2's ``ALTER COLUMN c RENAME TO d``, MariaDB's ``MODIFY COLUMN
#        IF EXISTS``, and the clauses sqlglot keeps as one piece of text.
#   /10 - a CREATE TABLE the grammar cannot read as written (an Oracle export's
#        ``NOT NULL ENABLE``, ``USING INDEX ... ENABLE`` and PCTFREE/STORAGE/
#        TABLESPACE, HSQLDB's CACHED and MEMORY tables) is read again with what
#        the catalog does not hold set aside and said; a disabled constraint is
#        not read; one that still cannot be read is named, where it was dropped
#        without a word. MySQL's ALTER TABLE ... COMMENT sets the table comment,
#        and H2's ALTER COLUMN c <definition> is read as MODIFY is. A file every
#        statement of which the grammar reads parses to the records /9 wrote.
#   /11 - what is set aside is recognized by its whole shape (review 4): a column
#        named key or index is a column, a tail word that is no table option this
#        reader knows (INHERITS) is not set aside, and MySQL's ``KEY idx (c)`` that
#        a grammar reads as a column named KEY is not a column. INHERITS gives the
#        parent's columns; a CREATE TABLE a database reads in a compatibility mode
#        (H2's MODE=MySQL) is read by that mode's grammar; statements a script
#        writes with no semicolons are read one by one; H2's DROP COLUMN (c, d)
#        drops each. A file with none of these parses to the records /10 wrote.
#   /12 - the header carries the diagnostics the run said, the list stderr carries,
#        so a catalog read back from its cache still says what it could not read;
#        a RENAME that cannot be read is ``alter_unreadable``. The tables, columns
#        and routines are the records /11 wrote.
#   /13 - a statement the grammar library fails on with an error of its own (an
#        AttributeError on SQL Server's ``ON [PRIMARY]`` read as MySQL) is read as
#        text or named, where it ended the run; a parse that stopped only where no
#        ALTER or RENAME is says so as ``parse_error_not_held`` (info), and IF EXISTS
#        on a column that is not there is ``alter_if_exists_absent`` (info). A file
#        /12 read gives the same tables, columns and routines; only the header's
#        diagnostics differ.
CATALOG_VERSION = "catalog-ddl/13"

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


# ---------------------------------------------------------------------------
# THE GRAMMAR LIBRARY, called in one way. sqlglot can fail on a statement with an
# error of its own rather than a ParseError: MySQL's grammar reading SQL Server's
# ``CREATE TABLE [dbo].[b] (...) ON [PRIMARY]`` raises AttributeError from deep in
# its parser, and that ended the whole run with a stack trace. Every parse and
# tokenize goes through these two, so such a failure is the parse or token error
# it is: a statement not read, which every caller already names.
# ---------------------------------------------------------------------------

class _GrammarFailed(ParseError):
    """The grammar library failing on text in a way of its own, as a parse error."""


class _GrammarFailedTokens(TokenError):
    """The same, while the text was cut into tokens."""


def _grammar_parse(sql, read, **opts):
    """sqlglot.parse, with the library's own failure raised as a ParseError."""
    try:
        return sqlglot.parse(sql, read=read, **opts)
    except (ParseError, TokenError):
        raise
    except Exception as e:  # noqa: BLE001 - whatever the library raises on this text is its failing to read it
        raise _GrammarFailed("the grammar failed on this text (%s: %s)" % (type(e).__name__, e)) from e


def _tokenize(dialect, sql):
    """The dialect's tokens of ``sql``, with the library's own failure raised as a TokenError."""
    try:
        return Dialect.get_or_raise(dialect).tokenize(sql)
    except (ParseError, TokenError, ValueError):
        raise
    except Exception as e:  # noqa: BLE001 - as above
        raise _GrammarFailedTokens("the grammar failed on this text (%s: %s)" % (type(e).__name__, e)) from e


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

# WHAT A DATABASE DOES THAT AN ALTER LEAVES UNSAID, keyed by the DATABASE the
# profile names (``--database``), never by the grammar the file is parsed with: H2
# and HSQLDB are parsed with sqlglot's standard grammar, CUBRID with MySQL's and
# Tibero with Oracle's, and speaking another database's SQL does not show that a
# database follows its other rules. A database with no row here has none of them:
# its unnamed key's name is not known, and each rule a statement depends on is
# said as not known there. A later statement is read against these:
# ``DROP CONSTRAINT x`` drops the primary key only if x is the key's name, and the
# DDL often never wrote one.
#   pkNameAlways    the key is called this whatever the DDL wrote. MySQL: "The name
#                   of a PRIMARY KEY is always PRIMARY"; MariaDB's ALTER TABLE page:
#                   the name given "is silently ignored, and the name of the index
#                   is always PRIMARY".
#   pkNameUnnamed   PostgreSQL names a key declared without a name <table>_pkey.
#                   That is the server's convention, not a word of the file, so a
#                   drop matched through it says so; a name past pkNameMaxBytes is
#                   cut by the server, and is then not known here.
#   dropKeyColumnDropsKey  True: dropping one column of a key drops the whole key
#                   (PostgreSQL drops "table constraints involving the column";
#                   Oracle needs CASCADE CONSTRAINTS for it). False: the column
#                   leaves the key and the rest stays (MySQL; MariaDB: "the column
#                   will be dropped from them").
#   indexRenameRenamesKey  ``ALTER INDEX a RENAME TO b`` renames the key a is the
#                   index of (PostgreSQL: "the constraint is renamed as well").
#   modifyRedefines True: ``MODIFY c ...`` restates the whole column, so what it does
#                   not say, NOT NULL or a comment, is gone (MySQL; MariaDB: "you
#                   should specify all attributes for the new column"). False: it
#                   changes only what it says (Oracle).
#   modes           the other databases' SQL the database reads in a compatibility
#                   mode, as (the mode's name, the grammar that reads that SQL). H2's
#                   manual, "Compatibility": MODE=MySQL, PostgreSQL, Oracle,
#                   MSSQLServer (and DB2, Derby, which sqlglot has no grammar for);
#                   HSQLDB's guide, "Compatibility With Other DBMS": sql.syntax_mys,
#                   syntax_pgs, syntax_ora, syntax_mss. A CREATE TABLE the database's
#                   own grammar cannot read is read as a mode reads it, and said so:
#                   the file of a project that runs H2 in MODE=MySQL is MySQL's SQL.
#                   A mode is none of the database's other rules.
# Oracle numbers the names it gives an unnamed key (SYS_C...), so such a key's
# name is not known there either.
_DATABASE_RULES = (
    {"names": ("postgres", "postgresql"), "database": "PostgreSQL", "pkNameUnnamed": "{table}_pkey",
     "pkNameMaxBytes": 63, "dropKeyColumnDropsKey": True, "indexRenameRenamesKey": True},
    {"names": ("mysql",), "database": "MySQL", "pkNameAlways": "PRIMARY", "modifyRedefines": True,
     "dropKeyColumnDropsKey": False},
    {"names": ("mariadb",), "database": "MariaDB", "pkNameAlways": "PRIMARY", "modifyRedefines": True,
     "dropKeyColumnDropsKey": False},
    {"names": ("oracle", "oracle-11g", "oracle-19c"), "database": "Oracle", "dropKeyColumnDropsKey": True,
     "modifyRedefines": False},
    {"names": ("h2",), "database": "H2",
     "modes": (("MySQL", "mysql"), ("PostgreSQL", "postgres"), ("Oracle", "oracle"), ("MSSQLServer", "tsql"))},
    {"names": ("hsqldb",), "database": "HSQLDB",
     "modes": (("sql.syntax_mys", "mysql"), ("sql.syntax_pgs", "postgres"), ("sql.syntax_ora", "oracle"),
               ("sql.syntax_mss", "tsql"))},
)


def _rules_of(database):
    return next((row for row in _DATABASE_RULES if (database or "").lower() in row["names"]), {})


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
    """What folding the files carries from one statement to the next. ``dialect`` is
    the grammar the files are parsed with, ``database`` the database they are for,
    whose rules an ALTER is read by (the grammar's own name when none is given).
    ``assumed``: the project did not declare the database, so it is a default, and
    a conclusion that rests on one of its rules says so (review 4, design 4)."""

    __slots__ = ("tables", "schema", "diagnostics", "identifier_case", "dialect", "database", "rules",
                 "source", "tail", "accounted", "assumed")

    def __init__(self, schema, diagnostics, identifier_case, dialect, database=None, assumed=False):
        self.tables = {}    # folded table name -> _Table (the record keeps the name as written)
        self.schema = schema
        self.diagnostics = diagnostics
        self.identifier_case = identifier_case
        self.dialect = dialect
        self.database = database if database is not None else dialect
        self.rules = _rules_of(self.database)
        self.source = None
        self.tail = ""      # what the grammar split off the ALTER being read, as written
        self.accounted = []  # each CREATE TABLE of the file being read that a statement declared
        self.assumed = assumed

    def rule(self, key):
        return self.rules.get(key)

    @property
    def label(self):
        """The database, as a sentence names it."""
        return self.rules.get("database") or self.database or "the database these files are for"

    def same(self, a, b):
        return _fold(a, self.identifier_case) == _fold(b, self.identifier_case)

    def say(self, level, code, table, message):
        _diag(self.diagnostics, level, code, table, message)

    def assumed_rule(self, table, what, rule):
        """A conclusion that rests on a rule of a database nobody declared: said, with what to declare."""
        if self.assumed:
            self.say("warn", "alter_rule_assumed", table,
                     "%s: %s, by %s's rule that %s. %s is assumed because sqlDialects.main is not declared; declare "
                     "it if these files are for another database" % (self.source, what, self.label, rule, self.label))


def _parse_statements(sql_text, diagnostics, source, dialect="mysql", fold=None):
    """Every statement of one file: read whole, then whole with the backslash rule turned round,
    then one statement at a time when neither reading can tokenize it."""
    try:
        return _parse_whole(sql_text, diagnostics, source, dialect, fold)
    except TokenError as e:
        error = e
    try:
        statements = _parse_whole(sql_text, diagnostics, source, _escapes_turned(dialect), fold)
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


def _parse_whole(sql_text, diagnostics, source, dialect, fold=None):
    """sqlglot.parse with the same salvage path the single-file reader had. A file
    that stops the parse is first read again with its CREATE TABLE statements that
    cannot be read as written set aside where the catalog holds nothing, so an
    export's ``NOT NULL ENABLE`` does not cost its table; one the database reads in
    a compatibility mode is read by that mode's grammar and put back in its place."""
    try:
        return _grammar_parse(sql_text, dialect)
    except ParseError as e:
        error = e
    found = _set_aside_in_file(sql_text, dialect, diagnostics, source, fold)
    placed = {}
    if found is not None:
        set_aside, placed = found
        try:
            return _put_back(_grammar_parse(set_aside, dialect), placed)
        except ParseError as e:
            error, sql_text = e, set_aside
    statements, stop = _read_errors_ignored(sql_text, dialect, error)
    _say_parse_stop(diagnostics, source, error, stop)
    return _put_back(statements, placed)


# ---------------------------------------------------------------------------
# A FILE READ WITH ERRORS IGNORED, and what that cost. sqlglot cuts a file into
# statements at its semicolons and parses each; with errors ignored it reads past
# what it cannot, keeping where it stopped. A statement it fails on outright (the
# AttributeError above) is kept as its text, the way the grammar keeps a statement
# it has no parser for, so the reader reads it again or names it like any other.
#
# What the stop cost the catalog is known from where it stopped: a CREATE TABLE is
# read or named on its own (the set-aside pass, _say_unread_tables), and the only
# other statements this reader applies are ALTER and RENAME. A stop in a statement
# that holds neither is a note, not a table read in part.
# ---------------------------------------------------------------------------

_CHANGING_WORDS = ("ALTER", "RENAME")


class _Stop(object):
    """Where a parse with errors ignored could not read as written: the statements (sqlglot's chunks) that hold
    a place it stopped at or that it failed on, why it failed on each of those, and whether every place it
    stopped at was found in a statement."""

    __slots__ = ("chunks", "unread", "failed", "placed")

    def __init__(self, chunks, unread, failed, placed):
        self.chunks, self.unread, self.failed, self.placed = chunks, unread, failed, placed


def _chunks(tokens):
    """The statements as sqlglot cuts a file before it parses one: the tokens between two semicolons."""
    chunks = [[]]
    for t in tokens:
        if t.token_type == TokenType.SEMICOLON:
            chunks.append([])
        else:
            chunks[-1].append(t)
    return [c for c in chunks if c]


def _as_text(chunk, sql_text):
    """A statement as the grammar keeps one it has no parser for: its first word, and the rest as text."""
    first = chunk[0].end + 1
    return exp.Command(this=sql_text[chunk[0].start:first], expression=sql_text[first:chunk[-1].end + 1])


def _read_each_chunk(grammar, chunks, sql_text):
    """Each statement parsed on its own with errors ignored: (statements, where it stopped, {chunk: why})."""
    statements, stops, failed = [], [], {}
    for n, chunk in enumerate(chunks):
        parser = grammar.parser(error_level=sqlglot.ErrorLevel.IGNORE)
        try:
            statements.extend(parser.parse(chunk, sql_text))
            stops.extend(parser.errors)
        except Exception as e:  # noqa: BLE001 - the grammar's own failure on this one statement
            statements.append(_as_text(chunk, sql_text))
            failed[n] = type(e).__name__
    return statements, stops, failed


def _read_errors_ignored(sql_text, dialect, error):
    """The file read with errors ignored, as sqlglot.parse reads it, and a _Stop for what it could not read as
    written. ``error`` is the error the parse that did not ignore them stopped at: a check that only such a parse
    makes (a keyword a clause must have) is a place too."""
    grammar = Dialect.get_or_raise(dialect)
    tokens = _tokenize(dialect, sql_text)
    chunks = _chunks(tokens)
    parser = grammar.parser(error_level=sqlglot.ErrorLevel.IGNORE)
    try:
        statements, stops, failed = parser.parse(tokens, sql_text), list(parser.errors), {}
    except Exception:  # noqa: BLE001 - one statement the grammar fails on: read them one at a time to find it
        statements, stops, failed = _read_each_chunk(grammar, chunks, sql_text)
    where = {(t.line, t.col): n for n, chunk in enumerate(chunks) for t in chunk}
    places = [(i.get("line"), i.get("col")) for e in [error] + stops for i in (getattr(e, "errors", None) or [])]
    unread = set(failed) | {where[p] for p in places if p in where}
    placed = all(p in where for p in places) and bool(places or failed)
    return statements, _Stop(chunks, sorted(unread), failed, placed)


def _changing_line(chunk):
    """The line of the first ALTER or RENAME a statement holds outside parentheses, or None."""
    depth = 0
    for t in chunk:
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(t.token_type, 0)
        if depth == 0 and _word(t) in _CHANGING_WORDS:
            return t.line
    return None


def _say_parse_stop(diagnostics, source, error, stop):
    """The file's note for a parse that stopped: a warning when what it could not read may change a table, or
    where it stopped is not known; a note when it holds no ALTER or RENAME, so it may have cost nothing."""
    head = "full parse of %s failed, salvaging with error_level=IGNORE: %s" % (source, str(error).replace("\n", " "))
    if stop.failed:
        first = min(stop.failed)
        head += ("; the grammar failed on %d statement(s) outright (%s, the first at line %d), which are read as text"
                 % (len(stop.failed), stop.failed[first], stop.chunks[first][0].line))
    changing = [line for line in (_changing_line(stop.chunks[n]) for n in stop.unread) if line is not None]
    if changing:
        _diag(diagnostics, "warn", "parse_error", None,
              "%s. There is an ALTER or a RENAME at line %d among what it could not read as written, so a change "
              "it makes to a table may be missing" % (head, changing[0]))
    elif not stop.placed:
        _diag(diagnostics, "warn", "parse_error", None, head)
    else:
        _diag(diagnostics, "info", "parse_error_not_held", None,
              "%s. The %d statement(s) it could not read as written, the first at line %d, declare and change no "
              "table, except a CREATE TABLE named on its own, so the catalog may have lost nothing by them"
              % (head, len(stop.unread), stop.chunks[stop.unread[0]][0].line))


# The statement that holds the place of a CREATE TABLE read by a compatibility
# mode's grammar while the rest of the file is parsed by the database's own.
_PLACE_HOLDER = "cascade_read_in_mode_%d"


def _put_back(statements, placed):
    """Each place holder replaced by the table it holds the place of."""
    if not placed:
        return statements
    out = []
    for stmt in statements:
        name = stmt.this.this.name if isinstance(stmt, exp.Create) and isinstance(stmt.this, exp.Schema) else None
        out.append(placed.get(name, stmt))
    return out


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
            statements.extend(_grammar_parse(chunk, dialect, error_level=sqlglot.ErrorLevel.IGNORE))
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


# ---------------------------------------------------------------------------
# A CREATE TABLE the grammar cannot read as written. An Oracle export writes how
# each constraint is checked and built, and the table's physical attributes after
# its column list; HSQLDB writes CACHED or MEMORY before TABLE. A grammar either
# stops at them or keeps the whole statement as text, and the table was then gone
# without a word. What the catalog does not hold is set aside, said, and the
# statement read again; one that still cannot be read is named. A statement the
# grammar reads as written is never touched.
# ---------------------------------------------------------------------------

# How a constraint is checked, never what it holds: Oracle's constraint state
# ("ENABLE | DISABLE, VALIDATE | NOVALIDATE, RELY | NORELY, [NOT] DEFERRABLE,
# INITIALLY IMMEDIATE | DEFERRED"). DISABLE is not among them: a disabled
# constraint is not enforced, so it is set aside whole and not read.
_CONSTRAINT_STATE_WORDS = ("ENABLE", "VALIDATE", "NOVALIDATE", "RELY", "NORELY", "DEFERRABLE")
# Kinds of table a grammar may not know, written between CREATE and TABLE: HSQLDB's
# CACHED, MEMORY and TEXT tables. The columns are the same whatever the kind.
_TABLE_KIND_WORDS = ("CACHED", "MEMORY", "TEXT")
_CREATE_PREFIX_WORDS = ("OR", "REPLACE", "GLOBAL", "LOCAL", "TEMPORARY", "TEMP", "UNLOGGED") + _TABLE_KIND_WORDS
_TABLE_CONSTRAINT_WORDS = ("CONSTRAINT", "PRIMARY KEY", "UNIQUE", "CHECK", "FOREIGN KEY")
_COLUMN_CONSTRAINT_WORDS = ("NULL", "PRIMARY KEY", "UNIQUE", "CHECK", "REFERENCES")
_CREATE_TABLE_TEXT_RE = re.compile(r"^\s*(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMPORARY|TEMP|UNLOGGED|CACHED|MEMORY|TEXT)\s+)*"
                                   r"TABLE\b", re.IGNORECASE)
_CREATE_NAME_RE = re.compile(r"\bTABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)", re.IGNORECASE)


def _word(token):
    """A keyword as written, upper case with single spaces; None for a quoted name or a string."""
    if token.token_type in (TokenType.IDENTIFIER, TokenType.STRING):
        return None
    return " ".join(token.text.split()).upper()


class _SetAside(object):
    """What reading one CREATE TABLE sets aside: the tokens, what each run was, and
    the constraints found disabled."""

    __slots__ = ("table", "dropped", "words", "disabled")

    def __init__(self, table):
        self.table = table
        self.dropped = set()     # token indices
        self.words = []          # what was set aside, as a sentence names it
        self.disabled = []       # each disabled constraint, as written

    def drop(self, i, j, word=None):
        self.dropped.update(range(i, j + 1))
        if word:
            self.words.append(word)


def _create_layout(tokens):
    """``CREATE [kind] TABLE [IF NOT EXISTS] name (list) tail`` as token indices:
    the kind words, the table's name, and the list's two parentheses. None when
    the statement has no column list this reader could read."""
    i, kinds = 1, []
    while i < len(tokens) and _word(tokens[i]) in _CREATE_PREFIX_WORDS:
        if _word(tokens[i]) in _TABLE_KIND_WORDS:
            kinds.append(i)
        i += 1
    if i >= len(tokens) or _word(tokens[i]) != "TABLE":
        return None
    i += 1
    while i < len(tokens) and _word(tokens[i]) in ("IF", "NOT", "EXISTS"):
        i += 1
    while i + 2 < len(tokens) and tokens[i + 1].token_type == TokenType.DOT:
        i += 2
    if i + 1 >= len(tokens) or tokens[i + 1].token_type != TokenType.L_PAREN:
        return None
    depth = 0
    for j in range(i + 1, len(tokens)):
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(tokens[j].token_type, 0)
        if depth == 0:
            return {"kinds": kinds, "table": tokens[i].text, "open": i + 1, "close": j}
    return None


def _elements(tokens, opening, closing):
    """The columns and table constraints of a list, as (first, last) token indices."""
    spans, depth, first = [], 0, opening + 1
    for j in range(opening + 1, closing):
        kind = tokens[j].token_type
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(kind, 0)
        if kind == TokenType.COMMA and depth == 0:
            spans.append((first, j - 1))
            first = j + 1
    spans.append((first, closing - 1))
    return [(s, e) for s, e in spans if s <= e]


def _top_depth(tokens, s, e):
    """The indices between s and e that are not inside parentheses of their own."""
    depth, out = 0, []
    for i in range(s, e + 1):
        kind = tokens[i].token_type
        if kind == TokenType.R_PAREN:
            depth -= 1
        if depth == 0 and kind not in (TokenType.L_PAREN, TokenType.R_PAREN):
            out.append(i)
        if kind == TokenType.L_PAREN:
            depth += 1
    return out


def _constraint_start(tokens, top, i):
    """Where the column constraint that ``DISABLE`` at i closes begins: the nearest
    constraint word before it, with its ``CONSTRAINT name`` when it has one."""
    before = [k for k in top if k < i]
    for n in range(len(before) - 1, 0, -1):
        k = before[n]
        if _word(tokens[k]) not in _COLUMN_CONSTRAINT_WORDS:
            continue
        if _word(tokens[k]) == "NULL" and n > 0 and _word(tokens[before[n - 1]]) == "NOT":
            n, k = n - 1, before[n - 1]
        if n >= 2 and _word(tokens[before[n - 2]]) == "CONSTRAINT":
            k = before[n - 2]
        return k
    return i


def _set_aside_disabled(tokens, s, e, top, text, aside):
    """A disabled constraint is not read: a table constraint goes whole, a column's
    constraint from its first word to DISABLE. True when the element went whole."""
    disabled = [i for i in top if _word(tokens[i]) == "DISABLE" and i > s]
    if not disabled:
        return False
    if _word(tokens[s]) in _TABLE_CONSTRAINT_WORDS:
        aside.disabled.append(text[tokens[s].start:tokens[e].end + 1])
        aside.drop(s, e)
        return True
    for i in disabled:
        start = _constraint_start(tokens, top, i)
        aside.disabled.append(text[tokens[start].start:tokens[i].end + 1])
        aside.drop(start, i)
    return False


def _set_aside_states(tokens, s, e, top, aside):
    """How each constraint of one column or table constraint is checked and built."""
    n = 0
    while n < len(top):
        i = top[n]
        word = _word(tokens[i])
        nxt = _word(tokens[top[n + 1]]) if n + 1 < len(top) else None
        if i == s or i in aside.dropped:
            n += 1
        elif word == "USING" and nxt == "INDEX":
            aside.drop(i, e, "USING INDEX")     # the index's name or build, to the element's end
            return
        elif word == "EXCEPTIONS" and nxt == "INTO":
            aside.drop(i, top[min(n + 2, len(top) - 1)], "EXCEPTIONS INTO")
            n += 3
        elif (word == "NOT" and nxt == "DEFERRABLE") or (word == "INITIALLY" and nxt in ("IMMEDIATE", "DEFERRED")):
            aside.drop(i, top[n + 1], "%s %s" % (word, nxt))
            n += 2
        elif word in _CONSTRAINT_STATE_WORDS:
            aside.drop(i, i, word)
            n += 1
        else:
            n += 1


# WHAT A CREATE TABLE WRITES AFTER ITS COLUMN LIST THAT CHANGES NOTHING THE CATALOG
# HOLDS: where and how the table is stored, and its defaults for rows to come.
# Each word maps to True when a value follows it (``ENGINE = InnoDB``, ``TABLESPACE
# users``), False when it stands alone; a parenthesized group after a word is its
# own (``STORAGE (...)``, ``WITH (fillfactor=70)``). A tail with a word not here is
# kept as written: ``INHERITS (parent)`` adds columns, ``AS SELECT`` declares them.
#   MySQL, MariaDB   CREATE TABLE's table_options and partition_options
#   Oracle           physical_properties, table_properties, and an export's segment clauses
#   PostgreSQL       WITH (...), WITHOUT OIDS, USING method, TABLESPACE, ON COMMIT, PARTITION BY
#   SQL Server       ON filegroup, TEXTIMAGE_ON, FILESTREAM_ON
_TABLE_OPTIONS = {
    "ENGINE": True, "TYPE": True, "AUTO_INCREMENT": True, "AVG_ROW_LENGTH": True, "CHECKSUM": True,
    "COMPRESSION": True, "CONNECTION": True, "DIRECTORY": True, "DATA": False, "DELAY_KEY_WRITE": True,
    "ENCRYPTION": True, "INSERT_METHOD": True, "KEY_BLOCK_SIZE": True, "MAX_ROWS": True, "MIN_ROWS": True,
    "PACK_KEYS": True, "PASSWORD": True, "ROW_FORMAT": True, "STATS_AUTO_RECALC": True, "STATS_PERSISTENT": True,
    "STATS_SAMPLE_PAGES": True, "PAGE_CHECKSUM": True, "TRANSACTIONAL": True, "SECONDARY_ENGINE": True,
    "AUTOEXTEND_SIZE": True, "TABLESPACE": True, "STORAGE": False, "DISK": False, "MEMORY": False, "UNION": False,
    "DEFAULT": False, "CHARSET": True, "CHARACTER SET": True, "CHARACTER": False, "SET": True, "COLLATE": True,
    "COMMENT": True, "PARTITION": False, "PARTITIONS": True, "SUBPARTITION": False, "SUBPARTITIONS": True,
    "BY": False, "RANGE": False, "LIST": False, "HASH": False, "LINEAR": False, "KEY": False, "COLUMNS": False,
    "PCTFREE": True, "PCTUSED": True, "INITRANS": True, "MAXTRANS": True, "LOGGING": False, "NOLOGGING": False,
    "COMPRESS": False, "NOCOMPRESS": False, "CACHE": False, "NOCACHE": False, "PARALLEL": False,
    "NOPARALLEL": False, "MONITORING": False, "NOMONITORING": False, "ENABLE": False, "DISABLE": False,
    "ROW": False, "MOVEMENT": False, "SEGMENT": False, "CREATION": True, "ORGANIZATION": True,
    "ROWDEPENDENCIES": False, "NOROWDEPENDENCIES": False, "RESULT_CACHE": False, "INMEMORY": False, "NO": False,
    "ON": True, "COMMIT": False, "PRESERVE": False, "DELETE": False, "ROWS": False, "DROP": False,
    "WITH": False, "WITHOUT": False, "OIDS": False, "USING": True, "TEXTIMAGE_ON": True, "FILESTREAM_ON": True,
}


def _tail_is_options(tokens, top):
    """Every word at the top of the tail is an option of _TABLE_OPTIONS or the value one takes."""
    value = False
    for i in top:
        kind, word = tokens[i].token_type, _word(tokens[i])
        if value or kind in (TokenType.NUMBER, TokenType.STRING, TokenType.IDENTIFIER, TokenType.COMMA):
            value = kind == TokenType.EQ
            continue
        if kind == TokenType.EQ:
            value = True
            continue
        if word not in _TABLE_OPTIONS:
            return False
        value = _TABLE_OPTIONS[word]
    return True


def _set_aside_tail(tokens, closing, last, aside, sql):
    """The physical attributes after the column list, all but a MySQL table comment.
    None, and nothing set aside, when a statement word starts a line in it: that is
    the next statement, not this table's attributes. False, and nothing set aside,
    when it holds a word that is not a table option this reader knows."""
    top = _top_depth(tokens, closing + 1, last)
    if any(_word(tokens[i]) in _STATEMENT_WORDS and "\n" in sql[tokens[i - 1].end + 1:tokens[i].start] for i in top):
        return None
    if not _tail_is_options(tokens, top):
        return False
    keep = set()
    for n, i in enumerate(top):
        if _word(tokens[i]) == "COMMENT":
            rest = [k for k in top[n + 1:n + 3]]
            string = next((k for k in rest if tokens[k].token_type == TokenType.STRING), None)
            if string is not None:
                keep.update(range(i, string + 1))
    words = []
    for i in range(closing + 1, last + 1):
        if i in keep:
            continue
        aside.dropped.add(i)
        word = _word(tokens[i]) if i in top else None
        if word and word.replace("_", "").isalpha() and word not in words:
            words.append(word)
    if words:
        aside.words.append("after the column list: %s" % " ".join(words[:12]))
    return True


# A table constraint the catalog holds nothing of, recognized by its whole shape,
# never by its first word: ``key text PRIMARY KEY`` is a column named key, and
# ``KEY idx (c)`` is an index. Each shape is its head (after ``CONSTRAINT name``),
# how many words may come between the head and its parenthesized list (an index's
# name, ``USING btree``, PostgreSQL's ``NULLS NOT DISTINCT``), whether that list
# names columns (``key varchar(10)`` lists a number, so it is a column), and the
# word that must follow the list. An element of no shape here is not set aside.
_CONSTRAINT_SHAPES = (
    {"head": ("FOREIGN KEY",), "between": 1, "columns": True, "then": "REFERENCES"},
    {"head": ("CHECK",), "between": 0, "columns": False},
    {"head": ("UNIQUE",), "between": 5, "columns": True},
    {"head": ("KEY", "INDEX"), "between": 3, "columns": True},
    {"head": ("FULLTEXT", "SPATIAL"), "between": 2, "columns": True},
    {"head": ("EXCLUDE",), "between": 2, "columns": False},
)
_NOT_NAMES = (TokenType.NUMBER, TokenType.STRING, TokenType.L_PAREN, TokenType.R_PAREN, TokenType.COMMA,
              TokenType.SEMICOLON, TokenType.DOT, TokenType.EQ)


def _name_like(token):
    """A token that can be a name: a quoted one, or a single bare word."""
    if token.token_type == TokenType.IDENTIFIER:
        return True
    return token.token_type not in _NOT_NAMES and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$#]*", token.text) is not None


def _closing(tokens, opening, last):
    depth = 0
    for j in range(opening, last + 1):
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(tokens[j].token_type, 0)
        if depth == 0:
            return j
    return None


def _lists_columns(tokens, opening, closing):
    """``(a, b(10) DESC, (expr))``: each item a column, or an expression in parentheses of its own."""
    items = _elements(tokens, opening, closing)
    return bool(items) and all(_name_like(tokens[s]) or tokens[s].token_type == TokenType.L_PAREN for s, _ in items)


def _constraint_head(tokens, s, e):
    """The head of the table constraint the element at s..e is, by its whole shape; None when it has none of them."""
    i = s + 2 if _word(tokens[s]) == "CONSTRAINT" else s
    shape = next((sh for sh in _CONSTRAINT_SHAPES if i <= e and _word(tokens[i]) in sh["head"]), None)
    if shape is None:
        return None
    j = i + 1
    while j <= e and tokens[j].token_type != TokenType.L_PAREN and _name_like(tokens[j]) and j - i <= shape["between"]:
        j += 1
    close = _closing(tokens, j, e) if j <= e and tokens[j].token_type == TokenType.L_PAREN else None
    if close is None or (shape["columns"] and not _lists_columns(tokens, j, close)):
        return None
    if shape.get("then") and (close + 1 > e or _word(tokens[close + 1]) != shape["then"]):
        return None
    return _word(tokens[i])


def _set_aside_constraint(tokens, s, e, elements, aside):
    """A table constraint the catalog holds nothing of (an index, a unique key, a
    check, a foreign key: all but the primary key), set aside whole with the comma
    before it, or after it when it is the list's first. True when it was."""
    head = _constraint_head(tokens, s, e)
    if head is None:
        return False
    first = elements.index((s, e)) == 0
    aside.drop(s, e + 1 if first and len(elements) > 1 else e, head)
    if not first:
        aside.drop(s - 1, s - 1)
    return True


def _set_aside_create(sql, dialect, stage):
    """What reading one CREATE TABLE sets aside at a stage: 0, how its constraints
    are checked and built; 1, and what follows its column list; 2, and each table
    constraint the catalog holds nothing of. None when it has no column list."""
    try:
        tokens = [t for t in _tokenize(dialect, sql) if t.token_type != TokenType.SEMICOLON]
    except (TokenError, ParseError, ValueError):
        return None
    layout = _create_layout(tokens) if tokens else None
    if layout is None:
        return None
    aside = _SetAside(layout["table"])
    for i in layout["kinds"]:
        aside.drop(i, i, _word(tokens[i]))
    elements = _elements(tokens, layout["open"], layout["close"])
    for s, e in elements:
        top = _top_depth(tokens, s, e)
        if stage >= 2 and _set_aside_constraint(tokens, s, e, elements, aside):
            continue
        if not _set_aside_disabled(tokens, s, e, top, sql, aside):
            _set_aside_states(tokens, s, e, top, aside)
    if stage >= 1 and layout["close"] + 1 < len(tokens):
        if _set_aside_tail(tokens, layout["close"], len(tokens) - 1, aside, sql) is None:
            return None
    aside.dropped = sorted(aside.dropped)
    return aside, tokens


def _without(sql, tokens, dropped):
    """``sql`` with the dropped tokens blanked, line breaks kept, so every line keeps its number."""
    out, cursor = [], 0
    for i in dropped:
        start, end = tokens[i].start, tokens[i].end + 1
        out.append(sql[cursor:start])
        out.append(re.sub(r"[^\n]", " ", sql[start:end]))
        cursor = end
    out.append(sql[cursor:])
    return "".join(out)


def _quiet_parse(sql, dialect):
    """One statement, parsed with sqlglot's fall-back warning held back."""
    logger = logging.getLogger("sqlglot")
    level = logger.level
    logger.setLevel(logging.ERROR)
    try:
        parsed = [p for p in _grammar_parse(sql, dialect) if p is not None]
    except (ParseError, TokenError):
        return None
    finally:
        logger.setLevel(level)
    return parsed[0] if len(parsed) == 1 else None


def _reads_as_table(sql, dialect):
    parsed = _quiet_parse(sql, dialect)
    return parsed if isinstance(parsed, exp.Create) and isinstance(parsed.this, exp.Schema) else None


def _read_set_aside(sql, dialect):
    """The statement read again with as little set aside as reads it: its constraint
    states, then what follows its column list, then the table constraints the
    catalog holds nothing of. (parsed, what was set aside, the text read), or None."""
    for stage in (0, 1, 2):
        found = _set_aside_create(sql, dialect, stage)
        if found is None:
            return None
        aside, tokens = found
        text = _without(sql, tokens, aside.dropped)
        parsed = _reads_as_table(text, dialect) if aside.dropped else None
        if parsed is not None:
            return parsed, aside, text
    return None


def _say_set_aside(aside, diagnostics, source):
    counts = {}
    for w in aside.words:
        counts[w] = counts.get(w, 0) + 1
    if counts:
        listed = ", ".join(w if n == 1 else "%s (%d times)" % (w, n) for w, n in counts.items())
        _diag(diagnostics, "info", "create_clause_not_held", aside.table,
              "%s: CREATE TABLE %s is read without what the catalog does not hold: %s" % (source, aside.table, listed))
    for text in aside.disabled:
        _diag(diagnostics, "info", "create_constraint_disabled", aside.table,
              "%s: CREATE TABLE %s declares %s. A disabled constraint is not enforced, so it is not read"
              % (source, aside.table, _short(text)))


def _create_unreadable(sql, diagnostics, source, outcome):
    m = _CREATE_NAME_RE.search(sql)
    name = m.group(1) if m else "(no name)"
    # Named once: a file whose parse stopped names it, and the salvage after may
    # hand the same statement back as text.
    if any(d["code"] == "create_table_unreadable" and d["table"] == name and d["message"].startswith(source + ":")
           for d in diagnostics or []):
        return
    _diag(diagnostics, "warn", "create_table_unreadable", name,
          "%s: CREATE TABLE %s could not be read, so %s: %s" % (source, name, outcome, _short(sql)))


def _statement_spans(tokens):
    """The statements of a file as (first, last) token indices, cut at semicolons outside parentheses."""
    spans, depth, first = [], 0, 0
    for j, t in enumerate(tokens):
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(t.token_type, 0)
        if t.token_type == TokenType.SEMICOLON and depth <= 0:
            spans.append((first, j - 1))
            first, depth = j + 1, 0
    spans.append((first, len(tokens) - 1))
    return [(s, e) for s, e in spans if s <= e]


def _set_aside_in_file(sql_text, dialect, diagnostics, source, fold=None):
    """A file whose parse stopped: each CREATE TABLE that cannot be read as written,
    read again with what the catalog does not hold set aside, or as a compatibility
    mode of the database reads it. (the file's text with those set aside or held in
    place, the tables read in a mode by their place holders' names), or None when no
    statement needed it."""
    try:
        tokens = _tokenize(dialect, sql_text)
    except (TokenError, ParseError, ValueError):
        return None
    edits, placed = [], {}
    for first, last in _statement_spans(tokens):
        stmt = sql_text[tokens[first].start:tokens[last].end + 1]
        if _word(tokens[first]) != "CREATE" or not _CREATE_TABLE_TEXT_RE.match(stmt[len(tokens[first].text):]):
            continue
        if _reads_as_table(stmt, dialect) is not None:
            continue
        text = _salvage_create(stmt, dialect, diagnostics, source, fold, placed)
        if text is None:
            _create_unreadable(stmt, diagnostics, source, "the file is read with errors ignored and the table "
                                                          "is missing or read in part")
            continue
        edits.append((tokens[first].start, tokens[last].end + 1, text))
    if not edits:
        return None
    out, cursor = [], 0
    for start, end, text in edits:
        out.append(sql_text[cursor:start])
        out.append(text)
        cursor = end
    out.append(sql_text[cursor:])
    return "".join(out), placed


def _salvage_create(stmt, dialect, diagnostics, source, fold, placed):
    """One CREATE TABLE the grammar cannot read as written: the text to parse in its place, said. With what
    the catalog does not hold set aside; else a place holder for the table a compatibility mode reads;
    else None."""
    read = _read_set_aside(stmt, dialect)
    if read is not None:
        _say_set_aside(read[1], diagnostics, source)
        return read[2]
    in_mode = _read_in_modes(stmt, fold)
    if in_mode is None:
        return None
    _say_read_in_mode(in_mode, diagnostics, source, fold)
    name = _PLACE_HOLDER % len(placed)
    placed[name] = in_mode[0]
    # The place holder keeps the statement's line breaks, so every line after it keeps its number.
    return "CREATE TABLE %s (x INT)%s" % (name, "\n" * stmt.count("\n"))


def _read_in_modes(sql, fold):
    """A CREATE TABLE the database's own grammar cannot read, read by the grammar of each compatibility mode
    the database has: (parsed, what was set aside, the modes that read it) when every mode that reads it reads
    the same columns and key. None when the database has no mode, none reads it, or two read it apart."""
    readings = []
    for mode, grammar in (fold.rule("modes") or ()) if fold is not None else ():
        parsed, aside = _reads_as_table(sql, grammar), None
        if parsed is None:
            read = _read_set_aside(sql, grammar)
            parsed, aside = (read[0], read[1]) if read is not None else (None, None)
        if parsed is not None and all(c.name and not _index_read_as_column(c)
                                      for c in parsed.this.expressions if isinstance(c, exp.ColumnDef)):
            readings.append((mode, parsed, aside))
    if not readings or len({_columns_and_key(r[1]) for r in readings}) > 1:
        return None
    return readings[0][1], readings[0][2], [r[0] for r in readings]


def _columns_and_key(create):
    cols = create.this.expressions
    return (tuple(c.name for c in cols if isinstance(c, exp.ColumnDef)), tuple(sorted(_primary_key_columns(cols))))


def _say_read_in_mode(in_mode, diagnostics, source, fold):
    parsed, aside, modes = in_mode
    name = parsed.this.this.name
    _diag(diagnostics, "info", "create_read_in_mode", name,
          "%s: CREATE TABLE %s is not written in %s's own SQL; it is read as %s reads it in its %s mode"
          % (source, name, fold.label, fold.label, " or ".join(modes)))
    if aside is not None:
        _say_set_aside(aside, diagnostics, source)


_STATEMENT_WORDS = ("CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "SET", "GRANT", "COMMIT")


def _line_statements(sql, dialect):
    """Text that holds several statements with no semicolon between them, as an
    HSQLDB script writes one per line: cut where a statement word starts a line
    outside parentheses. One piece when there is nothing to cut."""
    try:
        tokens = _tokenize(dialect, sql)
    except (TokenError, ParseError, ValueError):
        return [sql]
    cuts, depth = [], 0
    for n, t in enumerate(tokens):
        if t.token_type == TokenType.R_PAREN:
            depth -= 1
        elif t.token_type == TokenType.L_PAREN:
            depth += 1
        elif n > 0 and depth == 0 and _word(t) in _STATEMENT_WORDS and "\n" in sql[tokens[n - 1].end + 1:t.start]:
            cuts.append(t.start)
    bounds = [0] + cuts + [len(sql)]
    return [sql[a:b].strip() for a, b in zip(bounds, bounds[1:]) if sql[a:b].strip()]


def _apply_create_text(sql, ctx):
    """A CREATE TABLE the grammar kept as text: read again with what the catalog
    does not hold set aside, or named. Text that runs on into more statements is
    cut first, so no table is set aside as another's attributes."""
    pieces = _line_statements(sql, ctx.dialect)
    if len(pieces) > 1:
        _apply_pieces(pieces, ctx)
        return
    read = _read_set_aside(sql, ctx.dialect)
    if read is not None:
        _say_set_aside(read[1], ctx.diagnostics, ctx.source)
        _apply_create(read[0], ctx)
        return
    in_mode = _read_in_modes(sql, ctx)
    if in_mode is None:
        _create_unreadable(sql, ctx.diagnostics, ctx.source, "its table is not in the catalog")
        return
    _say_read_in_mode(in_mode, ctx.diagnostics, ctx.source, ctx)
    _apply_create(in_mode[0], ctx)


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
    ctx.accounted.append(table_name)
    existing = ctx.tables.get(key)
    if existing is not None:
        # NEVER merged: two declarations of one table are two different schemas,
        # and merging them would invent a table neither file describes. The FIRST
        # wins (the files are applied in the order the caller gave) and the
        # disagreement is reported.
        _diag(diagnostics, "warn", "DUPLICATE_TABLE_DECLARATION", table_name,
              "%s is declared in %s (as %s) and again in %s; the first declaration is kept, "
              "nothing is merged; pass only one of the two files, or the one that "
              "describes the live schema"
              % (table_name, existing.declared_in, existing.name, source))
        return

    tbl = _Table(table_name, _table_comment(stmt), source)
    inherited = _inherit_columns(tbl, stmt, ctx)
    pk_cols = _primary_key_columns(col_defs)
    misread = []
    for col_def in col_defs:
        if not isinstance(col_def, exp.ColumnDef):
            continue  # PRIMARY KEY / INDEX / etc. are not columns
        if _unnamed(col_def, table_name, source, diagnostics):
            continue
        if _index_read_as_column(col_def):
            misread.append("%s %s" % (col_def.name, col_def.args["kind"].sql(dialect=ctx.dialect or None)))
            continue
        try:
            rec = _column_record(col_def, ctx.schema, table_name)
        except Exception as e:  # noqa: BLE001
            _diag(diagnostics, "warn", "column_read_failed", table_name,
                  "a column of %s in %s could not be read: %s"
                  % (table_name, source, str(e).replace("\n", " ")))
            continue
        _add_own_column(tbl, rec, ctx, inherited)
    if misread:
        _diag(diagnostics, "info", "create_clause_not_held", table_name,
              "%s: CREATE TABLE %s is read without what the catalog does not hold: %s, an index written as MySQL "
              "writes one, which the grammar reads as a column" % (source, table_name, ", ".join(misread)))
    tbl.pk = set(pk_cols)
    _name_primary_key(tbl, _primary_key_name(col_defs), ctx)
    _key_columns_not_null(tbl)
    ctx.tables[key] = tbl


# MySQL's words for an index written inside the column list (``KEY idx (c)``). A
# grammar that does not know that form reads it as a column named KEY whose type
# is ``idx(c)``: a type whose parameters are names is no type a column has.
_INDEX_WORDS = ("KEY", "INDEX", "FULLTEXT", "SPATIAL")


def _index_read_as_column(col_def):
    """A column the grammar made of MySQL's ``KEY name (columns)``: named KEY or INDEX as a bare word, of a
    type of its own making whose parameters are all names."""
    ident, kind = col_def.this, col_def.args.get("kind")
    if not isinstance(ident, exp.Identifier) or ident.args.get("quoted") or ident.name.upper() not in _INDEX_WORDS:
        return False
    if not isinstance(kind, exp.DataType) or kind.this != exp.DataType.Type.USERDEFINED or not kind.expressions:
        return False
    return all(isinstance(p, exp.DataTypeParam) and isinstance(p.this, (exp.Var, exp.Column, exp.Identifier))
               for p in kind.expressions)


def _inherit_columns(tbl, stmt, ctx):
    """PostgreSQL's ``INHERITS (p, ...)``: the table holds each parent's columns before its own, NOT NULL
    with them; a primary key and a comment are not inherited. The names of the columns inherited."""
    props = stmt.args.get("properties")
    parents = [t for p in (props.expressions if props else []) if isinstance(p, exp.InheritsProperty)
               for t in p.expressions]
    inherited = set()
    for parent in parents:
        found = ctx.tables.get(_fold(parent.name, ctx.identifier_case))
        if found is None:
            ctx.say("warn", "create_parent_unknown", tbl.name,
                    "%s: CREATE TABLE %s inherits %s, which no file declared before it, so the columns it inherits "
                    "are not in the catalog" % (ctx.source, tbl.name, parent.name))
            continue
        for rec in found.columns.values():
            _add_own_column(tbl, dict(rec, table=tbl.name, comment=None), ctx, inherited)
            inherited.add(_column_key(tbl, rec["column"], ctx))
    return inherited


def _add_own_column(tbl, rec, ctx, inherited):
    """A column the CREATE declares. One it also inherits is that one column, where the parent put it, NOT NULL
    when either says so."""
    key = next((k for k in inherited if ctx.same(k, rec["column"])), None)
    if key is None:
        tbl.columns[rec["column"]] = rec
        return
    old = tbl.columns[key]
    tbl.columns[key] = dict(old, type=rec["type"] or old["type"], nullable=old["nullable"] and rec["nullable"],
                            comment=rec.get("comment") if rec.get("comment") is not None else old.get("comment"))


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
        # Unreadable, not a clause the catalog does not hold: it may rename a table.
        ctx.say("warn", "alter_unreadable", None,
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


def _unknown_column(tbl, verb, name, ctx, outcome="ignored", if_exists=False):
    if if_exists:
        # The database changes nothing either: a note of its own, not a table read in part.
        ctx.say("info", "alter_if_exists_absent", tbl.name,
                "%s %s %s.%s IF EXISTS, which is not there; nothing changes, as the database changes nothing"
                % (ctx.source, verb, tbl.name, name))
        return
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
    hit = ctx.same(name or "", tbl.pk_name)
    if ctx.rule("pkNameAlways") or tbl.pk_name_said:
        ctx.assumed_rule(tbl.name, "%s on %s is read as %s its primary key (%s), named %s" % (
            what, tbl.name, "dropping" if hit else "leaving", ", ".join(sorted(tbl.pk)), tbl.pk_name),
            "a primary key is named %s" % (ctx.rule("pkNameAlways") or ctx.rule("pkNameUnnamed")))
    if not hit:
        _not_held(tbl, what, ctx)
        return
    if tbl.pk_name_said:
        ctx.say("info", "alter_primary_key_by_convention", tbl.name,
                "%s: %s is read as dropping the primary key of %s (%s): %s"
                % (ctx.source, what, tbl.name, ", ".join(sorted(tbl.pk)), tbl.pk_name_said))
    _drop_primary_key(tbl)


def _drop_column(tbl, name, ctx, if_exists=False):
    key = _column_key(tbl, name, ctx)
    if key is None:
        _unknown_column(tbl, "drops", name, ctx, if_exists=if_exists)
        return
    del tbl.columns[key]
    if key not in tbl.pk:
        return
    drops_key = ctx.rule("dropKeyColumnDropsKey")
    if drops_key is None and len(tbl.pk) > 1:
        ctx.say("warn", "alter_primary_key_unknown", tbl.name,
                "%s drops %s.%s, one column of the primary key (%s). Whether %s then drops the whole key or "
                "keeps the rest is not known here; the rest is kept"
                % (ctx.source, tbl.name, key, ", ".join(sorted(tbl.pk)), ctx.label))
    elif len(tbl.pk) > 1:
        ctx.assumed_rule(tbl.name, "dropping %s.%s, one column of the primary key (%s), is read as %s" % (
            tbl.name, key, ", ".join(sorted(tbl.pk)), "dropping the whole key" if drops_key else "keeping the rest"),
            "dropping a column of a key %s" % ("drops the key" if drops_key else "leaves the rest of it"))
    if drops_key:
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
    listed = action.this.expressions if action.this is not None and not name else []
    if kind == "COLUMN" and listed:
        # H2's DROP COLUMN (c, d): each column dropped.
        for column in listed:
            _drop_column(tbl, column.name, ctx, bool(action.args.get("exists")))
    elif kind == "COLUMN":
        _drop_column(tbl, name, ctx, bool(action.args.get("exists")))
    elif kind in ("CONSTRAINT", "INDEX", "KEY"):
        _drop_constraint(tbl, name, ctx, what)
    else:
        _not_held(tbl, what, ctx)


def _changed_only(old, col_def, rec):
    """Oracle's MODIFY: what the clause says changes, what it does not say stays."""
    kept = dict(old, column=rec["column"])
    if rec.get("comment") is not None:
        kept["comment"] = rec["comment"]
    if col_def.args.get("kind") is not None:
        kept["type"] = rec["type"]
    if any(isinstance(getattr(c, "kind", None), exp.NotNullColumnConstraint)
           for c in col_def.args.get("constraints") or []):
        kept["nullable"] = rec["nullable"]
    return kept


def _unsaid(old, col_def, rec):
    """What a MODIFY clause leaves out of what the catalog holds of the column."""
    said = [c.kind for c in col_def.args.get("constraints") or [] if getattr(c, "kind", None) is not None]
    unsaid = []
    if col_def.args.get("kind") is None:
        unsaid.append("type")
    if not any(isinstance(k, exp.NotNullColumnConstraint) for k in said):
        unsaid.append("nullability")
    if old.get("comment") is not None and rec.get("comment") is None:
        unsaid.append("comment")
    return unsaid


def _restated(tbl, old_key, col_def, rec, ctx):
    """The column after MODIFY, by the database's rule: restated whole, or changed
    only where the clause speaks. With no rule, what it leaves out is kept and said."""
    redefines = ctx.rule("modifyRedefines")
    unsaid = _unsaid(tbl.columns[old_key], col_def, rec)
    if redefines is not None and unsaid:
        ctx.assumed_rule(tbl.name, "MODIFY %s.%s leaves out its %s, which is read as %s" % (
            tbl.name, old_key, " and ".join(unsaid), "gone" if redefines else "kept"),
            "MODIFY %s" % ("restates the whole column" if redefines else "changes only what it says"))
    if redefines:
        return rec
    kept = _changed_only(tbl.columns[old_key], col_def, rec)
    if redefines is None and unsaid:
        ctx.say("warn", "alter_modify_unsaid_unknown", tbl.name,
                "%s modifies %s.%s and leaves out its %s. Whether %s keeps what MODIFY leaves out or drops it "
                "is not known here; it is kept" % (ctx.source, tbl.name, old_key, " and ".join(unsaid), ctx.label))
    return kept


def _restate_column(tbl, col_def, old_ident, ctx, if_exists=False):
    """MODIFY / CHANGE: the column as the clause states it, in its place."""
    if _unnamed(col_def, tbl.name, ctx.source, ctx.diagnostics):
        return
    rec = _column_record(col_def, ctx.schema, tbl.name)
    old_name = old_ident.name if old_ident is not None else rec["column"]
    old_key = _column_key(tbl, old_name, ctx)
    if old_key is None:
        _unknown_column(tbl, "modifies", old_name, ctx, "added as declared", if_exists)
        if not if_exists:
            tbl.columns[rec["column"]] = rec
        return
    _replace_column(tbl, old_key, _restated(tbl, old_key, col_def, rec, ctx))
    if _column_is_pk(col_def):
        _set_primary_key(tbl, [rec["column"]], _primary_key_name([col_def]), ctx)
    _key_columns_not_null(tbl)


def _if_exists(node):
    """MariaDB's ``MODIFY COLUMN IF EXISTS c`` as sqlglot reads it, IF(EXISTS, c): the
    column c, touched only if it is there. Any other name comes back as it is."""
    true = node.args.get("true") if isinstance(node, exp.If) else None
    if (isinstance(true, exp.Column) and isinstance(node.this, exp.Column) and node.this.name.upper() == "EXISTS"
            and node.args.get("false") is None):
        return true.this, True
    return node, False


def _modify_column(tbl, action, ctx):
    col_def = action.this
    if not isinstance(col_def, exp.ColumnDef):
        _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        return
    name, if_exists = _if_exists(col_def.this)
    old, old_if_exists = _if_exists(action.args.get("rename_from"))
    if if_exists:
        col_def = col_def.copy()
        col_def.set("this", name)
    _restate_column(tbl, col_def, old, ctx, if_exists or old_if_exists)


def _rename_column_to(tbl, old, new, ctx):
    key = _column_key(tbl, old, ctx)
    if key is None or not new:
        _unknown_column(tbl, "renames", old, ctx)
        return
    _replace_column(tbl, key, dict(tbl.columns[key], column=new))


def _rename_column(tbl, action, ctx):
    old = action.this.name if action.this is not None else None
    new = action.args["to"].name if action.args.get("to") is not None else None
    _rename_column_to(tbl, old, new, ctx)


def _alter_column(tbl, action, ctx):
    """ALTER COLUMN c SET NOT NULL | DROP NOT NULL | [SET DATA] TYPE t | SET / DROP DEFAULT."""
    allow_null, dtype = action.args.get("allow_null"), action.args.get("dtype")
    default = action.args.get("default") is not None or (action.args.get("drop") and allow_null is None)
    name = action.this.name if action.this is not None else None
    if allow_null is None and dtype is None and not default:
        # The grammar read none of it: ``SET STATISTICS 100`` or H2's ``SET NULL``
        # went to the statement's options. Read the clause as it was written.
        if ctx.tail:
            tail, ctx.tail = ctx.tail, ""
            _read_clause(tbl, "ALTER COLUMN %s %s" % (action.this.sql(dialect=ctx.dialect or None), tail), ctx)
        else:
            _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        return
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
# What an Oracle export writes after a constraint, and PostgreSQL may: how the key
# is built and checked (``USING INDEX ... TABLESPACE users ENABLE``), never which
# columns it holds. DISABLE is not among them: a disabled key is not enforced, and
# is not read as one.
_CONSTRAINT_STATE_RE = re.compile(
    r"(?:\s+(?:USING\s+INDEX\b.*|ENABLE|VALIDATE|NOVALIDATE|RELY|NORELY|(?:NOT\s+)?DEFERRABLE|"
    r"INITIALLY\s+(?:IMMEDIATE|DEFERRED)))+\s*$", _CLAUSE_FLAGS)


def _unquote(name):
    name = name.strip()
    if len(name) >= 2 and name[0] + name[-1] in ('""', "``", "[]"):
        return name[1:-1]
    return name


def _top_level(text, ctx):
    """``text`` cut at its commas outside brackets and strings, as the dialect tokenizes it."""
    try:
        tokens = _tokenize(ctx.dialect, text)
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
    return _quiet_parse(sql, ctx.dialect)


def _column_spec(spec, ctx):
    """A column as a MODIFY clause states it, type or no type, read as the dialect reads a column."""
    created = _parse_quietly("CREATE TABLE cascade_clause (%s)" % spec, ctx)
    cols = created.this.expressions if isinstance(created, exp.Create) and isinstance(created.this, exp.Schema) else []
    return cols[0] if len(cols) == 1 and isinstance(cols[0], exp.ColumnDef) else None


def _restate_specs(tbl, m, text, ctx):
    """``MODIFY c ...`` / ``MODIFY (c1 ..., c2 ...)``: each column as the clause restates it.
    ``c NULL`` says only nullability; read as a column, NULL would be its type."""
    for spec in _top_level(m.group(1), ctx) or [m.group(1)]:
        spec = _CONSTRAINT_STATE_RE.sub("", spec).strip()
        only = _NULL_ONLY_RE.match(spec)
        if only:
            _set_null_text(tbl, only, spec, ctx)
            continue
        col_def = _column_spec(spec, ctx)
        kind = col_def.args.get("kind") if col_def is not None else None
        if col_def is None or (isinstance(kind, exp.DataType) and kind.this == exp.DataType.Type.NULL):
            # The clause as the file writes it: H2's ALTER COLUMN c <definition> is read here too.
            _unreadable(tbl.name, text, ctx)
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


def _table_comment_text(tbl, m, text, ctx):
    """``COMMENT = '...'``: the table's comment is this string now."""
    said = _parse_quietly("SELECT %s" % m.group(1), ctx)
    literal = said.expressions[0] if isinstance(said, exp.Select) and len(said.expressions) == 1 else None
    if not isinstance(literal, exp.Literal) or not literal.is_string:
        _unreadable(tbl.name, text, ctx)
        return
    tbl.comment = literal.name


def _drop_listed_text(tbl, m, text, ctx):
    """Oracle's ``DROP (c1, c2)``: each column dropped."""
    names = [re.match(_NAME, piece) for piece in _top_level(m.group(1), ctx) or []]
    if not names or any(n is None for n in names):
        _unreadable(tbl.name, text, ctx)
        return
    for n in names:
        _drop_column(tbl, _unquote(n.group(0)), ctx)


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
    (re.compile(r"^DROP\s*\((.*)\)(?:\s+CASCADE\s+CONSTRAINTS)?(?:\s+CHECKPOINT\s+\d+)?\s*$", _CLAUSE_FLAGS),
     _drop_listed_text),
    # COLUMN may be left out: PostgreSQL's grammar has it optional, and Oracle's DROP (c) above.
    (re.compile(r"^DROP\s+(?:COLUMN\s+)?(IF\s+EXISTS\s+)?(%s)(?:\s+(?:CASCADE|RESTRICT)(?:\s+CONSTRAINTS)?)?\s*$"
                % _NAME, _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _drop_column(tbl, _unquote(m.group(2)), ctx, bool(m.group(1)))),
    (re.compile(r"^ADD\s+(?:CONSTRAINT\s+(?:(?!PRIMARY\s+KEY)(%s)\s+)?)?PRIMARY\s+KEY\s*(?:USING\s+\w+\s*)?"
                r"\((.*)\)(?:\s*USING\s+\w+)?\s*$" % _NAME, _CLAUSE_FLAGS),
     _add_key_text),
    (re.compile(r"^ALTER\s+(?:COLUMN\s+)?(%s)\s+SET\s+(NOT\s+)?NULL\s*$" % _NAME, _CLAUSE_FLAGS),
     _set_null_text),
    (re.compile(r"^ALTER\s+(?:COLUMN\s+)?(%s)\s+RENAME\s+TO\s+(%s)\s*$" % (_NAME, _NAME), _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _rename_column_to(tbl, _unquote(m.group(1)), _unquote(m.group(2)), ctx)),
    (re.compile(r"^ALTER\s+(?:COLUMN\s+)?%s\s+SET\s+(?:STATISTICS|STORAGE|COMPRESSION)\b" % _NAME, _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _not_held(tbl, _short(text), ctx)),
    (re.compile(r"^MODIFY\s*\((.*)\)\s*$", _CLAUSE_FLAGS), _restate_specs),
    (re.compile(r"^MODIFY\s+(?:COLUMN\s+)?(.+)$", _CLAUSE_FLAGS), _restate_specs),
    # H2 and HSQLDB restate a column after its name: ``ALTER COLUMN c BIGINT NOT
    # NULL``. Read as MODIFY is, by the database's rule for what it leaves out.
    (re.compile(r"^ALTER\s+(?:COLUMN\s+)?(%s\s+(?!(?:SET|DROP|RENAME|RESTART|SELECTIVITY|TYPE|ADD)\b)\S.*)$" % _NAME,
                _CLAUSE_FLAGS),
     _restate_specs),
    (re.compile(r"^RENAME\s+CONSTRAINT\s+(%s)\s+TO\s+(%s)\s*$" % (_NAME, _NAME), _CLAUSE_FLAGS),
     _rename_constraint_text),
    # MySQL's table comment, which the catalog holds.
    (re.compile(r"^COMMENT\s*(?:=\s*)?('(?:[^'\\]|''|\\.)*')\s*$", _CLAUSE_FLAGS), _table_comment_text),
    # Clauses that touch no column, type, nullability or key: ownership, triggers,
    # row security, clustering, storage, and MySQL's table options and how it runs
    # the ALTER itself.
    (re.compile(r"^(?:OWNER\s+TO|ENABLE|DISABLE|CLUSTER\s+ON|SET\s+WITHOUT\s+CLUSTER|REPLICA\s+IDENTITY|"
                r"SET\s+TABLESPACE|VALIDATE\s+CONSTRAINT|(?:NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY)\b"
                r"|^(?:ALGORITHM|LOCK|ENGINE|AUTO_INCREMENT|ROW_FORMAT|(?:DEFAULT\s+)?(?:CHARSET|CHARACTER\s+SET)|"
                r"(?:DEFAULT\s+)?COLLATE)\s*=?", _CLAUSE_FLAGS),
     lambda tbl, m, text, ctx: _not_held(tbl, _short(text), ctx)),
)


def _read_clause(tbl, text, ctx):
    """One clause sqlglot left as text, read by the first form it has; named, as
    written, when it has none. How a key is built and checked is not what it holds,
    so that is set aside first."""
    text = text.strip()
    bare = _CONSTRAINT_STATE_RE.sub("", text).strip()
    for pattern, apply in _CLAUSE_READERS:
        m = pattern.match(bare)
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
    exp.Command: lambda tbl, action, ctx: _read_clauses(tbl, _command_text(action), ctx),
}


def _read_clauses(tbl, text, ctx):
    """What sqlglot left as text from a clause on: often the clause and every one
    after it (``DROP c, DROP d``). Each is read as an ALTER TABLE of its own."""
    pieces = _top_level(text, ctx) or [text]
    if len(pieces) == 1:
        _read_clause(tbl, text, ctx)
        return
    head = "TABLE %s" % exp.to_identifier(tbl.name, quoted=True).sql(dialect=ctx.dialect or None)
    for piece in pieces:
        _apply_clause(head, tbl.name, piece, ctx)


def _altered_table(table_name, ctx):
    tbl = ctx.tables.get(_fold(table_name, ctx.identifier_case))
    if tbl is None:
        ctx.say("warn", "alter_unknown_table", table_name,
                "%s alters %s, which no file declared before it; ignored" % (ctx.source, table_name))
    return tbl


def _options_text(stmt, ctx):
    """What the grammar put in the statement's options rather than in a clause, as
    written: the rest of a clause it could not read (``SET STATISTICS 100``)."""
    parts = []
    for o in stmt.args.get("options") or []:
        if isinstance(o, exp.ToTableProperty):
            continue
        inner = o.this if isinstance(o, exp.SetConfigProperty) else None
        parts.append(_command_text(inner) if isinstance(inner, exp.Command) else _clause_text(o, ctx))
    return " ".join(parts)


def _apply_alter(stmt, ctx):
    """Apply one ALTER TABLE, clause by clause. Every clause not applied is named."""
    table_name = getattr(stmt.this, "name", None)
    if not table_name:
        ctx.say("warn", "alter_read_failed", None, "ALTER in %s has no readable table name; ignored" % ctx.source)
        return
    # ``RENAME c TO d`` with COLUMN left out, as PostgreSQL allows: the grammar
    # reads c as a new table name and puts d in the options.
    to_column = next((o.this for o in stmt.args.get("options") or [] if isinstance(o, exp.ToTableProperty)), None)
    outer, ctx.tail = ctx.tail, _options_text(stmt, ctx)
    tbl = None
    for action in stmt.args.get("actions") or []:
        if isinstance(action, exp.AlterRename) and to_column is None:
            _rename_table(ctx, table_name, action.this.name)
            table_name = action.this.name
            continue
        tbl = _altered_table(table_name, ctx)
        if tbl is None:
            break
        if isinstance(action, exp.AlterRename):
            _rename_column_to(tbl, action.this.name, to_column.name, ctx)
            continue
        apply = _ACTIONS.get(type(action))
        if apply is None:
            _unreadable(tbl.name, _clause_text(action, ctx), ctx)
        else:
            apply(tbl, action, ctx)
    # What the grammar split off and no clause took back is read on its own; an
    # ALTER that is all options (``ENGINE=InnoDB``) has no clause to take it back.
    tail, ctx.tail = ctx.tail, outer
    if tail and tbl is None and not stmt.args.get("actions"):
        tbl = _altered_table(table_name, ctx)
    if tail and tbl is not None:
        _read_clause(tbl, tail, ctx)


def _split_alter_table(body, ctx):
    """``TABLE [IF EXISTS] [ONLY] <name> <clause>, <clause> ...`` as the text up to the
    name, the table's name, and the clauses."""
    try:
        tokens = _tokenize(ctx.dialect, body)
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
        if not _apply_clause(head, table_name, clause, ctx):
            return


_STATE_ONLY_RE = re.compile(
    r"(?:\s+(?:ENABLE|VALIDATE|NOVALIDATE|RELY|NORELY|(?:NOT\s+)?DEFERRABLE|INITIALLY\s+(?:IMMEDIATE|DEFERRED)))+\s*$",
    re.IGNORECASE)


def _is_alter_table(parsed):
    return isinstance(parsed, exp.Alter) and str(parsed.args.get("kind") or "").upper() == "TABLE"


def _apply_clause(head, table_name, clause, ctx):
    """One clause, read as an ALTER TABLE of its own: by sqlglot when it can, else as
    text. False when no file declared the table."""
    parsed = _parse_quietly("ALTER %s %s" % (head, clause), ctx)
    bare = _STATE_ONLY_RE.sub("", clause).strip()
    if not _is_alter_table(parsed) and bare != clause.strip():
        # How a constraint is checked (``NOT DEFERRABLE ... VALIDATE``) is not what
        # it is: read without it, a CHECK is a check.
        parsed = _parse_quietly("ALTER %s %s" % (head, bare), ctx)
    if _is_alter_table(parsed):
        _apply_alter(parsed, ctx)
        return True
    tbl = _altered_table(table_name, ctx)
    if tbl is None:
        return False
    _read_clause(tbl, clause, ctx)
    return True


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
    """``ALTER INDEX a RENAME TO b``: where a key and its index share one name, the
    key's name follows. Where the database has no rule for it, the key's name is no
    longer known, and that is said."""
    old = getattr(stmt.this, "name", None)
    follows = ctx.rule("indexRenameRenamesKey")
    if follows is False or not old:
        return
    for action in stmt.args.get("actions") or []:
        if not isinstance(action, exp.AlterRename):
            continue
        for tbl in ctx.tables.values():
            if tbl.pk_name is None or not ctx.same(tbl.pk_name, old):
                continue
            if follows:
                tbl.pk_name, tbl.pk_name_said = action.this.name, None
                continue
            ctx.say("warn", "alter_primary_key_unknown", tbl.name,
                    "%s renames index %s, which has the name of the primary key of %s. Whether %s renames the key "
                    "with it is not known here, so the key's name no longer is" % (ctx.source, old, tbl.name, ctx.label))
            tbl.pk_name, tbl.pk_name_said = None, None


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
        if word != "CREATE" and _holds_create_table(_command_text(stmt), ctx):
            # A script with no semicolons, kept as the text of its first statement.
            return _apply_pieces(_line_statements(_command_text(stmt), ctx.dialect), ctx)
        if word == "RENAME":
            return _rename_tables(body, ctx)
        if word == "ALTER" and re.match(r"TABLE\b", body, re.IGNORECASE):
            _apply_alter_table_text(body, ctx)
            return 1
        if word == "ALTER" and re.match(r"TYPE\b", body, re.IGNORECASE):
            _rename_type(body, ctx)
        if word == "CREATE" and _CREATE_TABLE_TEXT_RE.match(body):
            # A table the grammar kept as text is read again or named, never dropped.
            _apply_create_text("CREATE " + body, ctx)
    # everything else (INSERT/UPDATE/CREATE INDEX/…) is skipped: a CREATE TABLE
    # the grammar folded into one of them is named after the file (_say_unread_tables)
    return 0


def _is_create_table_text(text):
    return text[:6].upper() == "CREATE" and _CREATE_TABLE_TEXT_RE.match(text[6:]) is not None


def _holds_create_table(text, ctx):
    """Text of one statement that holds a CREATE TABLE starting a line of its own after it."""
    return "\n" in text and any(_is_create_table_text(p) for p in _line_statements(text, ctx.dialect)[1:])


def _apply_pieces(pieces, ctx):
    """Statements with no semicolon between them, as an HSQLDB script writes one per line: each folded in on
    its own, a CREATE TABLE among them read or named. How many table alterations they carried."""
    alters = 0
    for piece in pieces:
        parsed = _parse_quietly(piece, ctx)
        if _is_create_table_text(piece) and _reads_as_table(piece, ctx.dialect) is None:
            _apply_create_text(piece, ctx)
        elif parsed is not None:
            alters += _apply_statement(parsed, ctx)
    return alters


# Every way a statement starts a table, as text: counted before the file's tokens
# are, which is needed only when the text holds more than the reader accounted for.
_CREATE_TABLE_ANY_RE = re.compile(r"\bCREATE\s+(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMPORARY|TEMP|UNLOGGED|CACHED|MEMORY"
                                  r"|TEXT)\s+)*TABLE\b", re.IGNORECASE)


def _bare(name):
    return re.split(r"\.", name or "")[-1].strip("`\"[] ").lower()


def _declared_tables(sql_text, dialect):
    """(name, line) of each CREATE TABLE in the file's tokens, outside parentheses; None when the file cannot be
    tokenized, as its unreadable statements are then named where they are cut."""
    tokens = None
    for grammar in (dialect, _escapes_turned(dialect)):
        try:
            tokens = _tokenize(grammar, sql_text)
            break
        except (TokenError, ParseError, ValueError):
            continue
    if tokens is None:
        return None
    out, depth = [], 0
    for n, t in enumerate(tokens):
        depth += {TokenType.L_PAREN: 1, TokenType.R_PAREN: -1}.get(t.token_type, 0)
        if depth != 0 or _word(t) != "CREATE":
            continue
        layout = _create_layout(tokens[n:])
        if layout is not None or _create_names_table(tokens, n):
            out.append((layout["table"] if layout is not None else _table_after(tokens, n), t.line))
    return out


def _create_names_table(tokens, n):
    i = n + 1
    while i < len(tokens) and _word(tokens[i]) in _CREATE_PREFIX_WORDS:
        i += 1
    return i < len(tokens) and _word(tokens[i]) == "TABLE"


def _table_after(tokens, n):
    """The name a ``CREATE ... TABLE [IF NOT EXISTS] name`` with no column list gives (``AS SELECT``, ``LIKE``)."""
    i = n + 1
    while i < len(tokens) and _word(tokens[i]) in _CREATE_PREFIX_WORDS + ("TABLE", "IF", "NOT", "EXISTS"):
        i += 1
    while i + 2 < len(tokens) and tokens[i + 1].token_type == TokenType.DOT:
        i += 2
    return tokens[i].text if i < len(tokens) else "(no name)"


def _say_unread_tables(sql_text, accounted, ctx):
    """Every CREATE TABLE a file writes is read or named. One no statement the grammar read declares (folded
    into the statement before it, where a semicolon is missing) is named here."""
    if ctx.diagnostics is None or len(_CREATE_TABLE_ANY_RE.findall(sql_text)) <= len(accounted):
        return
    declared = _declared_tables(sql_text, ctx.dialect)
    left = {}
    for name in accounted:
        left[_bare(name)] = left.get(_bare(name), 0) + 1
    for name, line in declared or []:
        if left.get(_bare(name), 0) > 0:
            left[_bare(name)] -= 1
            continue
        ctx.say("warn", "create_table_unread", name,
                "%s: CREATE TABLE %s at line %d is not a statement the grammar read on its own (it is read as part "
                "of another), so its table is not in the catalog" % (ctx.source, name, line))


def parse_ddl_catalog_files(files, schema=None, diagnostics=None, identifier_case="exact", dialect="mysql",
                            database=None, database_assumed=False):
    """Fold several DDL files, IN THE ORDER GIVEN, into catalog records.

    ``files`` — a sequence of ``(source_label, sql_text)``. The label appears in
    diagnostics and in the header, so a reader can tell which file declared what.

    ``identifier_case`` — what makes two table names the SAME table when the fold
    decides it (``fold-lower`` / ``fold-upper`` / ``exact``). Only the DUPLICATE
    check and the ALTER lookup use it; every record keeps the name as the first
    file wrote it.

    ``dialect`` is the grammar the files are parsed with (``""`` is sqlglot's
    standard one); ``database`` the database they are for, whose rules an ALTER is
    read by, as the profile names it (``h2``, ``tibero``). None takes the grammar's.
    ``database_assumed``: nobody declared that database; it is a default, and a
    conclusion that rests on one of its rules says so.

    Returns the same record list shape as :func:`parse_ddl_catalog`: one header,
    then every table sorted by name with its columns in declaration order.
    """
    ctx = _Fold(schema, diagnostics, identifier_case, dialect, database, database_assumed)
    per_file = []
    routines = []
    for source, sql_text in files:
        ctx.source = source
        before = len(ctx.tables)
        routines.extend(extract_routines(sql_text, source))
        statements = _parse_statements(sql_text, diagnostics, source, dialect, ctx)
        alters, ctx.accounted = 0, []
        for stmt in statements:
            if stmt is not None:
                alters += _apply_statement(stmt, ctx)
        named = [d["table"] for d in (diagnostics or [])
                 if d["code"] == "create_table_unreadable" and d["message"].startswith(source + ":")]
        _say_unread_tables(sql_text, ctx.accounted + named, ctx)
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
                        help="the sqlglot grammar the files are parsed with (default: mysql); an empty "
                             "value is sqlglot's standard grammar, as H2 and HSQLDB are read")
    parser.add_argument("--database", default=None,
                        help="the database the files are for, as the profile names it (h2, tibero); "
                             "its rules decide what an ALTER leaves unsaid (default: the grammar's)")
    parser.add_argument("--database-assumed", action="store_true", dest="database_assumed",
                        help="the database is a default nobody declared (sqlDialects.main): a conclusion that "
                             "rests on one of its rules says so")
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
                                      identifier_case=args.identifier_case, dialect=args.dialect,
                                      database=args.database, database_assumed=args.database_assumed)

    # Stamp the source basenames only (determinism §2.1 — no absolute path).
    records[0]["source"] = "ddl:" + ",".join(name for name, _ in files)
    # What this run could not read or had to assume, as it said it on stderr: the
    # pack carries it from here, and a catalog read back from its cache has it
    # too. The header is outside what a lineage key is computed from.
    records[0]["diagnostics"] = diagnostics

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
