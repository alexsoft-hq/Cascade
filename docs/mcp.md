# The MCP server — transports, projects, errors

`cascade mcp` (stdio, for an AI client) and `cascade view` (HTTP, for the local
viewer) are two faces of **one** tool catalog: `src/mcp/catalog.mjs` owns every
tool name, description, input schema and dispatch, and both transports call it.
A test asserts the two produce byte-identical answers for the same call, so a
page and a model can never be told different things.

## Serving one project, or all of them

```bash
cascade mcp                                  # every project in ~/.cascade/registry.json
cascade mcp --project mall --project shop    # only those two
cascade mcp --pack .cascade/pack             # one pack directly (id from the pack meta)
cascade mcp --root ../some/repo              # that repo's .cascade/pack
cascade mcp --memory-budget 256              # MB of pack JSON to keep in memory (default 512)
```

`cascade view` takes the same flags plus `--port`.

Packs are **lazy**: starting the server reads the registry and nothing else. A
pack is parsed on the first call that needs it, and the loaded ones are held in
an LRU under the memory budget. An unbounded cache is what kills a resident
server.

## The `project` argument

Every tool takes an optional `project` string. The rule is deliberately blunt:

| served | call says | result |
|---|---|---|
| one project | nothing | that project answers |
| one project | `project: "<its id>"` | the same |
| several | `project: "<an id>"` | that project answers |
| several | nothing | **`ambiguous`** — the ids are listed, nothing is guessed |
| any | an id nobody serves | **`unknown-key`** — the served ids are listed |

Answering the wrong project confidently is the failure this product exists to
prevent, so there is no "pick the first one" fallback.

Call **`projects`** first when you do not know the ids. It is the one tool that
is not about a pack — it answers from the registry, loads nothing, and reports
the cache (`loaded`, `bytes`, `budgetBytes`, `evictions`, `hits`, `misses`).
Its basis says so: `project: "*"`, `scope: "server"`, no build digest.

```jsonc
// tools/call {"name":"projects","arguments":{}}
{ "answer": {
    "projects": [ { "id": "mall", "dotCascadePath": "/…/mall/.cascade",
                    "stack": ["sql","java"], "lastCertifiedAt": "2026-09-04T…",
                    "loaded": false, "bytes": null } ],
    "cache": { "loaded": 0, "bytes": 0, "budgetBytes": 536870912,
               "evictions": 0, "hits": 0, "misses": 0 } },
  "basis": { "project": "*", "scope": "server", "buildDigest": null,
             "freshness": { "verdict": "unknown" } },
  "trust": { "trustLevel": "UNCERTIFIED", "axes": ["server"],
             "knownGaps": ["server-level-answer", …] },
  "limits": [], "truncated": { "any": false, "fields": [ … ] } }
```

`basis.project` on every answer is the id you addressed — the registry id, not
the name inside the pack (an older `analyze` stamped every pack `"project"`, so
those names can collide across a multi-project server). When the pack declares a
different name of its own, the basis carries it as `packProject` and `overview`
relays it in `answer.pack.project`.

## The tools

`tools/list` is the source of truth — `src/mcp/catalog.mjs` owns the names,
descriptions and input schemas, and `test/docs.test.mjs` fails if this table
falls behind it. Every tool also takes the optional `project` argument described
above.

| tool | the question it answers | arguments (`*` = required) |
|---|---|---|
| `overview` | **Start here.** What is in this pack, how much of it is wired end to end from an HTTP route down to a table, and what the engine could not see | `mode` `depth` |
| `projects` | Which projects does this server serve, and what is in memory? Answers from the registry alone — no pack is loaded | — |
| `search` | Find a table, column or statement by a name substring. Matches names and business comments, **not** source full text | `query*` `limit` |
| `browse` | List one kind (table, column, statement, endpoint, symbol, screen) with the numbers to pick by on each row, for when you have no name yet. `endpoints` per row comes from one per-pack walk at `conservative`/depth 8; `kind=symbol` needs a `query`. `kind=screen` gives `{screen, path, label, title, group, component, source, endpoints, tables, observed}` | `kind*` `query` `table` `sort` `limit` `offset` |
| `column_impact` | If I change this column, which SQL statements read or write it? The statement axis; these edges are `EXACT` | `column*` `mode` `limit` `offset` |
| `endpoint_impact` | If I change this column, which HTTP endpoints are affected? Walks the code axis; each endpoint carries the weakest grade on its path. On a pack with a screen axis every row also carries `screens: {count, sample}` | `column*` `mode` `limit` `offset` |
| `screen_impact` | If I change this column, table, statement or method, which **screens** are affected? The same walk two lanes further out, through the frontend's own calls and the `RENDERS` edge. Each row names the routes it goes through, and `observed` says whether a recording confirms the call | `column` `table` `statement` `symbol` `mode` `limit` `offset` |
| `table_usage` | Which statements touch this table, with access, and per-column read/write counts | `table*` `limit` `offset` |
| `flow` | The chain behind one API call: entry → services → statements → tables, with hops and the walked path. `screen=<router path>` starts at the other end of the round trip (screen → its component functions → the routes they call → services → statements → tables); walking up, a pack with a frontend gains `webFunctions` and `screens` at the far end, and `walk.laneNames` says which lanes the answer has. List mode takes `kind=endpoint` (default) or `kind=screen` | `endpoint` `screen` `symbol` `column` `table` `statement` `direction` `kind` `mode` `depth` `limit` `query` `offset` |
| `transactions` | The `@Transactional` boundaries and each one's atomic read/write footprint | `method` `limit` `offset` |
| `erd` | An ERD recovered from the joins the mapper SQL witnesses — foreign keys are never read | `table` `hops` `limit` |
| `coupling` | Which API group writes what another group reads — the DB sharing no call edge shows | `axis` `mode` `depth` `limit` `offset` |
| `map` | The whole pack as one relation map: groups, endpoints, the tables they reach, and the joins between them | `mode` `depth` `layers` `limit` `maxBytes` |
| `neighborhood` | The graph slice around one focus node, for a visual view | `node` `column` `table` `statement` `endpoint` `symbol` `direction` `hops` `limit` |
| `changed_impact` | The working-tree overlay: I edited these files — what is the blast radius? Re-parses the dirty files on each call. An edited component file also reports `touched.screens`, the screens its functions are drawn on | `files` `mode` `limit` `offset` |

Grades, the `mode` floors, and what `limits` / `truncated` mean are in
[concepts.md](concepts.md).

## HTTP routes

| route | what |
|---|---|
| `GET /api/tools` | the catalog (`tools/list`) |
| `GET /api/projects` | the `projects` tool's answer |
| `POST /api/call` | `{name, arguments, project?}` — one tool call |
| `GET /api/meta` | the served project's pack metadata (`?project=`) |
| `GET /api/source` | one node's source, read from the working tree: the snippet, the absolute path, the 1-based line range it cut and the file's length (`?node=`, `?project=`, `?whole=1` for the whole file instead of the snippet) |
| `GET /vendor/<file>` | the two vendored MIT browser bundles the graph pictures render with |
| `GET /i18n/<lang>.json` | one interface-language catalogue (English is compiled into the page) |

`/vendor` and `/i18n` are allowlisted shelves, not file servers: one directory,
one set of extensions, and every way out of the directory is a 404.

`GET /api/projects` is lazy — it reads the registry and loads no pack. Each
listed project carries `meta` (digest, build time, lanes, axes, freshness) only
once that project has actually answered something; `null` means "not loaded",
never "nothing to say".

`project` is accepted as a query parameter on the GET routes and as either
`body.project` or `body.arguments.project` on `/api/call`; it is stripped
before the tool sees the arguments.

The viewer page shows **one** project at a time and carries a selector for it;
the choice rides in the URL hash (`#p=<id>&tab=<name>`), and `?project=<id>` is
still honoured. A single-project server needs neither. See
[viewer.md](viewer.md).

## Errors

One uniform model, kept apart by kind: input mistakes, data that cannot be
served, and server defects. Over HTTP they are JSON, never HTML:

| code | HTTP | means |
|---|---|---|
| `bad-input`, `bad-request`, `unknown-tool` | 400 | the call is wrong |
| `unknown-key`, `unknown-column`, `unknown-table`, … | 404 | no such thing here |
| `ambiguous` | 409 | say which project |
| `pack-unreadable` | 503 | the pack cannot be read, or does not fit the budget |
| `contract-violation` | 500 | the server built an invalid response — a bug |

Over stdio the same failure is a `tools/call` **result** with `isError: true`
and the text `error [<code>]: <message>` (a tool failure is not a JSON-RPC
error — the model is meant to read it and choose another path).

## The memory budget

`--memory-budget <MB>` bounds the **pack JSON** held in memory: per project,
the pack file's size plus its fact index's text length. That is a proxy, not a
heap measurement — Node cannot price a live object graph, and measuring the
real thing would mean loading the pack the budget is meant to refuse.

Re-measured on two packs, with two independent tools that agree:

| pack | proxy | resident graph | ratio |
|---|---|---|---|
| mall (12 674 nodes / 19 268 edges) | 10.0 MB | 18.1 MB | **1.8x** |
| synthetic 400 tables / 3 800 endpoints (61 980 / 105 068) | 47.6 MB | 94.1 MB | **2.0x** |

"Resident" is what the server actually HOLDS — the Graph. The file text and the
parsed JSON are released once the graph exists; while all three are alive the
load transiently costs about **4x** the proxy, which is the number to size a
machine by, not the one to size the cache by. (The older 2.3x in this document
was measured on a 2.8 MB / 3 941-node mall pack that no longer exists.)

So a 512 MB budget is roughly 1 GB of resident graph on this evidence, with a
higher transient peak while a pack loads — divide by the ratio you measure if
what you must bound is RSS. Re-measure on your own pack with either of:

```bash
node --expose-gc scripts/measure-host-memory.mjs --copies 5 --budget 8
node --expose-gc scripts/measure-pack-cost.mjs --pack <pack.json>
```

A pack that does not fit the budget **alone** is refused outright
(`pack-unreadable`, naming both numbers) rather than half-loaded. Eviction is
least-recently-used, logs one line per eviction to stderr, and is counted in
`projects`' `cache.evictions`.
