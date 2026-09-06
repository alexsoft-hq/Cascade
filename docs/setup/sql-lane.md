# SQL lane setup

The SQL lane is the half of the engine that reads your database side. It turns a
DDL file (or a fetched catalog snapshot) into tables and columns, MyBatis XML
into statements, and each statement into the columns it reads and writes. That
gives you `mapper → statement → table → column`.

It needs Python and one library. It never opens a database connection while
analyzing, so you can run it on a laptop with no access to the real server.

For the other half, `endpoint → controller → service → mapper`, see
[java-lane.md](java-lane.md). The Java lane is a separate, JDK-only,
parse-only lane, and you do not need it to get value out of this one.

## 1. Python and sqlglot

| What | Pin | Why |
|---|---|---|
| Python | 3.12.x | the reference stack, and what sqlglot is tested against here |
| a project-local `.venv` | `.venv/` at the repo root | the worker looks for `.venv/bin/python` first |
| sqlglot | `sqlglot==30.17.0` | the SQL parser, dialect by dialect, for Oracle, MySQL and PostgreSQL |

```bash
python3 -m venv .venv
.venv/bin/pip install -r adapters/sql/requirements.txt
node bin/cascade.mjs doctor      # tells you what is still missing, and the fix
```

The version is pinned in `adapters/sql/requirements.txt`, not chosen at install
time. sqlglot ships often, and a different version parses some statements
differently, which would move the pack digest. The digest has to be
reproducible, so the pin comes first and the upgrade is its own change: bump the
file, run the suite, and read the diff.

Live-catalog drivers (PyMySQL, psycopg, oracledb) are listed in the same file
but commented out. Install one only if you actually run
[`cascade catalog fetch`](db-catalog.md).

## 2. Dialect, and what counts as the same name

`profile.sqlDialects.main` names your database. Two separate things follow from
it: which **parser** sqlglot uses, and the rule that decides when **two
spellings mean one object**. The second is a property of the database rather
than of the parser, so we declare it here instead of inheriting whatever the
parser happens to do.

| `sqlDialects.main` | sqlglot parser | identifier case | where the rule comes from |
|---|---|---|---|
| `mysql`, `mariadb` | `mysql` | `fold-lower` | MySQL always compares column, index, trigger and event names case-insensitively. Table and database names follow the server's `lower_case_table_names` (0 stores and compares as written, 1 lower-cases, 2 compares insensitively). A DDL file does not carry that setting, so the lane takes the portable value the MySQL manual recommends for cross-platform schemas. |
| `postgres`, `postgresql` | `postgres` | `fold-lower` | PostgreSQL folds unquoted identifiers to lower case (manual §4.1.1). |
| `oracle`, `oracle-11g`, `oracle-19c` | `oracle` | `fold-upper` | Oracle stores and compares unquoted identifiers in upper case. |
| `hsqldb` | sqlglot's default (ANSI) parser | `fold-upper` | HSQLDB follows the SQL standard, where unquoted identifiers fold to upper case. sqlglot 30.17.0 ships no HSQLDB parser, so we use the standard-SQL one and say so. The case rule still comes from HSQLDB. |
| `h2` | sqlglot's default (ANSI) parser | `fold-upper` | H2's classic default (`DATABASE_TO_UPPER=TRUE`) folds unquoted identifiers to upper case. Same parser note as `hsqldb`. |
| anything else | | | refused. A dialect we cannot route is an error rather than a quiet fall back to MySQL: a wrong dialect mis-parses every statement, and the result would still look fine. |

Two rules apply under every row.

- A **quoted** identifier (`"Item"`, `` `Item` ``) is exact everywhere. We match
  it against the spelling the catalog declares and never fold it.
- The fold is only a matching key. Names print the way the **catalog** spells
  them, so a lower-case DDL read under `fold-upper` still answers
  `pms_product`.

`profile.sqlIdentifierCase` overrides the table with `fold-lower`, `fold-upper`
or `exact`. The default, `null`, takes the dialect's own rule. Use `exact` for a
case-sensitive MySQL deployment (`lower_case_table_names=0`) whose schema really
does tell `Item` from `ITEM`. Changing the key changes what matches, so it
invalidates the cached lineage of every statement.

If two catalog names fold onto one key, the run prints a
`folded_identifier_collision` warning naming both, the first declaration keeps
the key, and both tables stay in the pack. Nothing is merged in silence.

## 3. Where the table and column comments come from

Column answers carry business meaning only when the catalog carries comments.
There are two ways to get them, and you pick one per project.

**A file in the repo.** If the tree ships a schema dump with `CREATE TABLE` and
`COMMENT`, point `catalog.source: "file"` and `catalog.connectionFrom` at it.
This needs nothing but Python and sqlglot, and it is where to start.

**A snapshot you fetch once.** For a schema that lives only in a running
database, `cascade catalog fetch` opens one read-only connection, reads the
tables, columns and comments, and writes a snapshot into `.cascade/`. Analysis
then reads the snapshot, never the server. Set `catalog.source: "jdbc"` and read
[db-catalog.md](db-catalog.md) for the connection and credential rules.
Credentials are never committed, and never written into `.cascade/`, the pack or
a log.

With no catalog at all, the lane still works: a table or column exists in the
pack wherever a statement named it. The pack then declares the catalog axis
`not-shipped` and says why, so you can see what you are missing rather than
guess.

## 4. A first project to try it on

[macrozheng/mall](https://github.com/macrozheng/mall) is a good first target:
Apache-2.0, Spring Boot with MyBatis XML mappers, a MySQL dump in the repo, and
a matching Vue admin. About 30 tables, which is big enough to show one column
reaching many screens and small enough to iterate on.

Keep target checkouts **outside** this repository, in a sibling folder. The name
`target-examples/` says what it is: disposable, safe to delete later without
anyone having to investigate first.

```bash
git clone --depth 1 https://github.com/macrozheng/mall ../target-examples/mall

node bin/cascade.mjs init    --root ../target-examples/mall --project mall
node bin/cascade.mjs analyze --root ../target-examples/mall
node bin/cascade.mjs view    --project mall
```

`init` writes `.cascade/manifest.json` (the checkout path and its pinned commit)
and `.cascade/profile.json` (the build tool, the framework packs, the dialect,
and where the catalog comes from). `analyze` takes no lane flags: it reads those
two files plus what discovery found. If you want to know what a run would ship
before you run it, `cascade estimate` says so axis by axis.

The venv (`.venv/`) and `__pycache__/` are gitignored engine runtime, and are
not committed.

## 5. Testing the lane

```bash
.venv/bin/python -m unittest discover -s adapters/sql -q   # the Python side
npm run test:quick                                          # the Node side
```

`scripts/generality-gate.mjs` runs the whole engine over a pinned corpus of real
repositories that nobody wrote it for, Apache DolphinScheduler and JeecgBoot
among them. That corpus exists to catch a rule that only works on the project it
was written against; it is not a fallback target, and it is not a demo. It
clones outside this repository and is skipped unless you ask for it.
