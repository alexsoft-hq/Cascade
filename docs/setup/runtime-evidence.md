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

An **OpenTelemetry trace export**, in either of the two shapes a real capture
comes in:

- an **OTLP/JSON document** (`{"resourceSpans": […]}`) — what a collector's file
  exporter writes, and what a Jaeger or Tempo API export gives you;
- the **application's own log**, when the Java agent exports with
  `logging-otlp`. That is not a document: it is one `ResourceSpans` object per
  export batch, each on a line behind the logger's own prefix, in among
  everything else the app printed.

Which one a file is, is decided by **reading it**, not by its extension, so both
go in the same way. A line the reader cannot use is skipped and counted, never
fatal. Nothing else is needed: no agent of ours, no network at analysis time, no
database.

```
cascade analyze --root . --otel evidence/checkout-smoke.json
cascade analyze --project petclinic --otel evidence/petclinic.log
```

Repeat `--otel` for several captures. They are folded together, so two traces of
the same chain make one mark with the sum of both counts on it.

## The recipe, end to end

The numbers further down came out of a real run of this: spring-petclinic, the
official Java agent, a handful of `curl` requests, no code change to the
application and no collector. One thing about that run differs from the recipe
and is called out in step 5, because it is the reason two hops came back
`RUNTIME_ONLY`.

### 1. Get the agent

One download from the OpenTelemetry release page, and nothing else:

```
curl -L -o opentelemetry-javaagent.jar \
  https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
```

### 2. Ask the pack which methods to instrument

Out of the box the agent gives you HTTP server spans, Spring Data repository
spans and JDBC spans. That fills the **route** and **statement** joins on the
first run and leaves **dispatch at zero**, because no controller and no service
method has a span, so no method span ever nests inside another one.

The agent will add them, and it wants **explicit method names**. `pkg.Class[*]`
is not a name: the wildcard matches nothing and the capture comes back as empty
as before. The names it wants are the handlers and the methods that reach a
statement, which is exactly what the pack already holds:

```
cascade otel-methods --project petclinic
```

It prints one line on stdout, ready to paste:

```
org.springframework.samples.petclinic.owner.OwnerController[findOwner,findPaginatedForOwnersLastName,initCreationForm,…];org.springframework.samples.petclinic.owner.OwnerRepository[findById,…];…
```

On petclinic that is 32 methods in 10 classes. On a large project it is tens of
thousands of characters, which a shell will still carry but a `.properties` file
or a JVM argument file reads more comfortably.

### 3. Run it once, with traffic

```
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=petclinic \
     -Dotel.traces.exporter=logging-otlp \
     -Dotel.metrics.exporter=none \
     -Dotel.logs.exporter=none \
     -Dotel.bsp.schedule.delay=1000 \
     "-Dotel.instrumentation.methods.include=$(cascade otel-methods --project petclinic)" \
     -jar target/spring-petclinic-4.0.0-SNAPSHOT.jar > petclinic.log 2>&1
```

`logging-otlp` writes the spans into that log, so there is no collector and no
port to open. `metrics` and `logs` are off because this lane reads neither.
`bsp.schedule.delay=1000` makes the agent flush every second instead of every
five, which matters for a run that only lasts a minute.

Then send the traffic you want to be able to say something about — an
integration suite, a smoke script, or a slice of staging. The capture below is
thirteen `curl` requests over the screens petclinic has, of this shape:

```
curl -s localhost:8080/ > /dev/null
curl -s "localhost:8080/owners?lastName=" > /dev/null
curl -s localhost:8080/owners/1 > /dev/null
curl -s localhost:8080/vets.html > /dev/null
```

Then **stop the application**, so the last batch is flushed into the log before
the process exits.

A five-minute smoke run over the screens that matter is worth far more here than
a day of traffic: the value of this lane is in the chains it confirms, not in the
volume it holds.

### 4. Feed the log in

The log goes in as it is. There is no wrapping step and no `jq`:

```
cascade analyze --project petclinic --otel petclinic.log
```

The run says how it read the file and then prints its census:

```
Runtime evidence: petclinic.log was read as an agent log, one export per line: 169 span(s) in it, 56 line(s) carried none
Runtime evidence: 1 trace(s), 169 span(s) (25 carried nothing this lane reads), 31 observation(s):
  5 dispatch, 9 statement and 10 route observation(s) matched this pack, 7 matched none
Runtime evidence: 8 static edge(s) marked observed (3 a call the source states,
  0 a candidate set the trace narrowed), 2 RUNTIME_ONLY edge(s) added for a hop no
  static rule explains, 5 statement(s) and 10 route(s) observed, window
  2026-09-08T00:39:16.236Z to 2026-09-08T00:39:18.252Z
Runtime evidence: a grade was neither raised nor lowered by any of this.
  What the trace did not visit is unknown, not absent
```

Read it as three questions:

- **what was in the file** — how many spans, and how many carried no attribute
  this lane reads (the framework's own spans, a transaction commit, a Hibernate
  session);
- **what joined** — how many observations matched a symbol, a statement or a
  route this pack holds, and how many matched none. The 7 that matched none here
  are JDBC spans from Hibernate's schema bootstrap and its lazy loads, which ran
  under no repository method, so there is no statement to attribute them to and
  none is guessed at;
- **what was written** — marks on edges that already existed, and the hops that
  had to be added.

### 5. What it gets you

On spring-petclinic, from the run above:

| | observed |
| --- | --- |
| routes exercised | 10 of 17 |
| statements run | 5 of 6 |
| dispatch hops confirmed | 3 (`showOwner` → `findById`, `processCreationForm` → `save`, `showResourcesVetList` → `findAll`) |
| hops added as `RUNTIME_ONLY` | 2 |

The two added hops were `OwnerController#processFindForm` →
`OwnerRepository#findByLastNameStartingWith` and `VetController#showVetList` →
`VetRepository#findAll`. Neither is a call the source makes: both controllers go
through a **private helper** (`findPaginatedForOwnersLastName`, `findPaginated`)
that this capture did not instrument, so the trace saw the controller directly
over the repository and the lane recorded exactly that, without inventing a
static edge.

**That is what a `RUNTIME_ONLY` hop usually means: an intermediate method you did
not instrument.** This capture was taken with a hand-written list of the route
handlers only, which is the difference from step 2 above. `cascade otel-methods`
names both helpers as well, because both reach a statement, and all four hops
around them (`processFindForm` → `findPaginatedForOwnersLastName` →
`findByLastNameStartingWith`, and the same shape on the vet side) are edges the
static graph already holds. So a capture taken with that list has a span on the
helper, the observations key onto those edges, and there is no hop left for the
lane to add.

### 6. Read the marks for what they are

**Observed once is not always**, so a mark is drawn **beside** a grade and never
above it. A route with no mark on it was **not visited by this capture**, which
is not the same as "nothing runs there": coverage is only what was exercised, and
every answer carries `basis.runtimeEvidence` naming the traces, the span count
and the window, so a reader can tell the two apart.

**And nothing of yours enters the pack.** A statement's SQL is read for the table
names in it and then dropped, bound parameters are not read at all, and no
payload is touched (*What never enters the pack*, below).

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

Beside the census the run prints (step 4 above), in the answers:

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
