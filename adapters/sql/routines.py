"""Stored routines, read as text: the SQL a procedure or a function runs.

WHAT THIS MODULE OWNS. A mapper that writes ``{call p_movetag_insert(?, ?)}``
names a procedure, and the tables are inside the procedure, not in the mapper.
Korean SI systems keep a great deal of their business logic that way, in Oracle
packages and PostgreSQL functions, and a lineage that stops at the call stops
before the tables. So two readers, both lexical:

  the routines     ``CREATE [OR REPLACE] FUNCTION|PROCEDURE name ... AS $$ body $$``
                   (PostgreSQL), ``CREATE [OR REPLACE] PROCEDURE|FUNCTION name
                   ... IS|AS ... END [name];`` (Oracle, Tibero), and the routines
                   of an Oracle ``PACKAGE BODY`` as ``package.routine``
  the statements   every SELECT, INSERT, UPDATE, DELETE, MERGE or WITH a body
                   runs, taken out of the control flow around it (IF, LOOP,
                   FOR ... IN, cursor declarations), with PL/SQL's own
                   ``INTO variable`` clause of a SELECT removed so the rest is SQL

A branch is not modelled: every statement a body holds is one it CAN run, which
is the reading a MyBatis ``<if>`` already gets.

WHAT IT MUST NEVER KNOW ABOUT: the catalog of tables, the graph, sqlglot. Text in,
text out; the lineage worker analyses what comes back.
"""

import re

ROUTINE_KINDS = ("function", "procedure")

_NAME = r'(?:"[^"]+"|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*))?'

_PG_HEAD_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(" + _NAME + r")\s*\(",
    re.IGNORECASE)
_DOLLAR_RE = re.compile(r"\bAS\s+(\$[A-Za-z_]*\$)", re.IGNORECASE)
_LANG_RE = re.compile(r"\bLANGUAGE\s+'?([A-Za-z_]+)'?", re.IGNORECASE)

_ORA_HEAD_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION)\s+(" + _NAME + r")",
    re.IGNORECASE)
_ORA_PKG_BODY_RE = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?PACKAGE\s+BODY\s+(" + _NAME + r")\s+(?:IS|AS)\b",
    re.IGNORECASE)
_ORA_INNER_RE = re.compile(r"(?:^|;|\bIS\b|\bAS\b)\s*(PROCEDURE|FUNCTION)\s+([A-Za-z_][\w$#]*)", re.IGNORECASE)
_SLASH_LINE_RE = re.compile(r"^\s*/\s*$", re.MULTILINE)

_DML_START_RE = re.compile(r"\b(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)\b", re.IGNORECASE)
_CUT_RE = re.compile(r"\b(LOOP|THEN)\b", re.IGNORECASE)


def _unquote(name):
    parts = [p.strip() for p in re.split(r"\s*\.\s*", name)]
    return ".".join(p[1:-1] if p.startswith('"') and p.endswith('"') else p for p in parts)


def _line_of(text, index):
    return text.count("\n", 0, index) + 1


def _blank_comments(text):
    """Comments and string literals blanked to spaces, lines kept: what the scanners read."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("--", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", text[i:j]))
            i = j
        elif c == "'":
            j = i + 1
            while j < n:
                if text[j] == "'" and j + 1 < n and text[j + 1] == "'":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            j = min(j + 1, n)
            out.append("'" + re.sub(r"[^\n]", " ", text[i + 1:j - 1]) + ("'" if j - i >= 2 else ""))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _postgres_routines(text, masked, source):
    out = []
    for m in _PG_HEAD_RE.finditer(masked):
        tail = masked[m.end():]
        d = _DOLLAR_RE.search(tail)
        if d is None:
            continue
        tag = d.group(1)
        body_start = m.end() + d.end()
        body_end = text.find(tag, body_start)
        if body_end < 0:
            continue
        # A `CREATE` between the head and the body is another statement's.
        if _PG_HEAD_RE.search(masked, m.end(), m.end() + d.start()) or re.search(
                r"\bCREATE\b", masked[m.end():m.end() + d.start()], re.IGNORECASE):
            continue
        lang = _LANG_RE.search(masked[m.end():min(len(masked), body_end + len(tag) + 200)])
        out.append({
            "kind": "routine",
            "routineKind": m.group(1).lower(),
            "name": _unquote(m.group(2)),
            "language": lang.group(1).lower() if lang else None,
            "body": text[body_start:body_end],
            "source": source,
            "line": _line_of(text, m.start()),
        })
    return out


def _oracle_end(masked, start):
    """Where one Oracle routine ends: the `/` line after it, or the text's end."""
    slash = _SLASH_LINE_RE.search(masked, start)
    return slash.start() if slash else len(masked)


def _oracle_routines(text, masked, source):
    out = []
    for m in _ORA_PKG_BODY_RE.finditer(masked):
        pkg = _unquote(m.group(1))
        end = _oracle_end(masked, m.end())
        # From the package's own `IS`, so the first routine has its boundary too.
        inner = list(_ORA_INNER_RE.finditer(masked, m.end() - 2, end))
        for k, im in enumerate(inner):
            stop = inner[k + 1].start() if k + 1 < len(inner) else end
            out.append({
                "kind": "routine", "routineKind": im.group(1).lower(),
                "name": "%s.%s" % (pkg, im.group(2)), "language": "plsql",
                "body": text[im.end():stop], "source": source, "line": _line_of(text, im.start()),
            })
    for m in _ORA_HEAD_RE.finditer(masked):
        head_tail = masked[m.end():m.end() + 4000]
        if "$" in head_tail.split(";")[0] and _DOLLAR_RE.search(head_tail):
            continue  # a PostgreSQL routine, read above
        isas = re.search(r"\b(IS|AS)\b", head_tail, re.IGNORECASE)
        if isas is None:
            continue
        start = m.end() + isas.end()
        out.append({
            "kind": "routine", "routineKind": m.group(1).lower(),
            "name": _unquote(m.group(2)), "language": "plsql",
            "body": text[start:_oracle_end(masked, start)], "source": source,
            "line": _line_of(text, m.start()),
        })
    return out


def extract_routines(text, source=None):
    """Every stored routine one DDL text declares, sorted by name then line.

    A name declared twice keeps both records; which one a database holds is the
    order the script runs in, and the lineage reads the LAST.
    """
    text = str(text or "")
    masked = _blank_comments(text)
    found = _postgres_routines(text, masked, source) + _oracle_routines(text, masked, source)
    seen = set()
    out = []
    for r in sorted(found, key=lambda r: (r["name"].lower(), r["line"])):
        key = (r["name"].lower(), r["line"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _split_top(masked):
    """Semicolon-separated pieces at parenthesis depth 0, as (start, end) spans."""
    spans, depth, start = [], 0, 0
    for i, c in enumerate(masked):
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif c == ";" and depth == 0:
            spans.append((start, i))
            start = i + 1
    spans.append((start, len(masked)))
    return spans


def _depth_zero_cut(masked, start, end):
    """The first LOOP/THEN at parenthesis depth 0 in [start, end), or end."""
    depth = 0
    i = start
    while i < end:
        c = masked[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and c.isalpha():
            m = _CUT_RE.match(masked, i)
            if m and (i == 0 or not (masked[i - 1].isalnum() or masked[i - 1] == "_")):
                return i
        i += 1
    return end


def _strip_select_into(sql):
    """PL/SQL's `SELECT a, b INTO v_a, v_b FROM t` without its INTO clause."""
    m = re.match(r"(?is)^\s*SELECT\b(.*?)\bINTO\b(.*?)\bFROM\b", sql)
    if m is not None:
        return "SELECT" + m.group(1) + "FROM" + sql[m.end():]
    # No FROM at all: `SELECT nextval('seq') INTO v_id` assigns a value and reads no table.
    m = re.match(r"(?is)^\s*SELECT\b(.*?)\bINTO\b.*$", sql)
    return "SELECT" + m.group(1) if m is not None else sql


def embedded_statements(body):
    """The SQL statements one routine body runs, in order, as (sql, type, offset).

    ``type`` is the statement's first keyword, lower-cased; ``offset`` is where
    in the body it starts.
    """
    body = str(body or "")
    masked = _blank_comments(body)
    out = []
    for s, e in _split_top(masked):
        pos = s
        while pos < e:
            m = _DML_START_RE.search(masked, pos, e)
            if m is None:
                break
            # A SELECT inside parentheses belongs to the statement around it.
            before = masked[s:m.start()]
            if before.count("(") > before.count(")"):
                pos = m.end()
                continue
            stop = _depth_zero_cut(masked, m.start(), e)
            sql = body[m.start():stop].strip()
            if sql:
                kind = m.group(1).lower()
                out.append((_strip_select_into(sql) if kind == "select" else sql, kind, m.start()))
            pos = stop + 4 if stop < e else e
    return out


_CALL_RE = re.compile(
    r"(?:\{\s*(?:\?\s*=\s*)?call\s+|\bCALL\s+|\bEXEC(?:UTE)?\s+|\bPERFORM\s+)(" + _NAME + r")",
    re.IGNORECASE)
_INVOKE_RE = re.compile(r"(" + _NAME + r")\s*\(")


def routine_names_in(sql):
    """Every name one SQL text calls or invokes, as written (un-quoted), in order."""
    masked = _blank_comments(str(sql or ""))
    names = []
    for m in _CALL_RE.finditer(masked):
        names.append(_unquote(m.group(1)))
    for m in _INVOKE_RE.finditer(masked):
        names.append(_unquote(m.group(1)))
    seen, out = set(), []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def is_pure_call(sql):
    """Whether a statement is nothing but a routine call, which no SQL parser reads."""
    s = _blank_comments(str(sql or "")).strip()
    return bool(re.match(r"(?is)^(\{\s*(\?\s*=\s*)?call\b.*\}|CALL\b|EXEC(UTE)?\b|BEGIN\b.*\bEND\s*;?)", s))
