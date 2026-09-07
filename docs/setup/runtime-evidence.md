# Runtime evidence (execution traces)

Every other lane in this engine reads **source**. This one reads what a running
system **did**, and lays it over the graph the source produced.

It exists because of one wall the source cannot get past. When a controller
calls `brandService.listBrand()`, the source names an **interface**. Which class
answers is decided at run time by Spring, and the honest reading of that call is
therefore a **candidate set**, graded `SOUND_SET`, even when the project has
exactly one implementor. That is not pessimism: a `@Transactional` proxy, a
MyBatis interceptor, an `@DS` datasource switch and an `<if>` in the SQL can each
make the class that really runs differ from the one a compiler would name. A
mapper interface goes further still and has **no implementor in the source at
all**, because MyBatis writes it while the application starts.

A trace resolves exactly that. It observes which implementation handled a
request and which statement it ran, so the candidate set gets a member's name
next to it, and the statement binding gets a witness. Nothing else about the
graph changes.

## The rule that governs the whole lane

**Observed once is not always.** A trace proves a path *can* happen and never
that it is the only one, so:

- **It never raises a grade.** A confirmed edge keeps the grade it had and gains
  `observed: true` and a count beside it. `SOUND_SET` plus observed is still
  `SOUND_SET`. There is no state in this engine where a trace makes an answer
  claim more than the static reading did.
- **It never removes or downgrades an unobserved candidate.** A four-implementor
  dispatch where the trace saw one still has all four in the graph. The one that
  ran is marked, the other three are not, and none of them is touched.
- **What it adds is shown and never walked.** A hop the trace saw and no static
  rule explains becomes a `MAY_CALL` edge graded `RUNTIME_ONLY`, which sits below
  the floor of every query mode, so no chain, impact or census walk follows one.
- **Coverage is only what was exercised**, and the answer says so. Every response
  carries a `basis.runtimeEvidence` block naming the traces, the span count and
  the window, so a reader who sees no mark on a row knows it means "this capture
  did not visit it" rather than "nothing runs here".
- **It is never discovered.** `--otel <file>` or the profile's
  `runtimeEvidence.otel` is a person saying "I captured this on purpose".
  Nothing scans the tree for a trace, because a JSON file that happens to be
  lying around must not get to decide what this pack claims ran.

## What it needs

An **OpenTelemetry trace export in OTLP/JSON** — the `resourceSpans` shape a
collector's file exporter writes, and what a Jaeger or Tempo API export gives
you. Nothing else: no agent of ours, no network at analysis time, no database.

```
cascade analyze --root . --otel evidence/checkout-smoke.json
```

Repeat `--otel` for several captures. They are folded together, so two traces of
the same chain make one mark with the sum of both counts on it.

## How to capture one

The usual source is the **OpenTelemetry Java agent** under a run you control: an
integration test suite, a smoke run, or a slice of staging traffic. Out of the
box it writes HTTP server spans and JDBC spans, which is enough for the endpoint
and statement joins. The **dispatch** join needs method spans as well, and there
are two ways to get them:

- annotate the methods you care about with `@WithSpan`, or
- turn on the agent's method instrumentation for the packages you care about
  (`otel.instrumentation.methods.include`), naming the classes and methods to
  trace.

Then export to a file:

```
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.traces.exporter=otlp \
     -Dotel.exporter.otlp.protocol=http/protobuf \
     -Dotel.service.name=storefront-api \
     -jar app.jar
```

and have your collector write the OTLP/JSON out with a **file exporter**. A
Jaeger or Tempo export of the same trace is the same shape and reads the same.

Capture what you want to be able to say something about. A five-minute smoke run
over the screens that matter is far more useful here than a day of traffic,
because the value of this lane is in the chains it confirms, not in the volume it
holds.

## What is read off a span

Three attribute shapes carry something this lane can use. A span carrying none
of them is counted as **unusable** and never guessed at.

| what it says | attributes read |
| --- | --- |
| a method ran, in a named concrete class | `code.namespace` + `code.function` (or `code.function.name`) |
| a statement ran | `db.statement` (or `db.query.text`) |
| an endpoint was exercised | `http.route` (or `http.target`) + `http.method` (or `http.request.method`) |

Both the older and the newer spelling of each are accepted, because which one you
get depends on the agent version and not on your code.

## What is joined to what

**Dispatch.** A method span running inside another method span says "the callee
ran inside the caller". That is looked for in the graph in two shapes, in order:

1. a direct `caller --MAY_CALL--> callee` edge. The static lane already had it,
   so it is marked observed and its grade is untouched;
2. `caller --MAY_CALL--> interface#m --MAY_CALL--> callee`. **This is the one
   that matters.** That two-hop shape *is* the interface-dispatch candidate set,
   and the trace has just named which member of it ran. Both hops are marked
   observed, and both keep their `SOUND_SET` grade.

Only when neither shape exists, **and** the trace nested the two spans directly,
**and** this pack already holds both symbols, is a new `MAY_CALL` edge written
graded `RUNTIME_ONLY`. That edge says the callee **ran inside** the caller, not
that the source calls it, which is the honest reading of a nesting: a Spring
aspect wrapping a controller is exactly this shape, and no line of source states
it. Anything else the trace saw is **counted as unmatched**, with the key it
could not place, because a symbol this pack never read is not a symbol this lane
may invent.

**Statements.** A span carrying SQL is attributed to the mapper method it ran
under, and the statement node `owner.method` is marked observed together with the
`IMPLEMENTS_STMT` edge into it. The tables the SQL really named are recorded on
the node as `observedTables`, **beside** the statically derived `EXECUTES` edges
and never instead of them: a table that dynamic SQL or an `@DS` switch chose at
run time is a finding to show, not a correction to apply.

**Endpoints.** A server span's route is matched against the routes this pack
serves, by exact path first and then through the route template, so
`/brand/detail/12` reaches `/brand/detail/{brandId}`. The endpoint node is marked
observed.

## What never enters the pack

No payload, and no SQL text. A statement's SQL is read for the **table names** in
it and then dropped; bound parameters are not read at all. What a trace
contributes to a pack is a set of `observed` marks, counts, table names, the
trace file's name, and the time window. A trace taken from a running system
therefore carries none of that system's data into the analysis.

The trace file's **content hash joins the facts index**, the way every other
input to a pack is content-addressed, so a pack and the capture it was built from
can never disagree about which capture is being claimed, and the same trace
always produces the same pack digest.

## What you see afterwards

The run prints its census:

```
Runtime evidence: 1 trace(s), 10 span(s) (1 carried nothing this lane reads), 7 observation(s):
  3 dispatch, 1 statement and 2 route observation(s) matched this pack, 1 matched none
Runtime evidence: 4 static edge(s) marked observed (1 a call the source states,
  1 a candidate set the trace narrowed), 1 RUNTIME_ONLY edge(s) added for a hop no
  static rule explains, 1 statement(s) and 2 route(s) observed
Runtime evidence: a grade was neither raised nor lowered by any of this.
  What the trace did not visit is unknown, not absent
```

and, in the answers:

- `flow` rows carry `observed: true` on the method and statement rows a trace
  saw, and on the `link` of a step whose whole run was observed;
- `endpoint_impact` rows carry `observed: true` on a route that really served a
  request;
- `overview` carries a `runtime-evidence` gap saying how much was confirmed, how
  many candidate sets were narrowed, and that nothing was promoted;
- every response carries `basis.runtimeEvidence` with the source, the span count
  and the window, because an `observed` mark is only readable next to the
  coverage it came from;
- the census itself is on `meta.laneStats.otel`.

## The profile key

```json
{ "runtimeEvidence": { "har": [], "otel": ["evidence/checkout-smoke.json"] } }
```

Paths are relative to the manifest directory. `runtimeEvidence.otel` is read when
`analyze` runs **without** `--otel`, and the flag wins when both are present.

## What this lane does not do

It does not run your application, does not require production access, and makes
no attempt to resolve anything the trace did not carry. It does not make the
graph complete: it makes the **exercised** paths observed, and says which those
were.

Related: [the web lane and browser recordings](web-lane.md),
[the CLI reference](../cli.md), [한국어](../ko/setup/runtime-evidence.md)
