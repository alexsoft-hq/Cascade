# The DB catalog — three paths, and what each one costs you

Column lineage is only worth reading when the catalog carries the **comments**:
`pms_product.delete_status` means nothing on its own; the column comment
*"deletion flag — 0 live, 1 soft-deleted"* is the whole answer. This
page is about getting those comments in, and about the one thing the engine
refuses to do on its own — connect to your database.

There are three paths. Pick one per project; the profile records which.

| Path | `catalog.source` | Needs | Ships |
|---|---|---|---|
| A · a DDL file in the repo | `"file"` | nothing but Python + sqlglot | the catalog axis, **shipped** |
| B · a live read-only fetch | `"jdbc"` | one driver, one confirmed connection, once | the catalog axis, **shipped** |
| C · neither | `"none"` | nothing | the column axis, **degraded** — and it says so |

## The rule that shapes all of this

> **Analysis never connects to a database.** The extraction path makes zero
> network calls, and the DB catalog adapter lives *outside* it.
> `cascade catalog fetch` connects once, when you tell it to, and writes a
> **snapshot**. Every later `cascade analyze` reads that file. That is what
> makes a pack reproducible against a database that keeps changing.

## Path A — a DDL file (start here)

If the repository ships a schema dump with `CREATE TABLE … COMMENT`, you are
done: `cascade init` finds it and writes `catalog.source: "file"` with the path.
Nothing else to install, nothing to connect to.

```bash
node bin/cascade.mjs analyze --root /path/to/repo --ddl document/sql/mall.sql
```

## Path B — a live read-only fetch

### 1. See where the database might be

```bash
node bin/cascade.mjs catalog discover --root /path/to/repo
```

It reads `application.yml` / `application*.properties` / `.env` files and lists
what it found:

```
connection-info candidates under /path/to/repo: 2
  [1] mall-admin/src/main/resources/application-dev.yml  (spring-yml)
      mysql localhost:3306/mall — user root, password present (<literal in file>)
      jdbc:mysql://localhost:3306/mall?useUnicode=true&serverTimezone=Asia/Shanghai
  [2] mall-admin/src/main/resources/application-prod.yml  (spring-yml)
      mysql db:3306/mall — user reader, password present (<literal in file>)
```

**No password value is read, printed or stored** — only whether one is there
(`passwordPresent`) and where it comes from (`<literal in file>`, or the
`${DB_PASSWORD}` placeholder the file names). Placeholders are never resolved
from your shell environment: a parser that reads `process.env` makes its answer
depend on who ran it, and pulls a real secret into a printable object.

**Which files are read at all.** A `.yml` / `.yaml` / `.properties` / `.env`
anywhere in the tree — *except* under `static/`, `public/`, `templates/`,
`i18n/` or a `locale*/` directory, and except a resource bundle by name
(`messages*.properties`, or a `_xx_XX` locale suffix). Those hold translations
and vendored web assets, never a datasource. The rule is narrow on purpose: only
the full `_language_COUNTRY` suffix counts as a locale, so a real config called
`app_db.properties` is still read. Measured on jeecgboot/JeecgBoot, this cut
`cascade init`'s diagnostics from **211 to 3** — 208 of them were one per
unreadable line of a single PDF.js locale bundle — while all **18** connection
candidates were still found.

An unreadable line in a file that IS read produces **one** diagnostic per file
(with the count and the first line numbers), and only when the file also carries
a datasource-shaped key. A line this reader cannot parse in a file that holds no
datasource key is not a gap in the analysis; it is somebody else's file.

What the readers understand, and where they stop:

- **`.properties`** — `spring.datasource.url|username|password`,
  `spring.datasource.hikari.jdbc-url`, the multi-datasource
  `spring.datasource.<name>.url`, and (in a file with no Spring datasource at
  all) a plain `jdbc.connectionURL` + `jdbc.userId` + `jdbc.password` group.
- **`application.yml`** — a *minimal indentation-based reader for the
  `spring: datasource:` subtree only*. It reads block mappings, scalar values,
  quoted scalars, `#` comments and `---` document splits. It refuses — with a
  diagnostic, never a guess — sequences, flow collections (`{a: b}`), block
  scalars (`|`, `>`), anchors/aliases/merge keys, and tab indentation. It is not
  a YAML parser and must not become one (the engine ships zero runtime deps).
- **`.env`** — `DB_URL` / `JDBC_URL` / `DATABASE_URL` / `SPRING_DATASOURCE_URL`
  and the matching user/password keys.
- **anything else** — a bare `jdbc:…` URL in the text (the `DataSource` bean
  case). Only the URL: a password on a neighbouring line cannot be attributed to
  it, so it is not claimed.

URL forms: `jdbc:mysql://`, `jdbc:mariadb://` (read as the MySQL dialect),
`jdbc:postgresql://`, `jdbc:oracle:thin:@//host:port/service`,
`jdbc:oracle:thin:@host:port:sid`, and the driver-less `postgres://` /
`mysql://`. A scheme the engine does not know yields `dialect: null` — never a
guess. Credentials the URL itself carries (`user:pw@host`, `?password=…`, the
Oracle `user/pw@` prefix) are redacted out of the URL before it is returned.

### 2. Install the driver for your dialect

The drivers are **optional** — nothing above needed one, and neither does any
analysis. `adapters/sql/catalog_live.py` imports them lazily and, when one is
missing, says which package to install rather than dying at import.

| Dialect | `pip install` |
|---|---|
| MySQL / MariaDB | `pymysql` |
| PostgreSQL | `psycopg[binary]` |
| Oracle | `oracledb` |

See the commented block at the bottom of `adapters/sql/requirements.txt`.

### 3. Fetch — after confirming the exact target

```bash
export CASCADE_DB_PASSWORD='…'
node bin/cascade.mjs catalog fetch --root /path/to/repo --candidate 1 --yes
```

Without `--yes` it prints the target and **refuses**:

```
cascade catalog fetch would open a READ-ONLY connection to:
  mysql localhost:3306/mall
  as user      root
  password     from the environment variable CASCADE_DB_PASSWORD (never from the command line, never stored)
  read from    mall-admin/src/main/resources/application-dev.yml
  writes       …/.cascade/catalog/columns.jsonl
               …/.cascade/catalog/snapshot.json
  queries      metadata SELECTs only (tables, columns, comments, primary keys)

Refusing to connect: pass --yes to confirm this exact target.
```

**Why the confirmation exists**: the host, port and database
above came out of the analyzed repository, and the analyzed repository is
untrusted input. Without this step, a checkout could plant an
`application.yml` pointing at a machine of the attacker's choosing and have your
tool dial it. So a human reads the target and types `--yes`. There is no
"remember this" flag.

You can also spell the target out instead of picking a candidate — as a URL, or
field by field:

```bash
node bin/cascade.mjs catalog fetch --root /path/to/repo \
  --url jdbc:postgresql://pg.example.com:5432/shop --user reader \
  --password-env PG_READER_PW --schema public --yes

node bin/cascade.mjs catalog fetch --root /path/to/repo \
  --dialect postgres --host pg.example.com --port 5432 --database shop --user reader \
  --password-env PG_READER_PW --schema public --yes
```

A password written into `--url` is stripped, not used: the password comes from
the named environment variable, always.

### 4. Point the profile at the snapshot

`fetch` does **not** edit your profile — turning the source on is your sentence,
not the tool's. Add to `.cascade/profile.json`:

```json
"catalog": { "source": "jdbc" }
```

`cascade analyze` then reads `.cascade/catalog/columns.jsonl`. With
`source: "jdbc"` and no snapshot it fails with the structured error
`db-catalog-missing` pointing back at `cascade catalog fetch` — it does not
quietly fall back to an empty catalog.

## What is read, and what is stored

**Read** — metadata only, in read-only transactions:

| Dialect | Tables & comments | Columns & comments | Primary key |
|---|---|---|---|
| MySQL / MariaDB | `INFORMATION_SCHEMA.TABLES.TABLE_COMMENT` | `INFORMATION_SCHEMA.COLUMNS.COLUMN_COMMENT` | `COLUMN_KEY = 'PRI'` |
| PostgreSQL | `pg_catalog.obj_description` | `information_schema.columns` + `pg_description` | `pg_constraint.contype = 'p'` |
| Oracle | `ALL_TAB_COMMENTS` | `ALL_TAB_COLUMNS` + `ALL_COL_COMMENTS` | `ALL_CONSTRAINTS/ALL_CONS_COLUMNS` type `P` |

No table data is ever selected. The read-only claim is not a promise in this
document: every statement the worker can issue is a module-level constant, and
`adapters/sql/test_catalog_live.py` parses the worker's own source and fails if
any constant contains `INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|
MERGE|CALL|EXEC` as a statement keyword, or if any `cursor.execute` is handed
anything but one of those constants by name. The session is additionally put
into a read-only transaction (`SET SESSION TRANSACTION READ ONLY` on MySQL,
`default_transaction_read_only=on` on PostgreSQL, `SET TRANSACTION READ ONLY`
on Oracle).

**Stored** — two files, both inside the `catalog/` directory that `cascade init`
already gitignored:

- `.cascade/catalog/columns.jsonl` — the catalog records themselves: table and
  column names, types, nullability, primary keys, and the comments. These carry
  your business vocabulary, which is why the directory is ignored by default.
- `.cascade/catalog/snapshot.json` — the provenance: dialect, server version,
  `serverIdentity` (`host:port/db`), `fetchedAt`, the sha256 of
  `columns.jsonl`, and which candidate file the target came from.

**Never stored, anywhere**: the password. Not in `.cascade/`, not
in the pack, not in a log, not in the receipt, not in the home registry. It is
read by the worker from the environment variable you name and passed to the
driver; it is never a command-line argument (argv is world-readable in `ps`) and
a driver exception that quotes it back is scrubbed before it is printed. The
`serverIdentity` in the snapshot and in `pack.meta.catalog` is `host:port/db` —
no user, no URL, no credentials. Two tests hold this: a Python one that runs the
worker with a known password and greps every emitted byte, and a Node one that
runs `cascade catalog fetch` end to end and greps every file under `.cascade/`,
the pack, and both captured streams.

## Determinism, and what a refetch invalidates

The pack records what it was built from:

```json
"catalog": { "source": "snapshot", "fetchedAt": "…", "serverIdentity": "db:3306/shop", "sha256": "…" }
```

Refetching writes a new `columns.jsonl`, whose sha256 keys the catalog fact
shard. If the **schema did not change**, the catalog digest inside every lineage
shard key is unchanged, so no lineage is recomputed and the pack digest is
identical — a refetch of an unchanged database is free and changes nothing. If
the schema **did** change, the digest moves and exactly the affected lineage is
recomputed.

## Path C — no catalog at all

`catalog.source: "none"` is a supported answer, not a failure. The SQL lane
still runs; the column axis comes back **degraded**, with the reason attached to
every response: a column is attributed only where a statement names it
unambiguously, and what could not be attributed is recorded as unresolved rather
than dropped. `cascade estimate` tells you the size of the gap before you spend
anything on closing it.

## Testing the live path yourself

```bash
cd adapters/sql
../../.venv/bin/python -m unittest test_catalog_live -v            # no DB needed
../../.venv/bin/python -m unittest test_catalog_live_container -v  # needs Docker
```

The container test starts `mysql:8`, loads a small commented schema, reads it
through the live worker and through the DDL worker, and asserts the two agree on
tables, columns, primary keys and comments. Without a Docker daemon it **skips
and prints why** — a live-database test that vanishes silently from a green
suite is how a dialect goes unverified for a year. CI runs it in its own `db`
job (`.github/workflows/ci.yml`).
