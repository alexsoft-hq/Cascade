# Try the 0.9 code workspace

[한국어](ko/code-intelligence-demo.md)

Use an analyzed Java, TypeScript or frontend project. Cascade reads source;
it does not start that project's application or install its dependencies.

## Verify the agent workflow through MCP

Configure your MCP client to run `cascade mcp --root /path/to/project` over
stdio, then give the agent a concrete coding question. For example:

> Use Cascade to find where initial account balance creation is implemented.
> Start with session_briefing, find the relevant declarations, read their exact
> source, and identify the affected API and tables. Cite source locations and
> relationship evidence. State unresolved references and truncated results.

The expected path is `session_briefing` → `code_search` / `code_context` →
`file_outline` → `code_snippet`, followed by impact tools for data-facing work.
Check `basis.project`, `basis.freshness`, scope, trust and truncation on each
answer. In a multi-project server, call `projects` first and name a project on
every project query. `index_status` reports the last observed state without
forcing a refresh; the actual query performs that check.
Start impact queries with a small per-list `limit` and inspect truncation for
each lane you need. Fetch further pages for omitted evidence; do not mistake
fewer displayed paths for fewer possible impacts.

Save a function addition, rename or deletion and ask the agent to search again.
It should receive the new generation or an explicit failure, not silently reuse
the old answer as current. An LLM's own conversation memory is separate: it must
query again after edits. The viewer below is a convenient inspection surface
for the same catalog, not a prerequisite for using MCP.

## Open the viewer

```sh
cascade init --root /path/to/project
cascade analyze --root /path/to/project
cascade view --root /path/to/project --port 4319
```

Open [the local Code workspace](http://127.0.0.1:4319/#tab=code).
If the index does not include the desired files, select explicit `--java-src`,
`--ts-src` or `--web-src` roots when analyzing; see [CLI options](cli.md).

## 1. Start with the briefing

Open **Code**. Read the project briefing and its freshness and coverage details.
Copy it for a new coding session. The summary should name the indexed scope,
recorded entry points and relevant limitations. Empty entry points mean this
analysis recorded none; they are not invented from filenames.

The same answer is available to agents as `session_briefing`, or in the terminal:

```sh
cascade code briefing --root /path/to/project --max-bytes 12288
```

## 2. Follow a module dependency

Inspect the dependency list. Each connection has a source directory, a target
directory and a relationship type. Open its evidence to see the contributing
files. Import connections describe written dependencies; call connections
retain the recorded call evidence. Directory grouping is organization by path,
not a claim about business boundaries. Unresolved/external targets and omitted
rows are reported separately.
Adjust **Directory depth** to see internal modules in a monorepo; depth 5 is
useful for the evaluated Ghostfolio layout.

```sh
cascade code architecture --root /path/to/project --depth 2 --limit 50
```

## 3. Find a declaration and read its source

Search for a function or class in your project. Open a result, inspect the
file's ordered outline, and select a declaration to read its source. Long
signatures and code scroll within their pane. Java overloads appear separately;
select the exact declaration ID when a name is ambiguous.

```sh
cascade code search --root /path/to/project --query OrderService
cascade code outline --root /path/to/project --file src/orders.ts
cascade code snippet --root /path/to/project --symbol '<id from search>'
```

The source view must show whether the read was truncated. Old facts without an
exact extent need reanalysis or an explicit file range. A source-hash mismatch
must produce an error rather than display stale code as verified.

## 4. Save an edit and query again

Add a named function to a file inside the analyzed roots, save it, and search
for its new name. The request waits for the required analysis. Open its source
and check that it contains the saved change. Rename or remove the function and
search again; the old declaration should disappear after the next successful
refresh. Use the Code workspace's reload action to refresh a displayed briefing.
The page is a view of responses; it is not a live editor buffer.
If a later query observes a different structure generation, the old overview
is marked unknown and copying it is disabled until you refresh it. Background
checks run every 30 seconds; queries check immediately before answering.

```sh
cascade code search --root /path/to/project --query yourNewFunction
cascade code status --root /path/to/project
```

To inspect snapshot behavior, start a separate viewer with `--no-watch` on a
different port. Its freshness is unknown, and a snippet whose source has changed
is refused. Unsaved editor buffers are not analyzed. See the complete
[freshness and coverage contract](code-intelligence.md).
