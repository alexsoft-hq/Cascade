# 0.9 code intelligence: supported-language evaluation

[한국어](ko/code-intelligence-evaluation.md)

This local evaluation on 2026-10-16 asks whether Cascade helps an agent work on
its supported Java, TypeScript and JavaScript inputs: orient, find declarations,
read exact source, follow recorded dependencies and assess data-facing changes.
It is not a benchmark of every language or a claim of universal replacement.

## Projects and method

| Project | Selected inputs | Live structure result |
|---|---|---|
| Controlled orders playground | Java service/controller and JavaScript imports | 7 files, 11 declarations; distinct Java overloads and direct imported-call references |
| Ghostfolio, pin `f6b25eec05312a3cda466e00323b94f39c8f5a5f` | NestJS API and Angular client lanes | 760 files, 2,477 declarations; depth 5 exposes 86 directory groups and 280 dependency groups |
| Cascade's own working tree | Java analyzer plus JavaScript in core, CLI, viewer, TS/web workers and scripts | Final sampled generation: 287 files, 5,850 declarations; 12 directory groups and 30 dependency groups |

Counts describe these selections and generations, not every file in each repo.
Ghostfolio uses explicitly configured, source-verified prefix exclusions; this
evaluation does not establish automatic inference of that configuration.

The playground and Ghostfolio used the same source checkouts for Cascade and
the locally installed codebase-memory MCP. Relevant graph pagination and
coverage were checked, then material claims were compared with source. A clean
coverage report is best effort, not a completeness proof. The installed
competitor's version was not pinned, so these observations are not claims about
every codebase-memory release.
Its Ghostfolio index reported 60 partially indexed files overall; the account
service/controller files used for the comparisons had matching metadata and no
recorded coverage issue.

## Observed strengths and remaining gaps

| Check | Observation |
|---|---|
| Java outlines and overloads | Cascade preserved `findOrder(String)`, `findOrder(long)` and the constructor separately with exact ranges. The comparison index retained only the last overload in this fixture after full indexing. |
| Exact source boundaries | Cascade isolated adjacent functions on one line, including a Unicode character. The comparison snippet included its neighbor even with `include_neighbors: false`. Both tools returned the three sampled Ghostfolio methods correctly. |
| Saved changes in the playground JavaScript fixture | Cascade's first query after add, rename, delete and import rewire refreshed the relevant answer. The comparison's first short-window queries retained older results; its coverage API detected missing/untracked files. Watcher settings were not matched, so this does not establish that the other tool never refreshes. |
| Direct JavaScript import calls | The initial comparison found a missing `orderLabel → formatMoney` reference. This was fixed and verified in the live server as a separate ungraded `references-call`, with parser-binding provenance. |
| NestJS injected-service relationships | Cascade recorded controller-to-account-service links that the comparison's caller queries omitted. Source inspection confirmed the calls. |
| Route to Prisma impact | `POST /api/v1/account` reached Account, TagsOnAccounts, AccountBalance and Tag with SOUND_SET path evidence. This connects code orientation to Cascade's existing change-impact workflow. |
| Call resolution precision | The comparison resolved an imported `date-fns` formatter to an unrelated client adapter with low heuristic confidence. Cascade did not require that false association to explain the sampled route impact. |
| General immediate-call traversal | Added `code_trace` for recorded direct/transitive callers and callees, with intermediate declarations. Its two directions are independent; ambiguous overload associations remain explicit and are not traversed. Impact `flow` remains a different projection. |
| Callbacks, dynamic calls and aliases | The initial callback comparison missed both sides. Cascade now records identifier callback arguments as references, plus local functions and immutable aliases, without claiming callback invocation. Dynamic/member targets and barrel reexports remain unresolved. |

Directory depth matters: Ghostfolio's default depth 2 combines most API files
into one group. Choose depth 5 in the viewer to inspect its internal modules.
The 4,216 unresolved records in this sample mix different reference kinds;
they are not 4,216 proven missing calls.

## Actual MCP and coding-agent acceptance

A separate client exercised the real newline-delimited JSON-RPC stdio process,
not the viewer HTTP API. Initialize advertised 0.9.0, notifications worked,
and the initial tools/list exposed 25 tools; final hardening adds `code_trace` for 26. All three projects passed briefing,
architecture, search, outline, exact source, context and status checks.
Ghostfolio's independent architecture lists were fully paged across 85
responses. Unknown and omitted project IDs failed explicitly in the
multi-project server.

In the playground, saved add, rename, import rewire and deletion were reflected
on the first MCP query. A separate `--no-watch` client reported unknown
freshness and rejected a changed file's snippet with `stale-source`. Pending
replies drained on EOF, both clients exited zero, and stdout contained only
JSON-RPC. Temporary source changes were restored byte-for-byte; a fresh client
confirmed the restored index. These are protocol/client tests, not a claim that
every third-party AI client's integration was tested.

A coding agent then answered: “Where should initial account-balance creation
change, and which API/table impacts need checking?” Using Cascade MCP for
discovery, it found the account service, DTO, controller, shared balance upsert
and import caller; identified two affected API routes and four tables with
SOUND_SET paths; and proposed checks for missing/null versus zero balance,
date/upsert behavior and import compatibility. Five returned snippets were
independently compared with source. No broad repository search was needed.
This produced a grounded edit plan; Ghostfolio was not modified or executed.

That task used 11 domain calls and returned 97,596 bytes of answer JSON,
111,399 bytes including the embedded evidence envelopes, and 121,699 bytes of
complete JSON-RPC responses. The tool catalog added 44,731 bytes separately.
The largest response was upstream impact at 45,234 envelope bytes, with
repeated paths to frontend functions. This identified repeated impact evidence and long tool descriptions as
context-efficiency problems, addressed by the compact format below. These are measured bytes, not model-token or competitor ratios.
For the API-focused upstream question, a follow-up with `limit: 2` retained
both endpoint rows (2/2, no endpoint page remaining) while making the omitted
service (2/5 shown) and frontend (2/8 shown) rows explicit. Its envelope text
was 15,933 bytes. Small per-list limits therefore help this task immediately;
inspect and page each lane needed for the actual change before claiming
complete impact coverage. The original 11-call totals above remain unchanged.

## Release hardening and an actual code change

The same Ghostfolio upstream impact query was repeated through stdio with
`compact: true`. Full response: 45,248 bytes; compact response: 20,685 bytes.
Independent expansion of the shared evidence reproduced every original shown
path, grade and row. An 8,192-byte answer budget returned 7,464 answer bytes
with explicit per-lane omissions. The final catalog measured 32,915 bytes,
including the additional trace tool. These comparisons concern serialized
bytes for these responses, not tokens or a competitor benchmark.

A separate coding task used Cascade MCP discovery and verified snippets to
reproduce and fix a real Cascade bug: generated agent configuration lost a
custom registry when launched from an unrelated environment. The fix preserves
absolute `CASCADE_HOME` in JSON and Codex TOML. Nine CLI tests passed, including
launching the generated MCP configuration and resolving the registered project.
Post-edit MCP source hashes matched disk. Ten tool calls were captured; the
14 protocol requests including initialization returned 106,340 bytes in total.
The impact tool reported `readNoFacts` for the affected CLI/core files, so
behavioral tests supplied the correctness evidence. An empty impact projection
was not treated as proof of safety.

Independent review also corrected mixed-direction co-caller leakage, ambiguous
overload disclosure, default-parameter and switch lexical scopes, default
identifier exports, type-only exports, and cold/cache fact ordering. Targeted
regressions exercise real TS and web parsers as well as rejected shadowed,
reassigned and dynamic cases.

## Freshness and cost

Source reads matched the recorded UTF-16 slices and current file hashes. The
live briefings stayed within their 12,288-byte answer budget in all three
projects. This is a JSON byte budget, not a measurement of model tokens.
Automated saved-file refresh regressions also cover failed analysis, ignored inputs, import
closure, configuration changes, concurrent requests and HEAD movement.

The cost review found excessive idle scanning with a 2-second background
interval: one unchanged 20-second window consumed 32.93% of one CPU core across
three served projects. The default is now 30 seconds, including the serving
host's wiring, while every source-backed query retains content verification.
An initial retest caught a host override still using 2 seconds; the override
was corrected before the final local demo. Full content hashing remains a cost. Scan-local hash reuse now removes duplicate
reads across overlapping inputs; unrelated tracked documentation can still trigger analysis.
With the effective 30-second interval, an unchanged 35-second window consumed
0.72 CPU seconds (2.06% of one core), versus the earlier 32.93%. Both windows
used the same local demo inventory, which still included untracked evaluation
artifacts. Those artifacts were subsequently excluded locally; the figures
are bounded observations, not representative repository-wide throughput.

A same-input, three-sample warmed comparison of fingerprint hashing read
53.47MB without memoization and 29.13MB with scan-local reuse on Ghostfolio;
median wall time was 299ms and 224ms. Each new scan still reads saved content.
These figures isolate duplicate hashing in this local inventory. Excluding
unrelated documentation safely would require a complete analyzer read inventory,
including failed path lookups and discovery/configuration inputs. That broader
optimization remains deferred; freshness is kept conservative.

These local measurements do not justify speed, memory or token-saving ratios
against another tool: request wrappers, returned content, watcher settings,
caches and analysis scopes differed.

## Practical assessment

Cascade is useful as a primary orientation and change-impact tool for the
tested supported stacks. Its particular strength is moving from a bounded
briefing and exact source to evidence-bearing service and database impact in
one workflow. Use source inspection for unresolved references and constructs
outside the analyzed lanes. Broader supported-language projects still need
their own acceptance checks; three projects do not prove all frameworks work.

Reproduce the core workflow with the [demo guide](code-intelligence-demo.md).
For a comparative rerun, pin both tool versions, use identical source roots,
record refresh settings, and verify answers against source before comparing
timing or response sizes.
