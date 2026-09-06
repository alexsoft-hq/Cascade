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
