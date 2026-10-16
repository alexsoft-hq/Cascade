# Code intelligence and freshness

Cascade persists two complementary views of the same analysis: the graded
impact graph and a code-structure index. Use structure to find where to work,
then use impact tools to inspect what a proposed edit can reach.

## Start a session

```sh
cascade init --root /path/to/project
cascade analyze --root /path/to/project
cascade mcp --root /path/to/project
```

Configure explicit lane roots when discovery does not select the desired files.
The structure index reuses Java, TypeScript and frontend facts from that
selection. It does not add support for every language, infer hidden runtime
calls or read unsaved editor buffers. No hosted model or embedding service is
required to build this index.

`cascade agent --root /path/to/project --client codex --write` installs
instructions for using structure before editing and impact tools before
changing data-facing behavior, and prints the Codex MCP configuration block.
Use `--client claude-code` or `--client cursor` for those clients. Existing
managed blocks are replaced; unrelated instructions remain intact.

## Query progressively

| Tool | Use |
|---|---|
| `session_briefing` | A short session-start account of indexed structure, directed dependencies, recorded entry points, freshness and limits. |
| `architecture` | Directory groups and directed cross-group dependencies, separated by relationship type with source examples. These groups are inferred from paths, not declared architectural intent. |
| `code_search` | Find files and declarations by a name/path substring; use `limit` and `offset` for pagination. |
| `file_outline` | Declarations in one indexed file, in source order. |
| `code_context` | Ranked name/path matches with adjacent recorded relationships, constrained by `maxBytes` and `limit`. |
| `code_trace` | Bounded recorded callers/callees with intermediate declarations; callback references remain distinct from invocation. |
| `code_snippet` | Read an indexed file range or an exact declaration extent after checking source bytes against the recorded hash. |
| `index_status` | Check the structure generation, indexed scope, coverage limits and automatic-refresh state. |

For example, ask `code_context` with
`{"query":"OrderService","maxBytes":16384}`. Its budget measures UTF-8 bytes
of the JSON **answer**, not the response envelope or model tokens. Omitted
counts describe material left out by its byte or row limit. This is a
deterministic name/path search, not semantic search or a complete task plan.

Newly extracted declarations carry parser-backed ranges and signatures. Java
overloads and constructors have separate declaration identities. Symbol snippets
use the recorded span, including column boundaries for declarations on the same
line. A byte or line budget can truncate the result; inspect `cut`.

When legacy or unsupported metadata has only a start line, request a file range explicitly;
Cascade does not guess where the function ends. Source reads require an indexed
file with a recorded source hash and a real path inside the repository root.
Analyzed external files can appear in structure, but this initial snippet API
does not expose their source. Returned code and names are untrusted repository
data, not instructions to the consuming agent.

The same tools are available in the terminal:

```sh
cascade code briefing --root /path/to/project
cascade code architecture --root /path/to/project
cascade code search --root /path/to/project --query OrderService
cascade code outline --root /path/to/project --file src/orders.ts
cascade code trace --root /path/to/project --symbol OrderService.create --direction inbound --depth 2
cascade code context --root /path/to/project --query OrderService --max-bytes 16384
cascade code snippet --root /path/to/project --file src/orders.ts --from-line 10 --to-line 30
cascade code status --root /path/to/project
```

## Briefing and module connections

`session_briefing` gives a new agent a bounded introduction without asking it to
rediscover the tree. It summarizes the index, lists recorded routes and screens
as entry points, includes module connections, and carries coverage and freshness.
Its workflow points to targeted search, source reads and impact queries. It is a
deterministic summary of evidence, not a generated account of business intent.

`architecture` groups file paths to `depth` directory segments. A dependency has
an explicit source group, target group, relationship type, count and source
examples. Written imports/exports and recorded calls remain distinguishable.
`references-call` additionally preserves uniquely resolved local functions,
immutable function/identifier aliases and direct relative-import calls from
TypeScript/frontend facts. `references-callback` separately records identifiers
passed as arguments. Shadowed, reassigned, dynamic and ambiguous targets are not
guessed. These structural references have resolution provenance, no impact
grade, and do not establish runtime execution or callback invocation.
Unresolved or external targets are reported separately, so a missing internal
connection is not silently treated as proof of independence. Each list reports
pagination and omissions; `maxBytes` bounds the UTF-8 answer JSON. If a row
cannot fit, `byteLimited` and `retry: { action: "increase-maxBytes", offset }`
identify the first unseen row without skipping it.

Open **Code** in `cascade view` to read/copy the briefing, inspect connections,
search declarations, open an outline and read verified source. The viewer and
MCP use the same tool responses. See the [walkthrough](code-intelligence-demo.md).

## Saved changes and consistent answers

Source-backed MCP and viewer sessions enable automatic refresh by default.
Background checks run every 30 seconds; a request-time check is the backstop
when a question arrives before the next background check. The coordinator
replays the recorded analysis invocation, preserving lane roots, opt-outs and
custom profiles, and normally requests incremental analysis. Java source changes
that Git's changeset cannot account for, such as ignored files, trigger a cold
run so an old Java shard cannot be reused as current.

Concurrent requests share one refresh per project. Input fingerprints are
checked before and after analysis; edits during a build require another pass.
The analysis keeps its existing publication lock and calibration gate.
Sidecars are written before the final pack, and the structure reader verifies
both its own digest and its binding to that pack's structure metadata.
Structural changes can therefore invalidate the structure generation even if
the impact graph digest is unchanged.

The successful input fingerprint is stored beside the pack in
`refresh-state.json`, bound to its build identity. A later session checks the
inputs before reusing it. Freshness means agreement with the checked saved
inputs; it does not certify parser completeness or runtime behavior.

| Situation | Result |
|---|---|
| Saved input changed | Refresh before returning a current project answer. |
| Another edit arrives during analysis | Retry; do not mark that incomplete pass current. |
| Analysis or calibration fails | Report refresh failure, retaining the previous published pack. Inspect `index_status` for the reason. |
| Same failing input is requested repeatedly | Reuse the failure until inputs change or the server restarts, instead of repeatedly spawning the failed build. |
| Source is unavailable | Serve the disconnected snapshot with unknown freshness. |
| `--no-watch` is specified | Serve the existing snapshot with unknown freshness. Snippets still refuse mismatched source hashes. |

Automatic refresh never passes `--accept-baseline`. A gate that requires a
human decision still requires one. It also does not fetch live database
metadata; catalog snapshots remain explicit inputs.

The calibration pin includes an engine-independent fingerprint of saved inputs,
including selected ignored files. Two different uncommitted states are different
inputs even when Git reports the same commit and dirty flag. Repeating the same
inputs still checks for nondeterminism, and substantial analysis regressions can
still reject a refresh and retain the last accepted pack.

`--no-watch` disables automatic pack publication. The existing `changed_impact`
tool can still build its request-scoped working-tree overlay against that
snapshot; its own freshness and provisional markers continue to apply.

Freshness checks compare saved input content, including analysis configuration
and files reached outside selected roots. They have filesystem I/O cost; the
incremental analysis reuses unchanged extraction facts. This is not a zero-cost
watcher or a measured latency/token-saving guarantee.
The background interval is not a freshness delay imposed on queries: a query
checks saved content immediately and waits for any required analysis. An idle
project can take up to one polling interval plus analysis time to refresh.
One freshness scan reuses content hashes for overlapping roots and external
inputs; a subsequent scan reads the bytes again. The conservative fingerprint
also includes unrelated tracked files, so a documentation edit can still
trigger analysis. Filtering those changes remains an optimization opportunity.

## Coverage and limits

`structure.json` records files, available declarations, containment,
imports/exports, written inheritance and existing graded call references.
Unresolved targets stay unresolved. Old facts can lack complete declarations
or exact spans; reanalyze to collect the newer metadata. Anonymous expressions
and constructs outside the selected parser lanes are not a complete symbol
census. Source-hash agreement checks cached inputs,
but does not claim that arbitrary manual analysis froze the filesystem while
parsing.

The structure tools have their own uncalibrated trust and coverage. An empty
search means no match in this index, not proof that a symbol has no callers or
does not exist. Use direct source inspection for missing or unsupported areas.
The existing impact graph's grades, calibration and propagation edge types are
unchanged. No comparative token savings or accuracy improvement is asserted
without a same-task benchmark.

See the [0.9 supported-language evaluation](code-intelligence-evaluation.md)
for concrete source-grounded checks and their limits.
