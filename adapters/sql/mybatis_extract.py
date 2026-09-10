#!/usr/bin/env python3
"""MyBatis / iBATIS mapper extractor for the Cascade SQL lane, piece 2 of 3.

Walks mapper XML files and emits, per SQL statement, a **flattened SQL
text** that a SQL parser (piece 3) can consume. The flattening is best-effort:
dynamic tags are collapsed to one representative form (never expanded
combinatorially: one flattened string per statement, not a template), and
``<include refid="...">`` fragments are resolved, both within a mapper and
cross-file by ``namespace.refid`` (mall's generated mappers lean on a shared
``Base_Column_List`` fragment, so cross-file resolution is mandatory).

Parsing is done with ``xml.etree.ElementTree`` — **never regex** for XML
structure, which is a house rule here. ``re`` is used only for tiny local text tasks
(placeholder substitution, whitespace collapse, best-effort line lookup).

Determinism: identical inputs + args produce byte-for-byte identical
stdout. Statements are sorted by (namespace, id); every line is emitted with
sorted keys and no incidental whitespace. Nothing time-, machine-, or
absolute-path-derived enters the output (paths are relative to ``--root`` when
given, else the file basename).

Fail-closed / no silent loss (SPEC §3.3, §17.8): a file that will not parse as
XML emits a structured diagnostic to stderr and the run continues — one bad file
never crashes the whole run. Unresolved includes and include cycles are counted
and reported, never silently dropped.

Schema qualifiers (SPEC §6.2, invariant I-4): a project that writes
``select ... from ${dbMain}.tb_user`` is naming a SCHEMA through a MyBatis
property, not splicing a fragment. ``--schema-property dbMain`` says so, and then
``--default-schema mall`` rewrites the qualifier to ``mall.tb_user``. WITHOUT a
default schema the qualifier is DROPPED (``tb_user``) and the statement is
flagged ``schemaUnknown`` — the engine never invents a schema name. A ``${x}``
that is not declared a schema property keeps today's behaviour: it stays the raw
substitution marker it is, and flags the statement ``hasStringSubst``.

iBATIS 2: the same statements in the element that shipped before MyBatis
was called MyBatis. ``<sqlMap namespace="Sample">`` holds ``<select>``,
``<insert>``, ``<update>``, ``<delete>``, ``<procedure>`` and ``<statement>``;
its bind parameter is ``#name#`` rather than ``#{name}`` and its raw
substitution is ``$name$`` rather than ``${name}``; its dynamic tags are
``<dynamic>``, ``<isNotNull>``/``<isEqual>``/… and ``<iterate>``, each carrying
a ``prepend`` the runtime folds in. All of that is flattened by the same rules
the MyBatis tags go through, so both conventions produce one statement axis.

What an iBATIS statement is CALLED depends on one setting. ``<sqlMapConfig>``
with ``<settings useStatementNamespaces="true"/>`` makes the runtime key
``namespace.id``; without it (the iBATIS default) the key is the bare ``id``,
global across every sqlMap file. A ``<sqlMapConfig>`` among the inputs is read
for that setting; two configs that disagree are reported and the default stands.

CLI: ``python mybatis_extract.py [--root DIR] [--default-schema NAME]
     [--schema-property NAME ...] [--files-from LIST]
     <file-or-dir> [<file-or-dir> ...]``
     (a directory is walked for ``*.xml`` mapper files; ``--files-from`` reads a
     newline-delimited list of files instead, which is how a run that reads one
     database vendor's copy of each mapper says which copies those are.)
"""

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

STMTS_SCHEMA = "cascade:mybatis-stmts:1"

# Worker version — the identity of THIS extractor's output shape. It rides in
# the header record and is folded into the content-addressed statement-shard key
# (SPEC §17.7), so upgrading the worker invalidates the cache instead of mixing
# two generations of facts. BUMP IT whenever the records below change.
# Mirrored (and asserted) in src/core/worker_versions.mjs.
EXTRACTOR_VERSION = "mybatis-extract/2"

# The four statement tags MyBatis executes as SQL, keyed by tag name.
_STATEMENT_TAGS = ("select", "insert", "update", "delete")

# ...and iBATIS 2's six. `<procedure>` runs a callable statement and
# `<statement>` is the untyped one every iBATIS DAO falls back to; both are SQL
# the runtime sends, so both are read.
_IBATIS_STATEMENT_TAGS = ("select", "insert", "update", "delete", "procedure", "statement")

# iBATIS 2's conditional tags. Every one of them means "include the body when
# the property passes this test", and every one may carry `prepend`, `open` and
# `close` text the runtime folds in around the body. The TEST is not modelled --
# the goal here is SQL a parser can read, one flattened form per statement --
# so each is flattened to its affixes plus its body, exactly the way MyBatis'
# `<if>` is.
_IBATIS_CONDITIONAL_TAGS = frozenset((
    "isequal", "isnotequal", "isgreaterthan", "isgreaterequal",
    "islessthan", "islessequal", "isnull", "isnotnull",
    "isempty", "isnotempty", "ispropertyavailable", "isnotpropertyavailable",
    "isparameterpresent", "isnotparameterpresent",
))

# The root elements this worker reads: MyBatis 3's, iBATIS 2's, and the iBATIS
# configuration file that says what a statement is called.
_MAPPER_ROOTS = ("mapper", "sqlMap")

# `#{param}` / `#{param,jdbcType=...}` are prepared-statement bind parameters:
# MyBatis binds them as JDBC placeholders. We render them as `?`, the standard
# SQL placeholder — it parses everywhere sqlglot accepts SQL (`where id = ?`,
# `values (?, ?)`, `then ?`) and unambiguously marks a bind site for piece 3.
_BIND_PLACEHOLDER = "?"

# `${param}` is a raw *string substitution* (a column name, table name, or an
# order-by fragment spliced into the SQL text before it is sent). We render it
# as a neutral identifier so the surrounding SQL still parses (`order by
# __subst__`, `and __subst__`), and we flag the statement with `hasStringSubst`
# because a `${}` is an injection / limit concern the later lanes must see.
_SUBST_PLACEHOLDER = "__subst__"

# Matches a single `#{...}` or `${...}` token (no nested braces occur in MyBatis).
_PARAM_RE = re.compile(r"([#$])\{[^{}]*\}")
# iBATIS 2 writes the same two things as `#name#` and `$name$` -- a pair of
# markers around a property name, with the optional `:JDBCTYPE:NULLVALUE`
# suffixes iBATIS allows. Applied ONLY to a `<sqlMap>` file, so a `#` in a
# MyBatis mapper's SQL is left exactly where it is.
_IBATIS_PARAM_RE = re.compile(r"([#$])([A-Za-z_$][\w.$\[\]]*(?::[^\s#$]*)?)\1")
# ...and the same schema qualifier in the iBATIS spelling: `$dbMain$.tb_user`.
_IBATIS_SCHEMA_QUALIFIER_RE = re.compile(r"\$\s*([A-Za-z_][\w.]*)\s*\$\s*\.")
# A `${prop}` used as a SCHEMA QUALIFIER — i.e. immediately followed by a dot,
# as in `${dbMain}.tb_user`. Only rewritten when `prop` was declared in
# `schema.propertyNames`; every other `${}` falls through to _PARAM_RE.
_SCHEMA_QUALIFIER_RE = re.compile(r"\$\{\s*([^{}]*?)\s*\}\s*\.")
_WS_RE = re.compile(r"\s+")
# A leading SQL conjunction that MyBatis' <where>/<trim> auto-strips, matched
# only at a word boundary (so a column like `android_id` is never truncated).
_LEADING_CONJ_RE = re.compile(r"^(?:and|or)\b\s*", re.IGNORECASE)


def _diag(diagnostics, level, code, message, **extra):
    """Record a structured diagnostic (appended to the caller's list, if any)."""
    if diagnostics is not None:
        rec = {"level": level, "code": code, "message": message}
        rec.update(extra)
        diagnostics.append(rec)


def _localname(tag):
    """Element tag without any ``{namespace-uri}`` prefix (MyBatis uses none,
    but stay robust)."""
    if isinstance(tag, str) and "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _sub_schema_qualifiers(state, text):
    """Resolve `${prop}.` schema qualifiers declared in `schema.propertyNames`.

    With a default schema the qualifier becomes ``<default>.``; without one it is
    dropped and the statement is flagged ``schemaUnknown`` (invariant I-4: never
    invent a schema name). An undeclared ``${x}`` is left untouched for
    ``_sub_params`` to turn into the raw-substitution marker.
    """
    props = state.get("schemaProperties") or ()
    if not props or not text:
        return text

    def repl(m):
        if m.group(1) not in props:
            return m.group(0)
        default = state.get("defaultSchema")
        if default:
            return default + "."
        state["schemaUnknown"] = True
        return ""

    return _SCHEMA_QUALIFIER_RE.sub(repl, text)


def _sub_ibatis_schema_qualifiers(state, text):
    """The iBATIS spelling of the same qualifier: ``$dbMain$.tb_user``."""
    props = state.get("schemaProperties") or ()
    if not props or not text:
        return text

    def repl(m):
        if m.group(1) not in props:
            return m.group(0)
        default = state.get("defaultSchema")
        if default:
            return default + "."
        state["schemaUnknown"] = True
        return ""

    return _IBATIS_SCHEMA_QUALIFIER_RE.sub(repl, text)


def _sub_params(state, text):
    """Replace `#{}`/`${}` (and iBATIS' `#x#`/`$x$`) tokens in character data.

    A bind parameter -> ``?`` (bind marker). A raw substitution ->
    ``__subst__``, with the statement's ``hasStringSubst`` flag set. A declared
    schema qualifier is resolved first and never reaches the marker. Returns the
    substituted text unchanged otherwise.

    The iBATIS pass runs ONLY on a `<sqlMap>` file. A `#` means nothing in
    particular inside a MyBatis mapper's SQL, and reading one as a bind marker
    there would rewrite SQL nobody wrote that way.
    """
    if not text:
        return ""
    text = _sub_schema_qualifiers(state, text)

    def repl(m):
        if m.group(1) == "$":
            state["hasStringSubst"] = True
            return _SUBST_PLACEHOLDER
        return _BIND_PLACEHOLDER

    text = _PARAM_RE.sub(repl, text)
    if state.get("flavor") == "sqlMap":
        text = _sub_ibatis_schema_qualifiers(state, text)
        text = _IBATIS_PARAM_RE.sub(repl, text)
    return text


def _apply_overrides(inner, prefix_overrides, suffix_overrides):
    """Strip a ``<trim>``'s prefixOverrides/suffixOverrides tokens from inner SQL.

    MyBatis removes the first matching leading (prefixOverrides) and trailing
    (suffixOverrides) token — each attribute is a ``|``-separated candidate list
    (e.g. ``"and |or "``, ``","``). Matching is case-insensitive; only one
    candidate is stripped per side, mirroring MyBatis.
    """
    s = inner.strip()
    if prefix_overrides:
        for tok in prefix_overrides.split("|"):
            t = tok.strip()
            if t and s[:len(t)].lower() == t.lower():
                s = s[len(t):].lstrip()
                break
    if suffix_overrides:
        for tok in suffix_overrides.split("|"):
            t = tok.strip()
            if t and s[-len(t):].lower() == t.lower():
                s = s[:-len(t)].rstrip()
                break
    return s


def _flatten(elem, current_ns, state):
    """Recursively flatten a MyBatis element's inner SQL into a text list.

    ``elem``       — the element whose children/text produce SQL (a statement,
                     an ``<sql>`` fragment body, or a nested dynamic tag).
    ``current_ns`` — namespace owning ``elem`` (drives local include resolution
                     and follows a fragment across files).
    ``state``      — mutable run/statement state: the fragment index, the include
                     stack (cycle guard), ``hasStringSubst``, the unresolved and
                     cycle counters, the set of unknown tag names, diagnostics.

    Returns a list of text chunks (joined and whitespace-collapsed by the caller).
    Placeholders are already substituted; whitespace is normalized at the end.
    """
    out = [_sub_params(state, elem.text)]

    for child in elem:
        tag = _localname(child.tag)

        if tag is ET.Comment or tag is ET.ProcessingInstruction:
            pass  # ElementTree yields these as callables; they carry no SQL.
        elif tag == "include":
            out.extend(_expand_include(child, current_ns, state))
        elif tag == "where":
            # Prepend WHERE and drop a leading AND/OR (MyBatis' <where> does this,
            # and `WHERE and ...` will not parse).
            inner = _LEADING_CONJ_RE.sub("", "".join(_flatten(child, current_ns, state)).strip(), count=1)
            if inner:
                out.append(" WHERE " + inner + " ")
        elif tag == "set":
            # Prepend SET and drop a trailing comma (MyBatis' <set> does this).
            inner = "".join(_flatten(child, current_ns, state)).strip().rstrip(",").rstrip()
            if inner:
                out.append(" SET " + inner + " ")
        elif tag == "trim":
            # Fold the literal prefix/suffix affixes in and strip the
            # prefixOverrides/suffixOverrides tokens — dropping them loses parens
            # (`(...)`, `values (...)`) and leaves dangling AND/commas, which do
            # not parse. This is the "fold minimally" the SQL parser needs.
            inner = _apply_overrides(
                "".join(_flatten(child, current_ns, state)),
                child.get("prefixOverrides"), child.get("suffixOverrides"))
            out.append(" " + (child.get("prefix") or "") + " " + inner
                       + " " + (child.get("suffix") or "") + " ")
        elif tag == "foreach":
            # Keep the body once (no combinatorial expansion). Fold the literal
            # open/close delimiters in so `id IN (...)` stays parseable; drop the
            # separator (a single body needs none).
            body = "".join(_flatten(child, current_ns, state)).strip()
            out.append(" " + (child.get("open") or "") + " " + body
                       + " " + (child.get("close") or "") + " ")
        elif tag == "choose":
            # Representative branch: the first <when> (else the first <otherwise>).
            branch = None
            for sub in child:
                st = _localname(sub.tag)
                if st == "when":
                    branch = sub
                    break
                if st == "otherwise" and branch is None:
                    branch = sub
            if branch is not None:
                out.extend(_flatten(branch, current_ns, state))
        elif tag in ("if", "when", "otherwise"):
            # Keep the inner SQL, drop the control attribute (test). The goal is
            # parseable-enough SQL, not exact runtime semantics.
            out.extend(_flatten(child, current_ns, state))
        elif tag == "bind":
            pass  # `<bind name value>` declares a variable; emits no SQL text.
        elif tag == "dynamic":
            # iBATIS' `<dynamic prepend="WHERE">` (RM56). The prepend is folded
            # in; the first conjunction INSIDE it is dropped when there is a
            # prepend, which is what the runtime does and what keeps
            # `WHERE AND x = ?` from being written. With no prepend the body is
            # left as it stands: it is being appended to SQL that already has a
            # WHERE, and cutting its leading OR there would break the join.
            prepend = (child.get("prepend") or "").strip()
            inner = "".join(_flatten(child, current_ns, state)).strip()
            if prepend:
                inner = _LEADING_CONJ_RE.sub("", inner, count=1)
                out.append(" " + prepend + " " + inner + " ")
            elif inner:
                out.append(" " + inner + " ")
        elif tag == "iterate":
            # iBATIS' `<foreach>`: the body ONCE, with the literal open/close
            # delimiters folded in so `id IN (...)` stays parseable, and the
            # conjunction dropped for the same reason MyBatis' separator is.
            body = "".join(_flatten(child, current_ns, state)).strip()
            out.append(" " + (child.get("prepend") or "") + " " + (child.get("open") or "")
                       + " " + body + " " + (child.get("close") or "") + " ")
        elif tag.lower() in _IBATIS_CONDITIONAL_TAGS:
            # One iBATIS condition: its affixes and its body. The TEST is not
            # modelled, the same way MyBatis' `<if test>` is not.
            body = "".join(_flatten(child, current_ns, state)).strip()
            if body:
                out.append(" " + (child.get("prepend") or "") + " " + (child.get("open") or "")
                           + " " + body + " " + (child.get("close") or "") + " ")
        elif tag == "selectKey":
            # A separate key-generation SELECT MyBatis runs on its own; splicing
            # it into the host INSERT/UPDATE would corrupt that statement. Drop it.
            state["droppedSelectKey"] += 1
        else:
            # Unknown/rare tag: still recurse for its inner SQL (best-effort), but
            # record the tag name so the run can report what it could not model.
            state["unknownTags"].add(tag)
            out.extend(_flatten(child, current_ns, state))

        out.append(_sub_params(state, child.tail))

    return out


def _statement_namespaces_setting(config_root):
    """What one ``<sqlMapConfig>`` says about ``useStatementNamespaces``.

    Returns True, False, or None when the file does not mention it at all --
    which is not the same thing as saying false, even though iBATIS treats it
    the same way. The caller reports a disagreement; a file that stays silent
    disagrees with nobody.
    """
    for child in config_root.iter():
        if _localname(child.tag) != "settings":
            continue
        raw = child.get("useStatementNamespaces")
        if raw is None:
            continue
        return raw.strip().lower() == "true"
    return None


def _decide_statement_namespaces(configs, diagnostics):
    """Whether an iBATIS statement's runtime key carries its namespace.

    iBATIS' own default is False, and that is the answer when no configuration
    among the inputs says otherwise. Two configurations that DISAGREE cannot both
    be right about one run, so the disagreement is reported and the default
    stands: guessing which deployment is live would decide what every statement
    is called by reading files in walk order.
    """
    said = [c for c in configs if c["useStatementNamespaces"] is not None]
    values = sorted({c["useStatementNamespaces"] for c in said})
    if len(values) > 1:
        _diag(diagnostics, "warn", "statement_namespaces_conflict",
              "the sqlMapConfig files here disagree about useStatementNamespaces (%s); "
              "the iBATIS default (false) is used, so a statement's key is its bare id"
              % ", ".join("%s=%s" % (c["file"], "true" if c["useStatementNamespaces"] else "false")
                          for c in said),
              files=[c["file"] for c in said])
        return False
    return bool(values[0]) if values else False


def _resolve_refid(refid, current_ns, index):
    """Return the fragment-index key for an ``<include>`` refid, or None.

    Resolution order (SPEC §9.4 include convention):
      1. local — ``current_ns.refid`` (a bare id inside the same mapper);
      2. already fully-qualified — ``refid`` itself is ``namespace.fragid``.
    """
    if current_ns:
        local = current_ns + "." + refid
        if local in index:
            return local
    if refid in index:
        return refid
    return None


def _expand_include(child, current_ns, state):
    """Expand one ``<include refid="...">`` into its fragment body's SQL chunks."""
    index = state["fragments"]
    refid = child.get("refid")
    if not refid:
        state["unresolved"] += 1
        _diag(state["diagnostics"], "warn", "include_no_refid",
              "<include> without a refid attribute; skipped",
              namespace=current_ns)
        return []

    key = _resolve_refid(refid, current_ns, index)
    if key is None:
        state["unresolved"] += 1
        _diag(state["diagnostics"], "warn", "unresolved_include",
              "cannot resolve <include refid=%r> in namespace %r" % (refid, current_ns),
              namespace=current_ns, refid=refid)
        return []

    if key in state["include_stack"]:
        # Cycle: A -> ... -> A. Stop expanding this branch (do not loop forever).
        state["cycles"] += 1
        _diag(state["diagnostics"], "warn", "include_cycle",
              "include cycle detected at fragment %r; branch not expanded" % key,
              fragment=key)
        return []

    frag_elem, frag_ns, frag_flavor = index[key]
    state["include_stack"].add(key)
    outer_flavor = state.get("flavor")
    state["flavor"] = frag_flavor
    try:
        # A fragment resolves its own nested includes in *its* namespace, and is
        # read in ITS OWN convention: a `#name#` inside an iBATIS fragment is a
        # bind parameter wherever the statement that pulled it in was written.
        chunks = _flatten(frag_elem, frag_ns, state)
    finally:
        state["include_stack"].discard(key)
        state["flavor"] = outer_flavor
    return chunks


def _line_of(text, tag, stmt_id):
    """Best-effort 1-based line of a statement's opening tag.

    ElementTree in Python 3.9 exposes no source line numbers, so we locate the
    opening tag in the raw file text: the first ``<tag ... id="stmt_id" ...>``
    whose attribute list (``[^>]*`` — may span lines) carries that exact id, then
    count the newlines before it. Returns None if no reliable match is found
    (we emit null rather than guess a wrong line).
    """
    pat = re.compile(
        r"<" + re.escape(tag) + r"\b[^>]*\bid\s*=\s*[\"']" + re.escape(stmt_id) + r"[\"']"
    )
    m = pat.search(text)
    if not m:
        return None
    return text.count("\n", 0, m.start()) + 1


def _flatten_text(chunks):
    """Join chunks and collapse whitespace to single spaces (deterministic)."""
    return _WS_RE.sub(" ", "".join(chunks)).strip()


def _rel_path(path, root):
    """Output path: relative to ``root`` if given (POSIX slashes), else basename.

    Never an absolute path: an absolute path would move the pack digest between
    machines."""
    if root:
        try:
            rel = os.path.relpath(path, root)
            return rel.replace(os.sep, "/")
        except ValueError:
            pass  # different drive (Windows); fall back to basename
    return os.path.basename(path)


def extract_statements(files, root=None, diagnostics=None,
                       default_schema=None, schema_properties=()):
    """Extract flattened MyBatis statements from ``files`` into ordered records.

    Returns a list of dicts: a header record first, then one ``statement`` record
    per statement, sorted by (namespace, id). Includes are resolved against a
    global fragment index built across **all** ``files`` before any flattening,
    so cross-file ``namespace.refid`` references resolve.

    ``diagnostics`` — if a list is passed, structured warning dicts (unparseable
    files, unresolved includes, cycles, ...) are appended to it. Passing None
    discards them but never changes the returned records.

    ``default_schema`` / ``schema_properties`` — the profile's ``schema.default``
    and ``schema.propertyNames``. See the module docstring.
    """
    schema_properties = frozenset(schema_properties or ())
    # ---- Pass 1: parse every file; build the global fragment index. -----------
    parsed = []          # [{ns, root_elem, rel, text, flavor}]
    fragments = {}       # "namespace.fragid" -> (frag_elem, namespace, flavor)
    n_files = 0
    n_sqlmaps = 0
    configs = []         # every <sqlMapConfig> among the inputs

    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as e:
            _diag(diagnostics, "warn", "file_read_failed",
                  "cannot read file: %s" % e, file=_rel_path(path, root))
            continue

        try:
            # XXE safety: ElementTree's default parser (expat) does not resolve
            # external entities or fetch the external DTD; we add no resolver.
            root_elem = ET.fromstring(text)
        except ET.ParseError as e:
            _diag(diagnostics, "warn", "xml_parse_error",
                  "file is not well-formed XML: %s" % str(e).replace("\n", " "),
                  file=_rel_path(path, root))
            continue

        flavor = _localname(root_elem.tag)
        if flavor == "sqlMapConfig":
            # NOT a mapper: the file that says what a statement is CALLED.
            setting = _statement_namespaces_setting(root_elem)
            configs.append({"file": _rel_path(path, root), "useStatementNamespaces": setting})
            continue
        if flavor not in _MAPPER_ROOTS:
            _diag(diagnostics, "info", "not_a_mapper",
                  "root element is <%s>, not <mapper> or <sqlMap>; skipped"
                  % flavor,
                  file=_rel_path(path, root))
            continue

        ns = root_elem.get("namespace") or ""
        if not ns:
            _diag(diagnostics, "warn", "mapper_no_namespace",
                  "<%s> without a namespace attribute" % flavor, file=_rel_path(path, root))

        rel = _rel_path(path, root)
        parsed.append({"ns": ns, "root": root_elem, "rel": rel, "text": text, "flavor": flavor})
        n_files += 1
        if flavor == "sqlMap":
            n_sqlmaps += 1

        for child in root_elem:
            if _localname(child.tag) == "sql":
                frag_id = child.get("id")
                if not frag_id:
                    _diag(diagnostics, "warn", "sql_fragment_no_id",
                          "<sql> fragment without an id; skipped", file=rel)
                    continue
                key = (ns + "." + frag_id) if ns else frag_id
                if key in fragments:
                    _diag(diagnostics, "warn", "duplicate_fragment",
                          "duplicate <sql> fragment id %r; first definition kept" % key,
                          fragment=key, file=rel)
                    continue
                fragments[key] = (child, ns, flavor)

    # ---- Pass 2: flatten each statement against the global fragment index. -----
    statements = []
    total_unresolved = 0
    stmts_with_unresolved = 0
    total_cycles = 0
    unknown_tags = set()
    dropped_selectkey = 0

    use_ns = _decide_statement_namespaces(configs, diagnostics)
    seen_keys = {}
    for pf in parsed:
        ns, root_elem, rel, text = pf["ns"], pf["root"], pf["rel"], pf["text"]
        flavor = pf["flavor"]
        tags = _IBATIS_STATEMENT_TAGS if flavor == "sqlMap" else _STATEMENT_TAGS
        for child in root_elem:
            stype = _localname(child.tag)
            if stype not in tags:
                continue
            stmt_id = child.get("id")
            if not stmt_id:
                _diag(diagnostics, "warn", "statement_no_id",
                      "<%s> statement without an id; skipped" % stype, file=rel)
                continue

            state = {
                "fragments": fragments,
                "include_stack": set(),
                "hasStringSubst": False,
                "schemaUnknown": False,
                "schemaProperties": schema_properties,
                "defaultSchema": default_schema,
                "unresolved": 0,
                "cycles": 0,
                "unknownTags": unknown_tags,
                "droppedSelectKey": 0,
                "diagnostics": diagnostics,
                "flavor": flavor,
            }
            sql = _flatten_text(_flatten(child, ns, state))
            total_unresolved += state["unresolved"]
            total_cycles += state["cycles"]
            dropped_selectkey += state["droppedSelectKey"]
            if state["unresolved"]:
                stmts_with_unresolved += 1

            # WHAT THE RUNTIME LOOKS THIS STATEMENT UP BY. MyBatis always joins
            # the namespace on; iBATIS does so only when the configuration says
            # `useStatementNamespaces="true"`, and its default is the bare id,
            # global across every sqlMap file. The `namespace` field carries the
            # answer, so everything downstream keys the statement the way the
            # calling code names it.
            key_ns = ns if (flavor != "sqlMap" or use_ns) else ""
            key = (key_ns + "." + stmt_id) if key_ns else stmt_id
            first = seen_keys.get(key)
            if first is not None:
                _diag(diagnostics, "warn", "duplicate_statement_id",
                      "statement %r is declared in %s and again here; the runtime "
                      "answers with one of them and nothing in the source says which"
                      % (key, first), statement=key, file=rel)
            else:
                seen_keys[key] = rel

            statements.append({
                "kind": "statement",
                "namespace": key_ns,
                "id": stmt_id,
                "type": stype,
                "sql": sql,
                "hasStringSubst": state["hasStringSubst"],
                "schemaUnknown": state["schemaUnknown"],
                "file": rel,
                "line": _line_of(text, stype, stmt_id),
            })

    statements.sort(key=lambda r: (r["namespace"], r["id"]))

    if unknown_tags:
        _diag(diagnostics, "info", "unmodeled_tags",
              "flattened inner SQL of unmodeled tag(s) best-effort: %s"
              % ", ".join(sorted(unknown_tags)),
              tags=sorted(unknown_tags))
    if dropped_selectkey:
        _diag(diagnostics, "info", "dropped_selectkey",
              "dropped %d <selectKey> sub-statement(s) from host statements"
              % dropped_selectkey)

    header = {
        "kind": "header",
        "schema": STMTS_SCHEMA,
        "version": EXTRACTOR_VERSION,
        "files": n_files,
        "sqlMapFiles": n_sqlmaps,
        "statementNamespaces": use_ns,
        "statements": len(statements),
        "fragments": len(fragments),
        "unresolvedIncludes": total_unresolved,
        "schemaUnknownStatements": sum(1 for st in statements if st["schemaUnknown"]),
    }
    return [header] + statements


def _emit(rec):
    return json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _collect_xml_files(inputs, diagnostics):
    """Expand CLI inputs (files or directories) into a sorted list of *.xml paths."""
    files = []
    for item in inputs:
        if os.path.isdir(item):
            for dirpath, _dirnames, filenames in os.walk(item):
                for fn in filenames:
                    if fn.endswith(".xml"):
                        files.append(os.path.join(dirpath, fn))
        elif os.path.isfile(item):
            files.append(item)
        else:
            _diag(diagnostics, "warn", "input_not_found",
                  "input path does not exist: %s" % item)
    files.sort()  # deterministic file order (also stabilizes fragment index)
    return files


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="mybatis_extract.py",
        description="Flatten MyBatis mapper XML statements into a deterministic "
                    "JSONL stream for the Cascade SQL lane.",
    )
    parser.add_argument("--root", default=None,
                        help="directory to make output file paths relative to "
                             "(default: file basename)")
    parser.add_argument("--default-schema", default=None,
                        help="schema name a declared ${property} qualifier "
                             "resolves to; omitted means the schema stays "
                             "unknown and the qualifier is dropped (I-4)")
    parser.add_argument("--schema-property", action="append", default=[],
                        metavar="NAME", dest="schema_property",
                        help="a MyBatis property used as a schema qualifier "
                             "(repeatable), e.g. --schema-property dbMain")
    parser.add_argument("--files-from", default=None, metavar="LIST",
                        help="a newline-delimited file listing the mapper .xml "
                             "files to read, INSTEAD of walking directories. "
                             "How a run that reads one database vendor's copy "
                             "of each mapper says which copies those are")
    parser.add_argument("inputs", nargs="*", metavar="file-or-dir",
                        help="mapper .xml files or directories to walk for *.xml")
    args = parser.parse_args(argv)
    if not args.inputs and args.files_from is None:
        parser.error("give at least one file or directory, or --files-from LIST")

    diagnostics = []
    inputs = list(args.inputs)
    if args.files_from is not None:
        with open(args.files_from, "r", encoding="utf-8") as fh:
            inputs.extend(line for line in (raw.strip() for raw in fh) if line)
    files = _collect_xml_files(inputs, diagnostics)
    records = extract_statements(files, root=args.root, diagnostics=diagnostics,
                                 default_schema=args.default_schema,
                                 schema_properties=args.schema_property)

    out = sys.stdout
    try:
        for rec in records:
            out.write(_emit(rec))
            out.write("\n")
        out.flush()
    except BrokenPipeError:
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
        "version": EXTRACTOR_VERSION,
        "files": header["files"],
        "sqlMapFiles": header["sqlMapFiles"],
        "statementNamespaces": header["statementNamespaces"],
        "statements": header["statements"],
        "fragments": header["fragments"],
        "unresolvedIncludes": header["unresolvedIncludes"],
        "schemaUnknownStatements": header["schemaUnknownStatements"],
        "warnings": sum(1 for d in diagnostics if d.get("level") == "warn"),
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
