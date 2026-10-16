# Working on Cascade

Read `CONTRIBUTING.md` before changing runtime behavior. Prefer Cascade MCP for
this repository's supported code structure and impact queries. Confirm the
project and freshness with `projects` and `session_briefing`; use source reads
for literals, unsupported languages, configuration and reported coverage gaps.
If Cascade is unavailable, use codebase-memory MCP with its coverage checks,
then targeted source inspection. Do not claim an empty graph proves absence.

The local self-analysis selects `src`, `bin`, `viewer/js`, the TypeScript and web
analysis workers, `scripts`, and the Java analyzer. Tests, Python, vendored code,
and documentation are not all represented in that structure index. Verify the
actual input scope in the briefing rather than assuming this list is current.
Local `.cascade` data and `.codex/config.toml` are regenerable machine setup;
never commit credentials or personal absolute paths.

Delegate only bounded independent work with explicit ownership, constraints,
acceptance criteria and evidence. Preserve other workers' and the user's edits.
Use the least costly available model/effort appropriate to the uncertainty;
return ambiguous design or failed verification to the coordinator. The
coordinator reviews actual diffs and test evidence before claiming completion.
Run the relevant Node, Python and Java checks; do not weaken evidence grades or
accept a calibration baseline merely to make a test pass. Sign off commits.

<!-- cascade:begin -->
## Cascade: read code structure and change impact before editing

Use the `cascade` MCP server (project `cascade-oss`) for persistent structure
and graded change impact. Its selected analysis lanes do not cover every file.

Start each session with `session_briefing` for scope, freshness and recorded connections.
For code discovery, inspect `architecture`, then `code_search` or
`file_outline`. Use `code_context` for a bounded set of declarations and their
relationships; use `code_trace` for callers/callees (callback references are not execution),
and `code_snippet` for verified source. Reuse structure across
sessions; search source for literals, unsupported areas and reported gaps.
`index_status` reports the indexed scope and freshness. Automatic refresh reads
saved files; it cannot see unsaved editor buffers.

Before editing a mapper, entity, schema, controller, service or frontend:
1. Ask `changed_impact` with the files; check its freshness and overlay status.
2. For a column change, ask `column_impact`, `endpoint_impact` and
   `screen_impact`; include both readers and writers in the plan.
3. Use `flow` for a screen/API-to-table path and `overview` for impact coverage.
   Prefer `compact: true` with a small byte budget; read each needed lane's omitted counts
   and page it when necessary. A shortened list is not a complete impact census.

How to read an answer:
- Read `trust`, `limits`, `truncated` and any omitted counts before the list.
- `EXACT` is proved. `SOUND_SET` is a candidate set, so check each member.
  `HEURISTIC` and `RUNTIME_ONLY` are hints, not evidence.
- Empty means no match in the indexed scope, not proof of no callers or impact.
- Check `basis.freshness` as well as coverage. If it is `behind` or `unknown`,
  refresh the analysis or verify the affected source before drawing conclusions.
  A failed refresh is not a current answer.
- Structure relations explain organization; only the graded impact graph explains
  possible propagation. Directory groups do not establish architectural intent.

After editing, ask `changed_impact` again and report its evidence and limits.
<!-- cascade:end -->
