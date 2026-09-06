#!/usr/bin/env python3
"""SQL identifier identity for the Cascade SQL lane: what makes a node id stable.

ONE table, one function, one question: *when do two spellings of an identifier
name the same table or column?*

A database answers that with a **case-folding rule**, and the rule is a property
of the DIALECT, not a global policy. Folding when the database does not would
merge two genuinely different tables; not folding when it does splits one table
into two (which is the defect this module exists to fix — a DDL that declares
``create table item`` and a mapper that says ``FROM ITEM`` are the same table in
HSQLDB, Oracle and a MySQL server with ``lower_case_table_names=1``).

THE RULE PER DIALECT, with the source of each:

  mysql / mariadb  -> fold-lower
      Column, index, trigger and event names are ALWAYS compared case-
      insensitively in MySQL. Table and database names follow the server's
      ``lower_case_table_names``: 0 (the Linux default) stores and compares as
      written, 1 stores lower-cased and compares insensitively, 2 stores as
      written and compares insensitively. The engine cannot see that variable
      from a DDL file, so it takes the portable setting MySQL's own manual
      recommends for cross-platform schemas (1) and folds to lower. A schema
      that really does declare two tables differing only in case is NOT merged
      in silence: ``build_schema_index`` reports a folded-identifier collision.
      (MySQL 8.0 reference manual, "Identifier Case Sensitivity".)

  postgres         -> fold-lower
      Unquoted identifiers are folded to LOWER case. (PostgreSQL manual, §4.1.1
      "Identifiers and Key Words".)

  oracle           -> fold-upper
      Unquoted identifiers are stored and compared in UPPER case. (Oracle SQL
      Language Reference, "Database Object Naming Rules".)

  hsqldb, h2       -> fold-upper
      Both follow the SQL standard: an unquoted identifier is folded to UPPER
      case, a quoted one is exact. (HSQLDB Guide, "Database Objects — Names";
      H2's classic default, ``DATABASE_TO_UPPER=TRUE``.)

  anything else    -> exact
      Fail closed. An unknown dialect gets NO folding, because a fold we cannot
      cite is a guess, and a guess that merges two tables is unrecoverable.

TWO THINGS THIS MODULE DELIBERATELY DOES NOT DO:

  1. It never rewrites a user-visible name. The fold produces a MATCHING KEY;
     the name every answer prints is the spelling the catalog gave (see
     ``lineage.py``'s display maps). ``pms_product`` stays ``pms_product``.

  2. It folds ASCII A-Z only. Case folding outside ASCII is locale- and
     server-dependent (the Turkish dotless i is the classic trap) and differs
     between Python's ``str.lower()`` and JavaScript's ``toLowerCase()``. This
     lane has a mirror of this table in ``src/core/identifier_case.mjs`` and the
     two MUST agree byte for byte, so both fold ASCII and leave everything else
     exactly as written. A non-ASCII identifier is therefore matched exactly.
"""

FOLD_LOWER = "fold-lower"
FOLD_UPPER = "fold-upper"
EXACT = "exact"

#: The three identity rules a run may use. Mirrored in identifier_case.mjs.
IDENTIFIER_CASES = (FOLD_LOWER, FOLD_UPPER, EXACT)

#: The rule assumed for a dialect this table does not name: none (fail closed).
DEFAULT_IDENTIFIER_CASE = EXACT

#: dialect name -> identity rule. Keyed by BOTH the names a profile may write
#: (``mariadb``, ``oracle-19c``, ``hsqldb``) and the sqlglot dialect names the
#: worker sees on ``--dialect``, so the table answers whichever arrives. The
#: empty string is sqlglot's default (ANSI) parser: it carries no dialect
#: identity at all, so it gets no fold.
DIALECT_IDENTIFIER_CASE = {
    "mysql": FOLD_LOWER,
    "mariadb": FOLD_LOWER,
    "postgres": FOLD_LOWER,
    "postgresql": FOLD_LOWER,
    "oracle": FOLD_UPPER,
    "oracle-11g": FOLD_UPPER,
    "oracle-19c": FOLD_UPPER,
    "hsqldb": FOLD_UPPER,
    "h2": FOLD_UPPER,
    "": EXACT,
}

#: identity rule -> the sqlglot dialect setting that makes SQLGlot's own
#: identifier normalization obey the SAME rule. Without this, sqlglot would
#: apply ITS table (mysql = case-sensitive, postgres = lowercase, oracle =
#: uppercase) inside ``qualify`` and the tokens it hands back would no longer be
#: in the key space this lane indexes the catalog by.
_SQLGLOT_NORMALIZATION = {
    FOLD_LOWER: "lowercase",
    FOLD_UPPER: "uppercase",
    EXACT: "case_sensitive",
}

_TO_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ",
                          "abcdefghijklmnopqrstuvwxyz")
_TO_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz",
                          "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


class IdentifierCaseError(ValueError):
    """An identity rule this module does not implement."""


def identifier_case_for_dialect(dialect):
    """The declared identity rule for ``dialect`` (``exact`` when unknown)."""
    if dialect is None:
        return DEFAULT_IDENTIFIER_CASE
    return DIALECT_IDENTIFIER_CASE.get(dialect, DEFAULT_IDENTIFIER_CASE)


def fold_identifier(name, case):
    """The MATCHING KEY for one identifier spelling.

    ASCII A-Z only (see the module docstring). ``None`` folds to ``None`` so
    callers can pass an absent schema straight through.
    """
    if case not in IDENTIFIER_CASES:
        raise IdentifierCaseError(
            "unknown identifier case %r — expected one of %s"
            % (case, ", ".join(IDENTIFIER_CASES))
        )
    if name is None or case == EXACT:
        return name
    if not isinstance(name, str):
        return name
    return name.translate(_TO_LOWER if case == FOLD_LOWER else _TO_UPPER)


def sqlglot_dialect(dialect, case):
    """``dialect`` with SQLGlot's identifier normalization pinned to ``case``.

    SQLGlot takes dialect settings inline (``"mysql,normalization_strategy=
    lowercase"``), which is the only way to make ITS notion of identifier
    identity match the one declared here — one rule, applied by both.
    """
    if case not in IDENTIFIER_CASES:
        raise IdentifierCaseError(
            "unknown identifier case %r — expected one of %s"
            % (case, ", ".join(IDENTIFIER_CASES))
        )
    return "%s,normalization_strategy=%s" % (
        dialect or "", _SQLGLOT_NORMALIZATION[case])
