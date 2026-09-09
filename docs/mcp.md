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
                    "loaded": false, "bytes": null,
                    "federation": { "index": "present", "serves": 214, "calls": 3 } } ],
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

## Federation — one answer across several projects

One repository per microservice is the normal shape, and each one analyzes into
its own pack. A pack knows that its code sends `GET /owners/{ownerId}`
somewhere and stops there: the route it calls is not a route it serves, so the
lane put an outbound endpoint node in the graph and an `UNRESOLVED CALLS_HTTP`
edge onto it, which is below every mode's floor.

When another project **this same server serves** answers that route, `flow` and
`endpoint_impact` keep walking there. Nothing is added to any pack: the join is
made at query time.

**How a route is matched.** `analyze` writes `routes.json` beside `pack.json`:
what this project serves, what it calls and does not serve, and the service
names it answers to. The server reads those sidecars, never the packs, so it
can answer "who serves this?" for twenty projects without parsing one of them.
A sibling's pack is loaded only when the answer really crosses into it, through
the same LRU and the same memory budget as any other project.

**Where the names come from.** `serviceNames` is `profile.serviceNames`, which
`cascade init` writes from `spring.application.name` in the project's own
`application.yml`. When the profile declares none, `analyze` uses the names its
OWN run read out of the tree, so a project analyzed before anybody re-ran `init`
still answers to its real name, and the run says the name is not recorded yet
and how to record it. The profile always wins when it has one, and neither
choice touches the pack: the name rides beside it in the sidecar, so the digest
is the same either way. A project that declares no name anywhere is still
matched by its project id.

The name ON A CALL comes from the evidence the lane recorded: the host a Java
client wrote (a `lb://`-style service name in the url), the service a declared
or discovered gateway route forwards to, or nothing at all, in which case only
the path and the method are left to match on.

| the call matches | what happens |
|---|---|
| one project | crossed, `SOUND_SET` (`HEURISTIC` when either side's method is `ANY`) |
| several, and the call's service name picks exactly one | that one, `SOUND_SET` |
| several, and nothing picks one | **all** of them, `HEURISTIC`, `ambiguous: true`, one `limits` sentence naming them |
| none | not crossed. The row still reads "leaves the pack", and the call is listed in `federation.unmatched` |

A crossing never rises above `SOUND_SET`: which deployable answers a service
name is not a fact about anybody's source. It weakens the path grade of every
row below it exactly as any other edge does.

**What an answer carries.**

```jsonc
{ "answer": {
    "tables": [ { "table": "owners", "project": "customers-service",
                  "grade": "SOUND_SET", "viaHttp": true, "httpHops": 1,
                  "federated": true, "hops": 6, … } ],
    "federation": {
      "crossed":   [ { "from": { "project": "api-gateway", "symbol": "…CustomersServiceClient#getOwner" },
                       "route": { "method": "GET", "path": "/owners/{ownerId}" },
                       "service": "customers-service",
                       "to": { "project": "customers-service", "endpoint": "GET /owners/{ownerId}" },
                       "grade": "SOUND_SET", "ambiguous": false } ],
      "unmatched": [ { "from": { … }, "route": { … }, "checked": 3, "noIndex": 0 } ],
      "skipped":   [ { "project": "vets-service", "reason": "no-index" } ] } },
  "basis": { "project": "api-gateway", "buildDigest": "afcbe96e574f", …,
             "siblings": [ { "project": "customers-service", "buildDigest": "eaeb163146ce",
                             "builtAt": "…", "freshness": { "verdict": "unknown" } } ] } }
```

- Every row that came from another project carries `project`, `federated` and
  `viaHttp`, and its `hops` continue from the caller. `walk` and `layers` on a
  `flow` answer describe **this** project's walk only, and `walk.note` says so.
- `basis.siblings` names every other pack the answer walked, each with its own
  build digest and freshness verdict. A row from over there is anchored to that
  snapshot, not to this one. It is absent when nothing was crossed.
- On a server with only one project, `federation` is
  `{ "available": false, "reason": "single-project", "unmatched": [ … ] }`. The
  calls that leave the pack are still listed, because registering the project
  that serves them is the remedy and a reader who never sees the list cannot
  know to do it.
- `skipped` names a project that could not be asked: `no-index` (no
  `routes.json` beside its pack, so it is not federated at all), `stale-index`
  (its index was built from a different pack than the one this server loads), or
  `unreadable` (its pack could not be loaded). Each gets one `limits` sentence
  with the remedy, which is always `cascade analyze` in that project.
- `federate: false` answers from this pack alone. `federationHops` (default 3)
  bounds how many crossings one answer may chain, so A to B to C is walked and a
  ring of services cannot make one question walk forever.

**Siblings are read from their committed packs, never from their working-tree
overlays.** `changed_impact` and the overlay describe the project you are
editing; a sibling is whatever its last `cascade analyze` wrote. An edit in
another project is invisible here until that project is analyzed again.

### The whole-pack pictures cross too

`map` and `erd` follow the same rules, with one extra one: **only what this
project's requests reach is added, never a merge of two packs.** Two services
share no foreign key, so a relationship line between them would be an
invention, and jeecg alone is 10 601 nodes, so a merged picture would be
unreadable.

**`map`.** An endpoint on this map that calls a route another registered
project serves gets a `calls` link (`federated: true`) to that project's own
endpoint node, which is the **portal**. Under the portal hangs that route's own
picture, built by the same walk with the same mode, depth and layers.

```jsonc
{ "nodes": [
    { "id": "project:customers-service", "kind": "project", "label": "customers-service",
      "project": "customers-service", "endpoints": 1 },
    { "id": "customers-service|endpoint:GET /owners/{ownerId}", "kind": "endpoint",
      "project": "customers-service", "portal": true, … },
    { "id": "customers-service|table:owners", "kind": "table", "project": "customers-service", … } ],
  "links": [
    { "source": "project:customers-service", "target": "customers-service|endpoint:GET /owners/{ownerId}",
      "kind": "member", "grade": "EXACT", "project": "customers-service" },
    { "source": "endpoint:GET /api/gateway/owners/{ownerId}",
      "target": "customers-service|endpoint:GET /owners/{ownerId}",
      "kind": "calls", "grade": "SOUND_SET", "federated": true, "ambiguous": false,
      "project": "customers-service", "route": "GET /owners/{ownerId}", "via": "…#getOwner" },
    { "source": "customers-service|endpoint:GET /owners/{ownerId}",
      "target": "customers-service|table:owners", "kind": "touches",
      "grade": "SOUND_SET", "project": "customers-service" } ],
  "summary": { …, "federated": { "projects": ["customers-service"], "nodes": 2, "links": 3 } } }
```

- Every id from another pack is namespaced `<project>|<id>` and every such node
  and link carries `project`, so two services that both have an `orders` table
  are two nodes and never one.
- One node per sibling, `id: "project:<id>", kind: "project"`, is the skeleton
  the portals hang off. The sibling's own **groups are not drawn**: a group is
  one pack's naming convention and does not travel.
- `summary.federated.nodes` counts the nodes that BELONG to another pack (the
  skeleton is this answer's own drawing device, so it is not counted there);
  `summary.federated.links` counts every line that touches one.
- **One node cap and one byte budget bound the whole picture.** A federated node
  gives way before this pack's own node of the same kind, and a cluster goes
  whole once the route it hangs off goes, because a table with no line to it
  says nothing. `limits` names what went and from which project.
- A call that leaves this pack from a method **no route on the map reaches** (a
  scheduled job, a startup listener, a tool an AI model calls) cannot be drawn
  from a picture made of routes. It is not silently dropped: one `limits`
  sentence names the methods and the routes, and `overview.federation` counts
  every call that leaves the pack whether a route reaches it or not.

**`erd`.** The own answer is untouched. The whole-schema view gains
`answer.federated`, one entry per registered project a request reaches:

```jsonc
{ "federated": [
    { "project": "customers-service", "buildDigest": "eaeb163146ce",
      "tables": [ { "table": "owners", "comment": null, "columnCount": 6 } ],
      "relationships": [ { "from": …, "to": …, "columns": […], "statements": 2,
                          "grade": "EXACT", "cardinality": "1:N" } ],
      "via": [ { "route": { "method": "GET", "path": "/owners/{ownerId}" },
                 "fromEndpoint": "endpoint:GET /api/gateway/owners/{ownerId}",
                 "grade": "SOUND_SET", "ambiguous": false, "tables": ["owners"] } ] } ] }
```

- `tables` are only the tables the walk from the crossed route(s) reaches there,
  and `relationships` are **that project's own** joins between exactly those
  tables. **No relationship on this answer ever joins two projects.** The only
  thing connecting the clusters is the HTTP call, which `via` names.
- `via[].fromEndpoint` is the endpoint the request left from, namespaced
  `<project>|<id>` when a chained crossing means the caller is itself in another
  pack.
- The crossing walk runs at `mode=conservative, depth 8` (the default `map` and
  `flow` walk), because `erd` takes no mode or depth of its own. `limits` says
  so, so a table a wider walk would reach is unknown rather than absent.
- `erd table=<name>` answers one table's join neighbourhood in **this** pack and
  does not federate. Ask a sibling's table of that project (`erd` with its
  `project` argument).

Both accept `federate` and `federationHops` like `flow`. With `federate: false`,
and on a server that serves one project and calls nobody, both answers are
**byte for byte what they were before federation existed**: the `federation`
block appears only when there is something to say.

### The overview census

`overview.federation` is a census over the pack's outbound routes, not over one
walk, so it says the same thing whichever question the reader arrived with. No
pack is loaded: matching reads the siblings' sidecars only.

```jsonc
{ "federation": {
    "calls": 2, "answered": 2, "unmatched": 0,
    "projects": [ "customers-service", "visits-service" ],
    "byProject": [ { "project": "customers-service", "sites": 1,
                     "routes": [ { "method": "GET", "path": "/owners/{ownerId}", "sites": 1 } ] } ],
    "unmatchedRoutes": [ ] } }
```

`calls`, `answered` and `unmatched` count ROUTES that leave this pack. `sites`
counts CALL SITES: the methods in this pack that make the call, so one route
called from two services is one route and two sites. A route matched by two
projects is listed under both, which is what `ambiguous` means on a crossing.

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
