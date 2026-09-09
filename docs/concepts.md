# Concepts

Six ideas hold this engine together. Each is a mechanism in the code, not a
posture: the file that implements it is named beside it.

## 1. Grades — fact, candidate set, guess

Every edge in the graph carries one of five grades. They are a lattice, and the
whole point is that nothing moves **up** it.

| Grade | What it means | Example |
|---|---|---|
| `EXACT` | proved unique by syntax, symbols and constants | a handler calling a mapper method directly |
| `SOUND_SET` | a conservative candidate set the real target is *guaranteed to be inside* | the possible implementations behind an interface dispatch |
| `HEURISTIC` | plausible from a project convention; a recovered or partial binding | a column name derived from a field name with no declared naming strategy |
| `RUNTIME_ONLY` | not statically decidable; needs runtime evidence | a bean or URL chosen from external configuration |
| `UNRESOLVED` | the analysis failed, or the shape is unsupported | a parse failure, a missing dependency |

**A candidate set of one is never promoted to `EXACT`**, and no refactor may
change that. Narrowing is not proving. The lattice is computed in exactly one place —
`src/core/policy.mjs` — and the workers emit *evidence* (what kind of call,
what binding state), never a grade. A property test checks that no evidence
combination classifies above the lattice, and a second checks totality: an
evidence shape the table does not know falls to a conservative `HEURISTIC` with
a `POLICY_GAP` diagnostic, never to silence.

A walk is graded by its **weakest link**: a chain that passes through one
`SOUND_SET` call is `SOUND_SET`, however exact the rest of it was.

Query modes pick a floor: `strict` uses confirmed edges only, `conservative`
adds candidate calls, `heuristic` also admits guessed rules. A question that
returns nothing under `conservative` and something under `heuristic` has told
you something real about the code.

## 2. The four fields every answer carries

`src/mcp/contract.mjs` is the only place a valid response is built. The fields
are stamped with a private `Symbol`, so a hand-assembled object that merely has
the right shape is rejected by `assertContract()` before it is serialised
(invariant I-8). A server response that breaks the contract is a **500
contract-violation**, not a 200.

**`basis`** — the answer's anchor: project, pack digest, when it was built, and
a freshness verdict, one of `current` · `behind` · `provisional-overlay` ·
`unknown`. `unknown` is a real answer and never reads as `current`. A basis with
no pack digest is refused outright: an answer with nothing to anchor it to is
not an answer.

**`trust`** — a **computed** level, never a literal. Three names exist
(`UNCERTIFIED`, `GOLDEN_FAIL`, `GOLDEN_PASS`) and `src/core/trust.mjs` is the
only file allowed to write them down (a test greps the tree and fails the build
if the strings reappear elsewhere). The computation is pessimistic in order: no
calibration state at all → `UNCERTIFIED`; a gate that is not GREEN/BOOTSTRAP →
`UNCERTIFIED`; fewer than 30 approved golden cases → `UNCERTIFIED`. Note the
implication the module states plainly — 30 flawless cases give a Wilson lower
bound of 0.8865, so **no 95% target can be shown at N=30**. Thirty cases are
where a corpus may *start* being scored, not where it becomes sufficient.
`trust.knownGaps` also carries the axis declarations (`column-axis-degraded`,
`code-axis-not-shipped`, …).

**`limits`** — what the engine could not see, in sentences, each scoped. A depth
cap that bit, a `${}` substitution it refused to guess at, an axis that was
never built.

**`truncated`** — per list: how many were shown, how many there are, in what
order, and where to continue. A truncated list that called itself complete is
the failure this field exists to prevent.

**Empty means something.** `not-shipped` (the axis was never built) ·
`degraded` (built, but without something it needed) · `none` (looked, found
nothing). Those are three answers, and a `0 results` never reads as "safe".

## 3. Two speeds, one graph

| | the **certified base** | the **working-tree overlay** |
|---|---|---|
| what it describes | a specific commit's blobs | the bytes on your disk right now |
| determinism | byte-for-byte reproducible | explicitly not; outside every digest |
| cost | seconds to minutes | ~0.2 s on a 900-statement project |
| written down | yes — the pack | **nothing**: not the pack, not the fact cache |
| how it reads | `current` / `behind` | `provisional-overlay` |

The base is the pack: same commit + same catalog snapshot + same engine and
profile → **the same digest**, on any machine. Build time, hostname and absolute
paths are carried in `meta` and are outside the digest.

The overlay re-parses your dirty files on **every call** and splices them over
the cached shards of everything else (`src/core/overlay.mjs`). A node the base
never had is marked `provisional` — a marker beside the grade, not a grade. The
overlay may **over-approximate; it may not omit**, and that is a test, not a
promise: `test/overlay_integration.test.mjs` compares it against a full
re-analysis of the same bytes. Commit your edit and the overlay is *discarded*,
answering `behind` and naming `cascade analyze` as the cure — never a quiet fall
back to the pre-edit answer.

The second speed also covers *reruns*: a run after a small edit reuses the
content-addressed shards of everything that did not change, and the result must
equal a cold run of the same state **byte for byte** (invariant I-9,
`test/incremental.test.mjs`, which mutates a random subset of files each round
with a seeded PRNG). Four things it refuses to do quietly: unknown is never
"nothing changed"; a damaged shard is never loaded (it is reported
`SHARD_UNUSABLE` and that unit alone is recomputed); a dirty tree is stated in
`meta.base.dirty`; and the pack records the mode, the base commit and the
reparsed/reused counts.

## 4. Partial packs — a missing axis is declared, not fatal

Every lane input is optional, and every lane can be switched off by name
(`--no-ddl`, `--no-mappers`, `--no-java`, `--no-web`, `--no-openapi`). The run
still produces a valid pack,
and the pack records `meta.axes`: per axis (`catalog` `statements` `column`
`code` `jpa` `web` `screen`) one of `shipped` / `degraded` / `not-shipped`
**and why**.

That declaration then rides on every answer: the axis name lands in
`trust.knownGaps`, the reason in `limits`, and an empty list says `not-shipped`
rather than `none`.

Nothing is dropped to make the answer look clean. Analysing a project with
`--no-ddl` declares `column: degraded`, and the numbers behind it are real —
what cannot be attributed without a catalog is recorded as *unresolved*, not
discarded.

The `screen` axis is the far end of that round trip: the router's own
declarations, composed into the paths a user is really on, each joined by a
`RENDERS` edge to the frontend functions of the component it mounts. `RENDERS` is
`EXACT` onto the file the route DECLARES and `SOUND_SET` onto a file that
component imports, because which of an imported component's functions really runs
is a run-time question. It is `shipped` only when the profile turned the axis on,
at least one screen reaches a function, and nothing about the reading was a
guess; a router that fetches its menu from the server at run time makes it
`degraded`, because the screens in the source are then not the screens the
product has. The gate itself, `screenAxis.enabled`, has three states: `true` and
`false` are your word and are obeyed whatever the run reads, and `null` (the
default, and what `cascade init` leaves when it found no router package in the
tree) means "decide it from what this run READS" — which is what lets a backend
analysed with `--web-src ../front/src` build screens with nothing configured. Between that component and the route it hits sits one more hop,
`symbol --CALLS--> symbol`, graded the same way: `EXACT` for an import or a name
inside one file, `SOUND_SET` through an `export *` barrel or when the function
was never called here at all but handed to some other call AS A VALUE, and
`HEURISTIC` through an assumed alias. See
[the web lane setup page](setup/web-lane.md).

A browser recording (`--har`) is a different KIND of fact and is graded as one:
`RUNTIME_ONLY` sits below every mode's floor, so a recorded `screen → route` call
is **shown** (`observed: true`) and **never walked**, and it never raises the
grade of the static edge beside it. A recording proves a request happened once;
it proves nothing about what the code can do.

`degraded` is not only about a missing input. The `web` axis is `shipped` only
when nothing about the frontend had to be guessed: a URL prefix this engine
worked out by counting matches, or a path alias it assumed because the project
declares none, makes the axis `degraded` and the reason names what to declare to
fix it.

It can also mean **the axis stops earlier than it looks**. A pack whose routes
came from an OpenAPI document and not from source has endpoints and nothing under
them, so the `code` axis is `degraded` with the reason *"endpoints come from an
OpenAPI document, not from source: the routes exist, but nothing below them is
walked, so a frontend call reaches an endpoint and stops there"* — and a question
that would need the chain below a route answers `not-shipped`, never an empty
list that would read as "we looked".

`cascade estimate` answers the same question **before** you analyze: what this
tree will ship, degrade, or not ship.

## 5. Calibration — every run is judged against the last certified one

Each project keeps a sealed baseline in `.cascade/calibration/`
(`src/core/calibration.mjs`). Every `analyze` is compared against it, and the
gate first asks *why* this run differs:

| Mode | When |
|---|---|
| `NO_SEAL` | no baseline yet — this run becomes it (`BOOTSTRAP`) |
| `NO_CHANGE` | same engine, same commit pins |
| `ENGINE_MOVED` | the engine fingerprint moved — an upgrade |
| `REPIN` | the analyzed commits moved |
| `BOTH_MOVED` | both |

`ENGINE_MOVED` is the strict one: "the analyzer changed" is exactly when a loss
must not slip through, so a drop is treated as a regression and blocked. The
gate is **comparative**, not absolute, and it reports improvements too — a ratio
whose *numerator* rose is a wider lane, not a smaller answer, and the finding
says so in those words.

A `RED` run is never silently discarded: its pack is written to
`<packDir>-rejected/`, the certified pack is left exactly where it was, and the
command exits 3. The one override is `--accept-baseline`, which re-seals the
baseline **from that run** — a human decision, by design.

Alongside it, `cascade golden` keeps the project's own labelled corpus: the tool
*proposes* cases, a **human** approves them (`--ids …`, or an explicit `--all`),
a hash decides which are held out, and `check` scores the approved ones through
the shipped MCP tools. The tool never approves itself, which is why the trust
level above can mean anything.

## 6. Fail-closed, and evidence for everything

- What cannot be determined is **lowered** to a candidate set or `UNRESOLVED` —
  never rounded up.
- What cannot be attributed (a MyBatis `${}` substitution, an unresolvable
  include) is **recorded as a diagnostic**, not guessed and not dropped.
- Every node and edge carries provenance: the commit, the file, the symbol, the
  line, and the extraction rule that produced it.
- The extraction path makes **zero** network calls and runs **no** project build
  The DB catalog is a separate adapter that writes a pinned
  snapshot; analysis reads that file, so a pack stays reproducible against a
  database that keeps moving.

## 7. Identifier identity — when two spellings are one table

`create table item (…)` in the DDL and `FROM ITEM I` in a mapper name **the
same table** in HSQLDB, in Oracle, and in a MySQL server with
`lower_case_table_names=1`. Matching them by exact string would put two tables in
the graph and split every fact between them. Matching them by folding always
would merge two genuinely different tables in a database that does distinguish
them. So the rule is neither: it is **declared per dialect**, from what each
database's own manual says, and it is one small table
(`src/core/identifier_case.mjs`, mirrored for the worker in
`adapters/sql/identifier_case.py`, cross-checked by a test that runs both).

- MySQL / MariaDB and PostgreSQL → `fold-lower`; Oracle, HSQLDB and H2 →
  `fold-upper`; a dialect this engine does not know → `exact`, folding nothing.
- A **quoted** identifier (`"Item"`, `` `Item` ``) is exact in every one of them,
  so it is matched only against the spelling the catalog declares.
- The profile key `sqlIdentifierCase` — `fold-lower` | `fold-upper` | `exact` |
  `null` (the dialect's own rule) — overrides the table, and every run states
  which rule it used and where the rule came from.

The fold produces a **matching key**, never a new name. A table and a column
keep the spelling the catalog gave them, so `pms_product` stays `pms_product` in
the ERD and in every answer — which also means the fold *direction* cannot
change the facts, only what matches. Two catalog names that fold to one key are
reported as a `folded_identifier_collision` and the first declaration keeps the
key; both tables stay in the pack as declared. And a table the catalog does not
have under the folded comparison is still `unresolved` — folding makes the
comparison correct, not lenient.

**A tool argument is folded the same way.** The pack records the rule it was
built under (`pack.meta.identifierCase`), so `table_usage ORDERS` — the spelling
you read off your own SQL — answers about the catalog's `orders`, and the answer
carries one `limits` line saying so. The same goes for `column_impact`,
`endpoint_impact`, `flow`, `neighborhood` and `erd`'s focus table. A name that
matches nothing keeps its `unknown-table` / `unknown-column` code and names the
closest ones it does have; a name that folds onto *two* declared names is
ambiguous and is not resolved to either. Under `exact` nothing folds, and a pack
built before the engine recorded the rule declares none — such a pack matches
arguments exactly, as it always did.

## 8. Crossings — when the answer leaves the pack

One repository per microservice is the normal shape, so each service analyzes
into its own pack. That pack knows its code sends `GET /owners/{ownerId}`
**somewhere** and stops there. The route it calls is not a route it serves, so
the lane put an outbound endpoint node in the graph and an `UNRESOLVED`
`CALLS_HTTP` edge onto it, and no mode walks an `UNRESOLVED` edge. The chain
ends with "leaves the pack", which is the honest answer for one pack alone.

A **crossing** is what happens when the server holding that pack also holds the
project that answers the route: the same walk continues over there, and the rows
it brings back carry `project`. The packs are untouched — the join is made when
the question is asked, from the small `routes.json` index `analyze` writes
beside each pack.

**A name is what settles a tie.** Two projects can serve `GET /owners`, and the
path cannot tell them apart. What can is the name the CALLER wrote: the host of
a Java client's url, or the service a gateway route forwards to. Both are read
out of the tree rather than typed in — `cascade init` takes the service's own
`spring.application.name` into `profile.serviceNames`, and a gateway's
`spring.cloud.gateway` route table into `profile.gatewayRoutes`, where each
entry carries the deployable it forwards to. With a name on the call and a name
on the project, one candidate is picked and crossed at `SOUND_SET`; without one,
every candidate is crossed at `HEURISTIC` and the answer says it was ambiguous.

**A crossing is never better than a candidate.** Which deployable answers the
service name `customers-service` is not a fact about anybody's source: it is a
fact about a deployment, and no line of code states it. So a crossing is
`SOUND_SET` at best, `HEURISTIC` when either side's HTTP method was not readable
or when more than one registered project serves the route, and it weakens the
path grade of every row below it exactly as any other edge does. A table reached
through a crossing is a table this request **may** reach, which is the same claim
a `MAY_CALL` makes one lane in.

**An unmatched call is listed, not swallowed.** A call that no registered
project serves leaves the chain exactly where it was before — and the answer
names it in `federation.unmatched` with how many projects were asked. On a
server that serves one project the whole list is still there, because the
remedy is "register the project that serves these", and a reader who never sees
the list cannot know to do it. The same rule covers a project that could not be
asked at all: a project with no route index beside its pack is named in
`federation.skipped`, with `cascade analyze` as the fix.

**The route the request ENTERED is a row of its own.** A crossing lands on a
route in the other project, and the walk over there starts at it, so nothing
below draws it. Left out, a screen whose call is answered next door showed an
empty endpoint lane beside a note about a connection this mode does not trust,
which reads as "this screen calls nothing". So each crossing's target route is
an `endpoints` row carrying `project`, `federated`, `viaHttp`, the crossing's
grade and the hop it was entered at. It is not counted in this project's own
endpoint census: `walk` and `layers` describe this project's walk, exactly as
they do for the tables.

**"0 of 9 screens reach a table" is a true sentence about one pack and a false
one about a product.** On a gateway whose every request is answered elsewhere,
those nine screens end at real columns one HTTP hop away. `overview.reach`
therefore carries `viaFederation: {screens, endpoints}` — how many of this
project's screens and routes reach a table in a **connected** project — and the
page says both numbers under the dial (`0 here, 8 in connected projects`). The
dial itself stays this project's own ratio, because that is what a share of this
project means. The block is absent on a single-project server and when nothing
this project calls lands on a table, so its absence reads as "nothing crosses"
rather than "we did not look".

**A picture crosses, and it is still one project's picture.** The whole-pack
views (`map`, `erd`) follow the same crossing rules, with one more of their own:
they add only what **this project's requests reach**, never the other pack. Two
services share no foreign key, so a relationship line drawn between them would
be an invention rather than a finding, and a merged picture of two real
services is unreadable before it is wrong. So the route this project called is
drawn, what that route reaches over there is drawn under it, and the only thing
joining the two clusters is the HTTP call itself.

The wire shapes, `basis.siblings`, the `federate` argument and the rest are in
[mcp.md](mcp.md).
