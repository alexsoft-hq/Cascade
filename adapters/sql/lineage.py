#!/usr/bin/env python3
"""SQL lineage resolver for the Cascade SQL lane, piece 3 of 3.

Consumes the **catalog** JSONL (piece 1, ``catalog_ddl.py``) and the flattened
**statement** JSONL (piece 2, ``mybatis_extract.py``) and resolves, per SQL
statement, which tables and columns it **reads / writes / deletes**. The catalog
is used to qualify bare columns to their owning table and to expand ``*`` /
``alias.*`` projections into concrete columns.

Method: each statement is parsed with ``sqlglot.parse_one(read=
<dialect>)`` — the dialect comes from ``--dialect`` (the profile's
``sqlDialects.main``), never from a hardcoded default — and then run through
``sqlglot.optimizer.qualify.qualify`` with a
sqlglot schema built from the catalog. Qualify attaches a source table to every
column and expands stars. When qualify raises, we DO NOT drop the statement: we
fall back to a best-effort unqualified walk (table-level access at least) and
record an ``unresolved`` entry with reason ``qualify_failed``: this lane fails
closed and never silently drops a statement.

IDENTIFIER IDENTITY (``--identifier-case``, ``identifier_case.py``). A DDL that
declares ``create table item`` and a mapper that writes ``FROM ITEM`` name the
SAME table in HSQLDB, Oracle, and a MySQL server with
``lower_case_table_names=1``. Matching by exact string therefore invents a
second table and loses every fact that rode on the statement. So the catalog is
indexed twice over: by a **matching key** (the identifier folded under the
dialect's declared rule) and by the **display name** (the spelling the catalog
gave). Every reference resolves through the matching key and every fact is
emitted under the display name, so ``pms_product`` is still ``pms_product`` in
the answer. A QUOTED identifier is exempt — it is exact in every dialect, so it
is matched against the catalog's exact spellings only. Two catalog names that
fold to one key are a **collision**: reported (``folded_identifier_collision``),
never merged in silence.

Reference invariants honored:
  - **DELETE has no column write.** ``DELETE ... WHERE`` writes nothing at the
    column level; its WHERE columns are reads, and the table access is 'delete'.
    Column-axis impact never invents column writes for deletes.
  - A column that cannot be attributed to exactly one catalog table (unqualified/
    ambiguous, table not in catalog, or column unknown in its table) is placed in
    ``unresolved`` — never attached to a guessed table. These are counted.

Determinism: identical inputs produce byte-for-byte identical stdout.
Tables and columns are de-duplicated and sorted; every line is emitted with
sorted keys and no incidental whitespace; nothing time-, machine-, or
absolute-path-derived enters the output (paths flow through from piece 2).

CLI: ``python lineage.py --catalog <catalog.jsonl> --statements <stmts.jsonl>
     [--dialect mysql] [--identifier-case fold-lower] [--default-schema <name>]``
     (either path may be ``-`` to read that stream from stdin.)
"""

import argparse
import json
import logging
import os
import sys

import sqlglot
from sqlglot import exp
from sqlglot.errors import OptimizeError, ParseError
from sqlglot.optimizer.qualify import qualify

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from identifier_case import (  # noqa: E402
    EXACT,
    IDENTIFIER_CASES,
    fold_identifier,
    identifier_case_for_dialect,
    sqlglot_dialect,
)

SQLFACTS_SCHEMA = "cascade:sqlfacts:1"

# Worker version — the identity of THIS analyzer's output shape. It rides in the
# header record and is folded into every PER-STATEMENT lineage shard key
# (SPEC §17.7): a worker upgrade invalidates every cached lineage record rather
# than mixing generations. BUMP IT whenever the lineage records change.
# Mirrored (and asserted) in src/core/worker_versions.mjs.
#   /2 - identifier identity is now dialect-declared (``--identifier-case``): a
#        reference is matched by its folded key and emitted under the catalog's
#        display spelling. For a schema whose DDL and SQL already agree in case
#        (a MySQL dump written lower-case, say) the output is byte-identical to
#        /1; where they disagreed, /1 invented a second table, so shards from
#        the two generations must not share a key.
LINEAGE_VERSION = "lineage/2"

# sqlglot logs "unsupported syntax, falling back to Command" as a bare WARNING to
# the root logger's stderr handler; that would corrupt our structured JSONL
# diagnostics stream. We capture the same information ourselves (an
# 'unsupported_syntax' unresolved entry), so silence sqlglot's own emitter.
logging.getLogger("sqlglot").setLevel(logging.ERROR)

# Column-scoped unresolved reasons (drive the ``unresolvedColumns`` tally). A
# statement-scoped reason like 'qualify_failed'/'parse_failed' is NOT a column
# ref and must not inflate the column unresolved rate.
_COLUMN_UNRESOLVED_REASONS = frozenset({
    "unqualified_column",
    "table_not_in_catalog",
    "column_unknown_in_table",
    "implicit_insert_columns",
})


def _diag(diagnostics, level, code, message, **extra):
    """Record a structured diagnostic (appended to the caller's list, if any)."""
    if diagnostics is not None:
        rec = {"level": level, "code": code, "message": message}
        rec.update(extra)
        diagnostics.append(rec)


# --------------------------------------------------------------------------- #
# Schema index
# --------------------------------------------------------------------------- #

def _quoted_key(spelling):
    """A schema key SQLGlot will not case-normalize: every dotted part quoted.

    ``item`` -> ``"item"``; ``shop.item`` -> ``"shop"."item"``. An embedded
    double quote is doubled, as SQL escapes it.
    """
    return ".".join('"%s"' % part.replace('"', '""')
                    for part in str(spelling).split("."))


def build_schema_index(catalog_records, identifier_case=EXACT, diagnostics=None):
    """Build the lineage schema index from piece-1 catalog records.

    Every key in this index is a **matching key**: the catalog's spelling folded
    under ``identifier_case`` (``exact`` — the default — folds nothing, which is
    what the pre-RM12 index was). Alongside each key the index keeps the
    catalog's own **display spelling**, and that is what every emitted fact
    carries, so folding changes what MATCHES and never what is printed.

    Views (each keyed by bare table name and — when a schema/db is present on the
    records — additionally by ``schema.table``):

      ``sqlglot``    — the nested ``{table: {column: type}}`` mapping that
                       ``sqlglot`` optimizer passes want (drives star expansion
                       and column→table qualification). Matching keys.
      ``columns``    — ``{table: [column, ...]}`` in catalog (declaration) order,
                       for star fallback and membership tests. Matching keys.
      ``tables``     — the set of known table matching keys.
      ``display``    — ``{table matching key: catalog spelling}``.
      ``exactTables``— ``{catalog spelling: table matching key}``, the lookup a
                       QUOTED table reference uses (a quoted identifier is exact
                       in every dialect, so it must hit the declared spelling).
      ``columnDisplay`` / ``columnExact`` — the same two directions per table,
                       for column names.
      ``identifierCase`` — the rule this index was built under. ``analyze_stream``
                       and ``analyze_statement`` read it from here rather than
                       taking it again, so the index and the walk cannot disagree.
      ``collisions`` — two catalog spellings that fold to one matching key. They
                       are REPORTED (and the first declaration wins); §3.3 forbids
                       merging two declared objects behind the user's back.

    Column/table records are the ``kind == "column"`` / ``"table"`` records; the
    header and any other record kinds are ignored. Declaration order is preserved
    by the ``ordinal`` field when present, else by input order.
    """
    if identifier_case not in IDENTIFIER_CASES:
        raise ValueError("unknown identifier case %r" % (identifier_case,))

    # Accumulate per (schema, table) so we can emit both bare and qualified keys.
    by_table = {}   # (schema_or_None, table) -> list[(ordinal, column, type)]
    seen_tables = []  # declaration-ordered, de-duplicated

    for rec in catalog_records:
        kind = rec.get("kind")
        if kind == "table":
            key = (rec.get("schema"), rec.get("table"))
            if key not in seen_tables:
                seen_tables.append(key)
        elif kind == "column":
            key = (rec.get("schema"), rec.get("table"))
            col = rec.get("column")
            if not col:
                continue
            by_table.setdefault(key, []).append(
                (rec.get("ordinal"), col, rec.get("type"))
            )
            if key not in seen_tables:
                seen_tables.append(key)

    fold = lambda name: fold_identifier(name, identifier_case)  # noqa: E731

    sqlglot_schema = {}
    columns = {}
    table_keys = set()
    display = {}
    exact_tables = {}
    column_display = {}
    column_exact = {}
    collisions = []

    reported = set()

    def _collide(what, key, kept, dropped):
        # A table is installed under its bare key from both the column pass and
        # the table-record pass; one collision is one FACT, not two sightings.
        if (what, key, kept, dropped) in reported:
            return
        reported.add((what, key, kept, dropped))
        collisions.append({"kind": what, "key": key, "kept": kept,
                           "dropped": dropped})
        _diag(diagnostics, "warn", "folded_identifier_collision",
              "%s %r and %r both fold to %r under identifier case %r — the "
              "first declaration is kept and the second is NOT merged into it"
              % (what, kept, dropped, key, identifier_case),
              table=kept)

    def _install(key, spelling, cols):
        # cols: list of (column, type) in declaration order.
        if key in table_keys:
            if display[key] != spelling:
                _collide("table", key, display[key], spelling)
            return
        colmap = {}
        collist = []
        col_disp = {}
        col_exact = {}
        for col, typ in cols:
            ckey = fold(col)
            if ckey in colmap:
                if col_disp[ckey] != col:
                    _collide("column", "%s.%s" % (key, ckey), col_disp[ckey], col)
                continue  # keep first; catalog should not dup but stay safe
            colmap[ckey] = typ if typ is not None else "UNKNOWN"
            collist.append(ckey)
            col_disp[ckey] = col
            col_exact.setdefault(col, ckey)
        sqlglot_schema[key] = colmap
        if spelling != key:
            # SQLGlot's own lookup is by the token in the SQL, and a QUOTED
            # reference carries the catalog's spelling rather than the matching
            # key. Give its schema BOTH, the second under a QUOTED key so
            # SQLGlot's per-dialect normalization leaves it alone — otherwise
            # `SELECT * FROM "item"` would lose its star expansion under a
            # folding rule. Only sqlglot sees this second entry: the views below
            # stay in matching-key space, and the resolution functions map a
            # display spelling back through ``columnExact`` / ``exactTables``.
            sqlglot_schema[_quoted_key(spelling)] = {
                _quoted_key(c): (t if t is not None else "UNKNOWN")
                for c, t in cols}
        columns[key] = collist
        table_keys.add(key)
        display[key] = spelling
        exact_tables.setdefault(spelling, key)
        column_display[key] = col_disp
        column_exact[key] = col_exact

    def _keys(schema, table):
        """(matching key, display spelling) for the bare and qualified forms."""
        out = [(fold(table), table)]
        if schema:
            out.append(("%s.%s" % (fold(schema), fold(table)),
                        "%s.%s" % (schema, table)))
        return out

    for (schema, table), rows in by_table.items():
        # Stable declaration order: by ordinal when present, else input order.
        indexed = list(enumerate(rows))
        indexed.sort(key=lambda p: (p[1][0] if p[1][0] is not None else p[0], p[0]))
        ordered_cols = [(r[1], r[2]) for _, r in indexed]
        for key, spelling in _keys(schema, table):
            _install(key, spelling, ordered_cols)

    # Tables that had a table record but no columns still count as known tables.
    for (schema, table) in seen_tables:
        if not table:
            continue
        for key, spelling in _keys(schema, table):
            _install(key, spelling, [])

    return {"sqlglot": sqlglot_schema, "columns": columns, "tables": table_keys,
            "display": display, "exactTables": exact_tables,
            "columnDisplay": column_display, "columnExact": column_exact,
            "identifierCase": identifier_case, "collisions": collisions}


# --------------------------------------------------------------------------- #
# Per-statement analysis
# --------------------------------------------------------------------------- #

def _new_spellings():
    """The two spelling memories one statement needs.

    ``table`` — matching key -> the way a TABLE node spelled it;
    ``any``   — matching key -> the way the first identifier of any kind spelled
                it.
    A name the catalog knows is printed with the CATALOG's spelling; these two
    are for the names it does not know (a stub table, an unresolved column),
    which must still be reported the way the statement wrote them.
    """
    return {"table": {}, "any": {}}


def _orig(spellings, name, kind="any"):
    """The spelling ``name`` (a matching key) was written with, or ``name``."""
    if not spellings or not isinstance(name, str):
        return name
    if kind == "table":
        hit = spellings["table"].get(name)
        if hit is not None:
            return hit
    return spellings["any"].get(name, name)


def _fold_statement(expr, identifier_case, spellings):
    """Rewrite every UNQUOTED identifier in place to its matching key.

    This is the ONE place the fold touches SQL. A quoted identifier is left
    exactly as written, because a quoted identifier is exact in every dialect
    this engine knows; it is later matched against the catalog's
    declared spellings and against nothing else.
    """
    if identifier_case == EXACT:
        return expr
    for t in expr.find_all(exp.Table):
        ident = t.this
        if isinstance(ident, exp.Identifier) and not ident.quoted \
                and isinstance(ident.this, str):
            spellings["table"].setdefault(
                fold_identifier(ident.this, identifier_case), ident.this)
    for ident in expr.find_all(exp.Identifier):
        if ident.quoted:
            continue
        text = ident.this
        if not isinstance(text, str):
            continue
        key = fold_identifier(text, identifier_case)
        if key != text:
            spellings["any"].setdefault(key, text)
            ident.set("this", key)
    return expr


def _is_quoted(node):
    """Whether this node's identifier was written quoted in the SQL.

    Quoting is what exempts an identifier from folding, so it has to survive
    ``qualify`` — which is why ``analyze_statement`` qualifies with
    ``quote_identifiers=False``. Accepts an ``exp.Identifier`` or any node whose
    ``this`` is one (``exp.Table``, ``exp.Column``).
    """
    ident = node if isinstance(node, exp.Identifier) else getattr(node, "this", None)
    return isinstance(ident, exp.Identifier) and bool(ident.quoted)


def _table_ref(node, schema_index, spellings):
    """Identity of one ``exp.Table``: ``(matching key or None, display name)``.

    The matching key is ``None`` when the catalog has no such table — the
    statement then names something this pack cannot resolve, and the display name
    is the statement's own spelling so the miss is reported (and any stub node is
    built) the way the SQL wrote it.
    """
    written = node.name
    if not written:
        return None
    if _is_quoted(node):
        # A quoted identifier is exact: it must hit a spelling the catalog
        # declared, and folding never gets a say.
        key = schema_index["exactTables"].get(written)
    else:
        key = written if written in schema_index["tables"] else None
        # `written` is already folded, so a miss here can only be a token
        # SQLGlot injected in the catalog's own spelling (see the second schema
        # entry in build_schema_index) — never a looser match on user SQL.
        if key is None:
            key = schema_index["exactTables"].get(written)
    if key is None:
        return (None, _orig(spellings, written, "table"))
    return (key, schema_index["display"][key])


def _column_display(schema_index, table_key, node):
    """The catalog's spelling of the column ``node`` names inside ``table_key``,
    or None when that table declares no such column."""
    if table_key is None:
        return None
    if _is_quoted(node):
        key = schema_index["columnExact"].get(table_key, {}).get(node.name)
    else:
        key = node.name if node.name in schema_index["columnDisplay"].get(table_key, {}) else None
        if key is None:  # an injected display spelling — see _table_ref
            key = schema_index["columnExact"].get(table_key, {}).get(node.name)
    return None if key is None else schema_index["columnDisplay"][table_key][key]


def _alias_map(expr, schema_index, spellings):
    """Map every table alias (and bare table name) to its table identity.

    ``{alias_or_name: (matching key or None, display name)}`` built from every
    base ``exp.Table`` node in the (possibly nested) expression. A column's
    ``.table`` token — an alias after qualify, or a bare name before it — is
    looked up here to recover the table it belongs to.
    """
    m = {}
    for t in expr.find_all(exp.Table):
        ref = _table_ref(t, schema_index, spellings)
        if ref is None:
            continue
        m[t.alias_or_name] = ref
        m.setdefault(t.name, ref)
    return m


def _resolve_table_token(token, alias_map):
    """Table identity for a column's table token, or None if it maps to nothing
    known (e.g. a derived-table / CTE alias, or an unqualified column)."""
    if not token:
        return None
    return alias_map.get(token)


def _sole_table(alias_map):
    """The single base table in scope, or None when there are zero or many
    (a bare column is only unambiguous when exactly one table is present)."""
    distinct = set(alias_map.values())
    return next(iter(distinct)) if len(distinct) == 1 else None


def _ref_known(ref):
    """Whether a table identity resolved to a catalog table."""
    return ref is not None and ref[0] is not None


def _catalog_has_column(schema_index, table, column):
    """Membership test in MATCHING-KEY space (both arguments already folded)."""
    cols = schema_index["columns"].get(table)
    return cols is not None and column in cols


def _catalog_has_table(schema_index, table):
    """Membership test in MATCHING-KEY space (the argument already folded)."""
    return table in schema_index["tables"]


def _add_col(bucket, unresolved, seen_unres, schema_index, alias_map,
             col_node, access, sole_table=None, spellings=None):
    """Attribute one ``exp.Column`` to (table, column, access), or file it under
    ``unresolved`` (fail-closed) — never guess a wrong table.

    ``sole_table`` — when the statement has exactly one base table in scope, its
    identity. A bare (unqualified) column is then unambiguous and attributed to
    it. sqlglot's ``qualify`` only attaches source tables inside SELECT scopes;
    UPDATE/DELETE/INSERT columns come back bare, so this single-table fallback is
    what resolves the common single-table CRUD statement. With two or more tables
    a bare column stays ambiguous → unresolved (§3.3).

    The fact is emitted under the CATALOG's spelling of both names; the
    statement's own spelling is what the unresolved details quote.
    """
    name = col_node.name
    # `__subst__` is piece-2's placeholder for a MyBatis `${}` raw string
    # substitution — a genuinely unknown column/table token, not a real ref.
    # Compared case-insensitively because a fold-upper run has already turned it
    # into `__SUBST__` by the time this sees it.
    if not name or name.lower() == "__subst__":
        _record_unres(unresolved, seen_unres, "unqualified_column",
                      "string-substitution or unnameable column token")
        return
    written = _orig(spellings, name)
    token = col_node.table
    ref = _resolve_table_token(token, alias_map)
    if ref is None and not token and sole_table is not None:
        ref = sole_table  # unambiguous single-table attribution
    if ref is None:
        detail = ("column %r has no resolvable table" % written) if not token \
            else ("column %r bound to unknown source %r"
                  % (written, _orig(spellings, token, "table")))
        _record_unres(unresolved, seen_unres, "unqualified_column", detail)
        return
    table_key, table_display = ref
    if table_key is None:
        _record_unres(unresolved, seen_unres, "table_not_in_catalog",
                      "table %r (column %r) is not in the catalog"
                      % (table_display, written))
        return
    column_display = _column_display(schema_index, table_key, col_node)
    if column_display is None:
        _record_unres(unresolved, seen_unres, "column_unknown_in_table",
                      "column %r not found in catalog table %r"
                      % (written, table_display))
        return
    bucket.add((table_display, column_display, access))


def _record_unres(unresolved, seen, reason, detail):
    key = (reason, detail)
    if key in seen:
        return
    seen.add(key)
    unresolved.append({"reason": reason, "detail": detail})


def _write_columns_of_insert(insert_expr):
    """The explicit ``(c1, c2, ...)`` column list of an INSERT as identifier
    NODES (the quoting matters), or None if the statement gave no list (implicit
    — it writes all of the table's columns)."""
    target = insert_expr.this
    if isinstance(target, exp.Schema):
        return [i for i in target.expressions if isinstance(i, exp.Identifier)]
    return None


def _insert_target_table(insert_expr, alias_map):
    """Identity of an INSERT's target table, or None."""
    target = insert_expr.this
    tbl = target.this if isinstance(target, exp.Schema) else target
    if isinstance(tbl, exp.Table):
        return _resolve_table_token(tbl.alias_or_name, alias_map)
    return None


# --------------------------------------------------------------------------- #
# JOIN-relationship extraction (ERD edges from how the SQL joins tables). This
# DB has no foreign keys — the only record of a table relationship is the equi-
# join a mapper writes. We recover those, resolving each column's table with the
# same alias/table machinery used for column lineage (never guessing a table).
# --------------------------------------------------------------------------- #

def _rel_key(rel):
    """Full-tuple identity of a relationship, for de-duplication within one
    statement (two identical predicates collapse to one; the same pair seen in
    both an ON and a WHERE stays distinct because ``kind`` differs)."""
    l, r = rel["left"], rel["right"]
    return (l["schema"], l["table"], l["column"],
            r["schema"], r["table"], r["column"], rel["kind"])


def _side_sort_key(side):
    """None-safe ordering key for one relationship endpoint (schema/column may be
    None; comparing None to a str would raise in py3)."""
    return (side[0] or "", side[1] or "", side[2] or "")


def _relationship_from_eq(eq, kind, alias_map, schema_index, schema_of,
                          spellings=None):
    """Turn one ``exp.EQ`` into a canonical relationship, or explain why not.

    Returns ``(rel_or_None, dropped_bool)``:
      - Both operands must be **columns** resolving (via alias_map + the schema
        index) to two **different** real catalog tables. Then ``rel`` is the
        relationship, endpoints ordered canonically so de-dup is order-free.
      - A ``col = col`` predicate we could not resolve to two real tables is a
        real join we are forced to drop (fail-closed, no guessing): ``dropped``
        is True so the caller can count it.
      - Anything that is not ``col = col`` (a literal, function, arithmetic side)
        or a same-table equality (``a.x = a.y``) is simply not a cross-table
        relationship: ``(None, False)`` — not counted as a dropped join.
    """
    l, r = eq.this, eq.expression
    if not (isinstance(l, exp.Column) and isinstance(r, exp.Column)):
        return None, False  # literal / expression side — not a join predicate
    lref = _resolve_table_token(l.table, alias_map)
    rref = _resolve_table_token(r.table, alias_map)
    if not (_ref_known(lref) and _ref_known(rref)):
        return None, True   # a col=col join we cannot resolve → drop & count
    if lref[0] == rref[0]:
        return None, False  # same-table equality, not a cross-table relationship
    # The endpoint column keeps the catalog's spelling when the catalog declares
    # it, and the statement's own spelling when it does not (the ERD still shows
    # what the SQL joined on rather than dropping the endpoint).
    lcol = _column_display(schema_index, lref[0], l) or _orig(spellings, l.name)
    rcol = _column_display(schema_index, rref[0], r) or _orig(spellings, r.name)
    left = (schema_of.get(lref[1]), lref[1], lcol or None)
    right = (schema_of.get(rref[1]), rref[1], rcol or None)
    if _side_sort_key(right) < _side_sort_key(left):
        left, right = right, left
    rel = {
        "left": {"schema": left[0], "table": left[1], "column": left[2]},
        "right": {"schema": right[0], "table": right[1], "column": right[2]},
        "kind": kind,
    }
    return rel, False


def _extract_joins(expr, schema_index, alias_map, spellings=None):
    """Extract cross-table equi-join relationships from one statement.

    Primary source: explicit ``exp.Join`` nodes with an ``ON`` condition
    (``kind:"on"``). Secondary: ``exp.EQ`` predicates in a ``WHERE`` clause
    (implicit equi-joins, ``kind:"where"``). Returns ``(joins, dropped)`` where
    ``joins`` is de-duplicated and canonically sorted (deterministic) and
    ``dropped`` counts col=col predicates whose tables would not resolve.
    """
    # Map display table name -> its schema/db (when the SQL qualifies it). This
    # DB qualifies nothing, so these are ordinarily None — recorded honestly.
    schema_of = {}
    for t in expr.find_all(exp.Table):
        if not t.name:
            continue
        ref = alias_map.get(t.alias_or_name) or alias_map.get(t.name)
        if ref is not None:
            schema_of.setdefault(ref[1], _orig(spellings, t.db) or None)

    rels = {}          # _rel_key -> rel dict (de-dup within the statement)
    dropped = 0
    seen_eq = set()    # id(eq) — a nested WHERE is reached twice by find_all

    def _consider(eq, kind):
        nonlocal dropped
        if id(eq) in seen_eq:
            return
        seen_eq.add(id(eq))
        rel, drop = _relationship_from_eq(
            eq, kind, alias_map, schema_index, schema_of, spellings)
        if drop:
            dropped += 1
        elif rel is not None:
            rels[_rel_key(rel)] = rel

    for join in expr.find_all(exp.Join):
        on = join.args.get("on")
        if on is None:
            continue  # USING / natural / cross join — no ON columns to read
        for eq in on.find_all(exp.EQ):
            _consider(eq, "on")

    for where in expr.find_all(exp.Where):
        for eq in where.find_all(exp.EQ):
            _consider(eq, "where")

    ordered = sorted(rels.values(), key=lambda j: (
        j["left"]["table"], j["left"]["column"] or "",
        j["right"]["table"], j["right"]["column"] or "",
        j["kind"],
    ))
    return ordered, dropped


DEFAULT_DIALECT = "mysql"


def analyze_statement(sql, stmt_type, schema_index, default_schema=None,
                      diagnostics=None, dialect=DEFAULT_DIALECT):
    """Resolve read/write/delete tables and columns for one SQL statement.

    Returns ``{"tables": [...], "columns": [...], "unresolved": [...]}`` where
      tables  — ``[{"table":.., "access":"read|write|delete"}]``
      columns — ``[{"table":.., "column":.., "access":"read|write"}]``
      unresolved — ``[{"reason":.., "detail":..}]``
    all de-duplicated and deterministically sorted. Never raises on bad SQL: a
    parse failure or a qualify failure is recorded in ``unresolved`` and the best
    available result is still returned (§3.3 — no silent drop).

    The identifier-case rule is read from ``schema_index`` — the index and the
    walk must agree on what makes two spellings one name, so there is exactly one
    place to declare it.
    """
    tables = set()          # (table, access)
    columns = set()         # (table, column, access)
    unresolved = []
    seen_unres = set()

    stype = (stmt_type or "").lower()
    identifier_case = schema_index.get("identifierCase", EXACT)
    # SQLGlot normalizes identifiers itself inside `qualify`, by ITS per-dialect
    # table. Pinning its strategy to the case declared here is what keeps the
    # tokens it hands back in the same key space this index is built in.
    read_dialect = sqlglot_dialect(dialect, identifier_case)

    # ---- parse ------------------------------------------------------------- #
    try:
        expr = sqlglot.parse_one(sql, read=read_dialect)
    except (ParseError, Exception) as e:  # noqa: BLE001 — never crash a stream
        _record_unres(unresolved, seen_unres, "parse_failed",
                      str(e).replace("\n", " ")[:300])
        _diag(diagnostics, "warn", "parse_failed",
              "sqlglot could not parse statement", type=stype)
        return _finalize(tables, columns, unresolved)
    if expr is None:
        _record_unres(unresolved, seen_unres, "parse_failed", "empty parse result")
        return _finalize(tables, columns, unresolved)

    # ---- fold unquoted identifiers to their matching keys ------------------ #
    # Done BEFORE qualify so both the qualified tree and the best-effort fallback
    # tree below speak the same key space as the catalog index.
    spellings = _new_spellings()
    _fold_statement(expr, identifier_case, spellings)

    # ---- qualify (attach tables, expand stars) ----------------------------- #
    qualified = expr
    try:
        qualified = qualify(
            expr.copy(),
            schema=schema_index["sqlglot"],
            dialect=read_dialect,
            # Keep the SQL's own quoting: a quoted identifier is exact, and
            # qualify's default would quote everything and erase the difference.
            quote_identifiers=False,
            **({"db": default_schema} if default_schema else {})
        )
    except (OptimizeError, Exception) as e:  # noqa: BLE001 — fall back, don't drop
        _record_unres(unresolved, seen_unres, "qualify_failed",
                      str(e).replace("\n", " ")[:300])
        _diag(diagnostics, "warn", "qualify_failed",
              "qualify failed; best-effort unqualified walk", type=stype)
        qualified = expr  # best-effort on the un-qualified tree

    # sqlglot could not model the statement (e.g. MySQL REPLACE INTO, which it
    # parses as an opaque Command). Do not silently drop it: record it as
    # unresolved so the count reflects reality (§3.3).
    if isinstance(qualified, exp.Command):
        _record_unres(unresolved, seen_unres, "unsupported_syntax",
                      "sqlglot parsed %r statement as an opaque Command; no "
                      "table/column facts extracted" % stype)
        _diag(diagnostics, "warn", "unsupported_syntax",
              "statement parsed as opaque Command", type=stype)
        return _finalize(tables, columns, unresolved)

    alias_map = _alias_map(qualified, schema_index, spellings)

    # ---- dispatch by statement type --------------------------------------- #
    if isinstance(qualified, exp.Insert):
        _analyze_insert(qualified, schema_index, alias_map, tables, columns,
                        unresolved, seen_unres, spellings)
    elif isinstance(qualified, exp.Update):
        _analyze_update(qualified, schema_index, alias_map, tables, columns,
                        unresolved, seen_unres, spellings)
    elif isinstance(qualified, exp.Delete):
        _analyze_delete(qualified, schema_index, alias_map, tables, columns,
                        unresolved, seen_unres, spellings)
    else:
        # SELECT (and any read-only shape): every table read, every column read.
        _analyze_select(qualified, schema_index, alias_map, tables, columns,
                        unresolved, seen_unres, spellings)

    joins, joins_dropped = _extract_joins(qualified, schema_index, alias_map,
                                          spellings)
    return _finalize(tables, columns, unresolved, joins, joins_dropped)


def _table_access_all(expr, access, tables, alias_map, exclude=None):
    """Record ``access`` for every base table node except ``exclude`` (by id).

    The table is recorded under the CATALOG's spelling when the catalog knows it
    and under the statement's own spelling when it does not (an unknown table
    still becomes a fact — a stub — rather than vanishing).
    """
    for t in expr.find_all(exp.Table):
        if exclude is not None and id(t) in exclude:
            continue
        if not t.name:
            continue
        ref = alias_map.get(t.alias_or_name) or alias_map.get(t.name)
        tables.add(((ref[1] if ref is not None else t.name), access))


def _analyze_select(expr, schema_index, alias_map, tables, columns,
                    unresolved, seen_unres, spellings=None):
    _table_access_all(expr, "read", tables, alias_map)
    sole = _sole_table(alias_map)
    for c in expr.find_all(exp.Column):
        _add_col(columns, unresolved, seen_unres, schema_index, alias_map, c,
                 "read", sole_table=sole, spellings=spellings)


def _analyze_insert(expr, schema_index, alias_map, tables, columns,
                    unresolved, seen_unres, spellings=None):
    target = _insert_target_table(expr, alias_map)
    target_key = target[0] if target is not None else None
    target_display = target[1] if target is not None else None
    if target_display:
        tables.add((target_display, "write"))

    write_cols = _write_columns_of_insert(expr)
    if write_cols is not None:
        for col_node in write_cols:
            if target_display is None:
                continue
            if target_key is None:
                # The target is not a catalog table. The statement still says it
                # writes this column, so the fact is kept under the spellings the
                # SQL used — exactly as before RM12; it lands on a stub table.
                columns.add((target_display,
                             _orig(spellings, col_node.name), "write"))
                continue
            col_display = _column_display(schema_index, target_key, col_node)
            if col_display is None:
                _record_unres(unresolved, seen_unres, "column_unknown_in_table",
                              "insert column %r not in catalog table %r"
                              % (_orig(spellings, col_node.name), target_display))
            else:
                columns.add((target_display, col_display, "write"))
    else:
        # No explicit column list: writes all of the target's catalog columns.
        cat_cols = schema_index["columns"].get(target_key) if target_key else None
        if cat_cols:
            disp = schema_index["columnDisplay"][target_key]
            for col in cat_cols:
                columns.add((target_display, disp[col], "write"))
            _record_unres(unresolved, seen_unres, "implicit_insert_columns",
                          "INSERT without a column list: wrote all %d catalog "
                          "columns of %r" % (len(cat_cols), target_display))
        else:
            _record_unres(unresolved, seen_unres, "implicit_insert_columns",
                          "INSERT without a column list and table %r not in "
                          "catalog: column writes unknown" % (target_display,))

    # INSERT ... SELECT: the source SELECT's tables/columns are reads.
    source = expr.expression
    if isinstance(source, (exp.Select, exp.Union, exp.Subquery)):
        src_alias = _alias_map(source, schema_index, spellings)
        _table_access_all(source, "read", tables, src_alias)
        src_sole = _sole_table(src_alias)
        for c in source.find_all(exp.Column):
            _add_col(columns, unresolved, seen_unres, schema_index, src_alias,
                     c, "read", sole_table=src_sole, spellings=spellings)


def _analyze_update(expr, schema_index, alias_map, tables, columns,
                    unresolved, seen_unres, spellings=None):
    target_node = expr.this
    target = None
    if isinstance(target_node, exp.Table):
        target = _resolve_table_token(target_node.alias_or_name, alias_map) \
            or _table_ref(target_node, schema_index, spellings)
    if target:
        tables.add((target[1], "write"))
    # Any other table (join / subquery source) is a read.
    target_ids = {id(t) for t in target_node.find_all(exp.Table)} \
        if target_node is not None else set()
    _table_access_all(expr, "read", tables, alias_map, exclude=target_ids)

    # SET assignments: LHS column is a write; everything in the RHS is a read.
    # A bare SET column belongs to the update target (the sole table, absent a
    # join); joins make it ambiguous → unresolved.
    sole = _sole_table(alias_map)
    set_eqs = expr.args.get("expressions") or []
    write_col_ids = set()
    for eq in set_eqs:
        lhs = eq.this if isinstance(eq, exp.EQ) else None
        if isinstance(lhs, exp.Column):
            write_col_ids.add(id(lhs))
            _add_col(columns, unresolved, seen_unres, schema_index, alias_map,
                     lhs, "write", sole_table=sole, spellings=spellings)

    # Every other column in the statement (RHS exprs, WHERE, JOIN ON, subqueries)
    # is a read.
    for c in expr.find_all(exp.Column):
        if id(c) in write_col_ids:
            continue
        _add_col(columns, unresolved, seen_unres, schema_index, alias_map, c,
                 "read", sole_table=sole, spellings=spellings)


def _analyze_delete(expr, schema_index, alias_map, tables, columns,
                    unresolved, seen_unres, spellings=None):
    target_node = expr.this
    target = None
    if isinstance(target_node, exp.Table):
        target = _resolve_table_token(target_node.alias_or_name, alias_map) \
            or _table_ref(target_node, schema_index, spellings)
    if target:
        tables.add((target[1], "delete"))
    # Subquery / USING tables are reads.
    target_ids = {id(t) for t in target_node.find_all(exp.Table)} \
        if target_node is not None else set()
    _table_access_all(expr, "read", tables, alias_map, exclude=target_ids)

    # Reference invariant: DELETE writes NO columns. WHERE (and subquery) columns
    # are reads only.
    sole = _sole_table(alias_map)
    for c in expr.find_all(exp.Column):
        _add_col(columns, unresolved, seen_unres, schema_index, alias_map, c,
                 "read", sole_table=sole, spellings=spellings)


def _finalize(tables, columns, unresolved, joins=None, joins_dropped=0):
    tbl_list = [{"table": t, "access": a} for (t, a) in sorted(tables)]
    col_list = [{"table": t, "column": c, "access": a}
                for (t, c, a) in sorted(columns)]
    unres_sorted = sorted(unresolved, key=lambda u: (u["reason"], u["detail"]))
    # ``joins`` is purely additive; ``joinsDropped`` is an internal tally the
    # stream layer sums for its summary and is not part of the emitted record.
    return {"tables": tbl_list, "columns": col_list, "unresolved": unres_sorted,
            "joins": joins or [], "joinsDropped": joins_dropped}


# --------------------------------------------------------------------------- #
# Stream
# --------------------------------------------------------------------------- #

def analyze_stream(statement_records, schema_index, diagnostics=None,
                   default_schema=None, dialect=DEFAULT_DIALECT):
    """Map piece-2 statement records to lineage records (header first).

    Non-``statement`` records (e.g. piece-2's header) are ignored. Each statement
    record contributes exactly one ``lineage`` record, carrying through
    namespace/id/type/file/line. Header tallies (statements, tableFacts,
    columnFacts, unresolvedColumns) are computed over the emitted records.
    """
    lineage_records = []
    n_stmts = 0
    n_table_facts = 0
    n_col_facts = 0
    n_unres_cols = 0
    n_join_facts = 0
    n_joins_dropped = 0

    for rec in statement_records:
        if rec.get("kind") != "statement":
            continue
        n_stmts += 1
        analysis = analyze_statement(
            rec.get("sql") or "",
            rec.get("type"),
            schema_index,
            default_schema=default_schema,
            diagnostics=diagnostics,
            dialect=dialect,
        )
        n_table_facts += len(analysis["tables"])
        n_col_facts += len(analysis["columns"])
        n_unres_cols += sum(
            1 for u in analysis["unresolved"]
            if u["reason"] in _COLUMN_UNRESOLVED_REASONS
        )
        n_join_facts += len(analysis["joins"])
        n_joins_dropped += analysis.get("joinsDropped", 0)
        lineage_records.append({
            "kind": "lineage",
            "namespace": rec.get("namespace"),
            "id": rec.get("id"),
            "type": rec.get("type"),
            "tables": analysis["tables"],
            "columns": analysis["columns"],
            "joins": analysis["joins"],
            "unresolved": analysis["unresolved"],
            # Carried through from piece 2, not re-derived: whether the mapper
            # spliced raw text into this SQL (``${}``), and whether a schema
            # qualifier had to be dropped because no default schema was declared
            # (I-4). The graph bridge puts both on the statement node, so
            # `cascade estimate` can measure them without re-reading the mappers.
            "hasStringSubst": bool(rec.get("hasStringSubst")),
            "schemaUnknown": bool(rec.get("schemaUnknown")),
            "file": rec.get("file"),
            "line": rec.get("line"),
        })

    header = {
        "kind": "header",
        "schema": SQLFACTS_SCHEMA,
        "version": LINEAGE_VERSION,
        "statements": n_stmts,
        "tableFacts": n_table_facts,
        "columnFacts": n_col_facts,
        "joinFacts": n_join_facts,
        "unresolvedColumns": n_unres_cols,
        "unresolvedJoins": n_joins_dropped,
    }
    return [header] + lineage_records


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _emit(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _read_jsonl(path, diagnostics):
    """Read a JSONL file (or stdin when path is '-') into a list of dict records.

    A line that is not valid JSON is skipped with a diagnostic (never crashes the
    run). Blank lines are ignored."""
    if path == "-":
        fh = sys.stdin
        close = False
    else:
        try:
            fh = open(path, "r", encoding="utf-8")
        except OSError as e:
            sys.stderr.write("error: cannot read %r: %s\n" % (path, e))
            return None
        close = True
    records = []
    try:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                _diag(diagnostics, "warn", "bad_jsonl_line",
                      "skipped unparseable line %d in %s: %s" % (n, path, e))
    finally:
        if close:
            fh.close()
    return records


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="lineage.py",
        description="Resolve SQL table/column read-write-delete lineage from a "
                    "Cascade catalog + statement JSONL pair.",
    )
    parser.add_argument("--catalog", required=True,
                        help="catalog JSONL from catalog_ddl.py ('-' for stdin)")
    parser.add_argument("--statements", required=True,
                        help="statement JSONL from mybatis_extract.py ('-' for stdin)")
    parser.add_argument("--default-schema", default=None,
                        help="default schema/db name for unqualified tables")
    parser.add_argument("--dialect", default=DEFAULT_DIALECT,
                        help="sqlglot dialect to parse and qualify with "
                             "(default: %s); the caller maps the profile's "
                             "sqlDialects.main onto this" % DEFAULT_DIALECT)
    parser.add_argument("--identifier-case", default=None, dest="identifier_case",
                        choices=list(IDENTIFIER_CASES),
                        help="how two spellings of an identifier are matched: "
                             "fold-lower / fold-upper / exact. Omitted means the "
                             "dialect's own documented rule (identifier_case.py); "
                             "the caller routes the profile's sqlIdentifierCase "
                             "onto this")
    args = parser.parse_args(argv)

    if args.catalog == "-" and args.statements == "-":
        sys.stderr.write("error: only one of --catalog/--statements may be '-'\n")
        return 2

    diagnostics = []
    catalog_records = _read_jsonl(args.catalog, diagnostics)
    if catalog_records is None:
        return 2
    statement_records = _read_jsonl(args.statements, diagnostics)
    if statement_records is None:
        return 2

    identifier_case = args.identifier_case \
        or identifier_case_for_dialect(args.dialect)
    schema_index = build_schema_index(catalog_records, identifier_case,
                                      diagnostics=diagnostics)
    records = analyze_stream(statement_records, schema_index,
                             diagnostics=diagnostics,
                             default_schema=args.default_schema,
                             dialect=args.dialect)

    out = sys.stdout
    try:
        for rec in records:
            out.write(_emit(rec))
            out.write("\n")
        out.flush()
    except BrokenPipeError:
        import os
        try:
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, sys.stdout.fileno())
        except OSError:
            pass
        return 0

    for d in diagnostics:
        sys.stderr.write(_emit(d) + "\n")
    header = records[0]
    total_col_refs = header["columnFacts"] + header["unresolvedColumns"]
    rate = (header["unresolvedColumns"] / total_col_refs) if total_col_refs else 0.0
    sys.stderr.write(_emit({
        "level": "info",
        "code": "summary",
        "version": LINEAGE_VERSION,
        "statements": header["statements"],
        "tableFacts": header["tableFacts"],
        "columnFacts": header["columnFacts"],
        "joinFacts": header["joinFacts"],
        "unresolvedColumns": header["unresolvedColumns"],
        "unresolvedJoins": header["unresolvedJoins"],
        "unresolvedRate": round(rate, 4),
        "dialect": args.dialect,
        "identifierCase": identifier_case,
        "identifierCollisions": len(schema_index["collisions"]),
        "defaultSchema": args.default_schema,
        "diagnostics": len(diagnostics),
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
