# Java lane (source) setup

The Java lane lifts the answer from the SQL statement level up to the **HTTP
endpoint** level: it parses a Spring/MyBatis Java source tree and stitches
`endpoint → controller → service → mapper` onto the SQL lane's
`mapper → statement → table → column`. A column-impact query then reaches the
endpoints that touch the column.

## What it needs

- **A JDK (javac + java), version 17 or newer.** The lane uses the JDK's own
  compiler Tree API (`com.sun.source`) in **parse-only** mode — it never runs a
  build, never resolves your project's dependencies, and needs no Gradle/Maven.
  It parses your `.java` files with Spring/MyBatis absent and resolves app-local
  types itself. No JDK jars beyond the standard `jdk.compiler` module.
- Nothing else. No classpath, no `pom.xml`/`build.gradle` resolution.

### Point the CLI at a JDK

The CLI looks for `javac`/`java` in this order:

1. `$JAVA_HOME/bin`
2. `/opt/homebrew/opt/openjdk/bin`, `/usr/local/opt/openjdk/bin` (Homebrew keg)
3. `javac`/`java` on `PATH`

Install one if you have none:

```bash
# macOS
brew install openjdk
export JAVA_HOME=/opt/homebrew/opt/openjdk   # or add its bin to PATH

# Debian/Ubuntu
sudo apt-get install default-jdk
```

## Run it

Add `--java-src <dir>` (repeatable) to `cascade analyze`. Point it at your
backend source roots:

```bash
node bin/cascade.mjs analyze \
  --ddl      ../target-examples/mall/document/sql/mall.sql \
  --mappers  ../target-examples/mall/mall-mbg/src/main/resources \
  --mappers  ../target-examples/mall/mall-admin/src/main/resources/dao \
  --java-src ../target-examples/mall/mall-admin/src/main/java \
  --java-src ../target-examples/mall/mall-mbg/src/main/java \
  --root ../target-examples/mall --out .cascade/pack --project mall
```

The first run compiles the worker (`adapters/java/JavaFacts.java`) into
`.java-build/` (gitignored) and reuses it thereafter. The pack's `meta.lanes`
records `["sql","java"]` when the Java lane ran.

Then ask, over MCP:

```
endpoint_impact { "column": "pms_product.price" }
→ POST /product/create, POST /product/update/{id}, …  [SOUND_SET]
```

## What it does — and its honest grade

| Relation | Grade | Why |
|---|---|---|
| `endpoint → handler` (HANDLES) | **EXACT** | a Spring mapping annotation on a **concrete controller** method *is* its handler — definitional |
| `endpoint → implementer` (HANDLES) | **SOUND_SET** | a mapping on an interface/abstract *declaration* is a route **contract**; the handler is the implementer matched through `implements` by name (and arity) — a resolution, not a definition |
| `clientMethod → endpoint` (CALLS_HTTP) | **SOUND_SET** | an HTTP client call reaches a route this pack also serves — the internal HTTP hop. Two ways of writing one: a `@FeignClient`/`@HttpExchange` method, and an imperative `WebClient`/`RestClient`/`RestTemplate` call |
| `clientMethod → endpoint` (CALLS_HTTP) | **UNRESOLVED** | …or one it does not serve: the target is outside the pack, so no walk follows the edge and it is counted instead (`httpCallsUnresolved`) |
| `mapperMethod → statement` (IMPLEMENTS_STMT) | **EXACT** | a MyBatis statement id *is* the mapper interface FQN + method — definitional |
| `caller → callee`, `interface → impl` (MAY_CALL) | **SOUND_SET** | calls are resolved from the parse tree (receiver → field → declared type, method-by-name) and interface dispatch is a class-hierarchy over-approximation — a sound candidate set, **not** compiler-verified |
| `repositoryMethod → statement` (IMPLEMENTS_STMT) | **EXACT** | a Spring Data repository method *is* the statement Spring Data generates for it — definitional, same rule as MyBatis |

So an endpoint reached **through the call graph** carries the weakest link on
its path — **SOUND_SET** — and is reported as a candidate, never as confirmed.
This is deliberate: parse-only resolution without dependency binding cannot
honestly claim EXACT for a call, and narrowing a candidate set to one member
would not make it one.

### Which calls the lane can see

Every resolved call shape, all by NAME, all graded SOUND_SET:

| written as | `evidence.rule` | resolved to |
|---|---|---|
| `repo.save(x)` | `field-receiver` | the declared type of the field `repo` |
| `this.repo.save(x)` | `this-field` | the same field — the `this.` spelling is not a different call |
| `helper(x)` (unqualified) | `unqualified-enclosing` | a method of the **enclosing type** (or one it inherits) |
| `this.helper(x)` | `unqualified-enclosing` | the same thing — one call, one rule |
| `super.exportXls(…)` | `super-enclosing` | the first ancestor up the `extends` chain that **declares** the method |
| `service.list(…)` where `service` is typed by a **type parameter** | `type-param-binding` | the binding **that subclass** makes (`class C extends B<A, IAService>`), one edge from the subclass's own copy of the method, with `evidence.boundThrough` naming where the binding was spelled and `evidence.inheritedFrom` naming the shared body the call site is in |
| an interface method | `interface-dispatch` | every implementor (a class-hierarchy over-approximation) |
| `log.info(…)` in a `@Slf4j` class | `generated-field` | the logger type that Lombok's annotation generates (`org.slf4j.Logger` …). The field is real at run time and in no parse tree, so nothing but the annotation can explain the receiver |
| `ringData.computeIfAbsent(…)` where the field's type came in through `import java.util.*` | `wildcard-jdk` | `<that package>.<Simple>`. The JDK is a closed world this lane never reads, so the call leaves the project |

#### Which name means which type

A simple name is resolved the way the language resolves it, in this order:

1. a **member type in scope** — this type's own nested types, then each
   enclosing type's. A nested class has no compilation unit of its own, so its
   imports are the top-level type's;
2. a **single-type import** of the file;
3. the **same package**;
4. an **on-demand import** whose package holds a type this lane analyzed;
5. **`java.lang`**, which every compilation unit imports whether it says so or
   not (`String`, `System`, `Integer`, `Math`, `Thread` …);
6. a globally **unique** simple name — this engine's own last resort, and the
   only step the language does not have.

Step 5 sits where it does because that is the language's precedence: a project
class called `Process` in another package is not what `Process.x()` means in a
file that never imported it.

When a name is left over and the file carries wildcard imports, which one it
came from is decided by the **project's own import lines**: somewhere in a tree
this size another file writes `import org.jeecg.common.util.RedisUtil;`, and
that line proves which package holds that type. Only when nothing witnesses the
name does the category decide (a package of this project first, then the JDK).

#### What is left, and why

Three of the rules can fail in their own way, and the failure is named for what
failed rather than folded into the field rule:

| `unresolvedCallsByRule` key | means |
|---|---|
| `super-enclosing` | `super.m()` whose base class this lane neither parsed nor could name (measured on jeecg-boot: 3 of 73 `super.` calls; 40 more name a base the imports do name, and those become an edge that leaves the project) |
| `type-param-unbound` | no subclass in this pack binds that type parameter, so the call site has no callee here |
| `inherited-field` | a receiver no field, no type and no annotation explains |

…and beside the rule that failed, `unresolvedCallsByReason` says what was
**missing**, which is the half a reader can act on:

| `unresolvedCallsByReason` key | means |
|---|---|
| `project-type-outside-roots` | a wildcard import names a package of this project and no analyzed source root holds the type. **Pass `--java-src <module>/src/main/java`** and the calls resolve — or the module is a dependency, and the chain really does end there. `laneStats.typesOutsideRoots` names the packages |
| `superclass-outside-roots` | the `extends` chain ended at a name this lane could not resolve at all |
| `type-param-unbound` | as above |
| `unknown` | a third-party type behind a wildcard, a constant somebody static-imported, a field a code generator adds after parsing |

`type-param-binding` is an over-approximation of **one call site**, not a guess,
and it is resolved **once per subclass**. A generic base writes
`service.list(…)` once and thirty controllers run it, so the answer is thirty
separate edges, each leaving the controller that runs that body and naming the
one service that controller binds. Pooling them on the base method instead is
the same set of targets attached to the wrong symbol, and it reads as every
controller touching every sibling's tables: on jeecg-boot that was 9748 of
25376 endpoint-to-column pairs.

Which subclass carries the edge is read from the code, never assumed:

- a subclass that **inherits** the method outright has no body of its own, so
  the ancestor's is what runs. The member is instantiated for that class (see
  `inherited-member-call`) and the copy carries the call;
- a subclass that **overrides** it carries the call where it writes
  `super.exportXls(…)`, which is also what says WHICH base method runs —
  jeecg-boot's `JeecgDemoController#exportXls` calls `super.exportXlsSheet(…)`,
  a different method with a different body;
- an override that never calls `super` replaced the body, so the ancestor's
  call site is not in it and no edge is made.

**Every MAY_CALL edge carries its rule** in `evidence.rule`, with a one-sentence
`evidence.basis` saying what that rule actually did. They share one grade
(SOUND_SET — none is compiler-verified) but they do not share one failure mode,
and a reader deciding how far to trust a chain is entitled to know which one it
rested on.

The unqualified rule is what keeps a chain alive through a controller's private
helper: `processFindForm` → `findPaginatedForOwnersLastName` → `owners.find…`.
A name brought in by an `import static` is **not** treated as a call on the
enclosing type — it is skipped rather than mis-attributed.

**How often does the unqualified rule misattribute?** It resolves to the
enclosing type, so a method that type INHERITS is attributed to the subclass
rather than to the class that declares it. Measured over every one of the 8753
unqualified call sites in macrozheng/mall (8752 bare + the one written
`this.loadDataSource()`, whose method its own class declares), by checking
whether the method is declared in the enclosing type's own file:
**153 misattributed, 1.7%** — 152 of
them `getClass()`/`hashCode()` inherited from `java.lang.Object`, and one real
case (`CommentGenerator#addFieldJavaDoc → addJavadocTag()`, inherited from
MyBatis-generator's `DefaultCommentGenerator`). In hand-written code — the 141
sites outside generated `…Example`/`.model.` classes — the rate is **1 of 141**.

### A mapping annotation is not always a handler

`@GetMapping("/sys/api/getUserById")` on a method is not, by itself, evidence
that this project *serves* that route. The lane classifies it by the **enclosing
type** first:

| enclosing type | what the mapping means |
|---|---|
| a concrete class annotated `@RestController` / `@Controller` | it **serves** the route — HANDLES, EXACT |
| an interface annotated `@FeignClient` (or a class-level `@HttpExchange`) | it **calls** the route over HTTP — CALLS_HTTP, never HANDLES |
| a plain interface or abstract class | it **declares** the route for an implementer to serve — a route *contract* |
| anything else (a concrete class with no controller annotation) | unchanged: it serves the route, so a controller marked by a meta-annotation this engine does not know still gets its routes |

Why this matters, measured on jeecgboot/JeecgBoot: it ships a `local` and a
`cloud` flavour of the same API, and the cloud flavour is `@FeignClient`
interfaces whose methods carry the *same* mapping annotations as the controllers
that answer them. Read as declarations, **107 routes came back with two
handlers** — one of which was the caller. Classified, every route has exactly
one handler, and the 116 mapped methods across the 6 `@FeignClient` interfaces
become 116 CALLS_HTTP edges: 107 to a route this pack also serves, 9 to a route
it does not.

### An imperative client call is an HTTP hop too

Most service-to-service traffic is not annotated at all. It is a fluent chain or
a `RestTemplate` request, where the verb is a method name and the url is an
argument somebody built:

```java
webClient.get().uri("http://customers-service.invalid/owners/{ownerId}", ownerId).retrieve()
restClient.post().uri(baseUri + "/owners/" + id + "/pets").retrieve()
restTemplate.exchange(url, HttpMethod.POST, body, Result.class)
```

The lane reads all three, and reads the url only as far as one file allows: a
literal, a literal with `{…}` placeholders, or a `+` whose literal halves are
kept and whose base is **named** rather than resolved. A `scheme://host` is
stripped off the front and the host is kept as evidence, because it is usually
a logical service name a discovery server resolves, not a machine. The path is then
matched against the routes this pack serves — exactly, then by template, so a
call that interpolates an id lands on the route whose `{ownerId}` stands where
the value went — and the profile's `gatewayRoutes` rewrites the prefix first, the
same declaration the web lane applies to a frontend call.

A url the lane could **not** reduce to a path (a bare variable, a fully computed
string) draws **no edge at all** and is counted (`httpCallsUrlUnreadable`). A
route nobody wrote is not put in the graph to stand in for one. A call whose
verb was an argument the lane could not read is matched on the path alone and
graded HEURISTIC, below the conservative floor.

Measured on spring-petclinic-microservices, five services in one repository with
no `@FeignClient` anywhere: **0 CALLS_HTTP edges before this rule, 6 after** —
the gateway to `GET /owners/{ownerId}` and `GET /pets/visits`, the genai service
to `GET /vets`, `GET /owners`, `POST /owners` and `POST /owners/{ownerId}/pets`,
every one of them SOUND_SET. The gateway's own route then reaches the customers
and visits tables through the hop instead of stopping at the service boundary.

Which deployable actually answers a client call is **not knowable from source**,
so it is never claimed. The annotation's service name and url ride as evidence —
with `evidence.serviceLiteral` saying whether the source spelled a string or
named a constant (`ServiceNameConstants.SERVICE_SYSTEM`, which a parse-only
worker cannot resolve) — and the grade says only what was checked: SOUND_SET
when a route with that method+path is in the pack, UNRESOLVED when none is.

A route contract nobody in the pack implements is still emitted, with
`contractOnly: true` on the endpoint node, so a census can say "N routes are
declared by an interface nobody implements here" instead of dropping them.

### The internal HTTP hop

A CALLS_HTTP edge to a route this pack *serves* is a real step of a real
request: `clientMethod --CALLS_HTTP--> route --HANDLES--> handler`. Both walks
cross it — `flow` in either direction, `map`, `coupling`, `overview` reach,
`endpoint_impact` and `changed_impact` — and every row reached that way is
marked `viaHttp: true` with `httpHops`, because the code on the far side belongs
to another deployable and must not read as one call stack. The hop costs two
real steps of depth; nothing teleports.

A route the pack only *calls* is marked `outbound: true` on the node. It is not
one of the pack's endpoints: the per-endpoint census skips it (it would be an
endpoint reaching nothing, which is somebody else's endpoint), `overview`
reports it as `reach.outboundEndpoints` and names it in `gaps`
(`http-calls-leaving-pack`), and the two numbers always add up to the endpoint
node count.

### The page a handler renders

A `@Controller` that is not a `@RestController` and carries no class-level
`@ResponseBody` answers a request by naming a **view**, and a template engine
turns that name into the page the browser gets. The worker records one `view`
record per handler:

```json
{ "kind": "view", "owner": "com.example.OwnerController", "method": "initFindForm",
  "paramCount": 1, "unresolved": 0,
  "views": [{ "name": "owners/findOwners", "kind": "view", "from": "literal" }] }
```

Four places a name is read from, and one honest gap:

| `from` | what it read |
|---|---|
| `literal` | a returned string literal, and every literal leaf of a returned ternary |
| `model-and-view` | `new ModelAndView("x", …)` |
| `set-view-name` | `mav.setViewName("x")` |
| `constant` | a `static final String` field of the **same class**, initialised with a literal |
| `helper` | a **private or package-private method of the same class** whose every return is such a literal or such a field. The method's name is on the record |

A `redirect:` or `forward:` prefix becomes the record's `kind` rather than part
of the name, because what it names is a ROUTE and not a page.

The last two rows are what makes this useful on real controllers, and neither
resolves anything across a file. `private static final String
VIEWS_OWNER_CREATE_OR_UPDATE_FORM = "owners/createOrUpdateOwnerForm";` has its
value on the line that declares it, and `return addPaginationModel(page, …)`
calls a method of the same class whose returns are right there. Measured on
jpetstore-6, where every controller uses the constant idiom: 10 view names
before this rule, 16 after, and zero unread returns. Two guards keep them
honest:

- the helper is read **one level deep**. A return inside it that is itself a
  call is not followed, and the whole helper is then unreadable rather than
  half-read;
- **two methods of one name** are read as neither. Which overload a call reaches
  depends on the argument types, and this worker does not resolve types.

A helper with several literal returns gives several views, exactly as a ternary
does. Anything else a returned name could be — a field of a superclass, a method
somebody overrides, a constant from another file, a local variable — is **not**
resolved. That is a data-flow or a cross-file question this parse-only worker
does not answer, so it is counted in `unresolved` and the run says how many
pages it could not name. The one exception is the ModelAndView idiom:
`ModelAndView mav = new ModelAndView("x"); … return mav;` names the page on the
line that builds the object, so the bare `return mav` is not counted as a gap.

A method carrying `@ResponseBody`, and every method of a `@RestController`,
answers with a body and has no view at all: no record, not an empty one.

Which FILE `owners/findOwners` means is not the worker's business. That depends
on the view resolver's prefix and suffix, which are the project's configuration;
`src/core/discover.mjs` reads them and `src/adapters/web_bridge.mjs` joins the
two into a screen. See [the web lane](web-lane.md) for the page end of it.

### Known limits (measured on macrozheng/mall)

- A method call whose receiver is a **local variable or parameter** (not an
  instance field) is not resolved — the worker counts these
  (`skippedLocalReceivers` on its own header, 4786 on litemall) and emits
  nothing rather than guessing. **A chain that passes through one of them is not
  in this graph.** The number is a per-run tally on the worker's header, which
  the per-file fact shards do not carry, so the pack cannot report it yet.
- A call to a type the source tree never contains (a third-party library) whose
  **name the file imports** is an edge that leaves the project, counted under
  `externalCalls`; the walks stop there, which is where the chain really stops.
  A call whose target this lane could not name at all is **unresolved**
  (`unresolvedCalls`, split by `unresolvedCallsByReason`) — no dependency
  classpath is consulted either way.
- An unqualified call to an **inherited** method is attributed to the enclosing
  type, not to the class that declares it — a name-resolution over-approximation,
  which is why the edge is SOUND_SET and its evidence says so.
- Reflection, AOP proxies, and runtime wiring are out of scope (that is the
  `RUNTIME_ONLY` axis, not built).

## JPA / Spring Data

When the Java lane runs and the profile declares the `jpa` framework pack (which
`cascade init` does for you the moment it counts an `@Entity` file), a second
bridge maps persistence that is **declared in the mapping** rather than written
as SQL.

### What it resolves

| From | To | Grade |
|---|---|---|
| `@Entity` + `@Table(name="owners")` | the table `owners` | **EXACT** — the source says so |
| `@Entity` with no `@Table` | the table the naming strategy gives | **EXACT** if `jpa.namingStrategy` is declared, else **HEURISTIC** |
| `@Column(name="visit_date")` | that column | **EXACT** |
| a field with no `@Column` | the column the naming strategy gives | as above |
| `@Id` | the primary-key column | **EXACT** |
| `@ManyToOne`/`@OneToOne` + `@JoinColumn(name=…)` | that foreign-key column, plus a `JOINS` edge | weakest of the two entity mappings |
| `@OneToMany(@JoinColumn)` | the foreign key on the **target** table, plus a `JOINS` edge | as above |
| `@ManyToMany` + `@JoinTable` | the join table and its two columns, plus two `JOINS` edges | as above |
| `@MappedSuperclass` | its attributes are inherited by every subclass entity | as above |
| a derived query (`findByLastNameStartingWith`) | `select` reading the predicate and ordering columns | as above |
| `@Query` JPQL | the columns its aliases and paths name; `SET` targets are writes | as above |
| `@Query(nativeQuery = true)` | the SQL goes through the **SQL lane's own analyzer** (`lineage.py`), like a MyBatis statement — its JPA bind markers (`?1`, `:name`) are normalized to `?` first, exactly as MyBatis's `#{}` are | EXACT (a real SQL parse) |
| a called-but-undeclared `CrudRepository` method (`save`, `findById`, …) | the rows that method touches | as above |

`save*` writes **every** mapped column of the row (a JPA merge writes the whole
entity) and follows `cascade = ALL/PERSIST/MERGE` associations to the child
rows. `delete*` removes the row and follows `cascade = ALL/REMOVE` the same way.
A cascaded reach is capped at **SOUND_SET**: the cascade is declared in the
source, but whether a given call has a child to write or remove is a runtime
fact. `orphanRemoval` is not read.

### The fetch plan: what a query really reads

A repository method names one entity and reads several tables. Nothing in the
source says so, and the database does it anyway: an association whose fetch is
EAGER comes back in the same round trip, and so does everything eager on the rows
it brought with it. In spring-petclinic, `OwnerRepository.findById` names
`owners` and the running query reads four tables, because `Owner.pets` is
`fetch = EAGER`, `Pet.type` is a `@ManyToOne` (eager unless the mapping says
otherwise) and `Pet.visits` is eager too.

So every statement whose result is an entity carries that closure:

| Rule (`evidence.rule`) | What it followed |
|---|---|
| `jpa-eager-fetch` | an association whose effective fetch is EAGER. `evidence.fetch` says `explicit` when the mapping wrote `fetch = EAGER`, and `default` when it wrote nothing and the JPA specification decided (a to-one is eager, a to-many is lazy) |
| `jpql-join-fetch` | a `JOIN FETCH` / `LEFT JOIN FETCH` in the method's own JPQL. The query overrides the mapping, so this is followed whatever `fetch =` says |
| `jpa-entity-graph` | an `@EntityGraph` attribute path on the method, written out or named through the entity's `@NamedEntityGraph`. Same override, same reason |
| `jpa-cascade` | a `save` or a `delete` reaching a child row through `cascade` |

Every followed edge carries `evidence.path`, the attribute path from the entity
the query returns (`Owner.pets.visits`), so a table nobody expected can be traced
back to the field that brought it. The rule itself is EXACT — the annotation and
the specification decide it, nothing was resolved — and the edge is graded the
weakest link of that and the names the mapping left to the naming strategy, as
every other edge in this lane is.

Three things it deliberately does not do:

- **A LAZY association stays out.** A lazy collection a page touches after the
  query has run is a real read, and it happens where this lane cannot see it: in
  the template, not in the query. Following it would put reads in the answer that
  many requests never make. Each statement that skipped one says so in
  `jpaEvidence.limits`, and `overview` counts them all under
  `jpa.lazyAssociationsNotFollowed`.
- **A `save` follows cascade and not fetch.** A merge writes a row; it is not a
  query whose result somebody reads.
- **The plan stops at eight associations deep**, cycle-safe, with
  `fetch-depth-capped` on the statement when it hit the cap. A path that names no
  association of the entity is reported as `fetch-path-unresolved`, and an
  `@EntityGraph` naming a plan no entity in the pack declares as
  `entity-graph-unresolved`. A nested `@NamedSubgraph` is not read.

### `@ModelAttribute`: the call Spring makes and no line of source writes

Spring runs a controller's `@ModelAttribute` methods before **every** handler of
that controller. Nothing calls them, so nothing led to them, and
`GET /owners/{ownerId}/edit` in spring-petclinic answered no table while a real
agent capture of that request read four: the owner is loaded by
`OwnerController#findOwner`, a `@ModelAttribute("owner")` method.

The lane now draws that edge: `MAY_CALL` from every handler of a
`@Controller`/`@RestController` class to every `@ModelAttribute` method the
**same class** declares, rule `spring-model-attribute`, graded **EXACT** —
nothing was resolved, the framework's own contract says the method runs.

What it does not follow, and counts instead (`laneStats.modelAttribute`):

- a `@ControllerAdvice`'s model attributes (`onAdvice`), because which
  controllers an advice runs for is not a fact about one class;
- model attributes a controller INHERITS from a base class (`onSuperclass`);
- handlers a controller inherits rather than declares (`inheritedHandlers`).

A `@ModelAttribute` on a PARAMETER (`save(@ModelAttribute Owner owner)`) is a
binding, not a method Spring runs, and is never read as one.

### The naming-strategy rule, and how to declare it

Hibernate turns `Owner`/`lastName` into a physical `owners`/`last_name` with a
naming strategy the application configures. This engine does not run your
application, so when the profile is silent it **assumes** Spring Boot's default
(CamelCase → snake_case, lower-cased) and grades every name it derived that way
`HEURISTIC` — which means `endpoint_impact` at the default `conservative` mode
returns **nothing** for such a column, and says why in `limits`.

That is not a bug to work around; it is the engine refusing to present a guess as
a fact. Declare the rule and the same mappings become EXACT:

```json
{
  "frameworkPacks": ["spring-mvc", "jpa"],
  "jpa": { "namingStrategy": "spring-snake-case" }
}
```

- `"spring-snake-case"` — Spring Boot's default (`CamelCaseToUnderscoresNamingStrategy`).
- `"identity"` — the logical name is the physical name (Hibernate's
  `PhysicalNamingStrategyStandardImpl`, what you get with
  `spring.jpa.hibernate.naming.physical-strategy` set to it).
- `null` (the default) — undeclared, assume the Spring Boot default, grade HEURISTIC.

A name the source spells out with `@Table`/`@Column`/`@JoinColumn`/`@JoinTable`
is EXACT either way — the strategy is never consulted for it.

**Invariant I-1, in this lane:** if the derived table name happens to exist in
the DB catalog, that is recorded on the node as `jpaCatalogMatch: true` and
**nothing else**. A coincidence is evidence for a human, not a promotion.

### What it does NOT resolve

- `@Embedded` / `@Embeddable` attributes produce no column (recorded, not guessed).
- `@SecondaryTable`, `@Inheritance` strategies, `@AttributeOverride`,
  `@Convert`, `@ElementCollection` are not modelled.
- Hibernate's own `@Fetch` and `@BatchSize` are not read: they change how a fetch
  is issued, not whether it happens.
- A named query (`@Query(name = "…")`, `@NamedQuery`) is not read.
- `flush()` gets no statement of its own: it writes what the other statements in
  the transaction already made pending.
- A derived name or a JPQL fragment the reader cannot attribute to a column
  leaves the statement **in the graph** with `hasUnresolved: true` and the reason
  on the node — never dropped, never silently empty. `overview` counts them
  (`jpa.unresolvedStatements`) and `cascade analyze` prints them.

## MyBatis-Plus

MyBatis writes its SQL down. JPA writes nothing down but at least declares a
repository *method* per query. **MyBatis-Plus writes down less than either**:

```java
sysUserDepartMapper.selectList(
    new LambdaQueryWrapper<SysUserDepart>().eq(SysUserDepart::getDepId, id));
```

There is no SQL text and no method name to read. The table comes from a global
naming rule applied to the class `SysUserDepart`, the column from the same rule
applied to the JavaBeans property behind `getDepId`, and the verb from the fact
that `selectList` is a method of `BaseMapper<T>` this project never wrote.

Measured on jeecgboot/JeecgBoot, **735 of 969 routes reached no statement at
all** before this lane existed — not because their code touches no table, but
because everything it touches is spelled this way. With it, 717 of 969 do.

Turn it on with `frameworkPacks: ["mybatis-plus"]`; `cascade init` writes that
itself when discovery sees `extends BaseMapper<` or `@TableName` in the tree.
It is **independent of `mybatis-xml`** — a project can have both, and jeecg-boot
does (80 mapper XML files for 65 mappers, generic CRUD for everything else).

### What it resolves

| from the source | to | grade |
|---|---|---|
| `@TableName("sys_user_depart")` | the table | **EXACT** |
| `SysUser` with no `@TableName` | `sys_user` by the naming rule | **EXACT** if `mybatisPlus.namingStrategy` is declared, **HEURISTIC** if assumed |
| `@TableField("dep_id")` / `@TableId("id")` | the column | **EXACT** |
| a field with no `@TableField` | its column by the naming rule | as above |
| `@TableField(exist = false)`, `static`, `transient` | **no column** — MyBatis-Plus does not persist them | EXACT (definitional) |
| a `BaseMapper` / `IService` / `ServiceImpl` built-in a caller reached | one statement per (owner, method) | IMPLEMENTS_STMT **EXACT** — the method *is* the statement MyBatis-Plus generates |
| `X::getY` in a wrapper op | the column the property `y` maps to | the mapping's grade |
| `eq("status", …)` on a `QueryWrapper` | the column `status`, as written | **EXACT** (it is the physical name MyBatis-Plus passes through) |
| `@TableLogic` + any `delete*`/`remove*` | an **UPDATE that writes the flag column** | the mapping's grade |
| `@TableLogic` + any query | a **READ** of the flag column (`evidence.implicitFilter`) | the mapping's grade |

The entity is found through the generic bases, **transitively and with type
substitution** — no project base-class name is hardcoded. jeecg-boot puts its own
`JeecgServiceImpl<M extends BaseMapper<T>, T extends JeecgEntity> extends
ServiceImpl<M, T>` in between, and 24 services extend that; the lane substitutes
`T` down the chain the same way it would for anyone else's base class.

A class is an entity when the source says so in exactly two ways: it carries
`@TableName`, or a `BaseMapper<T>` / `IService<T>` / `ServiceImpl<M, T>` in the
pack names it as `T`. A class that merely carries `@TableField` on a couple of
fields is **not** one — jeecg-boot has six of those, every one a DTO shaped for
a result map, and mapping them would have invented six tables no schema has.

### The verbs, and what each does to the row

| built-in | access | columns |
|---|---|---|
| `insert`, `save`, `saveBatch` | write | every mapped column — MyBatis-Plus writes the **non-null** fields, and which those are is a run-time fact, so all of them are candidates |
| `updateById`, `updateBatchById` | write | every mapped **non-id** column, plus a read of the key |
| `update(entity, wrapper)` | write | the wrapper's `set(...)` columns when one is visible, else every mapped column |
| `saveOrUpdate*` | write | every mapped column, plus a read of the key |
| `deleteById`, `removeById`, `removeByIds`, `deleteBatchIds` | delete (or **write**, under `@TableLogic`) | a read of the key |
| `delete(wrapper)`, `remove(wrapper)` | delete (or **write**, under `@TableLogic`) | the wrapper's predicate columns |
| `selectById`, `getById`, `listByIds` | read | the key |
| `selectList`, `list`, `getOne`, `count`, `page`, `selectPage`, `exists`, … | read | the wrapper's predicate/order columns **and the projection** — every mapped column, or the `select(...)` list when the wrapper narrows it |

A method that runs no SQL is deliberately absent: `getBaseMapper`,
`lambdaQuery()`, `lambdaUpdate()` get no statement, because giving them one would
invent a row-touching fact.

If the owning type **declares the method itself**, the call runs that method and
not the built-in: no generic statement is created, and the case is counted
(`builtinsOverridden`) and named in the diagnostics.

### Condition wrappers, and the columns nobody wrote down

The worker records, per enclosing method, what kind of wrapper was built, for
which entity type, which ops were called on it with which method references and
literals, and where it ended up. It **decides nothing**: `eq` is recorded as the
op named `eq`, and that `eq` is an equality predicate on a column is the bridge's
reading.

Every op falls into one of five readings, and the table is **total** — an op
outside it is counted under `opsUninterpreted` and named in the analyze output,
so a lane that quietly ignored one cannot pass for a lane that saw none:

| reading | ops | what it means |
|---|---|---|
| `column` | `eq ne gt ge lt le in notIn like notLike likeLeft likeRight notLikeLeft notLikeRight between notBetween isNull isNotNull` | names ONE column: its first string-literal argument (after MyBatis-Plus's optional leading `boolean condition`), or the method references it carries |
| `columns` | `select groupBy orderByAsc orderByDesc orderBy` | names several — every top-level string literal |
| `write` | `set setIncrBy setDecrBy` | the columns it names are WRITTEN |
| `sql` | `apply last setSql exists notExists having inSql notInSql` | its string argument is a raw SQL **fragment**, not a column name — it is run through the SQL analyzer, see below |
| `structural` | `and or not nested lambda func clone getCustomSqlSegment getSqlSegment` | names no column of its own — but a method reference **inside** it still does, because `X::getY` is unambiguous wherever it appears |

**A wrapper this lane cannot see through is the interesting case.** jeecg-boot
builds 64 of its wrappers with

```java
QueryWrapper<T> queryWrapper = QueryGenerator.initQueryWrapper(object, request.getParameterMap());
```

whose conditions come from the HTTP query string. No source line names those
columns. The lane does **not** guess and does **not** go quiet: the table stays a
fact, the statement carries `columnsRuntimeOnly: true` with the reason, and
`column_impact` on **any** column of that table adds a limit saying "N statements
touch this table with columns decided at run time — the list above is a lower
bound", naming them. That is the grade table staying total: RUNTIME_ONLY is a
grade, not a silence.

**A raw SQL fragment goes to the SQL analyzer.** `apply / last / setSql / inSql
/ notInSql / exists / notExists / having` hand MyBatis-Plus a piece of SQL TEXT,
and SQL belongs to the SQL lane. The op says how the fragment is written into a
statement — `apply(cond)` is a `WHERE`, `setSql(x)` an `UPDATE … SET`,
`last("limit 10")` a tail — the `FROM` is the table the wrapper filters, and
MyBatis-Plus's own `{0}` bind placeholder becomes the `?` a parser accepts. The
result is an ordinary statement run through the same `lineage.py`, the same
catalog, dialect and identifier rule, and the same content-addressed shard cache
as a mapper statement or a native `@Query`, under the id
`<owner>.<method>#frag<n>`. What comes back is attached to the wrapper's
statement with `evidence.fragmentOp` naming the op, so

```java
w.apply("date_format(create_time,'%Y-%m') = {0}", ym);
```

makes the statement READ `create_time` even though no method reference and no
projection names it. Two things stay honest about it: a fragment that does not
parse keeps the old `unresolved` note **with its text**, and a fragment on a
wrapper with no entity of its own (a `QueryWrapper<T>` in a generic base class,
whose table is decided per call site) is not written out at all and says so —
nothing is invented in either case. jeecg-boot uses none of these ops, so the
fixture behind this path is the synthetic project in
`test/mp_fragments.test.mjs`, driven through the real CLI and both workers.

### What it does NOT resolve

- **A wrapper re-assigned to an existing variable** (`wrapper = new
  LambdaQueryWrapper<>();`) is not a new wrapper record — the scan reads
  declarations and chains. In every case measured the variable already had a
  record, so its ops still land; the *origin* is what is lost.
- A wrapper handed to a helper (`this.addEasyQuery(queryWrapper, …)`) is recorded
  with that sink and produces no statement there — the helper is not a built-in.
- `@Version`, `@TableField(fill = …)`, `@KeySequence`, MyBatis-Plus's multi-tenant
  and dynamic-table-name interceptors are recorded or ignored, never modelled.
- `mybatisPlus.logicNotDeleteValue` is recorded and not acted on: the lane records
  that the flag column is read as a filter, not which value it is compared with.

### The profile keys

```json
{
  "frameworkPacks": ["spring-mvc", "mybatis-xml", "mybatis-plus"],
  "mybatisPlus": {
    "namingStrategy": "underscore",
    "tablePrefix": null,
    "logicDeleteValue": "1",
    "logicNotDeleteValue": "0"
  }
}
```

- `"underscore"` — MyBatis-Plus's own default (`table-underline: true`,
  `map-underscore-to-camel-case: true`), `SysUser` → `sys_user`.
- `"identity"` — the project that turned it off; the logical name is the physical one.
- `null` (the default) — undeclared, assume `underscore`, grade HEURISTIC, and
  the `mybatisPlus` axis is **degraded** rather than shipped.

**Invariant I-1, in this lane:** if the derived table name happens to exist in
the DB catalog, that is recorded as `mpCatalogMatch: true` and **nothing else**.

Node ids go through the **same identity fold** the SQL lane used
(`sqlIdentifierCase`). jeecg-boot's `sys_user_depart` spells its key `ID` in the
DDL while the entity derives `id`; keyed by string that is two nodes for one
column and every answer about it is half an answer.

## Test targets

`macrozheng/mall` (Apache-2.0) is the MyBatis reference target — 383 files, 160
endpoints, 887 mapper-method↔statement bindings. See
[sql-lane.md](sql-lane.md) for cloning it.

`spring-projects/spring-petclinic` (Apache-2.0) is the JPA reference target.
`test/petclinic.test.mjs` clones it at a pinned commit and checks the mapping
against `src/main/resources/db/mysql/schema.sql`:

```bash
git clone https://github.com/spring-projects/spring-petclinic ../target-examples/spring-petclinic
node --test test/petclinic.test.mjs      # or set CASCADE_PETCLINIC=<path>
```
