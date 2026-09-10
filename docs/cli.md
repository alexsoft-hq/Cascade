# The CLI — every command and every flag

`cascade` is a thin shell over `src/core` and `src/mcp`. Run it as
`node bin/cascade.mjs <command>` from the engine root (or as `cascade` once the
`bin` entry is on your PATH).

Running it with no command prints the usage text. **That text is the source of
truth for this page**: `test/docs.test.mjs` runs the binary, reads the commands
and flags out of what it printed, and fails if any of them is missing here.

`cascade <command> --help` (or `-h`) prints just that command's section and
exits 0, before any other flag on the line is read and before anything is
resolved, discovered or written.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | the command did what it was asked |
| `1` | `doctor` only — a required prerequisite is missing |
| `2` | bad usage, or an input the command refuses (this is what `die()` exits with) |
| `3` | `analyze` only — the calibration gate judged the run a regression. The pack is written to `<packDir>-rejected/` and the certified pack is left untouched |
| `4` | `verify` only — a digest, the engine identity, or the expiry disagreed |

## Finding the project

Four commands (`analyze`, `mcp`, `view`, `impact`, and also `verify`,
`estimate`, `golden`) locate a project the same way, in this order:

```
--pack <dir>      an explicit pack directory
--project <id>    looked up in ~/.cascade/registry.json (written by `init`)
--root <dir>      that directory's .cascade/
(nothing)         the current directory's .cascade/
```

An unknown `--project` lists the ids that *are* registered rather than guessing
one.

---

## `cascade setup`

```
cascade setup [--force] [--home]
```

Build the SQL lane's Python and install its pinned requirements, in one
command, so reading a setup page is not what stands between you and your first
answer. It finds a `python3`, creates a virtual environment where a run will
look for one, installs `adapters/sql/requirements.txt`, and then **proves** it
by importing `sqlglot` with the interpreter a run will actually use rather than
trusting that `pip` said ok. Nothing outside that environment is touched.

Where it builds:

| you are in | it builds |
|---|---|
| a checkout of this repository (there is a `.git`) | `<engine>/.venv`, the path the setup pages and CI already name |
| anything else, or `--home` | `<cascade home>/venv`, which survives an upgrade that replaces the package directory |

- `--force` — remove an existing environment and build it again. Also the cure
  when one exists but cannot import `sqlglot`.
- `--home` — build in the tool home even inside a checkout.

A run looks for the interpreter in three places, in this order: `CASCADE_PYTHON`
when you set it, then the checkout's own `.venv`, then the tool home. Whichever
is found first is the one every command uses, and `cascade doctor` prints which
one that is. If you already have an interpreter with `sqlglot` in it, point
`CASCADE_PYTHON` at it and skip this command entirely.

The Java lane's JDK is not something this command can supply: a JDK is not a
Python package. `cascade doctor` names the directories it looked in.

## `cascade doctor`

```
cascade doctor [--json]
```

Pre-flight every prerequisite at once instead of discovering them
one error at a time: Node's version, `git`, the SQL lane's venv and `sqlglot`,
a JDK — naming which candidate directory won and why each of the others did not
— the three optional DB drivers, Docker, the registry file and the cache
directory. Each line carries a status (`ok` / `warn` / `missing`) and, when it
is not ok, the remedy.

- `--json` — the whole report as `cascade:doctor:1` instead of the table.

Exit `0` only when every **required** prerequisite is ok. The optional lines
(DB drivers, Docker) are reported and never fatal.

## `cascade init`

```
cascade init [--root <dir>] [--project <id>] [--force] [--json]
```

Discover what is in a tree and write the project's own state: `.cascade/manifest.json`
(repositories pinned to full commits), `.cascade/profile.json` (the reading
convention), `.cascade/.gitignore` (which ignores `pack/` and `catalog/`,
because they carry your SQL and your column comments), and an entry in
`~/.cascade/registry.json`.

It reports what it found — java/mapper/DDL counts, build tool, package
prefixes, the mapper directories and Java source roots the lanes will read — and
**what it has no lane for**: Kotlin sources and frontend packages come back as
`UNSUPPORTED_TECHNOLOGY` diagnostics rather than being silently ignored.

It also reads what the project says about ITSELF, out of its own Spring
configuration under `resources`:

```
service name: edge-service (from src/main/resources/application.yml)
gateway routes: 4 read from src/main/resources/application.yml
  /api/order -> / at orders-service
```

The name goes to `profile.serviceNames` (it is how two projects serving the same
path are told apart when one calls the other), the routes to
`profile.gatewayRoutes`. Both are written only into a profile that has none of
its own: a map you typed is yours, and a re-run with `--force` says how many
routes it found and did not apply. See
[the web lane](setup/web-lane.md#gateway-routes-you-do-not-have-to-type).

A **frontend with no `package.json`** gets a line of its own, and the way to
switch it off is in the same sentence:

```
frontend without a package: reading src/main/resources/static/scripts (22 file(s), router angular-router). Set webRoots to [] in the profile to stop
```

That is a directory of frontend sources with no manifest above them that the
tree says is served: under `static`, `public`, `webapp`, `www` or
`resources/templates`, or named by an `index.html` beside it. It goes to
`profile.webRoots`, which `cascade analyze` then reads with no flag. Like the
two keys above, a list already in the profile is yours, an empty one included.
See [the web lane](setup/web-lane.md#a-frontend-with-no-packagejson).

A **server-rendered application** gets one too. Where a view name becomes a
page, with the engine that renders it and the suffix the resolver appends:

```
template roots: 1 (config) src/main/resources/templates freemarker .ftl
```

It goes to `profile.templateRoots`, which `cascade analyze` then reads with no
flag, and the same rule holds: a list already in the profile is yours, an empty
one included. `analyze` prints the roots it will read before any lane starts:

```
template roots 1 (profile): src/main/resources/templates freemarker .ftl
```

See [the web lane](setup/web-lane.md#server-rendered-pages).

- `--root <dir>` — the tree to discover (default: the current directory).
- `--project <id>` — the id to register it under (default: derived from the
  directory name).
- `--force` — overwrite an existing manifest/profile. Without it, a second run
  keeps your edits.
- `--json` — the whole discovery report as JSON.

## `cascade agent`

```
cascade agent [--client claude-code|cursor|codex|all] [--write]
              [--project <id>] [--root <dir>]
```

Put the MCP server **and the rule that gets it used** into a project, in one
command. The configuration is the easy half: an absolute path to
`bin/cascade.mjs`, the project id out of the registry, one JSON shape per
client. The rule is the half that gets forgotten, and it is the one that
matters. An agent with the server attached and nothing telling it *when* to ask
edits a mapper without a question, because nothing in its context says a
question is due.

The project is the one registered for `--root` (default: the current
directory), found by comparing the real path of `<root>/.cascade` against the
registry, or the one `--project <id>` names, whose root then comes from its
manifest. A root nothing is registered for exits `2` and names `cascade init`.
No pack is needed: wiring the agent up before the first `analyze` is a normal
thing to do.

What each client gets:

| `--client` | MCP config | rules |
|---|---|---|
| `claude-code` (default) | `<root>/.mcp.json`, key `mcpServers.cascade` | `<root>/CLAUDE.md`, a managed block |
| `cursor` | `<root>/.cursor/mcp.json`, key `mcpServers.cascade` | `<root>/.cursor/rules/cascade.mdc`, the whole file, `alwaysApply: true` |
| `codex` | not written: a `[mcp_servers.cascade]` TOML block is **printed** for `~/.codex/config.toml` | `<root>/AGENTS.md`, a managed block |
| `all` | the three above | |

- `--client <name>` — one of `claude-code`, `cursor`, `codex`, or `all`
  (default: `claude-code`).
- `--write` — write the files. Without it the command prints every file it
  would write, each under a `--- <relative path> ---` header, with the exact
  content, and touches nothing.
- `--project <id>` — the registered project to configure, instead of the one at
  `--root`.
- `--root <dir>` — the project directory to write into (default: the current
  directory).

**The command in the config is always absolute**: `command` is the running
`node` binary and the first argument is the real path of `bin/cascade.mjs`,
resolved through the symlink a global install leaves behind. A client starts the
server from a working directory you do not control, and a relative path there is
the single most common reason a client reports the server as failed.

**How the merge works.** A JSON config is read, parsed, and given the one key:
every other key and every other server stays where it was, and the file is
written back with a two-space indent and a trailing newline. A file that exists
and does **not** parse is not touched at all. The command exits `2` naming it,
with nothing written, because a tool that overwrites what it could not read has
thrown away work it never looked at.

The rules block sits between `<!-- cascade:begin -->` and `<!-- cascade:end -->`
on their own lines. A file that has the block gets it replaced **in place**, so
your own text above and below it survives. A file without it gets the block
after one blank line, and a file that does not exist is created holding only the
block. Running the command twice is byte-identical the second time, and the
`unchanged` line says so.

With `--write`, each file is reported as `created`, `updated` or `unchanged`.

**Claude Code needs one approval.** A server that arrives in a project
`.mcp.json` sits at *Pending approval* until you run `claude` in that directory
once and approve `cascade` when it asks, and `claude mcp get cascade` prints
that state.

## `cascade analyze`

```
cascade analyze [--root <repo>] [--out <dir>] [--profile <f>]
                [--cold | --incremental] [--accept-baseline]
                [--ddl <schema.sql|glob>... | --no-ddl]
                [--mappers <dir>... | --no-mappers]
                [--java-src <dir>... | --no-java]
                [--web-src <dir>... | --no-web]
                [--openapi <file>... | --no-openapi]
                [--har <file>...]
```

Run the lanes end to end and write a content-addressed pack
(`<packDir>/pack.json`). **With no lane flag the inputs come from the project
itself** — the DDL from the profile's `catalog.connectionFrom` (one path or an
ordered list) or, failing that, from the classification below; the mapper
directories and Java source roots from discovery — and the run prints which lane
got what, and from where.

Every lane input is optional and a missing axis is **declared, not fatal**: the
pack records `meta.axes` with `shipped` / `degraded` / `not-shipped` and why.

Beside the pack the run also writes **`routes.json`**, a small sorted index of
what this project serves and what it calls and does not serve, and prints one
line for it (`routes index: 8 served, 0 outbound`). A server that holds several
projects reads those sidecars to join one project's outbound call to another
project's route (see [mcp.md](mcp.md)); nothing else reads it, and it is derived
from the pack rather than an input to it, so the pack digest is unchanged by it.

A run is **incremental** whenever a previous `facts-index.json` and its shards
both apply; otherwise it is cold **and says why**.

- `--root <repo>` — the tree to analyze (default: the current directory).
- `--out <dir>` — where the pack goes (default: the resolved `.cascade/pack`).
- `--profile <f>` — a profile file other than `<dotCascade>/profile.json`.
- `--cold` — recompute everything.
- `--incremental` — ask for an incremental run. One that cannot be incremental
  still runs, and still says why it could not.
- `--accept-baseline` — re-seal the calibration baseline **from this run**. The
  one override there is, and a human decision.
- `--ddl <schema.sql|glob>` — a DDL file the catalog is parsed from. **Repeatable,
  and each value may be a glob** (`*` inside a path segment, `**` across them):
  a schema split one file per service is `--ddl a.sql --ddl b.sql --ddl c.sql`
  or `--ddl 'svc-*/db/mysql/schema.sql'`. The files are applied **in the order
  given**, so a base schema followed by its migrations reads as the history it
  is: `CREATE TABLE` declares, `ALTER TABLE ADD/DROP/MODIFY/CHANGE COLUMN` and
  `RENAME TABLE` amend, and two files declaring the same table are reported
  (`DUPLICATE_TABLE_DECLARATION`) with the first kept, never merged.

  With no `--ddl` at all, discovery classifies every `.sql` it found by
  **dialect** (from the path — `db/mysql/…`, `schema_h2.sql` — and otherwise from
  spellings only one database has) and by **role** (`schema` when it declares
  tables, `migration` when it changes more than it declares or sits under a
  `flyway`/`liquibase`/`migration`/`upgrade`/`patch` path). The default is every
  `schema` file of the project's dialect, in path order; migrations and files
  under `src/test/` are **not** applied. Every file is printed with the reason it
  was applied or left out, and naming one with `--ddl` overrides the lot.
- `--no-ddl` — run with no DB catalog at all (the column axis then declares
  itself degraded). It overrides `--ddl`, the profile and the classification.
- `--mappers <dir>` — a MyBatis mapper directory; repeat for several.
- `--no-mappers` — no SQL statements (a schema with nothing over it).
- `--java-src <dir>` — a Java source root; repeat for several. An unflagged run
  reads **main** sources only and prints the `src/test` roots it skipped;
  passing one here includes it.
- `--no-java` — a SQL-only pack.
- `--web-src <dir>` — a frontend source root; repeat for several. An unflagged
  run reads the roots discovery found, but only when the profile declares the
  `web` framework pack. The lane traces every HTTP call to the client that sends
  it, derives the prefix that client goes through, matches the URL against the
  routes this pack knows, and adds a graded `CALLS_HTTP` edge from the frontend
  function to the endpoint. The `web` axis says what had to be guessed. Its facts
  are cached per file, so a second run re-reads only what changed.
  See [the web lane setup page](setup/web-lane.md).
- `--no-web` — do not read the frontend even when the profile declares it.
- `--openapi <file>` — an OpenAPI 3 or Swagger 2 document, JSON or YAML; repeat
  for several. Every `(method, path)` it declares becomes an endpoint with the
  same id the Java lane would give it: a route the code also serves is
  **corroborated** (the node gains `declaredBy`, and the `operationId` and
  `summary` when the document carries them), and a route nothing here serves is
  added with **no handler edge**, because a declaration says a route exists and
  says nothing about what runs below it. The two drift lists — declared and not
  served, served and not declared — are on `meta.laneStats.openapi` and in the
  overview's `openapi-drift` gap. With no flag, the documents come from the
  profile's `openapi.documents`, and failing that from discovery.
- `--no-openapi` — read no document even when the profile or discovery names one.
- `--har <file>` — a browser recording (HAR 1.2, what Chrome DevTools saves from
  the Network panel); repeat for several. Every request in it whose path matches
  a route this pack serves becomes a `screen --CALLS_HTTP--> endpoint` edge
  graded **RUNTIME_ONLY**, which is below every query mode's floor: it is
  **shown** (`observed: true` on the screen, the route and every row that names
  them) and **never walked**. A recording never raises a grade and never
  replaces the static reading; where a page it saw matches no screen the source
  declares, a screen is added with `source: "har"` and no `RENDERS` edge.
  Requests that match no route are counted by path, static assets are counted
  apart, and neither is dropped. With no flag the recordings come from the
  profile's `runtimeEvidence.har` (manifest-relative). **There is no discovery
  step**: a recording is something you made on purpose, and picking one up
  because it happens to be in the tree would let an unrelated capture decide what
  this pack claims was observed. See [the web lane setup page](setup/web-lane.md).
- `--otel <file>` — an OpenTelemetry trace export (OTLP/JSON, the `resourceSpans`
  shape); repeat for several. A trace says which **concrete implementation**
  handled a request and which statement it ran, which is the one thing no
  reading of the source can decide. Where the trace confirms a hop this analysis
  already had, that edge keeps its grade and gains `observed: true` with a count
  beside it, so a candidate set the code could only grade `SOUND_SET` now names
  the member that really ran **without being promoted**. A candidate the trace
  did not visit is left exactly where it was: absence of observation is not
  absence of the path. A hop the trace saw and no static rule explains becomes a
  `MAY_CALL` edge graded **RUNTIME_ONLY**, which is below every query mode's
  floor, so it is shown and never walked. No SQL text and no bound parameter
  enters the pack: a statement's SQL is read for the **table names** it touched
  and then dropped. With no flag the traces come from the profile's
  `runtimeEvidence.otel` (manifest-relative), and **there is no discovery step**,
  for the same reason recordings have none. See
  [the runtime evidence page](setup/runtime-evidence.md).

Each `--no-<lane>` overrides whatever the manifest, profile or discovery would
otherwise have supplied, so "run without this" is always expressible.

`--otel` reads **either** an OTLP/JSON document **or** the application log the
OpenTelemetry Java agent writes with `-Dotel.traces.exporter=logging-otlp`: one
export per line, behind the logger's own prefix. Which one it is is decided by
reading the file, never by its extension, and a line the reader cannot use is
skipped and counted rather than fatal. A log is reported as one:

```
Runtime evidence: app.log was read as an agent log, one export per line: 169 span(s) in it, 54 line(s) carried none
```

## `cascade otel-methods`

```
cascade otel-methods [--pack <dir> | --project <id> | --root <dir>] [--json]
```

Print the `otel.instrumentation.methods.include` value this pack needs, so the
OpenTelemetry Java agent emits the method spans the **dispatch** join reads.

Out of the box the agent writes HTTP server spans, repository spans and JDBC
spans, so a first capture observes routes and statements and reports **dispatch
0**: no controller and no service method has a span, so no method span ever
nests inside another one. The agent can add them, and it wants **explicit
method names** — `pkg.Class[m1,m2]`. A wildcard is not a name: `pkg.Class[*]`
matches nothing and the next capture is as empty as the first.

What goes on the list is read off the pack: every **route handler** (a `HANDLES`
target) and every symbol that **reaches a statement** (the method that
implements one, and everything with a `MAY_CALL` path down to it). A symbol
marked external is left off, because a library method is not yours to
instrument.

```
$ cascade otel-methods --project petclinic
org.springframework.samples.petclinic.owner.OwnerController[findOwner,findPaginatedForOwnersLastName,…];org.springframework.samples.petclinic.owner.OwnerRepository[findById,…];…
32 method(s) in 10 class(es): 17 route handler(s) and 24 method(s) that reach a statement. …
```

The **value goes to stdout on its own**, so it can be pasted or piped; the count
and the instruction go to stderr, where they cannot get into a pipe. Classes are
sorted and so are the methods inside each one, so the same pack prints the same
line every time.

- `--pack` / `--project` / `--root` — which pack (see *Finding the project*).
- `--json` — the same list as `{ "pkg.Class": ["m1", "m2"] }`.

The recipe this belongs to is on
[the runtime evidence page](setup/runtime-evidence.md).

## `cascade estimate`

```
cascade estimate [--root <dir>] [--project <id>] [--json]
```

What this tree will ship, degrade, or not ship — **before** you analyze it. Once
a pack exists it also reports the measured share of questions that can be
answered `EXACT`.

**Which tree it reads** is decided exactly as `analyze` decides it, and the
banner says which rule won: `--root` always, then the registered project's own
source (its manifest's single repository, or the workspace holding several),
then the current directory when nothing resolved. So `estimate --project mall`
from anywhere describes mall, not the directory your shell happens to be in.

```
estimate for /path/to/mall (the registered project's manifest), project mall
```

- `--root <dir>` / `--project <id>` — which project (see *Finding the project*).
- `--json` — the raw estimate object.

## `cascade verify`

```
cascade verify [--pack <dir> | --project <id> | --root <dir>] [--json]
```

Recompute every digest in `.cascade/receipt.json` from the files on disk, check
the running engine against the one that signed the receipt, and refuse an
expired receipt. Exit `4` on any disagreement — never a partial pass.

- `--pack` / `--project` / `--root` — which project.
- `--json` — the verification result as JSON.

## `cascade golden`

```
cascade golden <propose|approve|seal|check> [--pack <dir> | --project <id> | --root <dir>]
               [--per-relation N] [--from-otel <trace file>] [--ids <id>…] [--all] [--json]
```

The project's golden corpus. The split is the point: **the tool
proposes, a human approves**.

- `propose` — suggest candidate cases from the current pack. Writes candidates
  and nothing else.
- `propose --from-otel <trace>` — propose cases from an **OpenTelemetry trace**
  instead. Repeatable, and the file may be an OTLP/JSON document or the Java
  agent's own log.
- `approve` — make candidates evidence. Requires `--ids <id>…` or an explicit
  `--all`; the tool never approves itself.
- `seal` — hash the approved set, deciding which cases are held out.
- `check` — score the approved cases through the shipped MCP tools.

Flags: `--per-relation N`, `--from-otel <file>`, `--ids <id>…`, `--all`,
`--json`, plus `--pack` / `--project` / `--root`.

### Cases from a run

A proposal sampled from the pack is right by construction: the engine wrote both
the question and the answer, so it proves nothing until somebody reads it. That
is why almost nobody ever does, and why almost every project is `UNCERTIFIED`.

`--from-otel` breaks that loop by taking the labels from somewhere else: the
running program. For every route the trace exercised, the case says the tables of
every statement that ran under that request; for every method that ran SQL, it
says the statement the pack keys by that method. A route or a method this pack
does not know stays out and is counted in one line, so nothing is invented.

Two things follow from what execution can and cannot witness, and both are on
the case itself (`source: "runtime"`):

- **Positives only.** A run proves REACH, never absence, so a runtime case
  carries no `absent` ids and scores **recall** alone. It can show the answer
  covered what ran; it can never show precision.
- **A route that ran no statement asserts nothing**, and that is scored one way
  only: `PASS` where the pack answers no table either (two independent sources
  agreeing that this route reads nothing), and `UNSCORABLE` where the pack answers
  tables the run never touched, because the request may not have taken that
  branch. `check` prints how many cases of each relation assert nothing and how
  many could not be scored, and only the scored ones count towards covering a
  relation's population.
- **`--all` is the expected path here.** A human still stamps the approval, but
  what they are agreeing to is that the recording is a fair one, not that the
  analyzer was right. Reading each case one at a time buys nothing, because the
  engine did not write these labels.

`cascade otel-methods` prints the instrument list a Java agent needs before a
trace can see method spans at all; `docs/setup/runtime-evidence.md` is the whole
capture story.

## `cascade catalog discover`

```
cascade catalog discover [--project <id>|--root <dir>] [--json]
```

List the datasource configuration a tree carries — host, port, database,
dialect, and **whether** a password is there. No password value is read,
printed or stored, and **nothing is connected to**.

- `--root <dir>` — the tree to read.
- `--json` — the candidates as JSON.

## `cascade catalog fetch`

```
cascade catalog fetch [--project <id> | --root <dir>]
                      [--candidate <n> | --url <jdbc url> --user <u>
                       | --dialect <d> --host <h> [--port <p>] --database <db> --user <u>]
                      [--password-env NAME] [--schema NAME] [--stamp-schema NAME] [--yes]
```

Pin a **read-only** catalog snapshot into `.cascade/catalog/`, then write
`catalog.source: "jdbc"` into the profile so the next `analyze` reads it.

It prints the exact target first and **asks `y/N` in a terminal**; outside one
(a script, CI, a pipe) it **refuses without `--yes`**. The confirmation stays
because the connection info came out of the analyzed repository, which is
untrusted input, and a saved password for that host does not make the host
trustworthy.

The password is looked up in this order, and is never a command-line argument
(`ps` would show it):

1. the variable named by `--password-env NAME`;
2. the environment variable `CASCADE_DB_PASSWORD`;
3. the entry for this server and user in `$CASCADE_HOME/credentials`
   (see [`cascade catalog credentials`](#cascade-catalog-credentials));
4. a hidden prompt, when a terminal is attached, which offers once to save what
   you typed (default **No**).

Analysis itself never connects; it reads the pinned snapshot, so a pack stays
reproducible against a database that keeps moving.

- `--candidate <n>` — one of the candidates `catalog discover` listed.
- `--url <jdbc url>` `--user <u>` — or name the target by URL.
- `--dialect <d>` `--host <h>` `--port <p>` `--database <db>` `--user <u>` — or
  spell it out.
- `--password-env NAME` — the environment variable holding the password.
- `--schema NAME` — the schema to read.
- `--stamp-schema NAME` — the schema name to stamp on the records.
- `--yes` — confirm the exact target without being asked. Required outside a
  terminal; nothing connects without it there.
- `--project` / `--root` — which project the snapshot belongs to.

## `cascade catalog credentials`

```
cascade catalog credentials list
cascade catalog credentials set    --url <jdbc url> --user <u> [--password-env NAME]
cascade catalog credentials remove --url <jdbc url> --user <u>
```

The passwords `catalog fetch` may use. They live in `$CASCADE_HOME/credentials`
(`~/.cascade/credentials` by default) as one JSON object per line, keyed by
server and user, at **mode 0600** — the same shape and the same rule as
`~/.pgpass`. A file that group or others can read is **refused**, with the
`chmod 600` to run: a password anyone on the machine can open is not a secret.

The file is never written under a project tree. If `CASCADE_HOME` resolves
inside the project being analyzed, the command refuses and says why.

- `list` — the servers and users held. **Never a password.**
- `set` — store one. The password comes from `--password-env NAME`, else from
  `CASCADE_DB_PASSWORD`, else from a hidden prompt in a terminal.
- `remove` — delete exactly one entry.
- `--dialect <d>` `--host <h>` `--port <p>` `--database <db>` `--user <u>` —
  name the same target field by field instead of as a URL.

## `cascade pack`

```
cascade pack --catalog <f> --lineage <f> --out <dir> [--project NAME]
```

Build a pack directly from SQL-lane outputs (catalog + lineage JSONL) — the low
level under `analyze`, useful when you have run the workers yourself.

- `--catalog <f>` — the catalog JSONL.
- `--lineage <f>` — the lineage JSONL.
- `--out <dir>` — where `pack.json` is written.
- `--project NAME` — the project name stamped in the pack meta.

## `cascade mcp`

```
cascade mcp [--pack <dir> | --project <id> ... | --root <dir>] [--memory-budget <MB>]
```

Serve the tool catalog over **stdio** as an MCP server. With no
`--pack`/`--root`/`--project` it serves **every** registered project, lazily: a
pack is parsed on the first call that needs it, and the loaded ones are held in
an LRU under the memory budget.

Each tool takes an optional `project` argument; on a multi-project server a call
without one is answered `ambiguous`, listing the ids. Nothing is guessed. See
[mcp.md](mcp.md).

- `--project <id>` — repeat to narrow the served set.
- `--pack <dir>` / `--root <dir>` — serve one pack.
- `--memory-budget <MB>` — MB of pack JSON held in memory (default 512).

## `cascade impact`

```
cascade impact [--pack <dir> | --project <id> | --root <dir>] [--file <path>...]
               [--verbose] [--mode strict|conservative|heuristic|base-only]
```

The edit loop, from the shell: what did my uncommitted edits touch? By default
the dirty files (the working-tree diff against the commit the pack was built
from, plus untracked ones) are **re-parsed on every call**, so the answer
describes the bytes on disk rather than the last analysis. Nothing is written —
not the pack, not the fact cache.

- `--file <path>` — restrict the question to these files; repeat for several.
- `--verbose` — also print the reused shard count, the dirty document hashes and
  the files that were parsed.
- `--mode strict|conservative|heuristic` — which edge grades the walk may use.
- `--mode base-only` — answer from the pack alone: what these files touched as
  they were **last analyzed**, labelled as such.
- `--pack` / `--project` / `--root` — which project.

A row marked `PROVISIONAL` exists only in the overlay — no certified run has
seen it. After a commit the overlay is discarded and the answer is `behind`,
naming `cascade analyze` as the cure.

## `cascade view`

```
cascade view [--pack <dir> | --project <id> ... | --root <dir>] [--port 4319] [--memory-budget <MB>]
```

Serve the local web viewer over HTTP on `127.0.0.1`. Same project selection as
`mcp`; the page shows one project at a time — open it with `?project=<id>` when
the server serves several. See [viewer.md](viewer.md).

- `--port 4319` — the port to bind (default 4319).
- `--project <id>` — repeat to narrow the served set.
- `--pack <dir>` / `--root <dir>` — serve one pack.
- `--memory-budget <MB>` — MB of pack JSON held in memory (default 512).
