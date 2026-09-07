# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/cascade-mark-dark.svg"><img src="assets/cascade-mark.svg" width="28" alt=""></picture> Cascade

A code-to-column change-impact knowledge graph for AI coding agents, and for the
people who work beside them. Apache-2.0.

[English README](../README.md) | [한국어 README](../README.ko.md)

![The Cascade viewer's Overview tab: five dials reading endpoints that reach
SQL, statements, tables and columns reached, and screens that reach a table,
with the whole-project map underneath](assets/screens/overview.png)

## The round trip

The thing a shallow code index does not give you is the walk in both
directions, end to end:

```
screen → frontend function → endpoint → service → mapper/ORM → SQL → table → column
column ← SQL ← mapper ← service ← endpoint ← frontend function ← screen
```

Three lanes produce it. The **SQL lane** (Python and sqlglot) turns a DDL file
or a pinned catalog snapshot into a schema, MyBatis XML into parseable
statements, and those statements into table and column reads and writes. The
**Java lane** (the JDK's own parser, with no Gradle, no Maven and no dependency
classpath) stitches `endpoint → controller → service → mapper` onto them,
including persistence declared by `@Entity` or Spring Data rather than written
as SQL. The **web lane** (a vendored parser, no install) reads the code above
the endpoint: the frontend calls, and the router declarations that become
screens.

## The honesty contract

Every answer carries four fields, and they are checked before the response is
serialised: a route that assembles a look-alike by hand dies in
`assertContract()` rather than shipping.

- **basis** is what commit and which pack digest the answer is based on, and
  whether that is `current`, `behind`, `provisional-overlay` or `unknown`.
  `unknown` never reads as "current".
- **trust** is a **computed** level (`UNCERTIFIED`, `GOLDEN_FAIL`,
  `GOLDEN_PASS`), never a typed-in one. With no golden corpus, the level is
  `UNCERTIFIED`.
- **limits** is what the engine could not see, in words, scoped.
- **truncated** is how much of each list was cut, and the true total.

An empty list says *why* it is empty: `not-shipped` (the axis was never built),
`degraded` (built without something it needed), or `none` (looked, found
nothing). Those are three different answers and they do not collapse into `[]`.

### What it does not claim

Not a SAST or CodeQL replacement. Not "complete" impact. Not "safe refactoring
guaranteed". Not language-agnostic, not 100% accurate. It publishes measured
lower bounds; it cannot honestly claim any of those.

## Quickstart

Prerequisites, and one command that tells you which of them you are missing:

```bash
node bin/cascade.mjs setup     # the SQL lane: builds its python and installs the pinned sqlglot
# plus a JDK 17+ for the Java lane (`brew install openjdk`; set JAVA_HOME)
# the web lane needs nothing: its parser is vendored

node bin/cascade.mjs doctor        # every prerequisite, its state, the remedy
```

Then, over any Spring with MyBatis or JPA tree:

```bash
# 1. what is in this tree? -> .cascade/{manifest.json,profile.json} + the registry
node bin/cascade.mjs init --root <repo> --project <id>

# 2. run the lanes -> a content-addressed pack. No lane flags: the inputs come
#    from the manifest, the profile and discovery.
node bin/cascade.mjs analyze --root <repo>

# 3. what can it answer, and what will it not? (before or after the analysis)
node bin/cascade.mjs estimate --root <repo>

# 4. serve it to an AI client over stdio...
node bin/cascade.mjs mcp --project <id>

# 5. ...or look at it yourself
node bin/cascade.mjs view --project <id>     # http://127.0.0.1:4319/
```

Two questions to start with:

```jsonc
{"name": "column_impact",   "arguments": {"column": "pms_product.price"}}  // → statements
{"name": "endpoint_impact", "arguments": {"column": "pms_product.price"}}  // → HTTP endpoints
```

The README walks the same path with real output at every step, then wires the
server into an AI client and reads the answers:
[ten minutes on your own project](../README.md#ten-minutes-on-your-own-project),
[set it up for your AI agent](../README.md#set-it-up-for-your-ai-agent),
[the edit loop](../README.md#the-edit-loop).

## The pages

| Page | What is on it |
|---|---|
| [concepts.md](concepts.md) | grades, the four contract fields, the two speeds, partial packs, calibration |
| [cli.md](cli.md) | every command and every flag, checked against the binary by a test |
| [mcp.md](mcp.md) | the tool catalog, the `project` argument, both transports, the error table |
| [viewer.md](viewer.md) | the local web viewer: tabs, deep links, the language toggle |
| [measured.md](measured.md) | the generality gate's corpus table, the goldens, and what is **not** verified |
| [setup/agents.md](setup/agents.md) | the MCP client configurations in full: Claude Code, Claude Desktop, Cursor, a generic stdio client |
| [setup/sql-lane.md](setup/sql-lane.md) | Python and sqlglot, the dialects, and where the DDL comes from |
| [setup/java-lane.md](setup/java-lane.md) | the JDK, what the lane resolves, and what it does not; JPA and MyBatis-Plus |
| [setup/web-lane.md](setup/web-lane.md) | the frontend lane: the vendored parser, wrappers, prefixes, screens, OpenAPI, recordings |
| [setup/db-catalog.md](setup/db-catalog.md) | the three ways to get column comments, and what each costs |
| [ko/index.md](ko/index.md) | the Korean pages |

Contributing: [CONTRIBUTING.md](../CONTRIBUTING.md).
Security: [SECURITY.md](../SECURITY.md).
Changes: [CHANGELOG.md](../CHANGELOG.md).
