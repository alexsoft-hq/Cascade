# Wiring Cascade into an AI client

`cascade mcp` is an ordinary MCP server speaking JSON-RPC over **stdio**. Every
configuration on this page runs the same command:

```
node <absolute path to cascade>/bin/cascade.mjs mcp --project <id>
```

Three rules hold for all of them.

- **Use an absolute path to `bin/cascade.mjs`.** A client starts the server from
  a working directory you do not control, so a relative path is the single most
  common reason a client reports the server as failed.
- **`--project <id>` is optional.** With it, that one project answers and no
  tool needs a `project` argument. Without it, the server serves **every**
  project in `~/.cascade/registry.json`, and a call that does not name one is
  answered `ambiguous` with the ids listed. Repeat the flag to serve exactly
  two or three of them.
- **Packs are lazy.** Starting the server reads the registry and nothing else, so
  a client that starts the server at login pays almost nothing until the first
  question.

Check the command by hand before you paste it anywhere:

```bash
node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

```
cascade mcp: serving 1 project(s) [mall]: packs load on first use, budget 512 MB of pack JSON
```

That line goes to stderr; stdout carries the JSON-RPC stream and nothing else,
which is what lets a client read it.

## Tell the agent when to ask

Everything below this section wires the server up. None of it tells the agent
**when to ask**, and that is the half the tool's value sits on: a model with the
server attached and no rule about it edits a mapper without a question, because
nothing in its context says a question is due.

One command writes both, in the project you run it in:

```bash
cascade agent --write                     # .mcp.json + CLAUDE.md, for Claude Code
cascade agent --client cursor --write     # .cursor/mcp.json + .cursor/rules/cascade.mdc
cascade agent --client codex --write      # AGENTS.md, plus a TOML block to paste
```

Without `--write` it prints every file it would write, with the exact content,
and touches nothing. It fills in the absolute path to `bin/cascade.mjs` and the
project id itself, because it knows both. The full flag list is on
[the CLI page](../cli.md#cascade-agent).

The rules half is this, written into `CLAUDE.md` or `AGENTS.md` between two
markers so a second run replaces it in place and your own text around it
survives. Cursor gets the same body as a whole `.mdc` file with
`alwaysApply: true` on it.

```markdown
<!-- cascade:begin -->
## Cascade: ask the impact graph before touching data-facing code

This project has a change-impact graph served over MCP by the `cascade` server
(project `mall`). It knows which SQL statements, HTTP endpoints and screens reach
every table and column, with a grade on each edge.

Ask before you edit any of these:
- a MyBatis mapper XML or an annotated mapper, a JPA entity or repository, a DDL file
- a controller, a route, or a service method a controller reaches
- a frontend screen, or a frontend function that calls the backend

How to ask:
1. `changed_impact` with the files you are about to change, or have changed and
   not committed. It lists the endpoints, screens, tables and columns in the
   blast radius, and it reads your working tree, so it is never behind.
2. Before renaming or retyping a column, run `column_impact`, then
   `endpoint_impact` and `screen_impact` on it, and put every reader AND writer
   they name into your plan.
3. `flow` on an endpoint or a screen shows the whole path down to the tables it
   ends at. `overview` first when you do not know what is in the pack.

How to read an answer:
- `trust`, `limits` and `truncated` come with every answer. Read them before
  the list. Each `limits` entry names something the graph could not see.
- `EXACT` is proved. `SOUND_SET` is a candidate set, so check each member.
  `HEURISTIC` and `RUNTIME_ONLY` are hints, not evidence.
- An empty list means "none" only when `empty` says `none`. `not-shipped` and
  `degraded` mean unknown, which is not the same as zero.
- A `basis.freshness` of `behind` means the pack predates the code you see.
  `changed_impact` still answers from the working tree.

After the edit, run `changed_impact` again and put the endpoints and screens it
names into the commit message or the pull request, so a reviewer sees the same
radius you did.
<!-- cascade:end -->
```

Claude Code needs one approval after that: a server that arrives in a project
`.mcp.json` sits at *Pending approval* until you run `claude` in that directory
once and approve `cascade` when it asks, and `claude mcp get cascade` prints
that state.

The rest of this page is what the command writes, if you would rather do it by
hand, plus the clients it has no writer for.

## Claude Code

From a shell, in the repository you want the server available in:

```bash
claude mcp add cascade -- node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

Every registered project instead of one:

```bash
claude mcp add cascade -- node /path/to/cascade/bin/cascade.mjs mcp
```

Then `/mcp` inside Claude Code lists the server and its tools.

## Claude Desktop

Edit `claude_desktop_config.json`. On macOS it is under
`~/Library/Application Support/Claude/`, on Windows under `%APPDATA%\Claude\`.

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": [
        "/path/to/cascade/bin/cascade.mjs",
        "mcp",
        "--project", "mall"
      ]
    }
  }
}
```

Several projects on one server:

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": [
        "/path/to/cascade/bin/cascade.mjs",
        "mcp",
        "--project", "mall",
        "--project", "shop"
      ]
    }
  }
}
```

Restart the app after editing the file. Claude Desktop starts the server itself,
so `node` has to be on the PATH the desktop app inherits; if it is not, give the
absolute path to the `node` binary as `command`.

## Cursor

Cursor reads `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for
every project). The shape is the same:

```json
{
  "mcpServers": {
    "cascade": {
      "command": "node",
      "args": ["/path/to/cascade/bin/cascade.mjs", "mcp", "--project", "mall"]
    }
  }
}
```

## A generic stdio client

Anything that speaks the MCP stdio transport needs three things: the executable,
its arguments, and an environment. Cascade needs no environment variables at
all, and reads none of its own beyond the two below.

| Field | Value |
|---|---|
| transport | stdio |
| command | `node` (or the absolute path to your Node 20+ binary) |
| args | `["/path/to/cascade/bin/cascade.mjs", "mcp", "--project", "mall"]` |
| env | nothing required |

Two environment variables change where state lives, and both are for isolation
rather than for daily use: `CASCADE_HOME` moves the registry off
`~/.cascade`, and `XDG_CACHE_HOME` moves the regenerable fact shards off
`~/.cache/cascade`.

Drive it by hand to see the protocol:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node /path/to/cascade/bin/cascade.mjs mcp --project mall
```

## What to check when a client says the server failed

1. **Run the command yourself**, exactly as the client has it. Almost every
   failure reproduces in a shell in one second.
2. **Absolute paths.** Both to `bin/cascade.mjs` and, if `node` is not on the
   client's PATH, to `node`.
3. **`node --version` is 20 or newer.** A desktop app often inherits an older
   Node than your shell does.
4. **The project id exists.** An unknown `--project` lists the ids that *are*
   registered rather than guessing one. `node bin/cascade.mjs mcp` with no flag
   serves them all, and the `projects` tool lists them without loading a pack.
5. **A pack exists for that project.** `cascade init` registers a project;
   `cascade analyze` is what builds the pack it answers from. Until then a call
   comes back `pack-unreadable`, naming the path it looked at.

## What the agent should ask first

Start with `overview`. It is one call, it names what is in the pack and how much
of it is wired end to end, and its `limits` and `trust.knownGaps` tell the model
which questions this pack cannot answer before it asks one of them. Then
`browse` when there is no name yet, `search` when there is part of one, and the
impact tools once there is a target. The full catalog, with the arguments each
tool takes, is on [mcp.md](../mcp.md).
